# Language Diagnostics

Polypore asks language servers for active unsaved editor-buffer diagnostics and
uses Monaco diagnostics where Monaco already ships a validator. The Tauri host
includes language-server specs for common web, systems, scripting, data, and
mobile languages. A language server must be installed on `PATH` for its spec to
run.

Projects can add language servers without changing Polypore by creating
`.polypore/language-servers.json`:

```json
{
  "servers": [
    {
      "id": "custom-lsp",
      "command": "custom-language-server",
      "args": ["--stdio"],
      "extensions": ["foo", "bar"],
      "filenames": ["Foofile"],
      "languageIds": {
        "foo": "foo",
        "Foofile": "foo-build"
      }
    }
  ]
}
```

`extensions` and `filenames` select which open documents reach the server.
`languageIds` is optional. Keys can be extensions or exact filenames; omitted
keys use Polypore's built-in language-id mapping or the extension itself.

Project specs extend the built-in registry. Diagnostics are requested for the
active document after typing settles, so the server receives unsaved content
through LSP `textDocument/didOpen` instead of requiring the file to be saved.

## CLI diagnostics sources

For languages whose checker is a command-line compiler or linter rather than a
language server, Polypore also runs CLI diagnostics. The built-in matrix covers
many ecosystems (tsc, ESLint, Cargo, Go, Python, JVM, .NET, and more), and any
project can add its own without changing Polypore by creating
`.polypore/diagnostics.json`:

```json
{
  "sources": [
    { "id": "roc-check", "command": "roc check --format=gcc", "parser": "generic-colon" }
  ]
}
```

`parser` defaults to `generic-colon` (`file:line:col: message`), which handles
the majority of compiler output; named parsers map to the built-in formats.
Configured sources run alongside the built-in detectors. See
`docs/manual/the-ide/project-configuration.md` for the full field reference.

Runtime commands, verify commands, diagnostics sources, and debug launch presets
use the same project-configuration pattern under `.polypore/`; see
`docs/manual/the-ide/project-configuration.md`.
