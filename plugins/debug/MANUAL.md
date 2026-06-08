# debug

Bring problems and checks here. This panel is the workbench for turning
diagnostics and repeatable commands into an ordered fix queue, then sending that
queue to an open Codex or Claude chat.

## the flow

- **Problems** mirror the host diagnostics list used by [problems](panels/polypore.problems) and [editor](panels/polypore.editor).
  Run **deep scan** to add configured diagnostic sources that are not already in
  the live list.
- **Checks** come from declared verify commands. Queue checks here and send
  them to chat so the agent can run the declared command with
  `polypore.verify.run` and see the result.
- **Queue** accepts problems and checks. Drag rows into the queue, use the `+`
  buttons, or queue everything at once.
- **Custom entries** let you add an ad-hoc problem or command to the queue
  without first changing project configuration.
- **Send to chat** delivers the pending queue to an open agent terminal. If more
  than one chat is open, pick the target chat.

## runtime debugging, not guessing

When a failure needs investigation, the agent has real debugging tools under
`polypore.debug.*` — breakpoints, step, inspect, evaluate, and capture
(screenshot/console). It can pause the program and look, rather than
pattern-matching on an error string. A roadblock (`polypore.debug.roadblock`)
asks you to reproduce a state it can't reach on its own.

Agents should pass explicit adapter/config fields into `polypore.debug.probe`
and `polypore.debug.start` instead of assuming a language runtime.

## tips

- Declared checks are shared with the agent — declare once, queue them here,
  and have the agent run them from chat.
- Queue related failures together so the agent receives a coherent fix list
  instead of a single symptom.
- Use the debug tools when a failure needs observation at runtime, not another
  static guess.
