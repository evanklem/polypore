---
title: workspaces & panels
group: the ide
order: 2
---

Polypore's surface is a set of **panels** docked into a workspace. A panel is a
single focused tool: the editor, an agent terminal, preview, problems,
diff & history, memory. You arrange them once per kind of work and Polypore
remembers the arrangement.

## areas and slots

Panels dock into **areas**: center, right, and bottom by default. Each panel
declares a `defaultArea` (the editor opens center, an agent terminal opens
right, problems opens bottom), but you can drag any panel to any area, split a
group, or stack panels as tabs. The layout is a real tiling dock: drag a tab to
a group's edge to split, drag it onto another tab to stack.

## workspaces

A **workspace** is a saved panel arrangement. Switching workspaces swaps the
whole layout: building, reviewing and debugging each want different panels in
different places, without losing any of them. Polypore remembers each
workspace's layout independently, so returning to one restores exactly what you
left.

## the panel header

Every panel header carries two affordances on the right:

- **the gear** opens settings scoped to that panel: its permissions,
  capabilities, the `.polypore` config it reads, and any local data it has
  stored (which you can clear from there).
- **the `?`** opens this manual to that panel's page.

## opening and closing

Open a panel from the panel catalog (the **+** affordance) and close it from its
tab. Closing a panel never uninstalls it; the plugin stays installed and the
panel can be reopened. To enable, disable, or uninstall the underlying plugin,
use [settings → panels](the-ide/settings) for panel-level details or [settings → extensions](the-ide/settings)
for installed plugin records.

## panels are plugins

Each panel is a plugin with a manifest (`polypore.json`) declaring its
permissions and capabilities, and a `MANUAL.md` you can read here. Built-in
panels and ones you install behave identically; see [the polypore mcp server](agent-mcp/mcp) for how
an agent opens, focuses, and drives panels through tools.
