use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

pub mod acp;
pub mod claude_stdio;
pub mod codex_stdio;

#[derive(Clone, Debug, serde::Serialize)]
pub struct AgentRuntimeStatus {
    pub agent: String,
    pub adapter: String,
    pub available: bool,
    pub capabilities: AgentCapabilityMap,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSlashCatalog {
    pub agent: String,
    pub commands: Vec<AgentSlashEntry>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSlashEntry {
    pub command: String,
    pub title: String,
    pub detail: String,
    pub source: String,
    pub agent: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AgentCapabilityMap {
    pub streaming: bool,
    pub tool_use: bool,
    pub memory_dir: bool,
    pub slash_commands: bool,
    pub tool_servers: bool,
    pub compaction: bool,
    pub phase_reporting: bool,
    pub permission_flow: bool,
    pub subagent_spawn: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum AgentEvent {
    Message { text: String },
    ToolCall { tool_name: String, summary: String },
    Permission { summary: String },
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AgentSendResult {
    pub agent: String,
    pub adapter: String,
    pub session_id: String,
    pub response_text: String,
    pub events: Vec<AgentEvent>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct AgentControlResult {
    pub agent: String,
    pub adapter: String,
    pub session_id: String,
    pub interrupted: bool,
    pub message: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeEvent {
    pub agent: String,
    pub adapter: String,
    pub session_id: String,
    pub event: AgentEvent,
}

pub type AgentEventSink<'a> = dyn FnMut(AgentEvent) + 'a;

type AgentChildHandle = Arc<Mutex<Child>>;

static AGENT_CHILDREN: LazyLock<Mutex<HashMap<String, AgentChildHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn agent_child_key(agent: &str, session_id: &str) -> String {
    format!("{agent}:{session_id}")
}

pub(crate) fn register_agent_child(
    agent: &str,
    session_id: &str,
    child: Child,
) -> AgentChildHandle {
    let handle = Arc::new(Mutex::new(child));
    if let Ok(mut children) = AGENT_CHILDREN.lock() {
        children.insert(agent_child_key(agent, session_id), handle.clone());
    }
    handle
}

fn unregister_agent_child(agent: &str, session_id: &str, handle: &AgentChildHandle) {
    if let Ok(mut children) = AGENT_CHILDREN.lock() {
        let key = agent_child_key(agent, session_id);
        if children
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, handle))
        {
            children.remove(&key);
        }
    }
}

pub(crate) fn wait_agent_child(
    agent: &str,
    session_id: &str,
    handle: &AgentChildHandle,
) -> Result<ExitStatus, String> {
    loop {
        let status = {
            let mut child = handle
                .lock()
                .map_err(|_| format!("{agent} child lock failed"))?;
            child
                .try_wait()
                .map_err(|err| format!("failed to wait for {agent}: {err}"))?
        };
        if let Some(status) = status {
            unregister_agent_child(agent, session_id, handle);
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn interrupt_agent_child(
    agent: &str,
    adapter: &str,
    session_id: &str,
) -> Result<AgentControlResult, String> {
    let key = agent_child_key(agent, session_id);
    let handle = AGENT_CHILDREN
        .lock()
        .map_err(|_| "agent child registry lock failed".to_string())?
        .get(&key)
        .cloned();
    let Some(handle) = handle else {
        return Ok(AgentControlResult {
            agent: agent.to_string(),
            adapter: adapter.to_string(),
            session_id: session_id.to_string(),
            interrupted: false,
            message: format!("no running {agent} session found"),
        });
    };
    let mut child = handle
        .lock()
        .map_err(|_| format!("{agent} child lock failed"))?;
    if child
        .try_wait()
        .map_err(|err| format!("failed to inspect {agent}: {err}"))?
        .is_some()
    {
        drop(child);
        unregister_agent_child(agent, session_id, &handle);
        return Ok(AgentControlResult {
            agent: agent.to_string(),
            adapter: adapter.to_string(),
            session_id: session_id.to_string(),
            interrupted: false,
            message: format!("{agent} session already exited"),
        });
    }
    child
        .kill()
        .map_err(|err| format!("failed to interrupt {agent}: {err}"))?;
    child
        .wait()
        .map_err(|err| format!("failed to wait after interrupting {agent}: {err}"))?;
    drop(child);
    unregister_agent_child(agent, session_id, &handle);
    Ok(AgentControlResult {
        agent: agent.to_string(),
        adapter: adapter.to_string(),
        session_id: session_id.to_string(),
        interrupted: true,
        message: format!("{agent} stdio session interrupted"),
    })
}

pub trait AgentRuntime {
    fn status(&self) -> AgentRuntimeStatus;
    fn send_user_message(
        &self,
        session_id: &str,
        cwd: &Path,
        text: &str,
        event_sink: &mut AgentEventSink<'_>,
    ) -> Result<AgentSendResult, String>;
    fn interrupt(&self, session_id: &str) -> Result<AgentControlResult, String>;
    fn capabilities(&self) -> AgentCapabilityMap;
}

pub fn probe_acp(command: &str) -> bool {
    let mut child = match Command::new(command)
        .arg("--acp")
        .arg("--help")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= Duration::from_secs(2) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return false,
        }
    }
}

pub fn command_available(command: &str) -> bool {
    Command::new(command)
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Scrub recognized secret keys from the agent subprocess env so claude/codex
/// cannot read raw values via `printenv` or inherited env. Replaces each with
/// a `POLYPORE_SECRET_HANDLE_<KEY>=<handle>` sentinel pointing back at the
/// polypore secret store. Keys are discovered from .env files in the cwd —
/// any key listed there is presumed sensitive.
///
/// Call before `.spawn()` on a `Command`.
pub fn scrub_agent_env(cmd: &mut Command, cwd: &Path) {
    let candidates = [".env", ".env.local", ".env.development"];
    let mut secret_keys: Vec<String> = Vec::new();
    for file in candidates {
        let path = cwd.join(file);
        let body = match fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        for raw_line in body.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let stripped = if let Some(rest) = line.strip_prefix("export ") {
                rest.trim()
            } else {
                line
            };
            if let Some(eq) = stripped.find('=') {
                let key = stripped[..eq].trim().to_string();
                if !key.is_empty() && !secret_keys.contains(&key) {
                    secret_keys.push(key);
                }
            }
        }
    }
    for key in &secret_keys {
        cmd.env_remove(key);
        /* sentinel signals the polypore handle the agent should call
        polypore.secrets.use against — never the raw value. */
        let handle = key.to_ascii_lowercase().replace('_', "-");
        cmd.env(format!("POLYPORE_SECRET_HANDLE_{}", key), handle);
    }
    /* breadcrumb env var so agent skills (polyflow CLAUDE.md, etc.) can
    detect they're running under polypore and prefer the mediated path. */
    cmd.env("POLYPORE_AGENT_SCRUBBED", "1");
}

#[tauri::command]
pub fn agent_probe(agent: String) -> Result<AgentRuntimeStatus, String> {
    Ok(runtime_for(&agent)?.status())
}

#[tauri::command]
pub fn agent_slash_catalog(agent: String) -> Result<AgentSlashCatalog, String> {
    Ok(AgentSlashCatalog {
        commands: slash_catalog_for(&agent),
        agent,
    })
}

#[tauri::command]
pub async fn agent_send(
    agent: String,
    session_id: Option<String>,
    worktree_id: Option<String>,
    text: String,
    app: tauri::AppHandle,
) -> Result<AgentSendResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = session_id.unwrap_or_else(|| "default".to_string());
        let cwd = resolve_worktree_root(worktree_id)?;
        let runtime = runtime_for(&agent)?;
        let status = runtime.status();
        let mut event_sink = |event: AgentEvent| {
            let _ = app.emit(
                "polypore://agent-event",
                AgentRuntimeEvent {
                    agent: status.agent.clone(),
                    adapter: status.adapter.clone(),
                    session_id: session_id.clone(),
                    event,
                },
            );
        };
        runtime.send_user_message(&session_id, &cwd, &text, &mut event_sink)
    })
    .await
    .map_err(|err| format!("agent worker failed: {err}"))?
}

fn resolve_worktree_root(worktree_id: Option<String>) -> Result<PathBuf, String> {
    let Some(id) = worktree_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return crate::project_context::active_project_root();
    };
    if id == "main" {
        return crate::project_context::active_project_root();
    }
    crate::project::worktrees_list()?
        .into_iter()
        .find(|worktree| worktree.id == id)
        .map(|worktree| PathBuf::from(worktree.path))
        .ok_or_else(|| format!("worktree '{id}' is not registered"))
}

#[tauri::command]
pub fn agent_interrupt(
    agent: String,
    session_id: Option<String>,
) -> Result<AgentControlResult, String> {
    runtime_for(&agent)?.interrupt(session_id.as_deref().unwrap_or("default"))
}

fn runtime_for(agent: &str) -> Result<Box<dyn AgentRuntime>, String> {
    let command = agent;

    /* ACP is opt-in. The acp adapter is not yet protocol-complete (it echoes
    canned text), so without this gate a real `--acp`-capable CLI would
    silently downgrade chat from the working stdio adapter to the stub.
    Set POLYPORE_ENABLE_ACP=1 once acp::AcpRuntime implements the wire
    protocol per §16 M5 step 3. */
    let acp_enabled = std::env::var("POLYPORE_ENABLE_ACP")
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    if acp_enabled
        && is_safe_agent_command(command)
        && command_available(command)
        && probe_acp(command)
    {
        return Ok(Box::new(acp::AcpRuntime {
            agent: agent.to_string(),
        }));
    }

    match agent {
        "claude" => Ok(Box::new(claude_stdio::ClaudeStdioRuntime)),
        "codex" => Ok(Box::new(codex_stdio::CodexStdioRuntime)),
        other => Err(format!("unsupported agent runtime: {other}")),
    }
}

fn is_safe_agent_command(agent: &str) -> bool {
    !agent.is_empty()
        && agent
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && agent
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
}

fn slash_catalog_for(agent: &str) -> Vec<AgentSlashEntry> {
    let mut entries = Vec::new();
    entries.extend(static_agent_commands(agent));
    entries.extend(discovered_skill_entries(agent));

    let mut seen = BTreeMap::<String, AgentSlashEntry>::new();
    for entry in entries {
        seen.entry(entry.command.to_lowercase()).or_insert(entry);
    }
    seen.into_values().take(160).collect()
}

fn static_agent_commands(agent: &str) -> Vec<AgentSlashEntry> {
    let rows: &[(&str, &str, &str)] = match agent {
        "claude" => &[
            ("/goal ", "goal", "set or inspect the active Claude goal"),
            ("/resume", "resume", "resume a Claude Code conversation"),
            (
                "/continue",
                "continue",
                "continue the most recent conversation",
            ),
            ("/agents", "agents", "manage Claude background agents"),
            ("/agent ", "agent", "switch the active Claude agent"),
            ("/model ", "model", "switch Claude model"),
            ("/permissions", "permissions", "review permission mode"),
            ("/memory", "memory", "work with Claude memory"),
            ("/mcp", "mcp", "configure Claude MCP servers"),
            ("/plugins", "plugins", "manage Claude plugins"),
            ("/doctor", "doctor", "check Claude Code health"),
            ("/compact", "compact", "compact the current context"),
        ],
        _ => &[
            ("/goal ", "goal", "set or inspect the active Codex goal"),
            ("/resume", "resume", "resume a previous Codex session"),
            ("/fork", "fork", "fork a previous Codex session"),
            ("/review", "review", "run a Codex code review pass"),
            ("/model ", "model", "switch model for the next turn"),
            ("/approvals ", "approvals", "change approval behavior"),
            ("/sandbox ", "sandbox", "change sandbox policy"),
            ("/mcp", "mcp", "manage Codex MCP servers"),
            ("/plugin", "plugin", "manage Codex plugins"),
            ("/cloud", "cloud", "browse Codex Cloud tasks"),
            ("/apply", "apply", "apply the latest Codex diff"),
            ("/login", "login", "manage Codex login"),
            ("/logout", "logout", "remove Codex credentials"),
        ],
    };
    rows.iter()
        .map(|(command, title, detail)| AgentSlashEntry {
            command: (*command).to_string(),
            title: (*title).to_string(),
            detail: (*detail).to_string(),
            source: "agent".to_string(),
            agent: agent.to_string(),
        })
        .collect()
}

fn discovered_skill_entries(agent: &str) -> Vec<AgentSlashEntry> {
    let mut roots = Vec::new();
    if let Ok(root) = crate::project_context::active_project_root() {
        roots.push(root.join(".polypore").join("skills"));
        roots.push(root.join("skills"));
        roots.push(root.join(format!(".{agent}")).join("skills"));
    }
    if let Some(home) = home_dir() {
        if agent == "claude" {
            roots.push(home.join(".claude").join("skills"));
            roots.push(home.join(".claude").join("plugins").join("marketplaces"));
        } else {
            roots.push(home.join(".codex").join("skills"));
        }
    }

    let mut entries = Vec::new();
    for root in roots {
        collect_skill_dirs(agent, &root, 4, &mut entries);
        if entries.len() >= 120 {
            break;
        }
    }
    entries
}

fn collect_skill_dirs(agent: &str, dir: &Path, depth: usize, entries: &mut Vec<AgentSlashEntry>) {
    if entries.len() >= 120 || depth == 0 || !dir.is_dir() {
        return;
    }
    if dir.join("SKILL.md").is_file() {
        if let Some(entry) = skill_entry_from_dir(agent, dir) {
            entries.push(entry);
        }
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        if entries.len() >= 120 {
            return;
        }
        let path = item.path();
        if path.is_dir() {
            collect_skill_dirs(agent, &path, depth - 1, entries);
        } else if path.extension().is_some_and(|e| e == "md") {
            if let Some(entry) = skill_entry_from_flat_md(agent, &path) {
                entries.push(entry);
            }
        }
    }
}

fn skill_entry_from_flat_md(agent: &str, path: &Path) -> Option<AgentSlashEntry> {
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let detail = fs::read_to_string(path)
        .ok()
        .and_then(|body| summarize_skill(&body))
        .unwrap_or_else(|| format!("{agent} skill"));
    Some(AgentSlashEntry {
        command: format!("/{stem}"),
        title: stem,
        detail,
        source: "skill".to_string(),
        agent: agent.to_string(),
    })
}

fn skill_entry_from_dir(agent: &str, dir: &Path) -> Option<AgentSlashEntry> {
    let id = dir.file_name()?.to_string_lossy().to_string();
    let detail = fs::read_to_string(dir.join("SKILL.md"))
        .ok()
        .and_then(|body| summarize_skill(&body))
        .unwrap_or_else(|| format!("{agent} skill"));
    Some(AgentSlashEntry {
        command: format!("/{id}"),
        title: id,
        detail,
        source: "skill".to_string(),
        agent: agent.to_string(),
    })
}

fn summarize_skill(body: &str) -> Option<String> {
    let mut lines = body.lines().peekable();
    /* skip YAML frontmatter block (--- ... ---) if present */
    if lines.peek().is_some_and(|l| l.trim() == "---") {
        lines.next();
        for line in &mut lines {
            if line.trim() == "---" {
                break;
            }
        }
    }
    for line in lines {
        let trimmed = line.trim().trim_start_matches('#').trim();
        if trimmed.is_empty() {
            continue;
        }
        return Some(trimmed.chars().take(96).collect());
    }
    None
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn claude_capabilities() -> AgentCapabilityMap {
    AgentCapabilityMap {
        streaming: true,
        tool_use: true,
        memory_dir: true,
        slash_commands: true,
        tool_servers: true,
        compaction: true,
        phase_reporting: true,
        permission_flow: true,
        subagent_spawn: true,
    }
}

pub fn codex_capabilities() -> AgentCapabilityMap {
    AgentCapabilityMap {
        streaming: true,
        tool_use: true,
        memory_dir: false,
        slash_commands: true,
        tool_servers: true,
        compaction: true,
        phase_reporting: false,
        permission_flow: true,
        subagent_spawn: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_agent_command_rejects_paths_and_option_like_names() {
        for agent in [
            "",
            "-agent",
            "../agent",
            "agent/name",
            "agent name",
            "agent;touch",
        ] {
            assert!(
                !is_safe_agent_command(agent),
                "{agent:?} should be rejected"
            );
        }
        assert!(is_safe_agent_command("codex"));
        assert!(is_safe_agent_command("custom_agent-1.0"));
    }

    #[test]
    fn runtime_for_rejects_unknown_agents_without_acp_opt_in() {
        let previous = std::env::var("POLYPORE_ENABLE_ACP").ok();
        std::env::remove_var("POLYPORE_ENABLE_ACP");

        assert!(runtime_for("codex").is_ok());
        assert!(runtime_for("claude").is_ok());
        assert!(runtime_for("sh").is_err());

        match previous {
            Some(value) => std::env::set_var("POLYPORE_ENABLE_ACP", value),
            None => std::env::remove_var("POLYPORE_ENABLE_ACP"),
        }
    }

    #[test]
    fn slash_catalog_contains_agent_native_goal_commands() {
        let codex = slash_catalog_for("codex");
        let claude = slash_catalog_for("claude");

        assert!(codex
            .iter()
            .any(|entry| entry.command == "/goal " && entry.source == "agent"));
        assert!(claude
            .iter()
            .any(|entry| entry.command == "/goal " && entry.source == "agent"));
        assert!(claude.iter().any(|entry| entry.command == "/agents"));
    }

    #[test]
    fn registered_agent_child_can_be_interrupted() {
        #[cfg(unix)]
        let child = Command::new("sh")
            .arg("-c")
            .arg("sleep 5")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep child");

        #[cfg(windows)]
        let child = Command::new("cmd")
            .arg("/C")
            .arg("ping -n 6 127.0.0.1 > NUL")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep child");

        let session_id = "test-interrupt";
        let handle = register_agent_child("codex", session_id, child);
        let result = interrupt_agent_child("codex", "stdio", session_id).expect("interrupt child");

        assert!(result.interrupted);
        assert!(wait_agent_child("codex", session_id, &handle)
            .expect("wait child")
            .code()
            .is_none());
        assert!(
            !interrupt_agent_child("codex", "stdio", session_id)
                .expect("interrupt missing child")
                .interrupted
        );
    }
}
