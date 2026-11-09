//! Encodes crossterm input events into the bytes a program in a PTY expects.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

pub fn modifier_param(m: KeyModifiers) -> u8 {
    1 + if m.contains(KeyModifiers::SHIFT) { 1 } else { 0 }
        + if m.contains(KeyModifiers::ALT) { 2 } else { 0 }
        + if m.contains(KeyModifiers::CONTROL) { 4 } else { 0 }
}

pub fn encode_key(k: KeyEvent, app_cursor: bool, kitty: u16) -> Vec<u8> {
    let m = k.modifiers;
    let ctrl = m.contains(KeyModifiers::CONTROL);
    let alt = m.contains(KeyModifiers::ALT);
    let shift = m.contains(KeyModifiers::SHIFT);
    let mp = modifier_param(m);
    let disambiguate = kitty & 1 != 0;
    let csi_u = |code: u32, mp: u8| -> Vec<u8> {
        if mp > 1 { format!("\x1b[{code};{mp}u").into_bytes() } else { format!("\x1b[{code}u").into_bytes() }
    };
    let cursor = |final_: char| -> Vec<u8> {
        if mp > 1 {
            format!("\x1b[1;{mp}{final_}").into_bytes()
        } else if app_cursor {
            format!("\x1bO{final_}").into_bytes()
        } else {
            format!("\x1b[{final_}").into_bytes()
        }
    };
    let tilde = |n: u8| -> Vec<u8> {
        if mp > 1 { format!("\x1b[{n};{mp}~").into_bytes() } else { format!("\x1b[{n}~").into_bytes() }
    };
    match k.code {
        KeyCode::Char(c) => {
            if disambiguate && (ctrl || alt) {
                let base = c.to_ascii_lowercase() as u32;
                return csi_u(base, mp);
            }
            if ctrl {
                let b = match c {
                    'a'..='z' => (c as u8) - b'a' + 1,
                    'A'..='Z' => (c as u8) - b'A' + 1,
                    ' ' | '@' | '2' => 0,
                    '[' | '3' => 27,
                    '\\' | '4' => 28,
                    ']' | '5' => 29,
                    '^' | '6' => 30,
                    '_' | '-' | '7' => 31,
                    '?' | '8' => 127,
                    _ => c as u8,
                };
                let mut v = Vec::new();
                if alt {
                    v.push(0x1b);
                }
                v.push(b);
                return v;
            }
            let mut s = String::new();
            if alt {
                s.push('\x1b');
            }
            s.push(c);
            s.into_bytes()
        }
        KeyCode::Enter => {
            if disambiguate && mp > 1 {
                return csi_u(13, mp);
            }
            if shift || alt {
                // Claude Code and most line editors treat ESC CR as newline.
                return b"\x1b\r".to_vec();
            }
            b"\r".to_vec()
        }
        KeyCode::Tab => {
            if disambiguate && mp > 1 && !(shift && mp == 2) {
                return csi_u(9, mp);
            }
            if shift { b"\x1b[Z".to_vec() } else { b"\t".to_vec() }
        }
        KeyCode::BackTab => b"\x1b[Z".to_vec(),
        KeyCode::Backspace => {
            if disambiguate && mp > 1 {
                return csi_u(127, mp);
            }
            if ctrl {
                b"\x08".to_vec()
            } else if alt {
                b"\x1b\x7f".to_vec()
            } else {
                b"\x7f".to_vec()
            }
        }
        KeyCode::Esc => {
            if disambiguate {
                return csi_u(27, mp);
            }
            b"\x1b".to_vec()
        }
        KeyCode::Up => cursor('A'),
        KeyCode::Down => cursor('B'),
        KeyCode::Right => cursor('C'),
        KeyCode::Left => cursor('D'),
        KeyCode::Home => cursor('H'),
        KeyCode::End => cursor('F'),
        KeyCode::PageUp => tilde(5),
        KeyCode::PageDown => tilde(6),
        KeyCode::Insert => tilde(2),
        KeyCode::Delete => tilde(3),
        KeyCode::F(n) => match n {
            1..=4 => {
                let f = [b'P', b'Q', b'R', b'S'][(n - 1) as usize] as char;
                if mp > 1 { format!("\x1b[1;{mp}{f}").into_bytes() } else { format!("\x1bO{f}").into_bytes() }
            }
            5 => tilde(15),
            6 => tilde(17),
            7 => tilde(18),
            8 => tilde(19),
            9 => tilde(20),
            10 => tilde(21),
            11 => tilde(23),
            12 => tilde(24),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// Encodes a mouse event relative to the pane origin for programs that
/// enabled mouse reporting.
pub fn encode_mouse(ev: &MouseEvent, x: u16, y: u16, mode: vt100::MouseProtocolMode, enc: vt100::MouseProtocolEncoding) -> Option<Vec<u8>> {
    use vt100::MouseProtocolMode as M;
    if mode == M::None {
        return None;
    }
    let mut mods = 0u8;
    if ev.modifiers.contains(KeyModifiers::SHIFT) {
        mods |= 4;
    }
    if ev.modifiers.contains(KeyModifiers::ALT) {
        mods |= 8;
    }
    if ev.modifiers.contains(KeyModifiers::CONTROL) {
        mods |= 16;
    }
    let btn = |b: MouseButton| match b {
        MouseButton::Left => 0u8,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    };
    let (code, release) = match ev.kind {
        MouseEventKind::Down(b) => (btn(b), false),
        MouseEventKind::Up(b) => {
            if mode == M::Press {
                return None;
            }
            (btn(b), true)
        }
        MouseEventKind::Drag(b) => {
            if !matches!(mode, M::ButtonMotion | M::AnyMotion) {
                return None;
            }
            (btn(b) + 32, false)
        }
        MouseEventKind::Moved => {
            if mode != M::AnyMotion {
                return None;
            }
            (35, false)
        }
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        _ => return None,
    };
    let code = code | mods;
    if enc == vt100::MouseProtocolEncoding::Sgr {
        let f = if release { 'm' } else { 'M' };
        return Some(format!("\x1b[<{};{};{}{f}", code, x + 1, y + 1).into_bytes());
    }
    let code = if release { 3 | mods } else { code };
    let cx = (x + 1).min(222) as u8 + 32;
    let cy = (y + 1).min(222) as u8 + 32;
    Some(vec![0x1b, b'[', b'M', code + 32, cx, cy])
}

/// Parses a key spec like "ctrl-space", "ctrl-a", "alt-p".
pub fn parse_chord(spec: &str) -> (KeyModifiers, KeyCode) {
    let mut mods = KeyModifiers::empty();
    let mut code = KeyCode::Char(' ');
    for part in spec.to_ascii_lowercase().split(['-', '+']) {
        match part {
            "ctrl" | "c" | "control" => mods |= KeyModifiers::CONTROL,
            "alt" | "a" | "meta" | "m" => mods |= KeyModifiers::ALT,
            "shift" | "s" => mods |= KeyModifiers::SHIFT,
            "space" => code = KeyCode::Char(' '),
            "enter" => code = KeyCode::Enter,
            "tab" => code = KeyCode::Tab,
            "esc" => code = KeyCode::Esc,
            p if p.chars().count() == 1 => code = KeyCode::Char(p.chars().next().unwrap()),
            p if p.starts_with('f') => {
                if let Ok(n) = p[1..].parse() {
                    code = KeyCode::F(n);
                }
            }
            _ => {}
        }
    }
    (mods, code)
}

pub fn chord_matches(k: &KeyEvent, chord: &(KeyModifiers, KeyCode)) -> bool {
    let want_mods = chord.0;
    let have = k.modifiers - KeyModifiers::SHIFT;
    let want = want_mods - KeyModifiers::SHIFT;
    if have != want {
        return false;
    }
    match (k.code, chord.1) {
        (KeyCode::Char(a), KeyCode::Char(b)) => {
            a.eq_ignore_ascii_case(&b) || (b == ' ' && (a == '@' || a == '2' || a == '\0'))
        }
        (a, b) => a == b,
    }
}

pub fn chord_label(spec: &str) -> String {
    spec.replace("ctrl", "C").replace("alt", "M").replace("shift", "S").replace("space", "Spc")
}
