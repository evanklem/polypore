# chat

The chat panel is an agent terminal surface. Each agent — codex, claude — runs
its real CLI in a pty-backed terminal, so what you see is the genuine agent
session, not a re-rendering of it.

Codex and Claude chat panels are specialized terminal panels. They use the same
xterm-backed pty as the Terminal panel, but start with the agent command already
running and show agent-specific slash-command shortcuts.

## driving a session

- **It starts itself.** When the panel mounts, the agent CLI launches
  automatically; you can begin typing immediately.
- **Keystrokes go to the process.** Input is forwarded straight to the CLI, so
  every shortcut and prompt the agent supports works as it does in a terminal.
- **Slash commands are remembered per agent.** Common commands such as `/clear`
  and `/help` appear as quick chips, ranked separately for Claude and Codex.
- **Run agents in parallel.** The **+** opens another independent agent terminal.
  Two agents can work side by side without sharing a session.
- **If the CLI exits,** the panel falls back to a shell so you can inspect what
  happened without losing the terminal.

## what the agent can reach

Inside a chat session the agent can use Polypore MCP tools when its CLI is
configured with the Polypore MCP server: opening panels, running verify
commands, using mediated secret handles, reading this manual, and writing memory
notes. See [the polypore mcp server](agent-mcp/mcp) for the model, and [secrets & safety](agent-mcp/secrets) for the
limits of the secret policy in pty sessions.

## memory context

Documents queued from Memory are attached when you send the next message. The
terminal inserts them as `@path` mentions at the start of that prompt and then
removes them from the queue for that chat.

## tips

- Context you drag in from the Memory panel is scoped to this chat, not every
  open agent.
- Closing the panel ends that agent's session; reopening starts a fresh one.
