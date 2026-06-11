//! per-tool output parsers: each turns one CLI's stdout/stderr into
//! normalized Diagnostics. pure text -> struct, no process spawning.

use super::*;

/* ------------------------------ parsers ------------------------------ */

/* tsc default output: `path(line,col): error TSnnnn: message`. line and
column are 1-based; we normalize to 0-based so downstream consumers
(monaco, problems panel) can add 1 to render. */
pub fn parse_typescript_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| parse_typescript_line(index, line, source))
        .collect()
}

pub(crate) fn parse_typescript_line(index: usize, line: &str, source: &str) -> Option<Diagnostic> {
    let open = line.find('(')?;
    let close = line[open + 1..].find(')')? + open + 1;
    let file = line[..open].trim();
    if file.is_empty() || file.contains(' ') {
        return None;
    }
    let mut position = line[open + 1..close].split(',');
    let line_no = position.next()?.parse::<i64>().ok()?;
    let column = position.next()?.parse::<i64>().ok()?;
    let rest = line[close + 1..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let severity = if rest.starts_with("error") {
        "error"
    } else if rest.starts_with("warning") {
        "warn"
    } else {
        "info"
    };
    let code = rest
        .split_whitespace()
        .find(|token| token.starts_with("TS") && token.ends_with(':'))
        .map(|token| token.trim_end_matches(':').to_string());
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity: severity.to_string(),
        source: source.to_string(),
        file: file.to_string(),
        range: Range {
            start: Position {
                line: (line_no - 1).max(0),
                column: (column - 1).max(0),
            },
            end: Position {
                line: (line_no - 1).max(0),
                column: (column - 1).max(0),
            },
        },
        message: rest.to_string(),
        code,
    })
}

pub fn parse_eslint_json_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let Some(files) = parse_json_array_report(output) else {
        return vec![];
    };
    let Some(files) = files.as_array() else {
        return vec![];
    };
    let mut out = vec![];
    for (file_index, result) in files.iter().enumerate() {
        let file = result
            .get("filePath")
            .and_then(|path| path.as_str())
            .map(eslint_file_label)
            .unwrap_or_default();
        if file.is_empty() {
            continue;
        }
        let Some(messages) = result
            .get("messages")
            .and_then(|messages| messages.as_array())
        else {
            continue;
        };
        for (message_index, message) in messages.iter().enumerate() {
            let text = message
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .trim();
            if text.is_empty() {
                continue;
            }
            let fatal = message
                .get("fatal")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let severity = match message
                .get("severity")
                .and_then(|value| value.as_i64())
                .unwrap_or(if fatal { 2 } else { 0 })
            {
                2 => "error",
                1 => "warn",
                _ if fatal => "error",
                _ => "info",
            };
            let line = message
                .get("line")
                .and_then(|value| value.as_i64())
                .unwrap_or(1);
            let column = message
                .get("column")
                .and_then(|value| value.as_i64())
                .unwrap_or(1);
            let end_line = message
                .get("endLine")
                .and_then(|value| value.as_i64())
                .unwrap_or(line);
            let end_column = message
                .get("endColumn")
                .and_then(|value| value.as_i64())
                .unwrap_or(column);
            out.push(Diagnostic {
                id: format!("{source}-{file_index}-{message_index}"),
                severity: severity.to_string(),
                source: source.to_string(),
                file: file.clone(),
                range: Range {
                    start: Position {
                        line: (line - 1).max(0),
                        column: (column - 1).max(0),
                    },
                    end: Position {
                        line: (end_line - 1).max(0),
                        column: (end_column - 1).max(0),
                    },
                },
                message: text.to_string(),
                code: message
                    .get("ruleId")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
            });
        }
    }
    out
}

pub(crate) fn parse_json_array_report(output: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(output)
        .ok()
        .or_else(|| {
            let start = output.find('[')?;
            let end = output.rfind(']')?;
            if start > end {
                return None;
            }
            serde_json::from_str::<serde_json::Value>(&output[start..=end]).ok()
        })
}

