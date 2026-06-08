use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::project_context;

const VERIFY_OUTPUT_CHAR_CAP: usize = 12_000;

#[derive(Clone, Debug, serde::Serialize)]
pub struct PersistenceStatus {
    pub database: String,
    pub status: String,
    pub projects: i64,
    pub chat_sessions: i64,
    pub history_events: i64,
    pub verify_runs: i64,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct ChatMessageInput {
    pub session_id: String,
    pub project_path: Option<String>,
    pub agent: String,
    pub title: Option<String>,
    pub role: String,
    pub body: String,
    pub tool_call_id: Option<i64>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct VerifyRunInput {
    pub id: String,
    pub project_path: Option<String>,
    pub label: String,
    pub command: String,
    pub exit_code: Option<i64>,
    pub required: bool,
    pub output: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct FileSnapshotInput {
    pub task_id: String,
    pub path: String,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWriteInput {
    pub id: Option<String>,
    pub label: String,
    pub done: Option<bool>,
    pub parent_id: Option<String>,
    pub panel_hint: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpdateInput {
    pub id: String,
    pub label: Option<String>,
    pub done: Option<bool>,
    pub parent_id: Option<String>,
    pub panel_hint: Option<String>,
    pub created_by: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub label: String,
    pub done: bool,
    pub parent_id: Option<String>,
    pub panel_hint: Option<String>,
    pub created_at: i64,
    pub created_by: String,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyRunRecord {
    pub id: String,
    pub label: String,
    pub command: String,
    pub cwd: Option<String>,
    pub required: bool,
    pub status: String,
    pub exit_code: Option<i64>,
    pub ran_at: Option<i64>,
    pub output: String,
    pub duration_ms: Option<i64>,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct VerifyDeclareCommand {
    id: String,
    label: Option<String>,
    command: String,
    required: Option<bool>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct PersistedRow {
    pub stored: bool,
    pub id: String,
}

#[tauri::command]
pub fn persistence_status() -> Result<PersistenceStatus, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    Ok(PersistenceStatus {
        database: db_path()?.display().to_string(),
        status: "ready".to_string(),
        projects: count(&conn, "projects")?,
        chat_sessions: count(&conn, "chat_sessions")?,
        history_events: count(&conn, "history_events")?,
        verify_runs: count(&conn, "verify_runs")?,
    })
}

#[tauri::command]
pub fn persistence_record_chat_message(input: ChatMessageInput) -> Result<PersistedRow, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_path = input.project_path.unwrap_or(current_project_path()?);
    let project_id = upsert_project(&conn, &project_path)?;
    conn.execute(
        "INSERT OR IGNORE INTO chat_sessions(id, project_id, agent, title, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            input.session_id,
            project_id,
            input.agent,
            input.title.unwrap_or_default(),
            now_ms()
        ],
    )
    .map_err(|err| format!("failed to persist chat session: {err}"))?;
    conn.execute(
        "INSERT INTO chat_messages(session_id, ts, role, body, tool_call_id)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            input.session_id,
            now_ms(),
            input.role,
            input.body,
            input.tool_call_id
        ],
    )
    .map_err(|err| format!("failed to persist chat message: {err}"))?;
    Ok(PersistedRow {
        stored: true,
        id: conn.last_insert_rowid().to_string(),
    })
}

#[tauri::command]
pub fn persistence_record_verify_run(input: VerifyRunInput) -> Result<PersistedRow, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_path = input.project_path.unwrap_or(current_project_path()?);
    let project_id = upsert_project(&conn, &project_path)?;
    conn.execute(
        "INSERT INTO verify_runs(id, project_id, label, command, exit_code, ran_at, required, output)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           label=excluded.label,
           command=excluded.command,
           exit_code=excluded.exit_code,
           ran_at=excluded.ran_at,
           required=excluded.required,
           output=excluded.output",
        params![
            input.id,
            project_id,
            input.label,
            input.command,
            input.exit_code,
            now_ms(),
            if input.required { 1 } else { 0 },
            input.output
        ],
    )
    .map_err(|err| format!("failed to persist verify run: {err}"))?;
    Ok(PersistedRow {
        stored: true,
        id: input.id,
    })
}

#[tauri::command]
pub fn verify_runs_list() -> Result<Vec<VerifyRunRecord>, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_path = current_project_path()?;
    let project_id = upsert_project(&conn, &project_path)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, command, exit_code, ran_at, required, output
             FROM verify_runs WHERE project_id = ?1 ORDER BY ran_at DESC",
        )
        .map_err(|err| format!("failed to prepare verify runs list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            let exit_code: Option<i64> = row.get(3)?;
            Ok(VerifyRunRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                command: row.get(2)?,
                cwd: Some(project_path.clone()),
                required: row.get::<_, i64>(5)? != 0,
                status: match exit_code {
                    Some(0) => "ok".to_string(),
                    Some(_) => "fail".to_string(),
                    None => "pending".to_string(),
                },
                exit_code,
                ran_at: row.get(4)?,
                output: row.get(6)?,
                duration_ms: None,
            })
        })
        .map_err(|err| format!("failed to read verify runs: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("failed to decode verify run: {err}"))?);
    }
    for declared in declared_verify_commands(&project_path)? {
        if out.iter().any(|run| run.id == declared.id) {
            continue;
        }
        out.push(VerifyRunRecord {
            id: declared.id.clone(),
            label: declared.label.unwrap_or_else(|| declared.id.clone()),
            command: declared.command,
            cwd: Some(project_path.clone()),
            required: declared.required.unwrap_or(true),
            status: "pending".to_string(),
            exit_code: None,
            ran_at: None,
            output: String::new(),
            duration_ms: None,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn verify_run_command(id: String) -> Result<VerifyRunRecord, String> {
    tauri::async_runtime::spawn_blocking(move || verify_run_command_blocking(id))
        .await
        .map_err(|err| format!("verify command task failed: {err}"))?
}

fn verify_run_command_blocking(id: String) -> Result<VerifyRunRecord, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_path = current_project_path()?;
    let project_id = upsert_project(&conn, &project_path)?;
    let (label, command, required): (String, String, i64) = match conn.query_row(
        "SELECT label, command, required FROM verify_runs WHERE id = ?1 AND project_id = ?2",
        params![&id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ) {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            let declared = declared_verify_commands(&project_path)?
                .into_iter()
                .find(|command| command.id == id)
                .ok_or_else(|| format!("verify command not found: {id}"))?;
            (
                declared.label.unwrap_or_else(|| declared.id.clone()),
                declared.command,
                if declared.required.unwrap_or(true) {
                    1
                } else {
                    0
                },
            )
        }
        Err(err) => return Err(format!("verify command not found: {err}")),
    };
    let started = std::time::Instant::now();
    let output = Command::new("sh")
        .arg("-lc")
        .arg(&command)
        .current_dir(&project_path)
        .output()
        .map_err(|err| format!("failed to run verify command {id}: {err}"))?;
    let exit_code = output.status.code().map(|code| code as i64);
    let combined = capped_verify_output(&output.stdout, &output.stderr);
    let ran_at = now_ms();
    conn.execute(
        "INSERT INTO verify_runs(id, project_id, label, command, exit_code, ran_at, required, output)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           project_id=excluded.project_id,
           label=excluded.label,
           command=excluded.command,
           exit_code=excluded.exit_code,
           ran_at=excluded.ran_at,
           required=excluded.required,
           output=excluded.output",
        params![&id, project_id, &label, &command, exit_code, ran_at, required, &combined],
    )
    .map_err(|err| format!("failed to update verify run: {err}"))?;
    Ok(VerifyRunRecord {
        id,
        label,
        command,
        cwd: Some(project_path),
        required: required != 0,
        status: if exit_code == Some(0) {
            "ok".to_string()
        } else {
            "fail".to_string()
        },
        exit_code,
        ran_at: Some(ran_at),
        output: combined,
        duration_ms: Some(started.elapsed().as_millis() as i64),
    })
}

fn capped_verify_output(stdout: &[u8], stderr: &[u8]) -> String {
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(stdout),
        String::from_utf8_lossy(stderr)
    );
    let total = combined.chars().count();
    if total <= VERIFY_OUTPUT_CHAR_CAP {
        return combined;
    }
    let tail = combined
        .chars()
        .skip(total - VERIFY_OUTPUT_CHAR_CAP)
        .collect::<String>();
    format!("[output truncated]\n{tail}")
}

fn declared_verify_commands(project_path: &str) -> Result<Vec<VerifyDeclareCommand>, String> {
    let path = PathBuf::from(project_path)
        .join(".polypore")
        .join("verify.json");
    let mut commands = if path.exists() {
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("failed to read {}: {err}", path.display()))?;
        serde_json::from_str::<Vec<VerifyDeclareCommand>>(&text)
            .map_err(|err| format!("failed to parse {}: {err}", path.display()))?
    } else {
        Vec::new()
    };
    for detected in auto_detect_verify_commands(Path::new(project_path)) {
        if commands.iter().any(|command| command.id == detected.id) {
            continue;
        }
        commands.push(detected);
    }
    Ok(commands)
}

fn auto_detect_verify_commands(root: &Path) -> Vec<VerifyDeclareCommand> {
    let mut commands = Vec::new();
    detect_package_scripts(root, &mut commands);
    if root.join("Cargo.toml").exists() {
        commands.push(verify_command("cargo-check", "cargo check", "cargo check"));
    } else if root.join("src-tauri").join("Cargo.toml").exists() {
        commands.push(verify_command(
            "cargo-check",
            "cargo check",
            "cargo check --manifest-path src-tauri/Cargo.toml",
        ));
    }
    if root.join("go.mod").exists() {
        commands.push(verify_command("go-test", "go test", "go test ./..."));
        commands.push(verify_command("go-vet", "go vet", "go vet ./..."));
    }
    if has_any(root, &["pytest.ini", "tox.ini"]) || root.join("pyproject.toml").exists() {
        commands.push(verify_command("pytest", "pytest", "python3 -m pytest"));
    }
    if root.join("pyproject.toml").exists() || root.join("ruff.toml").exists() {
        commands.push(verify_command(
            "ruff",
            "ruff check",
            "python3 -m ruff check .",
        ));
    }
    if root.join("pom.xml").exists() {
        commands.push(verify_command("maven-test", "maven test", "mvn test"));
    }
    if has_gradle_project(root) {
        commands.push(verify_command(
            "gradle-test",
            "gradle test",
            &gradle_test_command(root),
        ));
    }
    if has_file_with_extension(root, &["sln", "csproj", "fsproj", "vbproj"]) {
        commands.push(verify_command(
            "dotnet-test",
            "dotnet test",
            "dotnet test --nologo",
        ));
    }
    if root.join("build.sbt").exists() {
        commands.push(verify_command("sbt-test", "sbt test", "sbt -batch test"));
    }
    if root.join("mix.exs").exists() {
        commands.push(verify_command("mix-test", "mix test", "mix test"));
    }
    if root.join("composer.json").exists() {
        commands.push(verify_command(
            "composer-validate",
            "composer validate",
            "composer validate --no-check-publish --no-interaction",
        ));
    }
    if root.join("Package.swift").exists() {
        commands.push(verify_command("swift-test", "swift test", "swift test"));
    }
    if root.join("pubspec.yaml").exists() {
        if pubspec_uses_flutter(root) {
            commands.push(verify_command(
                "flutter-test",
                "flutter test",
                "flutter test",
            ));
        } else {
            commands.push(verify_command("dart-test", "dart test", "dart test"));
        }
    }
    commands
}

fn detect_package_scripts(root: &Path, commands: &mut Vec<VerifyDeclareCommand>) {
    let path = root.join("package.json");
    let Ok(text) = fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    let Some(scripts) = value.get("scripts").and_then(|item| item.as_object()) else {
        return;
    };
    let manager = package_manager(root, &value);
    for name in ["lint", "typecheck", "check", "test", "build"] {
        if scripts.contains_key(name) {
            commands.push(verify_command(
                &format!("{manager}-{name}"),
                name,
                &package_script_command(&manager, name),
            ));
        }
    }
}

fn package_manager(root: &Path, package: &serde_json::Value) -> String {
    if let Some(declared) = package
        .get("packageManager")
        .and_then(|item| item.as_str())
        .and_then(|item| item.split('@').next())
    {
        if matches!(declared, "npm" | "pnpm" | "yarn" | "bun") {
            return declared.to_string();
        }
    }
    if root.join("pnpm-lock.yaml").exists() {
        return "pnpm".to_string();
    }
    if root.join("yarn.lock").exists() {
        return "yarn".to_string();
    }
    if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        return "bun".to_string();
    }
    "npm".to_string()
}

fn package_script_command(manager: &str, name: &str) -> String {
    match manager {
        "npm" => format!("npm run {name}"),
        "yarn" => format!("yarn {name}"),
        other => format!("{other} run {name}"),
    }
}

fn verify_command(id: &str, label: &str, command: &str) -> VerifyDeclareCommand {
    VerifyDeclareCommand {
        id: id.to_string(),
        label: Some(label.to_string()),
        command: command.to_string(),
        required: Some(true),
    }
}

fn has_any(root: &Path, names: &[&str]) -> bool {
    names.iter().any(|name| root.join(name).exists())
}

fn has_gradle_project(root: &Path) -> bool {
    has_any(
        root,
        &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
    )
}

fn gradle_test_command(root: &Path) -> String {
    if root.join("gradlew").exists() {
        "./gradlew test".to_string()
    } else {
        "gradle test".to_string()
    }
}

fn pubspec_uses_flutter(root: &Path) -> bool {
    fs::read_to_string(root.join("pubspec.yaml"))
        .map(|content| content.contains("sdk: flutter") || content.contains("flutter:"))
        .unwrap_or(false)
}

fn has_file_with_extension(root: &Path, extensions: &[&str]) -> bool {
    fn visit(dir: &Path, extensions: &[&str], seen: &mut usize) -> bool {
        *seen += 1;
        if *seen > 500 {
            return false;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| extensions.contains(&ext))
                    .unwrap_or(false)
            {
                return true;
            }
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if matches!(
                    name,
                    ".git" | ".polypore" | "node_modules" | "target" | "bin" | "obj"
                ) {
                    continue;
                }
                if visit(&path, extensions, seen) {
                    return true;
                }
            }
        }
        false
    }
    visit(root, extensions, &mut 0)
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLogRow {
    pub id: i64,
    pub worktree_id: String,
    pub commit_hash: String,
    pub ts: i64,
    pub kind: String,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEventWriteInput {
    pub id: Option<String>,
    pub ts: i64,
    pub task_id: String,
    pub source: String,
    pub kind: String,
    pub agent_id: Option<String>,
    pub tool_name: Option<String>,
    pub phase: Option<String>,
    pub affected_files: Vec<String>,
    pub summary: Option<String>,
    pub worktree_id: Option<String>,
    pub snapshot_commit: Option<String>,
    pub payload: Option<serde_json::Value>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEventRow {
    pub id: String,
    pub ts: i64,
    pub task_id: String,
    pub source: String,
    pub kind: String,
    pub agent_id: Option<String>,
    pub tool_name: Option<String>,
    pub phase: Option<String>,
    pub affected_files: Vec<String>,
    pub summary: String,
    pub worktree_id: String,
    pub snapshot_commit: Option<String>,
    pub payload: Option<serde_json::Value>,
}

pub fn record_snapshot_log_row(
    worktree_id: &str,
    commit_hash: &str,
    ts: i64,
    kind: &str,
) -> Result<(), String> {
    let conn = open_db()?;
    migrate(&conn)?;
    conn.execute(
        "INSERT INTO snapshot_log(worktree_id, commit_hash, ts, kind)
         VALUES (?1, ?2, ?3, ?4)",
        params![worktree_id, commit_hash, ts, kind],
    )
    .map_err(|err| format!("failed to record snapshot log: {err}"))?;
    Ok(())
}

#[tauri::command]
pub fn history_event_record(input: HistoryEventWriteInput) -> Result<HistoryEventRow, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let affected_json = serde_json::to_string(&input.affected_files)
        .map_err(|err| format!("failed to encode affected_files: {err}"))?;
    let payload_json = input
        .payload
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("failed to encode payload: {err}"))?;
    let summary = input.summary.clone().unwrap_or_else(|| input.kind.clone());
    let worktree_id = input
        .worktree_id
        .clone()
        .unwrap_or_else(|| "main".to_string());
    let id = input
        .id
        .clone()
        .unwrap_or_else(|| format!("ev-{}-{}", input.ts, now_ms()));
    /* We embed summary inside payload so the existing schema (which has no
    summary column) can round-trip the front-end's expected shape. */
    let payload_with_summary = match payload_json.clone() {
        Some(existing) => {
            let mut value: serde_json::Value =
                serde_json::from_str(&existing).unwrap_or(serde_json::json!({}));
            if let serde_json::Value::Object(ref mut map) = value {
                map.insert("__summary".into(), serde_json::json!(summary));
                map.insert("__id".into(), serde_json::json!(id));
            }
            serde_json::to_string(&value)
                .map_err(|err| format!("failed to merge summary: {err}"))?
        }
        None => serde_json::to_string(&serde_json::json!({
            "__summary": summary,
            "__id": id,
        }))
        .map_err(|err| format!("failed to encode summary: {err}"))?,
    };
    conn.execute(
        "INSERT INTO history_events(
           ts, task_id, source, kind, agent_id, tool_name, phase,
           affected_files, payload, worktree_id, snapshot_commit
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            input.ts,
            input.task_id,
            input.source,
            input.kind,
            input.agent_id,
            input.tool_name,
            input.phase,
            affected_json,
            payload_with_summary,
            worktree_id,
            input.snapshot_commit,
        ],
    )
    .map_err(|err| format!("failed to insert history event: {err}"))?;
    Ok(HistoryEventRow {
        id,
        ts: input.ts,
        task_id: input.task_id,
        source: input.source,
        kind: input.kind,
        agent_id: input.agent_id,
        tool_name: input.tool_name,
        phase: input.phase,
        affected_files: input.affected_files,
        summary,
        worktree_id,
        snapshot_commit: input.snapshot_commit,
        payload: input.payload,
    })
}

