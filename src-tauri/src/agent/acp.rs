use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{
    claude_capabilities, codex_capabilities, command_available, AgentCapabilityMap,
    AgentControlResult, AgentEvent, AgentEventSink, AgentRuntime, AgentRuntimeStatus,
    AgentSendResult,
};

pub struct AcpRuntime {
    pub agent: String,
}

static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

impl AcpRuntime {
    fn capabilities_for(&self) -> AgentCapabilityMap {
        if self.agent == "claude" {
            claude_capabilities()
        } else {
            codex_capabilities()
        }
    }
}

impl AgentRuntime for AcpRuntime {
    fn status(&self) -> AgentRuntimeStatus {
        AgentRuntimeStatus {
            agent: self.agent.clone(),
            adapter: "acp".to_string(),
            available: command_available(&self.agent),
            capabilities: self.capabilities_for(),
        }
    }

    fn capabilities(&self) -> AgentCapabilityMap {
        self.capabilities_for()
    }

    fn send_user_message(
        &self,
        session_id: &str,
        cwd: &Path,
        text: &str,
        event_sink: &mut AgentEventSink<'_>,
    ) -> Result<AgentSendResult, String> {
        let mut child = Command::new(&self.agent)
            .current_dir(cwd)
            .arg("--acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|err| format!("failed to spawn {} --acp: {err}", self.agent))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to capture acp stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture acp stdout".to_string())?;

        send_request(
            &mut stdin,
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientInfo": { "name": "polypore", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "session": true, "streaming": true }
            }),
        )?;

        send_request(
            &mut stdin,
            "session/prompt",
            json!({
                "sessionId": session_id,
                "message": { "role": "user", "content": text }
            }),
        )?;

        let mut reader = BufReader::new(stdout);
        let mut events: Vec<AgentEvent> = Vec::new();
        let mut response_text = String::new();
        let started = Instant::now();
        let deadline = Duration::from_secs(120);

        loop {
            if started.elapsed() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("acp prompt timed out after 120s".to_string());
            }
            let frame = match read_frame(&mut reader)? {
                Some(frame) => frame,
                None => break,
            };
            if let Some(event) = translate_frame(&frame, &mut response_text) {
                event_sink(event.clone());
                events.push(event);
            }
            if frame_marks_completion(&frame) {
                break;
            }
        }

        let _ = child.kill();
        let _ = child.wait();

        if response_text.is_empty() {
            response_text = format!("{} acp returned no text.", self.agent);
        }

        Ok(AgentSendResult {
            agent: self.agent.clone(),
            adapter: "acp".to_string(),
            session_id: session_id.to_string(),
            response_text,
            events,
        })
    }

    fn interrupt(&self, session_id: &str) -> Result<AgentControlResult, String> {
        let mut child = match Command::new(&self.agent)
            .arg("--acp")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) => {
                return Ok(AgentControlResult {
                    agent: self.agent.clone(),
                    adapter: "acp".to_string(),
                    session_id: session_id.to_string(),
                    interrupted: false,
                    message: format!("acp interrupt failed to start agent: {err}"),
                });
            }
        };

        let result = if let Some(mut stdin) = child.stdin.take() {
            send_notification(
                &mut stdin,
                "session/cancel",
                json!({ "sessionId": session_id }),
            )
        } else {
            Err("failed to capture stdin for cancel".to_string())
        };

        wait_briefly(&mut child);
        let _ = child.kill();
        let _ = child.wait();

        Ok(AgentControlResult {
            agent: self.agent.clone(),
            adapter: "acp".to_string(),
            session_id: session_id.to_string(),
            interrupted: result.is_ok(),
            message: match result {
                Ok(()) => "acp cancel sent".to_string(),
                Err(err) => format!("acp cancel failed: {err}"),
            },
        })
    }
}

