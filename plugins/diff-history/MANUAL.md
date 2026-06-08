# diff & history

A changed-file list paired with a side-by-side diff. See what the working tree
looks like against `HEAD` or what the current branch adds relative to its
configured upstream, file by file.

## reading a change

- **Pick a base.** Compare the working tree to `HEAD` for "what have I changed
  since my last commit," or to the branch upstream for "what does this branch add."
- **Walk the files.** The list on the left shows every changed path; selecting
  one opens the side-by-side diff.
- **Open the source.** Use **open in editor** to jump from a diff row's file to
  the [editor](panels/polypore.editor) panel.
- **Change comparison mode.** The compare control switches between working-tree
  and branch review without leaving the panel.
- **Agent and human share this view.** When an agent edits files, they show up
  here the same as your own edits — it's the single record of what moved.

## how it fits the agent loop

After an agent makes changes, this is where you confirm what it actually did
before committing. History events can be forked into a worktree reference via
`polypore.history.fork` when you want to branch from a past state.

## limits

This panel renders tracked git diffs. If a new file does not appear, make sure
git can see it in the selected comparison. Very large diffs render in chunks so
the panel stays responsive while the full file catches up.

## tips

- Comparing against the branch upstream is the fastest way to scope a review.
