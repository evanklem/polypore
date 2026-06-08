---
title: getting started
group: the ide
order: 1
---

Polypore is a desktop IDE built for driving agentic coding sessions. You open a
project, pick a workspace, and the panels you need are already arranged for the
work in front of you — editor, a live agent terminal, preview, diagnostics,
diff & history.

## first-time setup

Before you open a project, you need a supported agent CLI installed and on your
system path:

- **Claude Code** (`claude`) — install via `npm install -g @anthropic-ai/claude-code`
- **Codex** (`codex`) — install via `npm install -g @openai/codex`

You only need one. If Polypore cannot find a CLI you expect, check **settings →
agents** — it shows the resolved path for each detected CLI. A missing CLI
usually means the shell PATH that the desktop app inherits does not include the
directory where the CLI is installed (common with `nvm`, `asdf`, or user-local
npm prefixes).

### the mcp connection

Polypore connects to an agent CLI through an MCP server called `polypore-ide`.
When you open a project, Claude Code reads the `.mcp.json` file at the project
root and starts the server automatically — no configuration on your part. The
agent can then call `polypore.*` tools to drive the IDE as it works.

If you're starting a new project from scratch, you can bootstrap the `.mcp.json`
from **settings → project → verify** or copy the template from an existing
project. See **the polypore mcp server** for the file's contents and what the
server exposes.

## the first five minutes

1. **open a project** from the launcher. Recent projects are one click away; a
   new project starts from an empty workspace.
2. **pick a workspace.** Workspaces are saved panel arrangements tuned for a kind
   of work — building, reviewing, debugging. Switching never loses your panels;
   each layout is remembered.
3. **talk to an agent.** The chat panel runs a real agent CLI (codex, claude) in
   a pty-backed terminal. Type what you want done; the agent works in your
   project and its tool calls show up as they happen.
4. **let it use the tools.** Polypore's IDE features are exposed through the MCP
   tool surface — opening panels, running verify checks, reading this manual,
   writing memory notes, and using mediated secret handles.

## the mental model

- **the IDE is the surface; the agent is the worker.** You arrange panels and set
  policy; when the agent drives Polypore itself, it does so through a fixed,
  inspectable tool surface.
- **everything project-specific is a file.** Runtimes, language servers, verify
  checks, formatters, and file-tree rules all live as plain JSON
  under `.polypore/` — editable by you or the agent.
- **stored secrets are used through handles.** Keys you store become opaque
  handles; when an agent uses one through Polypore's mediated secret call, the
  raw value is not returned to chat.
- **memory is the durable context.** Chat is for the active conversation; Memory
  is the markdown knowledge base where project notes, source material,
  decisions, and handoffs survive across sessions.

## where to go next

- [workspaces & panels](the-ide/workspaces-and-panels) — the layout model: areas, slots, and how panels dock.
- [settings](the-ide/settings) — the six settings sections: panels, project, extensions, agents,
  credentials, and appearance.
- [project configuration](the-ide/project-configuration) — the `.polypore/` files for language servers,
  runtimes, verify checks, diagnostics, formatters, and file-tree rules.
- [the ai workflow](workflows/ai-workflow) — how to actually drive an agent through a change, from
  prompt to verified diff.
- [polyflow](workflows/polyflow) — the built-in skillset the agent follows for non-trivial work.
- [the polypore mcp server](agent-mcp/mcp) — the tool surface the agent calls, the full
  namespace table, and how to verify the connection.
- [secrets & safety](agent-mcp/secrets) — how to store API keys and let agents use them without
  the raw value ever appearing in chat.
