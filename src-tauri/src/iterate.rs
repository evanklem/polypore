use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};

use crate::project_context;

#[derive(Clone, Debug, serde::Deserialize)]
pub struct IterateCommand {
    pub id: String,
    pub label: String,
    pub command: String,
    pub required: bool,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct IterateRunInput {
    pub task_id: String,
    pub prompt: String,
    pub project_path: Option<String>,
    pub max_cycles: Option<i64>,
    pub verify_commands: Vec<IterateCommand>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IterateVerifyRun {
    pub id: String,
    pub label: String,
    pub command: String,
    pub required: bool,
    pub exit_code: Option<i32>,
    pub output: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IterateRunResult {
    pub task_id: String,
    pub status: String,
    pub cycle: i64,
    pub max_cycles: i64,
    pub prompt: String,
    pub runs: Vec<IterateVerifyRun>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct IterateStatus {
    pub task_id: String,
    pub status: String,
    pub cycle: i64,
    pub max_cycles: i64,
}

#[tauri::command]
pub fn iterate_run(input: IterateRunInput) -> Result<IterateRunResult, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    let project_path = resolve_iterate_project_path(input.project_path)?;
    let project_id = upsert_project(&conn, &project_path)?;
    let max_cycles = input.max_cycles.unwrap_or(5).clamp(1, 25);
    let cycle = next_cycle(&conn, &input.task_id)?.min(max_cycles);
    let mut runs = Vec::new();

    for verify in &input.verify_commands {
        let run = run_verify(verify, &project_path)?;
        record_verify(&conn, project_id, &run)?;
        runs.push(run);
    }

    let clean = runs
        .iter()
        .filter(|run| run.required)
        .all(|run| run.exit_code == Some(0));
    let status = if clean {
        "clean"
    } else if cycle >= max_cycles {
        "paused"
    } else {
        "failed"
    };
    record_iterate_state(&conn, project_id, &input.task_id, cycle, max_cycles, status)?;

    Ok(IterateRunResult {
        task_id: input.task_id,
        status: status.to_string(),
        cycle,
        max_cycles,
        prompt: input.prompt,
        runs,
    })
}

#[tauri::command]
pub fn iterate_status(task_id: String) -> Result<Option<IterateStatus>, String> {
    let conn = open_db()?;
    migrate(&conn)?;
    match conn.query_row(
        "SELECT task_id, status, cycle, max_cycles FROM iterate_state WHERE task_id = ?1",
        params![task_id],
        |row| {
            Ok(IterateStatus {
                task_id: row.get(0)?,
                status: row.get(1)?,
                cycle: row.get(2)?,
                max_cycles: row.get(3)?,
            })
        },
    ) {
        Ok(status) => Ok(Some(status)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("failed to read iterate status: {err}")),
    }
}

fn run_verify(verify: &IterateCommand, project_path: &str) -> Result<IterateVerifyRun, String> {
    let output = Command::new("sh")
        .arg("-lc")
        .arg(&verify.command)
        .current_dir(project_path)
        .output()
        .map_err(|err| format!("failed to run verify command {}: {err}", verify.id))?;
    Ok(IterateVerifyRun {
        id: format!("{}-{}", verify.id, now_ms()),
        label: verify.label.clone(),
        command: verify.command.clone(),
        required: verify.required,
        exit_code: output.status.code(),
        output: format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .chars()
        .rev()
        .take(12000)
        .collect::<String>()
        .chars()
        .rev()
        .collect(),
    })
}

fn record_verify(conn: &Connection, project_id: i64, run: &IterateVerifyRun) -> Result<(), String> {
    conn.execute(
        "INSERT INTO verify_runs(id, project_id, label, command, exit_code, ran_at, required, output)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            run.id,
            project_id,
            run.label,
            run.command,
            run.exit_code,
            now_ms(),
            if run.required { 1 } else { 0 },
            run.output
        ],
    )
    .map_err(|err| format!("failed to record iterate verify run: {err}"))?;
    Ok(())
}

fn record_iterate_state(
    conn: &Connection,
    project_id: i64,
    task_id: &str,
    cycle: i64,
    max_cycles: i64,
    status: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO iterate_state(task_id, project_id, cycle, max_cycles, status, pause_requested, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT(task_id) DO UPDATE SET
           cycle=excluded.cycle,
           max_cycles=excluded.max_cycles,
           status=excluded.status,
           updated_at=excluded.updated_at",
        params![task_id, project_id, cycle, max_cycles, status, now_ms()],
    )
    .map_err(|err| format!("failed to record iterate state: {err}"))?;
    Ok(())
}

fn next_cycle(conn: &Connection, task_id: &str) -> Result<i64, String> {
    match conn.query_row(
        "SELECT cycle FROM iterate_state WHERE task_id = ?1",
        params![task_id],
        |row| row.get::<_, i64>(0),
    ) {
        Ok(cycle) => Ok(cycle + 1),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(1),
        Err(err) => Err(format!("failed to read iterate cycle: {err}")),
    }
}

fn open_db() -> Result<Connection, String> {
    crate::persistence::open_db()
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
    .map_err(|err| format!("failed to migrate iterate tables: {err}"))
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

fn resolve_iterate_project_path(input: Option<String>) -> Result<String, String> {
    let active = project_context::active_project_root()?;
    if let Some(raw) = input {
        let requested = fs::canonicalize(&raw)
            .map_err(|err| format!("invalid iterate project path '{raw}': {err}"))?;
        let active = fs::canonicalize(&active)
            .map_err(|err| format!("invalid active project path '{}': {err}", active.display()))?;
        if requested != active {
            return Err("iterate project path must match the active project".into());
        }
        return Ok(active.display().to_string());
    }
    Ok(active.display().to_string())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("polypore-iterate-{name}-{unique}"));
        std::fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn resolve_iterate_project_path_accepts_active_root_alias() {
        let active = project_context::active_project_root().expect("active root");
        let active = std::fs::canonicalize(active).expect("canonical active root");

        let resolved = resolve_iterate_project_path(Some(active.join(".").display().to_string()))
            .expect("active root accepted");

        assert_eq!(resolved, active.display().to_string());
    }

    #[test]
    fn resolve_iterate_project_path_rejects_other_directories() {
        let outside = temp_root("outside");

        let result = resolve_iterate_project_path(Some(outside.display().to_string()));

        assert_eq!(
            result.unwrap_err(),
            "iterate project path must match the active project"
        );
        let _ = std::fs::remove_dir_all(outside);
    }
}