pub(crate) fn eslint_file_label(path: &str) -> String {
    let path = Path::new(path);
    if path.is_absolute() {
        if let Ok(root) = project_context::active_project_root() {
            return relative_path(&root, path);
        }
    }
    path.to_string_lossy().replace('\\', "/")
}

/* cargo with --message-format=json emits one json object per line. we
only care about objects whose `reason` is `compiler-message`; the rest
(build script output, artifact records) are skipped. each compiler
message carries a primary span we treat as the diagnostic anchor. */
pub fn parse_cargo_json_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    for (index, line) in output.lines().enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('{') {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("reason").and_then(|r| r.as_str()) != Some("compiler-message") {
            continue;
        }
        let Some(msg) = value.get("message") else {
            continue;
        };
        let level = msg.get("level").and_then(|l| l.as_str()).unwrap_or("error");
        let severity = match level {
            "error" => "error",
            "warning" => "warn",
            "note" | "help" => "info",
            other if other.starts_with("error") => "error",
            _ => "info",
        };
        let message = msg
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        if message.is_empty() {
            continue;
        }
        let code = msg
            .get("code")
            .and_then(|c| c.get("code"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());
        let Some(spans) = msg.get("spans").and_then(|s| s.as_array()) else {
            continue;
        };
        let primary = spans
            .iter()
            .find(|s| {
                s.get("is_primary")
                    .and_then(|p| p.as_bool())
                    .unwrap_or(false)
            })
            .or_else(|| spans.first());
        let Some(primary) = primary else { continue };
        let file = primary
            .get("file_name")
            .and_then(|f| f.as_str())
            .unwrap_or("")
            .to_string();
        if file.is_empty() {
            continue;
        }
        let line_start = primary
            .get("line_start")
            .and_then(|n| n.as_i64())
            .unwrap_or(1);
        let col_start = primary
            .get("column_start")
            .and_then(|n| n.as_i64())
            .unwrap_or(1);
        let line_end = primary
            .get("line_end")
            .and_then(|n| n.as_i64())
            .unwrap_or(line_start);
        let col_end = primary
            .get("column_end")
            .and_then(|n| n.as_i64())
            .unwrap_or(col_start);
        out.push(Diagnostic {
            id: format!("{source}-{index}"),
            severity: severity.to_string(),
            source: source.to_string(),
            file,
            range: Range {
                start: Position {
                    line: (line_start - 1).max(0),
                    column: (col_start - 1).max(0),
                },
                end: Position {
                    line: (line_end - 1).max(0),
                    column: (col_end - 1).max(0),
                },
            },
            message,
            code,
        });
    }
    out
}

pub fn parse_generic_colon_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| parse_generic_colon_line(index, line, source))
        .collect()
}

pub(crate) fn parse_generic_colon_line(
    index: usize,
    line: &str,
    source: &str,
) -> Option<Diagnostic> {
    let parts: Vec<&str> = line.splitn(4, ':').collect();
    if parts.len() < 3 {
        return None;
    }
    let file = parts[0].trim();
    if file.is_empty() || file.contains(" ") {
        return None;
    }
    let line_no = parts[1].trim().parse::<i64>().ok()?;
    let (col, message) = if parts.len() >= 4 {
        (
            parts[2].trim().parse::<i64>().ok().unwrap_or(1),
            parts[3].trim(),
        )
    } else {
        (1, parts[2].trim())
    };
    if message.is_empty() {
        return None;
    }
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity: if message.to_lowercase().contains("warning") {
            "warn".to_string()
        } else {
            "error".to_string()
        },
        source: source.to_string(),
        file: file.to_string(),
        range: line_range((line_no - 1).max(0), (col - 1).max(0)),
        message: message.to_string(),
        code: None,
    })
}