fn send_request(stdin: &mut ChildStdin, method: &str, params: Value) -> Result<(), String> {
    let id = REQUEST_ID.fetch_add(1, Ordering::SeqCst);
    write_frame(
        stdin,
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
}

fn send_notification(stdin: &mut ChildStdin, method: &str, params: Value) -> Result<(), String> {
    write_frame(
        stdin,
        json!({ "jsonrpc": "2.0", "method": method, "params": params }),
    )
}

fn write_frame(stdin: &mut ChildStdin, body: Value) -> Result<(), String> {
    let serialized =
        serde_json::to_vec(&body).map_err(|err| format!("acp serialize failed: {err}"))?;
    write!(stdin, "Content-Length: {}\r\n\r\n", serialized.len())
        .map_err(|err| format!("acp write header failed: {err}"))?;
    stdin
        .write_all(&serialized)
        .map_err(|err| format!("acp write body failed: {err}"))?;
    stdin
        .flush()
        .map_err(|err| format!("acp flush failed: {err}"))
}

fn read_frame<R: BufRead>(reader: &mut R) -> Result<Option<Value>, String> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|err| format!("acp read header failed: {err}"))?;
        if bytes == 0 {
            return Ok(None);
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let len = content_length.ok_or_else(|| "acp frame missing Content-Length".to_string())?;
    let mut body = vec![0u8; len];
    reader
        .read_exact(&mut body)
        .map_err(|err| format!("acp read body failed: {err}"))?;
    let value: Value =
        serde_json::from_slice(&body).map_err(|err| format!("acp parse body failed: {err}"))?;
    Ok(Some(value))
}

fn translate_frame(frame: &Value, response_text: &mut String) -> Option<AgentEvent> {
    /* either a JSON-RPC response (id present) or a notification (method present). */
    if let Some(method) = frame.get("method").and_then(|m| m.as_str()) {
        let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
        match method {
            "session/update" | "session/message" => {
                let kind = params
                    .get("kind")
                    .or_else(|| params.get("type"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("message");
                match kind {
                    "tool_call" | "tool_use" => Some(AgentEvent::ToolCall {
                        tool_name: params
                            .get("toolName")
                            .or_else(|| params.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string(),
                        summary: params
                            .get("summary")
                            .or_else(|| params.get("description"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    }),
                    "permission_request" => Some(AgentEvent::Permission {
                        summary: params
                            .get("summary")
                            .or_else(|| params.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("permission requested")
                            .to_string(),
                    }),
                    _ => {
                        let text = params
                            .get("text")
                            .or_else(|| params.get("content"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if !text.is_empty() {
                            if !response_text.is_empty() {
                                response_text.push('\n');
                            }
                            response_text.push_str(text);
                            Some(AgentEvent::Message {
                                text: text.to_string(),
                            })
                        } else {
                            None
                        }
                    }
                }
            }
            _ => None,
        }
    } else if let Some(result) = frame.get("result") {
        if let Some(text) = result.get("text").and_then(|v| v.as_str()) {
            if !response_text.is_empty() {
                response_text.push('\n');
            }
            response_text.push_str(text);
            Some(AgentEvent::Message {
                text: text.to_string(),
            })
        } else {
            None
        }
    } else {
        None
    }
}

fn frame_marks_completion(frame: &Value) -> bool {
    /* a final response carries result + matches our prompt id; we accept any
    response-shaped frame that isn't a session/update notification, or a
    notification explicitly marked "completed". */
    if let Some(method) = frame.get("method").and_then(|m| m.as_str()) {
        let params = frame.get("params").cloned().unwrap_or_else(|| json!({}));
        let kind = params
            .get("kind")
            .or_else(|| params.get("type"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        method == "session/complete" || kind == "stop" || kind == "completed"
    } else {
        frame.get("result").is_some() || frame.get("error").is_some()
    }
}

fn wait_briefly(child: &mut Child) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_millis(500) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.stderr.take().map(|mut s| {
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf);
    });
}
