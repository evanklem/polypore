//! One-key handoff: what a session was doing, written down so a fresh
//! session can pick it up without the old one's context.

use std::path::PathBuf;

use crate::model::*;

/// The handoff note for a run, as markdown.
pub fn note(run: &AgentRun, title: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Handoff: {title}\n\n"));
    out.push_str(&format!("From a {} session ({}), last active {}.\n", run.key.kind.label(), run.key.id, chrono::DateTime::from_timestamp_millis(run.updated).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default()));
    out.push_str(&format!("Working directory: {}", run.cwd));
    if !run.branch.is_empty() {
        out.push_str(&format!(", branch {}", run.branch));
    }
    out.push_str(".\n");
    out.push_str(&format!("Full transcript: {}\n\n", run.path.display()));
    if !run.goal.is_empty() {
        out.push_str(&format!("## Goal\n\n{}\n\n", run.goal));
    }
    let prompts: Vec<&Event> = run.events.iter().filter(|e| e.kind == EvKind::Prompt).collect();
    if let Some(first) = prompts.first() {
        out.push_str(&format!("## What was asked\n\nFirst prompt: {}\n", first.text));
        if prompts.len() > 1 {
            out.push_str(&format!("\nLatest prompt: {}\n", prompts[prompts.len() - 1].text));
        }
        out.push('\n');
    } else if !run.last_prompt.is_empty() {
        out.push_str(&format!("## What was asked\n\n{}\n\n", run.last_prompt));
    }
    if !run.tasks.is_empty() {
        out.push_str("## Plan\n\n");
        for t in &run.tasks {
            let mark = match t.status {
                TaskStatus::Done => "x",
                TaskStatus::InProgress => "~",
                TaskStatus::Pending => " ",
            };
            out.push_str(&format!("- [{mark}] {}\n", t.subject));
        }
        out.push_str("\n([~] was in progress.)\n\n");
    }
    let mut changed: Vec<&FileTouch> = run.files.values().filter(|f| f.edits + f.writes > 0).collect();
    changed.sort_by(|a, b| b.last.cmp(&a.last));
    if !changed.is_empty() {
        out.push_str("## Files it changed\n\n");
        for f in changed.iter().take(60) {
            out.push_str(&format!("- {} (+{} -{})\n", rel_path(&f.path, &run.cwd), f.added, f.removed));
        }
        if changed.len() > 60 {
            out.push_str(&format!("- and {} more\n", changed.len() - 60));
        }
        out.push('\n');
    }
    let fails: Vec<&CmdRun> = run.cmds.iter().rev().filter(|c| c.ok == Some(false)).take(8).collect();
    if !fails.is_empty() || !run.errors.is_empty() {
        out.push_str("## Open problems\n\n");
        for c in fails {
            out.push_str(&format!("- failed: `{}`\n", one_line(&c.cmd, 200)));
        }
        for e in run.errors.iter().rev().filter(|e| e.text.starts_with("api error")).take(3) {
            out.push_str(&format!("- {}\n", e.text));
        }
        out.push('\n');
    }
    // The full last reply; the event list only keeps a one-line copy.
    let reply = if run.last_reply.is_empty() { run.events.iter().rev().find(|e| e.kind == EvKind::Reply).map(|e| e.text.clone()).unwrap_or_default() } else { run.last_reply.clone() };
    if !reply.is_empty() {
        let body: String = reply.chars().take(6000).collect();
        out.push_str(&format!("## Its last reply\n\n{}\n", body.trim()));
    }
    out
}

pub fn dir() -> PathBuf {
    crate::config::state_dir().join("handoffs")
}

/// Writes the note under the state dir and returns its path.
pub fn write(run: &AgentRun, title: &str) -> Result<PathBuf, String> {
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let p = d.join(format!("{}-{}.md", short_id(&run.key.id), chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::write(&p, note(run, title)).map_err(|e| e.to_string())?;
    Ok(p)
}

/// The first prompt of the new session.
pub fn prompt(run: &AgentRun, note: &std::path::Path) -> String {
    format!(
        "You are picking up work from an earlier {} session. Read the handoff in {} first; it has the goal, the plan, the files changed and the open problems. Check the current state of those files, then continue where it left off. The old transcript is {} if you need more detail.",
        run.key.kind.label(),
        note.display(),
        run.path.display()
    )
}