#[tauri::command]
pub fn history_events_list(
    worktree_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<HistoryEventRow>, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let limit = limit.unwrap_or(500).clamp(1, 5000);
    let mut stmt;
    let rows;
    let wt_id = worktree_id.unwrap_or_default();
    if wt_id.is_empty() {
        stmt = conn
            .prepare(
                "SELECT ts, task_id, source, kind, agent_id, tool_name, phase,
                        affected_files, payload, worktree_id, snapshot_commit
                 FROM history_events ORDER BY ts DESC LIMIT ?1",
            )
            .map_err(|err| format!("failed to prepare history events query: {err}"))?;
        rows = stmt
            .query_map(params![limit], decode_history_row)
            .map_err(|err| format!("failed to query history events: {err}"))?;
    } else {
        stmt = conn
            .prepare(
                "SELECT ts, task_id, source, kind, agent_id, tool_name, phase,
                        affected_files, payload, worktree_id, snapshot_commit
                 FROM history_events WHERE worktree_id = ?1
                 ORDER BY ts DESC LIMIT ?2",
            )
            .map_err(|err| format!("failed to prepare history events query: {err}"))?;
        rows = stmt
            .query_map(params![wt_id, limit], decode_history_row)
            .map_err(|err| format!("failed to query history events: {err}"))?;
    }
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("failed to decode history row: {err}"))?);
    }
    Ok(out)
}

