---
title: building custom panels
group: reference
order: 1
---

Polypore is built from panels, and every panel is a plugin. The built-in editor,
chat, preview, problems, and debug panels are ordinary plugins installed at
`plugins/`: nothing about them is privileged. A panel you write follows the
exact same path.

## the plugin model

A plugin is a directory with two required files:

- `polypore.json`: the manifest. Declares identity, permissions, and where to
  load the panel's UI from.
- `index.html`: the entry point. An HTML file the host loads into a sandboxed
  iframe.

The host injects the client runtime (`window.polypore`) into every iframe before
the panel's scripts run. The panel calls `window.polypore.ready()` and then uses
the API to read state, talk to the editor, send chat messages, spawn terminals,
or do anything else its declared permissions allow.

```
my-panel/
  polypore.json   ← manifest
  index.html      ← panel UI entry point
  MANUAL.md       ← (optional) appears in this manual under "panels"
```

## the manifest

`polypore.json` follows schema version 1:

```json
{
  "schemaVersion": 1,
  "id": "com.example.my-panel",
  "title": "my panel",
  "icon": "⬡",
  "version": "0.1.0",
  "author": { "name": "Your Name", "url": "https://example.com" },
  "description": "A short one-liner shown in the panel catalog.",
  "entry": "index.html",
  "permissions": ["state.read", "editor.read"],
  "capabilities": [],
  "category": "other",
  "defaultArea": "right"
}
```

**id**: reverse-DNS style, unique across all installed plugins. Built-in panels
use `polypore.*`; yours should use your own namespace.

**entry**: path relative to the plugin directory. Can be an `index.html`,
any HTML file, or a URL served by a dev server during development.

**category**: one of `editor`, `agent`, `verify`, `knowledge`, `runtime`,
`other`. Used to group panels in the catalog.

**defaultArea**: where the panel opens by default: `center`, `left`, `right`,
or `bottom`. The user can drag it anywhere after the first open.

## permissions

Every host API method is gated by a permission. If your manifest does not
declare a permission and the panel calls the method, the host rejects the call
with `permission_not_declared`. The user is also shown what permissions a panel
needs before they install it.

| permission | what it unlocks |
|---|---|
| `state.read` | `polypore.state.get`, state subscriptions |
| `editor.read` | `polypore.editor.tree`, `.read`, `.onOpen` |
| `editor.write` | `polypore.editor.applyEdit`, `.open` |
| `editor.decorate` | `polypore.editor.setDecorations` |
| `tasks.read` | `polypore.tasks.list`, `.onChange` |
| `tasks.write` | `polypore.tasks.add`, `.update` |
| `diagnostics.read` | `polypore.diagnostics.list`, `.onChange` |
| `chat.read` | `polypore.chat.sessions`, `.history`, `.onMessage` |
| `chat.send` | `polypore.chat.send`, `.stream` |
| `terminal.spawn` | `polypore.terminal.spawn` |
| `terminal.write` | `polypore.terminal.write` |
| `terminal.stop` | `polypore.terminal.stop` |
| `preview.register` | `polypore.preview.register` |
| `history.read` | `polypore.history.events`, `.diff` |
| `history.fork` | `polypore.history.fork` |
| `knowledge.read` | `polypore.knowledge.list`, `.read` |
| `knowledge.write` | `polypore.knowledge.write` |
| `secrets.list` | `polypore.secrets.list`, `.has` |
| `secrets.use` | `polypore.secrets.use` |
| `storage.read` | `polypore.storage.get`, `.list` |
| `storage.write` | `polypore.storage.set`, `.delete` |
| `git.read` | `polypore.git.status`, `.log`, `.blame`, `.branches` |
| `http.fetch` | `polypore.http.fetch` |
| `ui.notify` | `polypore.ui.notify` |
| `ui.confirm` | `polypore.ui.confirm` |
| `fs.write` | `polypore.fs.write`, `.delete`, `.rename`, `.mkdir` |

