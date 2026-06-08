use std::collections::{HashMap, HashSet};
#[cfg(target_os = "macos")]
use std::ffi::c_void;
use std::fs;
#[cfg(target_os = "linux")]
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
#[cfg(target_os = "linux")]
use std::process::Stdio;

use base64::Engine;

#[derive(Debug, serde::Deserialize)]
struct HyprClient {
    address: Option<String>,
    class: Option<String>,
    pid: Option<u32>,
    title: Option<String>,
    at: Option<Vec<i64>>,
    size: Option<Vec<i64>>,
}

#[derive(Debug)]
struct X11Client {
    window_id: String,
    title: Option<String>,
    class: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsCaptureResult {
    captured: bool,
    title: Option<String>,
    x: Option<i64>,
    y: Option<i64>,
    width: Option<i64>,
    height: Option<i64>,
    error: Option<String>,
}

#[cfg(target_os = "windows")]
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsActionResult {
    ok: bool,
    error: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug)]
struct MacWindowTarget {
    pid: u32,
    title: Option<String>,
    bounds: Option<NativePreviewBounds>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewFrame {
    pub captured: bool,
    pub title: Option<String>,
    pub backend: Option<String>,
    pub bounds: Option<NativePreviewBounds>,
    pub data_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewFocusInput {
    pub root_pid: Option<u32>,
    pub command: Option<String>,
    /* the detected project name (e.g. "polypore"), used as an extra
    matching term when the command tokens get filtered out as
    reserved words. matches the spawned window's WM_CLASS / title. */
    pub target_name: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewFocusResult {
    pub focused: bool,
    pub backend: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewInput {
    pub root_pid: Option<u32>,
    pub command: Option<String>,
    pub target_name: Option<String>,
    pub x: i64,
    pub y: i64,
    pub button: Option<u8>,
    pub key: Option<String>,
    pub text: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePreviewInputResult {
    pub sent: bool,
    pub backend: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn preview_capture_frame(
    root_pid: Option<u32>,
    command: Option<String>,
    target_name: Option<String>,
) -> Result<NativePreviewFrame, String> {
    let hint = combine_hint(command.as_deref(), target_name.as_deref());
    preview_capture_frame_platform(root_pid, hint.as_deref())
}

#[tauri::command]
pub fn preview_focus_window(
    mut input: NativePreviewFocusInput,
) -> Result<NativePreviewFocusResult, String> {
    input.command = combine_hint(input.command.as_deref(), input.target_name.as_deref());
    preview_focus_window_platform(input)
}

#[tauri::command]
pub fn preview_send_input(
    mut input: NativePreviewInput,
) -> Result<NativePreviewInputResult, String> {
    input.command = combine_hint(input.command.as_deref(), input.target_name.as_deref());
    preview_send_input_platform(input)
}

/* JS sends the raw command and the detected project name as two separate
fields. internal matching only needs one haystack, so concatenate them
here. for commands like `cargo tauri dev` where every command token is
filtered as reserved by native_target_terms, the project name (e.g.
"polypore") supplies the actual matching term — it typically appears
in the spawned window's WM_CLASS / hyprctl class. */
fn combine_hint(command: Option<&str>, target_name: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = [command, target_name]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" "))
    }
}

#[cfg(target_os = "linux")]
fn preview_capture_frame_platform(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<NativePreviewFrame, String> {
    let x11_available = x11_preview_available();
    let hypr_available = hyprland_preview_available();
    /* only short-circuit when X11 actually captured a window that
    matched the target. otherwise fall through to Hyprland — many
    Tauri / GTK4 apps run as native Wayland windows that don't
    appear in _NET_CLIENT_LIST, so X11 would return an unrelated
    XWayland window (the editor, terminal, etc.) and the actual
    app would never be discovered. */
    if let Ok(Some(frame)) = preview_capture_x11(root_pid, command) {
        if frame.captured {
            return Ok(frame);
        }
    }
    let Some(client) = find_hypr_client_with_fallback(root_pid, command)? else {
        if let Ok(Some(frame)) = preview_capture_active_wayland_window(command) {
            return Ok(frame);
        }
        let (backend, error) = linux_capture_unavailable_message(x11_available, hypr_available);
        return Ok(NativePreviewFrame {
            captured: false,
            title: None,
            backend: Some(backend),
            bounds: None,
            data_url: None,
            error: Some(error),
        });
    };
    let at = client.at.unwrap_or_default();
    let size = client.size.unwrap_or_default();
    if at.len() < 2 || size.len() < 2 || size[0] <= 0 || size[1] <= 0 {
        if let Ok(Some(frame)) = preview_capture_active_wayland_window(command) {
            return Ok(frame);
        }
        return Ok(NativePreviewFrame {
            captured: false,
            title: client.title,
            backend: Some("hyprland".into()),
            bounds: None,
            data_url: None,
            error: Some("native window has no capturable bounds".into()),
        });
    }

    let geometry = format!("{},{} {}x{}", at[0], at[1], size[0], size[1]);
    let path = frame_path();
    let output = match Command::new("grim")
        .args(["-g", &geometry, "-t", "png"])
        .arg(&path)
        .output()
    {
        Ok(output) => output,
        Err(err) => {
            if let Ok(Some(frame)) = preview_capture_active_wayland_window(command) {
                return Ok(frame);
            }
            return Err(format!("failed to run grim: {err}"));
        }
    };
    if !output.status.success() {
        if let Ok(Some(frame)) = preview_capture_active_wayland_window(command) {
            return Ok(frame);
        }
        return Ok(NativePreviewFrame {
            captured: false,
            title: client.title,
            backend: Some("hyprland".into()),
            bounds: Some(NativePreviewBounds {
                x: at[0],
                y: at[1],
                width: size[0],
                height: size[1],
            }),
            data_url: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        });
    }
    let bytes =
        fs::read(&path).map_err(|err| format!("failed to read native preview frame: {err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(NativePreviewFrame {
        captured: true,
        title: client.title,
        backend: Some("hyprland".into()),
        bounds: Some(NativePreviewBounds {
            x: at[0],
            y: at[1],
            width: size[0],
            height: size[1],
        }),
        data_url: Some(format!("data:image/png;base64,{encoded}")),
        error: None,
    })
}

#[cfg(target_os = "linux")]
fn preview_focus_window_platform(
    input: NativePreviewFocusInput,
) -> Result<NativePreviewFocusResult, String> {
    let x11_available = x11_preview_available();
    let hypr_available = hyprland_preview_available();
    if let Ok(Some(result)) = preview_focus_x11(input.root_pid, input.command.as_deref()) {
        return Ok(result);
    }
    let Some(client) = find_hypr_client_with_fallback(input.root_pid, input.command.as_deref())?
    else {
        let (backend, error) = linux_focus_unavailable_message(x11_available, hypr_available);
        return Ok(NativePreviewFocusResult {
            focused: false,
            backend: Some(backend),
            error: Some(error),
        });
    };
    let selector = if let Some(address) = client.address {
        format!("address:{address}")
    } else if let Some(pid) = client.pid {
        format!("pid:{pid}")
    } else if let Some(title) = client.title {
        format!("title:{}", title.replace(',', " "))
    } else {
        return Ok(NativePreviewFocusResult {
            focused: false,
            backend: Some("hyprland".into()),
            error: Some("native window has no selector".into()),
        });
    };
    let output = Command::new("hyprctl")
        .args(["dispatch", "focuswindow", &selector])
        .output()
        .map_err(|err| format!("failed to run hyprctl: {err}"))?;
    Ok(NativePreviewFocusResult {
        focused: output.status.success(),
        backend: Some("hyprland".into()),
        error: (!output.status.success())
            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
    })
}

#[cfg(target_os = "linux")]
fn preview_send_input_platform(
    input: NativePreviewInput,
) -> Result<NativePreviewInputResult, String> {
    if let Ok(Some(result)) = preview_send_input_x11(&input) {
        return Ok(result);
    }
    if let Ok(Some(result)) = preview_send_input_wayland(&input) {
        return Ok(result);
    }
    Ok(NativePreviewInputResult {
        sent: false,
        backend: Some("native".into()),
        error: Some(
            "native input forwarding requires xdotool on X11 or ydotool/dotool/wtype on Wayland"
                .into(),
        ),
    })
}

#[cfg(target_os = "linux")]
fn x11_preview_available() -> bool {
    std::env::var_os("DISPLAY").is_some() && command_available("xprop")
}

#[cfg(target_os = "linux")]
fn hyprland_preview_available() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some() && command_available("hyprctl")
}

#[cfg(target_os = "linux")]
fn linux_capture_unavailable_message(
    x11_available: bool,
    hypr_available: bool,
) -> (String, String) {
    if x11_available || hypr_available {
        return (
            "linux-native".into(),
            "no matching native window found yet".into(),
        );
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return (
            "wayland".into(),
            "native capture on this Wayland desktop requires GNOME Screenshot, KDE Spectacle, Hyprland/wlroots tooling (hyprctl + grim), or an X11 session with xprop plus maim/import/xwd".into(),
        );
    }
    (
        "linux-native".into(),
        "native capture requires GNOME Screenshot, KDE Spectacle, an X11 session with xprop plus maim/import/xwd, or Hyprland/wlroots with hyprctl + grim".into(),
    )
}

#[cfg(target_os = "linux")]
fn linux_focus_unavailable_message(x11_available: bool, hypr_available: bool) -> (String, String) {
    if x11_available || hypr_available {
        return (
            "linux-native".into(),
            "no matching native window found yet".into(),
        );
    }
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return (
            "wayland".into(),
            "native focus on this Wayland desktop requires compositor support; Hyprland uses hyprctl and generic Wayland input uses ydotool/dotool/wtype".into(),
        );
    }
    (
        "linux-native".into(),
        "native focus requires xdotool on X11 or compositor-supported Wayland input tooling".into(),
    )
}

#[cfg(target_os = "windows")]
fn preview_capture_frame_platform(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<NativePreviewFrame, String> {
    let path = frame_path();
    let root = root_pid.map(|pid| pid.to_string()).unwrap_or_default();
    let path_arg = path.to_string_lossy().to_string();
    let output = run_powershell(
        WINDOWS_CAPTURE_SCRIPT,
        &[&root, &path_arg, command.unwrap_or_default()],
    )?;
    let parsed: WindowsCaptureResult = serde_json::from_slice(&output)
        .map_err(|err| format!("failed to parse windows native preview result: {err}"))?;
    if !parsed.captured {
        return Ok(NativePreviewFrame {
            captured: false,
            title: parsed.title,
            backend: Some("windows".into()),
            bounds: None,
            data_url: None,
            error: parsed
                .error
                .or_else(|| Some("no matching native window found yet".into())),
        });
    }
    let bytes = fs::read(&path)
        .map_err(|err| format!("failed to read windows native preview frame: {err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(NativePreviewFrame {
        captured: true,
        title: parsed.title,
        backend: Some("windows".into()),
        bounds: Some(NativePreviewBounds {
            x: parsed.x.unwrap_or_default(),
            y: parsed.y.unwrap_or_default(),
            width: parsed.width.unwrap_or_default(),
            height: parsed.height.unwrap_or_default(),
        }),
        data_url: Some(format!("data:image/png;base64,{encoded}")),
        error: None,
    })
}

#[cfg(target_os = "windows")]
fn preview_focus_window_platform(
    input: NativePreviewFocusInput,
) -> Result<NativePreviewFocusResult, String> {
    let root = input
        .root_pid
        .map(|pid| pid.to_string())
        .unwrap_or_default();
    let output = run_powershell(
        WINDOWS_FOCUS_SCRIPT,
        &[&root, input.command.as_deref().unwrap_or_default()],
    )?;
    let parsed: WindowsActionResult = serde_json::from_slice(&output)
        .map_err(|err| format!("failed to parse windows native focus result: {err}"))?;
    Ok(NativePreviewFocusResult {
        focused: parsed.ok,
        backend: Some("windows".into()),
        error: parsed.error,
    })
}

#[cfg(target_os = "windows")]
fn preview_send_input_platform(
    input: NativePreviewInput,
) -> Result<NativePreviewInputResult, String> {
    let root = input
        .root_pid
        .map(|pid| pid.to_string())
        .unwrap_or_default();
    let x = input.x.to_string();
    let y = input.y.to_string();
    let button = input
        .button
        .map(|button| button.to_string())
        .unwrap_or_default();
    let key = input.key.unwrap_or_default();
    let text = input.text.unwrap_or_default();
    let output = run_powershell(
        WINDOWS_INPUT_SCRIPT,
        &[
            &root,
            &x,
            &y,
            &button,
            &key,
            &text,
            input.command.as_deref().unwrap_or_default(),
        ],
    )?;
    let parsed: WindowsActionResult = serde_json::from_slice(&output)
        .map_err(|err| format!("failed to parse windows native input result: {err}"))?;
    Ok(NativePreviewInputResult {
        sent: parsed.ok,
        backend: Some("windows".into()),
        error: parsed.error,
    })
}

#[cfg(target_os = "macos")]
fn preview_capture_frame_platform(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<NativePreviewFrame, String> {
    let Some(target) = find_macos_target_with_fallback(root_pid, command)? else {
        return Ok(NativePreviewFrame {
            captured: false,
            title: None,
            backend: Some("macos".into()),
            bounds: None,
            data_url: None,
            error: Some("no matching native window found yet".into()),
        });
    };
    let Some(bounds) = target.bounds.as_ref() else {
        return Ok(NativePreviewFrame {
            captured: false,
            title: target.title,
            backend: Some("macos".into()),
            bounds: None,
            data_url: None,
            error: Some("matching native window has no capturable bounds".into()),
        });
    };
    let title = target.title.clone();
    let bounds = bounds.clone();
    let _ = activate_macos_pid(target.pid);
    let path = frame_path();
    let mut command = Command::new("screencapture");
    command.args(["-x", "-T", "0"]);
    command.args([
        "-R",
        &format!(
            "{},{},{},{}",
            bounds.x, bounds.y, bounds.width, bounds.height
        ),
    ]);
    let output = command
        .arg(&path)
        .output()
        .map_err(|err| format!("failed to run screencapture: {err}"))?;
    if !output.status.success() {
        return Ok(NativePreviewFrame {
            captured: false,
            title,
            backend: Some("macos".into()),
            bounds: Some(bounds),
            data_url: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        });
    }
    let bytes = fs::read(&path)
        .map_err(|err| format!("failed to read macos native preview frame: {err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(NativePreviewFrame {
        captured: true,
        title,
        backend: Some("macos".into()),
        bounds: Some(bounds),
        data_url: Some(format!("data:image/png;base64,{encoded}")),
        error: None,
    })
}

#[cfg(target_os = "macos")]
fn preview_focus_window_platform(
    input: NativePreviewFocusInput,
) -> Result<NativePreviewFocusResult, String> {
    let Some(target) = find_macos_target_with_fallback(input.root_pid, input.command.as_deref())?
    else {
        return Ok(NativePreviewFocusResult {
            focused: false,
            backend: Some("macos".into()),
            error: Some("no matching native window found yet".into()),
        });
    };
    let focused = activate_macos_pid(target.pid)?;
    Ok(NativePreviewFocusResult {
        focused,
        backend: Some("macos".into()),
        error: (!focused).then(|| "failed to focus native window".into()),
    })
}

#[cfg(target_os = "macos")]
fn preview_send_input_platform(
    input: NativePreviewInput,
) -> Result<NativePreviewInputResult, String> {
    let Some(target) = find_macos_target_with_fallback(input.root_pid, input.command.as_deref())?
    else {
        return Ok(NativePreviewInputResult {
            sent: false,
            backend: Some("macos".into()),
            error: Some("no matching native window found yet".into()),
        });
    };
    let _ = activate_macos_pid(target.pid);
    if let Some(button) = input.button {
        return Ok(NativePreviewInputResult {
            sent: macos_send_pointer(target.bounds.as_ref(), input.x, input.y, button),
            backend: Some("macos".into()),
            error: None,
        });
    }
    let script = if let Some(text) = input.text.as_ref().filter(|text| !text.is_empty()) {
        format!(
            "tell application \"System Events\" to keystroke {}",
            serde_json::to_string(text)
                .map_err(|err| format!("failed to encode macos text input: {err}"))?,
        )
    } else if let Some(key) = input.key.as_ref().filter(|key| !key.is_empty()) {
        macos_key_script(key)
    } else {
        return Ok(NativePreviewInputResult {
            sent: false,
            backend: Some("macos".into()),
            error: Some("no native input requested".into()),
        });
    };
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|err| format!("failed to run osascript: {err}"))?;
    Ok(NativePreviewInputResult {
        sent: output.status.success(),
        backend: Some("macos".into()),
        error: (!output.status.success())
            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
    })
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn preview_capture_frame_platform(
    _root_pid: Option<u32>,
    _command: Option<&str>,
) -> Result<NativePreviewFrame, String> {
    Ok(NativePreviewFrame {
        captured: false,
        title: None,
        backend: Some(platform_backend_name().into()),
        bounds: None,
        data_url: None,
        error: Some(format!(
            "native window capture is not implemented yet for {}; URL-based app previews still run in-window",
            platform_backend_name(),
        )),
    })
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn preview_focus_window_platform(
    _input: NativePreviewFocusInput,
) -> Result<NativePreviewFocusResult, String> {
    Ok(NativePreviewFocusResult {
        focused: false,
        backend: Some(platform_backend_name().into()),
        error: Some(format!(
            "native window focus is not implemented yet for {}",
            platform_backend_name(),
        )),
    })
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn preview_send_input_platform(
    _input: NativePreviewInput,
) -> Result<NativePreviewInputResult, String> {
    Ok(NativePreviewInputResult {
        sent: false,
        backend: Some(platform_backend_name().into()),
        error: Some(format!(
            "native input forwarding is not implemented yet for {}",
            platform_backend_name(),
        )),
    })
}

#[cfg(target_os = "linux")]
fn preview_capture_x11(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<NativePreviewFrame>, String> {
    if !x11_preview_available() {
        return Ok(None);
    }
    let Some(client) = find_x11_client_with_fallback(root_pid, command)? else {
        return Ok(Some(NativePreviewFrame {
            captured: false,
            title: None,
            backend: Some("x11".into()),
            bounds: None,
            data_url: None,
            error: Some("no matching X11 native window found yet".into()),
        }));
    };
    let path = frame_path();
    if let Err(err) = capture_x11_window(&client.window_id, &path) {
        return Ok(Some(NativePreviewFrame {
            captured: false,
            title: client.title,
            backend: Some("x11".into()),
            bounds: None,
            data_url: None,
            error: Some(err),
        }));
    }
    let bytes =
        fs::read(&path).map_err(|err| format!("failed to read native preview frame: {err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(NativePreviewFrame {
        captured: true,
        title: client.title,
        backend: Some("x11".into()),
        bounds: None,
        data_url: Some(format!("data:image/png;base64,{encoded}")),
        error: None,
    }))
}

#[cfg(target_os = "linux")]
fn capture_x11_window(window_id: &str, path: &PathBuf) -> Result<(), String> {
    if command_available("maim") {
        let output = Command::new("maim")
            .args(["-i", window_id])
            .arg(path)
            .output()
            .map_err(|err| format!("failed to run maim: {err}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if command_available("import") {
        let output = Command::new("import")
            .args(["-window", window_id])
            .arg(path)
            .output()
            .map_err(|err| format!("failed to run import: {err}"))?;
        if output.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if command_available("xwd") && (command_available("magick") || command_available("convert")) {
        let xwd_path = path.with_extension("xwd");
        let output = Command::new("xwd")
            .args(["-silent", "-id", window_id, "-out"])
            .arg(&xwd_path)
            .output()
            .map_err(|err| format!("failed to run xwd: {err}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let converter = if command_available("magick") {
            "magick"
        } else {
            "convert"
        };
        let output = Command::new(converter)
            .arg(&xwd_path)
            .arg(path)
            .output()
            .map_err(|err| format!("failed to run {converter}: {err}"))?;
        let _ = fs::remove_file(&xwd_path);
        if output.status.success() {
            return Ok(());
        }
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Err(
        "X11 native preview capture requires maim, ImageMagick import, or xwd plus magick/convert"
            .into(),
    )
}

#[cfg(target_os = "linux")]
fn preview_capture_active_wayland_window(
    command: Option<&str>,
) -> Result<Option<NativePreviewFrame>, String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Ok(None);
    }
    let path = frame_path();
    let Some((backend, output)) = (if command_available("gnome-screenshot") {
        Some((
            "wayland-gnome-screenshot",
            Command::new("gnome-screenshot")
                .args(["-w", "-f"])
                .arg(&path)
                .output()
                .map_err(|err| format!("failed to run gnome-screenshot: {err}"))?,
        ))
    } else if command_available("spectacle") {
        Some((
            "wayland-spectacle",
            Command::new("spectacle")
                .args(["-b", "-n", "-a", "-o"])
                .arg(&path)
                .output()
                .map_err(|err| format!("failed to run spectacle: {err}"))?,
        ))
    } else {
        None
    }) else {
        return Ok(None);
    };
    if !output.status.success() {
        return Ok(Some(NativePreviewFrame {
            captured: false,
            title: command.map(|value| value.to_string()),
            backend: Some(backend.into()),
            bounds: None,
            data_url: None,
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        }));
    }
    let bytes = fs::read(&path)
        .map_err(|err| format!("failed to read Wayland native preview frame: {err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(Some(NativePreviewFrame {
        captured: true,
        title: command.map(|value| value.to_string()),
        backend: Some(backend.into()),
        bounds: None,
        data_url: Some(format!("data:image/png;base64,{encoded}")),
        error: None,
    }))
}

#[cfg(target_os = "linux")]
fn preview_focus_x11(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<NativePreviewFocusResult>, String> {
    if std::env::var_os("DISPLAY").is_none()
        || !command_available("xprop")
        || !command_available("xdotool")
    {
        return Ok(None);
    }
    let Some(client) = find_x11_client_with_fallback(root_pid, command)? else {
        return Ok(Some(NativePreviewFocusResult {
            focused: false,
            backend: Some("x11".into()),
            error: Some("no matching X11 native window found yet".into()),
        }));
    };
    let output = Command::new("xdotool")
        .args(["windowactivate", &client.window_id])
        .output()
        .map_err(|err| format!("failed to run xdotool: {err}"))?;
    Ok(Some(NativePreviewFocusResult {
        focused: output.status.success(),
        backend: Some("x11".into()),
        error: (!output.status.success())
            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }))
}

#[cfg(target_os = "linux")]
fn preview_send_input_x11(
    input: &NativePreviewInput,
) -> Result<Option<NativePreviewInputResult>, String> {
    if std::env::var_os("DISPLAY").is_none()
        || !command_available("xprop")
        || !command_available("xdotool")
    {
        return Ok(None);
    }
    let Some(client) = find_x11_client_with_fallback(input.root_pid, input.command.as_deref())?
    else {
        return Ok(Some(NativePreviewInputResult {
            sent: false,
            backend: Some("x11".into()),
            error: Some("no matching X11 native window found yet".into()),
        }));
    };
    if let Some(text) = input.text.as_ref().filter(|text| !text.is_empty()) {
        let output = Command::new("xdotool")
            .args([
                "windowactivate",
                &client.window_id,
                "type",
                "--window",
                &client.window_id,
                text,
            ])
            .output()
            .map_err(|err| format!("failed to run xdotool: {err}"))?;
        return Ok(Some(NativePreviewInputResult {
            sent: output.status.success(),
            backend: Some("x11".into()),
            error: (!output.status.success())
                .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
        }));
    }
    if let Some(key) = input.key.as_ref().filter(|key| !key.is_empty()) {
        let output = Command::new("xdotool")
            .args([
                "windowactivate",
                &client.window_id,
                "key",
                "--window",
                &client.window_id,
                key,
            ])
            .output()
            .map_err(|err| format!("failed to run xdotool: {err}"))?;
        return Ok(Some(NativePreviewInputResult {
            sent: output.status.success(),
            backend: Some("x11".into()),
            error: (!output.status.success())
                .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
        }));
    }
    let button = input.button.unwrap_or(1).clamp(1, 5).to_string();
    let x = input.x.max(0).to_string();
    let y = input.y.max(0).to_string();
    let output = Command::new("xdotool")
        .args([
            "windowactivate",
            &client.window_id,
            "mousemove",
            "--window",
            &client.window_id,
            &x,
            &y,
            "click",
            &button,
        ])
        .output()
        .map_err(|err| format!("failed to run xdotool: {err}"))?;
    Ok(Some(NativePreviewInputResult {
        sent: output.status.success(),
        backend: Some("x11".into()),
        error: (!output.status.success())
            .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
    }))
}

#[cfg(target_os = "linux")]
fn preview_send_input_wayland(
    input: &NativePreviewInput,
) -> Result<Option<NativePreviewInputResult>, String> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Ok(None);
    }
    let _ = preview_focus_window_platform(NativePreviewFocusInput {
        root_pid: input.root_pid,
        command: input.command.clone(),
        target_name: input.target_name.clone(),
    });
    if let Some(button) = input.button {
        let (pointer_x, pointer_y) = wayland_pointer_position(input);
        if command_available("ydotool") {
            let output = if button == 4 || button == 5 {
                let delta = if button == 4 { "1" } else { "-1" };
                Command::new("ydotool").args(["wheel", delta]).output()
            } else {
                let button_name = match button {
                    2 => "0x02",
                    3 => "0x03",
                    _ => "0x01",
                };
                let x = pointer_x.to_string();
                let y = pointer_y.to_string();
                Command::new("ydotool")
                    .args(["mousemove", "--absolute", &x, &y])
                    .output()
                    .and_then(|_| {
                        Command::new("ydotool")
                            .args(["click", button_name])
                            .output()
                    })
            }
            .map_err(|err| format!("failed to run ydotool: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-ydotool".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
        if command_available("dotool") {
            let script = if button == 4 {
                "wheel 0 1\n".to_string()
            } else if button == 5 {
                "wheel 0 -1\n".to_string()
            } else {
                let button_name = match button {
                    2 => "middle",
                    3 => "right",
                    _ => "left",
                };
                format!("mouseto {pointer_x} {pointer_y}\nclick {button_name}\n")
            };
            let output = command_output_with_stdin("dotool", &["-"], script.as_bytes())
                .map_err(|err| format!("failed to run dotool: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-dotool".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
    }
    if let Some(text) = input.text.as_ref().filter(|text| !text.is_empty()) {
        if command_available("wtype") {
            let output = Command::new("wtype")
                .arg(text)
                .output()
                .map_err(|err| format!("failed to run wtype: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-wtype".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
        if command_available("ydotool") {
            let output = Command::new("ydotool")
                .args(["type", text])
                .output()
                .map_err(|err| format!("failed to run ydotool: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-ydotool".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
    }
    if let Some(key) = input.key.as_ref().filter(|key| !key.is_empty()) {
        if command_available("wtype") {
            let output = Command::new("wtype")
                .args(["-k", &wayland_wtype_key(key)])
                .output()
                .map_err(|err| format!("failed to run wtype: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-wtype".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
        if command_available("ydotool") {
            let output = Command::new("ydotool")
                .args(["key", &wayland_ydotool_key(key)])
                .output()
                .map_err(|err| format!("failed to run ydotool: {err}"))?;
            return Ok(Some(NativePreviewInputResult {
                sent: output.status.success(),
                backend: Some("wayland-ydotool".into()),
                error: (!output.status.success())
                    .then(|| String::from_utf8_lossy(&output.stderr).trim().to_string()),
            }));
        }
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn find_x11_client(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<X11Client>, String> {
    let output = Command::new("xprop")
        .args(["-root", "_NET_CLIENT_LIST"])
        .output()
        .map_err(|err| format!("failed to run xprop: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let ids = String::from_utf8_lossy(&output.stdout)
        .split('#')
        .nth(1)
        .unwrap_or_default()
        .split(',')
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    let descendants = root_pid.map(process_tree);
    let mut fallback: Option<X11Client> = None;
    for id in ids {
        let pid = x11_window_pid(&id);
        let client = X11Client {
            title: x11_window_title(&id),
            class: x11_window_class(&id),
            window_id: id,
        };
        if let Some(tree) = &descendants {
            if pid.is_some_and(|candidate| tree.contains(&candidate)) {
                return Ok(Some(client));
            }
            if fallback.is_none() && native_target_matches(command, [&client.title, &client.class])
            {
                fallback = Some(client);
            }
            continue;
        }
        if command.is_some() {
            /* only return a window when its title or class actually
            matches the command hint. previously this branch fell
            back to "first window in _NET_CLIENT_LIST" whenever no
            match was found — which silently grabbed whichever
            XWayland window happened to be oldest (typically the
            editor the user launched polypore from). for commands
            like `cargo tauri dev` or `npm run dev`, native_target_terms
            filters every token as a reserved word, so command
            matching can never succeed and the fallback always
            won. better to return None and let the UI keep
            polling until the real window appears in the process
            tree. */
            if native_target_matches(command, [&client.title, &client.class]) {
                return Ok(Some(client));
            }
        } else {
            return Ok(Some(client));
        }
    }
    Ok(fallback)
}

#[cfg(target_os = "linux")]
fn find_x11_client_with_fallback(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<X11Client>, String> {
    if let Some(client) = find_x11_client(root_pid, command)? {
        return Ok(Some(client));
    }
    if root_pid.is_some() {
        return find_x11_client(None, command);
    }
    Ok(None)
}

#[cfg(target_os = "linux")]
fn x11_window_pid(id: &str) -> Option<u32> {
    let output = Command::new("xprop")
        .args(["-id", id, "_NET_WM_PID"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .rsplit_once('=')?
        .1
        .trim()
        .parse()
        .ok()
}

#[cfg(target_os = "linux")]
fn x11_window_title(id: &str) -> Option<String> {
    let output = Command::new("xprop")
        .args(["-id", id, "_NET_WM_NAME"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value = raw.rsplit_once('=')?.1.trim();
    Some(value.trim_matches('"').to_string()).filter(|title| !title.is_empty())
}

#[cfg(target_os = "linux")]
fn x11_window_class(id: &str) -> Option<String> {
    let output = Command::new("xprop")
        .args(["-id", id, "WM_CLASS"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value = raw.rsplit_once('=')?.1.trim();
    Some(value.trim_matches('"').replace("\", \"", " ")).filter(|class| !class.is_empty())
}

#[cfg(target_os = "linux")]
fn find_hypr_client(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<HyprClient>, String> {
    if !hyprland_preview_available() {
        return Ok(None);
    }
    let output = Command::new("hyprctl")
        .args(["clients", "-j"])
        .output()
        .map_err(|err| format!("failed to run hyprctl: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let clients: Vec<HyprClient> = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("failed to parse hyprctl clients: {err}"))?;
    let Some(pid) = root_pid else {
        if command.is_some() {
            return Ok(clients
                .into_iter()
                .find(|client| native_target_matches(command, [&client.title, &client.class])));
        }
        return Ok(clients.into_iter().next());
    };
    let descendants = process_tree(pid);
    let mut fallback = None;
    for client in clients {
        if client
            .pid
            .is_some_and(|client_pid| descendants.contains(&client_pid))
        {
            return Ok(Some(client));
        }
        if fallback.is_none() && native_target_matches(command, [&client.title, &client.class]) {
            fallback = Some(client);
        }
    }
    Ok(fallback)
}

#[cfg(target_os = "linux")]
fn find_hypr_client_with_fallback(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<HyprClient>, String> {
    if let Some(client) = find_hypr_client(root_pid, command)? {
        return Ok(Some(client));
    }
    if root_pid.is_some() {
        return find_hypr_client(None, command);
    }
    Ok(None)
}
#[cfg(target_os = "linux")]
fn process_tree(root_pid: u32) -> HashSet<u32> {
    let mut parents: HashMap<u32, u32> = HashMap::new();
    if let Ok(entries) = fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            if let Some(ppid) = read_ppid(pid) {
                parents.insert(pid, ppid);
            }
        }
    }
    let mut tree = HashSet::from([root_pid]);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, ppid) in &parents {
            if tree.contains(ppid) && tree.insert(*pid) {
                changed = true;
            }
        }
    }
    tree
}

#[cfg(target_os = "linux")]
fn read_ppid(pid: u32) -> Option<u32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_name = stat.rsplit_once(") ")?.1;
    after_name.split_whitespace().nth(1)?.parse().ok()
}

#[cfg(target_os = "linux")]
fn command_output_with_stdin(
    command: &str,
    args: &[&str],
    stdin: &[u8],
) -> std::io::Result<std::process::Output> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut child_stdin) = child.stdin.take() {
        child_stdin.write_all(stdin)?;
    }
    child.wait_with_output()
}

#[cfg(target_os = "linux")]
fn wayland_wtype_key(key: &str) -> String {
    let mut parts = key.split('+').collect::<Vec<_>>();
    let base = parts.pop().unwrap_or_default();
    let mut mapped = parts
        .into_iter()
        .map(|modifier| match modifier {
            "ctrl" => "ctrl",
            "alt" => "alt",
            "shift" => "shift",
            "super" => "logo",
            other => other,
        })
        .collect::<Vec<_>>();
    mapped.push(match base {
        "Return" => "enter",
        "BackSpace" => "backspace",
        "Delete" => "delete",
        "Escape" => "esc",
        "Tab" => "tab",
        "Left" => "left",
        "Right" => "right",
        "Up" => "up",
        "Down" => "down",
        "Home" => "home",
        "End" => "end",
        "Page_Up" => "pageup",
        "Page_Down" => "pagedown",
        other => other,
    });
    mapped.join("+")
}

#[cfg(target_os = "linux")]
fn wayland_ydotool_key(key: &str) -> String {
    wayland_wtype_key(key)
}

#[cfg(target_os = "linux")]
fn wayland_pointer_position(input: &NativePreviewInput) -> (i64, i64) {
    let local_x = input.x.max(0);
    let local_y = input.y.max(0);
    let Some(client) = find_hypr_client(input.root_pid, input.command.as_deref())
        .ok()
        .flatten()
    else {
        return (local_x, local_y);
    };
    let at = client.at.unwrap_or_default();
    if at.len() < 2 {
        return (local_x, local_y);
    }
    (at[0].saturating_add(local_x), at[1].saturating_add(local_y))
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);
    command.args(args);
    let output = command
        .output()
        .map_err(|err| format!("failed to run powershell.exe: {err}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

#[cfg(target_os = "windows")]
const WINDOWS_CAPTURE_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$rootText = $args[0]
$path = $args[1]
$hintText = $args[2]
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public static class NativePreviewWin32 {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
}
'@
function Write-PreviewJson($value) {
  $value | ConvertTo-Json -Compress
}
function Get-HintTerms([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @($value -split '[\s/\\`"'':;=]+' | Where-Object {
    $_.Length -ge 3 -and $_ -notin @('npm','pnpm','yarn','bun','run','npx','node','cargo','tauri','dev','start','open','cmd','powershell','pwsh','bash','zsh')
  } | ForEach-Object { $_.ToLowerInvariant().Trim('.-_()[]') })
}
function Test-PreviewMatch($process, $terms) {
  if ($terms.Count -eq 0) { return $true }
  $haystack = (($process.ProcessName + ' ' + $process.MainWindowTitle).ToLowerInvariant())
  foreach ($term in $terms) {
    if ($haystack.Contains($term)) { return $true }
  }
  return $false
}
function Get-PreviewPids([int]$root) {
  $set = [System.Collections.Generic.HashSet[int]]::new()
  if ($root -le 0) { return @() }
  [void]$set.Add($root)
  $rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      $pid = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if ($set.Contains($parent) -and -not $set.Contains($pid)) {
        [void]$set.Add($pid)
        $changed = $true
      }
    }
  }
  return @($set)
}
try {
  $root = 0
  [void][int]::TryParse($rootText, [ref]$root)
  $ids = Get-PreviewPids $root
  if ($ids.Count -gt 0) {
    $processes = foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
  } else {
    $processes = Get-Process
  }
  $terms = Get-HintTerms $hintText
  $target = $processes | Where-Object {
    $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
  } | Select-Object -First 1
  if ($null -eq $target) {
    $target = $processes | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle)
    } | Select-Object -First 1
  }
  if ($null -eq $target -and $ids.Count -gt 0) {
    $target = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
    } | Select-Object -First 1
  }
  if ($null -eq $target) {
    Write-PreviewJson @{ captured = $false; error = 'no matching native window found yet' }
    exit 0
  }
  $rect = New-Object RECT
  if (-not [NativePreviewWin32]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
    Write-PreviewJson @{ captured = $false; title = $target.MainWindowTitle; error = 'failed to read native window bounds' }
    exit 0
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    Write-PreviewJson @{ captured = $false; title = $target.MainWindowTitle; error = 'native window has no capturable bounds' }
    exit 0
  }
  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  $printed = [NativePreviewWin32]::PrintWindow($target.MainWindowHandle, $hdc, 2)
  $graphics.ReleaseHdc($hdc)
  if (-not $printed) {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
  }
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  Write-PreviewJson @{
    captured = $true
    title = $target.MainWindowTitle
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
  }
} catch {
  Write-PreviewJson @{ captured = $false; error = $_.Exception.Message }
}
"#;

#[cfg(target_os = "windows")]
const WINDOWS_FOCUS_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$rootText = $args[0]
$hintText = $args[1]
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativePreviewWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
function Write-PreviewJson($value) { $value | ConvertTo-Json -Compress }
function Get-HintTerms([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @($value -split '[\s/\\`"'':;=]+' | Where-Object {
    $_.Length -ge 3 -and $_ -notin @('npm','pnpm','yarn','bun','run','npx','node','cargo','tauri','dev','start','open','cmd','powershell','pwsh','bash','zsh')
  } | ForEach-Object { $_.ToLowerInvariant().Trim('.-_()[]') })
}
function Test-PreviewMatch($process, $terms) {
  if ($terms.Count -eq 0) { return $true }
  $haystack = (($process.ProcessName + ' ' + $process.MainWindowTitle).ToLowerInvariant())
  foreach ($term in $terms) {
    if ($haystack.Contains($term)) { return $true }
  }
  return $false
}
function Get-PreviewPids([int]$root) {
  $set = [System.Collections.Generic.HashSet[int]]::new()
  if ($root -le 0) { return @() }
  [void]$set.Add($root)
  $rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      $pid = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if ($set.Contains($parent) -and -not $set.Contains($pid)) {
        [void]$set.Add($pid)
        $changed = $true
      }
    }
  }
  return @($set)
}
try {
  $root = 0
  [void][int]::TryParse($rootText, [ref]$root)
  $ids = Get-PreviewPids $root
  $processes = if ($ids.Count -gt 0) {
    foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
  } else {
    Get-Process
  }
  $terms = Get-HintTerms $hintText
  $target = $processes | Where-Object {
    $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
  } | Select-Object -First 1
  if ($null -eq $target) {
    $target = $processes | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle)
    } | Select-Object -First 1
  }
  if ($null -eq $target -and $ids.Count -gt 0) {
    $target = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
    } | Select-Object -First 1
  }
  if ($null -eq $target) {
    Write-PreviewJson @{ ok = $false; error = 'no matching native window found yet' }
    exit 0
  }
  $ok = [NativePreviewWin32]::SetForegroundWindow($target.MainWindowHandle)
  Write-PreviewJson @{ ok = $ok; error = $(if ($ok) { $null } else { 'failed to focus native window' }) }
} catch {
  Write-PreviewJson @{ ok = $false; error = $_.Exception.Message }
}
"#;

#[cfg(target_os = "windows")]
const WINDOWS_INPUT_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$rootText = $args[0]
$xText = $args[1]
$yText = $args[2]
$buttonText = $args[3]
$key = $args[4]
$text = $args[5]
$hintText = $args[6]
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public static class NativePreviewWin32 {
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@
Add-Type -AssemblyName System.Windows.Forms
function Write-PreviewJson($value) { $value | ConvertTo-Json -Compress }
function Get-HintTerms([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @($value -split '[\s/\\`"'':;=]+' | Where-Object {
    $_.Length -ge 3 -and $_ -notin @('npm','pnpm','yarn','bun','run','npx','node','cargo','tauri','dev','start','open','cmd','powershell','pwsh','bash','zsh')
  } | ForEach-Object { $_.ToLowerInvariant().Trim('.-_()[]') })
}
function Test-PreviewMatch($process, $terms) {
  if ($terms.Count -eq 0) { return $true }
  $haystack = (($process.ProcessName + ' ' + $process.MainWindowTitle).ToLowerInvariant())
  foreach ($term in $terms) {
    if ($haystack.Contains($term)) { return $true }
  }
  return $false
}
function Get-PreviewPids([int]$root) {
  $set = [System.Collections.Generic.HashSet[int]]::new()
  if ($root -le 0) { return @() }
  [void]$set.Add($root)
  $rows = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      $pid = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if ($set.Contains($parent) -and -not $set.Contains($pid)) {
        [void]$set.Add($pid)
        $changed = $true
      }
    }
  }
  return @($set)
}
function Convert-Key($value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return '' }
  $parts = $value -split '\+'
  $base = $parts[$parts.Length - 1]
  $prefix = ''
  foreach ($part in $parts[0..([Math]::Max(0, $parts.Length - 2))]) {
    if ($part -eq 'ctrl') { $prefix += '^' }
    elseif ($part -eq 'alt') { $prefix += '%' }
    elseif ($part -eq 'shift') { $prefix += '+' }
  }
  $mapped = switch ($base) {
    'Return' { '{ENTER}' }
    'BackSpace' { '{BACKSPACE}' }
    'Delete' { '{DELETE}' }
    'Escape' { '{ESC}' }
    'Tab' { '{TAB}' }
    'Left' { '{LEFT}' }
    'Right' { '{RIGHT}' }
    'Up' { '{UP}' }
    'Down' { '{DOWN}' }
    'Home' { '{HOME}' }
    'End' { '{END}' }
    'Page_Up' { '{PGUP}' }
    'Page_Down' { '{PGDN}' }
    default { $base }
  }
  return "$prefix$mapped"
}
try {
  $root = 0
  $x = 0
  $y = 0
  $button = 0
  [void][int]::TryParse($rootText, [ref]$root)
  [void][int]::TryParse($xText, [ref]$x)
  [void][int]::TryParse($yText, [ref]$y)
  [void][int]::TryParse($buttonText, [ref]$button)
  $ids = Get-PreviewPids $root
  $processes = if ($ids.Count -gt 0) {
    foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue }
  } else {
    Get-Process
  }
  $terms = Get-HintTerms $hintText
  $target = $processes | Where-Object {
    $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
  } | Select-Object -First 1
  if ($null -eq $target) {
    $target = $processes | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle)
    } | Select-Object -First 1
  }
  if ($null -eq $target -and $ids.Count -gt 0) {
    $target = Get-Process | Where-Object {
      $_.MainWindowHandle -ne 0 -and [NativePreviewWin32]::IsWindowVisible($_.MainWindowHandle) -and (Test-PreviewMatch $_ $terms)
    } | Select-Object -First 1
  }
  if ($null -eq $target) {
    Write-PreviewJson @{ ok = $false; error = 'no matching native window found yet' }
    exit 0
  }
  [void][NativePreviewWin32]::SetForegroundWindow($target.MainWindowHandle)
  if ($button -gt 0) {
    $rect = New-Object RECT
    if (-not [NativePreviewWin32]::GetWindowRect($target.MainWindowHandle, [ref]$rect)) {
      Write-PreviewJson @{ ok = $false; error = 'failed to read native window bounds' }
      exit 0
    }
    [void][NativePreviewWin32]::SetCursorPos($rect.Left + $x, $rect.Top + $y)
    if ($button -eq 2) {
      [NativePreviewWin32]::mouse_event(0x20, 0, 0, 0, [UIntPtr]::Zero)
      [NativePreviewWin32]::mouse_event(0x40, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($button -eq 3) {
      [NativePreviewWin32]::mouse_event(0x08, 0, 0, 0, [UIntPtr]::Zero)
      [NativePreviewWin32]::mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero)
    } elseif ($button -eq 4) {
      [NativePreviewWin32]::mouse_event(0x0800, 0, 0, 120, [UIntPtr]::Zero)
    } elseif ($button -eq 5) {
      [NativePreviewWin32]::mouse_event(0x0800, 0, 0, 4294967176, [UIntPtr]::Zero)
    } else {
      [NativePreviewWin32]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
      [NativePreviewWin32]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
    }
    Write-PreviewJson @{ ok = $true }
    exit 0
  }
  $sendKey = Convert-Key $key
  if (-not [string]::IsNullOrEmpty($sendKey)) {
    [System.Windows.Forms.SendKeys]::SendWait($sendKey)
    Write-PreviewJson @{ ok = $true }
    exit 0
  }
  if (-not [string]::IsNullOrEmpty($text)) {
    [System.Windows.Forms.SendKeys]::SendWait($text)
    Write-PreviewJson @{ ok = $true }
    exit 0
  }
  Write-PreviewJson @{ ok = $false; error = 'no native input requested' }
} catch {
  Write-PreviewJson @{ ok = $false; error = $_.Exception.Message }
}
"#;

#[cfg(target_os = "macos")]
fn find_macos_target(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<MacWindowTarget>, String> {
    let pids = root_pid.map(macos_process_tree).unwrap_or_default();
    let candidates = if pids.is_empty() {
        let output = Command::new("ps")
            .args(["-axo", "pid="])
            .output()
            .map_err(|err| format!("failed to run ps: {err}"))?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .collect::<Vec<_>>()
    } else {
        pids
    };
    for pid in candidates {
        if let Some(target) = macos_process_window(pid) {
            if root_pid.is_some()
                || command.is_none()
                || native_target_matches(command, [&target.title])
            {
                return Ok(Some(target));
            }
        }
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn macos_process_tree(root_pid: u32) -> Vec<u32> {
    let output = Command::new("ps").args(["-axo", "pid=,ppid="]).output();
    let Ok(output) = output else {
        return vec![root_pid];
    };
    let mut parents = HashMap::<u32, u32>::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.split_whitespace();
        let Some(pid) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
            continue;
        };
        let Some(ppid) = parts.next().and_then(|part| part.parse::<u32>().ok()) else {
            continue;
        };
        parents.insert(pid, ppid);
    }
    let mut tree = HashSet::from([root_pid]);
    let mut changed = true;
    while changed {
        changed = false;
        for (pid, ppid) in &parents {
            if tree.contains(ppid) && tree.insert(*pid) {
                changed = true;
            }
        }
    }
    tree.into_iter().collect()
}

#[cfg(target_os = "macos")]
fn macos_process_window(pid: u32) -> Option<MacWindowTarget> {
    let script = format!(
        "tell application \"System Events\"\nset matches to every process whose unix id is {}\nif (count of matches) is 0 then return \"\"\nset targetProcess to item 1 of matches\nif (count of windows of targetProcess) is 0 then return \"\"\nset targetWindow to window 1 of targetProcess\nset {{windowX, windowY}} to position of targetWindow\nset {{windowWidth, windowHeight}} to size of targetWindow\nreturn (name of targetProcess) & linefeed & windowX & \",\" & windowY & \",\" & windowWidth & \",\" & windowHeight\nend tell",
        pid,
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let mut lines = raw.lines();
    let title = lines
        .next()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    let bounds = lines.next().and_then(parse_macos_bounds);
    if title.is_none() && bounds.is_none() {
        return None;
    }
    Some(MacWindowTarget { pid, title, bounds })
}

#[cfg(target_os = "macos")]
fn parse_macos_bounds(raw: &str) -> Option<NativePreviewBounds> {
    let parts = raw
        .split(',')
        .filter_map(|part| part.trim().parse::<i64>().ok())
        .collect::<Vec<_>>();
    if parts.len() != 4 || parts[2] <= 0 || parts[3] <= 0 {
        return None;
    }
    Some(NativePreviewBounds {
        x: parts[0],
        y: parts[1],
        width: parts[2],
        height: parts[3],
    })
}

#[cfg(target_os = "macos")]
fn find_macos_target_with_fallback(
    root_pid: Option<u32>,
    command: Option<&str>,
) -> Result<Option<MacWindowTarget>, String> {
    if let Some(target) = find_macos_target(root_pid, command)? {
        return Ok(Some(target));
    }
    if root_pid.is_some() {
        return find_macos_target(None, command);
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn activate_macos_pid(pid: u32) -> Result<bool, String> {
    let script = format!(
        "tell application \"System Events\"\nset matches to every process whose unix id is {}\nif (count of matches) is 0 then return \"false\"\nset frontmost of item 1 of matches to true\nreturn \"true\"\nend tell",
        pid,
    );
    let output = Command::new("osascript")
        .args(["-e", &script])
        .output()
        .map_err(|err| format!("failed to run osascript: {err}"))?;
    if !output.status.success() {
        return Ok(false);
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "true")
}

#[cfg(target_os = "macos")]
fn macos_key_script(key: &str) -> String {
    let mut parts = key.split('+').collect::<Vec<_>>();
    let base = parts.pop().unwrap_or_default();
    let modifiers = parts
        .into_iter()
        .filter_map(|modifier| match modifier {
            "ctrl" => Some("control down"),
            "alt" => Some("option down"),
            "shift" => Some("shift down"),
            "super" => Some("command down"),
            _ => None,
        })
        .collect::<Vec<_>>();
    let key_code = match base {
        "Return" => Some(36),
        "BackSpace" => Some(51),
        "Delete" => Some(117),
        "Escape" => Some(53),
        "Tab" => Some(48),
        "Left" => Some(123),
        "Right" => Some(124),
        "Down" => Some(125),
        "Up" => Some(126),
        "Home" => Some(115),
        "End" => Some(119),
        "Page_Up" => Some(116),
        "Page_Down" => Some(121),
        _ => None,
    };
    let using = if modifiers.is_empty() {
        String::new()
    } else {
        format!(" using {{{}}}", modifiers.join(", "))
    };
    if let Some(code) = key_code {
        format!("tell application \"System Events\" to key code {code}{using}")
    } else {
        format!(
            "tell application \"System Events\" to keystroke {}{}",
            serde_json::to_string(base).unwrap_or_else(|_| "\"\"".into()),
            using,
        )
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
#[repr(C)]
struct MacCGPoint {
    x: f64,
    y: f64,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        mouse_type: u32,
        mouse_cursor_position: MacCGPoint,
        mouse_button: u32,
    ) -> *mut c_void;
    fn CGEventCreateScrollWheelEvent(
        source: *const c_void,
        units: u32,
        wheel_count: u32,
        ...
    ) -> *mut c_void;
    fn CGEventPost(tap: u32, event: *mut c_void);
    fn CFRelease(cf: *const c_void);
}

#[cfg(target_os = "macos")]
fn macos_send_pointer(bounds: Option<&NativePreviewBounds>, x: i64, y: i64, button: u8) -> bool {
    const EVENT_TAP: u32 = 0;
    const SCROLL_UNIT_PIXEL: u32 = 0;
    const LEFT_DOWN: u32 = 1;
    const LEFT_UP: u32 = 2;
    const RIGHT_DOWN: u32 = 3;
    const RIGHT_UP: u32 = 4;
    const OTHER_DOWN: u32 = 25;
    const OTHER_UP: u32 = 26;
    const LEFT_BUTTON: u32 = 0;
    const RIGHT_BUTTON: u32 = 1;
    const CENTER_BUTTON: u32 = 2;

    if button == 4 || button == 5 {
        let delta = if button == 4 { 120 } else { -120 };
        unsafe {
            let event =
                CGEventCreateScrollWheelEvent(std::ptr::null(), SCROLL_UNIT_PIXEL, 1, delta);
            if event.is_null() {
                return false;
            }
            CGEventPost(EVENT_TAP, event);
            CFRelease(event);
        }
        return true;
    }

    let screen_x = bounds
        .map(|bounds| bounds.x)
        .unwrap_or_default()
        .saturating_add(x.max(0));
    let screen_y = bounds
        .map(|bounds| bounds.y)
        .unwrap_or_default()
        .saturating_add(y.max(0));
    let point = MacCGPoint {
        x: screen_x as f64,
        y: screen_y as f64,
    };
    let (down, up, mouse_button) = match button {
        2 => (OTHER_DOWN, OTHER_UP, CENTER_BUTTON),
        3 => (RIGHT_DOWN, RIGHT_UP, RIGHT_BUTTON),
        _ => (LEFT_DOWN, LEFT_UP, LEFT_BUTTON),
    };
    unsafe {
        let down_event = CGEventCreateMouseEvent(std::ptr::null(), down, point, mouse_button);
        if down_event.is_null() {
            return false;
        }
        CGEventPost(EVENT_TAP, down_event);
        CFRelease(down_event);
        let up_event = CGEventCreateMouseEvent(std::ptr::null(), up, point, mouse_button);
        if up_event.is_null() {
            return false;
        }
        CGEventPost(EVENT_TAP, up_event);
        CFRelease(up_event);
    }
    true
}

#[cfg(target_os = "linux")]
fn command_available(command: &str) -> bool {
    which::which(command).is_ok()
}

fn frame_path() -> PathBuf {
    std::env::temp_dir().join("polypore-native-preview.png")
}

fn native_target_matches<'a, I>(command: Option<&str>, values: I) -> bool
where
    I: IntoIterator<Item = &'a Option<String>>,
{
    let terms = native_target_terms(command);
    if terms.is_empty() {
        return false;
    }
    let haystack = values
        .into_iter()
        .filter_map(|value| value.as_deref())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    !haystack.is_empty() && terms.iter().any(|term| haystack.contains(term))
}

fn native_target_terms(command: Option<&str>) -> Vec<String> {
    let Some(command) = command else {
        return Vec::new();
    };
    command
        .split(|ch: char| {
            ch.is_whitespace() || matches!(ch, '/' | '\\' | '"' | '\'' | ':' | ';' | '=')
        })
        .map(|part| {
            part.trim_matches(|ch: char| matches!(ch, '.' | '-' | '_' | '(' | ')' | '[' | ']'))
        })
        .filter(|part| part.len() >= 3)
        .filter(|part| {
            !matches!(
                part.to_ascii_lowercase().as_str(),
                "npm"
                    | "pnpm"
                    | "yarn"
                    | "bun"
                    | "run"
                    | "npx"
                    | "node"
                    | "cargo"
                    | "tauri"
                    | "dev"
                    | "start"
                    | "open"
                    | "cmd"
                    | "powershell"
                    | "pwsh"
                    | "bash"
                    | "zsh"
                    | "sh"
            )
        })
        .map(|part| part.to_ascii_lowercase())
        .collect()
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn platform_backend_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "native"
    }
}
