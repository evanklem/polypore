# Polypore Language Agnosticism Audit

Date: 2026-06-02

## Verdict

Polypore is not fully programming-language agnostic today.

The most accurate description is: language-broad, plugin-oriented, and extensible, with an agnostic shell, but not end-to-end language neutral. The core Dockview/plugin architecture treats panels uniformly. The terminal can run arbitrary commands. Monaco syntax and the LSP registry cover many languages. Project config and settings can add custom language servers, runtime commands, verify commands, and debug launch presets.

The remaining gaps are in first-run defaults, provider defaults, and finite detector matrices: TypeScript/JavaScript still receive special editor hydration, agent/team defaults are still Claude/Codex-oriented, and several systems remain broad but matrix-based unless project configuration fills the gaps.

## Remediation Progress

Completed on 2026-06-02:

- Preview no longer falls back to `npm start`, uses a neutral manual command state, and exposes all detected runtimes in polyglot repos instead of stopping at the first Node match.
- Editor status labels now use Monaco's language registry or generic extension/filename labels instead of a tiny TypeScript/JavaScript/Rust whitelist.
- File tree visibility no longer hides `.lock` files.
- MCP `polypore.verify.run` now accepts arbitrary declared IDs, auto-detects verify commands across common non-JavaScript stacks, and has smoke coverage for custom declared commands plus Cargo auto-detection.
- Diff/history branch comparison now uses the configured upstream/default ref instead of hard-coded `origin/main`.
- Debug start no longer defaults to `vscode-js-debug`; callers must pass an adapter, a known `config.type`, or `config.adapterCommand`.
- Terminal and Verify panel default text no longer advertises npm commands as the generic path.
- Launcher template categories render `general` first and then alphabetically, avoiding web-first category ordering.
- Browser blank scaffolding now writes a broader ignore seed covering common build artifacts across Node, Rust, Python, and generic env files.
- Settings now has a project tab for runtime commands, language servers, verify commands, formatter commands, debug launch presets, and file tree filters, backed by `.polypore/runtime.json`, `.polypore/language-servers.json`, `.polypore/verify.json`, `.polypore/formatters.json`, `.polypore/debug.json`, and `.polypore/file-tree.json`.
- Preview now reads `.polypore/runtime.json` before auto-detection, so unsupported ecosystems can provide project-level runtime commands without source changes.
- Preview runtime selection is now persisted per project via host `project` state and a local runtime preference key.
- The debug panel now reads `.polypore/debug.json`, probes configured adapter availability, and starts available launch presets through `host.debug.start`.
- The manual now documents `.polypore/language-servers.json`, `.polypore/runtime.json`, `.polypore/verify.json`, `.polypore/formatters.json`, `.polypore/debug.json`, and `.polypore/file-tree.json`, with corpus contract coverage for frontend and MCP readers.
- Plain terminal quick-launch defaults no longer advertise `claude` or `codex`; they start with generic shell/VCS commands.
- File tree generated-directory and text/binary heuristics are now configurable through `.polypore/file-tree.json`, exposed in project settings and documented in the manual.
- Formatter commands declared in `.polypore/formatters.json` can now run from the editor and through MCP `polypore.format.run`, with file placeholder substitution.
- Desktop Verify package-script detection now respects declared `packageManager` and pnpm/yarn/bun/npm lockfiles instead of always emitting npm commands.
- Problems now preserves `error`, `warn`, `info`, and `hint` severities instead of collapsing every non-error diagnostic to warning.
- Git chrome now displays the resolved upstream/default comparison ref from project status instead of fabricating `origin/{branch}`.

Update 2026-06-02 (second pass):

- CLI diagnostics are no longer a closed matrix. Projects declare custom diagnostics sources in `.polypore/diagnostics.json` (command + named parser, optional `deep`/`timeoutSecs`); they run in both the fast collect and the deep scan alongside the built-ins. `parser` defaults to the generic `file:line:col: message` reader and maps to every built-in parser. Covered by `diagnostics::tests::project_*`.
- Debug launch configs are now portable: the DAP layer substitutes `${workspaceFolder}` / `${workspaceRoot}` / `${workspaceFolderBasename}` against the active project root and defaults `cwd` to the root when unset. Covered by `dap::tests::substitutes_workspace_vars_and_defaults_cwd` and `explicit_cwd_is_preserved`.
- The debug panel now suggests language-detected presets: when the project contains files of a language whose adapter (`debugpy`, `delve`, `lldb-dap`, `vscode-js-debug`) is installed, a ready-to-start preset appears marked `suggested`. Suggestions are hidden when the adapter is off PATH and yield to any configured preset for the same adapter. Covered by two new `verify panel ... suggest` tests.
- The Settings project tab now edits `.polypore/diagnostics.json` (id, command, parser, deep) like the other project configs, and the manual + `docs/language-diagnostics.md` document it.

