use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use super::{
    codex_capabilities, command_available, interrupt_agent_child, register_agent_child,
    scrub_agent_env, wait_agent_child, AgentControlResult, AgentEvent, AgentEventSink,
    AgentRuntime, AgentRuntimeStatus, AgentSendResult,
};

pub struct CodexStdioRuntime;

impl AgentRuntime for CodexStdioRuntime {
    fn status(&self) -> AgentRuntimeStatus {
        AgentRuntimeStatus {
            agent: "codex".to_string(),
            adapter: "stdio".to_string(),
            available: command_available("codex"),
            capabilities: self.capabilities(),
        }
    }

    fn send_user_message(
        &self,
        session_id: &str,
        cwd: &Path,
        text: &str,
        event_sink: &mut AgentEventSink<'_>,
    ) -> Result<AgentSendResult, String> {
        let mut command = Command::new("codex");
        command
            .arg("--ask-for-approval")
            .arg("on-request")
            .arg("exec")
            .arg("--cd")
            .arg(cwd)
            .arg("--json")
            .arg(text)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        scrub_agent_env(&mut command, cwd);
        let mut child = command
            .spawn()
            .map_err(|err| format!("failed to spawn codex: {err}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture codex stdout".to_string())?;
        let mut stderr_pipe = child.stderr.take();
        let child_handle = register_agent_child("codex", session_id, child);
        let mut events = Vec::new();
        let mut read_error = None;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    read_error = Some(format!("failed to read codex stdout: {err}"));
                    break;
                }
            };
            for event in parse_codex_line(&line) {
                event_sink(event.clone());
                events.push(event);
            }
        }

        let status = wait_agent_child("codex", session_id, &child_handle)?;
        if let Some(err) = read_error {
            return Err(err);
        }
        if status.success() {
            let response_text = collect_message_text(&events)
                .unwrap_or_else(|| "codex returned no text.".to_string());
            Ok(AgentSendResult {
                agent: "codex".to_string(),
                adapter: "stdio".to_string(),
                session_id: session_id.to_string(),
                response_text,
                events,
            })
        } else {
            let mut stderr = String::new();
            if let Some(mut pipe) = stderr_pipe.take() {
                let _ = pipe.read_to_string(&mut stderr);
            }
            Err(stderr)
        }
    }

    fn capabilities(&self) -> super::AgentCapabilityMap {
        codex_capabilities()
    }

    fn interrupt(&self, session_id: &str) -> Result<AgentControlResult, String> {
        interrupt_agent_child("codex", "stdio", session_id)
    }
}

fn parse_codex_line(line: &str) -> Vec<AgentEvent> {
    if line.trim().is_empty() {
        return Vec::new();
    }
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        let event_type = value
            .get("type")
            .or_else(|| value.get("event"))
            .or_else(|| value.get("kind"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if event_type.contains("tool")
            || event_type.contains("exec")
            || event_type.contains("command")
            || event_type.contains("function")
        {
            let tool_name = value
                .get("tool")
                .or_else(|| value.get("name"))
                .or_else(|| value.pointer("/item/tool"))
                .or_else(|| value.pointer("/item/name"))
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let summary = value
                .get("summary")
                .or_else(|| value.get("command"))
                .or_else(|| value.get("message"))
                .or_else(|| value.pointer("/item/summary"))
                .or_else(|| value.pointer("/item/command"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{tool_name} called"));
            return vec![AgentEvent::ToolCall { summary, tool_name }];
        }
        if event_type.contains("approval") || event_type.contains("permission") {
            let summary = value
                .get("message")
                .or_else(|| value.get("summary"))
                .or_else(|| value.pointer("/item/summary"))
                .and_then(Value::as_str)
                .unwrap_or("permission requested")
                .to_string();
            return vec![AgentEvent::Permission { summary }];
        }
        if let Some(text) = extract_text(&value) {
            return vec![AgentEvent::Message { text }];
        }
        return Vec::new();
    }
    vec![AgentEvent::Message {
        text: line.to_string(),
    }]
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value
        .get("text")
        .or_else(|| value.get("message"))
        .or_else(|| value.get("content"))
        .or_else(|| value.get("delta"))
        .or_else(|| value.get("output_text"))
        .or_else(|| value.pointer("/item/text"))
        .or_else(|| value.pointer("/item/content"))
        .or_else(|| value.pointer("/item/output_text"))
        .or_else(|| value.pointer("/message/content"))
        .and_then(Value::as_str)
    {
        return Some(text.to_string());
    }

    for pointer in ["/message/content", "/item/content", "/content"] {
        let Some(Value::Array(items)) = value.pointer(pointer) else {
            continue;
        };
        let text = items
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("output_text"))
                    .or_else(|| item.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join("");
        if !text.trim().is_empty() {
            return Some(text);
        }
    }

    for pointer in ["/message", "/item", "/result", "/delta"] {
        if let Some(text) = value.pointer(pointer).and_then(extract_text) {
            return Some(text);
        }
    }

    None
}

fn collect_message_text(events: &[AgentEvent]) -> Option<String> {
    let text = events
        .iter()
        .filter_map(|event| match event {
            AgentEvent::Message { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_parser_ignores_lifecycle_json_and_extracts_nested_text() {
        let sample = [
            r#"{"type":"thread.started","thread_id":"019e414d-8510-7633-80ac-4938f7359482"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I don't have an active task to resume."}]}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":13723,"cached_input_tokens":5504,"output_tokens":80}}"#,
        ];
        let events = sample
            .iter()
            .flat_map(|line| parse_codex_line(line))
            .collect::<Vec<_>>();

        assert_eq!(
            collect_message_text(&events).as_deref(),
            Some("I don't have an active task to resume.")
        );
    }
}
