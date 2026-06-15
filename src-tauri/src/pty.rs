use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::Emitter;

use crate::project_context;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub id: String,
    pub command: String,
    pub status: String,
    pub output: String,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyEvent {
    pub id: String,
    pub command: String,
    pub kind: String,
    pub data: Option<String>,
    pub exit_code: Option<i32>,
}

/* keep the master pty alive on the handle so we can resize the kernel-side
tty after spawn. without this, programs that read $LINES/$COLUMNS or
handle SIGWINCH (vim, htop, claude, …) get stuck at the spawn-time
dimensions and clip badly when the panel is resized. */
pub struct PtyHandle {
    killer: Box<dyn ChildKiller + Send + Sync>,
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Clone, Default)]
pub struct PtyRegistry {
    sessions: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

#[tauri::command]
pub fn pty_spawn(
    command: String,
    cols: Option<u16>,
    rows: Option<u16>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyRegistry>,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let initial_size = PtySize {
        rows: rows.unwrap_or(30),
        cols: cols.unwrap_or(120),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = pty_system
        .openpty(initial_size)
        .map_err(|err| format!("failed to open pty: {err}"))?;

    let (program, args) = launcher(&command);
    let mut builder = CommandBuilder::new(program);
    for arg in args {
        builder.arg(arg);
    }
    builder.cwd(project_context::active_project_root()?);
    /* tell the spawned program it's running inside an ansi-capable
    terminal so curses/rich/etc. emit color and cursor codes. */
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    scrub_appimage_env(&mut builder);

    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|err| format!("failed to spawn pty command: {err}"))?;
    let pid = child.process_id();
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("failed to clone pty reader: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("failed to open pty writer: {err}"))?;
    let master = pair.master;
    let started = Instant::now();
    let id = format!("pty-{}-{}", now_ms(), started.elapsed().as_nanos());
    let killer = child.clone_killer();
    state
        .sessions
        .lock()
        .map_err(|_| "pty registry lock failed".to_string())?
        .insert(
            id.clone(),
            PtyHandle {
                killer,
                writer,
                master,
            },
        );
    let event_id = id.clone();
    let event_command = command.clone();
    let event_app = app.clone();
    let event_registry = state.inner().clone();
    let _ = app.emit(
        "polypore://pty-event",
        PtyEvent {
            id: id.clone(),
            command: command.clone(),
            kind: "started".to_string(),
            data: None,
            exit_code: None,
        },
    );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    /* keep raw bytes — xterm.js parses ansi/utf-8 itself.
                    lossy decoding here is only to ship through the
                    string-shaped event payload; xterm treats the
                    resulting replacement chars as literal text. */
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = event_app.emit(
                        "polypore://pty-event",
                        PtyEvent {
                            id: event_id.clone(),
                            command: event_command.clone(),
                            kind: "output".to_string(),
                            data: Some(data),
                            exit_code: None,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        if let Ok(mut sessions) = event_registry.sessions.lock() {
            sessions.remove(&event_id);
        }
        let _ = event_app.emit(
            "polypore://pty-event",
            PtyEvent {
                id: event_id,
                command: event_command,
                kind: "exited".to_string(),
                data: None,
                exit_code,
            },
        );
    });

    Ok(PtySession {
        id,
        command,
        status: "running".to_string(),
        output: String::new(),
        pid,
        exit_code: None,
    })
}

#[tauri::command]
pub fn pty_stop(id: String, state: tauri::State<'_, PtyRegistry>) -> Result<bool, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "pty registry lock failed".to_string())?;
    let Some(mut handle) = sessions.remove(&id) else {
        return Ok(false);
    };
    handle
        .killer
        .kill()
        .map_err(|err| format!("failed to stop pty {id}: {err}"))?;
    Ok(true)
}

#[tauri::command]
pub fn pty_write(
    id: String,
    data: String,
    state: tauri::State<'_, PtyRegistry>,
) -> Result<bool, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "pty registry lock failed".to_string())?;
    let Some(handle) = sessions.get_mut(&id) else {
        return Ok(false);
    };
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|err| format!("failed to write to pty {id}: {err}"))?;
    handle
        .writer
        .flush()
        .map_err(|err| format!("failed to flush pty {id}: {err}"))?;
    Ok(true)
}

