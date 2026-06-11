---
title: the polypore mcp server
group: the agent & mcp
order: 1
---

Polypore exposes its IDE features to agents through a built-in **MCP server**
called `polypore-ide`. When you open a project in Claude Code, the server starts
automatically; it reads the `.mcp.json` file at the project root, which is
already checked in. You do not configure or launch it yourself.

```json
// .mcp.json (already present at project root)
{
  "mcpServers": {
    "polypore-ide": {
      "type": "stdio",
      "command": "node",
      "args": ["packages/mcp-server/src/server.mjs"]
    }
  }
}
```

Any agent CLI that supports MCP (Claude Code, Codex) and is started from the
project directory will connect to this server automatically. The agent can then
call the tools listed below to drive the IDE, read files, run checks, and use
mediated secrets, all through named, validated tool calls you can watch happen.

## verifying the connection

Call `polypore.host.ping` (or any tool in the list, such as
`polypore.state.get` with key `"branch"`) to confirm the server is live. If
the host is not running, the tools will return an error explaining the server
cannot reach the Polypore host. Start Polypore and try again.

You can also check the tool list directly; any MCP-aware agent CLI exposes a
way to enumerate available tools. The live list is the authoritative source;
the server's exposed tools reflect the running host's capabilities.

## what the server provides

Every MCP tool call is a discrete, named action with validated arguments. The
surface is closed: tools that are not declared cannot be called, and invalid
arguments are rejected before they reach the host. You can see every call the
agent makes as it happens.

### tool namespaces

| namespace | what the agent can do |
|---|---|
| `polypore.manual` | read this manual, any section by slug |
| `polypore.state.*` | read IDE state: branch, active workspace, permission mode |
| `polypore.panel.*` | open or close panels by id |
| `polypore.editor.*` | open files in the editor, read content, search by pattern |
| `polypore.tasks.*` | add, list, and update shared tasks (visible across panels) |
| `polypore.diagnostics.*` | list errors and warnings from language servers |
| `polypore.verify.*` | run declared verify commands, read results, declare new commands |
| `polypore.format.*` | run a declared formatter against a file |
| `polypore.preview.*` | register a run target, request a preview refresh |
| `polypore.history.*` | read diff history events, fork a worktree from a snapshot |
| `polypore.memory.*` | read and write knowledge base documents, record handoffs |
| `polypore.secrets.*` | list handles, check whether a handle exists, make a mediated HTTP call |
| `polypore.mcp.*` | list external servers, add/remove/test them, invoke their tools |
| `polypore.skills.*` | list, read, create, update, delete, and publish skills |
| `polypore.skillsets.*` | list, read, create, and manage skill groups |
| `polypore.formation.*` | write a multi-agent formation into the agent panel |
| `polypore.debug.*` | start debug sessions, set breakpoints, step, inspect, capture |
| `polypore.plugins.*` | list, enable, disable, fetch, inspect, and install plugins |
| `polypore.ui.notify` | surface a notification in the Polypore UI |
| `polypore.adr.record` | write an architectural decision record to memory |
| `polypore.phase.report` | report workflow phase status to the host |
| `polypore.workspace.describe` | describe the current workspace layout |

## the manual tool

`polypore.manual` is the agent's way to read this documentation. Pass a section
slug to pull a specific page (e.g. `agent-mcp/secrets`) or call it without
arguments to get the full table of contents. This means when you ask the agent
"how does X work?" it answers from the same source you're reading now.

## external mcp servers

You can register external MCP servers that the agent can reach through
`polypore.mcp.invoke`. See [external mcp servers](agent-mcp/external-mcp) for how to add them, set
auth, and use secret handles to keep tokens out of tool arguments.

## what this means for you

- **every agent action is inspectable.** MCP tool calls are discrete named
  actions, not opaque shell invocations. You can read them in the chat stream
  as they happen.
- **the surface is intentionally closed.** An agent cannot open a panel or run
  a check through any channel other than these tools. If a call fails argument
  validation, the host never sees it.
- **the agent reads the same docs you do.** The `polypore.manual` tool means
  a well-configured agent session is never guessing at how Polypore works.
