---
title: settings
group: the ide
order: 4
---

Settings is a full-screen surface that covers workspace, system, and appearance
configuration. Open it from the gear icon in the launcher bar. Search across all
sections with the **find a setting** input at the top of the nav.

Settings has six sections, organized into three groups.

## workspace

### panels

Per-panel configuration for every installed panel. Select a panel from the list
to see:

- **permissions** the panel declared in its manifest: what the panel is allowed
  to call on the host.
- **capabilities** the panel exposes to other panels or agents.
- **local data** the panel has stored; you can clear it from here.
- **docs link**: the same `?` button that appears in the panel header.

Panels that declare a `polypore.json` manifest with custom permissions will
always show those permissions here, so you can review what a third-party panel
can do before or after installing it.

### project

The project section is the UI-level editor for the `.polypore/` configuration
files. Use it to configure runtimes, language servers, verify commands, diagnostic
sources, formatters, and file-tree filters without editing JSON by hand.

Each subsection creates or edits the corresponding file under `.polypore/`: the
same file the agent reads. Editing the JSON directly is equivalent; settings and
panels read the same project files. See [project configuration](the-ide/project-configuration) for the full
JSON shape of each file.

## system

### extensions

The installed plugin registry. Shows every plugin installed at user or project
scope, plus the built-in panels. From here you can:

- **install from file**: drag in a `.zip` plugin archive or point to a local
  directory. Polypore validates the manifest and shows the permission list before
  confirming.
- **enable / disable** a plugin; disabling a plugin keeps it installed but
  prevents its panels from appearing in the catalog.
- **uninstall**: removes the plugin record (not the source directory if you
  installed from a local path during development).

### agents

Agent CLI availability and probing. Polypore detects whether supported CLIs
(Claude Code, Codex) are reachable on your system path and shows their resolved
location. Use this section to:

- check which agent CLIs are available.
- verify that a CLI Polypore detected is the one you expect (the resolved path
  is shown).
- troubleshoot "agent not found" errors: if a CLI is installed but not found,
  the issue is usually a shell PATH that the desktop app does not inherit.

### credentials

Secret handles by scope. This is where you store keys so agents and panels can
use them through handles instead of raw values.

- **add a secret**: choose a name, paste the value, pick a scope (`project` or
  `user`). The value is written to the OS keyring (desktop shell) or a local
  in-process store (browser mode). You will not see the raw value again.
- **project secrets** are tied to the active project. **User secrets** are
  available across all your projects.
- **check / reveal**: the panel shows the handle mask and lets you confirm
  whether the key is configured. A reveal requires explicit confirmation and
  should be avoided for keys in active use.
- **delete**: removes the handle. If an agent or panel tries to use the deleted
  handle, it will fail and surface an error.

See [secrets & safety](agent-mcp/secrets) for the full policy on how agents use handles.

## look

### appearance

Theme, motion, and surface settings:

- **accent**: the theme accent color. Some functional colors (file-type
  indicators, error/warning states) are not affected by the accent.
- **motion**: reduce motion for animations in the Polypore shell.
- **surface**: panel surface style and glass/blur options.
