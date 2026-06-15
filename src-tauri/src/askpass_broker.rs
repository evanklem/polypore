//! Askpass broker — gives git/ssh a non-terminal channel to answer credential
//! prompts. The `__askpass` helper subcommand POSTs a prompt here; the host
//! raises a modal in the originating window and the renderer resolves it.
//!
//! The security-bearing core is the pending-prompt registry below: it must
//! fail closed on cancel (so git fails cleanly) and never retain a secret past
//! the single request that asked for it (we cache nothing).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::broker_security::{broker_token, token_matches, MAX_BROKER_BODY_BYTES};

/// Env flag set on the git child so the re-executed binary knows it is the
/// askpass helper rather than the app. Paired with the broker url + token.
pub const HELPER_FLAG_ENV: &str = "POLYPORE_ASKPASS";
pub const BROKER_URL_ENV: &str = "POLYPORE_ASKPASS_URL";
pub const BROKER_TOKEN_ENV: &str = "POLYPORE_ASKPASS_TOKEN";

/// Registry of in-flight credential prompts. Each `begin` hands the caller a
/// waiter that blocks until the renderer `resolve`s or `cancel`s the matching
/// id. The secret itself never lives in this struct: it travels through the
/// channel and is owned only by the waiter that delivers it to git/ssh.
#[derive(Default)]
pub struct PendingPrompts {
    next_id: AtomicU64,
    pending: Mutex<HashMap<String, Sender<Result<String, String>>>>,
}

/// Blocking handle returned by [`PendingPrompts::begin`]. The TCP handler calls
/// [`PromptWaiter::wait`] and writes the result back to the helper.
pub struct PromptWaiter {
    receiver: Receiver<Result<String, String>>,
}

impl PendingPrompts {
    /// Register a new prompt, returning its id (sent to the renderer) and a
    /// waiter the request thread blocks on.
    pub fn begin(&self) -> (String, PromptWaiter) {
        let id = format!("askpass-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .expect("askpass pending lock poisoned")
            .insert(id.clone(), sender);
        (id, PromptWaiter { receiver })
    }

    /// Deliver a secret to the waiter for `id`. Errors if no such prompt is
    /// still pending (already resolved, cancelled, or never existed).
    pub fn resolve(&self, id: &str, secret: String) -> Result<(), String> {
        self.complete(id, Ok(secret))
    }

    /// Cancel the prompt for `id`, failing its waiter so git/ssh exits cleanly.
    /// Errors if no such prompt is still pending.
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.complete(id, Err("askpass prompt cancelled".to_string()))
    }

    /// Remove the pending entry for `id` and hand its waiter the terminal
    /// outcome. Each prompt completes exactly once: the entry is gone
    /// afterwards, so a second `resolve`/`cancel` reports it no longer pending.
    fn complete(&self, id: &str, outcome: Result<String, String>) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "askpass pending lock poisoned".to_string())?
            .remove(id)
            .ok_or_else(|| "askpass prompt is no longer pending".to_string())?;
        sender
            .send(outcome)
            .map_err(|_| "askpass waiter is gone".to_string())
    }
}

impl PromptWaiter {
    /// Block until the prompt is resolved or cancelled. `Err` means the helper
    /// should exit nonzero so git/ssh fails cleanly.
    pub fn wait(self) -> Result<String, String> {
        match self.receiver.recv() {
            Ok(result) => result,
            Err(_) => Err("askpass prompt was abandoned".to_string()),
        }
    }
}

/// Localhost broker the helper POSTs to. Mirrors `host_broker`: bind
/// `127.0.0.1:0`, mint a token, one thread per connection, emit a Tauri event
/// and block on the renderer's answer. Holds no secret state of its own.
#[derive(Clone, Default)]
pub struct AskpassBroker {
    inner: Arc<AskpassBrokerInner>,
}

#[derive(Default)]
struct AskpassBrokerInner {
    state: Mutex<Option<AskpassBrokerState>>,
    prompts: PendingPrompts,
}

