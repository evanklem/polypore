---
title: project configuration
group: the ide
order: 3
---

Polypore looks for project-level configuration under `.polypore/`. These files
extend the built-in detector lists without changing Polypore source code.

## language servers

Use `.polypore/language-servers.json` when a language server is not in the
built-in registry, or when a project needs a specific command.

```json
{
  "servers": [
    {
      "id": "custom-lsp",
      "command": "custom-language-server",
      "args": ["--stdio"],
      "extensions": ["foo"],
      "filenames": ["Foofile"],
      "languageIds": {
        "foo": "foo"
      }
    }
  ]
}
```

`extensions` and `filenames` decide which files reach the server. `languageIds`
is optional; it maps an extension or filename to the language id the server
expects. The editor also reads these mappings, so a custom extension can show a
project-declared language label and model language instead of falling back to
plain text.

## runtime commands

Use `.polypore/runtime.json` when Preview should know how to run the project.
Configured runtimes appear before auto-detected ones.

```json
{
  "runtimes": [
    {
      "label": "roc app",
      "hint": "dev",
      "defaultUrl": "http://localhost:8000",
      "commands": [
        {
          "name": "dev",
          "command": "roc run app.roc",
          "kind": "site"
        }
      ]
    }
  ]
}
```

`kind` can be `site`, `desktop`, `mobile`, `cli`, `test`, or `game`.

## verify commands

Use `.polypore/verify.json` for repeatable checks the IDE and agents can run.

```json
[
  {
    "id": "roc-check",
    "label": "roc check",
    "command": "roc check",
    "required": true
  }
]
```

The `id` is what `polypore.verify.run` receives. The command can be any project
check, not just a package-manager script.

## diagnostics sources

Use `.polypore/diagnostics.json` when a language's compiler or linter is not in
the built-in detector matrix. Each source declares a command and the named
parser that reads its output. Configured sources run alongside the built-in
detectors in both the fast collect and the deep scan.

```json
{
  "sources": [
    {
      "id": "roc-check",
      "command": "roc check --format=gcc",
      "parser": "generic-colon",
      "deep": false,
      "timeoutSecs": 30
    }
  ]
}
```

`parser` defaults to `generic-colon`, which reads `file:line:col: message`
output and covers most compilers and linters. Other accepted values map to the
built-in parsers: `tsc`, `eslint-json`, `cargo-json`, `msbuild`, `jvm`, `dart`,
`php`, `python-compile`, `bash`, `luac`, `npm-audit`, and `composer`. Set
`deep: true` to run a source only during the deep scan; omit it (the default) to
run in both phases. A bare `[ ... ]` array is accepted in place of the
`{ "sources": [...] }` wrapper.

## formatter commands

Use `.polypore/formatters.json` to make project formatter commands explicit.
The editor format action and `polypore.format.run` both read this file.

```json
{
  "formatters": [
    {
      "id": "roc-format",
      "label": "roc format",
      "command": "roc format {file}",
      "extensions": ["roc"],
      "filenames": ["Rocfile"]
    }
  ]
}
```

`extensions` and `filenames` are optional selectors that tell humans and agents
which files the command is meant to format. When a file is supplied,
`{file}`, `{path}`, `{basename}`, and `{dir}` are shell-quoted before the
command runs.

## file tree filters

Use `.polypore/file-tree.json` when the built-in file tree heuristics hide a
source-of-truth directory or show project-specific generated files.

```json
{
  "includeDirs": ["src-tauri/target"],
  "excludeDirs": ["generated", "vendor/cache"],
  "textExtensions": ["roc", "rlib"],
  "binaryExtensions": ["snap"]
}
```

`includeDirs` can restore a built-in skipped directory such as `target` for a
specific project path. `excludeDirs` hides generated paths by name or relative
path. `textExtensions` and `binaryExtensions` override the default text/binary
extension heuristic.

## editing from settings

The [settings → project](the-ide/settings) section can create these files for runtime commands,
language servers, verify commands, diagnostics sources, formatter commands, and
file tree filters. Editing the JSON directly is equivalent; settings and panels
read the same project files.
