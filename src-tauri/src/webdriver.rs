//! Web auto-nav (phase 1.5) — an OPTIONAL, detected capability.
//!
//! When the project has Playwright installed, the agent can drive web surfaces
//! itself (navigate/click/fill/login) to reach the broken state. When it is
//! absent, the host degrades to the manual roadblock handoff — so this whole
//! module is a pure accelerator with no fallback of its own.
//!
//! Playwright is a Node library, so the actual browser driving lives in
//! `scripts/polypore-web-driver.mjs`, spawned with cwd = project root (so
//! `import('playwright')` resolves the project's install). We talk to it over
//! the same `Content-Length`-framed JSON the rest of the shell uses, but the
//! protocol here is plain request/response (no async events), so a blocking
//! write-then-read per command is enough — no reader thread.
//!
//! Secret-injected login resolves handles to values IN THE SHELL
//! (`secrets::resolve_secret_for_injection`) and types them via the driver. The
//! raw value flows shell→driver→page over trusted stdio and never reaches the
//! agent — same trust model as the secrets broker.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::project_context;
use crate::secrets;

const DRIVER_SCRIPT: &str = "scripts/polypore-web-driver.mjs";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct WebDriverRegistry {
    drivers: Mutex<HashMap<String, WebDriver>>,
}