Not complete yet:

- TS/JS Monaco import hydration remains a higher-quality path than other languages.
- Chat/agent defaults remain provider-specific (`claude`/`codex`) rather than agent-runtime agnostic.
- The project settings tab edits all project config files but does not yet show a read-only roster of *detected* (auto-detected) language servers, runtimes, and debug adapters with availability.
- Web auto-driving still depends on Playwright/Node; VCS history is still Git-only.

## Definition Used

I treated "truly programming-language agnostic" as:

- The IDE can open, edit, diagnose, run, debug, verify, and navigate projects in arbitrary languages without a single ecosystem being required.
- Unsupported languages can be added through documented project/plugin configuration without source changes.
- Visible panels do not steer users toward one language/toolchain unless the project itself indicates that language.
- The same quality of experience is available across languages, or the UI clearly exposes where a language needs configuration.

By that standard, Polypore is partially agnostic. It has strong extension points, but the shipped product experience is still shaped by hard-coded language/tool/provider choices.

## Executive Matrix

| Surface | Agnosticism | Evidence | Main limitation |
| --- | --- | --- | --- |
| Shell/layout/plugin host | Strong | Build-time plugin discovery and uniform panel surface | Default workspace includes Codex/Claude and a fixed panel set |
| Launcher/new project | Partial | Broad template catalog plus blank project | Categories now avoid web-first ordering; browser fallback only has blank and a heuristic `.gitignore` |
| Chat | Language-neutral, provider-specific | Chat slots are Codex and Claude terminal panels | Only Codex/Claude are first-class chat agents |
| Preview/run | Partial | Detectors for Node, Rust, Python, Go, JVM, .NET, BEAM, Ruby, PHP, Dart, CMake, Bazel, Nix, Make, Docker Compose plus `.polypore/runtime.json` | Runtime commands are configurable, but richer runtime config is still small |
| Editor | Partial to strong | Monaco basic-language registry, LSP diagnostics, custom language-server config, project formatter action | TS/JS get special import graph and package hydration |
| File tree | Stronger | Textual files only, generated dirs skipped; lockfiles visible; `.polypore/file-tree.json` overrides | Default filtering remains heuristic when no project config exists |
| Terminal | Strong core | Real portable pty, login shell, arbitrary command | Agent-CLI slash mode still recognizes only `claude`/`codex` |
| Verify/debug panel | Partial | Arbitrary `.polypore/verify.json`; broad auto-detect; generic DAP protocol; project debug presets | Debug and verify are broad but still use built-in detector/adapter lists unless configured |
| Problems | Inherits diagnostics | Displays host diagnostics from any source and preserves severity | Depends on diagnostics coverage |
| Diff/history | Language-neutral, VCS-specific | Unified diff parser is text-based; branch comparison uses configured upstream/default ref | Git-only |
| Memory | Programming-language neutral | Loads context/docs independent of code language | Knowledge docs are Markdown/wiki-specific |
| Agent/formation | Language-neutral, provider/workflow-biased | Custom roles, tools, prompts | Defaults to Claude models and Codex/Claude targets |
| Settings/manual/overlays | Mostly neutral | Plugin management, manual corpus, credentials, interface, project runtime/LSP/verify/formatter/debug/file-tree config | Agent settings only expose Codex/Claude probes |
| Top/bottom chrome | Language-neutral, Git-specific | Project open/recent/scaffold actions; Git menu uses reported upstream/default ref | Git-only |

## Core Architecture

The strongest agnostic foundation is the panel/plugin shell.

- `src/App.tsx:41` through `src/App.tsx:52` discovers plugins with `import.meta.glob('../plugins/*/index.ts')`; `App.tsx` does not manually import each panel.
- `src/PanelSurface.tsx:20` through `src/PanelSurface.tsx:22` documents that every Dockview panel uses the same surface path, either trusted React or sandboxed iframe.
- `src/PolyporeDockview.tsx:19` through `src/PolyporeDockview.tsx:22` explicitly treats chat, editor, preview, and the rest as ordinary Dockview panels.
- `src/workspaces/presets.ts:7` mounts the default panel set: Codex, Claude, Preview, Editor, Diff, Terminal, Verify, Memory, Extensions.

This is good architecture for language agnosticism: adding a language-oriented panel should not require new shell concepts. The default workspace, however, is not neutral in provider terms because Codex and Claude are always part of the preset.

## Panel-By-Panel Audit

### Launcher And Project Creation

