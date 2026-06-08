use std::process::Command;

#[derive(Clone, Debug, serde::Serialize)]
pub struct NotificationResult {
    pub shown: bool,
    pub backend: String,
    pub message: String,
}

#[tauri::command]
pub fn os_notify(title: String, body: String) -> NotificationResult {
    let (backend, program, args) = notification_command(&title, &body);
    let result = Command::new(program)
        .args(args)
        .output()
        .map(|output| (output.status.success(), backend));

    match result {
        Ok((true, backend)) => NotificationResult {
            shown: true,
            backend: backend.to_string(),
            message: "notification shown".to_string(),
        },
        Ok((false, backend)) => NotificationResult {
            shown: false,
            backend: backend.to_string(),
            message: "notification backend returned an error".to_string(),
        },
        Err(err) => NotificationResult {
            shown: false,
            backend: "unavailable".to_string(),
            message: format!("notification backend unavailable: {err}"),
        },
    }
}

fn notification_command(title: &str, body: &str) -> (&'static str, &'static str, Vec<String>) {
    if cfg!(target_os = "macos") {
        return (
            "osascript",
            "osascript",
            vec![
                "-e".into(),
                "on run argv".into(),
                "-e".into(),
                "display notification item 2 of argv with title item 1 of argv".into(),
                "-e".into(),
                "end run".into(),
                title.into(),
                body.into(),
            ],
        );
    }
    if cfg!(target_os = "windows") {
        return (
            "powershell",
            "powershell",
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                "param($Title, $Body) New-BurntToastNotification -Text $Title, $Body".into(),
                title.into(),
                body.into(),
            ],
        );
    }
    (
        "notify-send",
        "notify-send",
        vec![title.into(), body.into()],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notification_command_passes_message_as_arguments() {
        let payload = "\"; touch /tmp/polypore-notify-injected; \"";
        let (_, _, args) = notification_command("title", payload);

        assert!(args.iter().any(|arg| arg == payload));
        assert!(!args
            .iter()
            .any(|arg| arg.contains("touch /tmp/polypore-notify-injected") && arg != payload));
    }
}
