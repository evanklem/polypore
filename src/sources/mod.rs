pub mod claude;
pub mod codex;

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::Path;

/// Reads complete lines appended after `offset`, calling `f` for each one, and
/// advances `offset` past the last complete line. A trailing partial line
/// (the writer is mid-append) is left for the next call.
pub fn tail_lines(path: &Path, offset: &mut u64, mut f: impl FnMut(&[u8])) -> std::io::Result<u64> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < *offset {
        // Truncated or replaced: start over.
        *offset = 0;
    }
    if len == *offset {
        return Ok(len);
    }
    file.seek(SeekFrom::Start(*offset))?;
    let mut reader = BufReader::with_capacity(256 * 1024, file);
    let mut buf = Vec::with_capacity(64 * 1024);
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if buf.last() != Some(&b'\n') {
            break;
        }
        *offset += n as u64;
        let line = trim_line(&buf);
        if !line.is_empty() {
            f(line);
        }
    }
    Ok(len)
}

/// Reads up to `max` bytes from the start of a file and yields whole lines.
pub fn head_lines(path: &Path, max: u64, mut f: impl FnMut(&[u8]) -> bool) -> std::io::Result<()> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::new();
    let mut read = 0u64;
    while read < max {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        read += n as u64;
        let line = trim_line(&buf);
        if !line.is_empty() && !f(line) {
            break;
        }
    }
    Ok(())
}

/// Reads whole lines from the last `max` bytes of a file.
pub fn last_lines(path: &Path, max: u64, mut f: impl FnMut(&[u8])) -> std::io::Result<()> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(max);
    file.seek(SeekFrom::Start(start))?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut buf = Vec::new();
    let mut first = start > 0;
    loop {
        buf.clear();
        let n = reader.read_until(b'\n', &mut buf)?;
        if n == 0 {
            break;
        }
        if first {
            first = false;
            continue;
        }
        let line = trim_line(&buf);
        if !line.is_empty() {
            f(line);
        }
    }
    Ok(())
}

fn trim_line(buf: &[u8]) -> &[u8] {
    let mut end = buf.len();
    while end > 0 && (buf[end - 1] == b'\n' || buf[end - 1] == b'\r') {
        end -= 1;
    }
    &buf[..end]
}

pub fn count_diff_lines(diff: &str) -> (u32, u32) {
    let mut add = 0;
    let mut del = 0;
    for l in diff.lines() {
        if l.starts_with("+++") || l.starts_with("---") {
            continue;
        }
        if l.starts_with('+') {
            add += 1;
        } else if l.starts_with('-') {
            del += 1;
        }
    }
    (add, del)
}
