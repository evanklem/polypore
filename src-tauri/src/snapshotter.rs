use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::async_runtime::{self, JoinHandle};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::{mpsc, Mutex as TokioMutex};

use crate::persistence;

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRecord {
    pub worktree_id: String,
    pub commit_hash: String,
    pub parent_commit: Option<String>,
    pub ts: i64,
    pub kind: String,
    pub ref_name: String,
}

#[derive(Clone, Copy, Debug)]
pub enum SnapshotKind {
    Bootstrap,
    Interactive,
    Autonomous,
    Manual,
    Heartbeat,
}

impl SnapshotKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Interactive => "interactive",
            Self::Autonomous => "autonomous",
            Self::Manual => "manual",
            Self::Heartbeat => "heartbeat",
        }
    }

    pub fn from_str(raw: &str) -> Self {
        match raw {
            "interactive" => Self::Interactive,
            "autonomous" => Self::Autonomous,
            "heartbeat" => Self::Heartbeat,
            "bootstrap" => Self::Bootstrap,
            _ => Self::Manual,
        }
    }
}

pub fn ref_name(worktree_id: &str) -> String {
    format!("refs/polypore/snapshots/{}", sanitize_id(worktree_id))
}

fn worktree_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(worktree_id: &str) -> Arc<Mutex<()>> {
    let mut map = worktree_locks().lock().expect("worktree locks poisoned");
    map.entry(worktree_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn sanitize_id(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/* Take a content-addressed snapshot of the working tree on a hidden git ref.
Procedure:
  1. Fresh temp index (under .git, isolated from the user's real index).
  2. `git add -A` populates the temp index from the working tree, honoring
     .gitignore and capturing additions, modifications, and deletions.
  3. `git write-tree` produces a tree hash.
  4. `git commit-tree` makes a commit pointing at that tree, parented by the
     current snapshot ref (if any).
  5. `git update-ref refs/polypore/snapshots/{id}` advances the ref.

The objects live in the shared git object store, so multiple worktrees in the
same repo benefit from dedup. */
pub fn take_snapshot(
    worktree_path: &Path,
    worktree_id: &str,
    kind: SnapshotKind,
) -> Result<SnapshotRecord, String> {
    let lock_arc = lock_for(worktree_id);
    let _guard = lock_arc.lock().expect("snapshot lock poisoned");

    let snap_t0 = Instant::now();
    eprintln!(
        "polypore: [snap-start] {} kind={}",
        worktree_id,
        kind.as_str()
    );

    let git_dir = git_dir(worktree_path)?;
    let temp_index = git_dir.join(format!("polypore-snap-{}.idx", sanitize_id(worktree_id)));
    let _ = std::fs::remove_file(&temp_index);

    let add_t0 = Instant::now();
    run_git_with_index(worktree_path, &temp_index, &["add", "-A"])?;
    eprintln!("polypore: [snap-add-A] {}ms", add_t0.elapsed().as_millis());

    let tree = run_git_capture_with_index(worktree_path, &temp_index, &["write-tree"])?
        .trim()
        .to_string();

    let parent = current_ref(worktree_path, worktree_id);

    let ts = now_ms();
    let message = format!("polypore snap {} @ {}", kind.as_str(), ts);
    let mut commit_args: Vec<String> = vec!["commit-tree".into(), tree.clone()];
    if let Some(ref p) = parent {
        commit_args.push("-p".into());
        commit_args.push(p.clone());
    }
    commit_args.push("-m".into());
    commit_args.push(message);

    let commit = run_git_capture(worktree_path, &commit_args)?
        .trim()
        .to_string();

    let ref_n = ref_name(worktree_id);
    run_git_quiet(worktree_path, &["update-ref", &ref_n, &commit])?;

    let _ = std::fs::remove_file(&temp_index);

    eprintln!(
        "polypore: [snap-done] {} total={}ms",
        worktree_id,
        snap_t0.elapsed().as_millis()
    );
    Ok(SnapshotRecord {
        worktree_id: worktree_id.to_string(),
        commit_hash: commit,
        parent_commit: parent,
        ts,
        kind: kind.as_str().to_string(),
        ref_name: ref_n,
    })
}

pub fn current_snapshot_commit(worktree_path: &Path, worktree_id: &str) -> Option<String> {
    current_ref(worktree_path, worktree_id)
}

fn git_dir(worktree_path: &Path) -> Result<PathBuf, String> {
    let out = run_git_capture(
        worktree_path,
        &["rev-parse".to_string(), "--git-dir".to_string()],
    )?;
    let trimmed = out.trim();
    let path = Path::new(trimmed);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        Ok(worktree_path.join(trimmed))
    }
}

fn current_ref(worktree_path: &Path, worktree_id: &str) -> Option<String> {
    let ref_n = ref_name(worktree_id);
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "--quiet", &ref_n])
        .current_dir(worktree_path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

fn run_git_capture(worktree_path: &Path, args: &[String]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_git_quiet(worktree_path: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn run_git_with_index(
    worktree_path: &Path,
    temp_index: &Path,
    args: &[&str],
) -> Result<(), String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .env("GIT_INDEX_FILE", temp_index)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(())
}

fn run_git_capture_with_index(
    worktree_path: &Path,
    temp_index: &Path,
    args: &[&str],
) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(worktree_path)
        .env("GIT_INDEX_FILE", temp_index)
        .output()
        .map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotDecision {
    Snapshot(SnapshotKind),
    Wait,
}

impl PartialEq for SnapshotKind {
    fn eq(&self, other: &Self) -> bool {
        self.as_str() == other.as_str()
    }
}
impl Eq for SnapshotKind {}

/* Pure policy that decides whether to snapshot now. The runtime feeds it
write timestamps, snapshot timestamps, and trigger events, then asks for a
decision. Defaults: 5s debounce, 30s gate between autonomous snapshots,
10min heartbeat that overrides the gate when activity is sustained. */
#[derive(Debug, Clone)]
pub struct SchedulerPolicy {
    pub debounce_ms: i64,
    pub min_gap_ms: i64,
    pub heartbeat_ms: i64,
    last_snapshot_ms: Option<i64>,
    last_write_ms: Option<i64>,
}

impl Default for SchedulerPolicy {
    fn default() -> Self {
        Self {
            debounce_ms: 5_000,
            min_gap_ms: 30_000,
            heartbeat_ms: 600_000,
            last_snapshot_ms: None,
            last_write_ms: None,
        }
    }
}

impl SchedulerPolicy {
    pub fn note_write(&mut self, now_ms: i64) {
        self.last_write_ms = Some(now_ms);
    }

    pub fn note_snapshot(&mut self, now_ms: i64) {
        self.last_snapshot_ms = Some(now_ms);
    }

    /* Background tick: take a snapshot iff there is fresh activity that has
    settled past the debounce, the gate has cleared, OR the heartbeat tripped. */
    pub fn evaluate_autonomous(&self, now_ms: i64) -> SnapshotDecision {
        let Some(last_write) = self.last_write_ms else {
            return SnapshotDecision::Wait;
        };
        if let Some(last_snap) = self.last_snapshot_ms {
            if last_write <= last_snap {
                return SnapshotDecision::Wait;
            }
            let since_snap = now_ms - last_snap;
            if since_snap >= self.heartbeat_ms {
                return SnapshotDecision::Snapshot(SnapshotKind::Heartbeat);
            }
            if since_snap < self.min_gap_ms {
                return SnapshotDecision::Wait;
            }
        }
        if now_ms - last_write < self.debounce_ms {
            return SnapshotDecision::Wait;
        }
        SnapshotDecision::Snapshot(SnapshotKind::Autonomous)
    }

    /* Prompt-boundary signal: snapshot at the end of an interactive turn,
    honoring the per-worktree min-gap to avoid rapid-fire snapshots. */
    pub fn evaluate_interactive(&self, now_ms: i64) -> SnapshotDecision {
        if let Some(last_snap) = self.last_snapshot_ms {
            let since = now_ms - last_snap;
            if since < self.min_gap_ms {
                return SnapshotDecision::Wait;
            }
        }
        SnapshotDecision::Snapshot(SnapshotKind::Interactive)
    }
}

/* Per-worktree scheduler. Spawned at project-open and any time a new
worktree is discovered. Owns the policy, a background tokio task that
periodically re-evaluates against autonomous-snapshot rules, and channels
for turn-end + write notifications from the host. */
pub struct SchedulerHandle {
    pub worktree_path: PathBuf,
    policy: Arc<TokioMutex<SchedulerPolicy>>,
    turn_end_tx: mpsc::UnboundedSender<()>,
    write_tx: mpsc::UnboundedSender<()>,
    _task: JoinHandle<()>,
}

#[derive(Default)]
pub struct SnapshotterRegistry {
    inner: Mutex<HashMap<String, Arc<SchedulerHandle>>>,
    /* Shared suppression gate. When set to a future epoch-ms timestamp,
    all scheduler ticks skip `git add -A` until that time passes.
    Used to prevent snapshot I/O from competing with sash drag events. */
    suppress_until_ms: Arc<AtomicI64>,
}

impl SnapshotterRegistry {
    pub fn ensure<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        worktree_id: String,
        worktree_path: PathBuf,
    ) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "snapshot registry poisoned".to_string())?;
        if guard.contains_key(&worktree_id) {
            return Ok(());
        }
        let handle = spawn_scheduler(
            app.clone(),
            worktree_id.clone(),
            worktree_path,
            Arc::clone(&self.suppress_until_ms),
        )?;
        guard.insert(worktree_id, Arc::new(handle));
        Ok(())
    }

    pub fn suppress_until(&self, until_ms: i64) {
        self.suppress_until_ms.store(until_ms, Ordering::Relaxed);
    }

    pub fn note_write(&self, worktree_id: &str) {
        if let Ok(guard) = self.inner.lock() {
            if let Some(h) = guard.get(worktree_id) {
                let _ = h.write_tx.send(());
            }
        }
    }

    pub fn trigger_turn_end(&self, worktree_id: &str) {
        if let Ok(guard) = self.inner.lock() {
            if let Some(h) = guard.get(worktree_id) {
                let _ = h.turn_end_tx.send(());
            }
        }
    }

    /* The manual-snapshot path goes through `snapshot_take` which needs to
    feed `last_snapshot_ms` back into the registered policy. Without that,
    the per-worktree min-gap can't see manual snapshots and the next
    autonomous tick could pile a second snapshot on top of a fresh one. */
    pub fn policy_for(&self, worktree_id: &str) -> Option<Arc<TokioMutex<SchedulerPolicy>>> {
        self.inner
            .lock()
            .ok()
            .and_then(|guard| guard.get(worktree_id).map(|h| h.policy.clone()))
    }
}

