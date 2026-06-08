use serde::Serialize;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::host_broker::HostBroker;
use crate::secret_broker::SecretBroker;

#[derive(Default)]
pub struct McpSupervisor {
    child: Mutex<Option<Child>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    pub state: String,
    pub pid: Option<u32>,
    pub restarted: bool,
    pub message: String,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn project_root() -> Result<PathBuf, String> {
    let cwd =
        std::env::current_dir().map_err(|err| format!("cannot resolve current dir: {err}"))?;
    if cwd.file_name().and_then(|name| name.to_str()) == Some("src-tauri") {
        return cwd
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "cannot resolve project root".to_string());
    }
    Ok(cwd)
}

fn spawn_sidecar(
    secret_broker: &SecretBroker,
    host_broker: &HostBroker,
    app: tauri::AppHandle,
) -> Result<Child, String> {
    let root = project_root()?;
    let secret_broker = secret_broker.ensure_started()?;
    let host_broker = host_broker.ensure_started(app)?;
    Command::new("node")
        .arg("packages/mcp-server/src/server.mjs")
        .current_dir(root)
        .env("POLYPORE_STARTED_AT", now_ms().to_string())
        .env("POLYPORE_SECRET_BROKER_URL", secret_broker.url)
        .env("POLYPORE_SECRET_BROKER_TOKEN", secret_broker.token)
        .env("POLYPORE_HOST_RPC_URL", host_broker.url)
        .env("POLYPORE_HOST_RPC_TOKEN", host_broker.token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to start polypore-ide mcp server: {err}"))
}

#[tauri::command]
pub fn mcp_server_start(
    state: tauri::State<'_, McpSupervisor>,
    secret_broker: tauri::State<'_, SecretBroker>,
    host_broker: tauri::State<'_, HostBroker>,
    app: tauri::AppHandle,
) -> Result<McpStatus, String> {
    let mut child = state
        .child
        .lock()
        .map_err(|_| "mcp supervisor lock failed")?;
    if let Some(existing) = child.as_mut() {
        if existing
            .try_wait()
            .map_err(|err| err.to_string())?
            .is_none()
        {
            return Ok(McpStatus {
                state: "running".to_string(),
                pid: Some(existing.id()),
                restarted: false,
                message: "polypore-ide mcp server running".to_string(),
            });
        }
    }
    let next = spawn_sidecar(&secret_broker, &host_broker, app)?;
    let pid = next.id();
    *child = Some(next);
    Ok(McpStatus {
        state: "running".to_string(),
        pid: Some(pid),
        restarted: false,
        message: "polypore-ide mcp server started".to_string(),
    })
}

#[tauri::command]
pub fn mcp_server_status(
    state: tauri::State<'_, McpSupervisor>,
    secret_broker: tauri::State<'_, SecretBroker>,
    host_broker: tauri::State<'_, HostBroker>,
    app: tauri::AppHandle,
) -> Result<McpStatus, String> {
    let mut child = state
        .child
        .lock()
        .map_err(|_| "mcp supervisor lock failed")?;
    if let Some(existing) = child.as_mut() {
        if existing
            .try_wait()
            .map_err(|err| err.to_string())?
            .is_none()
        {
            return Ok(McpStatus {
                state: "running".to_string(),
                pid: Some(existing.id()),
                restarted: false,
                message: "polypore-ide mcp server running".to_string(),
            });
        }
        let next = spawn_sidecar(&secret_broker, &host_broker, app)?;
        let pid = next.id();
        *child = Some(next);
        return Ok(McpStatus {
            state: "running".to_string(),
            pid: Some(pid),
            restarted: true,
            message: "polypore-ide mcp server restarted after crash".to_string(),
        });
    }

    Ok(McpStatus {
        state: "stopped".to_string(),
        pid: None,
        restarted: false,
        message: "polypore-ide mcp server stopped".to_string(),
    })
}

#[tauri::command]
pub fn mcp_server_stop(state: tauri::State<'_, McpSupervisor>) -> Result<McpStatus, String> {
    let mut child = state
        .child
        .lock()
        .map_err(|_| "mcp supervisor lock failed")?;
    if let Some(mut existing) = child.take() {
        existing
            .kill()
            .map_err(|err| format!("failed to stop mcp server: {err}"))?;
        let _ = existing.wait();
    }
    Ok(McpStatus {
        state: "stopped".to_string(),
        pid: None,
        restarted: false,
        message: "polypore-ide mcp server stopped".to_string(),
    })
}
