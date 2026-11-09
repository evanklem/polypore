//! Behavior tests through module interfaces.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::Rect;

use crate::keys::{encode_key, parse_chord, chord_matches};
use crate::layout::{Comp, Dir, LeafKind, Layout, Move};
use crate::model::*;

fn key(code: KeyCode, m: KeyModifiers) -> KeyEvent {
    KeyEvent::new(code, m)
}

#[test]
fn layout_split_remove_and_collapse() {
    let mut l = Layout::empty();
    let t = l.split(None, LeafKind::Term(1), Dir::H, 0.5);
    let c = l.split(Some(t), LeafKind::Comp(Comp::Tasks), Dir::H, 0.6);
    let area = Rect::new(0, 0, 100, 40);
    let (rects, handles) = l.compute(area, 1, true);
    assert_eq!(rects.len(), 2);
    assert_eq!(handles.len(), 1);
    let rt = rects.iter().find(|r| r.0 == t).unwrap().1;
    let rc = rects.iter().find(|r| r.0 == c).unwrap().1;
    assert_eq!(rt.width + rc.width + 1, 100, "gap of one cell between panes");
    assert!(rt.width > rc.width, "ratio 0.6 favours the first child");
    // Components collapse when no agent is present; the terminal takes all.
    let (rects, handles) = l.compute(area, 1, false);
    assert_eq!(rects.len(), 1);
    assert_eq!(rects[0].1, area);
    assert!(handles.is_empty());
    // The file tree stays visible without an agent.
    let files = l.split(Some(t), LeafKind::Comp(Comp::Files), Dir::V, 0.5);
    let (rects, _) = l.compute(area, 1, false);
    assert!(rects.iter().any(|r| r.0 == files));
    l.remove(files);
    l.remove(c);
    assert_eq!(l.leaves().len(), 1);
    l.remove(t);
    assert!(l.root.is_none());
}

#[test]
fn layout_neighbor_swap_resize_and_spec_roundtrip() {
    let mut l = Layout::empty();
    let a = l.split(None, LeafKind::Term(1), Dir::H, 0.5);
    let b = l.split(Some(a), LeafKind::Term(2), Dir::H, 0.5);
    let c = l.split(Some(b), LeafKind::Comp(Comp::Tasks), Dir::V, 0.5);
    let (rects, _) = l.compute(Rect::new(0, 0, 120, 40), 1, true);
    assert_eq!(Layout::neighbor(&rects, a, Move::Right).map(|x| x == b || x == c), Some(true));
    assert_eq!(Layout::neighbor(&rects, b, Move::Down), Some(c));
    assert_eq!(Layout::neighbor(&rects, a, Move::Left), None);
    l.swap(a, c);
    assert_eq!(l.kind_of(a), Some(LeafKind::Comp(Comp::Tasks)));
    assert_eq!(l.kind_of(c), Some(LeafKind::Term(1)));
    let before = l.compute(Rect::new(0, 0, 120, 40), 1, true).0;
    let w = |v: &Vec<(u64, Rect)>, id| v.iter().find(|r| r.0 == id).unwrap().1.width;
    // Arrow keys move the divider that way, from either side of it.
    l.resize(b, Dir::H, 0.1);
    let after = l.compute(Rect::new(0, 0, 120, 40), 1, true).0;
    assert!(w(&after, b) < w(&before, b) && w(&after, a) > w(&before, a), "right from the right pane moves the divider right");
    l.resize(a, Dir::H, -0.1);
    let back_left = l.compute(Rect::new(0, 0, 120, 40), 1, true).0;
    assert!(w(&back_left, a) < w(&after, a), "left from the left pane moves the divider left");
    let spec = l.to_spec(|p| Some((p as usize - 1, String::new()))).unwrap();
    let text = toml::to_string(&crate::layout::LayoutFile { layout: spec.clone() }).unwrap();
    let back: crate::layout::LayoutFile = toml::from_str(&text).unwrap();
    let rebuilt = Layout::from_spec(&back.layout, &mut |slot, _| Some(slot as u64 + 10));
    assert_eq!(rebuilt.terms().len(), 2);
    assert_eq!(rebuilt.leaves().len(), 3);
}

#[test]
fn default_layout_parses_from_its_own_toml() {
    let spec = crate::layout::default_spec();
    let text = toml::to_string_pretty(&crate::layout::LayoutFile { layout: spec }).unwrap();
    let back: crate::layout::LayoutFile = toml::from_str(&text).unwrap();
    let mut roles = Vec::new();
    let l = Layout::from_spec(&back.layout, &mut |_, role| {
        roles.push(role.to_string());
        Some(roles.len() as u64)
    });
    assert_eq!(roles, vec!["agent", "shell"]);
    assert_eq!(l.leaves().len(), 5);
    assert!(l.leaves().iter().any(|(_, k)| *k == LeafKind::Comp(Comp::Activity)), "the activity feed is beside a new session");
    assert_eq!(back.layout, crate::layout::default_spec(), "round-trips exactly, so an untouched file is recognised");
}