Status: partial.

Positive evidence:

- The desktop template catalog starts with `blank` as `language: "any"` at `src-tauri/src/project.rs:122` through `src-tauri/src/project.rs:129`.
- The catalog is broad: Python starts at `src-tauri/src/project.rs:267`, Rust at `src-tauri/src/project.rs:320`, Go at `src-tauri/src/project.rs:366`, and the later catalog includes JVM, native, BEAM, Ruby, PHP, functional, Lua, mobile, desktop, ML, and data templates.
- Browser-only mode still has a blank template at `src/Launcher.tsx:45` through `src/Launcher.tsx:53`.

Limitations:

- The first large block after blank is TypeScript/web: Vite, Next, Nuxt, SvelteKit, Astro, Remix, Node, Bun, and Deno appear before Python/Rust/Go at `src-tauri/src/project.rs:131` through `src-tauri/src/project.rs:265`.
- Browser fallback template support is only blank, and `createBrowserBlankProject` writes a heuristic `.gitignore` seed at `src/Launcher.tsx:50` through `src/Launcher.tsx:64`.

Conclusion: the launcher is language-broad, with neutralized category ordering but only a blank browser fallback.

### Chat Panels

Status: language-neutral, provider-specific.

Evidence:

- The chat plugin is generated only for `codex` and `claude` at `plugins/chat/index.ts:5`, with metadata at `plugins/chat/index.ts:9` through `plugins/chat/index.ts:12`.
- Each chat panel is just a terminal panel with `initialCommand: agent` at `plugins/chat/index.ts:28` through `plugins/chat/index.ts:36`.
- Shared delivery only recognizes Codex/Claude slots at `plugins/shared/chat-targets.ts:18` through `plugins/shared/chat-targets.ts:21`.

Impact:

This does not make Polypore language-specific, but it does mean "agnostic IDE" cannot also imply agent-provider agnostic. The coding language can be anything; the first-class chat providers cannot.

### Preview / Run Panel

Status: partial.

Positive evidence:

- Runtime detectors cover many ecosystems: Cargo/Rust at `plugins/preview/component.tsx:588`, Python at `plugins/preview/component.tsx:609`, Go at `plugins/preview/component.tsx:639`, and many more in the detector array at `plugins/preview/component.tsx:1080` through `plugins/preview/component.tsx:1101`.
- Project runtime declarations are read from `.polypore/runtime.json` at `plugins/preview/component.tsx:507` through `plugins/preview/component.tsx:535` and merged ahead of built-in detectors at `plugins/preview/component.tsx:1108` through `plugins/preview/component.tsx:1131`.
- Manual command editing exists, and command/URL controls are plain text inputs.
- URL override logic is honest about non-Node limitations: Django, PHP, and custom Go commands are returned unchanged at `plugins/preview/component.tsx:246` through `plugins/preview/component.tsx:248`.

Limitations:

- Runtime detection is still a built-in finite matrix unless the project declares runtime commands.
- Polyglot repos now show all detected/configured runtimes, and the user's chosen runtime is restored per project at `plugins/preview/component.tsx:1290` through `plugins/preview/component.tsx:1306` and `plugins/preview/component.tsx:1365` through `plugins/preview/component.tsx:1385`.

Impact:

Preview is now materially less biased. Unknown ecosystems can declare commands, and polyglot runtime choice persists, but runtime configuration is still a small command-focused contract.

### Editor Panel

Status: strong syntax coverage, project language-id mappings, partial language experience.

Positive evidence:

- Monaco is imported through `editor.main`, which registers basic language contributions, with comments calling out TS/JS/CSS/HTML/JSON/Markdown/Rust/Python/YAML at `plugins/editor/component.tsx:352` through `plugins/editor/component.tsx:373`.
- File language selection asks Monaco's registered language list instead of maintaining a syntax whitelist at `plugins/editor/component.tsx:1479` through `plugins/editor/component.tsx:1514`.
- The editor reads `.polypore/language-servers.json` at `plugins/editor/component.tsx:187` through `plugins/editor/component.tsx:195`, registers project-declared language ids with Monaco at `plugins/editor/component.tsx:502` through `plugins/editor/component.tsx:511`, and prefers project `languageIds` when assigning a model language at `plugins/editor/component.tsx:1516` through `plugins/editor/component.tsx:1568`.
- Project language-id mapping has renderer coverage at `src/App.test.tsx:2465` through `src/App.test.tsx:2481`.
- Editor diagnostics render host diagnostics and Monaco markers; the Problems menu uses diagnostic source/file/line data at `plugins/editor/component.tsx:884` through `plugins/editor/component.tsx:900`.
- The new editor can display breakpoints and debug stop positions through host debug state at `plugins/editor/component.tsx:543` through `plugins/editor/component.tsx:576`.
- The editor reads `.polypore/formatters.json`, matches formatters by extension/filename, runs them through the terminal host, reloads the file, and exposes a formatter selector/action at `plugins/editor/component.tsx:197` through `plugins/editor/component.tsx:205`, `plugins/editor/component.tsx:684` through `plugins/editor/component.tsx:718`, and `plugins/editor/component.tsx:847` through `plugins/editor/component.tsx:864`.
- Formatter command placeholders are shell-quoted before execution at `plugins/editor/component.tsx:1086` through `plugins/editor/component.tsx:1098`.