pub fn parse_jvm_build_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            parse_jvm_bracket_line(index, line, source)
                .or_else(|| parse_kotlin_compiler_line(index, line, source))
                .or_else(|| parse_generic_colon_line(index, line, source))
        })
        .collect()
}

pub(crate) fn parse_jvm_bracket_line(index: usize, line: &str, source: &str) -> Option<Diagnostic> {
    let trimmed = strip_log_prefix(line.trim());
    let marker = trimmed.find(":[")?;
    let file = trimmed[..marker].trim();
    if file.is_empty() || file.contains(" ") {
        return None;
    }
    let rest = &trimmed[marker + 2..];
    let close = rest.find(']')?;
    let mut position = rest[..close].split(',');
    let line_no = position.next()?.trim().parse::<i64>().ok()?;
    let col = position
        .next()
        .and_then(|part| part.trim().parse::<i64>().ok())
        .unwrap_or(1);
    let message = rest[close + 1..].trim_start_matches(':').trim();
    if message.is_empty() {
        return None;
    }
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity: severity_from_text(trimmed),
        source: source.to_string(),
        file: file.to_string(),
        range: line_range((line_no - 1).max(0), (col - 1).max(0)),
        message: message.to_string(),
        code: None,
    })
}

pub(crate) fn parse_kotlin_compiler_line(
    index: usize,
    line: &str,
    source: &str,
) -> Option<Diagnostic> {
    let trimmed = strip_log_prefix(line.trim());
    let body = trimmed
        .strip_prefix("e: ")
        .or_else(|| trimmed.strip_prefix("w: "))?;
    let body = body.strip_prefix("file://").unwrap_or(body);
    let open = body.rfind(": (")?;
    let file = body[..open].trim();
    if file.is_empty() || file.contains(" ") {
        return None;
    }
    let after_open = &body[open + 3..];
    let close = after_open.find(')')?;
    let mut position = after_open[..close].split(',');
    let line_no = position.next()?.trim().parse::<i64>().ok()?;
    let col = position
        .next()
        .and_then(|part| part.trim().parse::<i64>().ok())
        .unwrap_or(1);
    let message = after_open[close + 1..].trim_start_matches(':').trim();
    if message.is_empty() {
        return None;
    }
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity: severity_from_text(trimmed),
        source: source.to_string(),
        file: file.to_string(),
        range: line_range((line_no - 1).max(0), (col - 1).max(0)),
        message: message.to_string(),
        code: None,
    })
}

pub fn parse_msbuild_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| parse_msbuild_line(index, line, source))
        .collect()
}

pub(crate) fn parse_msbuild_line(index: usize, line: &str, source: &str) -> Option<Diagnostic> {
    let trimmed = line.trim();
    let open = trimmed.find('(')?;
    let close = trimmed[open + 1..].find(')')? + open + 1;
    let file = trimmed[..open].trim();
    if file.is_empty() || file.contains(" ") {
        return None;
    }
    let mut position = trimmed[open + 1..close].split(',');
    let line_no = position.next()?.trim().parse::<i64>().ok()?;
    let col = position
        .next()
        .and_then(|part| part.trim().parse::<i64>().ok())
        .unwrap_or(1);
    let message = trimmed[close + 1..].trim_start_matches(':').trim();
    if message.is_empty() {
        return None;
    }
    let code = message
        .split_whitespace()
        .find(|token| token.ends_with(':') && token.chars().any(|ch| ch.is_ascii_digit()))
        .map(|token| token.trim_end_matches(':').to_string());
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity: severity_from_text(message),
        source: source.to_string(),
        file: file.to_string(),
        range: line_range((line_no - 1).max(0), (col - 1).max(0)),
        message: message.to_string(),
        code,
    })
}

