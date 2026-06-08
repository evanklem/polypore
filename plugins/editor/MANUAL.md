# editor

A Monaco-backed code editor with a file tree and a fuzzy file finder. LSP
diagnostics surface in the editor and feed the same host diagnostics list used
by Problems and Verify.

## working in it

- **Open a file** from the tree on the left, click the file search row, or hit
  **ctrl+p** for the fuzzy finder and type part of a path.
- **Use tabs** to switch between open files, close files, or open another one.
- **Create files** from the file-tree header.
- **Diagnostics** from the language server appear in the editor. The diagnostic
  badge opens a problem menu; choosing an item focuses the relevant range.
  [Problems](panels/polypore.problems) and [debug](panels/polypore.debug) read the same host diagnostics list, so triage stays in
  sync.
- **Custom language ids** from `.polypore/language-servers.json` label files
  whose extensions Monaco does not know by default.
- **Format** runs a matching command from `.polypore/formatters.json` for the
  open file. Multiple matching commands appear in the formatter selector.
- **Saving** writes to the working tree the agent sees — a saved change is
  immediately visible to the next agent action and to Diff & History.

## how it fits the agent loop

The editor is the human's view of the same files the agent edits. When the agent
changes a file, the editor reflects it; when you edit, the agent's next read
sees your change. There's one working tree, two editors of it.

## tips

- Use the diagnostics badge when you want to jump directly to a problem in the
  editor.
- The fuzzy finder matches on path fragments, not just filenames.
- Formatter commands can use `{file}`, `{path}`, `{basename}`, and `{dir}`.
