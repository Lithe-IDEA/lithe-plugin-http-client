//! Thin Lithe plugin adapter around OpenIDEA's unchanged HTTP parser and executor.
use ide_core::CancellationToken;
use ide_http::{env::Environments, exec, parse};
use lithe_plugin_sdk::{Backend, FunctionError, PluginError, Value};
use serde_json::json;
use std::{sync::Arc, time::Duration};

const INPUT_LIMIT: usize = 128 * 1024;
const PREVIEW_LIMIT: usize = 48 * 1024;

fn invalid(code: &str) -> FunctionError {
    PluginError::new(code, code).into()
}

fn source(params: &Value) -> Result<&str, FunctionError> {
    params["text"]
        .as_str()
        .filter(|s| s.len() <= INPUT_LIMIT)
        .ok_or_else(|| invalid("httpClient.invalidInput"))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = Arc::new(tokio::runtime::Runtime::new()?);
    let mut backend = Backend::new("lithe-http-client").version(env!("CARGO_PKG_VERSION"));
    backend.function("requests.parse", |params, context| {
        context.check_cancelled()?;
        let parsed = parse::parse(source(&params)?);
        Ok(json!({"requests": parsed.requests.into_iter().map(|r| r.block).collect::<Vec<_>>()}))
    })?;
    backend.function("requests.execute", move |params, context| {
        context.check_cancelled()?;
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
            && body.len() > PREVIEW_LIMIT
        {
            let mut end = PREVIEW_LIMIT;
            while !body.is_char_boundary(end) {
                end -= 1;
            }
            body.truncate(end);
            response.truncated = true;
        }
        let value = serde_json::to_value(response)?;
        if serde_json::to_vec(&value)?.len() > 512 * 1024 {
            return Err(invalid("httpClient.responseTooLarge"));
        }
        Ok(value)
    })?;
    std::process::exit(backend.listen());
}
