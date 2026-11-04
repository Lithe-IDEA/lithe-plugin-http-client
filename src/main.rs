//! Thin Lithe plugin adapter around OpenIDEA's unchanged HTTP parser and executor.
use ide_core::CancellationToken;
use ide_http::{env::Environments, exec, parse};
use lithe_plugin_sdk::{Backend, FunctionError, PluginError, SdkError, Value};
use serde_json::json;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

mod files;

const INPUT_LIMIT: usize = 128 * 1024;
const DEFAULT_PREVIEW_KIB: u64 = 128;
const RESULT_LIMIT: usize = 900 * 1024;

fn invalid(code: &str) -> FunctionError {
    PluginError::new(code, code).into()
}

fn source(params: &Value) -> Result<&str, FunctionError> {
    params["text"]
        .as_str()
        .filter(|s| s.len() <= INPUT_LIMIT)
        .ok_or_else(|| invalid("httpClient.invalidInput"))
}

fn main() {
    let backend = match prepare_backend() {
        Ok(backend) => backend,
        // A setup failure precedes the protocol writer. Let the host record
        // the process exit instead of Rust's stderr Termination formatter.
        Err(_) => std::process::exit(2),
    };
    std::process::exit(backend.listen());
}

fn prepare_backend() -> Result<Backend, SdkError> {
    let mut backend = Backend::new("lithe-http-client").version(env!("CARGO_PKG_VERSION"));
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => Arc::new(runtime),
        Err(_) => {
            // The SDK's protocol output does not exist before listen. The
            // host records this startup exit through its process lifecycle.
            std::process::exit(1);
        }
    };
    files::register(&mut backend)?;
    backend.function("requests.parse", |params, context| {
        context.check_cancelled()?;
        let parsed = parse::parse(source(&params)?);
        Ok(json!({"requests": parsed.requests.into_iter().map(|r| r.block).collect::<Vec<_>>()}))
    })?;
    backend.suppress_success_diagnostics("requests.parse")?;
    // Record loss of preview data once per backend, without response contents.
    let truncation_reported = AtomicBool::new(false);
    backend.function("requests.execute", move |params, context| {
        context.check_cancelled()?;
        let preview_kib = match params.get("previewLimitKiB") {
            None => DEFAULT_PREVIEW_KIB,
            Some(value) => value
                .as_u64()
                .filter(|n| (1..=512).contains(n))
                .ok_or_else(|| invalid("httpClient.invalidInput"))?,
        };
        let preview_limit = preview_kib as usize * 1024;
        let text = source(&params)?;
        let parsed = parse::parse(text);
        let index = params["index"]
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| invalid("httpClient.invalidInput"))?;
        let raw = parsed
            .requests
            .get(index)
            .ok_or_else(|| invalid("httpClient.invalidInput"))?;
        // Upstream deliberately skips handlers and redirects. Reject them rather
        // than presenting a successful send as successful script execution.
        if text
            .lines()
            .skip(raw.block.start_line as usize)
            .take((raw.block.end_line - raw.block.start_line + 1) as usize)
            .any(|line| {
                let line = line.trim_start();
                line.starts_with('>') || line.starts_with("<>")
            })
        {
            return Err(invalid("httpClient.handlerUnsupported"));
        }
        // This text-only client has no selected file/root. Never resolve includes
        // against the backend's working directory or read ambient environment files.
        if raw
            .body
            .iter()
            .any(|p| matches!(p, parse::BodyPart::File(_)))
        {
            return Err(invalid("httpClient.fileIncludeUnsupported"));
        }
        let request = exec::prepare(raw, &parsed.variables, &Environments::default(), None, None)
            .map_err(|_| invalid("httpClient.prepareFailed"))?;
        if !(request.url.starts_with("http://") || request.url.starts_with("https://")) {
            return Err(invalid("httpClient.invalidScheme"));
        }
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        context.cancellation().on_cancel(move || signal.cancel());
        context.check_cancelled()?;
        let response = runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(30), exec::execute(&request, &cancel)).await
        });
        context.check_cancelled()?;
        let mut response = response
            .map_err(|_| invalid("httpClient.timeout"))?
            .map_err(|_| invalid("httpClient.transportFailed"))?;
        // Upstream caps the network body; the plugin protocol has a smaller JSON
        // budget. Trim on a UTF-8 boundary, and never return request credentials.
        if let Some(body) = response.body.as_mut()
            && body.len() > preview_limit
        {
            let mut end = preview_limit;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
            response.truncated = true;
        }
        // JSON escaping can expand text up to six times. Keep the result below
        // the host's 1 MiB function-result budget, including response metadata.
        loop {
            let value = serde_json::to_value(&response)?;
            let encoded_size = serde_json::to_vec(&value)?.len();
            if encoded_size <= RESULT_LIMIT {
                if response.truncated && !truncation_reported.swap(true, Ordering::Relaxed) {
                    context
                        .diagnostics()
                        .degraded("requests.execute", "preview_truncated", None)
                        .expect("registered operation and static diagnostic code");
                }
                return Ok(value);
            }
            let Some(body) = response.body.as_mut().filter(|body| !body.is_empty()) else {
                return Err(invalid("httpClient.responseTooLarge"));
            };
            let reduction = (encoded_size - RESULT_LIMIT).min(body.len().div_ceil(2));
            let mut end = body.len() - reduction;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
            response.truncated = true;
        }
    })?;
    Ok(backend)
}
