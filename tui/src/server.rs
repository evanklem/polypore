//! The terminal server: a small background process that owns every pty, so
//! closing (or crashing) the dashboard leaves agents running. The dashboard
//! and the CLI talk to it over a unix socket in the runtime dir.
//!
//! Frames are `u32 length | u8 tag | u64 pane | payload`. Terminal bytes
//! travel raw; everything else is JSON. The server keeps its own vt100 copy
//! of each screen, answers the terminal's queries (cursor position, device
//! attributes) and replays the screen to whoever attaches.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::model::{RunKey, now_ms};
use crate::pane::{Cb, PaneKind, PaneMsg, SpawnSpec};

pub const PROTO: u32 = 1;

const SPAWN: u8 = 1;
const ATTACH: u8 = 2;
const INPUT: u8 = 3;
const RESIZE: u8 = 4;
const KILL: u8 = 5;
const LIST: u8 = 6;
const DETACH: u8 = 7;
const META: u8 = 8;
const HELLO: u8 = 9;
const PROMPT: u8 = 10;
const SPAWNED: u8 = 101;
const SNAPSHOT: u8 = 102;
const OUTPUT: u8 = 103;
const EXITED: u8 = 104;
const LISTED: u8 = 106;
const HELLOED: u8 = 109;
const ERROR: u8 = 110;
const DONE: u8 = 111;

/// What the dashboard knows about a pane, kept by the server so the CLI and
/// the next dashboard can say what each terminal is.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Meta {
    pub project: String,
    pub name: String,
    pub run: Option<RunKey>,
    /// Workspace the dashboard keeps this pane in, so a pane started by the
    /// CLI can be adopted into its own workspace.
    #[serde(default)]
    pub workspace: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SpawnReq {
    pub spec: SpawnSpec,
    pub rows: u16,
    pub cols: u16,
    /// Typed into the terminal right after it starts (an agent command).
    pub typed: Option<String>,
    pub meta: Meta,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PaneInfo {
    pub id: u64,
    pub pid: Option<u32>,
    pub kind: PaneKind,
    pub cwd: String,
    pub exited: Option<u32>,
    pub rows: u16,
    pub cols: u16,
    pub meta: Meta,
    pub created: i64,
    pub scrubbed: bool,
    pub attached: usize,
    pub last_output: i64,
}

impl PaneInfo {
    pub fn kind_label(&self) -> &'static str {
        match self.kind {
            PaneKind::Claude => "claude",
            PaneKind::Codex => "codex",
            PaneKind::Shell => "terminal",
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct Snap {
    pub info: PaneInfo,
    pub kitty: u16,
    pub screen: String,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    proto: u32,
    version: String,
    pid: u32,
}

pub fn socket_path() -> PathBuf {
    #[cfg(unix)]
    let uid = unsafe { libc::getuid() };
    #[cfg(not(unix))]
    let uid = 0;
    // Unix socket paths are limited to about 100 bytes.
    let base = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_dir() && p.as_os_str().len() < 80)
        .map(|p| p.join("polypore"))
        .unwrap_or_else(|| PathBuf::from("/tmp").join(format!("polypore-{uid}")));
    let _ = std::fs::create_dir_all(&base);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700));
    }
    base.join("server.sock")
}

/// The socket's folder must be ours alone: in a shared /tmp another user
/// could otherwise put a fake server there and read everything typed.
#[cfg(unix)]
fn check_private(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::getuid() };
    let dir = path.parent().ok_or("no socket folder")?;
    let md = std::fs::symlink_metadata(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !md.is_dir() || md.uid() != uid || md.mode() & 0o077 != 0 {
        return Err(format!("{} is not a private folder owned by you; refusing to use it for the terminal server", dir.display()));
    }
    if let Ok(sm) = std::fs::symlink_metadata(path) {
        if sm.uid() != uid {
            return Err(format!("{} belongs to someone else", path.display()));
        }
    }
    Ok(())
}

fn write_frame(w: &mut impl Write, tag: u8, pane: u64, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&frame(tag, pane, payload))?;
    w.flush()
}

