# Chat

The chat panel is an agent terminal surface. Each agent — codex, claude — runs
its real CLI in a pty-backed terminal, so what you see is the genuine agent
session, not a re-rendering of it.

## Driving a session

- **It starts itself.** When the panel mounts, the agent CLI launches
  automatically; you can begin typing immediately.
- **Keystrokes go to the process.** Input is forwarded straight to the CLI, so
  every shortcut and prompt the agent supports works as it does in a terminal.
- **Run agents in parallel.** The **+** opens another independent agent terminal.
  Two agents can work side by side without sharing a session.

## What the agent can reach

Inside a chat session the agent has the full MCP tool surface — opening panels,
running verify commands, using secret handles, reading this manual. See
**The Agent & MCP** for the model, and **Secrets & safety** for how keys stay
masked.

## Tips

- Context you drag in from the Memory panel rides along with the session.
- Closing the panel ends that agent's session; reopening starts a fresh one.
