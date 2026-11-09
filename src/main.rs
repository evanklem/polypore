mod analysis;
mod anim;
mod app;
mod art;
mod cli;
mod config;
mod keys;
mod layout;
mod mcp;
mod handoff;
mod hunks;
mod meta;
mod model;
mod notify;
mod pane;
mod procs;
mod review;
mod quota;
mod server;
mod worktree;
mod secrets;
mod search;
mod skills;
mod sleep;
mod sources;
mod wake;
mod stats_view;
mod store;
mod theme;
mod tree;
mod ui;
#[cfg(test)]
mod tests;

use ratatui::crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture, KeyboardEnhancementFlags,
    PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::supports_keyboard_enhancement;

const HELP: &str = "polypore: a terminal dashboard for claude and codex sessions

usage:
  polypore                 open the dashboard
  polypore ls [--all] [--json] [--project P]
                           sessions that are open (and closed ones with --all)
  polypore send ID TEXT    type a prompt into a session (waits for its turn to end;
                           resumes a closed session in a polypore terminal)
  polypore watch [--json] [--hooks]
                           print a line each time a session changes state
  polypore run -- CMD...   run your own command with this project's secrets injected
  polypore mcp             stdio MCP server for agents (secrets_list, secrets_exec, secrets_http)
  polypore doctor          show what polypore can see on this machine
  polypore server          the background terminal server (started on its own)
  polypore --version

files:
  ~/.config/polypore/config.toml   themes, borders, gaps, animations, prefix key, agents
  ~/.config/polypore/layouts/      focus layouts (default.toml, per-project copies)
  ~/.config/polypore/anims/        custom ASCII animations (<name>.txt, frames split by ---)
  ~/.config/polypore/secrets.toml  secret names and allowlists (values live in the OS keyring)
  ~/.local/state/polypore/         index cache, saved workspaces, analysis reports

inside the dashboard press ? for keys.";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    #[cfg(unix)]
    if !args.is_empty() {
        // CLI subcommands behave like normal unix tools when piped into head.
        unsafe {
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
        }
    }
    let code = match args.first().map(|s| s.as_str()) {
        Some("-h") | Some("--help") | Some("help") => {
            println!("{HELP}");
            0
        }
        Some("-V") | Some("--version") => {
            println!("polypore {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("mcp") => match mcp::serve() {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("polypore mcp: {e}");
                1
            }
        },
        Some("run") => match mcp::run(&args[1..]) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("polypore run: {e}");
                1
            }
        },
        Some("doctor") => doctor(),
        Some("ls") => cli::ls(&args[1..]),
        Some("send") => cli::send(&args[1..]),
        Some("watch") => cli::watch(&args[1..]),
        Some("server") => match server::serve() {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("polypore server: {e}");
                1
            }
        },
        Some("inspect") => inspect(args.get(1).map(|s| s.as_str()).unwrap_or("")),
        Some(other) => {
            eprintln!("unknown command {other}\n\n{HELP}");
            2
        }
        None => match tui() {
            Ok(_) => 0,
            Err(e) => {
                eprintln!("polypore: {e}");
                1
            }
        },
    };
    std::process::exit(code);
}

fn tui() -> anyhow::Result<()> {
    let (cfg, err) = config::Config::load();
    let mut terminal = ratatui::init();
    let mut out = std::io::stdout();
    let _ = execute!(out, EnableMouseCapture, EnableBracketedPaste);
    let kitty = supports_keyboard_enhancement().unwrap_or(false);
    if kitty {
        let _ = execute!(out, PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES));
    }
    let mut app = app::App::new(cfg, err);
    app.outer_kitty = kitty;
    let res = app.run(&mut terminal);
    let running = app.running_in_server();
    drop(app);
    if kitty {
        let _ = execute!(out, PopKeyboardEnhancementFlags);
    }
    let _ = execute!(out, DisableMouseCapture, DisableBracketedPaste);
    ratatui::restore();
    if running > 0 {
        println!(
            "polypore: {running} terminal{} still running in the background; run polypore to get back to {}.",
            if running == 1 { " is" } else { "s are" },
            if running == 1 { "it" } else { "them" }
        );
    }
    res
}