Limitations:

- Monaco workers are specialized for TypeScript/JavaScript, JSON, CSS, and HTML; all other labels use the generic editor worker at `plugins/editor/component.tsx:358` through `plugins/editor/component.tsx:365`.
- TypeScript/JavaScript get a special compiler options path at `plugins/editor/component.tsx:1140` through `plugins/editor/component.tsx:1158`.
- TypeScript/JavaScript get import graph and package type hydration from `node_modules` at `plugins/editor/component.tsx:956` through `plugins/editor/component.tsx:1129`.

Impact:

Syntax highlighting and visible metadata are broad, but editor UX is not equal: TS/JS get import graph/package hydration that other languages do not.

### File Tree

Status: stronger, configurable heuristics.

Evidence:

- The native tree caps depth and file count at `src-tauri/src/fs_watch.rs:434` through `src-tauri/src/fs_watch.rs:442`.
- It reads `.polypore/file-tree.json` at `src-tauri/src/fs_watch.rs:195` through `src-tauri/src/fs_watch.rs:199`.
- It applies configured include/exclude directory overrides at `src-tauri/src/fs_watch.rs:521` through `src-tauri/src/fs_watch.rs:553`.
- It applies configured text/binary extension overrides at `src-tauri/src/fs_watch.rs:575` through `src-tauri/src/fs_watch.rs:585`.
- The shared file tree UI can style lockfiles at `plugins/shared/file-tree.tsx:160` through `plugins/shared/file-tree.tsx:163`.
- Project settings expose file-tree filters at `src/settings/tabs/ProjectTab.tsx:593` through `src/settings/tabs/ProjectTab.tsx:629`.
- The manual documents `.polypore/file-tree.json` at `docs/manual/the-ide/project-configuration.md:130` through `docs/manual/the-ide/project-configuration.md:147`.

Impact:

Dependency lockfiles are visible, and projects can override generated-directory and text/binary heuristics. The default tree remains heuristic when no project config is present.

### Language Server / Diagnostics Pipeline

Status: broad and extensible, but finite.

Positive evidence:

- Project-level custom language servers are supported through `.polypore/language-servers.json`; docs show `extensions`, `filenames`, and `languageIds` at `docs/language-diagnostics.md:9` through `docs/language-diagnostics.md:36`.
- The native LSP registry appends project config to built-ins at `src-tauri/src/lsp.rs:594` through `src-tauri/src/lsp.rs:604`.
- Built-in LSP specs cover a wide set of languages at `src-tauri/src/lsp.rs:613` through `src-tauri/src/lsp.rs:749`.
- Default language IDs cover many languages at `src-tauri/src/lsp.rs:773` through `src-tauri/src/lsp.rs:822`.
- Unsaved-document diagnostics are supported through `lsp_diagnostics_document` at `src-tauri/src/lsp.rs:114` through `src-tauri/src/lsp.rs:150`.

Limitations:

- Collection only takes up to 80 matched files per server at `src-tauri/src/lsp.rs:72` through `src-tauri/src/lsp.rs:78`.
- Project file discovery stops around 300 files at `src-tauri/src/lsp.rs:488` through `src-tauri/src/lsp.rs:502`.
- The server probe assumes `command --version` at `src-tauri/src/lsp.rs:152` through `src-tauri/src/lsp.rs:190`; some LSP servers do not expose a conventional version probe.
- Light CLI diagnostics only auto-detect TypeScript, ESLint, and Cargo at `src-tauri/src/diagnostics.rs:207` through `src-tauri/src/diagnostics.rs:219`.
- Deep scan adds many ecosystems at `src-tauri/src/diagnostics.rs:221` through `src-tauri/src/diagnostics.rs:282`, but it is still a hard-coded matrix.
- TypeScript aliases receive a dedicated resolver at `src-tauri/src/diagnostics.rs:1010` through `src-tauri/src/diagnostics.rs:1085`; there is no equivalent generic resolver for Python, Go, JVM, etc.

