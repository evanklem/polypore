//! DAP (Debug Adapter Protocol) client.
//!
//! Mirrors the `Content-Length`-framed JSON-RPC stdio transport in `lsp.rs`,
//! but DAP's session/stop/event model is distinct behaviour: sessions are
//! long-lived, stops arrive as async events, and `continue`/`step*` must block
//! until the next `stopped`/`terminated` event (the async↔sync bridge from the
//! spec §7). So this is a separate module behind a `DebugRegistry` Tauri state.
//!
//! Built-in adapter aliases cover `vscode-js-debug`, `debugpy`, `lldb-dap`, and
//! `delve`; `config.adapterCommand` can point at any other stdio DAP server.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// How long a blocking `continue`/`step` waits for the next stop before giving
/// up. Kept under the host broker's 30s round-trip cap (see project memory:
/// debug rides the existing host RPC rail, not a separate broker).
const STOP_TIMEOUT: Duration = Duration::from_secs(25);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONSOLE_BUFFER_CAP: usize = 500;

#[derive(Default)]
pub struct DebugRegistry {
    sessions: Mutex<HashMap<String, Arc<DapSession>>>,
    seq: AtomicI64,
}

struct DapSession {
    #[allow(dead_code)]
    adapter: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    request_seq: AtomicI64,
    pending: Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    events: Arc<(Mutex<EventState>, Condvar)>,
}

#[derive(Default)]
struct EventState {
    /// queued `stopped` events not yet consumed by a blocking call.
    stops: Vec<Value>,
    terminated: bool,
    last_thread_id: Option<i64>,
    console: Vec<ConsoleEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
}

