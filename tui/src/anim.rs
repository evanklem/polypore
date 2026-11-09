//! ASCII animations shown for each agent while it works. Built-ins are
//! generated; custom ones load from `~/.config/polypore/anims/<name>.txt`,
//! frames separated by a line containing only `---`, optional first line
//! `fps: N`.

use std::collections::HashMap;

#[derive(Clone, Debug)]
pub struct Anim {
    pub frames: Vec<Vec<String>>,
    /// Shown while the agent is not working. Custom files use frame 1.
    pub idle: Option<Vec<String>>,
    pub fps: u16,
    pub width: u16,
    pub height: u16,
}

impl Anim {
    fn new(frames: Vec<Vec<String>>, fps: u16) -> Anim {
        let height = frames.iter().map(|f| f.len()).max().unwrap_or(1) as u16;
        let width = frames
            .iter()
            .flat_map(|f| f.iter())
            .map(|l| unicode_width::UnicodeWidthStr::width(l.as_str()))
            .max()
            .unwrap_or(1) as u16;
        Anim { frames, idle: None, fps: fps.max(1), width, height }
    }

    fn with_idle(mut self, idle: &[&str]) -> Anim {
        self.idle = Some(idle.iter().map(|s| s.to_string()).collect());
        self
    }

    pub fn frame(&self, tick_ms: u64, playing: bool) -> &[String] {
        if self.frames.is_empty() {
            return &[];
        }
        if !playing {
            return self.idle.as_deref().unwrap_or(&self.frames[0]);
        }
        let i = (tick_ms / (1000 / self.fps as u64).max(1)) as usize % self.frames.len();
        &self.frames[i]
    }
}

pub const BUILTINS: &[&str] = &["spark", "orbit", "pulse", "bars", "wave", "dna", "prompt", "dots", "moon"];

pub fn exists(name: &str) -> bool {
    BUILTINS.contains(&name) || crate::config::config_dir().join("anims").join(format!("{name}.txt")).is_file()
}

pub struct AnimLib {
    cache: HashMap<String, Anim>,
}

impl AnimLib {
    pub fn load(names: &[String]) -> AnimLib {
        let mut cache = HashMap::new();
        for n in names {
            cache.insert(n.clone(), load_one(n));
        }
        AnimLib { cache }
    }

    pub fn get(&mut self, name: &str) -> &Anim {
        if !self.cache.contains_key(name) {
            self.cache.insert(name.to_string(), load_one(name));
        }
        &self.cache[name]
    }
}

fn load_one(name: &str) -> Anim {
    let path = crate::config::config_dir().join("anims").join(format!("{name}.txt"));
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Some(a) = parse_file(&text) {
            return a;
        }
    }
    builtin(name)
}

pub fn parse_file(text: &str) -> Option<Anim> {
    let mut fps = 8;
    let mut frames: Vec<Vec<String>> = vec![Vec::new()];
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            if let Some(v) = line.trim().strip_prefix("fps:") {
                fps = v.trim().parse().unwrap_or(8);
                continue;
            }
        }
        if line.trim() == "---" {
            frames.push(Vec::new());
        } else {
            frames.last_mut().unwrap().push(line.to_string());
        }
    }
    frames.retain(|f| !f.is_empty());
    if frames.is_empty() { None } else { Some(Anim::new(frames, fps)) }
}

fn rows(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|s| s.to_string()).collect()
}

pub fn builtin(name: &str) -> Anim {
    match name {
        "orbit" => orbit(),
        "pulse" => pulse(),
        "bars" => bars(),
        "wave" => wave(),
        "dna" => dna(),
        "prompt" => prompt(),
        "dots" => dots(),
        "moon" => moon(),
        _ => spark(),
    }
}

fn spark() -> Anim {
    let glyphs = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
    let rings = [
        ["   ·   ", "       ", "   ·   "],
        ["    ·  ", "       ", "  ·    "],
        ["     · ", "       ", " ·     "],
        ["       ", " ·   · ", "       "],
        [" ·     ", "       ", "     · "],
        ["  ·    ", "       ", "    ·  "],
    ];
    let mut frames = Vec::new();
    for (i, g) in glyphs.iter().enumerate() {
        let r = rings[i % rings.len()];
        let mid = format!("  {}{g}{}  ", if i % 2 == 0 { "·" } else { " " }, if i % 2 == 0 { "·" } else { " " });
        frames.push(vec![r[0].to_string(), mid, r[2].to_string()]);
    }
    Anim::new(frames, 10).with_idle(&["       ", "   ✻   ", "       "])
}

