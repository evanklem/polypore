use std::process::Command;

#[tauri::command]
pub fn open_external_url(url: String) -> Result<bool, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("external previews only support http and https urls".into());
    }

    let mut command = if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(trimmed);
        cmd
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("rundll32");
        cmd.arg("url.dll,FileProtocolHandler").arg(trimmed);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(trimmed);
        cmd
    };

    command
        .spawn()
        .map_err(|err| format!("failed to open external preview: {err}"))?;
    Ok(true)
}