#[derive(Clone, Debug)]
pub struct AskpassBrokerState {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
struct AskpassRequest {
    prompt: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskpassEvent {
    id: String,
    prompt: String,
}

/// Raises a prompt in the UI (id, prompt text). Returns `Err` if the prompt
/// could not be surfaced, in which case the request fails fast. Decoupled from
/// the `AppHandle` so the broker's TCP+auth+resolve path is testable.
type PromptNotifier = Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>;

impl AskpassBroker {
    pub fn ensure_started(&self, app: tauri::AppHandle) -> Result<AskpassBrokerState, String> {
        let notifier: PromptNotifier = Arc::new(move |id: &str, prompt: &str| {
            app.emit(
                "polypore://askpass-prompt",
                AskpassEvent {
                    id: id.to_string(),
                    prompt: prompt.to_string(),
                },
            )
            .map_err(|err| format!("failed to emit askpass prompt: {err}"))
        });
        self.start_with_notifier(notifier)
    }

    fn start_with_notifier(&self, notifier: PromptNotifier) -> Result<AskpassBrokerState, String> {
        let mut guard = self
            .inner
            .state
            .lock()
            .map_err(|_| "askpass broker lock failed".to_string())?;
        if let Some(state) = guard.clone() {
            return Ok(state);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|err| format!("failed to bind askpass broker: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("failed to read askpass broker address: {err}"))?;
        let token = broker_token("polypore-askpass")?;
        let thread_token = token.clone();
        let inner = self.inner.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let token = thread_token.clone();
                let inner = inner.clone();
                let notifier = notifier.clone();
                thread::spawn(move || {
                    let _ = handle_stream(stream, &token, inner, notifier);
                });
            }
        });

        let state = AskpassBrokerState {
            url: format!("http://{addr}"),
            token,
        };
        *guard = Some(state.clone());
        Ok(state)
    }

    pub fn resolve(&self, id: &str, secret: String) -> Result<(), String> {
        self.inner.prompts.resolve(id, secret)
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        self.inner.prompts.cancel(id)
    }
}

#[tauri::command]
pub fn askpass_respond(
    broker: tauri::State<'_, AskpassBroker>,
    id: String,
    secret: String,
) -> Result<(), String> {
    broker.resolve(&id, secret)
}

#[tauri::command]
pub fn askpass_cancel(broker: tauri::State<'_, AskpassBroker>, id: String) -> Result<(), String> {
    broker.cancel(&id)
}

fn handle_stream(
    mut stream: TcpStream,
    token: &str,
    inner: Arc<AskpassBrokerInner>,
    notifier: PromptNotifier,
) -> Result<(), String> {
    let mut reader = BufReader::new(
        stream
            .try_clone()
            .map_err(|err| format!("failed to clone broker stream: {err}"))?,
    );
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|err| format!("failed to read request line: {err}"))?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    let mut content_length = 0_usize;
    let mut authed = false;
    loop {
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|err| format!("failed to read header: {err}"))?;
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().unwrap_or(0);
            }
            if key.eq_ignore_ascii_case("x-polypore-token") && token_matches(value.trim(), token) {
                authed = true;
            }
        }
    }

    if method != "POST" || path != "/askpass" || !authed {
        return write_json(
            &mut stream,
            403,
            serde_json::json!({ "error": "forbidden" }),
        );
    }
    if content_length > MAX_BROKER_BODY_BYTES {
        return write_json(
            &mut stream,
            413,
            serde_json::json!({ "error": "request too large" }),
        );
    }

    let mut body = vec![0_u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|err| format!("failed to read body: {err}"))?;
    let request: AskpassRequest = serde_json::from_slice(&body).map_err(|err| err.to_string())?;

    let (id, waiter) = inner.prompts.begin();
    if let Err(err) = notifier(&id, &request.prompt) {
        // Nothing will resolve the prompt; cancel so begin's entry is cleared.
        let _ = inner.prompts.cancel(&id);
        return write_json(&mut stream, 500, serde_json::json!({ "error": err }));
    }

    // Cancel-only: block with no timeout until the renderer answers or cancels.
    match waiter.wait() {
        Ok(secret) => write_json(&mut stream, 200, serde_json::json!({ "secret": secret })),
        Err(err) => write_json(&mut stream, 499, serde_json::json!({ "error": err })),
    }
}

