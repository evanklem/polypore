# Contributing to Polypore

## Prerequisites

- Node 20+
- Rust stable (via [rustup](https://rustup.rs))
- On Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`

## Dev setup

```sh
npm ci
cd src-tauri && cargo build && cd ..
```

## Running

| Command | What it does |
|---|---|
| `npm run dev` | Vite renderer on `127.0.0.1:1420` (browser mode) |
| `npm run app` | Full desktop app via Tauri |
| `npm run mcp` | MCP sidecar against current directory |

## Tests

```sh
npm run typecheck      # TypeScript (fast)
npm test               # vitest renderer suite
cd src-tauri && cargo test && cargo clippy --no-deps -- -D warnings
```

The vitest suite is the slow one — run it before opening a PR.

## Submitting changes

1. Fork and create a branch from `main`.
2. Keep PRs focused — one concern per PR.
3. Make sure CI passes before requesting review.
4. Fill out the PR template.

## Architecture overview

```
src-tauri/      Tauri shell (Rust): host broker, secret broker, agent runtimes, pty, LSP/DAP
src/            React renderer: dockview layout, built-in surfaces (settings, manual)
plugins/        Built-in panel plugins (chat, editor, preview, terminal, memory, …)
packages/
  host/         HostRpcServer — contract between renderer and plugins
  sdk/          Plugin SDK and codegen'd types from schemas/
  mcp-server/   polypore-ide MCP sidecar (Node)
  polyflow/     Polyflow skill definitions
schemas/        JSON Schema contracts (source of truth for codegen)
scripts/        Build helpers and smoke tests
```
