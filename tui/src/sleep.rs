//! Manual stay-awake toggle. Off at every launch, released when polypore
//! exits, even on a crash: the helper watches our pid and restores state.
//!
//! Linux: `systemd-inhibit` blocks suspend; on Omarchy the shell ignores
//! systemd inhibitors, so the helper also flips omarchy's stay-awake flag and
//! restores the previous value on exit.
//! macOS: `caffeinate -w <pid>`.

use std::process::{Child, Command, Stdio};

pub struct Sleep {
    child: Option<Child>,
    pub note: String,
}

impl Sleep {
    pub fn new() -> Sleep {
        Sleep { child: None, note: String::new() }
    }

    pub fn active(&mut self) -> bool {
        if let Some(c) = self.child.as_mut() {
            if let Ok(Some(_)) = c.try_wait() {
                self.child = None;
                self.note = "inhibitor exited".into();
            }
        }
        self.child.is_some()
    }

    pub fn toggle(&mut self, what: &str, omarchy: bool) -> Result<bool, String> {
        if self.active() {
            self.release();
            return Ok(false);
        }
        self.engage(what, omarchy)?;
        Ok(true)
    }

    fn engage(&mut self, what: &str, omarchy: bool) -> Result<(), String> {
        let pid = std::process::id();
        #[cfg(target_os = "linux")]
        {
            let has_omarchy = omarchy && which("omarchy-toggle-idle");
            let script = format!(
                r#"prev=""
{set}
cleanup() {{ {restore} exit 0; }}
trap cleanup EXIT TERM INT HUP
while kill -0 {pid} 2>/dev/null; do sleep 2 & wait $!; done"#,
                set = if has_omarchy {
                    "prev=$(omarchy-toggle-idle status 2>/dev/null); omarchy-toggle-idle stay-awake >/dev/null"
                } else {
                    ""
                },
                restore = if has_omarchy {
                    r#"case "$prev" in *'"enabled":true'*) ;; *) omarchy-toggle-idle allow-idle >/dev/null ;; esac;"#
                } else {
                    ""
                },
            );
            let mut cmd = if which("systemd-inhibit") {
                let mut c = Command::new("systemd-inhibit");
                c.args([
                    &format!("--what={what}"),
                    "--who=polypore",
                    "--why=polypore stay-awake toggle",
                    "--mode=block",
                    "bash",
                    "-c",
                    &script,
                ]);
                c
            } else if has_omarchy {
                let mut c = Command::new("bash");
                c.args(["-c", &script]);
                c
            } else {
                return Err("no systemd-inhibit found".into());
            };
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
            cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let child = cmd.spawn().map_err(|e| e.to_string())?;
            self.note = if has_omarchy { format!("{what} + omarchy stay-awake") } else { what.to_string() };
            self.child = Some(child);
            Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            let _ = omarchy;
            let mut args = vec!["-i".to_string()];
            if what.contains("idle") {
                args.push("-d".into());
            }
            args.push("-w".into());
            args.push(pid.to_string());
            let child = Command::new("caffeinate")
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            self.note = "caffeinate".into();
            self.child = Some(child);
            Ok(())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (what, omarchy, pid);
            Err("stay-awake is not supported on this platform yet".into())
        }
    }

    pub fn release(&mut self) {
        if let Some(mut c) = self.child.take() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(c.id() as libc::pid_t), libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        self.release();
    }
}

pub fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}