fn spawn_scheduler<R: Runtime>(
    app: AppHandle<R>,
    worktree_id: String,
    worktree_path: PathBuf,
    suppress_until_ms: Arc<AtomicI64>,
) -> Result<SchedulerHandle, String> {
    let policy = Arc::new(TokioMutex::new(SchedulerPolicy::default()));
    let (turn_end_tx, mut turn_end_rx) = mpsc::unbounded_channel::<()>();
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<()>();
    let policy_runtime = policy.clone();
    let wt_id_runtime = worktree_id.clone();
    let wt_path_runtime = worktree_path.clone();
    let app_runtime = app.clone();

    let task = async_runtime::spawn(async move {
        let app = app_runtime;
        let wt_id = wt_id_runtime;
        let wt_path = wt_path_runtime;
        let policy = policy_runtime;

        /* Bootstrap snapshot if the ref doesn't exist yet. */
        if current_snapshot_commit(&wt_path, &wt_id).is_none() {
            if let Err(err) =
                snapshot_and_emit(&app, &wt_path, &wt_id, SnapshotKind::Bootstrap, &policy).await
            {
                eprintln!("polypore: bootstrap snapshot failed for {wt_id}: {err}");
            }
        }

        let mut tick = tokio::time::interval(Duration::from_secs(5));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = tick.tick() => {
                    /* Skip if the caller has requested suppression (e.g. sash drag in flight).
                       git add -A competes with WebKitGTK's IPC socket under Linux I/O load. */
                    if now_ms() < suppress_until_ms.load(Ordering::Relaxed) {
                        continue;
                    }
                    let decision = {
                        let p = policy.lock().await;
                        p.evaluate_autonomous(now_ms())
                    };
                    if let SnapshotDecision::Snapshot(kind) = decision {
                        if let Err(err) = snapshot_and_emit(&app, &wt_path, &wt_id, kind, &policy).await {
                            eprintln!("polypore: autonomous snapshot failed for {wt_id}: {err}");
                        }
                    }
                }
                Some(()) = turn_end_rx.recv() => {
                    let decision = {
                        let p = policy.lock().await;
                        p.evaluate_interactive(now_ms())
                    };
                    if let SnapshotDecision::Snapshot(kind) = decision {
                        if let Err(err) = snapshot_and_emit(&app, &wt_path, &wt_id, kind, &policy).await {
                            eprintln!("polypore: interactive snapshot failed for {wt_id}: {err}");
                        }
                    }
                }
                Some(()) = write_rx.recv() => {
                    let mut p = policy.lock().await;
                    p.note_write(now_ms());
                }
            }
        }
    });

    Ok(SchedulerHandle {
        worktree_path,
        policy,
        turn_end_tx,
        write_tx,
        _task: task,
    })
}

