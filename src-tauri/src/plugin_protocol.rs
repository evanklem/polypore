use std::{
    borrow::Cow,
    fs,
    path::{Component, Path, PathBuf},
};

use tauri::{
    http::{header, Request, Response, StatusCode},
    Runtime, UriSchemeContext,
};

use crate::project_context;

pub fn handle<R: Runtime>(
    _ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    match resolve_request_path(request.uri()) {
        Ok(path) => serve_file(path),
        Err((status, message)) => text_response(status, message),
    }
}

fn resolve_request_path(uri: &tauri::http::Uri) -> Result<PathBuf, (StatusCode, &'static str)> {
    let (plugin_id, relative_path) = parse_plugin_uri(uri)?;
    /* serve from the active project's .polypore/plugins/<id>/, matching where the
       installer copies bundles. active_project_root honors POLYPORE_PROJECT_ROOT
       (set when a different folder is opened) and the src-tauri dev case, so a
       packaged build does not fall back to an arbitrary cwd. */
    let plugin_root = project_context::active_project_root()
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve project directory",
            )
        })?
        .join(".polypore")
        .join("plugins")
        .join(&plugin_id);

    if !is_safe_plugin_id(&plugin_id) {
        return Err((StatusCode::BAD_REQUEST, "invalid plugin id"));
    }

    let mut target = plugin_root;
    let relative = if relative_path.is_empty() {
        "index.html"
    } else {
        relative_path.as_str()
    };
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => target.push(part),
            Component::CurDir => {}
            _ => return Err((StatusCode::BAD_REQUEST, "invalid plugin path")),
        }
    }

    Ok(target)
}

fn parse_plugin_uri(
    uri: &tauri::http::Uri,
) -> Result<(String, String), (StatusCode, &'static str)> {
    let host = uri.host().unwrap_or_default();
    let path = uri.path().trim_start_matches('/');

    if host == "plugin.localhost" {
        let mut parts = path.splitn(2, '/');
        let id = parts.next().unwrap_or_default();
        let relative = parts.next().unwrap_or_default();
        if id.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "missing plugin id"));
        }
        return Ok((id.to_string(), relative.to_string()));
    }

    if host.is_empty() {
        let mut parts = path.splitn(2, '/');
        let id = parts.next().unwrap_or_default();
        let relative = parts.next().unwrap_or_default();
        if id.is_empty() {
            return Err((StatusCode::BAD_REQUEST, "missing plugin id"));
        }
        return Ok((id.to_string(), relative.to_string()));
    }

    Ok((host.to_string(), path.to_string()))
}

fn is_safe_plugin_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn serve_file(path: PathBuf) -> Response<Cow<'static, [u8]>> {
    if !path.is_file() {
        return text_response(StatusCode::NOT_FOUND, "plugin asset not found");
    }

    match fs::read(&path) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type(&path))
            .header("Cross-Origin-Resource-Policy", "same-origin")
            .body(Cow::Owned(bytes))
            .unwrap(),
        Err(_) => text_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to read plugin asset",
        ),
    }
}

fn text_response(status: StatusCode, message: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Borrowed(message.as_bytes()))
        .unwrap()
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
    {
        "css" => "text/css; charset=utf-8",
        "gif" => "image/gif",
        "html" | "htm" => "text/html; charset=utf-8",
        "ico" => "image/x-icon",
        "jpg" | "jpeg" => "image/jpeg",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "wasm" => "application/wasm",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::{is_safe_plugin_id, parse_plugin_uri};

    #[test]
    fn parses_custom_protocol_uri() {
        let uri = "plugin://polypore.chat/assets/panel.js".parse().unwrap();
        assert_eq!(
            parse_plugin_uri(&uri).unwrap(),
            ("polypore.chat".to_string(), "assets/panel.js".to_string())
        );
    }

    #[test]
    fn parses_windows_localhost_uri() {
        let uri = "http://plugin.localhost/polypore.chat/index.html"
            .parse()
            .unwrap();
        assert_eq!(
            parse_plugin_uri(&uri).unwrap(),
            ("polypore.chat".to_string(), "index.html".to_string())
        );
    }

    #[test]
    fn validates_plugin_id() {
        assert!(is_safe_plugin_id("polypore.chat_1"));
        assert!(!is_safe_plugin_id("../polypore.chat"));
    }
}
