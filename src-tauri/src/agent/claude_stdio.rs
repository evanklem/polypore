use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::Value;

use super::{
    claude_capabilities, command_available, interrupt_agent_child, register_agent_child,
    scrub_agent_env, wait_agent_child, AgentControlResult, AgentEvent, AgentEventSink,
    AgentRuntime, AgentRuntimeStatus, AgentSendResult,
};

pub struct ClaudeStdioRuntime;

impl AgentRuntime for ClaudeStdioRuntime {
    fn status(&self) -> AgentRuntimeStatus {
        AgentRuntimeStatus {
            agent: "claude".to_string(),
            adapter: "stdio".to_string(),
            available: command_available("claude"),
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
        let mut command = Command::new("claude");
        command
            .current_dir(cwd)
            .arg("-p")
            .arg("--verbose")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--permission-mode")
            .arg("default")
            .arg(text)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        scrub_agent_env(&mut command, cwd);
        let mut child = command
            .spawn()
            .map_err(|err| format!("failed to spawn claude: {err}"))?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to capture claude stdout".to_string())?;
        let mut stderr_pipe = child.stderr.take();
        let child_handle = register_agent_child("claude", session_id, child);
        let mut events = Vec::new();
        let mut read_error = None;
        for line in BufReader::new(stdout).lines() {
            let line = match line {
                Ok(line) => line,
                Err(err) => {
                    read_error = Some(format!("failed to read claude stdout: {err}"));
                    break;
                }
            };
            for event in parse_claude_line(&line) {
                event_sink(event.clone());
                events.push(event);
            }
        }

        let status = wait_agent_child("claude", session_id, &child_handle)?;
        if let Some(err) = read_error {
            return Err(err);
        }
        if status.success() {
            let stdout = collect_message_text(&events).unwrap_or_default();
            let response_text = if stdout.is_empty() {
                "claude returned no text.".to_string()
            } else {
                stdout
            };
            Ok(AgentSendResult {
                agent: "claude".to_string(),
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
        claude_capabilities()
    }

    fn interrupt(&self, session_id: &str) -> Result<AgentControlResult, String> {
        interrupt_agent_child("claude", "stdio", session_id)
    }
}

fn parse_claude_line(line: &str) -> Vec<AgentEvent> {
    if line.trim().is_empty() {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return vec![AgentEvent::Message {
            text: line.to_string(),
        }];
    };
    let event_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if event_type.contains("tool") {
        let tool_name = value
            .get("name")
            .or_else(|| value.pointer("/tool/name"))
            .or_else(|| value.pointer("/message/content/0/name"))
            .or_else(|| value.pointer("/message/content/0/tool_name"))
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let summary = value
            .get("summary")
            .or_else(|| value.pointer("/tool/input/command"))
            .or_else(|| value.pointer("/message/content/0/input/command"))
            .or_else(|| value.pointer("/message/content/0/input/description"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .unwrap_or_else(|| format!("{tool_name} called"));
        return vec![AgentEvent::ToolCall { summary, tool_name }];
    }
    if event_type.contains("permission") {
        return vec![AgentEvent::Permission {
            summary: "permission requested".to_string(),
        }];
    }
    extract_text(&value)
        .map(|text| vec![AgentEvent::Message { text }])
        .unwrap_or_default()
}

fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value
        .get("text")
        .or_else(|| value.get("content"))
        .or_else(|| value.get("delta"))
        .or_else(|| value.get("output_text"))
        .or_else(|| value.pointer("/message/content/0/text"))
        .or_else(|| value.pointer("/message/content/0/output_text"))
        .or_else(|| value.pointer("/delta/text"))
        .and_then(Value::as_str)
    {
        return Some(text.to_string());
    }

    for pointer in ["/message/content", "/content"] {
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
    fn claude_parser_extracts_nested_text_without_protocol_noise() {
        let sample = [
            r#"{"type":"system","subtype":"init"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Ready to work."}]}}"#,
            r#"{"type":"result","usage":{"input_tokens":10,"output_tokens":4}}"#,
        ];
        let events = sample
            .iter()
            .flat_map(|line| parse_claude_line(line))
            .collect::<Vec<_>>();

        assert_eq!(
            collect_message_text(&events).as_deref(),
            Some("Ready to work.")
        );
    }
}