async fn snapshot_and_emit<R: Runtime>(
    app: &AppHandle<R>,
    wt_path: &Path,
    wt_id: &str,
    kind: SnapshotKind,
    policy: &Arc<TokioMutex<SchedulerPolicy>>,
) -> Result<SnapshotRecord, String> {
    let wt_path_owned = wt_path.to_path_buf();
    let wt_id_owned = wt_id.to_string();
    let record =
        async_runtime::spawn_blocking(move || take_snapshot(&wt_path_owned, &wt_id_owned, kind))
            .await
            .map_err(|err| format!("snapshot task panicked: {err}"))??;

    {
        let mut p = policy.lock().await;
        p.note_snapshot(record.ts);
    }
    let _ = persistence::record_snapshot_log_row(
        &record.worktree_id,
        &record.commit_hash,
        record.ts,
        &record.kind,
    );
    let _ = app.emit("polypore://snapshot-taken", &record);
    Ok(record)
}

/* Tauri commands wiring frontend triggers into the registry. */

#[tauri::command]
pub async fn snapshot_take<R: Runtime>(
    app: AppHandle<R>,
    worktree_id: String,
    worktree_path: Option<String>,
    kind: Option<String>,
) -> Result<SnapshotRecord, String> {
    let registry = app.state::<SnapshotterRegistry>();
    let path = resolve_worktree_path(&worktree_id, worktree_path.as_deref(), &app)?;
    registry.ensure(&app, worktree_id.clone(), path.clone())?;
    let kind = kind
        .as_deref()
        .map(SnapshotKind::from_str)
        .unwrap_or(SnapshotKind::Manual);
    /* Feed the registry's per-worktree policy so the manual snapshot's
    timestamp participates in the min-gap that throttles autonomous ticks. */
    let policy = registry
        .policy_for(&worktree_id)
        .ok_or_else(|| format!("worktree '{worktree_id}' is not registered"))?;
    snapshot_and_emit(&app, &path, &worktree_id, kind, &policy).await
}