fn decode_history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEventRow> {
    let ts: i64 = row.get(0)?;
    let task_id: String = row.get(1)?;
    let source: String = row.get(2)?;
    let kind: String = row.get(3)?;
    let agent_id: Option<String> = row.get(4)?;
    let tool_name: Option<String> = row.get(5)?;
    let phase: Option<String> = row.get(6)?;
    let affected_files_json: Option<String> = row.get(7)?;
    let payload_json: Option<String> = row.get(8)?;
    let worktree_id: String = row.get(9).unwrap_or_else(|_| "main".to_string());
    let snapshot_commit: Option<String> = row.get(10).ok();
    let affected_files: Vec<String> = affected_files_json
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let mut payload_value: Option<serde_json::Value> = payload_json
        .as_deref()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let mut summary = kind.clone();
    let mut id = format!("ev-{ts}");
    if let Some(serde_json::Value::Object(ref mut map)) = payload_value {
        if let Some(serde_json::Value::String(s)) = map.remove("__summary") {
            summary = s;
        }
        if let Some(serde_json::Value::String(s)) = map.remove("__id") {
            id = s;
        }
    }
    Ok(HistoryEventRow {
        id,
        ts,
        task_id,
        source,
        kind,
        agent_id,
        tool_name,
        phase,
        affected_files,
        summary,
        worktree_id,
        snapshot_commit,
        payload: payload_value,
    })
}