#[test]
fn key_encoding_matches_xterm_and_kitty() {
    assert_eq!(encode_key(key(KeyCode::Char('a'), KeyModifiers::CONTROL), false, 0), vec![1]);
    assert_eq!(encode_key(key(KeyCode::Char(' '), KeyModifiers::CONTROL), false, 0), vec![0]);
    assert_eq!(encode_key(key(KeyCode::Char('x'), KeyModifiers::ALT), false, 0), b"\x1bx".to_vec());
    assert_eq!(encode_key(key(KeyCode::Up, KeyModifiers::NONE), false, 0), b"\x1b[A".to_vec());
    assert_eq!(encode_key(key(KeyCode::Up, KeyModifiers::NONE), true, 0), b"\x1bOA".to_vec());
    assert_eq!(encode_key(key(KeyCode::Right, KeyModifiers::CONTROL), false, 0), b"\x1b[1;5C".to_vec());
    assert_eq!(encode_key(key(KeyCode::Enter, KeyModifiers::SHIFT), false, 0), b"\x1b\r".to_vec());
    assert_eq!(encode_key(key(KeyCode::Enter, KeyModifiers::SHIFT), false, 1), b"\x1b[13;2u".to_vec());
    assert_eq!(encode_key(key(KeyCode::Esc, KeyModifiers::NONE), false, 1), b"\x1b[27u".to_vec());
    assert_eq!(encode_key(key(KeyCode::BackTab, KeyModifiers::SHIFT), false, 0), b"\x1b[Z".to_vec());
    assert_eq!(encode_key(key(KeyCode::F(5), KeyModifiers::NONE), false, 0), b"\x1b[15~".to_vec());
    assert_eq!(encode_key(key(KeyCode::Delete, KeyModifiers::NONE), false, 0), b"\x1b[3~".to_vec());
}

#[test]
fn prefix_chord_parsing() {
    let c = parse_chord("ctrl-space");
    assert!(chord_matches(&key(KeyCode::Char(' '), KeyModifiers::CONTROL), &c));
    assert!(!chord_matches(&key(KeyCode::Char(' '), KeyModifiers::NONE), &c));
    let c = parse_chord("alt-p");
    assert!(chord_matches(&key(KeyCode::Char('p'), KeyModifiers::ALT), &c));
}

#[test]
fn mouse_encoding_sgr_and_default() {
    use ratatui::crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
    let ev = MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: 0, row: 0, modifiers: KeyModifiers::NONE };
    let sgr = crate::keys::encode_mouse(&ev, 4, 2, vt100::MouseProtocolMode::PressRelease, vt100::MouseProtocolEncoding::Sgr);
    assert_eq!(sgr, Some(b"\x1b[<0;5;3M".to_vec()));
    let none = crate::keys::encode_mouse(&ev, 4, 2, vt100::MouseProtocolMode::None, vt100::MouseProtocolEncoding::Sgr);
    assert_eq!(none, None);
}

#[test]
fn masking_covers_encodings() {
    let secrets = vec![("TOKEN".to_string(), "s3cr3t-value".to_string())];
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, "s3cr3t-value");
    let out = crate::secrets::mask(&format!("a s3cr3t-value b {b64} c 73336372337420"), &secrets);
    assert!(!out.contains("s3cr3t-value"));
    assert!(!out.contains(&b64));
    assert_eq!(out.matches("[polypore:TOKEN]").count(), 2);
}

#[test]
fn allowlist_glob_and_dangerous_commands() {
    use crate::secrets::{dangerous, glob_match};
    assert!(glob_match("stripe *", "stripe customers list"));
    assert!(!glob_match("stripe *", "curl https://x"));
    assert!(glob_match("*.stripe.com", "api.stripe.com"));
    assert!(dangerous("printenv TOKEN").is_some());
    assert!(dangerous("/usr/bin/env").is_some());
    assert!(dangerous("bash -c x").is_some());
    assert!(dangerous("gh release list").is_none());
    assert!(dangerous("gh api $TOKEN").is_some());
}

#[test]
fn skill_descriptions_handle_block_scalars() {
    let d = crate::skills::description("---\nname: x\ndescription: >\n  First line\n  second line.\n---\n");
    assert_eq!(d, "First line second line.");
    let d = crate::skills::description("---\ndescription: \"Quoted one\"\n---");
    assert_eq!(d, "Quoted one");
}

