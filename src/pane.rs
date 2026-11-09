//! A terminal pane: a PTY running a shell or agent, emulated with vt100 and
//! drawn into a ratatui buffer.

use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::Instant;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};

use crate::model::{AgentKind, RunKey};

#[derive(Default)]
pub struct Cb {
    pub responses: Vec<u8>,
    pub bell: bool,
    pub notify: Option<String>,
    pub title: Option<String>,
    pub clipboard: Option<Vec<u8>>,
    pub cwd: Option<String>,
    pub kitty_flags: Vec<u16>,
    pub size: (u16, u16),
}

impl Cb {
    pub fn kitty(&self) -> u16 {
        self.kitty_flags.last().copied().unwrap_or(0)
    }
}

impl vt100::Callbacks for Cb {
    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.bell = true;
    }

    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.title = Some(String::from_utf8_lossy(title).to_string());
    }

    fn copy_to_clipboard(&mut self, _: &mut vt100::Screen, _ty: &[u8], data: &[u8]) {
        self.clipboard = Some(data.to_vec());
    }

    fn unhandled_csi(&mut self, screen: &mut vt100::Screen, i1: Option<u8>, _i2: Option<u8>, params: &[&[u16]], c: char) {
        let p0 = params.first().and_then(|p| p.first()).copied().unwrap_or(0);
        match (i1, c) {
            (None, 'n') if p0 == 6 => {
                let (r, col) = screen.cursor_position();
                self.responses.extend(format!("\x1b[{};{}R", r + 1, col + 1).bytes());
            }
            (Some(b'?'), 'n') if p0 == 6 => {
                let (r, col) = screen.cursor_position();
                self.responses.extend(format!("\x1b[?{};{}R", r + 1, col + 1).bytes());
            }
            (None, 'n') if p0 == 5 => self.responses.extend(b"\x1b[0n"),
            (None, 'c') => self.responses.extend(b"\x1b[?62;22c"),
            (Some(b'>'), 'c') => self.responses.extend(b"\x1b[>1;10;0c"),
            (Some(b'>'), 'q') => self.responses.extend(b"\x1bP>|polypore\x1b\\"),
            (Some(b'?'), 'u') => self.responses.extend(format!("\x1b[?{}u", self.kitty()).bytes()),
            (Some(b'>'), 'u') => {
                self.kitty_flags.push(p0);
                if self.kitty_flags.len() > 16 {
                    self.kitty_flags.remove(0);
                }
            }
            (Some(b'<'), 'u') => {
                for _ in 0..p0.max(1) {
                    self.kitty_flags.pop();
                }
            }
            (Some(b'='), 'u') => {
                let mode = params.get(1).and_then(|p| p.first()).copied().unwrap_or(1);
                let cur = self.kitty();
                let new = match mode {
                    2 => cur | p0,
                    3 => cur & !p0,
                    _ => p0,
                };
                if let Some(last) = self.kitty_flags.last_mut() {
                    *last = new;
                } else {
                    self.kitty_flags.push(new);
                }
            }
            (None, 't') if p0 == 18 => {
                self.responses.extend(format!("\x1b[8;{};{}t", self.size.0, self.size.1).bytes());
            }
            _ => {}
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        let Some(code) = params.first() else { return };
        let s = |i: usize| params.get(i).map(|p| String::from_utf8_lossy(p).to_string()).unwrap_or_default();
        match *code {
            b"9" => {
                // OSC 9;4 is a progress report in some terminals; ignore it.
                if s(1) != "4" {
                    self.notify = Some(s(1));
                }
            }
            b"777" if params.get(1) == Some(&b"notify".as_slice()) => {
                let title = s(2);
                let body = s(3);
                self.notify = Some(if body.is_empty() { title } else { format!("{title}: {body}") });
            }
            b"99" => self.notify = Some(s(params.len() - 1)),
            b"7" => {
                let uri = s(1);
                if let Some(rest) = uri.strip_prefix("file://") {
                    let path = rest.find('/').map(|i| &rest[i..]).unwrap_or(rest);
                    self.cwd = Some(percent_decode(path));
                }
            }
            b"10" | b"11" if params.get(1) == Some(&b"?".as_slice()) => {
                let rgb = if *code == b"10" { "c0c0/caca/f5f5" } else { "1a1a/1b1b/2626" };
                self.responses.extend(format!("\x1b]{};rgb:{rgb}\x1b\\", String::from_utf8_lossy(code)).bytes());
            }
            _ => {}
        }
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Shell,
    Claude,
    Codex,
}

impl PaneKind {
    pub fn agent(self) -> Option<AgentKind> {
        match self {
            PaneKind::Claude => Some(AgentKind::Claude),
            PaneKind::Codex => Some(AgentKind::Codex),
            PaneKind::Shell => None,
        }
    }
}

pub struct Pane {
    #[allow(dead_code)]
    pub id: u64,
    pub kind: PaneKind,
    pub cwd: String,
    pub parser: vt100::Parser<Cb>,
    backend: Backend,
    rx: Receiver<PaneMsg>,
    pub pid: Option<u32>,
    pub exited: Option<u32>,
    pub attention: Option<String>,
    pub last_output: Instant,
    pub run: Option<RunKey>,
    pub detected: Option<AgentKind>,
    /// What is running in the foreground (nvim, cargo, btop), if not the shell.
    pub fg: Option<String>,
    pub scrubbed: bool,
    pub scroll: usize,
    pub size: (u16, u16),
    pub created: i64,
    /// The pane's id in the terminal server, when the server owns it.
    pub server_id: Option<u64>,
    /// Bytes to write once this many ms have passed (a prompt's enter key
    /// goes a moment after its text, or TUIs read both as one paste).
    pub delayed: Vec<(Instant, Vec<u8>)>,
}

/// Where a pane's pty lives: in this process, or in the terminal server so
/// it outlives the dashboard.
enum Backend {
    Local { master: Box<dyn MasterPty + Send>, writer: Box<dyn Write + Send>, child: Box<dyn portable_pty::Child + Send + Sync> },
    Remote { conn: std::sync::Arc<crate::server::Conn>, id: u64 },
}

pub enum PaneMsg {
    Data(Vec<u8>),
    Exit(u32),
    /// The terminal server went away.
    Lost,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SpawnSpec {
    pub kind: PaneKind,
    pub cwd: String,
    pub argv: Vec<String>,
    pub env_set: Vec<(String, String)>,
    pub env_remove: Vec<String>,
    pub scrubbed: bool,
}

pub struct Pty {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub reader: Box<dyn Read + Send>,
    pub child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Starts `spec` on a fresh pty.
pub fn open_pty(id: u64, spec: &SpawnSpec, rows: u16, cols: u16) -> anyhow::Result<Pty> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 })?;
    let mut argv = spec.argv.clone();
    if argv.is_empty() {
        argv.push(default_shell());
    }
    let mut cmd = CommandBuilder::new(&argv[0]);
    for a in &argv[1..] {
        cmd.arg(a);
    }
    cmd.cwd(&spec.cwd);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "polypore");
    // claude (and other node CLIs, through supports-hyperlinks) only style
    // file paths and URLs as links, in blue, when they recognise the
    // terminal, and they do not know TERM_PROGRAM=polypore. The OSC 8
    // wrapper is dropped when the pane is parsed; the colour stays.
    if std::env::var_os("FORCE_HYPERLINK").is_none() {
        cmd.env("FORCE_HYPERLINK", "1");
    }
    cmd.env("POLYPORE", "1");
    cmd.env("POLYPORE_PANE", id.to_string());
    for k in &spec.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &spec.env_set {
        cmd.env(k, v);
    }
    let child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);
    let reader = pair.master.try_clone_reader()?;
    let writer = pair.master.take_writer()?;
    Ok(Pty { master: pair.master, writer, reader, child })
}

