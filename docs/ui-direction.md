# operator ide ui direction

status: working visual brief, based on product discussion after the prd.

## core feel

operator ide should feel like a riced linux workspace crossed with adobe-style
dockable panels: glassy, compact, mostly monospace, dark, and stylish without
becoming a dashboard. the ui should be programming-language agnostic. "preview"
means the active run surface for the project: a browser app when relevant, CLI
output or another runtime surface when not.

## visual language

- all visible ui copy should be lowercase.
- background: user-provided fungus photo eventually. until then, use a tasteful
  built-in placeholder treatment that suggests a dark mycology photograph.
- theme: translucent dark panels over the background.
- active panel/tab: visibly frostier and brighter than inactive panels.
- accent: rich honey / amber / brown.
- typography: mostly monospace across the application.
- shape: compact title bars, visible panel borders, small radii.
- chrome: adobe-like dockable panel affordances with title bars and direct drag
  behavior. panel title controls are close, split, and float.
- resizing: every docked panel and split region should be directly resizable,
  adobe-style. fixed proportions are defaults only, never constraints.

## global layout

- built-in workspace: build. users can save their own layouts later.
- top bar: linux status-bar style with workspace, active agent, cycle, context,
  settings, and product/version.
- bottom bar: branch, file/cursor info, agent state, verify state.
- left chat panel: dockable, visible by default, full-height between global bars,
  about one third of the window, resizable by dragging the split.
- main surface: one active tab by default, customizable through future docking.

## build workspace

default workspace for active implementation.

- chat docked left.
- main tab defaults to preview.
- main tabs: preview, code, diff, terminal, history, memory, agent.
- preview is generic runtime output, not web-only.
- code has a file selector bar: folder-like symbol + "select file" on the left,
  current document name centered in the same visual element, and a file picker
  opened from that control.
- diff uses file list left and side-by-side diff right.
- history is a vertical event stream containing agent tool calls and human edits.
- history entries are restore points; users can revert/fork from any change.
- memory combines context visibility with an obsidian-like repo knowledge base.
  it should expose active context, included/excluded files, memories, docs,
  ADRs, and configurable wiki-style project knowledge.
- knowledge base docs are grouped in visually strong folders with smaller,
  indented documents beneath them, like a normal directory tree built for
  hundreds of docs.
- the selected knowledge-base item opens in a document pane, not a "note" pane.
- when context approaches the limit, recommend a handoff instead of compaction:
  the agent writes a self-handoff document into memory/knowledge for the next
  cleared session to read.
- agent is the unified agent cockpit: activity stacked over tasks on the left,
  and a larger formation hierarchy canvas on the right taking roughly two thirds
  of the panel. the hierarchy should let users arrange roles like overseer,
  frontend, cybersecurity, QA, or any custom node tree.
- formation node creation opens a configuration window for role instructions,
  model/tool access, scope, MCPs/plugins, handoff rules, and constraints.

## chat

- hybrid subtle message blocks.
- tool calls appear like claude code-style compact cards.
- clicking a tool card opens agent and navigates to that tool event.

## demo content

for now, demo/static content is acceptable to make the visual prototype feel
alive. demo data must remain obviously mock and should not imply acp, tauri,
monaco, dockview, sqlite, or runtime integrations already exist.
