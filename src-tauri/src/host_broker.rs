use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Emitter;

use crate::broker_security::{broker_token, token_matches, MAX_BROKER_BODY_BYTES};

#[derive(Clone, Default)]
pub struct HostBroker {
    inner: Arc<HostBrokerInner>,
}

#[derive(Default)]
struct HostBrokerInner {
    state: Mutex<Option<HostBrokerState>>,
    pending: Mutex<HashMap<String, Sender<Result<serde_json::Value, String>>>>,
}

#[derive(Clone, Debug)]
pub struct HostBrokerState {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcRequest {
    method: String,
    params: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RpcEvent {
    id: String,
    method: String,
    params: serde_json::Value,
}

impl HostBroker {
    pub fn ensure_started(&self, app: tauri::AppHandle) -> Result<HostBrokerState, String> {
        let mut guard = self
            .inner
            .state
            .lock()
            .map_err(|_| "host broker lock failed".to_string())?;
        if let Some(state) = guard.clone() {
            return Ok(state);
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|err| format!("failed to bind host broker: {err}"))?;
        let addr = listener
            .local_addr()
            .map_err(|err| format!("failed to read host broker address: {err}"))?;
        let token = broker_token("polypore-host")?;
        let thread_token = token.clone();
        let inner = self.inner.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let token = thread_token.clone();
                let inner = inner.clone();
                let app = app.clone();
                thread::spawn(move || {
                    let _ = handle_stream(stream, &token, inner, app);
                });
            }
        });

        let state = HostBrokerState {
            url: format!("http://{addr}"),
            token,
        };
        *guard = Some(state.clone());
        Ok(state)
    }

    pub fn respond(&self, id: String, response: serde_json::Value) -> Result<(), String> {
        let sender = self
            .inner
            .pending
            .lock()
            .map_err(|_| "host broker pending lock failed".to_string())?
            .remove(&id)
            .ok_or_else(|| "host rpc request is no longer pending".to_string())?;
        sender
            .send(Ok(response))
            .map_err(|err| format!("failed to send host rpc response: {err}"))
    }
}

#[tauri::command]
pub fn mcp_host_rpc_respond(
    broker: tauri::State<'_, HostBroker>,
    id: String,
    response: serde_json::Value,
) -> Result<(), String> {
    broker.respond(id, response)
}

fn request_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("mcp-host-{now:x}")
}

