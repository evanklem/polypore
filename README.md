# Polypore

Desktop IDE for driving agentic coding sessions. Tauri 2 shell, Vite + React 18
renderer, JSON-Schema-driven contracts, and a panel-plugin architecture under
the `polypore-ide` MCP server.

Spec: `docs/specs/2026-05-16-master-implementation-plan.md`.

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Tauri shell (Rust, src-tauri/)                                     │
│  ├─ host_broker (HTTP)   → emits Tauri events to the renderer      │
│  ├─ secret_broker (HTTP) → OS keyring (keyring crate)              │
│  ├─ agent runtimes       → stdio adapters per CLI; ACP opt-in      │
│  ├─ pty (portable-pty)   ├─ persistence (rusqlite)                 │
│  ├─ iterate              ├─ fs_watch (notify)                      │
│  └─ plugin:// protocol   → serves .polypore/plugins/<id>/<asset>   │
├────────────────────────────────────────────────────────────────────┤
│ Renderer (React + dockview)                                        │
│  ├─ HostRpcServer (packages/host)  contract per §4.3               │
│  ├─ PolyporeHost loopback          built-in plugins use this       │
│  ├─ PluginLoader                   3rd-party iframes use this      │
│  └─ 9 built-in panels (plugins/)   chat | preview | editor | …     │
├────────────────────────────────────────────────────────────────────┤
│ polypore-ide MCP sidecar (Node, packages/mcp-server/)              │
│  ├─ tools (§22) → host_broker for state changes                    │
│  └─ secrets.*   → secret_broker, never returns plaintext           │
└────────────────────────────────────────────────────────────────────┘
```

Contracts live in `schemas/` and are codegen'd into
`packages/sdk/src/types.gen.ts` + `packages/sdk/src/validators.gen.ts` by
`scripts/codegen-ts.mjs`. Run `npm run codegen` after editing a schema.

## Scripts

| command | purpose |
|---|---|
| `npm run dev` | Vite dev server on 127.0.0.1:1420 |
| `npm run app` | run Polypore as a Tauri desktop app |
| `npm run app:build` | build the desktop app bundle |
| `npm test` | vitest renderer suite |
| `npm run lint` | static TypeScript verifier used by MCP `verify.run` lint |
| `npm run typecheck` | codegen + tsc --noEmit |
| `npm run build` | production renderer bundle |
| `npm run tauri dev` | run the Tauri shell against the dev server |
| `npm run mcp` | run the MCP sidecar against the cwd |
| `npm run mcp:smoke` | JSON-RPC tools/list smoke against the sidecar |
| `npm run mcp:pipeline-smoke` | end-to-end plugin install + skill + secret |
| `npm run mcp:host-broker-smoke` | MCP → host_broker bridge |
| `npm run mcp:secret-broker-smoke` | MCP → secret_broker bridge |
| `cargo test` (in `src-tauri`) | Rust shell tests |
| `cargo clippy --no-deps -- -D warnings` | Rust lints |

## Current State

- The default path is the desktop shell: project launcher/open-folder,
  filesystem watcher, SQLite task/verify persistence, Git diff/worktree/revert,
  pty terminal sessions, keyring-backed secrets, MCP brokers, and agent stdio
  adapters are wired through Tauri commands.
- The renderer runs the IDE surface through dockview panels: chat, preview,
  editor, diff/history, terminal, verify, memory, agent, and problems. Built-in
  panels use the same host RPC contract exposed to iframe plugins.
- Browser mode remains useful for renderer development, but bridge-dependent
  features intentionally show fallback errors there instead of pretending to
  touch the filesystem, terminal, secrets, or agents.

## Environment toggles

| env var | effect |
|---|---|
| `POLYPORE_PROJECT_ROOT` | overrides cwd as the workspace root |
| `POLYPORE_ENABLE_ACP=1` | opt into the (not-yet-complete) ACP adapter |
| `POLYPORE_UPDATE_ENDPOINT` | report the updater as configured |
| `POLYPORE_CONFIG_DIR` | secrets metadata location (default `~/.config/polypore`) |