fn orbit() -> Anim {
    // A dot travelling round a small ring, clockwise.
    let base = ["╭─────╮", "│  ◇  │", "╰─────╯"];
    let mut perim: Vec<(usize, usize)> = Vec::new();
    for x in 1..6 {
        perim.push((0, x));
    }
    perim.push((1, 6));
    for x in (1..6).rev() {
        perim.push((2, x));
    }
    perim.push((1, 0));
    let mut frames = Vec::new();
    for (i, (r, c)) in perim.iter().enumerate() {
        let mut grid: Vec<Vec<char>> = base.iter().map(|l| l.chars().collect()).collect();
        grid[*r][*c] = '●';
        let (tr, tc) = perim[(i + perim.len() - 1) % perim.len()];
        grid[tr][tc] = '•';
        grid[1][3] = if i % 4 < 2 { '◆' } else { '◇' };
        frames.push(grid.into_iter().map(|l| l.into_iter().collect()).collect());
    }
    Anim::new(frames, 10).with_idle(&["╭─────╮", "│  ◇  │", "╰─────╯"])
}

fn pulse() -> Anim {
    let seq = [
        ["       ", "   ·   ", "       "],
        ["   ·   ", "  ·•·  ", "   ·   "],
        ["  ·•·  ", " ·•●•· ", "  ·•·  "],
        [" ·   · ", "·  ●  ·", " ·   · "],
        ["·     ·", "   •   ", "·     ·"],
        ["       ", "   ·   ", "       "],
    ];
    Anim::new(seq.iter().map(|f| rows(f)).collect(), 8).with_idle(&["       ", "   •   ", "       "])
}

fn bars() -> Anim {
    let lv = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let mut frames = Vec::new();
    for t in 0..16 {
        let mut top = String::new();
        let mut bot = String::new();
        for x in 0..7 {
            let v = (((t as f64 * 0.6 + x as f64 * 0.9).sin() + 1.0) * 8.0) as usize; // 0..16
            let lo = v.min(8);
            let hi = v.saturating_sub(8).min(8);
            bot.push(lv[lo]);
            top.push(lv[hi]);
        }
        frames.push(vec![top, bot]);
    }
    Anim::new(frames, 10)
}

fn wave() -> Anim {
    let w = "∙∙∙∘○◯○∘∙∙∙∙∙∙";
    let chars: Vec<char> = w.chars().collect();
    let mut frames = Vec::new();
    for t in 0..chars.len() {
        let line: String = (0..7).map(|x| chars[(x + chars.len() - t) % chars.len()]).collect();
        frames.push(vec![line]);
    }
    Anim::new(frames, 10)
}

fn dna() -> Anim {
    let mut frames = Vec::new();
    for t in 0..12 {
        let mut out = Vec::new();
        for y in 0..3 {
            let phase = (t + y * 2) as f64 * 0.52;
            let a = ((phase.sin() + 1.0) * 3.0).round() as usize;
            let b = 6 - a;
            let mut row: Vec<char> = vec![' '; 7];
            let (l, r) = (a.min(b), a.max(b));
            for c in row.iter_mut().take(r).skip(l + 1) {
                *c = '─';
            }
            row[a] = '●';
            row[b] = '○';
            out.push(row.into_iter().collect());
        }
        frames.push(out);
    }
    Anim::new(frames, 8)
}

fn prompt() -> Anim {
    Anim::new(vec![rows(&["❯ █"]), rows(&["❯  "])], 2)
}

fn dots() -> Anim {
    let seq = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    Anim::new(seq.iter().map(|s| vec![format!(" {s} ")]).collect(), 12)
}

fn moon() -> Anim {
    let seq = ["◯", "◔", "◑", "◕", "●", "◕", "◑", "◔"];
    Anim::new(seq.iter().map(|s| vec![format!(" {s} ")]).collect(), 6)
}