#[tauri::command]
pub fn snapshot_log_list(
    worktree_id: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SnapshotLogRow>, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let limit = limit.unwrap_or(200).clamp(1, 2000);
    let wt_id = worktree_id.unwrap_or_default();
    let mut out = Vec::new();
    if wt_id.is_empty() {
        let mut stmt = conn
            .prepare(
                "SELECT id, worktree_id, commit_hash, ts, kind
                 FROM snapshot_log ORDER BY ts DESC LIMIT ?1",
            )
            .map_err(|err| format!("failed to prepare snapshot log query: {err}"))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(SnapshotLogRow {
                    id: row.get(0)?,
                    worktree_id: row.get(1)?,
                    commit_hash: row.get(2)?,
                    ts: row.get(3)?,
                    kind: row.get(4)?,
                })
            })
            .map_err(|err| format!("failed to query snapshot log: {err}"))?;
        for row in rows {
            out.push(row.map_err(|err| format!("failed to decode snapshot log row: {err}"))?);
        }
    } else {
        let mut stmt = conn
            .prepare(
                "SELECT id, worktree_id, commit_hash, ts, kind
                 FROM snapshot_log WHERE worktree_id = ?1
                 ORDER BY ts DESC LIMIT ?2",
            )
            .map_err(|err| format!("failed to prepare snapshot log query: {err}"))?;
        let rows = stmt
            .query_map(params![wt_id, limit], |row| {
                Ok(SnapshotLogRow {
                    id: row.get(0)?,
                    worktree_id: row.get(1)?,
                    commit_hash: row.get(2)?,
                    ts: row.get(3)?,
                    kind: row.get(4)?,
                })
            })
            .map_err(|err| format!("failed to query snapshot log: {err}"))?;
        for row in rows {
            out.push(row.map_err(|err| format!("failed to decode snapshot log row: {err}"))?);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn persistence_record_snapshot(input: FileSnapshotInput) -> Result<PersistedRow, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let hash = content_hash(&input.content);
    conn.execute(
        "INSERT OR IGNORE INTO file_snapshots(ts, task_id, path, content_hash, content)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now_ms(), input.task_id, input.path, hash, input.content],
    )
    .map_err(|err| format!("failed to persist file snapshot: {err}"))?;
    Ok(PersistedRow {
        stored: true,
        id: hash,
    })
}

#[tauri::command]
pub fn tasks_list() -> Result<Vec<TaskRecord>, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_id = upsert_project(&conn, &current_project_path()?)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, label, done, parent_id, panel_hint, created_at, created_by
             FROM tasks WHERE project_id = ?1 ORDER BY created_at DESC",
        )
        .map_err(|err| format!("failed to prepare tasks list: {err}"))?;
    let rows = stmt
        .query_map(params![project_id], |row| {
            Ok(TaskRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                done: row.get::<_, i64>(2)? != 0,
                parent_id: row.get(3)?,
                panel_hint: row.get(4)?,
                created_at: row.get(5)?,
                created_by: row.get(6)?,
            })
        })
        .map_err(|err| format!("failed to read tasks: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("failed to decode task: {err}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn tasks_add(input: TaskWriteInput) -> Result<TaskRecord, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_id = upsert_project(&conn, &current_project_path()?)?;
    let created_at = now_ms();
    let id = input.id.unwrap_or_else(|| format!("t-{created_at}"));
    let task = TaskRecord {
        id,
        label: input.label,
        done: input.done.unwrap_or(false),
        parent_id: input.parent_id,
        panel_hint: input.panel_hint,
        created_at,
        created_by: input.created_by.unwrap_or_else(|| "user".to_string()),
    };
    conn.execute(
        "INSERT INTO tasks(id, project_id, parent_id, label, done, created_at, panel_hint, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           parent_id=excluded.parent_id,
           label=excluded.label,
           done=excluded.done,
           panel_hint=excluded.panel_hint,
           created_by=excluded.created_by",
        params![
            &task.id,
            project_id,
            &task.parent_id,
            &task.label,
            if task.done { 1 } else { 0 },
            task.created_at,
            &task.panel_hint,
            &task.created_by
        ],
    )
    .map_err(|err| format!("failed to write task: {err}"))?;
    Ok(task)
}

#[tauri::command]
pub fn tasks_update(input: TaskUpdateInput) -> Result<TaskRecord, String> {
    let mut tasks = tasks_list()?;
    let existing = tasks
        .iter_mut()
        .find(|task| task.id == input.id)
        .ok_or_else(|| format!("task not found: {}", input.id))?;
    if let Some(label) = input.label {
        existing.label = label;
    }
    if let Some(done) = input.done {
        existing.done = done;
    }
    if input.parent_id.is_some() {
        existing.parent_id = input.parent_id;
    }
    if input.panel_hint.is_some() {
        existing.panel_hint = input.panel_hint;
    }
    if let Some(created_by) = input.created_by {
        existing.created_by = created_by;
    }
    tasks_add(TaskWriteInput {
        id: Some(existing.id.clone()),
        label: existing.label.clone(),
        done: Some(existing.done),
        parent_id: existing.parent_id.clone(),
        panel_hint: existing.panel_hint.clone(),
        created_by: Some(existing.created_by.clone()),
    })
}

pub(crate) fn open_db() -> Result<Connection, String> {
    let path = db_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "database path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("failed to create data dir: {err}"))?;
    migrate_legacy_sessions_db(&path)?;
    Connection::open(path).map_err(|err| format!("failed to open sqlite database: {err}"))
}

pub(crate) fn db_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("POLYPORE_DATA_DIR") {
        return Ok(PathBuf::from(dir).join("polypore.sqlite"));
    }
    if let Ok(dir) = std::env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(dir).join("polypore").join("polypore.sqlite"));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("polypore")
        .join("polypore.sqlite"))
}

