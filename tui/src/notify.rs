//! Desktop notifications via the platform's standard CLI, throttled.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct Notifier {
    last: HashMap<String, Instant>,
    pub enabled: bool,
}

impl Notifier {
    pub fn new() -> Notifier {
        Notifier { last: HashMap::new(), enabled: true }
    }

    pub fn send(&mut self, key: &str, title: &str, body: &str) {
        if !self.enabled {
            return;
        }
        let now = Instant::now();
        if let Some(t) = self.last.get(key) {
            if now.duration_since(*t) < Duration::from_secs(20) {
                return;
            }
        }
        self.last.insert(key.to_string(), now);
        let title = title.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            #[cfg(target_os = "macos")]
            {
                let script = format!(
                    "display notification {:?} with title {:?}",
                    body.replace('"', "'"),
                    title.replace('"', "'")
                );
                let _ = Command::new("osascript").args(["-e", &script]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = Command::new("notify-send")
                    .args(["-a", "polypore", "-i", "utilities-terminal", &title, &body])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        });
    }
}