#[tauri::command]
pub fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    state: tauri::State<'_, PtyRegistry>,
) -> Result<bool, String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "pty registry lock failed".to_string())?;
    let Some(handle) = sessions.get(&id) else {
        return Ok(false);
    };
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("failed to resize pty {id}: {err}"))?;
    Ok(true)
}

/* decide what to actually launch inside the pty.
- empty command → spawn an interactive login shell so the user gets a
  real $SHELL session and can type any command they want (claude, vim,
  htop, …) just like a system terminal.
- non-empty command → wrap with `$SHELL -i -l -c <cmd>` so one-shot
  launches ("git status", "npm run dev", "codex") still work; the
  spawned process gets a real pty regardless, so its ansi output renders
  correctly. interactive + login matters: agent CLIs commonly live in
  dirs (~/.local/bin, npm globals, version-manager shims) that only the
  user's rc files put on PATH — a bare `sh -lc` skips those and the
  panel dies with "codex: command not found". */
fn launcher(command: &str) -> (String, Vec<String>) {
    if cfg!(target_os = "windows") {
        if command.trim().is_empty() {
            return ("cmd.exe".to_string(), vec![]);
        }
        return (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), command.to_string()],
        );
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "bash".to_string());
    if command.trim().is_empty() {
        /* -l so the shell sources the user's login profile and the user
        sees their familiar prompt + aliases. */
        return (shell, vec!["-l".to_string()]);
    }
    (
        shell,
        vec![
            "-i".to_string(),
            "-l".to_string(),
            "-c".to_string(),
            command.to_string(),
        ],
    )
}

/* when polypore runs as a linux AppImage, its AppRun injects bundle paths
into the environment (LD_LIBRARY_PATH, GTK_PATH, GST_PLUGIN_*, …) so the
shipped binary resolves its own libraries. those vars are inherited by every
child we spawn — and a child that itself links GTK/WebKit (e.g. `tauri dev`
launching a dev build of polypore) then loads the *bundle's* libraries and
dies looking for a helper that only exists relative to the AppImage mount
("Failed to spawn child process …/WebKitNetworkProcess"). strip the bundle
injections so children resolve system libraries instead. no-op off AppImage. */
fn scrub_appimage_env(builder: &mut CommandBuilder) {
    let appdir = match std::env::var("APPDIR") {
        Ok(dir) if !dir.is_empty() => dir,
        _ => return,
    };

    /* colon-separated search paths: drop the segments that point into the
    AppImage mount, keep any the user set themselves. */
    const PATH_LISTS: &[&str] = &[
        "LD_LIBRARY_PATH",
        "PATH",
        "XDG_DATA_DIRS",
        "GTK_PATH",
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GIO_EXTRA_MODULES",
        "GDK_PIXBUF_MODULEDIR",
        "FONTCONFIG_PATH",
        "LIBGL_DRIVERS_PATH",
        "GSETTINGS_SCHEMA_DIR",
    ];
    for key in PATH_LISTS {
        let Some(val) = std::env::var_os(key) else { continue };
        let kept: Vec<_> = std::env::split_paths(&val)
            .filter(|p| !p.starts_with(&appdir))
            .collect();
        if kept.is_empty() {
            builder.env_remove(key);
        } else if let Ok(joined) = std::env::join_paths(kept) {
            builder.env(key, joined);
        }
    }

    /* single-value pointers into the bundle: remove outright. */
    const SINGLES: &[&str] = &[
        "GDK_PIXBUF_MODULE_FILE",
        "GIO_MODULE_DIR",
        "GST_PLUGIN_SCANNER",
        "WEBKIT_EXEC_PATH",
        "FONTCONFIG_FILE",
    ];
    for key in SINGLES {
        let Some(val) = std::env::var_os(key) else { continue };
        if std::path::Path::new(&val).starts_with(&appdir) {
            builder.env_remove(key);
        }
    }
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