pub fn parse_composer_validate_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let message = line.trim();
            if !(message.contains("[ERROR]") || message.contains("[WARNING]")) {
                return None;
            }
            Some(Diagnostic {
                id: format!("{source}-{index}"),
                severity: severity_from_text(message),
                source: source.to_string(),
                file: "composer.json".to_string(),
                range: line_range(0, 0),
                message: message.to_string(),
                code: None,
            })
        })
        .collect()
}

pub fn parse_dart_analyze_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    output
        .lines()
        .enumerate()
        .filter_map(|(index, line)| parse_dart_analyze_line(index, line, source))
        .collect()
}

pub(crate) fn parse_dart_analyze_line(
    index: usize,
    line: &str,
    source: &str,
) -> Option<Diagnostic> {
    let trimmed = line.trim();
    let parts: Vec<&str> = trimmed.splitn(4, " - ").collect();
    if parts.len() < 3 {
        return None;
    }
    let severity = match parts[0].trim().to_lowercase().as_str() {
        "warning" | "info" => parts[0].trim().to_lowercase(),
        "error" => "error".to_string(),
        _ => return None,
    };
    let loc: Vec<&str> = parts[1].rsplitn(3, ':').collect();
    if loc.len() < 3 {
        return None;
    }
    let col = loc[0].trim().parse::<i64>().ok().unwrap_or(1);
    let line_no = loc[1].trim().parse::<i64>().ok()?;
    let file = loc[2].trim();
    if file.is_empty() || file.contains(" ") {
        return None;
    }
    let code = parts
        .get(3)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Some(Diagnostic {
        id: format!("{source}-{index}"),
        severity,
        source: source.to_string(),
        file: file.to_string(),
        range: line_range((line_no - 1).max(0), (col - 1).max(0)),
        message: parts[2].trim().to_string(),
        code,
    })
}

pub(crate) fn strip_log_prefix(line: &str) -> &str {
    line.strip_prefix("[ERROR] ")
        .or_else(|| line.strip_prefix("[WARNING] "))
        .or_else(|| line.strip_prefix("[warn] "))
        .or_else(|| line.strip_prefix("[error] "))
        .unwrap_or(line)
}

pub(crate) fn severity_from_text(text: &str) -> String {
    if text.to_lowercase().contains("warning") {
        "warn".to_string()
    } else {
        "error".to_string()
    }
}

/* `php -l` output for a passing file is `No syntax errors detected in <path>`;
for a failure it prints `Parse error: ... in <path> on line <n>` followed by
`Errors parsing <path>`. we only emit when we see a Parse / Fatal error. */
pub fn parse_php_lint_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    for (index, line) in output.lines().enumerate() {
        let trimmed = line.trim();
        if !(trimmed.starts_with("Parse error:")
            || trimmed.starts_with("PHP Parse error:")
            || trimmed.starts_with("Fatal error:")
            || trimmed.starts_with("PHP Fatal error:"))
        {
            continue;
        }
        /* "... in /abs/path/foo.php on line 12" */
        let (file, line_no) = match trimmed.rfind(" in ") {
            Some(idx) => {
                let tail = &trimmed[idx + 4..];
                let (file_part, line_part) = match tail.find(" on line ") {
                    Some(j) => (&tail[..j], &tail[j + 9..]),
                    None => (tail, "1"),
                };
                let line_no = line_part
                    .split_whitespace()
                    .next()
                    .and_then(|n| n.parse::<i64>().ok())
                    .unwrap_or(1);
                (file_part.to_string(), line_no)
            }
            None => continue,
        };
        out.push(Diagnostic {
            id: format!("{source}-{index}"),
            severity: "error".to_string(),
            source: source.to_string(),
            file,
            range: line_range((line_no - 1).max(0), 0),
            message: trimmed.to_string(),
            code: None,
        });
    }
    out
}