fn doctor() -> i32 {
    let (cfg, err) = config::Config::load();
    println!("polypore {}", env!("CARGO_PKG_VERSION"));
    println!("config      {}{}", config::display_path(&config::config_path()), err.map(|e| format!("  ({e})")).unwrap_or_default());
    println!("state       {}", config::display_path(&config::state_dir()));
    let count = |dir: std::path::PathBuf| -> usize {
        let mut n = 0;
        let mut stack = vec![dir];
        while let Some(d) = stack.pop() {
            if let Ok(rd) = std::fs::read_dir(&d) {
                for e in rd.flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                        n += 1;
                    }
                }
            }
        }
        n
    };
    println!("claude      {} ({} transcripts)", config::display_path(&config::claude_dir()), count(config::claude_dir().join("projects")));
    println!("codex       {} ({} rollouts)", config::display_path(&config::codex_dir()), count(config::codex_dir().join("sessions")));
    let live = store::live_claude();
    println!("live claude {}", live.len());
    for l in &live {
        println!("            pid {} {} {}", l.pid, l.status, model::rel_path(&l.cwd, ""));
    }
    match server::Conn::connect(false) {
        Ok(c) => {
            let list = c.list().unwrap_or_default();
            let live = list.iter().filter(|p| p.exited.is_none()).count();
            println!("server      running (polypore {}), {live} terminal{}, {}", c.server_version, if live == 1 { "" } else { "s" }, server::socket_path().display());
        }
        Err(_) => println!("server      not running (starts with the dashboard)"),
    }
    for bin in ["claude", "codex", "git", "systemd-inhibit", "omarchy-toggle-idle", "notify-send", "curl"] {
        println!("{:<11} {}", bin, if sleep::which(bin) { "found" } else { "missing" });
    }
    match keyring::Entry::new("polypore", "doctor::probe").and_then(|e| e.get_password().map(|_| ()).or_else(|e| match e {
        keyring::Error::NoEntry => Ok(()),
        other => Err(other),
    })) {
        Ok(_) => println!("keyring     ok"),
        Err(e) => println!("keyring     unavailable: {e}"),
    }
    let (src, targets) = (config::expand(&cfg.skills.source), cfg.skills.targets.iter().map(|t| config::expand(t)).collect::<Vec<_>>());
    let inv = skills::inventory(&src, &targets, &Default::default());
    println!("skills      {} found, source {}", inv.len(), config::display_path(&src));
    0
}

/// Debug aid: fold one transcript and print the normalized summary.
fn inspect(path: &str) -> i32 {
    use model::*;
    let p = std::path::PathBuf::from(path);
    let kind = if path.contains("/.codex/") { AgentKind::Codex } else { AgentKind::Claude };
    let id = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut run = AgentRun::new(RunKey { kind, id }, p.clone());
    let mut cur = sources::claude::ClaudeCursor::default();
    let mut off = 0u64;
    let t = std::time::Instant::now();
    let _ = sources::tail_lines(&p, &mut off, |l| match kind {
        AgentKind::Claude => sources::claude::apply_line(&mut run, &mut cur, l),
        AgentKind::Codex => sources::codex::apply_line(&mut run, l),
    });
    if kind == AgentKind::Claude {
        sources::claude::refresh_now(&mut run);
    }
    let now = now_ms();
    println!("parsed {} bytes in {:?}", off, t.elapsed());
    println!("title      {}", run.display_title());
    println!("cwd        {}  branch {}  model {}  effort {}  mode {}", run.cwd, run.branch, run.model, run.effort, run.permission_mode);
    println!("state      {:?}  turn_open {}  turns {}  now: {}", run.state(now), run.turn_open, run.turns, run.now);
    let (d, n) = run.tasks_done();
    println!("tasks      {d}/{n}  goal: {}", run.goal);
    for task in run.tasks.iter().take(8) {
        println!("           {:?} {}", task.status, one_line(&task.subject, 70));
    }
    println!("files      {} touched", run.files.len());
    for f in run.recent_files(5) {
        println!("           r{} e{} w{} +{} -{} {}", f.reads, f.edits, f.writes, f.added, f.removed, rel_path(&f.path, &run.cwd));
    }
    println!("web        {}  cmds {} ({} failed)  subagents {}  errors {}", run.web.len(), run.cmds.len(), run.cmds.iter().filter(|c| c.ok == Some(false)).count(), run.subagents.len(), run.errors.len());
    println!("ctx        {:?}% of {}  tokens in {} out {} cache {}  cost ${:.2}  compactions {}", run.ctx_percent().map(|p| p.round()), run.ctx_window, run.tokens_in, run.tokens_out, run.tokens_cache_read, run.cost_usd, run.compactions);
    println!("thinking   {} blocks, {} ms, last: {}", run.thinking_count, run.thinking_ms, one_line(&run.last_reasoning, 60));
    println!("events     {}  question {:?}  approval {:?}", run.events.len(), run.question, run.approval);
    if let Some(r) = &run.rate_limits {
        println!("limits     {:?}", r.primary.as_ref().map(|w| (w.used_percent, w.window_minutes)));
    }
    0
}