fn write_json(stream: &mut TcpStream, status: u16, value: serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec(&value).map_err(|err| err.to_string())?;
    let status_text = if status == 200 { "OK" } else { "ERROR" };
    write!(
        stream,
        "HTTP/1.1 {status} {status_text}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    )
    .map_err(|err| format!("failed to write response headers: {err}"))?;
    stream
        .write_all(&body)
        .map_err(|err| format!("failed to write response body: {err}"))
}

/// True when this process was re-executed by git/ssh as the askpass helper.
/// Checked at the very top of `main` before any GUI initialisation.
pub fn running_as_helper() -> bool {
    std::env::var(HELPER_FLAG_ENV).is_ok()
}

/// Helper mode: ask the broker to surface the prompt, print the answer git/ssh
/// is waiting for on stdout, and exit. Exits nonzero on any failure or cancel so
/// the git operation fails cleanly rather than proceeding without a credential.
pub fn run_helper_and_exit() -> ! {
    let code = match run_helper() {
        Ok(secret) => {
            // git/ssh read the first line of stdout as the answer.
            println!("{secret}");
            0
        }
        Err(_) => 1,
    };
    std::process::exit(code);
}

fn run_helper() -> Result<String, String> {
    let prompt = std::env::args().nth(1).unwrap_or_default();
    let url = std::env::var(BROKER_URL_ENV).map_err(|_| "askpass url missing".to_string())?;
    let token = std::env::var(BROKER_TOKEN_ENV).map_err(|_| "askpass token missing".to_string())?;

    let response = reqwest::blocking::Client::new()
        .post(format!("{url}/askpass"))
        .header("x-polypore-token", token)
        .json(&serde_json::json!({ "prompt": prompt }))
        .send()
        .map_err(|err| format!("askpass request failed: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("askpass declined: {}", response.status()));
    }
    let body: serde_json::Value = response
        .json()
        .map_err(|err| format!("askpass response unreadable: {err}"))?;
    body.get("secret")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .ok_or_else(|| "askpass response had no secret".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolved_prompt_delivers_secret_to_waiter() {
        let prompts = PendingPrompts::default();
        let (id, waiter) = prompts.begin();

        prompts.resolve(&id, "hunter2".to_string()).unwrap();

        assert_eq!(waiter.wait().unwrap(), "hunter2");
    }

    #[test]
    fn cancelled_prompt_fails_the_waiter() {
        let prompts = PendingPrompts::default();
        let (id, waiter) = prompts.begin();

        prompts.cancel(&id).unwrap();

        assert!(waiter.wait().is_err());
    }

    #[test]
    fn helper_request_round_trips_secret_through_broker() {
        let broker = AskpassBroker::default();
        // Stand in for the renderer: when a prompt is raised, answer it.
        let answering = broker.clone();
        let notifier: PromptNotifier = Arc::new(move |id: &str, _prompt: &str| {
            let broker = answering.clone();
            let id = id.to_string();
            thread::spawn(move || {
                let _ = broker.resolve(&id, "s3cr3t".to_string());
            });
            Ok(())
        });
        let state = broker.start_with_notifier(notifier).unwrap();

        let response = reqwest::blocking::Client::new()
            .post(format!("{}/askpass", state.url))
            .header("x-polypore-token", &state.token)
            .json(&serde_json::json!({ "prompt": "Enter passphrase for key" }))
            .send()
            .unwrap();

        assert!(response.status().is_success());
        let body: serde_json::Value = response.json().unwrap();
        assert_eq!(body["secret"], "s3cr3t");
    }

    #[test]
    fn broker_rejects_requests_without_the_token() {
        let broker = AskpassBroker::default();
        let notifier: PromptNotifier = Arc::new(|_id: &str, _prompt: &str| Ok(()));
        let state = broker.start_with_notifier(notifier).unwrap();

        let response = reqwest::blocking::Client::new()
            .post(format!("{}/askpass", state.url))
            .header("x-polypore-token", "wrong-token")
            .json(&serde_json::json!({ "prompt": "Enter passphrase for key" }))
            .send()
            .unwrap();

        assert_eq!(response.status().as_u16(), 403);
    }

    #[test]
    fn a_prompt_completes_at_most_once() {
        let prompts = PendingPrompts::default();
        let (id, waiter) = prompts.begin();

        prompts.resolve(&id, "first".to_string()).unwrap();
        // The entry is gone, so a second completion finds nothing pending —
        // proof the resolved secret was not retained.
        let second = prompts.resolve(&id, "second".to_string());

        assert_eq!(
            second,
            Err("askpass prompt is no longer pending".to_string())
        );
        assert_eq!(waiter.wait().unwrap(), "first");
    }

    #[test]
    fn unknown_id_is_not_pending() {
        let prompts = PendingPrompts::default();

        assert_eq!(
            prompts.resolve("askpass-999", "x".to_string()),
            Err("askpass prompt is no longer pending".to_string())
        );
    }
}