#[test]
fn claude_parser_tasks_files_question_and_state() {
    let mut run = AgentRun::new(RunKey { kind: AgentKind::Claude, id: "s".into() }, "/x".into());
    let mut cur = crate::sources::claude::ClaudeCursor::default();
    let lines = [
        r#"{"type":"user","timestamp":"2026-11-08T10:00:00Z","cwd":"/p","gitBranch":"main","message":{"role":"user","content":"fix the bug"}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-08T10:00:01Z","message":{"id":"m1","model":"claude-opus-5-5","content":[{"type":"tool_use","id":"t1","name":"TaskCreate","input":{"subject":"Write test","activeForm":"Writing test"}}],"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":1000}}}"#,
        r#"{"type":"user","timestamp":"2026-11-08T10:00:02Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"Task #1 created successfully: Write test"}]},"toolUseResult":{"task":{"id":"1","subject":"Write test"}}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-08T10:00:03Z","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"TaskUpdate","input":{"taskId":"1","status":"in_progress"}},{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/p/src/a.rs","old_string":"a\nb","new_string":"a\nb\nc"}}],"stop_reason":"tool_use"}}"#,
        r#"{"type":"assistant","timestamp":"2026-11-08T10:00:04Z","message":{"id":"m3","content":[{"type":"tool_use","id":"t4","name":"AskUserQuestion","input":{"questions":[{"question":"Which approach?"}]}}]}}"#,
    ];
    for l in lines {
        crate::sources::claude::apply_line(&mut run, &mut cur, l.as_bytes());
    }
    assert_eq!(run.cwd, "/p");
    assert_eq!(run.branch, "main");
    assert_eq!(run.tasks.len(), 1);
    assert_eq!(run.tasks[0].status, TaskStatus::InProgress);
    let f = run.files.get("/p/src/a.rs").unwrap();
    assert_eq!((f.edits, f.added, f.removed), (1, 3, 2));
    assert_eq!(run.question.as_deref(), Some("Which approach?"));
    // Not running anywhere: closed, whatever the transcript says.
    assert_eq!(run.state(parse_ts("2026-11-08T10:00:05Z")), RunState::Closed);
    // Claude's own live status decides once the process is running.
    run.live_pid = Some(1);
    run.live_status = Some("waiting".into());
    assert_eq!(run.state(parse_ts("2026-11-08T10:00:05Z")), RunState::NeedsInput);
    assert_eq!(run.activity(RunState::NeedsInput), "Which approach?");
    run.live_status = Some("busy".into());
    assert_eq!(run.state(0), RunState::Working);
    run.live_status = Some("idle".into());
    assert_eq!(run.state(0), RunState::Ready);
    assert_eq!(run.ctx_tokens, 1010);
    assert!(run.now.starts_with("asking"));
}

#[test]
fn codex_parser_items_and_legacy_events() {
    let mut run = AgentRun::new(RunKey { kind: AgentKind::Codex, id: "c".into() }, "/x".into());
    let lines = [
        r#"{"timestamp":"2026-11-08T10:00:00Z","type":"session_meta","payload":{"id":"c","cwd":"/p","git":{"branch":"dev"}}}"#,
        r#"{"timestamp":"2026-11-08T10:00:01Z","type":"event_msg","payload":{"type":"task_started","model_context_window":258400}}"#,
        r#"{"timestamp":"2026-11-08T10:00:02Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","command":["bash","-lc","cargo test"],"parsed_cmd":[{"type":"read","path":"src/lib.rs"}],"exit_code":101,"duration":{"secs":2,"nanos":0}}}}"#,
        r#"{"timestamp":"2026-11-08T10:00:03Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","changes":{"/p/src/lib.rs":{"type":"update","unified_diff":"@@\n-a\n+b\n+c\n"}}}}}"#,
        r#"{"timestamp":"2026-11-08T10:00:04Z","type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"u1","arguments":"{\"plan\":[{\"step\":\"one\",\"status\":\"completed\"},{\"step\":\"two\",\"status\":\"in_progress\"}]}"}}"#,
        r#"{"timestamp":"2026-11-08T10:00:05Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":50000},"model_context_window":258400},"rate_limits":{"primary":{"used_percent":42.0,"window_minutes":300,"resets_at":0}}}}"#,
        r#"{"timestamp":"2026-11-08T10:00:06Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done","duration_ms":6000}}"#,
    ];
    for l in lines {
        crate::sources::codex::apply_line(&mut run, l.as_bytes());
    }
    assert_eq!(run.cwd, "/p");
    assert_eq!(run.branch, "dev");
    assert_eq!(run.cmds.len(), 1);
    assert_eq!(run.cmds[0].ok, Some(false));
    assert_eq!(run.cmds[0].duration_ms, Some(2000));
    let f = run.files.get("/p/src/lib.rs").unwrap();
    assert_eq!((f.reads, f.edits, f.added, f.removed), (1, 1, 2, 1));
    assert_eq!(run.tasks_done(), (1, 2));
    assert_eq!(run.rate_limits.as_ref().unwrap().primary.as_ref().unwrap().used_percent, 42.0);
    assert!(!run.turn_open);
    assert_eq!(run.last_reply, "done");
    assert!(run.ctx_percent().unwrap() > 19.0);
}