impl Pane {
    /// Starts a terminal. With a server connection the server owns the pty
    /// (and types `typed` into it); otherwise it lives in this process.
    pub fn spawn(
        id: u64,
        spec: SpawnSpec,
        rows: u16,
        cols: u16,
        conn: Option<&std::sync::Arc<crate::server::Conn>>,
        typed: Option<String>,
        meta: crate::server::Meta,
    ) -> anyhow::Result<Pane> {
        let rows = rows.max(2);
        let cols = cols.max(10);
        if let Some(conn) = conn {
            let info = conn.spawn(&crate::server::SpawnReq { spec: spec.clone(), rows, cols, typed: typed.clone(), meta }).map_err(|e| anyhow::anyhow!(e))?;
            return Pane::attach(id, conn, info.id);
        }
        let Pty { master, writer, mut reader, child } = open_pty(id, &spec, rows, cols)?;
        let pid = child.process_id();
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new().name(format!("pty-{id}")).spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(PaneMsg::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                        crate::wake::poke();
                    }
                }
            }
            crate::wake::poke();
        })?;
        let cb = Cb { size: (rows, cols), ..Default::default() };
        let parser = vt100::Parser::new_with_callbacks(nz(rows), nz(cols), 5000, cb);
        let mut p = Pane {
            id,
            kind: spec.kind,
            cwd: spec.cwd,
            parser,
            backend: Backend::Local { master, writer, child },
            rx,
            pid,
            exited: None,
            attention: None,
            last_output: Instant::now(),
            run: None,
            detected: spec.kind.agent(),
            fg: None,
            scrubbed: spec.scrubbed,
            scroll: 0,
            size: (rows, cols),
            created: crate::model::now_ms(),
            server_id: None,
            delayed: Vec::new(),
        };
        if let Some(t) = typed {
            p.write(t.as_bytes());
        }
        Ok(p)
    }

    /// Attaches to a terminal the server already runs: its screen as it is
    /// now, then everything it prints from here on.
    pub fn attach(id: u64, conn: &std::sync::Arc<crate::server::Conn>, server_id: u64) -> anyhow::Result<Pane> {
        let (snap, rx) = conn.attach(server_id).map_err(|e| anyhow::anyhow!(e))?;
        let info = snap.info;
        let (rows, cols) = (info.rows.max(2), info.cols.max(10));
        let cb = Cb { size: (rows, cols), kitty_flags: if snap.kitty > 0 { vec![snap.kitty] } else { Vec::new() }, ..Default::default() };
        let mut parser = vt100::Parser::new_with_callbacks(nz(rows), nz(cols), 5000, cb);
        parser.process(snap.screen.as_bytes());
        // The server answers terminal queries; replies the replay provoked here go nowhere.
        parser.callbacks_mut().responses.clear();
        Ok(Pane {
            id,
            kind: info.kind,
            cwd: info.cwd.clone(),
            parser,
            backend: Backend::Remote { conn: conn.clone(), id: server_id },
            rx,
            pid: info.pid,
            exited: info.exited,
            attention: None,
            last_output: Instant::now(),
            run: info.meta.run.clone(),
            detected: info.kind.agent(),
            fg: None,
            scrubbed: info.scrubbed,
            scroll: 0,
            size: (rows, cols),
            created: info.created,
            server_id: Some(server_id),
            delayed: Vec::new(),
        })
    }

    /// Drains PTY output. Returns true when anything changed on screen.
    pub fn pump(&mut self) -> bool {
        let mut changed = false;
        let mut budget = 64;
        loop {
            match self.rx.try_recv() {
                Ok(PaneMsg::Data(bytes)) => {
                    self.parser.process(&bytes);
                    changed = true;
                    self.last_output = Instant::now();
                    budget -= 1;
                    if budget == 0 {
                        break;
                    }
                }
                Ok(PaneMsg::Exit(code)) => {
                    self.exited = Some(code);
                    changed = true;
                }
                Ok(PaneMsg::Lost) => {
                    if self.exited.is_none() {
                        self.exited = Some(255);
                        self.attention = Some("the terminal server stopped".into());
                        changed = true;
                    }
                    break;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if self.exited.is_none() {
                        let code = match &mut self.backend {
                            Backend::Local { child, .. } => child.try_wait().ok().flatten().map(|s| s.exit_code()).unwrap_or(0),
                            Backend::Remote { .. } => 255,
                        };
                        self.exited = Some(code);
                        changed = true;
                    }
                    break;
                }
            }
        }
        if changed {
            let cb = self.parser.callbacks_mut();
            let resp = std::mem::take(&mut cb.responses);
            let cwd = cb.cwd.take();
            if let Some(cwd) = cwd {
                self.cwd = cwd;
            }
            // Only a local pty needs answers from here; the server answers its own.
            if let Backend::Local { writer, .. } = &mut self.backend {
                if !resp.is_empty() {
                    let _ = writer.write_all(&resp);
                    let _ = writer.flush();
                }
            }
        }
        if self.exited.is_none() {
            if let Backend::Local { child, .. } = &mut self.backend {
                if let Ok(Some(s)) = child.try_wait() {
                    self.exited = Some(s.exit_code());
                    changed = true;
                }
            }
        }
        if !self.delayed.is_empty() {
            let now = Instant::now();
            let due: Vec<Vec<u8>> = {
                let (due, keep): (Vec<_>, Vec<_>) = std::mem::take(&mut self.delayed).into_iter().partition(|(t, _)| *t <= now);
                self.delayed = keep;
                due.into_iter().map(|(_, b)| b).collect()
            };
            for b in due {
                self.write(&b);
            }
        }
        changed
    }

    pub fn take_signals(&mut self) -> (bool, Option<String>, Option<Vec<u8>>) {
        let cb = self.parser.callbacks_mut();
        let bell = std::mem::take(&mut cb.bell);
        (bell, cb.notify.take(), cb.clipboard.take())
    }

    pub fn title(&self) -> Option<&str> {
        self.parser.callbacks().title.as_deref().filter(|t| !t.is_empty())
    }

    pub fn write(&mut self, bytes: &[u8]) {
        if self.exited.is_some() {
            return;
        }
        if self.scroll > 0 {
            self.scroll = 0;
        }
        match &mut self.backend {
            Backend::Local { writer, .. } => {
                let _ = writer.write_all(bytes);
                let _ = writer.flush();
            }
            Backend::Remote { conn, id } => conn.input(*id, bytes),
        }
    }

    /// Types a prompt into an agent's input and presses enter a moment later.
    pub fn send_prompt(&mut self, text: &str) {
        let body = text.trim_end_matches(['\n', '\r']);
        if self.bracketed_paste() {
            let mut b = b"\x1b[200~".to_vec();
            b.extend(body.as_bytes());
            b.extend(b"\x1b[201~");
            self.write(&b);
        } else {
            self.write(body.replace('\n', "\r").as_bytes());
        }
        self.delayed.push((Instant::now() + std::time::Duration::from_millis(180), b"\r".to_vec()));
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        let rows = rows.max(2);
        let cols = cols.max(10);
        if self.size == (rows, cols) {
            return;
        }
        self.size = (rows, cols);
        self.parser.screen_mut().set_size(nz(rows), nz(cols));
        self.parser.callbacks_mut().size = (rows, cols);
        match &mut self.backend {
            Backend::Local { master, .. } => {
                let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
            }
            Backend::Remote { conn, id } => conn.resize(*id, rows, cols),
        }
    }

    /// Stops the process for good (closing a pane, not leaving polypore).
    pub fn kill(&mut self) {
        match &mut self.backend {
            Backend::Local { child, .. } => {
                let _ = child.kill();
            }
            Backend::Remote { conn, id } => conn.kill(*id),
        }
        self.exited.get_or_insert(0);
    }

    pub fn is_remote(&self) -> bool {
        matches!(self.backend, Backend::Remote { .. })
    }

    pub fn scroll_by(&mut self, delta: isize) {
        let max = self.parser.screen().scrollback_capacity();
        let cur = self.scroll as isize + delta;
        self.scroll = cur.clamp(0, max as isize) as usize;
    }

    pub fn alternate(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    pub fn mouse_mode(&self) -> (vt100::MouseProtocolMode, vt100::MouseProtocolEncoding) {
        let s = self.parser.screen();
        (s.mouse_protocol_mode(), s.mouse_protocol_encoding())
    }

    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }

    pub fn app_cursor(&self) -> bool {
        self.parser.screen().application_cursor()
    }

    pub fn kitty_flags(&self) -> u16 {
        self.parser.callbacks().kitty()
    }

    /// Draws the screen into `area`. Returns the cursor position when visible.
    pub fn render(&mut self, area: Rect, buf: &mut Buffer, dim: bool) -> Option<(u16, u16)> {
        self.parser.screen_mut().set_scrollback(self.scroll);
        self.scroll = self.parser.screen().scrollback();
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let rows = rows.get().min(area.height);
        let cols = cols.get().min(area.width);
        for r in 0..rows {
            for c in 0..cols {
                let Some(cell) = screen.cell(r, c) else { continue };
                if cell.is_wide_continuation() {
                    continue;
                }
                let x = area.x + c;
                let y = area.y + r;
                let Some(out) = buf.cell_mut((x, y)) else { continue };
                let sym = cell.contents();
                if sym.is_empty() {
                    out.set_symbol(" ");
                } else {
                    out.set_symbol(sym);
                }
                let mut style = Style::default().fg(conv(cell.fgcolor())).bg(conv(cell.bgcolor()));
                let mut m = Modifier::empty();
                if cell.bold() {
                    m |= Modifier::BOLD;
                }
                if cell.dim() || dim {
                    m |= Modifier::DIM;
                }
                if cell.italic() {
                    m |= Modifier::ITALIC;
                }
                if cell.underline() {
                    m |= Modifier::UNDERLINED;
                }
                if cell.inverse() {
                    m |= Modifier::REVERSED;
                }
                style = style.add_modifier(m);
                out.set_style(style);
            }
        }
        if self.scroll > 0 || screen.hide_cursor() || self.exited.is_some() {
            return None;
        }
        let (cr, cc) = screen.cursor_position();
        if cr < area.height && cc < area.width {
            Some((area.x + cc, area.y + cr))
        } else {
            None
        }
    }
}

impl Drop for Pane {
    fn drop(&mut self) {
        match &mut self.backend {
            Backend::Local { child, .. } => {
                if self.exited.is_none() {
                    let _ = child.kill();
                }
            }
            // A server pane outlives the dashboard: let go of it, and only
            // tidy away the record when its process is already gone.
            Backend::Remote { conn, id } => {
                if self.exited.is_some() {
                    conn.kill(*id);
                } else {
                    conn.detach(*id);
                }
            }
        }
    }
}

fn nz(v: u16) -> core::num::NonZeroU16 {
    core::num::NonZeroU16::new(v.max(1)).unwrap()
}

fn conv(c: vt100::Color) -> Color {
    match c {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}
