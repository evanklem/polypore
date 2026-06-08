# Polypore — agent guidance

This is the Polypore desktop IDE. Skills are bundled at `packages/polyflow/`; built-in plugins live under `plugins/`; the polypore MCP server is at `packages/mcp-server/`; the Tauri shell is `src-tauri/`.

## MCP — polypore-ide server

The polypore MCP server is registered at the project level via `.mcp.json`. Claude Code starts it automatically when invoked from this directory. The server exposes the following tool namespaces:

- `polypore.skills.*` — list and read skill definitions
- `polypore.secrets.*` — list handles and make mediated HTTP requests (see Secrets section)
- `polypore.mcp.*` — list and manage MCP server entries
- `polypore.memory.*` — read and write knowledge-base entries
- `polypore.verify.*` — run verification runs
- `polypore.files.*` — file-system helpers
- `polypore.host.*` — host state (project, workspace, panels)

To check what tools are available, call `polypore.host.ping` or look at the MCP tool list.

## Secrets — never read raw

Polypore manages secrets agent-agnostically. When you're spawned by polypore the breadcrumb env var `POLYPORE_AGENT_SCRUBBED=1` is set, and any secret keys listed in `.env`, `.env.local`, or `.env.development` have been **removed from your environment** and replaced with sentinel handles of the form `POLYPORE_SECRET_HANDLE_<KEY>=<handle>`.

- **Do NOT** `cat .env*`, `printenv`, `env | grep`, or otherwise try to retrieve raw secret values. The value isn't in your env; the file may be on disk but reading it directly is a leak and explicitly out of policy.
- **DO** call the MCP tool `polypore.secrets.use` with `{ id: "<handle>", request: { url, method, headers, body } }`. Polypore injects the value into the outbound request and masks it on the way back. You never see the raw secret.
- The `polypore.secrets.list` tool gives you the available handles + which are configured; the value field never returns through it.

If you need a secret that polypore doesn't have a handle for, stop and ask the user to add it through the Secrets panel — don't paste it into chat, never write it to a file.

## Skills — polyflow slash commands

All 15 polyflow skills are published to `~/.claude/skills/` as `.md` symlinks. Type `/` in the Claude Code prompt to see them. Available skills:

| Slash command | Purpose |
|---|---|
| `/polyflow` | Entry-point orchestrator — routes to the right sub-skill |
| `/polyflow-go` | Quick one-shot execution for clear, small tasks |
| `/polyflow-brainstorming` | Explore + clarify unclear intent |
| `/polyflow-writing-plans` | Draft a step-by-step implementation plan |
| `/polyflow-executing-plans` | Execute an already-approved plan |
| `/polyflow-tdd` | Test-driven production-code changes |
| `/polyflow-iterate` | Iterate on a draft (code or doc) |
| `/polyflow-debug` | Systematic debug loop |
| `/polyflow-review` | Code review |
| `/polyflow-design-interface` | API / UI interface design |
| `/polyflow-prd` | Write or refine a PRD |
| `/polyflow-improve-architecture` | Architecture analysis and improvement |
| `/polyflow-glossary` | Build or update a project glossary |
| `/polyflow-qa` | QA checklist and test planning |
| `/polyflow-compact` | Compact / summarise prior context |

When the user invokes a polyflow flow, start with the smallest useful step: brainstorming for unclear intent, writing-plans for known multi-step work, executing-plans for an approved plan, or TDD for a direct production-code change. Keep the loop sequential unless the user explicitly asks for parallel agents.

## Verification

- Frontend changes: `npm run typecheck` (fast) and the dev server check. The user runs the full vitest suite themselves — don't auto-run it.
- Rust changes: `cd src-tauri && cargo check`.