#[test]
fn tail_lines_skips_partial_final_line() {
    let dir = std::env::temp_dir().join(format!("polypore-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("t.jsonl");
    std::fs::write(&p, "one\ntwo\nthr").unwrap();
    let mut off = 0;
    let mut got = Vec::new();
    crate::sources::tail_lines(&p, &mut off, |l| got.push(String::from_utf8_lossy(l).to_string())).unwrap();
    assert_eq!(got, vec!["one", "two"]);
    std::fs::write(&p, "one\ntwo\nthree\nfour\n").unwrap();
    got.clear();
    crate::sources::tail_lines(&p, &mut off, |l| got.push(String::from_utf8_lossy(l).to_string())).unwrap();
    assert_eq!(got, vec!["three", "four"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn env_parsing_and_import_rewrites_without_values() {
    let dir = std::env::temp_dir().join(format!("polypore-env-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".env"), "# c\nA=1\nexport B=\"two words\"\nC='x' \n9BAD=1\n").unwrap();
    let keys = crate::secrets::env_file_keys(&dir);
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].1, vec!["A", "B", "C"]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn animations_load_and_cycle() {
    for name in ["spark", "orbit", "pulse", "bars", "wave", "dna", "prompt", "dots", "moon"] {
        let a = crate::anim::builtin(name);
        assert!(!a.frames.is_empty(), "{name}");
        assert!(a.width <= 9 && a.height <= 3, "{name} fits a card: {}x{}", a.width, a.height);
        let still = a.frame(0, false);
        assert!(!still.is_empty(), "{name} has a resting frame");
    }
    let custom = crate::anim::parse_file("fps: 4\n(o_o)\n---\n(-_-)\n").unwrap();
    assert_eq!(custom.frames.len(), 2);
    assert_eq!(custom.fps, 4);
}

#[test]
fn ago_and_rel_path() {
    assert_eq!(ago(10_000, 5_000), "5s");
    assert_eq!(ago(7_200_000, 0), "-");
    assert_eq!(rel_path("/p/src/a.rs", "/p"), "src/a.rs");
    assert_eq!(
        rel_path("/tmp/claude-1000/-home-me-p/0fa256fb-ec80/scratchpad/shots/s1.png", "/p"),
        "scratchpad/shots/s1.png",
        "agent scratch folders fold to what is inside them"
    );
    assert_eq!(rel_path("/tmp/other/file.txt", "/p"), "/tmp/other/file.txt");
}

#[test]
fn quota_drops_windows_that_already_reset() {
    let now = 1_800_000_000_000i64; // ms
    let w = |pct: f64, mins: u64, resets_s: i64| RateWindow { used_percent: pct, window_minutes: mins, resets_at: resets_s };
    let rl = RateLimits {
        primary: Some(w(7.0, 300, now / 1000 - 60)),           // reset a minute ago
        secondary: Some(w(21.0, 10_080, now / 1000 + 3600)),   // resets in an hour
        plan: String::new(),
        ts: now - 2 * 86_400_000,
    };
    let q = crate::quota::from_rollout(&rl);
    let cur = q.current(now);
    assert_eq!(cur.len(), 1, "the 5h window already reset, so only the week is current");
    assert_eq!(cur[0].name, "week");
    // No reset time: the window is taken to end one window after the record.
    let old = RateLimits { primary: Some(w(50.0, 300, 0)), secondary: None, plan: String::new(), ts: now - 145 * 86_400_000 };
    assert!(crate::quota::from_rollout(&old).current(now).is_empty(), "a 145-day-old 5h reading is not current");
}

#[test]
fn quota_reads_omarchy_and_anthropic_and_keeps_the_freshest() {
    use crate::quota::*;
    let om = r#"{"limits":[{"label":"Session (5-hour)","percent":0.64,"resetsAt":"2026-11-09T01:10:00+00:00"},{"label":"Weekly (7-day)","percent":0.79,"resetsAt":"2026-11-12T03:00:00+00:00"},{"label":"Fable Weekly","title":"Fable Weekly","percent":0.1,"resetsAt":"2026-11-12T03:00:00+00:00"}],"limitsFetchedAt":1794178190304,"limitsStale":false,"tierLabel":"Pro"}"#;
    let q = parse_omarchy(om, AgentKind::Claude).unwrap();
    assert_eq!(q.plan, "Pro");
    assert_eq!(q.windows.len(), 2, "per-model side buckets are left out");
    assert_eq!((q.windows[0].name.as_str(), q.windows[0].used.round()), ("5h", 64.0));
    assert_eq!(q.windows[1].name, "week");
    assert_eq!(q.windows[1].window_ms, 7 * 86_400_000);
    assert!(parse_omarchy(&om.replace("\"limitsStale\":false", "\"limitsStale\":true"), AgentKind::Claude).is_none(), "stale records are ignored");
    assert_eq!(window_from_label("720h window").map(|w| w.0), Some("30d".to_string()));
    let api = r#"{"five_hour":{"utilization":12.0,"resets_at":"2026-11-09T01:10:00+00:00"},"seven_day":{"utilization":40,"resets_at":"2026-11-12T03:00:00Z"},"seven_day_opus":null}"#;
    let a = parse_claude_usage(api, 1_794_200_000_000).unwrap();
    assert_eq!(a.windows.iter().map(|w| w.name.as_str()).collect::<Vec<_>>(), vec!["5h", "week"]);
    let best = freshest(vec![q.clone(), a.clone()]);
    assert_eq!(best.len(), 1);
    assert_eq!(best[0].source, "anthropic", "the newer measurement wins");
}

#[test]
fn quota_pace_projects_running_out_before_reset() {
    use crate::quota::*;
    let h = 3_600_000i64;
    let w = QWindow { name: "5h".into(), used: 60.0, resets_at: 3 * h, window_ms: 5 * h };
    // now = 1h in... 2h into the window (start at -2h): 60% in 2h, 40% left at 30%/h = 1h20m
    assert_eq!(w.pace(0), Pace::RunsOut(80 * 60_000));
    let slow = QWindow { used: 10.0, ..w.clone() };
    assert_eq!(slow.pace(0), Pace::Fine);
    let fresh = QWindow { used: 1.0, resets_at: 5 * h - 60_000, ..w };
    assert_eq!(fresh.pace(0), Pace::Unknown, "a minute into the window says nothing yet");
    assert_eq!(span(3 * h + 20 * 60_000), "3h 20m");
}

#[test]
fn hunks_parse_and_rebuild_single_hunk_patches() {
    let diff = "diff --git a/src/x.rs b/src/x.rs\nindex 1..2 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -1,3 +1,3 @@ fn main\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n y\n+z\n w\ndiff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n";
    let files = crate::hunks::parse(diff, false);
    assert_eq!(files.len(), 2);
    let f = &files[0];
    assert_eq!(f.path, "src/x.rs");
    assert_eq!(f.hunks.len(), 2);
    assert_eq!((f.hunks[0].added, f.hunks[0].removed, f.hunks[0].new_start), (1, 1, 1));
    assert_eq!(f.hunks[1].new_start, 10);
    assert!(files[1].binary);
    let p = crate::hunks::patch(f, &f.hunks[1]);
    assert!(p.starts_with("diff --git a/src/x.rs b/src/x.rs\nindex 1..2 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -10,2 +10,3 @@\n"));
    assert!(!p.contains("-b"), "a hunk's patch carries only that hunk");
    let items = crate::hunks::items(&files, Some(&["img.png".to_string()]));
    assert_eq!(items, vec![crate::hunks::Item::File(1)]);
}

#[test]
fn hunks_stage_and_revert_in_a_real_repo() {
    let dir = std::env::temp_dir().join(format!("polypore-hunks-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let d = dir.to_string_lossy().to_string();
    let git = |args: &[&str]| std::process::Command::new("git").arg("-C").arg(&d).args(args).output().unwrap();
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    let body: String = (1..=30).map(|i| format!("line {i}\n")).collect();
    std::fs::write(dir.join("f.txt"), &body).unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "init"]);
    std::fs::write(dir.join("f.txt"), body.replace("line 2\n", "line two\n").replace("line 28\n", "line twenty-eight\n")).unwrap();
    let files = crate::hunks::load(&d);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].hunks.len(), 2, "two separate changes are two hunks");
    crate::hunks::toggle_stage(&d, &files[0], &files[0].hunks[0]).unwrap();
    let after = crate::hunks::load(&d);
    let staged: Vec<_> = after.iter().filter(|f| f.staged).collect();
    let unstaged: Vec<_> = after.iter().filter(|f| !f.staged).collect();
    assert_eq!((staged.len(), unstaged.len()), (1, 1));
    assert_eq!(staged[0].hunks.len(), 1);
    crate::hunks::revert(&d, unstaged[0], &unstaged[0].hunks[0]).unwrap();
    let text = std::fs::read_to_string(dir.join("f.txt")).unwrap();
    assert!(text.contains("line two") && text.contains("line 28\n"), "reverting one hunk keeps the other");
    assert!(crate::hunks::revert(&d, staged[0], &staged[0].hunks[0]).is_err(), "a staged hunk is unstaged before it can be reverted");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn search_needs_every_term_and_ranks_titles_first() {
    use crate::search::*;
    let doc = |id: &str, title: &str, prompts: &str, replies: &str, mtime: i64| Doc {
        key: RunKey { kind: AgentKind::Claude, id: id.into() },
        path: std::path::PathBuf::from(format!("/x/{id}.jsonl")),
        size: 1,
        root: "/home/me/Dev/polypore".into(),
        cwd: "/home/me/Dev/polypore".into(),
        title: title.into(),
        mtime,
        prompts: prompts.into(),
        replies: replies.into(),
        files: vec!["tui/src/pane.rs".into()],
    };
    let now = 1_800_000_000_000;
    let docs = vec![
        doc("a", "Fix the PTY server", "make sessions survive", "", now - 86_400_000),
        doc("b", "Theme work", "the pty dies on quit", "Fixed the pty", now),
        doc("c", "Unrelated", "nothing here", "", now),
    ];
    let hits = query(&docs, "PTY", now, 10);
    assert_eq!(hits.iter().map(|h| docs[h.doc].key.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"], "title matches outrank prompt matches");
    assert!(query(&docs, "pty quit", now, 10).iter().all(|h| docs[h.doc].key.id == "b"), "every term must match");
    assert_eq!(query(&docs, "pane.rs", now, 10).len(), 3, "files touched are searched");
    assert_eq!(find_ci("Hello Wörld", "wö"), Some(6));
    assert_eq!(find_ci("Hello WÖrld", "wö"), None, "case folding is ASCII only; Ö must match as written");
    assert_eq!(find_ci("Hello World", "world"), Some(6));
}

#[test]
fn worktree_slugs_and_main_repo() {
    assert_eq!(crate::worktree::slug("Fix the PTY server!"), "fix-the-pty-server");
    assert_eq!(crate::worktree::slug("feat/quota pace"), "feat/quota-pace");
    assert_eq!(crate::worktree::slug("  !!! "), "session");
    let dir = std::env::temp_dir().join(format!("polypore-wt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(".git"), "gitdir: /home/me/Dev/app/.git/worktrees/fix\n").unwrap();
    assert_eq!(crate::worktree::main_repo_of(&dir).as_deref(), Some("/home/me/Dev/app"));
    std::fs::write(dir.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
    assert_eq!(crate::worktree::main_repo_of(&dir), None, "submodules are their own project");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn agent_commands_for_resume_fork_and_prompt() {
    use crate::app::{agent_command, Launch};
    use crate::pane::PaneKind;
    let cfg = crate::config::Config::default();
    let k = |kind| RunKey { kind, id: "abc".into() };
    assert_eq!(agent_command(&cfg, PaneKind::Claude, &Launch::default()).unwrap(), "claude");
    assert_eq!(agent_command(&cfg, PaneKind::Claude, &Launch::resume(k(AgentKind::Claude))).unwrap(), "claude --resume abc");
    assert_eq!(agent_command(&cfg, PaneKind::Claude, &Launch { resume: Some(k(AgentKind::Claude)), fork: true, ..Default::default() }).unwrap(), "claude --resume abc --fork-session");
    assert_eq!(agent_command(&cfg, PaneKind::Codex, &Launch { resume: Some(k(AgentKind::Codex)), fork: true, ..Default::default() }).unwrap(), "codex fork abc");
    let job = RunKey { kind: AgentKind::Claude, id: "cdeb890f-6a4f-422f-be76-36471b6c2631".into() };
    assert_eq!(agent_command(&cfg, PaneKind::Claude, &Launch { resume: Some(job), attach: true, args: "--permission-mode plan".into(), ..Default::default() }).unwrap(), "claude attach cdeb890f");
    assert_eq!(agent_command(&cfg, PaneKind::Codex, &Launch { resume: Some(k(AgentKind::Codex)), prompt: Some("go on, it's fine".into()), ..Default::default() }).unwrap(), "codex resume abc 'go on, it'\\''s fine'");
    assert_eq!(agent_command(&cfg, PaneKind::Shell, &Launch::default()), None);
    assert_eq!(agent_command(&cfg, PaneKind::Claude, &Launch { args: "--permission-mode plan".into(), prompt: Some("hi".into()), ..Default::default() }).unwrap(), "claude --permission-mode plan hi");
}

#[test]
fn tracker_reports_only_real_changes() {
    use crate::cli::Tracker;
    let mut snap = crate::store::Snapshot::default();
    let key = RunKey { kind: AgentKind::Claude, id: "s1".into() };
    let mut run = AgentRun::new(key.clone(), "/x".into());
    run.live_pid = Some(1);
    run.live_status = Some("busy".into());
    snap.runs.insert(key.clone(), std::sync::Arc::new(run.clone()));
    let mut t = Tracker::default();
    let none = std::collections::HashSet::new();
    assert!(t.step(&snap, &none, 0).is_empty(), "the first sighting is not a change");
    run.live_status = Some("waiting".into());
    snap.runs.insert(key.clone(), std::sync::Arc::new(run.clone()));
    let c = t.step(&snap, &none, 0);
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].from, c[0].to), (RunState::Working, RunState::NeedsInput));
    assert!(t.step(&snap, &none, 0).is_empty());
}

#[test]
fn status_filter_and_handoff_note() {
    use crate::app::StatusFilter;
    assert!(StatusFilter::All.admits_pub(4, false));
    assert!(!StatusFilter::All.admits_pub(4, true), "archived sessions stay out of the normal list");
    assert!(StatusFilter::Archived.admits_pub(4, true));
    assert!(StatusFilter::Needs.admits_pub(0, false) && !StatusFilter::Needs.admits_pub(1, false));
    let mut run = AgentRun::new(RunKey { kind: AgentKind::Claude, id: "abc".into() }, "/t/abc.jsonl".into());
    run.cwd = "/p".into();
    run.goal = "ship the server".into();
    run.push_event(1, EvKind::Prompt, "make sessions survive");
    run.tasks.push(Task { id: "1".into(), subject: "write server.rs".into(), active: String::new(), status: TaskStatus::InProgress });
    run.touch_file("/p/src/server.rs", 2, |f| {
        f.writes = 1;
        f.added = 600;
    });
    run.last_reply = "Server is up.".into();
    let note = crate::handoff::note(&run, "PTY server");
    for want in ["# Handoff: PTY server", "## Goal\n\nship the server", "make sessions survive", "- [~] write server.rs", "src/server.rs (+600 -0)", "Server is up.", "/t/abc.jsonl"] {
        assert!(note.contains(want), "handoff note is missing {want:?}:\n{note}");
    }
}

#[cfg(unix)]
#[test]
fn server_refuses_a_socket_folder_others_can_enter() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("polypore-sock-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::server::check_private_pub(&dir.join("server.sock")).is_err(), "a folder others can read is refused");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(crate::server::check_private_pub(&dir.join("server.sock")).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn presets_come_from_the_project_and_the_config() {
    use crate::config::{Config, Preset};
    let dir = std::env::temp_dir().join(format!("polypore-presets-{}", std::process::id()));
    std::fs::create_dir_all(dir.join(".polypore")).unwrap();
    std::fs::write(dir.join(".polypore/presets.toml"), "[[presets]]\nname = \"local\"\nargs = \"--model opus\"\n").unwrap();
    let root = dir.to_string_lossy().to_string();
    let mut cfg = Config::default();
    cfg.presets = vec![
        Preset { name: "plan".into(), agent: "claude".into(), args: "--permission-mode plan".into(), ..Default::default() },
        Preset { name: "elsewhere".into(), agent: "claude".into(), project: "some-other-project".into(), ..Default::default() },
        Preset { name: "fast codex".into(), agent: "codex".into(), worktree: true, ..Default::default() },
    ];
    let names = |a: &str| cfg.presets_for(&root, a).into_iter().map(|p| p.name).collect::<Vec<_>>();
    assert_eq!(names("claude"), vec!["local", "plan"], "project presets first; an empty agent means claude; other projects' presets stay out");
    assert_eq!(names("codex"), vec!["fast codex"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn server_frames_round_trip() {
    let f = crate::server::frame_pub(3, 42, b"hello");
    let mut r = std::io::Cursor::new(f);
    let (tag, pane, body) = crate::server::read_frame_pub(&mut r).unwrap();
    assert_eq!((tag, pane, body.as_slice()), (3, 42, b"hello".as_slice()));
    let mut short = std::io::Cursor::new(vec![0u8, 0, 0, 2, 1, 2]);
    assert!(crate::server::read_frame_pub(&mut short).is_err(), "a frame shorter than its header is refused");
}

#[test]
fn plain_strips_markdown() {
    assert_eq!(plain("**Done.** Ran `cargo test`\n- all green"), "Done. Ran cargo test all green");
}

#[test]
fn file_tree_marks_touched_and_collapses_chains() {
    use crate::tree::{rows, Mark, TreeState};
    let files: Vec<String> = ["src/app.rs", "src/ui.rs", "src/sources/claude.rs", "docs/a.md", "README.md"].iter().map(|s| s.to_string()).collect();
    let mut marks = std::collections::HashMap::new();
    marks.insert("src/sources/claude.rs".to_string(), Mark { added: 3, removed: 1, changed: true, read: false });
    marks.insert("README.md".to_string(), Mark { read: true, ..Default::default() });
    // touched-only: just the touched files and their folders, opened
    let st = TreeState::default();
    let r = rows(&files, &marks, &st);
    let names: Vec<&str> = r.iter().map(|x| x.name.as_str()).collect();
    assert_eq!(names, vec!["src/sources", "claude.rs", "README.md"]);
    assert!(r[0].dir && r[0].open && r[0].changed_below == 1);
    // all files: untouched folders start closed, touched ones open
    let st = TreeState { all: true, ..Default::default() };
    let r = rows(&files, &marks, &st);
    let docs = r.iter().find(|x| x.name == "docs").unwrap();
    assert!(!docs.open);
    let src = r.iter().find(|x| x.name == "src").unwrap();
    assert!(src.open);
    assert!(r.iter().any(|x| x.name == "claude.rs" && x.mark.changed));
}

#[test]
fn mascot_rows_have_stable_width() {
    for mood in [crate::art::Mood::Idle, crate::art::Mood::Busy, crate::art::Mood::Alert, crate::art::Mood::Watch] {
        for tick in [0u64, 777, 4200, 9000] {
            for (_, row) in crate::art::mascot(mood, tick) {
                assert_eq!(unicode_width::UnicodeWidthStr::width(row.as_str()), crate::art::MASCOT_W as usize, "{mood:?} {row:?}");
            }
        }
    }
}

#[test]
fn typed_project_paths_resolve_from_home() {
    let home = dirs::home_dir().unwrap();
    assert_eq!(crate::app::project_path("Dev/NewProject"), home.join("Dev/NewProject"));
    assert_eq!(crate::app::project_path("~/Dev/NewProject/"), home.join("Dev/NewProject"));
    assert_eq!(crate::app::project_path("~"), home);
    assert_eq!(crate::app::project_path("/srv/thing"), std::path::PathBuf::from("/srv/thing"));
    assert!(crate::app::project_path("  ".trim()).as_os_str().is_empty());
}

#[test]
fn pane_links_to_the_claude_session_that_has_a_transcript() {
    use crate::procs::{pick_claude_session, ClaudeCand};
    let c = |id: &str, updated: i64, has_transcript: bool| ClaudeCand { id: id.into(), cwd: "/p".into(), updated, has_transcript };
    // Plain claude in a pane: its own session.
    assert_eq!(pick_claude_session(&[c("own", 5, true), c("job", 9, true)]).as_deref(), Some("own"));
    // The prompt went to a background job: the front session stays empty.
    assert_eq!(pick_claude_session(&[c("own", 5, false), c("spare", 9, false), c("job1", 6, true), c("job2", 8, true)]).as_deref(), Some("job2"));
    // Nothing written yet anywhere: keep the pane's own session.
    assert_eq!(pick_claude_session(&[c("own", 5, false), c("spare", 9, false)]).as_deref(), Some("own"));
    assert_eq!(pick_claude_session(&[]), None);
    // The daemon's workers for other projects are descendants too; they
    // never claim the pane.
    let elsewhere = ClaudeCand { id: "other-project".into(), cwd: "/q".into(), updated: 99, has_transcript: true };
    assert_eq!(pick_claude_session(&[c("own", 5, false), elsewhere.clone(), c("job", 6, true)]).as_deref(), Some("job"));
    assert_eq!(pick_claude_session(&[c("own", 5, false), elsewhere]).as_deref(), Some("own"));
}

#[test]
fn proc_start_reads_field_22_past_a_spaced_command_name() {
    let stat = "4242 (Web Content x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 372451 999 0";
    assert_eq!(crate::store::proc_start_field(stat).as_deref(), Some("372451"));
    assert_eq!(crate::store::proc_start_field("garbage"), None);
    // This process, read back the way claude records it.
    let me = std::process::id();
    let mine = std::fs::read_to_string(format!("/proc/{me}/stat")).ok().and_then(|s| crate::store::proc_start_field(&s));
    if let Some(start) = mine {
        assert!(crate::store::same_process(me, &start));
        assert!(!crate::store::same_process(me, "1"), "a reused pid with another start time is not the session's");
        assert!(crate::store::same_process(me, ""), "no recorded start time: trust the pid");
    }
}

#[test]
fn problems_clear_once_fixed_or_a_new_turn_starts() {
    use crate::model::{AgentKind, AgentRun, CmdRun, EvKind, RunKey};
    let mut r = AgentRun::new(RunKey { kind: AgentKind::Claude, id: "x".into() }, std::path::PathBuf::new());
    let cmd = |r: &mut AgentRun, c: &str, ts: i64, ok: bool| r.push_cmd(CmdRun { cmd: c.into(), desc: String::new(), ts, ok: Some(ok), background: false, duration_ms: None });
    r.push_event(100, EvKind::Prompt, "fix the build");
    cmd(&mut r, "cargo build", 110, false);
    cmd(&mut r, "grep -n missing src/app.rs", 115, false);
    cmd(&mut r, "cargo test", 120, false);
    cmd(&mut r, "cargo test", 125, false);
    cmd(&mut r, "cargo build", 130, true);
    let p = r.open_problems(200);
    assert_eq!(p.len(), 1, "the build was fixed and grep only found nothing: {p:?}");
    assert_eq!((p[0].0.as_str(), p[0].1), ("cargo test", 2));
    // The next prompt starts clean.
    r.push_event(300, EvKind::Prompt, "now the docs");
    assert!(r.open_problems(400).is_empty());
    // Between tool calls the working line says what it just did.
    r.push_event(310, EvKind::Tool, "reading README.md");
    r.turn_open = true;
    assert_eq!(r.activity(crate::model::RunState::Working), "thinking · last: reading README.md");
}