fn frame(tag: u8, pane: u64, payload: &[u8]) -> Vec<u8> {
    let mut b = Vec::with_capacity(13 + payload.len());
    b.extend(((9 + payload.len()) as u32).to_be_bytes());
    b.push(tag);
    b.extend(pane.to_be_bytes());
    b.extend(payload);
    b
}

fn read_frame(r: &mut impl Read) -> std::io::Result<(u8, u64, Vec<u8>)> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if !(9..=64 << 20).contains(&len) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "bad frame"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    let tag = body[0];
    let pane = u64::from_be_bytes(body[1..9].try_into().unwrap());
    Ok((tag, pane, body[9..].to_vec()))
}

#[cfg(all(test, unix))]
pub fn check_private_pub(path: &std::path::Path) -> Result<(), String> {
    check_private(path)
}

#[cfg(test)]
pub fn frame_pub(tag: u8, pane: u64, payload: &[u8]) -> Vec<u8> {
    frame(tag, pane, payload)
}

#[cfg(test)]
pub fn read_frame_pub(r: &mut impl Read) -> std::io::Result<(u8, u64, Vec<u8>)> {
    read_frame(r)
}

// ---------------------------------------------------------------- server

struct SPane {
    info: PaneInfo,
    parser: vt100::Parser<Cb>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    subs: HashSet<u64>,
}

struct Client {
    tx: Sender<Vec<u8>>,
    pending: Arc<AtomicUsize>,
}

#[derive(Default)]
struct Server {
    panes: Mutex<HashMap<u64, Arc<Mutex<SPane>>>>,
    clients: Mutex<HashMap<u64, Client>>,
    next_pane: AtomicU64,
    next_client: AtomicU64,
}

impl Server {
    fn send(&self, client: u64, bytes: Vec<u8>) {
        let mut clients = self.clients.lock().unwrap();
        let Some(c) = clients.get(&client) else { return };
        // A client that stopped reading (suspended, wedged) must not stall
        // the agents: past 64 MB queued it is dropped.
        let n = c.pending.fetch_add(bytes.len(), Ordering::SeqCst) + bytes.len();
        if n > 64 << 20 || c.tx.send(bytes).is_err() {
            clients.remove(&client);
        }
    }

    fn snapshot(p: &SPane) -> Snap {
        let s = p.parser.screen();
        let mut screen = String::new();
        if s.alternate_screen() {
            screen.push_str("\x1b[?1049h");
        }
        screen.push_str(&s.state_formatted());
        let mut info = p.info.clone();
        info.attached = p.subs.len();
        Snap { info, kitty: p.parser.callbacks().kitty(), screen }
    }