struct WebDriver {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    seq: AtomicI64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesOutput {
    pub web_auto_nav: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSessionInput {
    pub session_id: String,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebNavigateInput {
    pub session_id: String,
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebClickInput {
    pub session_id: String,
    pub selector: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFillInput {
    pub session_id: String,
    pub selector: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebLoginInput {
    pub session_id: String,
    #[serde(default)]
    pub url: Option<String>,
    pub username_selector: String,
    pub password_selector: String,
    pub username_secret: String,
    pub password_secret: String,
    #[serde(default)]
    pub submit_selector: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
}

// ── detection ──────────────────────────────────────────────────────────────

/// Project-local Playwright install — the reliable signal (web apps carry it as
/// a devDep), and project-first means we never need to bundle browsers.
fn playwright_in_project(root: &Path) -> bool {
    root.join("node_modules/playwright/package.json").exists()
        || root.join("node_modules/.bin/playwright").exists()
        || root
            .join("node_modules/@playwright/test/package.json")
            .exists()
}

/// Global Playwright on PATH (a `--version` probe), for repos that rely on a
/// global install. Mirrors the agent PATH-probe approach in `project.rs`.
fn playwright_on_path() -> bool {
    Command::new("playwright")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn web_auto_nav_available() -> bool {
    let root = match project_context::active_project_root() {
        Ok(root) => root,
        Err(_) => return false,
    };
    playwright_in_project(&root) || playwright_on_path()
}

// ── registry / driver lifecycle ─────────────────────────────────────────────

impl WebDriverRegistry {
    fn with_driver<T>(
        &self,
        session_id: &str,
        run: impl FnOnce(&mut WebDriver) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut drivers = self
            .drivers
            .lock()
            .map_err(|_| "web driver lock failed".to_string())?;
        if !drivers.contains_key(session_id) {
            drivers.insert(session_id.to_string(), spawn_driver()?);
        }
        let driver = drivers
            .get_mut(session_id)
            .ok_or_else(|| "web driver missing after spawn".to_string())?;
        run(driver)
    }

    pub fn start(&self, input: WebSessionInput) -> Result<Value, String> {
        self.with_driver(&input.session_id, |driver| {
            if let Some(url) = &input.url {
                driver.command("navigate", json!({ "url": url }))?;
            }
            Ok(json!({ "ok": true }))
        })
    }

    pub fn navigate(&self, input: WebNavigateInput) -> Result<Value, String> {
        self.with_driver(&input.session_id, |driver| {
            driver.command("navigate", json!({ "url": input.url }))?;
            Ok(json!({ "url": input.url, "ok": true }))
        })
    }

    pub fn click(&self, input: WebClickInput) -> Result<Value, String> {
        self.with_driver(&input.session_id, |driver| {
            driver.command("click", json!({ "selector": input.selector }))?;
            Ok(json!({ "ok": true }))
        })
    }

    pub fn fill(&self, input: WebFillInput) -> Result<Value, String> {
        self.with_driver(&input.session_id, |driver| {
            driver.command(
                "fill",
                json!({ "selector": input.selector, "value": input.text }),
            )?;
            Ok(json!({ "ok": true }))
        })
    }

    pub fn login(&self, input: WebLoginInput) -> Result<Value, String> {
        // resolve handles → values IN THE SHELL; the agent never sees them.
        let scope = input.scope.as_deref();
        let username = secrets::resolve_secret_for_injection(&input.username_secret, scope)?;
        let password = secrets::resolve_secret_for_injection(&input.password_secret, scope)?;
        self.with_driver(&input.session_id, |driver| {
            if let Some(url) = &input.url {
                driver.command("navigate", json!({ "url": url }))?;
            }
            driver.command(
                "fill",
                json!({ "selector": input.username_selector, "value": username }),
            )?;
            driver.command(
                "fill",
                json!({ "selector": input.password_selector, "value": password }),
            )?;
            if let Some(submit) = &input.submit_selector {
                driver.command("click", json!({ "selector": submit }))?;
            }
            Ok(json!({ "ok": true }))
        })
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let driver = self
            .drivers
            .lock()
            .map_err(|_| "web driver lock failed".to_string())?
            .remove(session_id);
        if let Some(mut driver) = driver {
            let _ = driver.command("close", json!({}));
            let _ = driver.child.kill();
            let _ = driver.child.wait();
        }
        Ok(())
    }
}

fn spawn_driver() -> Result<WebDriver, String> {
    let root = project_context::active_project_root()?;
    let mut child = Command::new("node")
        .arg(DRIVER_SCRIPT)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("failed to start web driver: {err}"))?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "web driver stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "web driver stdout unavailable".to_string())?;
    let mut driver = WebDriver {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        seq: AtomicI64::new(0),
    };
    // the driver greets with `{ ready: true }` once playwright launched, or
    // `{ error }` if the import failed — surface that as a clear message.
    let ready = driver.read_message()?;
    if ready.get("ready").and_then(|v| v.as_bool()) != Some(true) {
        let err = ready
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("web driver failed to start");
        return Err(err.to_string());
    }
    Ok(driver)
}

impl WebDriver {
    fn command(&mut self, command: &str, args: Value) -> Result<Value, String> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        write_message(
            &mut self.stdin,
            &json!({ "seq": seq, "command": command, "args": args }),
        )?;
        let response = self.read_message()?;
        if response.get("ok").and_then(|v| v.as_bool()) == Some(false) {
            let message = response
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("web driver command failed");
            return Err(format!("{command} failed: {message}"));
        }
        Ok(response)
    }

    fn read_message(&mut self) -> Result<Value, String> {
        read_message(&mut self.stdout, COMMAND_TIMEOUT)
    }
}

// ── Content-Length framing (request/response, blocking) ──────────────────────

fn write_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message)
        .map_err(|err| format!("failed to encode web driver message: {err}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", bytes.len())
        .map_err(|err| format!("failed to write web driver header: {err}"))?;
    stdin
        .write_all(&bytes)
        .map_err(|err| format!("failed to write web driver body: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("failed to flush web driver message: {err}"))
}

fn read_message(reader: &mut BufReader<ChildStdout>, _timeout: Duration) -> Result<Value, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut header = String::new();
        let read = reader
            .read_line(&mut header)
            .map_err(|err| format!("failed to read web driver header: {err}"))?;
        if read == 0 {
            return Err("web driver closed the connection".to_string());
        }
        let header = header.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
    }
    let len =
        content_length.ok_or_else(|| "web driver message missing Content-Length".to_string())?;
    let mut body = vec![0_u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|err| format!("failed to read web driver body: {err}"))?;
    serde_json::from_slice(&body)
        .map_err(|err| format!("failed to parse web driver message: {err}"))
}

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn debug_web_capabilities() -> CapabilitiesOutput {
    CapabilitiesOutput {
        web_auto_nav: web_auto_nav_available(),
    }
}

#[tauri::command]
pub fn debug_web_start(
    registry: tauri::State<'_, WebDriverRegistry>,
    input: WebSessionInput,
) -> Result<Value, String> {
    registry.start(input)
}

#[tauri::command]
pub fn debug_web_navigate(
    registry: tauri::State<'_, WebDriverRegistry>,
    input: WebNavigateInput,
) -> Result<Value, String> {
    registry.navigate(input)
}

#[tauri::command]
pub fn debug_web_click(
    registry: tauri::State<'_, WebDriverRegistry>,
    input: WebClickInput,
) -> Result<Value, String> {
    registry.click(input)
}

#[tauri::command]
pub fn debug_web_fill(
    registry: tauri::State<'_, WebDriverRegistry>,
    input: WebFillInput,
) -> Result<Value, String> {
    registry.fill(input)
}

#[tauri::command]
pub fn debug_web_login(
    registry: tauri::State<'_, WebDriverRegistry>,
    input: WebLoginInput,
) -> Result<Value, String> {
    registry.login(input)
}

#[tauri::command]
pub fn debug_web_stop(
    registry: tauri::State<'_, WebDriverRegistry>,
    session_id: String,
) -> Result<(), String> {
    registry.stop(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn detects_a_project_local_playwright_install() {
        let dir = std::env::temp_dir().join(format!("polypore-pw-{}", std::process::id()));
        let pw = dir.join("node_modules/playwright");
        fs::create_dir_all(&pw).unwrap();
        fs::write(pw.join("package.json"), "{}").unwrap();
        assert!(playwright_in_project(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_no_install_when_node_modules_is_empty() {
        let dir = std::env::temp_dir().join(format!("polypore-pw-empty-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!playwright_in_project(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn frames_a_request_response_round_trip() {
        // a response framed exactly as the node driver writes it parses back.
        use std::io::Cursor;
        let body = serde_json::to_vec(&json!({ "seq": 1, "ok": true })).unwrap();
        let framed = format!("Content-Length: {}\r\n\r\n", body.len());
        let mut bytes = framed.into_bytes();
        bytes.extend_from_slice(&body);
        // BufReader<ChildStdout> can't be built in a test, so exercise the
        // header/body split via the same logic on a Cursor.
        let mut reader = std::io::BufReader::new(Cursor::new(bytes));
        let mut content_length: Option<usize> = None;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end_matches(['\r', '\n']);
            if header.is_empty() {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let len = content_length.unwrap();
        let mut payload = vec![0_u8; len];
        reader.read_exact(&mut payload).unwrap();
        let parsed: Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(parsed.get("ok").and_then(|v| v.as_bool()), Some(true));
    }
}