Declare only what you use; users can see the list before installing.

## the client runtime

The host injects `window.polypore` before any of your scripts execute. All
methods return promises. The top-level namespaces are:

- **`polypore.state`**: read shared IDE state (active agent, active panel,
  branch, permission mode, workspace, etc.)
- **`polypore.editor`**: file tree, open files, read/apply edits, cursor,
  decorations, save events
- **`polypore.chat`**: sessions, history, send messages, stream agent replies
- **`polypore.tasks`**: task list shared across panels and agents
- **`polypore.diagnostics`**: lint/type errors from the language server
- **`polypore.verify`**: verify runs (test / build / check commands)
- **`polypore.terminal`**: spawn and drive pty sessions
- **`polypore.preview`**: register a preview target; request a refresh
- **`polypore.history`**: diff & history events; fork a worktree from a snapshot
- **`polypore.knowledge`**: read and write knowledge base documents
- **`polypore.secrets`**: list handles; use a secret to make a proxied HTTP call
- **`polypore.storage`**: key-value store scoped to your plugin id
- **`polypore.git`**: status, log, blame, branches
- **`polypore.http`**: proxied HTTP fetch (routed through the Tauri shell)
- **`polypore.fs`**: write, delete, rename, mkdir
- **`polypore.ui`**: notify, confirm, input box, quick pick, status bar, panel
  title/badge
- **`polypore.panels`**: open or close other panels by id
- **`polypore.bus`**: low-level publish/subscribe across panels

Subscribe methods (`onChange`, `onOpen`, `onEvent`, etc.) return an unsubscribe
function. Call it in your teardown to avoid memory leaks.

## a minimal panel

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 1rem; font-family: sans-serif; }
  </style>
</head>
<body>
  <p id="out">connecting…</p>

  <script>
    polypore.ready().then(async () => {
      const { value: branch } = await polypore.state.get('branch');
      document.getElementById('out').textContent = 'branch: ' + branch;

      polypore.state.subscribe('branch', (next) => {
        document.getElementById('out').textContent = 'branch: ' + next;
      });
    });
  </script>
</body>
</html>
```

Pair that `index.html` with a `polypore.json` that declares `"permissions":
["state.read"]` and you have a working panel. Drop the directory into
`plugins/` and restart Polypore; it appears in the catalog immediately.

## adding a manual page

Place a `MANUAL.md` alongside `polypore.json`. When the host loads the plugin
it pulls in the markdown and publishes it under **panels → your panel title** in
this manual. The panel's `?` header button links directly to that page.

Keep your `MANUAL.md` in the same voice as the built-in pages: describe what
the panel does and how to use it, not how it is implemented.

## using secrets

If your panel calls an external API with a key the user has stored in Polypore's
[credentials](the-ide/settings) panel; do not read the value directly, use `polypore.secrets.use`:

```js
const result = await polypore.secrets.use({
  id: 'MY_API_KEY',           // the handle name the user stored
  request: {
    url: 'https://api.example.com/data',
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  },
});
// result.status, result.headers, result.body; key was never in JS
```

The raw value never crosses into your iframe. Declare `secrets.use` (and
`secrets.list` if you display which keys are configured) in your manifest.

## installing plugins

During development, place your directory directly under `plugins/` and restart.
For distribution, a plugin is a zip of the directory; the user installs it from
[settings → extensions](the-ide/settings). Polypore validates the manifest
schema on install and shows the permission list before confirming.

## typescript types

The `packages/sdk` package exports TypeScript types for the manifest
(`PanelManifest`) and all host types. Add it as a dev dependency if your panel
is built with a bundler:

```ts
import type { PanelManifest } from '@polypore/sdk';
```

The `window.polypore` shape is available as `PolyporeHost` from the same
package. The client runtime itself (`client-runtime.js`) is a self-contained
IIFE that the host injects; you do not import it in your bundle.