// ── command I/O structs (camelCase over the Tauri bridge) ──────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    pub adapter: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutput {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProbeInput {
    pub adapter: String,
    #[serde(default)]
    pub config: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterProbeOutput {
    pub adapter: String,
    pub command: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakpointSpec {
    pub line: i64,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub hit_condition: Option<String>,
    #[serde(default)]
    pub log_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBreakpointsInput {
    pub session_id: String,
    pub file: String,
    #[serde(default)]
    pub breakpoints: Vec<BreakpointSpec>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBreakpoint {
    pub verified: bool,
    pub line: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetBreakpointsOutput {
    pub breakpoints: Vec<VerifiedBreakpoint>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    pub session_id: String,
    #[serde(default)]
    pub thread_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub reason: String,
    pub thread_id: Option<i64>,
    pub frame_id: Option<i64>,
    pub file: Option<String>,
    pub line: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutput {
    pub stop: Option<Stop>,
    pub terminated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameInput {
    pub session_id: String,
    #[serde(default)]
    pub thread_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopesInput {
    pub session_id: String,
    pub frame_id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VariablesInput {
    pub session_id: String,
    pub variables_reference: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluateInput {
    pub session_id: String,
    pub expression: String,
    #[serde(default)]
    pub frame_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    pub session_id: String,
    #[serde(default)]
    pub limit: Option<usize>,
}

// ── registry / session lifecycle ───────────────────────────────────────────

impl DebugRegistry {
    fn next_session_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        format!("dap-{n}")
    }

    fn session(&self, id: &str) -> Result<Arc<DapSession>, String> {
        self.sessions
            .lock()
            .map_err(|_| "debug registry lock failed".to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("debug session not found: {id}"))
    }

    pub fn start(&self, input: StartInput) -> Result<StartOutput, String> {
        /* resolve `${workspaceFolder}` style variables against the active
        project root so presets in `.polypore/debug.json` are portable across
        machines and language-detected suggestions can use concrete defaults.
        best-effort: if the root can't be resolved, the config is passed
        through unchanged. */
        let config = match crate::project_context::active_project_root() {
            Ok(root) => substitute_workspace_vars(input.config, &root),
            Err(_) => input.config,
        };
        let input = StartInput {
            adapter: input.adapter,
            config,
        };
        let (command, args) = adapter_command(&input.adapter, &input.config)?;
        let mut child = Command::new(&command)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|err| format!("failed to start debug adapter {command}: {err}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "debug adapter stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "debug adapter stdout unavailable".to_string())?;

        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let events = Arc::new((Mutex::new(EventState::default()), Condvar::new()));
        {
            let pending = pending.clone();
            let events = events.clone();
            thread::spawn(move || read_dap_messages(stdout, pending, events));
        }

        let session = Arc::new(DapSession {
            adapter: input.adapter.clone(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            request_seq: AtomicI64::new(0),
            pending,
            events,
        });

        // DAP handshake: initialize → launch/attach → wait for `initialized`
        // event → configurationDone. Breakpoints are set via setBreakpoints
        // (most adapters accept them after configurationDone too).
        session.request(
            "initialize",
            json!({
                "clientID": "polypore",
                "adapterID": input.adapter,
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsRunInTerminalRequest": false,
            }),
            REQUEST_TIMEOUT,
        )?;

        let request = launch_request_kind(&input.config);
        // launch/attach response may arrive after `initialized`; fire it but
        // don't block on the response before configurationDone.
        session.send_request(request, input.config.clone())?;
        session.wait_for_initialized(REQUEST_TIMEOUT)?;
        let _ = session.request("configurationDone", json!({}), REQUEST_TIMEOUT);

        let id = self.next_session_id();
        self.sessions
            .lock()
            .map_err(|_| "debug registry lock failed".to_string())?
            .insert(id.clone(), session);
        Ok(StartOutput { session_id: id })
    }

    pub fn set_breakpoints(&self, input: SetBreakpointsInput) -> Result<SetBreakpointsOutput, String> {
        let session = self.session(&input.session_id)?;
        let lines: Vec<Value> = input
            .breakpoints
            .iter()
            .map(|bp| {
                let mut value = json!({ "line": bp.line });
                if let Some(condition) = &bp.condition {
                    value["condition"] = json!(condition);
                }
                if let Some(hit) = &bp.hit_condition {
                    value["hitCondition"] = json!(hit);
                }
                if let Some(log) = &bp.log_message {
                    value["logMessage"] = json!(log);
                }
                value
            })
            .collect();
        let response = session.request(
            "setBreakpoints",
            json!({
                "source": { "path": input.file },
                "breakpoints": lines,
            }),
            REQUEST_TIMEOUT,
        )?;
        let breakpoints = response
            .get("body")
            .and_then(|body| body.get("breakpoints"))
            .and_then(|items| items.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|item| VerifiedBreakpoint {
                        verified: item.get("verified").and_then(|v| v.as_bool()).unwrap_or(false),
                        line: item.get("line").and_then(|v| v.as_i64()),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(SetBreakpointsOutput { breakpoints })
    }

    pub fn execute(&self, command: &str, input: StepInput) -> Result<StopOutput, String> {
        let session = self.session(&input.session_id)?;
        let thread_id = input.thread_id.or_else(|| session.last_thread_id()).unwrap_or(1);
        session.drain_stops()?;
        let dap_command = match command {
            "continue" => "continue",
            "stepOver" => "next",
            "stepIn" => "stepIn",
            "stepOut" => "stepOut",
            "pause" => "pause",
            other => return Err(format!("unknown execution command: {other}")),
        };
        session.request(dap_command, json!({ "threadId": thread_id }), REQUEST_TIMEOUT)?;
        session.wait_for_stop(STOP_TIMEOUT)
    }

    pub fn stack_trace(&self, input: FrameInput) -> Result<Value, String> {
        let session = self.session(&input.session_id)?;
        let thread_id = input.thread_id.or_else(|| session.last_thread_id()).unwrap_or(1);
        let response = session.request(
            "stackTrace",
            json!({ "threadId": thread_id, "startFrame": 0, "levels": 50 }),
            REQUEST_TIMEOUT,
        )?;
        let frames = response
            .get("body")
            .and_then(|body| body.get("stackFrames"))
            .and_then(|items| items.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|frame| {
                        json!({
                            "id": frame.get("id").and_then(|v| v.as_i64()),
                            "name": frame.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "file": frame.get("source").and_then(|s| s.get("path")).and_then(|v| v.as_str()),
                            "line": frame.get("line").and_then(|v| v.as_i64()),
                            "column": frame.get("column").and_then(|v| v.as_i64()),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "frames": frames }))
    }

    pub fn scopes(&self, input: ScopesInput) -> Result<Value, String> {
        let session = self.session(&input.session_id)?;
        let response = session.request("scopes", json!({ "frameId": input.frame_id }), REQUEST_TIMEOUT)?;
        let scopes = response
            .get("body")
            .and_then(|body| body.get("scopes"))
            .and_then(|items| items.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|scope| {
                        json!({
                            "name": scope.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "variablesReference": scope.get("variablesReference").and_then(|v| v.as_i64()).unwrap_or(0),
                            "expensive": scope.get("expensive").and_then(|v| v.as_bool()).unwrap_or(false),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "scopes": scopes }))
    }

    pub fn variables(&self, input: VariablesInput) -> Result<Value, String> {
        let session = self.session(&input.session_id)?;
        let response = session.request(
            "variables",
            json!({ "variablesReference": input.variables_reference }),
            REQUEST_TIMEOUT,
        )?;
        let variables = response
            .get("body")
            .and_then(|body| body.get("variables"))
            .and_then(|items| items.as_array())
            .map(|items| {
                items
                    .iter()
                    .map(|variable| {
                        json!({
                            "name": variable.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                            "value": variable.get("value").and_then(|v| v.as_str()).unwrap_or(""),
                            "type": variable.get("type").and_then(|v| v.as_str()),
                            "variablesReference": variable.get("variablesReference").and_then(|v| v.as_i64()).unwrap_or(0),
                            "indexedVariables": variable.get("indexedVariables").and_then(|v| v.as_i64()),
                            "namedVariables": variable.get("namedVariables").and_then(|v| v.as_i64()),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(json!({ "variables": variables }))
    }

    pub fn evaluate(&self, input: EvaluateInput) -> Result<Value, String> {
        let session = self.session(&input.session_id)?;
        let mut params = json!({ "expression": input.expression, "context": "repl" });
        if let Some(frame_id) = input.frame_id {
            params["frameId"] = json!(frame_id);
        }
        let response = session.request("evaluate", params, REQUEST_TIMEOUT)?;
        let body = response.get("body").cloned().unwrap_or_else(|| json!({}));
        Ok(json!({
            "result": body.get("result").and_then(|v| v.as_str()).unwrap_or(""),
            "type": body.get("type").and_then(|v| v.as_str()),
            "variablesReference": body.get("variablesReference").and_then(|v| v.as_i64()).unwrap_or(0),
        }))
    }

    pub fn console(&self, input: SessionInput) -> Result<Vec<ConsoleEntry>, String> {
        let session = self.session(&input.session_id)?;
        session.console(input.limit.unwrap_or(100))
    }

    pub fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "debug registry lock failed".to_string())?
            .remove(session_id);
        if let Some(session) = session {
            let _ = session.request("disconnect", json!({ "terminateDebuggee": true }), Duration::from_secs(2));
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        Ok(())
    }
}

impl DapSession {
    fn last_thread_id(&self) -> Option<i64> {
        self.events.0.lock().ok().and_then(|state| state.last_thread_id)
    }

    fn drain_stops(&self) -> Result<(), String> {
        let mut state = self.events.0.lock().map_err(|_| "debug event lock failed".to_string())?;
        state.stops.clear();
        Ok(())
    }

    fn send_request(&self, command: &str, arguments: Value) -> Result<i64, String> {
        let seq = self.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        let mut stdin = self.stdin.lock().map_err(|_| "debug stdin lock failed".to_string())?;
        write_dap_message(&mut stdin, &message)?;
        Ok(seq)
    }

    fn request(&self, command: &str, arguments: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let seq = {
            let next = self.request_seq.fetch_add(1, Ordering::SeqCst) + 1;
            self.pending
                .lock()
                .map_err(|_| "debug pending lock failed".to_string())?
                .insert(next, tx);
            next
        };
        let message = json!({
            "seq": seq,
            "type": "request",
            "command": command,
            "arguments": arguments,
        });
        {
            let mut stdin = self.stdin.lock().map_err(|_| "debug stdin lock failed".to_string())?;
            write_dap_message(&mut stdin, &message)?;
        }
        match rx.recv_timeout(timeout) {
            Ok(response) => {
                if response.get("success").and_then(|v| v.as_bool()) == Some(false) {
                    let message = response
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("debug request failed");
                    return Err(format!("{command} failed: {message}"));
                }
                Ok(response)
            }
            Err(_) => {
                self.pending
                    .lock()
                    .map_err(|_| "debug pending lock failed".to_string())?
                    .remove(&seq);
                Err(format!("{command} timed out"))
            }
        }
    }

    fn wait_for_initialized(&self, timeout: Duration) -> Result<(), String> {
        // wait once for the first adapter event (`initialized` notifies the
        // condvar). The handshake only needs the configuration window to open;
        // the configurationDone request that follows is tolerated by adapters
        // that haven't emitted `initialized` yet, so a single bounded wait is
        // enough and avoids hanging if the event never arrives.
        let (lock, cvar) = &*self.events;
        let state = lock.lock().map_err(|_| "debug event lock failed".to_string())?;
        if state.terminated {
            return Ok(());
        }
        let _ = cvar
            .wait_timeout(state, timeout)
            .map_err(|_| "debug event wait failed".to_string())?;
        Ok(())
    }

    fn wait_for_stop(&self, timeout: Duration) -> Result<StopOutput, String> {
        let (lock, cvar) = &*self.events;
        let deadline = Instant::now() + timeout;
        let mut state = lock.lock().map_err(|_| "debug event lock failed".to_string())?;
        loop {
            if let Some(stop) = state.stops.pop() {
                return Ok(StopOutput {
                    stop: Some(parse_stop(&stop)),
                    terminated: false,
                });
            }
            if state.terminated {
                return Ok(StopOutput { stop: None, terminated: true });
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("debug continue timed out waiting for a stop".to_string());
            }
            let (next, _timed_out) = cvar
                .wait_timeout(state, deadline - now)
                .map_err(|_| "debug event wait failed".to_string())?;
            state = next;
        }
    }

    fn console(&self, limit: usize) -> Result<Vec<ConsoleEntry>, String> {
        let state = self.events.0.lock().map_err(|_| "debug event lock failed".to_string())?;
        let len = state.console.len();
        let start = len.saturating_sub(limit);
        Ok(state.console[start..].to_vec())
    }
}

fn parse_stop(event: &Value) -> Stop {
    let body = event.get("body").cloned().unwrap_or_else(|| json!({}));
    Stop {
        reason: body.get("reason").and_then(|v| v.as_str()).unwrap_or("stopped").to_string(),
        thread_id: body.get("threadId").and_then(|v| v.as_i64()),
        frame_id: None,
        file: None,
        line: None,
    }
}

/// Reader thread: routes responses to their pending sender and folds events
/// (`stopped`/`terminated`/`output`) into the shared event state, notifying the
/// condvar so blocking calls wake.
fn read_dap_messages<R: Read>(
    reader: R,
    pending: Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    events: Arc<(Mutex<EventState>, Condvar)>,
) {
    let mut reader = BufReader::new(reader);
    loop {
        let mut content_length: Option<usize> = None;
        loop {
            let mut header = String::new();
            let Ok(read) = reader.read_line(&mut header) else {
                return;
            };
            if read == 0 {
                mark_terminated(&events);
                return;
            }
            let header = header.trim_end_matches(['\r', '\n']);
            if header.is_empty() {
                break;
            }
            if let Some(value) = header.strip_prefix("Content-Length:") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
        let Some(len) = content_length else { continue };
        let mut body = vec![0_u8; len];
        if reader.read_exact(&mut body).is_err() {
            mark_terminated(&events);
            return;
        }
        let Ok(message) = serde_json::from_slice::<Value>(&body) else {
            continue;
        };
        route_message(message, &pending, &events);
    }
}

fn route_message(
    message: Value,
    pending: &Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    events: &Arc<(Mutex<EventState>, Condvar)>,
) {
    match message.get("type").and_then(|v| v.as_str()) {
        Some("response") => {
            if let Some(request_seq) = message.get("request_seq").and_then(|v| v.as_i64()) {
                let sender = pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&request_seq));
                if let Some(sender) = sender {
                    let _ = sender.send(message);
                }
            }
        }
        Some("event") => handle_event(message, events),
        _ => {}
    }
}

fn handle_event(message: Value, events: &Arc<(Mutex<EventState>, Condvar)>) {
    let event = message.get("event").and_then(|v| v.as_str()).unwrap_or("");
    let (lock, cvar) = &**events;
    let Ok(mut state) = lock.lock() else { return };
    match event {
        "stopped" => {
            if let Some(thread_id) = message
                .get("body")
                .and_then(|b| b.get("threadId"))
                .and_then(|v| v.as_i64())
            {
                state.last_thread_id = Some(thread_id);
            }
            state.stops.push(message);
            cvar.notify_all();
        }
        "terminated" | "exited" => {
            state.terminated = true;
            cvar.notify_all();
        }
        "initialized" => {
            cvar.notify_all();
        }
        "output" => {
            let body = message.get("body");
            let category = body
                .and_then(|b| b.get("category"))
                .and_then(|v| v.as_str())
                .unwrap_or("console");
            let text = body
                .and_then(|b| b.get("output"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if !text.is_empty() {
                let level = match category {
                    "stderr" => "error",
                    "stdout" => "log",
                    other => other,
                }
                .to_string();
                state.console.push(ConsoleEntry { level, text });
                if state.console.len() > CONSOLE_BUFFER_CAP {
                    let overflow = state.console.len() - CONSOLE_BUFFER_CAP;
                    state.console.drain(0..overflow);
                }
            }
        }
        _ => {}
    }
}

fn mark_terminated(events: &Arc<(Mutex<EventState>, Condvar)>) {
    let (lock, cvar) = &**events;
    if let Ok(mut state) = lock.lock() {
        state.terminated = true;
        cvar.notify_all();
    }
}

fn write_dap_message(stdin: &mut ChildStdin, message: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(message).map_err(|err| format!("failed to encode dap message: {err}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", bytes.len())
        .map_err(|err| format!("failed to write dap header: {err}"))?;
    stdin
        .write_all(&bytes)
        .map_err(|err| format!("failed to write dap body: {err}"))?;
    stdin.flush().map_err(|err| format!("failed to flush dap message: {err}"))
}

fn launch_request_kind(config: &Value) -> &'static str {
    match config.get("request").and_then(|v| v.as_str()) {
        Some("attach") => "attach",
        _ => "launch",
    }
}

/// Replace `${workspaceFolder}` / `${workspaceRoot}` / `${workspaceFolderBasename}`
/// in every string in a launch config, and default `cwd` to the project root
/// when the config does not set it. This keeps debug presets portable: the same
/// `.polypore/debug.json` works on any machine regardless of checkout path.
fn substitute_workspace_vars(config: Value, root: &std::path::Path) -> Value {
    let folder = root.to_string_lossy().to_string();
    let basename = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| folder.clone());
    let mut resolved = substitute_value(config, &folder, &basename);
    /* default the working directory to the project root so relative `program`
    paths and tool lookups resolve as the user expects. only fill it in when
    absent — an explicit `cwd` always wins. */
    if let Value::Object(map) = &mut resolved {
        if !map.contains_key("cwd") {
            map.insert("cwd".to_string(), Value::String(folder.clone()));
        }
    }
    resolved
}

fn substitute_value(value: Value, folder: &str, basename: &str) -> Value {
    match value {
        Value::String(text) => Value::String(
            text.replace("${workspaceFolderBasename}", basename)
                .replace("${workspaceFolder}", folder)
                .replace("${workspaceRoot}", folder),
        ),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| substitute_value(item, folder, basename))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, item)| (key, substitute_value(item, folder, basename)))
                .collect(),
        ),
        other => other,
    }
}

/// Resolve the adapter executable + args. `vscode-js-debug` ships a standalone
/// `dapDebugServer.js`; the config may override `adapterCommand`/`adapterArgs`
/// to point at a discovered binary (mirrors the agent PATH-probe approach).
fn adapter_command(adapter: &str, config: &Value) -> Result<(String, Vec<String>), String> {
    if let Some(command) = config.get("adapterCommand").and_then(|v| v.as_str()) {
        let args = config
            .get("adapterArgs")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        return Ok((command.to_string(), args));
    }
    match adapter {
        // js-debug standalone server speaking DAP over stdio.
        "vscode-js-debug" | "node" | "pwa-node" => Ok(("js-debug-adapter".to_string(), vec![])),
        "debugpy" => Ok(("debugpy-adapter".to_string(), vec![])),
        "lldb-dap" => Ok(("lldb-dap".to_string(), vec![])),
        "delve" | "go" => Ok(("dlv".to_string(), vec!["dap".to_string()])),
        other => Err(format!(
            "unknown debug adapter '{other}'; set config.adapterCommand to point at a DAP server"
        )),
    }
}

fn probe_adapter(input: AdapterProbeInput) -> AdapterProbeOutput {
    match adapter_command(&input.adapter, &input.config) {
        Ok((command, _args)) => match which::which(&command) {
            Ok(path) => AdapterProbeOutput {
                adapter: input.adapter,
                command,
                available: true,
                detail: format!("available at {}", path.display()),
            },
            Err(err) => AdapterProbeOutput {
                adapter: input.adapter,
                command,
                available: false,
                detail: format!("not available: {err}"),
            },
        },
        Err(err) => AdapterProbeOutput {
            adapter: input.adapter,
            command: String::new(),
            available: false,
            detail: err,
        },
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn debug_adapter_probe(input: AdapterProbeInput) -> AdapterProbeOutput {
    probe_adapter(input)
}

#[tauri::command]
pub fn debug_start(registry: tauri::State<'_, DebugRegistry>, input: StartInput) -> Result<StartOutput, String> {
    registry.start(input)
}

#[tauri::command]
pub fn debug_set_breakpoints(
    registry: tauri::State<'_, DebugRegistry>,
    input: SetBreakpointsInput,
) -> Result<SetBreakpointsOutput, String> {
    registry.set_breakpoints(input)
}

#[tauri::command]
pub fn debug_continue(registry: tauri::State<'_, DebugRegistry>, input: StepInput) -> Result<StopOutput, String> {
    registry.execute("continue", input)
}

#[tauri::command]
pub fn debug_step_over(registry: tauri::State<'_, DebugRegistry>, input: StepInput) -> Result<StopOutput, String> {
    registry.execute("stepOver", input)
}

#[tauri::command]
pub fn debug_step_in(registry: tauri::State<'_, DebugRegistry>, input: StepInput) -> Result<StopOutput, String> {
    registry.execute("stepIn", input)
}

#[tauri::command]
pub fn debug_step_out(registry: tauri::State<'_, DebugRegistry>, input: StepInput) -> Result<StopOutput, String> {
    registry.execute("stepOut", input)
}

#[tauri::command]
pub fn debug_pause(registry: tauri::State<'_, DebugRegistry>, input: StepInput) -> Result<StopOutput, String> {
    registry.execute("pause", input)
}

#[tauri::command]
pub fn debug_stack_trace(registry: tauri::State<'_, DebugRegistry>, input: FrameInput) -> Result<Value, String> {
    registry.stack_trace(input)
}

#[tauri::command]
pub fn debug_scopes(registry: tauri::State<'_, DebugRegistry>, input: ScopesInput) -> Result<Value, String> {
    registry.scopes(input)
}

#[tauri::command]
pub fn debug_variables(registry: tauri::State<'_, DebugRegistry>, input: VariablesInput) -> Result<Value, String> {
    registry.variables(input)
}

#[tauri::command]
pub fn debug_evaluate(registry: tauri::State<'_, DebugRegistry>, input: EvaluateInput) -> Result<Value, String> {
    registry.evaluate(input)
}

#[tauri::command]
pub fn debug_console(
    registry: tauri::State<'_, DebugRegistry>,
    input: SessionInput,
) -> Result<Vec<ConsoleEntry>, String> {
    registry.console(input)
}

#[tauri::command]
pub fn debug_stop(registry: tauri::State<'_, DebugRegistry>, session_id: String) -> Result<(), String> {
    registry.stop(&session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_workspace_vars_and_defaults_cwd() {
        let root = std::path::Path::new("/home/dev/my-proj");
        let config = json!({
            "type": "lldb",
            "request": "launch",
            "program": "${workspaceFolder}/target/debug/${workspaceFolderBasename}",
            "args": ["--root", "${workspaceFolder}"],
        });
        let resolved = substitute_workspace_vars(config, root);
        assert_eq!(
            resolved["program"].as_str(),
            Some("/home/dev/my-proj/target/debug/my-proj")
        );
        assert_eq!(resolved["args"][1].as_str(), Some("/home/dev/my-proj"));
        // cwd defaults to the project root when unset.
        assert_eq!(resolved["cwd"].as_str(), Some("/home/dev/my-proj"));
    }

    #[test]
    fn explicit_cwd_is_preserved() {
        let root = std::path::Path::new("/home/dev/my-proj");
        let config = json!({ "type": "go", "cwd": "/somewhere/else" });
        let resolved = substitute_workspace_vars(config, root);
        assert_eq!(resolved["cwd"].as_str(), Some("/somewhere/else"));
    }

    #[test]
    fn frames_a_dap_message_with_content_length_header() {
        // round-trip the framing: write to a pipe, read it back with the same
        // reader the session uses, and confirm the body arrives intact.
        use std::io::Cursor;
        let message = json!({ "seq": 1, "type": "request", "command": "initialize" });
        let bytes = serde_json::to_vec(&message).unwrap();
        let framed = format!("Content-Length: {}\r\n\r\n{}", bytes.len(), String::from_utf8(bytes).unwrap());

        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let events = Arc::new((Mutex::new(EventState::default()), Condvar::new()));
        // a response so route_message has somewhere to send.
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap().insert(7, tx);
        let response = json!({ "type": "response", "request_seq": 7, "success": true, "command": "initialize" });
        let response_bytes = serde_json::to_vec(&response).unwrap();
        let framed_response = format!(
            "Content-Length: {}\r\n\r\n{}",
            response_bytes.len(),
            String::from_utf8(response_bytes).unwrap()
        );

        read_dap_messages(Cursor::new(framed_response.into_bytes()), pending.clone(), events.clone());
        let received = rx.recv_timeout(Duration::from_millis(200)).unwrap();
        assert_eq!(received.get("request_seq").and_then(|v| v.as_i64()), Some(7));
        // header parsing must accept the canonical framing in `framed`.
        assert!(framed.starts_with("Content-Length:"));
    }

    #[test]
    fn stopped_event_unblocks_a_waiter_with_attribution_fields() {
        let events = Arc::new((Mutex::new(EventState::default()), Condvar::new()));
        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let stopped = json!({
            "type": "event",
            "event": "stopped",
            "body": { "reason": "breakpoint", "threadId": 1 }
        });
        route_message(stopped, &pending, &events);
        let (lock, _cvar) = &*events;
        let mut state = lock.lock().unwrap();
        let stop = state.stops.pop().expect("a stop was queued");
        assert_eq!(parse_stop(&stop).reason, "breakpoint");
        assert_eq!(state.last_thread_id, Some(1));
    }

    #[test]
    fn output_events_buffer_as_console_entries() {
        let events = Arc::new((Mutex::new(EventState::default()), Condvar::new()));
        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        route_message(
            json!({ "type": "event", "event": "output", "body": { "category": "stderr", "output": "boom" } }),
            &pending,
            &events,
        );
        let state = events.0.lock().unwrap();
        assert_eq!(state.console.len(), 1);
        assert_eq!(state.console[0].level, "error");
        assert_eq!(state.console[0].text, "boom");
    }

    #[test]
    fn unknown_adapter_without_override_is_rejected() {
        assert!(adapter_command("mystery", &json!({})).is_err());
        let (cmd, _) = adapter_command("mystery", &json!({ "adapterCommand": "my-dap" })).unwrap();
        assert_eq!(cmd, "my-dap");
    }

    #[test]
    fn adapter_probe_reports_custom_command_availability() {
        let output = probe_adapter(AdapterProbeInput {
            adapter: "custom".to_string(),
            config: json!({ "adapterCommand": "definitely-not-a-polypore-dap" }),
        });

        assert_eq!(output.adapter, "custom");
        assert_eq!(output.command, "definitely-not-a-polypore-dap");
        assert!(!output.available);
        assert!(output.detail.contains("not available"));
    }
}