fn legacy_db_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("POLYPORE_DATA_DIR") {
        return Ok(PathBuf::from(dir).join("sessions.db"));
    }
    if let Ok(dir) = std::env::var("XDG_DATA_HOME") {
        return Ok(PathBuf::from(dir).join("polypore").join("sessions.db"));
    }
    let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("polypore")
        .join("sessions.db"))
}

fn migrate_legacy_sessions_db(path: &Path) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    let legacy = legacy_db_path()?;
    if legacy == path || !legacy.exists() {
        return Ok(());
    }
    fs::copy(&legacy, path).map_err(|err| {
        format!(
            "failed to migrate legacy sqlite database from {} to {}: {err}",
            legacy.display(),
            path.display()
        )
    })?;
    Ok(())
}

fn current_project_path() -> Result<String, String> {
    project_context::active_project_path()
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS projects(
          id INTEGER PRIMARY KEY,
          path TEXT UNIQUE NOT NULL,
          last_opened INTEGER
        );
        CREATE TABLE IF NOT EXISTS chat_sessions(
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          agent TEXT NOT NULL,
          title TEXT,
          created_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS chat_messages(
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id),
          ts INTEGER NOT NULL,
          role TEXT NOT NULL,
          body TEXT NOT NULL,
          tool_call_id INTEGER
        );
        CREATE TABLE IF NOT EXISTS history_events(
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          source TEXT NOT NULL,
          kind TEXT NOT NULL,
          agent_id TEXT,
          tool_name TEXT,
          phase TEXT,
          affected_files TEXT,
          payload TEXT,
          snapshot_id INTEGER REFERENCES file_snapshots(id),
          worktree_id TEXT NOT NULL DEFAULT 'main',
          snapshot_commit TEXT
        );
        CREATE TABLE IF NOT EXISTS worktree_registry(
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL REFERENCES projects(id),
          path TEXT NOT NULL,
          branch TEXT,
          created_at INTEGER NOT NULL,
          removed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_worktree_registry_project
          ON worktree_registry(project_id);
        CREATE TABLE IF NOT EXISTS snapshot_log(
          id INTEGER PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          commit_hash TEXT NOT NULL,
          ts INTEGER NOT NULL,
          kind TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshot_log_worktree_ts
          ON snapshot_log(worktree_id, ts DESC);
        CREATE TABLE IF NOT EXISTS file_snapshots(
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          path TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          content BLOB
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_hash ON file_snapshots(content_hash);
        CREATE TABLE IF NOT EXISTS verify_runs(
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL,
          label TEXT NOT NULL,
          command TEXT NOT NULL,
          exit_code INTEGER,
          ran_at INTEGER,
          required INTEGER,
          output TEXT
        );
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL,
          parent_id TEXT,
          label TEXT NOT NULL,
          done INTEGER,
          created_at INTEGER,
          panel_hint TEXT,
          created_by TEXT DEFAULT 'user'
        );
        CREATE TABLE IF NOT EXISTS iterate_state(
          task_id TEXT PRIMARY KEY,
          project_id INTEGER NOT NULL,
          cycle INTEGER NOT NULL,
          max_cycles INTEGER NOT NULL,
          status TEXT NOT NULL,
          pause_requested INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        ",
    )
    .map_err(|err| format!("failed to migrate sqlite database: {err}"))?;
    add_column_if_missing(conn, "tasks", "panel_hint", "TEXT")?;
    add_column_if_missing(conn, "tasks", "created_by", "TEXT DEFAULT 'user'")?;
    add_column_if_missing(
        conn,
        "history_events",
        "worktree_id",
        "TEXT NOT NULL DEFAULT 'main'",
    )?;
    add_column_if_missing(conn, "history_events", "snapshot_commit", "TEXT")?;
    /* Indices that depend on columns added by add_column_if_missing must run
    after those migrations. CREATE TABLE statements inside the batch above
    only create them for fresh databases. */
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_history_events_worktree_ts
           ON history_events(worktree_id, ts DESC);",
    )
    .map_err(|err| format!("failed to create idx_history_events_worktree_ts: {err}"))?;
    Ok(())
}

fn upsert_project(conn: &Connection, project_path: &str) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO projects(path, last_opened) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET last_opened=excluded.last_opened",
        params![project_path, now_ms()],
    )
    .map_err(|err| format!("failed to upsert project: {err}"))?;
    conn.query_row(
        "SELECT id FROM projects WHERE path = ?1",
        params![project_path],
        |row| row.get(0),
    )
    .map_err(|err| format!("failed to read project id: {err}"))
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> Result<(), String> {
    let sql = format!("ALTER TABLE {table} ADD COLUMN {column} {definition}");
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(err) if err.to_string().contains("duplicate column name") => Ok(()),
        Err(err) => Err(format!("failed to migrate {table}.{column}: {err}")),
    }
}

