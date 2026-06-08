# agent / formation

The agent panel is the control room for multi-agent work. The left rail manages
the ingredients an agent can use — skills, skillsets, MCP servers, and secret
handles. The main canvas builds a task-specific **formation**: roles, prompts,
models, tools, skills, and handoff routes.

## the mental model

A formation is a small graph. Each node is a role such as overseer, frontend,
backend, QA, debugger, researcher, reviewer, or a custom agent. Each edge is a
handoff route: who passes work to whom. The active chat session appears as a
root node when one is open; only nodes reachable from that root are included
when you send the formation to chat.

Use a formation when the task needs deliberate structure: parallel slices,
independent review, research before implementation, or a debugging role that
should not also write the fix.

## skills and skillsets

Skills are markdown instructions the agent can load for repeatable workflows.
The rail shows Polypore skills plus discovered Claude/Codex skills. You can:

- create or edit a Polypore skill;
- group skills into skillsets;
- publish a skill to Claude, Codex, both, or keep it Polypore-local;
- open a skill in rendered or source view before attaching it to a role.

When you attach a skill to a role, the formation prompt names that skill so the
receiving chat knows what discipline to apply.

### how skills reach each agent

**Claude:** published skills appear as `/skillname` slash commands in the Claude
terminal. Type `/` to browse them.

**Codex:** published skills are injected into Codex's system prompt at session
start. Codex does not expose user skills as slash commands — `/` in the Codex
terminal only shows Codex's own built-in commands and cannot be extended.
Instead, Codex applies a skill automatically when your request matches its
description, or you can invoke it explicitly by mentioning the skill name
(`$skillname` or just its name in plain text). Codex's own instructions to the
model read: *"if the user names a skill or the task clearly matches a skill's
description, use that skill for that turn."*

The injection is token-efficient: only each skill's **name, description, and
file path** are listed in the system prompt — the full body is not loaded
upfront. Codex reads the `SKILL.md` file lazily the moment it decides to use a
skill ("progressive disclosure"). The per-session cost scales with the number of
published skills and the length of their descriptions, not their full content.

Skills are read once at session start and baked into the developer (system)
message. **A skill added or deleted mid-session will not take effect until you
start a new Codex session** — close and reopen the Codex panel to pick up the
change.

## mcp servers

The MCP rail lists the built-in Polypore IDE server, managed Polypore MCP
servers, and external servers discovered from Claude/Codex config. Managed
servers can be added, edited, tested, or removed. External discovered servers
are shown as read-only because their source of truth is the external agent
configuration.

Use MCP servers for capabilities outside the built-in Polypore tools, and attach
secret handles rather than raw tokens when a server needs auth.

## secret handles

The secrets rail lists masked handles by scope. You can add project or user
secrets, reveal a value only after confirmation, and delete a handle. Secrets
are for tools and MCP calls, not for pasting into role prompts.

## building a formation

- **Start with the active chat root** or create a canvas without one and send it
  later.
- **Add nodes** from built-in templates or your saved templates.
- **Edit each role** with a role name, model hint, prompt, tool chips, and skill
  chips. Built-in presets start with an inherited model hint so the active
  Claude/Codex chat decides the concrete model unless you override it.
- **Wire handoffs** by dragging between node ports in either direction, or by
  using the connection picker.
- **Organize the layout** when the canvas gets messy; pan, zoom, and reset the
  view as needed.
- **Send to chat** to inject the reachable formation into the chosen open
  Codex/Claude terminal.

Agents can also write the same formation through `polypore.formation.upsert`.
The panel subscribes to that host state and updates live.

## templates and constraints

Built-in templates cover common roles, but any selected node can be saved as a
template. Templates remember role, prompt, model hint, tools, and skills.

Some handoffs are blocked when the model/provider relationship cannot work. For
example, the panel prevents a Codex-rooted role from adding Claude as a
subagent when that provider relationship is unsupported.

## tips

- Keep the formation as small as the task allows.
- Put secrets only on the roles or MCP servers that actually need them.
- Save reusable roles as templates instead of rebuilding the same prompts.
- Send the formation to chat after the graph reflects the real workflow, not
  before.