Impact:

The LSP story is a real agnostic extension point and settings now expose it. The diagnostics story is broad by default, but not universal, because source detection is still a hard-coded matrix.

### Terminal Panel

Status: strong core, provider-specific agent mode.

Positive evidence:

- The terminal uses xterm.js plus portable pty, explicitly to support interactive programs, at `plugins/terminal/component.tsx:200` through `plugins/terminal/component.tsx:221`.
- The native pty spawns commands in the active project root at `src-tauri/src/pty.rs:66` through `src-tauri/src/pty.rs:75`.
- Empty command launches the user's login shell, and non-empty command wraps through `sh -lc` on Unix at `src-tauri/src/pty.rs:240` through `src-tauri/src/pty.rs:266`.
- Plain shell quick-launch defaults are now generic shell/VCS commands at `plugins/terminal/component.tsx:15` through `plugins/terminal/component.tsx:17`, with coverage at `src/App.test.tsx:455` through `src/App.test.tsx:470`.

Limitations:

- Agent detection and slash buckets are limited to `claude` and `codex` at `plugins/terminal/component.tsx:9` through `plugins/terminal/component.tsx:17`.

Impact:

The terminal can run anything. Plain shell shortcuts no longer promote built-in AI CLIs, but agent-CLI slash-command tracking is still Codex/Claude-specific.

### Verify / Debug Panel

Status: partial.

Positive evidence:

- The panel queue prompt is language-neutral and tells the agent to run relevant checks and use debug tools when needed at `plugins/verify/component.tsx:62` through `plugins/verify/component.tsx:73`.
- The UI accepts custom problems and custom checks; the custom check placeholder is just an example at `plugins/verify/component.tsx:461` through `plugins/verify/component.tsx:465`.
- Desktop verify reads `.polypore/verify.json` and appends auto-detected commands at `src-tauri/src/persistence.rs:328` through `src-tauri/src/persistence.rs:346`.
- Desktop verify auto-detects npm scripts, Cargo, Go, Python, Ruff, Maven, Gradle, .NET, SBT, Mix, Composer, Swift, Flutter, and Dart at `src-tauri/src/persistence.rs:349` through `src-tauri/src/persistence.rs:419`.
- Desktop verify package-script commands infer npm/pnpm/yarn/bun from `packageManager` and lockfiles at `src-tauri/src/persistence.rs:422` through `src-tauri/src/persistence.rs:473`, with Rust coverage at `src-tauri/src/persistence.rs:1403` through `src-tauri/src/persistence.rs:1461`.
- The MCP sidecar schema accepts arbitrary verify IDs at `schemas/mcp-tools.schema.json:86` through `schemas/mcp-tools.schema.json:97`.
- The MCP sidecar reads declared commands and auto-detects package scripts, Cargo, Go, Python, JVM, .NET, BEAM, PHP, Swift, Dart, and Flutter at `packages/mcp-server/src/server.mjs:845` through `packages/mcp-server/src/server.mjs:1065`.
- MCP exposes `polypore.format.run`, validates its schema, reads declared formatter commands, filters by file selectors, substitutes placeholders, and runs only declared commands at `packages/mcp-server/src/server.mjs:54`, `schemas/mcp-tools.schema.json:141` through `schemas/mcp-tools.schema.json:154`, and `packages/mcp-server/src/server.mjs:877` through `packages/mcp-server/src/server.mjs:958`.
- MCP pipeline smoke covers declared formatter execution at `scripts/mcp-pipeline-smoke.mjs:76` through `scripts/mcp-pipeline-smoke.mjs:89`.

Limitations:

- Desktop and MCP verify still maintain separate detector implementations, which can drift.

Impact:

Verify is extensible and broad across both desktop and sidecar paths. The remaining risk is implementation drift between the two detector registries.

### Debug Suite

Status: generic protocol, adapter probing, partial discovery UX.

Positive evidence:

- The native debug implementation is a DAP client at `src-tauri/src/dap.rs:1` through `src-tauri/src/dap.rs:11`.
- It starts arbitrary adapter processes resolved through `adapter_command` at `src-tauri/src/dap.rs:211` through `src-tauri/src/dap.rs:219`.
- Config can override `adapterCommand` and `adapterArgs` at `src-tauri/src/dap.rs:724` through `src-tauri/src/dap.rs:735`.
- Built-in adapter aliases include JS, Python, LLDB, and Go/Delve at `src-tauri/src/dap.rs:736` through `src-tauri/src/dap.rs:744`.
- Native `debug_adapter_probe` resolves the same adapter command and checks PATH availability at `src-tauri/src/dap.rs:748` through `src-tauri/src/dap.rs:778`.
- Host `debug.probe` resolves explicit adapters, `config.adapterCommand`, or known `config.type` values before delegating to the shell at `packages/host/src/rpc-server.ts:2156` through `packages/host/src/rpc-server.ts:2184`.
- Host debug start uses the same adapter resolver for JS, Python, Go, and LLDB, then rejects missing adapter metadata at `packages/host/src/rpc-server.ts:3370` through `packages/host/src/rpc-server.ts:3388`.
- The debug panel loads and probes project presets from `.polypore/debug.json` at `plugins/verify/component.tsx:144` through `plugins/verify/component.tsx:157`, blocks starts when a probe reports unavailable at `plugins/verify/component.tsx:303` through `plugins/verify/component.tsx:325`, and renders availability details at `plugins/verify/component.tsx:588` through `plugins/verify/component.tsx:610`.
- MCP exposes `polypore.debug.probe` at `packages/mcp-server/src/server.mjs:154` through `packages/mcp-server/src/server.mjs:157`, maps it to `debug.probe` at `packages/mcp-server/src/server.mjs:267`, and documents the tool at `packages/mcp-server/src/server.mjs:353`.

Limitations:

- Project debug presets validate configured adapter command availability before start, but the panel does not yet suggest detected adapters by language.
- Web auto-navigation is optional and explicitly Playwright/Node-based at `src-tauri/src/webdriver.rs:1` through `src-tauri/src/webdriver.rs:13`.
- Project-local Playwright detection checks `node_modules` at `src-tauri/src/webdriver.rs:103` through `src-tauri/src/webdriver.rs:109`.

Impact:

The DAP layer can be language-agnostic with configuration. The remaining gaps are adapter discovery/suggestions and avoiding a browser automation helper that depends on Node/Playwright.

### Problems Panel

Status: inherits diagnostics.

Evidence:

- Problems reads `host.diagnostics.list()` and labels rows by diagnostic source at `plugins/problems/component.tsx:5` through `plugins/problems/component.tsx:27`.
- It can open any problem file through the editor at `plugins/problems/component.tsx:48` through `plugins/problems/component.tsx:58`.
- The shared conversion preserves diagnostic severities at `plugins/shared/diagnostics.ts:3` through `plugins/shared/diagnostics.ts:17`; row styles cover info and hint at `src/App.css:6196` through `src/App.css:6201`.
- App coverage asserts that info/hint rows keep their severity classes at `src/App.test.tsx:2464` through `src/App.test.tsx:2502`.

Impact:

The panel is language-neutral as a renderer, but its quality depends on LSP/deep-scan coverage.

### Diff / History Panel

Status: language-neutral, Git-specific.

Positive evidence:

- The diff parser operates on unified diff text, independent of programming language, starting at `plugins/diff-history/component.tsx:17`.

Limitations:

- The panel is still Git-only; non-Git VCS projects do not get an equivalent diff/history flow.

Impact:

This is not a programming-language issue, but it is an IDE-agnostic issue. Non-Git projects are still second-class, even though Git branch comparison no longer assumes `origin/main`.

### Memory Panel

Status: programming-language neutral, document-format specific.

Positive evidence:

- The memory base preset is generic knowledge storage; the basic preset has `raw` and `wiki` folders at `plugins/memory/component.tsx:103` through `plugins/memory/component.tsx:124`.
- Context loading is tied to Codex/Claude chat targets, not a programming language, at `plugins/memory/component.tsx:98`.

Limitations:

- New documents are forced to `.md` at `plugins/memory/component.tsx:665` through `plugins/memory/component.tsx:682`.
- The new-document placeholder is `notes/decision.md` at `plugins/memory/component.tsx:1355` through `plugins/memory/component.tsx:1364`.
- Preview is Markdown/wiki-oriented at `plugins/memory/component.tsx:1031` through `plugins/memory/component.tsx:1047` and `plugins/memory/component.tsx:1965` through `plugins/memory/component.tsx:2022`.

Impact:

This does not block programming-language agnosticism, but it means the knowledge panel is not document-format agnostic.

### Agent / Formation Panel

Status: language-neutral, provider/workflow-biased.

Positive evidence:

- Tools are generic task capabilities: edit, bash, web, search, git, MCP, verify, memory at `plugins/agent/component.tsx:156` through `plugins/agent/component.tsx:165`.
- Templates are editable and custom templates are merged with built-ins at `plugins/agent/component.tsx:281` through `plugins/agent/component.tsx:310`.

Limitations:

- Model options are hard-coded around Claude, Codex, and GPT-5 at `plugins/agent/component.tsx:146` through `plugins/agent/component.tsx:154`.
- The frontend template says `UI implementation - React + CSS` at `plugins/agent/component.tsx:193` through `plugins/agent/component.tsx:200`.
- Blank/custom template defaults to `claude-sonnet` at `plugins/agent/component.tsx:271` through `plugins/agent/component.tsx:290`.
- Provider detection is string-based for Claude/Codex at `plugins/agent/component.tsx:357` through `plugins/agent/component.tsx:361`.
- Codex-to-Claude handoffs are explicitly blocked at `plugins/agent/component.tsx:368` through `plugins/agent/component.tsx:382`.
- Formation delivery goes to live Claude/Codex terminals at `plugins/agent/component.tsx:1622` through `plugins/agent/component.tsx:1641`.

Impact:

The panel can coordinate work in any programming language, but default teams and provider assumptions are not agnostic.

### Settings, Panel Settings, And Manual

Status: mostly language-neutral, with project configuration UX.

Evidence:

- Settings sections include project settings at `src/settings/SettingsSurface.tsx:19` through `src/settings/SettingsSurface.tsx:26`.
- Project settings load and write `.polypore/runtime.json`, `.polypore/language-servers.json`, `.polypore/verify.json`, `.polypore/formatters.json`, `.polypore/debug.json`, and `.polypore/file-tree.json` at `src/settings/tabs/ProjectTab.tsx:125` through `src/settings/tabs/ProjectTab.tsx:177`.
- Project settings expose runtime command, language server, verify-command, formatter-command, debug launch preset, and file-tree filter forms at `src/settings/tabs/ProjectTab.tsx:250` through `src/settings/tabs/ProjectTab.tsx:629`.
- Project settings can write language server `languageIds` mappings at `src/settings/tabs/ProjectTab.tsx:220` through `src/settings/tabs/ProjectTab.tsx:240` and `src/settings/tabs/ProjectTab.tsx:445` through `src/settings/tabs/ProjectTab.tsx:450`, with settings coverage at `src/settings/SettingsSurface.test.tsx:64` through `src/settings/SettingsSurface.test.tsx:78`.
- Project settings can write explicit debug adapter ids and adapter arguments at `src/settings/tabs/ProjectTab.tsx:300` through `src/settings/tabs/ProjectTab.tsx:326`, with settings coverage at `src/settings/SettingsSurface.test.tsx:108` through `src/settings/SettingsSurface.test.tsx:128`.
- Agent install hints are Codex/Claude only at `src/settings/tabs/AgentsTab.tsx:11` through `src/settings/tabs/AgentsTab.tsx:15`.
- Credentials default to an Anthropic API key/service at `src/settings/tabs/CredentialsTab.tsx:9` through `src/settings/tabs/CredentialsTab.tsx:13`.
- Panel settings expose plugin metadata, category, permissions, and enable/disable state at `src/components/overlays/PanelSettingsOverlay.tsx:90` through `src/components/overlays/PanelSettingsOverlay.tsx:130`.
- The manual corpus is generated from docs plus plugin `MANUAL.md` and `polypore.json` files at `src/manual/loadManualCorpus.ts:1` through `src/manual/loadManualCorpus.ts:52`.
- Project configuration docs cover language servers, runtime commands, verify commands, formatter commands, debug launch presets, and file tree filters at `docs/manual/the-ide/project-configuration.md:7` through `docs/manual/the-ide/project-configuration.md:162`.
- Agent/MCP docs tell agents to use declared formatter commands and probe debug preset adapter/config fields instead of guessing at `docs/manual/agent-mcp/mcp.md:29` through `docs/manual/agent-mcp/mcp.md:45`.
- The editor manual documents custom language ids, formatter actions, and placeholders at `plugins/editor/MANUAL.md:6` through `plugins/editor/MANUAL.md:28`.
- Verify/debug panel docs explain `.polypore/debug.json` presets and adapter probes at `plugins/verify/MANUAL.md:24` through `plugins/verify/MANUAL.md:28`.
- Manual corpus coverage asserts that the project configuration page reaches both frontend and MCP readers at `src/manual/manualCorpus.contract.test.ts:55` through `src/manual/manualCorpus.contract.test.ts:66`.

Impact:

Settings now expose the main project-level language/runtime/verify/formatter/debug/file-tree files, and the editor/MCP surfaces can run declared formatter commands. The Verify panel validates debug adapter command availability, but settings still do not suggest detected debug adapters or agent-runtime/provider setup beyond Codex/Claude probes.

### Top Bar, Bottom Bar, And Project Chrome

Status: language-neutral, Git-specific.

Evidence:

- Project menu actions are open/new/recent templates at `src/components/topbar/ProjectMenu.tsx:87` through `src/components/topbar/ProjectMenu.tsx:99`.
- Git menu exposes status/fetch/pull/push/log at `src/components/topbar/GitMenu.tsx:4` through `src/components/topbar/GitMenu.tsx:10`.
- Project status reports the resolved upstream/default comparison ref at `src-tauri/src/project.rs:36` through `src-tauri/src/project.rs:41` and `src-tauri/src/project.rs:610` through `src-tauri/src/project.rs:623`.
- Git menu displays that reported ref instead of fabricating `origin/{branch}` at `src/components/topbar/GitMenu.tsx:20` through `src/components/topbar/GitMenu.tsx:65`, with renderer coverage at `src/App.test.tsx:277` through `src/App.test.tsx:295`.
- Bottom bar displays branch, project, dirty state, and path at `src/components/BottomBar.tsx:25` through `src/components/BottomBar.tsx:31`.

Impact:

No programming-language bias here, but the IDE chrome assumes Git workflows.

## Cross-Cutting Findings

### High: Runtime/verify/debug paths have inconsistent agnosticism

Preview, Verify, and Debug all have extensibility hooks, but they are uneven:

- Preview and Verify are now configurable by project files/settings, but their auto-detection remains finite.
- Desktop Verify and MCP Verify both support broad detection, but they maintain separate detector registries.
- Debug protocol is DAP and no longer defaults to JS. Project settings can write debug launch presets with explicit `adapter`, `config.type`, `adapterCommand`, and `adapterArgs`, and the debug panel/MCP can probe adapter availability before starting them. Web driving still depends on Playwright, and adapter discovery/suggestions are limited.

This is the biggest reason Polypore should not claim "truly language agnostic" without qualification.

### Medium: Runtime configuration is command-focused

Preview now presents all detected/configured runtimes and restores the selected runtime per project. The remaining gap is richer runtime configuration, such as launch profiles, environment variables, and explicit debug adapter pairing.

### Medium: TS/JS editor hydration remains better than other languages

Monaco language lookup and labels are broad, but TypeScript/JavaScript still receive package/import hydration that other ecosystems cannot configure.

### Medium: Provider-specific agent defaults are pervasive

This is not a programming-language blocker, but it affects the broader "agnostic IDE" claim. Codex/Claude assumptions exist in chat, terminal agent-CLI mode, memory context targets, formation delivery, settings, and native agent runtimes.

### Medium: VCS support is Git-only

Diff/History is still Git-specific. That is independent of programming language but still important for IDE agnosticism.

### Low: Memory is Markdown/wiki-specific

This is reasonable for a knowledge panel, but the panel should not be described as document-format agnostic.

## Recommendations

1. Finish Preview runtime configuration.
   - Extend runtime declarations with env, working directory, and optional debug adapter metadata.

2. Keep Verify MCP and desktop Verify aligned.
   - Share the desktop auto-detect command registry or expose it through host RPC so the sidecar and shell do not drift.

3. Make editor intelligence configurable beyond TS/JS.
   - Add project-configured import graph/hydration hooks for non-TS languages instead of only TypeScript package hydration.
   - Keep editor metadata backed by Monaco and project config rather than tiny extension maps.

4. Keep file-tree filtering visible.
   - Add detected-config feedback in the file tree so users can see when project overrides are active.

5. Extend project settings.
   - Show detected language servers and their availability.
   - Show detected Preview runtimes and Verify commands.
   - Show detected debug adapters and suggest presets for configured languages.

6. Make Debug configuration first-class.
   - If Python files and `debugpy` are detected, offer Python.
   - If Go and `dlv` are detected, offer Go.
   - If Rust/C/C++ and `lldb-dap` are detected, offer LLDB.

7. Broaden history beyond the current Git modes.
   - Let users choose arbitrary refs.
   - Consider non-Git VCS adapters or a project history abstraction.

8. Separate programming-language agnosticism from provider agnosticism in product language.
   - "Works across many programming languages and supports custom language servers" is defensible.
   - "Provider agnostic" or "truly language agnostic" is not defensible today without addressing defaults.

## Bottom Line

Polypore has the right shell architecture for a language-agnostic IDE, and several important subsystems are already extensible. The current implementation is not truly language agnostic end to end because the default experience still contains TS/JS-specific editor hydration, Codex/Claude provider assumptions, Git-only history, and finite runtime/diagnostics/debug matrices.

The path to a stronger claim is not a rewrite. It is mostly:

- replace single-default assumptions with detected-choice UIs,
- move finite matrices behind project-configurable registries,
- suggest configured debug adapters by language,
- and give non-TS languages configurable editor intelligence hooks.
