# preview

The active runtime surface for your project — whatever "running it" means here.
A web viewport, CLI output, a test runner, a game, or a desktop/mobile launch
target.

## what it shows

- **Detected runtimes.** Preview reads configured runtimes from
  `.polypore/runtime.json` and also detects common project scripts from files
  such as `package.json`.
- **Web** projects render in an embedded viewport when a URL is available. The
  dev server may hot-reload itself; Preview can also be refreshed explicitly.
- **CLI / test / game** targets show output in the same surface, so "see it run"
  is one place regardless of project kind.
- **Desktop/mobile** commands are detected separately. Native app launchers are
  not forced into the embedded terminal when they need the OS.
- **Registered targets.** An agent declares what to run via
  `polypore.preview.register` (kind + command + target); the preview then knows
  how to launch and refresh it.

## setup

Pick a runtime, command, and optional URL. Preview remembers the runtime choice
for the project. If no detector matches, enter the command manually.

When the URL includes a host and port, Preview can rewrite common dev-server
commands so the launched process binds to that address. Commands that do not
match a known shape are left alone; edit the command field directly for those.

## how it fits the agent loop

When an agent changes code, it can request a refresh with
`polypore.preview.refresh` and capture what it sees — closing the loop between
"made a change" and "observed the result" without leaving the IDE.

## tips

- If the preview is blank, check that a run target is registered for this
  project's kind, that the command is running, and that the URL matches the
  server output.
