//! Explicit file-dialog reads and exports. All writes target the user's chosen
//! file, never the installed package or application bundle. No cache or history
//! files are created; the host owns the editor and HTML preview lifecycle.
use lithe_plugin_sdk::{Backend, Context, FunctionError, PluginError, Value};
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const PREVIEW_METHOD: &str = "lithe/host/preview/openHTML";
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

fn failure(code: &str) -> FunctionError {
    PluginError::new(code, code).into()
}

fn path(params: &Value) -> Result<&Path, FunctionError> {
    params["path"]
        .as_str()
        .map(Path::new)
        .filter(|path| path.is_absolute() && !path.components().any(|p| p == Component::ParentDir))
        .ok_or_else(|| failure("httpClient.invalidInput"))
}

fn read_request(params: &Value, context: &Context) -> Result<Value, FunctionError> {
    context.check_cancelled()?;
    let path = path(params)?;
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    if !["http", "rest"]
        .iter()
        .any(|v| extension.eq_ignore_ascii_case(v))
    {
        return Err(failure("httpClient.fileReadFailed"));
    }
    let read = || -> std::io::Result<Vec<u8>> {
        if !fs::metadata(path)?.is_file() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let file = File::open(path)?;
        if !file.metadata()?.is_file() {
            return Err(std::io::ErrorKind::InvalidInput.into());
        }
        let mut bytes = Vec::new();
        file.take((super::INPUT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)?;
        Ok(bytes)
    };
    let bytes = read().map_err(|_| failure("httpClient.fileReadFailed"))?;
    if bytes.len() > super::INPUT_LIMIT {
        return Err(failure("httpClient.fileReadFailed"));
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    let text = std::str::from_utf8(bytes)
        .ok()
        .filter(|text| text.len() <= super::INPUT_LIMIT && !text.contains('\0'))
        .ok_or_else(|| failure("httpClient.fileReadFailed"))?;
    context.check_cancelled()?;
    Ok(json!({"name": path.file_name().and_then(|v| v.to_str()), "text": text}))
}

fn writable_destination(path: &Path) -> Result<PathBuf, FunctionError> {
    let refused = || failure("httpClient.fileWriteFailed");
    let parent = path
        .parent()
        .ok_or_else(refused)?
        .canonicalize()
        .map_err(|_| refused())?;
    let target = parent.join(path.file_name().ok_or_else(refused)?);
    // Canonicalize the parent first so an alias cannot route an export into a
    // signed bundle. Refuse symlinks and special files instead of following them.
    if parent.components().any(|part| {
        part.as_os_str()
            .to_str()
            .is_some_and(|part| part.to_ascii_lowercase().ends_with(".app"))
    }) {
        return Err(refused());
    }
    let executable = std::env::current_exe()
        .map_err(|_| refused())?
        .canonicalize()
        .map_err(|_| refused())?;
    if let Some(package) = executable.parent().and_then(Path::parent)
        && package.join("plugin.json").is_file()
        && target.starts_with(package)
    {
        return Err(refused());
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(refused());
        }
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(refused()),
        _ => {}
    }
    Ok(target)
}

fn preview_context(
    context: &Context,
) -> Result<(lithe_plugin_sdk::WorkspaceContext, Value), FunctionError> {
    let unavailable = || failure("httpClient.previewUnavailable");
    let scope = context
        .workspace_context()
        .cloned()
        .ok_or_else(unavailable)?;
    let host = context.host();
    for method in [
        PREVIEW_METHOD,
        "lithe/host/workspace/getFolders",
        "lithe/host/documents/list",
    ] {
        if !host.supports(method).map_err(|_| unavailable())? {
            return Err(unavailable());
        }
    }
    let folders = host
        .workspace()
        .get_folders(&scope)
        .map_err(|_| unavailable())?;
    // Local folders alone carry paths. getFolders is read-only, whereas
    // getContext would create a workspace state directory unnecessarily.
    if !folders["folders"].as_array().is_some_and(|folders| {
        folders
            .iter()
            .any(|folder| folder["path"].as_str().is_some())
    }) {
        return Err(unavailable());
    }
    Ok((scope, folders))
}

fn preview_resource(target: &Path, folders: &Value) -> Result<Value, FunctionError> {
    let resource = folders["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|folder| {
            let root = Path::new(folder["path"].as_str()?).canonicalize().ok()?;
            let relative = target.strip_prefix(root).ok()?;
            Some(json!({"rootID": folder["rootID"], "path": relative.to_str()?.replace('\\', "/")}))
        });
    resource.ok_or_else(|| failure("httpClient.previewOutsideWorkspace"))
}

fn atomic_write(target: &Path, text: &str, context: &Context) -> Result<(), FunctionError> {
    let refused = || failure("httpClient.fileWriteFailed");
    // Stage alongside the destination, then rename. A failed write leaves the
    // previous file intact. The temporary file belongs to this call only.
    let temporary = target.with_file_name(format!(
        ".lithe-http-{}-{}.tmp",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut created = false;
    let mut write = || -> Result<(), FunctionError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| refused())?;
        created = true;
        file.write_all(text.as_bytes()).map_err(|_| refused())?;
        file.sync_all().map_err(|_| refused())?;
        if let Ok(metadata) = fs::metadata(target) {
            file.set_permissions(metadata.permissions())
                .map_err(|_| refused())?;
        }
        context.check_cancelled()?;
        fs::rename(&temporary, target).map_err(|_| refused())?;
        Ok(())
    };
    let result = write();
    // A create_new collision belongs to someone else and must be left alone.
    if created && result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn register(backend: &mut Backend) -> Result<(), lithe_plugin_sdk::SdkError> {
    backend.function("requests.openFile", |params, context| {
        read_request(&params, context)
    })?;
    backend.function("response.previewInfo", |_, context| {
        preview_context(context)?;
        Ok(json!({"available": true}))
    })?;
    backend.suppress_success_diagnostics("response.previewInfo")?;
    backend.function("response.save", |params, context| {
        context.check_cancelled()?;
        let text = params["text"]
            .as_str()
            .filter(|v| v.len() <= super::RESULT_LIMIT)
            .ok_or_else(|| failure("httpClient.invalidInput"))?;
        let target = writable_destination(path(&params)?)?;
        let preview = params["preview"].as_bool().unwrap_or(false);
        let preview_target = if preview {
            if !target
                .extension()
                .and_then(|v| v.to_str())
                .is_some_and(|v| v.eq_ignore_ascii_case("html") || v.eq_ignore_ascii_case("htm"))
            {
                return Err(failure("httpClient.previewOutsideWorkspace"));
            }
            let (scope, folders) = preview_context(context)?;
            let resource = preview_resource(&target, &folders)?;
            let documents = context
                .host()
                .documents()
                .list(&scope)
                .map_err(|_| failure("httpClient.previewUnavailable"))?;
            // The host preserves existing buffers, including clean ones. Refuse
            // an open destination so its old buffer cannot impersonate a response.
            if documents["documents"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|doc| doc["path"] == resource["path"])
            {
                return Err(failure("httpClient.previewDirty"));
            }
            Some((scope, resource))
        } else {
            None
        };
        atomic_write(&target, text, context)?;
        if let Some((scope, resource)) = preview_target {
            context
                .host()
                .preview()
                .open_html(
                    &scope,
                    json!({"resource": resource, "presentation": "previewOnly"}),
                )
                .map_err(|_| failure("httpClient.previewFailed"))?;
        }
        Ok(json!({"saved": true, "preview": preview}))
    })?;
    Ok(())
}