/* `luac -p` outputs `luac: <file>:<line>: <message>` for parse errors,
sometimes prefixed by build noise. */
pub fn parse_luac_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    for (index, line) in output.lines().enumerate() {
        let trimmed = line.trim();
        let body = trimmed.strip_prefix("luac: ").unwrap_or(trimmed);
        let parts: Vec<&str> = body.splitn(3, ':').collect();
        if parts.len() < 3 {
            continue;
        }
        let file = parts[0].trim();
        if file.is_empty() {
            continue;
        }
        let Ok(line_no) = parts[1].trim().parse::<i64>() else {
            continue;
        };
        let message = parts[2].trim();
        if message.is_empty() {
            continue;
        }
        out.push(Diagnostic {
            id: format!("{source}-{index}"),
            severity: "error".to_string(),
            source: source.to_string(),
            file: file.to_string(),
            range: line_range((line_no - 1).max(0), 0),
            message: message.to_string(),
            code: None,
        });
    }
    out
}

/* `bash -n` writes errors as `<file>: line <n>: <message>` to stderr and
exits non-zero. parse the standard shape; ignore noise. */
pub fn parse_bash_syntax_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    for (index, line) in output.lines().enumerate() {
        let trimmed = line.trim();
        if !trimmed.contains(": line ") {
            continue;
        }
        let Some(colon) = trimmed.find(": line ") else {
            continue;
        };
        let file = trimmed[..colon].trim();
        if file.is_empty() {
            continue;
        }
        let after = &trimmed[colon + 7..];
        let Some(sep) = after.find(':') else {
            continue;
        };
        let Ok(line_no) = after[..sep].trim().parse::<i64>() else {
            continue;
        };
        let message = after[sep + 1..].trim();
        if message.is_empty() {
            continue;
        }
        out.push(Diagnostic {
            id: format!("{source}-{index}"),
            severity: "error".to_string(),
            source: source.to_string(),
            file: file.to_string(),
            range: line_range((line_no - 1).max(0), 0),
            message: message.to_string(),
            code: None,
        });
    }
    out
}

pub fn parse_python_compile_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let mut out = vec![];
    let mut current_file: Option<String> = None;
    for (index, line) in output.lines().enumerate() {
        if let Some(rest) = line.strip_prefix("*** Error compiling '") {
            current_file = rest.split('\'').next().map(|item| item.to_string());
            continue;
        }
        if let Some(file) = current_file.clone() {
            let lower = line.to_lowercase();
            if lower.contains("syntaxerror") || lower.contains("indentationerror") {
                out.push(Diagnostic {
                    id: format!("{source}-{index}"),
                    severity: "error".to_string(),
                    source: source.to_string(),
                    file,
                    range: line_range(0, 0),
                    message: line.trim().to_string(),
                    code: None,
                });
                current_file = None;
            }
        }
    }
    out
}

pub fn parse_npm_audit_diagnostics(output: &str, source: &str) -> Vec<Diagnostic> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(output) else {
        return vec![];
    };
    let Some(vulnerabilities) = value
        .get("vulnerabilities")
        .and_then(|item| item.as_object())
    else {
        return vec![];
    };
    vulnerabilities
        .iter()
        .enumerate()
        .map(|(index, (name, item))| {
            let severity = match item
                .get("severity")
                .and_then(|s| s.as_str())
                .unwrap_or("moderate")
            {
                "critical" | "high" => "error",
                "moderate" | "low" => "warn",
                _ => "info",
            };
            let via = item
                .get("via")
                .and_then(|via| via.as_array())
                .and_then(|via| {
                    via.iter()
                        .find_map(|entry| entry.get("title").and_then(|title| title.as_str()))
                })
                .unwrap_or("dependency vulnerability");
            Diagnostic {
                id: format!("{source}-{index}-{name}"),
                severity: severity.to_string(),
                source: source.to_string(),
                file: "package.json".to_string(),
                range: line_range(0, 0),
                message: format!("{name}: {via}"),
                code: item
                    .get("severity")
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string()),
            }
        })
        .collect()
}