fn count(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .map_err(|err| format!("failed to count {table}: {err}"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn content_hash(content: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in content {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{LazyLock, Mutex};

    static ENV_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

    fn fresh_conn() -> Connection {
        Connection::open_in_memory().expect("open in-memory sqlite")
    }

    fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
        let sql = format!("PRAGMA table_info({table})");
        let mut stmt = conn.prepare(&sql).expect("pragma table_info");
        let mut rows = stmt.query([]).expect("query table_info");
        while let Some(row) = rows.next().expect("row") {
            let name: String = row.get(1).expect("col name");
            if name == column {
                return true;
            }
        }
        false
    }

    fn table_exists(conn: &Connection, table: &str) -> bool {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?1")
            .expect("prepare sqlite_master");
        stmt.exists(params![table]).expect("query sqlite_master")
    }

    #[test]
    fn migrate_adds_worktree_and_snapshot_columns() {
        let conn = fresh_conn();
        migrate(&conn).expect("first migrate");
        assert!(column_exists(&conn, "history_events", "worktree_id"));
        assert!(column_exists(&conn, "history_events", "snapshot_commit"));
    }

    #[test]
    fn migrate_creates_worktree_registry() {
        let conn = fresh_conn();
        migrate(&conn).expect("first migrate");
        assert!(table_exists(&conn, "worktree_registry"));
        for col in [
            "id",
            "project_id",
            "path",
            "branch",
            "created_at",
            "removed_at",
        ] {
            assert!(
                column_exists(&conn, "worktree_registry", col),
                "missing {col}"
            );
        }
    }

    #[test]
    fn migrate_creates_snapshot_log() {
        let conn = fresh_conn();
        migrate(&conn).expect("first migrate");
        assert!(table_exists(&conn, "snapshot_log"));
        for col in ["id", "worktree_id", "commit_hash", "ts", "kind"] {
            assert!(column_exists(&conn, "snapshot_log", col), "missing {col}");
        }
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = fresh_conn();
        migrate(&conn).expect("first migrate");
        migrate(&conn).expect("second migrate");
        migrate(&conn).expect("third migrate");
    }

    #[test]
    fn open_db_migrates_legacy_sessions_db_to_polypore_sqlite() {
        let _guard = ENV_LOCK.lock().expect("env lock");
        let previous_data_dir = std::env::var("POLYPORE_DATA_DIR").ok();
        let dir = std::env::temp_dir().join(format!(
            "polypore-db-migrate-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).expect("create temp data dir");
        std::env::set_var("POLYPORE_DATA_DIR", &dir);

        let legacy = dir.join("sessions.db");
        let legacy_conn = Connection::open(&legacy).expect("open legacy db");
        legacy_conn
            .execute_batch(
                "CREATE TABLE projects(
                  id INTEGER PRIMARY KEY,
                  path TEXT UNIQUE NOT NULL,
                  last_opened INTEGER
                );
                INSERT INTO projects(path, last_opened) VALUES('/legacy', 1);",
            )
            .expect("seed legacy db");
        drop(legacy_conn);

        let conn = open_db().expect("open migrated db");
        migrate(&conn).expect("migrate copied db");
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE path='/legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated project");

        assert_eq!(count, 1);
        assert!(dir.join("polypore.sqlite").exists());

        match previous_data_dir {
            Some(value) => std::env::set_var("POLYPORE_DATA_DIR", value),
            None => std::env::remove_var("POLYPORE_DATA_DIR"),
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_preserves_legacy_history_events_with_default_worktree() {
        let conn = fresh_conn();
        /* Simulate a pre-migration database: create history_events without
        the new columns, insert a legacy row, then migrate. */
        conn.execute_batch(
            "CREATE TABLE history_events(
              id INTEGER PRIMARY KEY,
              ts INTEGER NOT NULL,
              task_id TEXT NOT NULL,
              source TEXT NOT NULL,
              kind TEXT NOT NULL,
              agent_id TEXT,
              tool_name TEXT,
              phase TEXT,
              affected_files TEXT,
              payload TEXT,
              snapshot_id INTEGER
            );",
        )
        .expect("seed legacy schema");
        conn.execute(
            "INSERT INTO history_events(ts, task_id, source, kind) VALUES (?1, ?2, ?3, ?4)",
            params![1_700_000_000_000i64, "t-legacy", "agent", "tool-call"],
        )
        .expect("insert legacy row");

        migrate(&conn).expect("migrate over legacy schema");

        let worktree_id: String = conn
            .query_row(
                "SELECT worktree_id FROM history_events WHERE task_id='t-legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read backfilled worktree_id");
        assert_eq!(worktree_id, "main");
    }

    #[test]
    fn verify_auto_detect_covers_non_js_runtimes() {
        let dir = std::env::temp_dir().join(format!(
            "polypore-verify-detect-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("pom.xml"), "<project />").unwrap();
        fs::write(dir.join("build.gradle"), "").unwrap();
        fs::write(dir.join("gradlew"), "").unwrap();
        fs::write(dir.join("src").join("App.csproj"), "<Project />").unwrap();
        fs::write(dir.join("build.sbt"), r#"name := "app""#).unwrap();
        fs::write(dir.join("mix.exs"), "defmodule App.MixProject do end").unwrap();
        fs::write(dir.join("composer.json"), "{}").unwrap();
        fs::write(dir.join("Package.swift"), "// swift-tools-version: 5.10").unwrap();
        fs::write(
            dir.join("pubspec.yaml"),
            "dependencies:\n  flutter:\n    sdk: flutter\n",
        )
        .unwrap();

        let commands = auto_detect_verify_commands(&dir);
        let ids: Vec<&str> = commands.iter().map(|command| command.id.as_str()).collect();

        for expected in [
            "maven-test",
            "gradle-test",
            "dotnet-test",
            "sbt-test",
            "mix-test",
            "composer-validate",
            "swift-test",
            "flutter-test",
        ] {
            assert!(ids.contains(&expected), "missing {expected}");
        }
        let gradle = commands
            .iter()
            .find(|command| command.id == "gradle-test")
            .expect("gradle command");
        assert_eq!(gradle.command, "./gradlew test");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verify_output_is_capped_to_tail() {
        let stdout = "a".repeat(VERIFY_OUTPUT_CHAR_CAP + 10);
        let capped = capped_verify_output(stdout.as_bytes(), b"stderr-tail");

        assert!(capped.starts_with("[output truncated]\n"));
        assert!(capped.ends_with("stderr-tail"));
        assert_eq!(
            capped.chars().count(),
            "[output truncated]\n".chars().count() + VERIFY_OUTPUT_CHAR_CAP
        );

        let small = capped_verify_output(b"stdout", b"stderr");
        assert_eq!(small, "stdoutstderr");
    }

    #[test]
    fn verify_package_scripts_use_declared_or_locked_package_manager() {
        let root = std::env::temp_dir().join(format!(
            "polypore-verify-package-manager-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&root).unwrap();

        let cases = [
            (
                "declared-pnpm",
                r#"{"packageManager":"pnpm@9.0.0","scripts":{"typecheck":"tsc"}}"#,
                None,
                "pnpm-typecheck",
                "pnpm run typecheck",
            ),
            (
                "locked-yarn",
                r#"{"scripts":{"test":"vitest"}}"#,
                Some("yarn.lock"),
                "yarn-test",
                "yarn test",
            ),
            (
                "locked-bun",
                r#"{"scripts":{"build":"vite build"}}"#,
                Some("bun.lock"),
                "bun-build",
                "bun run build",
            ),
            (
                "fallback-npm",
                r#"{"scripts":{"lint":"eslint ."}}"#,
                None,
                "npm-lint",
                "npm run lint",
            ),
        ];

        for (name, package_json, lockfile, expected_id, expected_command) in cases {
            let dir = root.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("package.json"), package_json).unwrap();
            if let Some(lockfile) = lockfile {
                fs::write(dir.join(lockfile), "").unwrap();
            }
            let commands = auto_detect_verify_commands(&dir);
            let command = commands
                .iter()
                .find(|command| command.id == expected_id)
                .unwrap_or_else(|| panic!("missing {expected_id}"));
            assert_eq!(command.command, expected_command);
        }

        fs::remove_dir_all(&root).ok();
    }
}
