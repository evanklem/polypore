//! Capture route for the debug suite — the visual/context half of inspection.
//!
//! Screenshot reuses `preview_native`'s window capture; console reads the
//! buffered DAP `output` events from the session in `dap.rs`. DOM and network
//! capture need a CDP attachment and are deferred (phase 1.5) — the host
//! surfaces a clear "needs CDP" error for those, mirroring `mcp_probe.rs`'s
//! stdio stub. This is a thin wrapper that keeps the debug-session framing
//! adjacent to the primitives it reuses.

use serde::{Deserialize, Serialize};

use crate::dap::{ConsoleEntry, DebugRegistry, SessionInput};
use crate::preview_native;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotInput {
    /* accepted for API symmetry with the other capture tools; screenshot
    targets a window by hint/pid, not by DAP session. */
    #[serde(default)]
    #[allow(dead_code)]
    pub session_id: Option<String>,
    /// optional window hint — command line / project name, like the preview panel.
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub root_pid: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotOutput {
    pub mime_type: String,
    pub data_base64: String,
}

#[tauri::command]
pub fn debug_capture_screenshot(input: ScreenshotInput) -> Result<ScreenshotOutput, String> {
    let frame =
        preview_native::preview_capture_frame(input.root_pid, input.target.clone(), input.target)?;
    let data_url = frame.data_url.ok_or_else(|| {
        frame
            .error
            .unwrap_or_else(|| "no debuggee window captured".to_string())
    })?;
    let (mime_type, data_base64) = split_data_url(&data_url)?;
    Ok(ScreenshotOutput {
        mime_type,
        data_base64,
    })
}

#[tauri::command]
pub fn debug_capture_console(
    registry: tauri::State<'_, DebugRegistry>,
    input: SessionInput,
) -> Result<Vec<ConsoleEntry>, String> {
    registry.console(input)
}

/// `data:image/png;base64,AAAA` → (`image/png`, `AAAA`).
fn split_data_url(data_url: &str) -> Result<(String, String), String> {
    let rest = data_url
        .strip_prefix("data:")
        .ok_or_else(|| "capture did not return a data URL".to_string())?;
    let (meta, payload) = rest
        .split_once(',')
        .ok_or_else(|| "malformed capture data URL".to_string())?;
    let mime = meta.split(';').next().unwrap_or("image/png").to_string();
    Ok((mime, payload.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_png_data_url_into_mime_and_payload() {
        let (mime, payload) = split_data_url("data:image/png;base64,AAAA").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(payload, "AAAA");
    }

    #[test]
    fn rejects_a_non_data_url() {
        assert!(split_data_url("http://example/image.png").is_err());
    }
}