#[tauri::command]
pub fn snapshot_signal_write<R: Runtime>(app: AppHandle<R>, worktree_id: String) {
    let registry = app.state::<SnapshotterRegistry>();
    registry.note_write(&worktree_id);
}

#[tauri::command]
pub fn snapshot_signal_turn_end<R: Runtime>(app: AppHandle<R>, worktree_id: String) {
    let registry = app.state::<SnapshotterRegistry>();
    registry.trigger_turn_end(&worktree_id);
}

/* Suppress autonomous snapshot ticks for `duration_ms` milliseconds.
Call on sash-drag start (large window) and again on release (short cooldown)
to prevent git add -A from competing with WebKitGTK IPC during drag. */
#[tauri::command]
pub fn snapshot_suppress<R: Runtime>(app: AppHandle<R>, duration_ms: u64) {
    let registry = app.state::<SnapshotterRegistry>();
    registry.suppress_until(now_ms() + duration_ms as i64);
}

#[tauri::command]
pub fn snapshot_bootstrap<R: Runtime>(
    app: AppHandle<R>,
    worktrees: Vec<BootstrapWorktree>,
) -> Result<(), String> {
    let registry = app.state::<SnapshotterRegistry>();
    for wt in worktrees {
        registry.ensure(&app, wt.id, PathBuf::from(wt.path))?;
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapWorktree {
    pub id: String,
    pub path: String,
}

fn resolve_worktree_path<R: Runtime>(
    worktree_id: &str,
    worktree_path: Option<&str>,
    app: &AppHandle<R>,
) -> Result<PathBuf, String> {
    if let Some(p) = worktree_path {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    let registry = app.state::<SnapshotterRegistry>();
    let guard = registry
        .inner
        .lock()
        .map_err(|_| "registry poisoned".to_string())?;
    if let Some(h) = guard.get(worktree_id) {
        return Ok(h.worktree_path.clone());
    }
    Err(format!(
        "worktree_path not provided and worktree '{worktree_id}' is not registered"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_repo_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "polypore-snap-test-{}-{}-{}",
            std::process::id(),
            label,
            n
        ))
    }

    fn run(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn capture(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).to_string()
    }

    fn init_repo(label: &str) -> PathBuf {
        let dir = unique_repo_dir(label);
        std::fs::create_dir_all(&dir).unwrap();
        run(&dir, &["init", "-q", "-b", "main"]);
        run(&dir, &["config", "user.email", "test@polypore.local"]);
        run(&dir, &["config", "user.name", "polypore-test"]);
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        run(&dir, &["add", "."]);
        run(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn first_snapshot_has_no_parent_and_captures_working_tree() {
        let repo = init_repo("first");
        std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
        let wt = "wt-test-first";

        let snap = take_snapshot(&repo, wt, SnapshotKind::Bootstrap).unwrap();
        assert!(snap.parent_commit.is_none());
        assert_eq!(snap.kind, "bootstrap");

        let listing = capture(&repo, &["ls-tree", "-r", "--name-only", &snap.commit_hash]);
        let names: Vec<&str> = listing.lines().collect();
        assert!(names.contains(&"README.md"), "missing README: {listing}");
        assert!(names.contains(&"new.txt"), "missing new.txt: {listing}");

        let ref_value = capture(&repo, &["rev-parse", &ref_name(wt)]);
        assert_eq!(ref_value.trim(), snap.commit_hash);

        cleanup(&repo);
    }

    #[test]
    fn second_snapshot_parents_first() {
        let repo = init_repo("second");
        let wt = "wt-test-second";
        let s1 = take_snapshot(&repo, wt, SnapshotKind::Bootstrap).unwrap();
        std::fs::write(repo.join("README.md"), "changed\n").unwrap();
        let s2 = take_snapshot(&repo, wt, SnapshotKind::Autonomous).unwrap();

        assert_eq!(s2.parent_commit.as_deref(), Some(s1.commit_hash.as_str()));
        assert_ne!(s1.commit_hash, s2.commit_hash);

        cleanup(&repo);
    }

    #[test]
    fn snapshot_captures_deletions() {
        let repo = init_repo("delete");
        let wt = "wt-test-delete";
        let _ = take_snapshot(&repo, wt, SnapshotKind::Bootstrap).unwrap();
        std::fs::remove_file(repo.join("README.md")).unwrap();
        let s2 = take_snapshot(&repo, wt, SnapshotKind::Manual).unwrap();

        let listing = capture(&repo, &["ls-tree", "-r", "--name-only", &s2.commit_hash]);
        assert!(
            !listing.lines().any(|n| n == "README.md"),
            "README should be absent in snapshot 2: {listing}"
        );
        cleanup(&repo);
    }

    #[test]
    fn snapshot_respects_gitignore() {
        let repo = init_repo("ignore");
        let wt = "wt-test-ignore";
        std::fs::write(repo.join(".gitignore"), "ignored.txt\n").unwrap();
        std::fs::write(repo.join("ignored.txt"), "should not be snapshotted\n").unwrap();

        let s = take_snapshot(&repo, wt, SnapshotKind::Bootstrap).unwrap();
        let listing = capture(&repo, &["ls-tree", "-r", "--name-only", &s.commit_hash]);
        assert!(
            !listing.lines().any(|n| n == "ignored.txt"),
            "ignored file leaked into snapshot: {listing}"
        );
        cleanup(&repo);
    }

    #[test]
    fn policy_waits_with_no_writes() {
        let p = SchedulerPolicy::default();
        assert_eq!(p.evaluate_autonomous(1_000_000), SnapshotDecision::Wait);
    }

    #[test]
    fn policy_waits_within_debounce() {
        let mut p = SchedulerPolicy::default();
        p.note_write(1_000_000);
        assert_eq!(
            p.evaluate_autonomous(1_000_000 + p.debounce_ms - 1),
            SnapshotDecision::Wait
        );
    }

    #[test]
    fn policy_snapshots_autonomous_after_debounce() {
        let mut p = SchedulerPolicy::default();
        p.note_write(1_000_000);
        assert_eq!(
            p.evaluate_autonomous(1_000_000 + p.debounce_ms),
            SnapshotDecision::Snapshot(SnapshotKind::Autonomous)
        );
    }

    #[test]
    fn policy_waits_within_gate_after_snapshot() {
        let mut p = SchedulerPolicy::default();
        p.note_snapshot(1_000_000);
        p.note_write(1_000_000 + 1_000);
        assert_eq!(
            p.evaluate_autonomous(1_000_000 + p.debounce_ms + 1_000),
            SnapshotDecision::Wait
        );
    }

    #[test]
    fn policy_snapshots_after_gate_clears() {
        let mut p = SchedulerPolicy::default();
        p.note_snapshot(1_000_000);
        p.note_write(1_000_000 + p.min_gap_ms - 1_000);
        let now = 1_000_000 + p.min_gap_ms + p.debounce_ms + 1;
        assert_eq!(
            p.evaluate_autonomous(now),
            SnapshotDecision::Snapshot(SnapshotKind::Autonomous)
        );
    }

    #[test]
    fn policy_fires_heartbeat_when_activity_sustained_past_heartbeat_window() {
        let mut p = SchedulerPolicy::default();
        p.note_snapshot(1_000_000);
        // Keep writing throughout — last write is recent (within debounce)
        p.note_write(1_000_000 + p.heartbeat_ms - 1_000);
        let now = 1_000_000 + p.heartbeat_ms;
        assert_eq!(
            p.evaluate_autonomous(now),
            SnapshotDecision::Snapshot(SnapshotKind::Heartbeat)
        );
    }

    #[test]
    fn policy_no_heartbeat_without_fresh_writes() {
        let mut p = SchedulerPolicy::default();
        p.note_snapshot(1_000_000);
        p.note_write(500_000); // before last snapshot
        let now = 1_000_000 + p.heartbeat_ms;
        assert_eq!(p.evaluate_autonomous(now), SnapshotDecision::Wait);
    }

    #[test]
    fn policy_interactive_honors_min_gap() {
        let mut p = SchedulerPolicy::default();
        p.note_snapshot(1_000_000);
        assert_eq!(
            p.evaluate_interactive(1_000_000 + p.min_gap_ms - 1),
            SnapshotDecision::Wait
        );
        assert_eq!(
            p.evaluate_interactive(1_000_000 + p.min_gap_ms),
            SnapshotDecision::Snapshot(SnapshotKind::Interactive)
        );
    }

    /* Manual snapshots bypass the policy entirely (snapshot_take calls
    snapshot_and_emit directly), so no policy method needs testing here. */

    #[test]
    fn current_snapshot_commit_returns_ref_head() {
        let repo = init_repo("current");
        let wt = "wt-test-current";
        assert!(current_snapshot_commit(&repo, wt).is_none());
        let s = take_snapshot(&repo, wt, SnapshotKind::Bootstrap).unwrap();
        assert_eq!(
            current_snapshot_commit(&repo, wt).as_deref(),
            Some(s.commit_hash.as_str())
        );
        cleanup(&repo);
    }
}
