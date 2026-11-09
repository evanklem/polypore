# polypore: agent guidance

A Rust/ratatui terminal dashboard for claude and codex sessions. One crate at the repo root; see `README.md` for what it does and `src/` layout. The old Tauri desktop app lives at the `v0-tauri` tag, not on any branch.

## Verify

- `cargo build --release && cargo test` (fast, unit tests only).
- Visual check: run it in a private tmux server (`tmux -L ptest new-session -d -x 200 -y 50 ...`) with `XDG_CONFIG_HOME`/`XDG_STATE_HOME` pointed at a scratch dir, then `tmux capture-pane -p`. Also set `XDG_RUNTIME_DIR` to a short scratch path (unix sockets cap at ~100 bytes) so the test gets its own terminal server, and point `[agents.claude] command` / `[review] command` at stand-in scripts so tests never start a real agent.
- Paths under `/tmp/.../scratchpad/` display as `scratchpad/...` (see `model::rel_path`), so a demo HOME for screenshots should live outside any scratchpad folder.
- Terminals live in `polypore server` (src/server.rs); rebuilding does not restart a running server, so kill it (`$XDG_STATE_HOME/polypore/server.pid`) when its protocol changes.

## Release

- Bump `version` in `Cargo.toml`, commit, then push a matching tag (`v0.2.1`). `.github/workflows/release.yml` builds Linux and macOS binaries (x86_64 + arm64) and publishes the release; it fails if the tag and `Cargo.toml` disagree.
- `install.sh` downloads the latest release asset for the machine, checks its sha256, and installs to `~/.local/bin`.
- README screenshots are in `assets/`, rendered from a synthetic demo HOME (fake projects and transcripts), never from real sessions.

## Local install

`~/.local/bin/polypore-tui` is the installed copy (the old Tauri binary may still be at `~/.local/bin/polypore`).
