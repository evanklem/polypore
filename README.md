<div align="center">

<img src="public/polyporelogo.png" alt="Polypore" width="128" height="128" />

# Polypore

**An agentic desktop IDE that treats the agent as the primary actor, not a sidebar.**

Language agnostic, OS agnostic. Every surface is a dockable panel you can split, reorder, or close. The built-in panels cover most workflows; when they don't, the SDK is there.

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20macOS%20%C2%B7%20Windows-555.svg)](#install)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB.svg)](https://tauri.app)
[![No telemetry](https://img.shields.io/badge/telemetry-none-444.svg)](#)

</div>

---

## Demo

https://github.com/user-attachments/assets/a3961bf3-46cd-4168-8e12-9acfcb2bf6b7

---

## Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/7ad1b39a-1392-447d-8da8-b1d8de57e3d1" alt="Editor panel" />
      <p align="center"><b>Editor</b> — Monaco with a live file tree and per-project diagnostics.</p>
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/9facaa4e-8212-408d-b9fe-21c2741f8f28" alt="Debug and diff panels" />
      <p align="center"><b>Debug</b> — verify runs and a scrubbable side-by-side diff.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/822b12ac-6c2a-4631-a81a-5471e89a0f1f" alt="Memory panel" />
      <p align="center"><b>Memory</b> — a project knowledge base with <code>[[wikilinks]]</code>.</p>
    </td>
    <td width="50%">
      <img src="https://github.com/user-attachments/assets/ca7fd44c-d117-455e-af7c-c461916bd24f" alt="Agent panel" />
      <p align="center"><b>Agent</b> — the formation canvas, skills, MCP, and secrets.</p>
    </td>
  </tr>
</table>

---

## Install

Download the build for your platform from the [latest release](https://github.com/evanklem/polypore/releases/latest). Polypore updates itself after the first install.

| Platform | File |
|---|---|
| Linux | `.AppImage` (any distro), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL) |
| macOS | `.dmg` (Apple Silicon or Intel) |
| Windows | `_x64_en-US.msi` or `_x64-setup.exe` |

On Linux the AppImage needs FUSE (`fuse2` on Arch). Mark it executable and run it:

```sh
chmod +x Polypore_*_amd64.AppImage
./Polypore_*_amd64.AppImage
```

To build from source instead, see [Getting started](#getting-started) below.

---

## The idea

The agentic tooling space moves fast. The right models, CLIs, and orchestration patterns shift faster than a typical IDE's release cycle, so Polypore is built to keep up rather than freeze a stack in place. Every surface is a sandboxed panel behind a shared contract, which means any piece of the IDE can be swapped, extended, or dropped without touching the core.

This is not a code editor with an agent panel bolted on after the fact. The layout, the memory system, the debug tooling, and the MCP server were all designed around the agent doing the work and a human steering it.

---

## Panels

The built-in panels, all available from the `+` tab button:

| Panel | What it does |
|---|---|
| claude | Claude CLI terminal with slash-command quick-launch |
| codex | Codex CLI terminal with slash-command quick-launch |
| preview | Live runtime output: browser, CLI, or any dev server |
| editor | Monaco editor with per-project diagnostics |
| diff-stack | Side-by-side diff and scrubbable history feed |
| terminal | Standalone pty terminal |
| debug | Verify runs and diagnostics |
| memory | Project knowledge base with `[[wikilinks]]` and context inventory |
| agent | Formation canvas, skills, MCP management, and secrets |

---

## SDK and plugins

Third-party panels are sandboxed iframes using the same `HostRpcServer` contract as the built-ins. Write a plugin in any framework, drop it in `.polypore/plugins/<id>/`, and it appears in the panel strip. Agents can drive it through the MCP server the same way they drive built-in panels.

---

## polypore-ide MCP server

A Node MCP sidecar ships with Polypore. Claude Code picks it up from `.mcp.json` automatically. It gives agents direct IDE control through 22+ tools:

| Namespace | What agents can do |
|---|---|
| `polypore.debug.*` | Start sessions, set breakpoints, step, capture console/DOM/network |
| `polypore.memory.*` | Read/write the knowledge base, link entries, write handoff documents |
| `polypore.verify.*` | Declare and run verification suites |
| `polypore.tasks.*` | Create and update tasks visible in the IDE in real time |
| `polypore.phase.*` | Report workflow phase to the live UI |
| `polypore.secrets.*` | Make mediated HTTP requests without seeing the secret value |
| `polypore.skills.*` | Read the active skill library |
| `polypore.format.*` | Trigger formatters in-editor |

---

## Secret broker

Secrets live in the OS keyring. When Polypore spawns an agent it strips every registered secret from the environment and replaces it with a `POLYPORE_SECRET_HANDLE_<KEY>` sentinel. Agents call `polypore.secrets.use` with an HTTP request; Polypore injects the value and masks it on the way back. The model never sees plaintext.

---

## Polyflow skills

15 slash commands in `packages/polyflow/` covering the full development loop:

`/polyflow` `/polyflow-go` `/polyflow-brainstorming` `/polyflow-writing-plans` `/polyflow-executing-plans` `/polyflow-tdd` `/polyflow-iterate` `/polyflow-debug` `/polyflow-review` `/polyflow-design-interface` `/polyflow-prd` `/polyflow-improve-architecture` `/polyflow-qa` `/polyflow-glossary` `/polyflow-compact`

---

## Stack

| | |
|---|---|
| Shell | Tauri 2, Rust |
| Renderer | React 18, Vite, TypeScript |
| Panels | Dockview |
| Editor | Monaco |
| Terminal | xterm.js, portable-pty |
| MCP sidecar | Node, JSON-RPC |
| Persistence | SQLite via rusqlite |
| Secrets | OS keyring via `keyring` crate |
| File watching | `notify` |
| Contracts | JSON Schema, codegen'd into `packages/sdk/` |

---

## Getting started

**Prerequisites:** Node 20+, Rust stable ([rustup](https://rustup.rs)). Linux also needs `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`.

```sh
npm ci
cd src-tauri && cargo build && cd ..
npm run app
```

For renderer-only development (no Tauri bridge):

```sh
npm run dev
```

---

## Scripts

| Command | |
|---|---|
| `npm run app` | Desktop app via Tauri |
| `npm run app:build` | Production bundle |
| `npm run dev` | Vite renderer on `127.0.0.1:1420` |
| `npm run typecheck` | Codegen + `tsc --noEmit` |
| `npm test` | vitest renderer suite |
| `npm run mcp` | MCP sidecar against cwd |
| `npm run mcp:smoke` | JSON-RPC tools/list smoke |
| `npm run mcp:pipeline-smoke` | End-to-end plugin + skill + secret |
| `cd src-tauri && cargo test` | Rust tests |
| `cargo clippy --no-deps -- -D warnings` | Rust lints |

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Tauri shell (Rust, src-tauri/)                                     │
│  ├─ host_broker (HTTP)    → emits Tauri events to the renderer     │
│  ├─ secret_broker (HTTP)  → OS keyring, never returns plaintext    │
│  ├─ agent runtimes        → stdio adapters per CLI; ACP opt-in     │
│  ├─ pty (portable-pty)    ├─ persistence (rusqlite)                │
│  ├─ snapshotter           ├─ fs_watch (notify)                     │
│  └─ plugin:// protocol    → serves .polypore/plugins/<id>/<asset>  │
├────────────────────────────────────────────────────────────────────┤
│ Renderer (React + Dockview)                                        │
│  ├─ HostRpcServer (packages/host)  shared contract for all plugins │
│  ├─ PolyporeHost loopback          built-in plugins use this       │
│  ├─ PluginLoader                   3rd-party iframes use this      │
│  └─ built-in panels (plugins/)                                     │
├────────────────────────────────────────────────────────────────────┤
│ polypore-ide MCP sidecar (Node, packages/mcp-server/)              │
│  ├─ 22+ tools → host_broker for live state changes                 │
│  └─ secrets.* → secret_broker, value never returned to agent       │
└────────────────────────────────────────────────────────────────────┘
```

Contracts live in `schemas/` and codegen into `packages/sdk/src/types.gen.ts` and `packages/sdk/src/validators.gen.ts`. Run `npm run codegen` after editing a schema.

---

## Environment variables

| | |
|---|---|
| `POLYPORE_PROJECT_ROOT` | Override cwd as the workspace root |
| `POLYPORE_ENABLE_ACP=1` | Opt into the ACP adapter |
| `POLYPORE_CONFIG_DIR` | Secrets metadata location (default `~/.config/polypore`) |
| `POLYPORE_UPDATE_ENDPOINT` | Override the auto-updater endpoint |

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

## License

[MIT](LICENSE)