    fn spawn(self: &Arc<Self>, req: SpawnReq) -> Result<PaneInfo, String> {
        // Ids keep counting across server restarts, so a saved workspace
        // never mistakes a new terminal for the one it remembers.
        let id = self.next_pane.fetch_add(1, Ordering::SeqCst) + 1;
        let _ = std::fs::write(counter_path(), id.to_string());
        let (rows, cols) = (req.rows.max(2), req.cols.max(10));
        let pty = crate::pane::open_pty(id, &req.spec, rows, cols).map_err(|e| e.to_string())?;
        let crate::pane::Pty { master, mut writer, mut reader, child } = pty;
        if let Some(t) = &req.typed {
            let _ = writer.write_all(t.as_bytes());
            let _ = writer.flush();
        }
        let info = PaneInfo {
            id,
            pid: child.process_id(),
            kind: req.spec.kind,
            cwd: req.spec.cwd.clone(),
            exited: None,
            rows,
            cols,
            meta: req.meta,
            created: now_ms(),
            scrubbed: req.spec.scrubbed,
            attached: 0,
            last_output: now_ms(),
        };
        let cb = Cb { size: (rows, cols), ..Default::default() };
        let parser = vt100::Parser::new_with_callbacks(nz(rows), nz(cols), 2000, cb);
        let pane = Arc::new(Mutex::new(SPane { info: info.clone(), parser, master, writer, child, subs: HashSet::new() }));
        self.panes.lock().unwrap().insert(id, pane.clone());
        let me = self.clone();
        std::thread::Builder::new()
            .name(format!("srv-pty-{id}"))
            .spawn(move || {
                let mut buf = [0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut p = pane.lock().unwrap();
                            p.parser.process(&buf[..n]);
                            let resp = std::mem::take(&mut p.parser.callbacks_mut().responses);
                            if !resp.is_empty() {
                                let _ = p.writer.write_all(&resp);
                                let _ = p.writer.flush();
                            }
                            // The notification fields only matter to attached clients,
                            // which parse the same bytes; drop them here.
                            let cb = p.parser.callbacks_mut();
                            cb.notify = None;
                            cb.clipboard = None;
                            cb.bell = false;
                            p.info.last_output = now_ms();
                            // Sent while holding the pane, so an attach never sees
                            // these bytes both in its snapshot and as output.
                            let f = frame(OUTPUT, id, &buf[..n]);
                            for s in p.subs.clone() {
                                me.send(s, f.clone());
                            }
                        }
                    }
                }
                // Poll for the exit status without holding the pane, in case
                // the process lingers after closing its terminal.
                let code = loop {
                    if let Ok(Some(s)) = pane.lock().unwrap().child.try_wait() {
                        break s.exit_code();
                    }
                    std::thread::sleep(Duration::from_millis(100));
                };
                let mut p = pane.lock().unwrap();
                p.info.exited = Some(code);
                let f = frame(EXITED, id, code.to_string().as_bytes());
                for s in p.subs.clone() {
                    me.send(s, f.clone());
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(info)
    }

    fn handle(self: &Arc<Self>, client: u64, tag: u8, pane: u64, body: &[u8]) {
        let get = |id: u64| self.panes.lock().unwrap().get(&id).cloned();
        let err = |msg: &str| self.send(client, frame(ERROR, pane, msg.as_bytes()));
        match tag {
            HELLO => {
                let h = Hello { proto: PROTO, version: env!("CARGO_PKG_VERSION").into(), pid: std::process::id() };
                self.send(client, frame(HELLOED, 0, &serde_json::to_vec(&h).unwrap_or_default()));
            }
            SPAWN => match serde_json::from_slice::<SpawnReq>(body).map_err(|e| e.to_string()).and_then(|r| self.spawn(r)) {
                Ok(info) => self.send(client, frame(SPAWNED, info.id, &serde_json::to_vec(&info).unwrap_or_default())),
                Err(e) => err(&e),
            },
            ATTACH => match get(pane) {
                Some(p) => {
                    let mut p = p.lock().unwrap();
                    p.subs.insert(client);
                    let snap = Self::snapshot(&p);
                    self.send(client, frame(SNAPSHOT, pane, &serde_json::to_vec(&snap).unwrap_or_default()));
                    if let Some(code) = p.info.exited {
                        self.send(client, frame(EXITED, pane, code.to_string().as_bytes()));
                    }
                }
                None => err("no such terminal"),
            },
            INPUT => {
                if let Some(p) = get(pane) {
                    let mut p = p.lock().unwrap();
                    let _ = p.writer.write_all(body);
                    let _ = p.writer.flush();
                }
            }
            RESIZE => {
                #[derive(Deserialize)]
                struct R {
                    rows: u16,
                    cols: u16,
                }
                if let (Some(p), Ok(r)) = (get(pane), serde_json::from_slice::<R>(body)) {
                    let mut p = p.lock().unwrap();
                    let (rows, cols) = (r.rows.max(2), r.cols.max(10));
                    if (p.info.rows, p.info.cols) != (rows, cols) {
                        p.info.rows = rows;
                        p.info.cols = cols;
                        p.parser.screen_mut().set_size(nz(rows), nz(cols));
                        p.parser.callbacks_mut().size = (rows, cols);
                        let _ = p.master.resize(portable_pty::PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                    }
                }
            }
            KILL => {
                let removed = self.panes.lock().unwrap().remove(&pane);
                if let Some(p) = removed {
                    let mut p = p.lock().unwrap();
                    if p.info.exited.is_none() {
                        let _ = p.child.kill();
                    }
                }
                self.send(client, frame(DONE, pane, b""));
            }
            DETACH => {
                if let Some(p) = get(pane) {
                    p.lock().unwrap().subs.remove(&client);
                }
            }
            PROMPT => match get(pane) {
                // Paste the text the way the program asked for pastes, then
                // press enter a moment later so it is not read as part of it.
                Some(p) => {
                    let mut g = p.lock().unwrap();
                    let text = String::from_utf8_lossy(body).trim_end_matches(['\n', '\r']).to_string();
                    let bytes = if g.parser.screen().bracketed_paste() {
                        format!("\x1b[200~{text}\x1b[201~").into_bytes()
                    } else {
                        text.replace('\n', "\r").into_bytes()
                    };
                    let _ = g.writer.write_all(&bytes);
                    let _ = g.writer.flush();
                    drop(g);
                    let p = p.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(180));
                        let mut g = p.lock().unwrap();
                        let _ = g.writer.write_all(b"\r");
                        let _ = g.writer.flush();
                    });
                    self.send(client, frame(DONE, pane, b""));
                }
                None => err("no such terminal"),
            },
            META => {
                if let (Some(p), Ok(m)) = (get(pane), serde_json::from_slice::<Meta>(body)) {
                    p.lock().unwrap().info.meta = m;
                }
            }
            LIST => {
                let panes: Vec<Arc<Mutex<SPane>>> = self.panes.lock().unwrap().values().cloned().collect();
                let mut v: Vec<PaneInfo> = panes
                    .iter()
                    .map(|p| {
                        let p = p.lock().unwrap();
                        let mut i = p.info.clone();
                        i.attached = p.subs.len();
                        i
                    })
                    .collect();
                v.sort_by_key(|i| i.id);
                self.send(client, frame(LISTED, 0, &serde_json::to_vec(&v).unwrap_or_default()));
            }
            _ => err("unknown request"),
        }
    }

    fn drop_client(&self, client: u64) {
        self.clients.lock().unwrap().remove(&client);
        for p in self.panes.lock().unwrap().values() {
            p.lock().unwrap().subs.remove(&client);
        }
    }

    fn live_panes(&self) -> usize {
        self.panes.lock().unwrap().values().filter(|p| p.lock().unwrap().info.exited.is_none()).count()
    }
}