fn handle_stream(
    mut stream: TcpStream,
    token: &str,
    inner: Arc<HostBrokerInner>,
    app: tauri::AppHandle,
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

    if method != "POST" || path != "/host/rpc" || !authed {
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
    let request: RpcRequest = serde_json::from_slice(&body).map_err(|err| err.to_string())?;
    if !is_host_rpc_method_allowed(&request.method) {
        return write_json(
            &mut stream,
            403,
            serde_json::json!({ "error": format!("host rpc method not allowed: {}", request.method) }),
        );
    }
    let id = request_id();
    let (sender, receiver) = mpsc::channel();
    inner
        .pending
        .lock()
        .map_err(|_| "host broker pending lock failed".to_string())?
        .insert(id.clone(), sender);

    let event = RpcEvent {
        id: id.clone(),
        method: request.method,
        params: request.params.unwrap_or_else(|| serde_json::json!({})),
    };
    if let Err(err) = app.emit("polypore://mcp-host-rpc", event) {
        let _ = inner
            .pending
            .lock()
            .map_err(|_| "host broker pending lock failed".to_string())?
            .remove(&id);
        return write_json(
            &mut stream,
            500,
            serde_json::json!({ "error": format!("failed to emit host rpc: {err}") }),
        );
    }

    match receiver.recv_timeout(Duration::from_secs(30)) {
        Ok(Ok(value)) => write_json(&mut stream, 200, value),
        Ok(Err(err)) => write_json(&mut stream, 500, serde_json::json!({ "error": err })),
        Err(_) => {
            let _ = inner
                .pending
                .lock()
                .map_err(|_| "host broker pending lock failed".to_string())?
                .remove(&id);
            write_json(
                &mut stream,
                504,
                serde_json::json!({ "error": "host rpc timed out" }),
            )
        }
    }
}

fn is_host_rpc_method_allowed(method: &str) -> bool {
    matches!(
        method,
        "state.get"
            | "workspace.describe"
            | "editor.open"
            | "editor.read"
            | "editor.search"
            | "tasks.add"
            | "tasks.list"
            | "tasks.update"
            | "diagnostics.list"
            | "verify.run"
            | "verify.runs"
            | "knowledge.bases"
            | "knowledge.list"
            | "knowledge.read"
            | "knowledge.write"
            | "knowledge.link"
            | "knowledge.handoff"
            | "adr.record"
            | "phase.report"
            | "workflow.update"
            | "panel.open"
            | "panel.close"
            | "ui.notify"
            | "preview.register"
            | "preview.refresh"
            | "history.events"
            | "history.fork"
            | "plugins.list"
            | "plugins.enable"
            | "plugins.disable"
            | "plugins.confirmInstall"
            | "plugins.install"
            | "plugins.confirmUninstall"
            | "plugins.uninstall"
            | "skills.list"
            | "skills.read"
            | "skills.write"
            | "skills.invoke"
            | "skills.delete"
            | "skillsets.list"
            | "skillsets.read"
            | "skillsets.upsert"
            | "skillsets.delete"
            | "skills.publish"
            | "mcp.servers.list"
            | "mcp.servers.upsert"
            | "mcp.servers.delete"
            | "mcp.servers.test"
            | "formation.upsert"
            | "debug.probe"
            | "debug.start"
            | "debug.setBreakpoints"
            | "debug.addBreakpoint"
            | "debug.removeBreakpoint"
            | "debug.continue"
            | "debug.stepOver"
            | "debug.stepIn"
            | "debug.stepOut"
            | "debug.pause"
            | "debug.stackTrace"
            | "debug.scopes"
            | "debug.variables"
            | "debug.evaluate"
            | "debug.capture.screenshot"
            | "debug.capture.console"
            | "debug.capture.dom"
            | "debug.capture.network"
            | "debug.roadblock"
            | "debug.roadblock.resolve"
            | "debug.rootCause"
            | "debug.sessions"
            | "debug.select"
            | "debug.state"
            | "debug.stop"
            | "debug.capabilities"
            | "debug.navigate"
            | "debug.click"
            | "debug.fill"
            | "debug.login"
    )
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

#[cfg(test)]
mod tests {
    use super::is_host_rpc_method_allowed;

    #[test]
    fn host_broker_allows_documented_mcp_host_methods() {
        assert!(is_host_rpc_method_allowed("tasks.list"));
        assert!(is_host_rpc_method_allowed("plugins.confirmInstall"));
        assert!(is_host_rpc_method_allowed("debug.variables"));
        // editor read/navigation + agent-coherence state writes are reachable
        assert!(is_host_rpc_method_allowed("workspace.describe"));
        assert!(is_host_rpc_method_allowed("editor.read"));
        assert!(is_host_rpc_method_allowed("editor.search"));
        assert!(is_host_rpc_method_allowed("tasks.update"));
        assert!(is_host_rpc_method_allowed("knowledge.bases"));
        assert!(is_host_rpc_method_allowed("knowledge.list"));
        assert!(is_host_rpc_method_allowed("knowledge.handoff"));
        assert!(is_host_rpc_method_allowed("adr.record"));
        assert!(is_host_rpc_method_allowed("phase.report"));
        assert!(is_host_rpc_method_allowed("workflow.update"));
    }

    #[test]
    fn host_broker_blocks_privileged_host_methods() {
        assert!(!is_host_rpc_method_allowed("secrets.reveal"));
        assert!(!is_host_rpc_method_allowed("secrets.set"));
        assert!(!is_host_rpc_method_allowed("secrets.delete"));
        assert!(!is_host_rpc_method_allowed("terminal.spawn"));
        assert!(!is_host_rpc_method_allowed("editor.applyEdit"));
        assert!(!is_host_rpc_method_allowed("mcp.invoke"));
    }
}
