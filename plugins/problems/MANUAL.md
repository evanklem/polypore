# problems

Aggregated diagnostics across the project in one list. Errors, warnings, and
hints from language servers and configured diagnostic sources are collected so
you can work through them without hunting file by file.

## working the list

- **Scan everything at once.** Host diagnostics land here, not just diagnostics
  for the file you are currently editing.
- **Jump to source.** Click an entry to open the editor at the exact line.
- **Same source as the editor and Verify.** These are the diagnostics the editor
  and Verify also read, gathered into a triage list.
- **Read the source label.** Each row shows the diagnostic source and code when
  one is available.

## how it fits the agent loop

Problems is the quick triage view. Pair it with [debug](panels/polypore.debug) when you want to queue
items, run deep scans, or hand a fix list to an agent.

## tips

- Sort your attention by severity — clear errors before warnings.