/// `polypore server`: runs until no terminal is left running and nobody has
/// been connected for a minute.
#[cfg(unix)]
pub fn serve() -> anyhow::Result<()> {
    use std::os::unix::net::UnixListener;
    let path = socket_path();
    check_private(&path).map_err(|e| anyhow::anyhow!(e))?;
    if std::os::unix::net::UnixStream::connect(&path).is_ok() {
        anyhow::bail!("a polypore server is already running at {}", path.display());
    }
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let _ = std::fs::write(crate::config::state_dir().join("server.pid"), std::process::id().to_string());
    let srv = Arc::new(Server::default());
    let last: u64 = std::fs::read_to_string(counter_path()).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
    srv.next_pane.store(last, Ordering::SeqCst);
    let idle_since = Arc::new(Mutex::new(Instant::now()));
    {
        let srv = srv.clone();
        let idle_since = idle_since.clone();
        let path = path.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(5));
                let busy = srv.live_panes() > 0 || !srv.clients.lock().unwrap().is_empty();
                let mut idle = idle_since.lock().unwrap();
                if busy {
                    *idle = Instant::now();
                } else if idle.elapsed() > Duration::from_secs(60) {
                    // Only remove the socket if it is still ours.
                    let _ = std::fs::remove_file(&path);
                    std::process::exit(0);
                }
            }
        });
    }
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let client = srv.next_client.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let pending = Arc::new(AtomicUsize::new(0));
        srv.clients.lock().unwrap().insert(client, Client { tx, pending: pending.clone() });
        let Ok(mut wstream) = stream.try_clone() else { continue };
        std::thread::spawn(move || {
            for b in rx {
                pending.fetch_sub(b.len(), Ordering::SeqCst);
                if wstream.write_all(&b).is_err() {
                    break;
                }
            }
        });
        let srv = srv.clone();
        std::thread::spawn(move || {
            let mut r = stream;
            while let Ok((tag, pane, body)) = read_frame(&mut r) {
                srv.handle(client, tag, pane, &body);
            }
            srv.drop_client(client);
        });
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn serve() -> anyhow::Result<()> {
    anyhow::bail!("the terminal server needs unix sockets")
}

