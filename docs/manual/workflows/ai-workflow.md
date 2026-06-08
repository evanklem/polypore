---
title: the ai workflow
group: workflows
order: 1
---

Polypore is built around driving an agent through a change end-to-end — from a
prompt to a verified diff you choose to keep. This page is the loop; [polyflow](workflows/polyflow)
is the disciplined version of it the agent follows on non-trivial work.

## the loop

1. **describe the task** in a chat panel. Be concrete about the outcome, not the
   steps — "make the export button stream the file" beats "edit exporter.ts".
2. **watch it work.** Polypore tool calls show up as they happen: opening files
   in the editor, running a verify check, reading this manual, using a secret
   handle. File changes are visible in the editor and diff panels before you
   decide what to keep.
3. **review the diff.** The [diff & history](panels/polypore.diff-history) panel shows exactly what changed
   and lets you walk the history of the session. Read the diff before you trust
   it.
4. **verify.** Run the project's verify checks ([settings → project](the-ide/settings),
   or the agent calls `polypore.verify.run`). Diagnostics surface in the
   [problems](panels/polypore.problems) panel; the [preview](panels/polypore.preview) panel runs the app.
5. **save durable context.** Put decisions, source material, recovery notes, and
   handoffs into [memory](panels/polypore.memory) so the next session has more than chat scrollback.
6. **keep or discard.** The agent **never commits for you** — git is always your
   move. Keep the diff, ask for a change, or discard and retry.

## running agents in parallel

The **+** in a chat panel opens another independent agent terminal. Two agents
can work side by side without sharing a session. Treat that as an explicit
coordination choice: split the work only when the boundaries are clear, verify
the merged result as a whole, and keep git integration under your control.

## what stays in your hands

- **git.** No auto-commits, ever. You decide what lands.
- **secrets.** The agent uses your keys through handles and never sees the raw
  value — see [secrets & safety](agent-mcp/secrets).
- **policy.** You decide which panels exist, which plugins are enabled, and what
  each role in a formation is allowed to reach.
- **memory.** You decide which notes become durable knowledge and which files
  are loaded into a specific chat as context.
