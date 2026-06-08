# terminal

A real xterm-backed shell surface for ad-hoc commands — the things you'd
normally drop to a terminal for. Distinct from verify checks: Verify runs
structured, repeatable project checks; Terminal is for interactive human work.

## using it

- **Run anything** you'd run in a shell — git, package managers, scripts.
- **Use interactive programs.** The panel is backed by a pty, so full-screen and
  cursor-driven programs such as `vim`, `less`, `ssh`, and agent CLIs can work.
- **Resize naturally.** The pty receives new rows/columns when the panel
  changes size.
- **Use quick commands.** Common shell commands are remembered locally. When you
  run `claude` or `codex`, the quick chips switch to that agent's slash-command
  history.
- **It's yours, not the agent's checks.** Use it for exploration and one-offs;
  use verify checks for the commands that should be declared and repeatable.

## terminal and memory

Agent chat panels use this same terminal engine. When a chat has queued [memory](panels/polypore.memory)
documents, pressing Enter inserts those files as `@path` mentions before the
prompt is submitted. Plain shell terminals are still just shells; use memory's
chat selector to target the right agent terminal.

## terminal vs verify

| | terminal | verify |
|---|---|---|
| for | ad-hoc human commands | structured agent checks |
| repeatable | no | yes, declared in `.polypore/verify.json` |
| who reads results | you | you and the agent |

## tips

- Reach for a verify check, not the terminal, when a command is something the
  project should run every time — that way the agent can run it too.