fn counter_path() -> PathBuf {
    crate::config::state_dir().join("server.next")
}

fn nz(v: u16) -> core::num::NonZeroU16 {
    core::num::NonZeroU16::new(v.max(1)).unwrap()
}

// ---------------------------------------------------------------- client

/// A connection to the terminal server.
pub struct Conn {
    #[cfg(unix)]
    w: Mutex<std::os::unix::net::UnixStream>,
    routes: Arc<Mutex<HashMap<u64, Sender<PaneMsg>>>>,
    replies: Mutex<Receiver<(u8, u64, Vec<u8>)>>,
    pub alive: Arc<AtomicBool>,
    pub server_version: String,
}

impl Conn {
    /// Connects, starting the server first when `start` is set and none is
    /// running.
    #[cfg(unix)]
    pub fn connect(start: bool) -> Result<Arc<Conn>, String> {
        use std::os::unix::net::UnixStream;
        let path = socket_path();
        check_private(&path)?;
        let stream = match UnixStream::connect(&path) {
            Ok(s) => s,
            Err(_) if start => {
                start_server()?;
                let t = Instant::now();
                loop {
                    match UnixStream::connect(&path) {
                        Ok(s) => break s,
                        Err(e) if t.elapsed() > Duration::from_secs(3) => return Err(format!("terminal server did not start: {e}")),
                        Err(_) => std::thread::sleep(Duration::from_millis(30)),
                    }
                }
            }
            Err(e) => return Err(format!("no terminal server running ({e})")),
        };
        let mut reader = stream.try_clone().map_err(|e| e.to_string())?;
        let routes: Arc<Mutex<HashMap<u64, Sender<PaneMsg>>>> = Arc::new(Mutex::new(HashMap::new()));
        let (rtx, rrx) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let routes = routes.clone();
            let alive = alive.clone();
            std::thread::Builder::new()
                .name("polypore-conn".into())
                .spawn(move || {
                    while let Ok((tag, pane, body)) = read_frame(&mut reader) {
                        match tag {
                            OUTPUT => {
                                if let Some(tx) = routes.lock().unwrap().get(&pane) {
                                    let _ = tx.send(PaneMsg::Data(body));
                                }
                            }
                            EXITED => {
                                let code = String::from_utf8_lossy(&body).parse().unwrap_or(0);
                                if let Some(tx) = routes.lock().unwrap().get(&pane) {
                                    let _ = tx.send(PaneMsg::Exit(code));
                                }
                            }
                            _ => {
                                let _ = rtx.send((tag, pane, body));
                            }
                        }
                    }
                    alive.store(false, Ordering::SeqCst);
                    for tx in routes.lock().unwrap().values() {
                        let _ = tx.send(PaneMsg::Lost);
                    }
                })
                .map_err(|e| e.to_string())?;
        }
        let mut c = Conn { w: Mutex::new(stream), routes, replies: Mutex::new(rrx), alive, server_version: String::new() };
        let (_, _, body) = c.request(HELLO, 0, b"", &[HELLOED])?;
        let h: Hello = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        if h.proto != PROTO {
            return Err(format!("the running terminal server speaks protocol {} (this polypore speaks {PROTO}); close its terminals or restart it", h.proto));
        }
        c.server_version = h.version;
        Ok(Arc::new(c))
    }

    #[cfg(not(unix))]
    pub fn connect(_start: bool) -> Result<Arc<Conn>, String> {
        Err("the terminal server needs unix sockets".into())
    }

    fn send(&self, tag: u8, pane: u64, body: &[u8]) -> Result<(), String> {
        #[cfg(unix)]
        {
            let mut w = self.w.lock().unwrap();
            write_frame(&mut *w, tag, pane, body).map_err(|e| e.to_string())
        }
        #[cfg(not(unix))]
        {
            let _ = (tag, pane, body);
            Err("no server".into())
        }
    }

    fn request(&self, tag: u8, pane: u64, body: &[u8], want: &[u8]) -> Result<(u8, u64, Vec<u8>), String> {
        let replies = self.replies.lock().unwrap();
        // Anything left over from a request that timed out is stale.
        while replies.try_recv().is_ok() {}
        self.send(tag, pane, body)?;
        let deadline = Instant::now() + Duration::from_secs(4);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match replies.recv_timeout(left) {
                Ok((ERROR, _, b)) => return Err(String::from_utf8_lossy(&b).to_string()),
                Ok(r) if want.contains(&r.0) => return Ok(r),
                Ok(_) => continue,
                Err(_) => return Err("the terminal server did not answer".into()),
            }
        }
    }

    pub fn spawn(&self, req: &SpawnReq) -> Result<PaneInfo, String> {
        let (_, _, body) = self.request(SPAWN, 0, &serde_json::to_vec(req).map_err(|e| e.to_string())?, &[SPAWNED])?;
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }

    pub fn attach(&self, id: u64) -> Result<(Snap, Receiver<PaneMsg>), String> {
        let (tx, rx) = mpsc::channel();
        self.routes.lock().unwrap().insert(id, tx);
        match self.request(ATTACH, id, b"", &[SNAPSHOT]) {
            Ok((_, _, body)) => Ok((serde_json::from_slice(&body).map_err(|e| e.to_string())?, rx)),
            Err(e) => {
                self.routes.lock().unwrap().remove(&id);
                Err(e)
            }
        }
    }

    pub fn list(&self) -> Result<Vec<PaneInfo>, String> {
        let (_, _, body) = self.request(LIST, 0, b"", &[LISTED])?;
        serde_json::from_slice(&body).map_err(|e| e.to_string())
    }

    /// Types a prompt into a terminal and presses enter.
    pub fn prompt(&self, id: u64, text: &str) -> Result<(), String> {
        self.request(PROMPT, id, text.as_bytes(), &[DONE]).map(|_| ())
    }

    pub fn input(&self, id: u64, bytes: &[u8]) {
        let _ = self.send(INPUT, id, bytes);
    }

    pub fn resize(&self, id: u64, rows: u16, cols: u16) {
        let _ = self.send(RESIZE, id, format!("{{\"rows\":{rows},\"cols\":{cols}}}").as_bytes());
    }

    pub fn kill(&self, id: u64) {
        self.routes.lock().unwrap().remove(&id);
        let _ = self.request(KILL, id, b"", &[DONE]);
    }

    pub fn detach(&self, id: u64) {
        self.routes.lock().unwrap().remove(&id);
        let _ = self.send(DETACH, id, b"");
    }

    pub fn set_meta(&self, id: u64, meta: &Meta) {
        if let Ok(b) = serde_json::to_vec(meta) {
            let _ = self.send(META, id, &b);
        }
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }
}

/// Starts `polypore server` in its own session, detached from this terminal.
#[cfg(unix)]
fn start_server() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(crate::config::state_dir().join("server.log")).ok();
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("server").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null());
    match log {
        Some(f) => cmd.stderr(f),
        None => cmd.stderr(std::process::Stdio::null()),
    };
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // The server must not keep the dashboard's secret-free or secret-full
    // env choices; each pane gets its own env from its spawn request.
    cmd.spawn().map(|_| ()).map_err(|e| format!("could not start the terminal server: {e}"))
}
