---
title: external mcp servers
group: the agent & mcp
order: 2
---

Beyond the built-in `polypore-ide` server, you can register external MCP servers
that the agent can call through `polypore.mcp.invoke`. These live alongside your
project or across your user account and let you extend what the agent can reach
without changing your agent CLI's main config.

## adding a server

Open the [agent panel](panels/polypore.agent) and find the **MCP rail** on the left. Click **add
server** and fill in:

- **name** — a label shown in the rail and used as the `server` argument to
  `polypore.mcp.invoke`.
- **url** — the server's HTTP or SSE endpoint.
- **scope** — `project` makes the server available only in this project;
  `user` makes it available across all your projects.
- **auth** — attach a secret handle instead of pasting a raw token. The handle
  name matches one you stored in **settings → credentials**.
- **allow insecure** — only for local dev servers; leave off for anything with a
  real token.

The agent can do the same through `polypore.mcp.servers.upsert`.

## testing a server

Click the test button on a registered server in the MCP rail, or have the agent
call `polypore.mcp.servers.test` with the server id. A test performs a connection
check and reports whether the server is reachable and responding.

## invoking a server from an agent

An agent calls `polypore.mcp.invoke` with:

```
{
  "server": "my-server-name",
  "method": "tool-name",
  "args": { ... }
}
```

Polypore routes the call to the registered server. If the server entry has an
`authRef`, Polypore resolves the secret handle and injects the token into the
outbound request — the raw value is never part of the tool call arguments.

## managing servers

- **list servers** — `polypore.mcp.servers.list` returns all registered servers
  for a given scope. The Agent panel shows the same list in the MCP rail.
- **remove a server** — use the remove button in the rail or call
  `polypore.mcp.servers.delete` with the server id.
- **discovered servers** — servers from your agent CLI's own config (e.g.
  `~/.claude/claude_desktop_config.json`) appear in the rail as read-only.
  Their source of truth is the external config, so edit them there.

## using secrets with external servers

Attach a secret handle when you register the server (the `authRef` field). At
invoke time, Polypore substitutes `${secret}` in the outbound request headers or
body. You and the agent see only the handle name, never the raw value. See
[secrets & safety](agent-mcp/secrets) for the full policy.
