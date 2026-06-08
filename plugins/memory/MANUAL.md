# memory

Memory is Polypore's Obsidian-like knowledge base for agent work. It stores
plain markdown documents in local folders, lets you browse and edit those notes
like a small wiki, and lets you choose exactly which documents should be loaded
into a chat session as context.

The panel has three working areas:

- **context** on the left: what the selected chat already carries, what files
  are queued for the next message, and an estimated token/byte count.
- **bases and documents** in the middle: your knowledge bases, folders, and
  markdown files.
- **document editor** on the right: the selected note, with editable markdown,
  preview mode, wikilinks, and backlinks.

## the mental model

Treat Memory like a local markdown vault. A **memory base** is a folder of notes.
A base can be scoped to the current project or marked global so it appears in
every project. Inside a base, folders are just folders and documents are just
text files, so the knowledge is portable and can be reviewed outside Polypore.

This is not chat history. Chat history is what happened in one agent terminal.
Memory is the durable knowledge you want to survive across sessions: project
notes, source material, decisions, handoffs, research, glossaries, and wiki pages
the agent can keep using later.

## creating a base

Click **create base** to make a new knowledge base. You choose:

- **name**: the label shown in the panel.
- **scope**: `project` shows only in this project; `global` is available
  everywhere.
- **folder**: the local folder where the base lives. Polypore suggests a path,
  but you can choose another folder.
- **preset**: the starter layout for the base.
- **folders**: optional top-level partitions shown in hosts that support
  create-time folder seeding. You can always add folders later from the base
  editor.

Click **open folder** when you already have a folder of markdown notes and want
to attach it as a base. If the folder is inside the current project, Polypore
suggests project scope; otherwise it suggests global scope.

If the project already has a `.knowledge/` folder, Polypore shows it as a
project base automatically unless a configured base already covers that folder.

## presets

The default **basic wiki** preset is based on Andrej Karpathy's common setup
for project memory: keep raw source material separate from distilled notes, then
let agents work mostly from the distilled wiki.

- `raw/` is for source material: pasted specs, transcripts, references, or
  imported documents. Treat these as evidence and avoid rewriting them.
- `wiki/` is for the cleaned-up knowledge layer: durable explanations,
  summaries, decisions, and pages the agent should actually reason from.
- `README.md` names the base.
- `CLAUDE.md` seeds the workflow instruction: keep raw material in `raw/`,
  maintain durable notes in `wiki/`, and link claims back to sources.

The **blank base** preset creates a single `index.md` and leaves the structure to
you. Use the base editor when you want to add, rename, or delete top-level
folders after creation.

## browsing and editing

Select a base, then pick a document from the tree. The right pane opens the
document as editable markdown. Changes autosave shortly after you stop typing,
and the panel shows the save state near the document path.

Use **new document** to create a markdown file. You can type a nested path like
`notes/decision.md`; Polypore creates missing folders as needed. If you omit
`.md`, Polypore adds it.

Use **preview** to render the current note. Preview supports headings,
paragraphs, lists, quotes, code blocks, and `[[wikilinks]]`.

## wikilinks and backlinks

Write `[[Some Page]]` or `[[folder/page.md]]` in a note to create an
Obsidian-style wikilink. In preview mode, clicking that link opens a matching
document in the current base if one exists.

When the selected document is linked from other notes, the right pane shows a
**backlinks** section. Backlinks are found by scanning the other documents in the
selected base for either `[[filename]]` or `[[path/to/file.md]]`.

## loading context into a chat

The left column is scoped to the selected chat. If more than one chat is open,
use **context for** to choose which one receives new files.

To load a document:

1. Select or drag a document from the tree.
2. Drop it onto the context column.
3. The file appears as queued context.
4. On the next message in that chat, the terminal inserts the file as an
   `@path` mention and removes it from the queue.

Queued context is deliberate: the agent does not receive the file merely because
you clicked it. It receives the file when you send the next prompt to that chat.

The context column also estimates context size. Token counts are approximate,
but they are useful for keeping the next prompt focused.

## context states

Context rows are modeled with these states:

- **queued** means the file will be sent with the next message.
- **loaded** is available for integrations that report files the chat has
  already read.
- **compacted** is available for integrations that report a document has been
  summarized or folded into a smaller context form.

Queued files can be canceled from the context list before you send the next
message.

## managing bases and folders

Use the gear button on a base to edit it. You can rename the base, change its
scope, add folders, rename folders, or delete folders.

Be careful with delete actions. In the desktop shell, deleting a base removes
the underlying folder and all files under it. Deleting a folder removes that
folder and every document inside it.

## agent tools

Agents can read and write memory through the `polypore.memory.*` MCP tools:

- `polypore.memory.list` lists knowledge documents.
- `polypore.memory.read` reads a knowledge document.
- `polypore.memory.write` writes a document.
- `polypore.memory.link` appends a markdown link between documents.
- `polypore.memory.handoff` writes a handoff note for future sessions.

Use Memory for facts you expect the agent to reuse. Use chat for the active
conversation.

## tips

- Keep raw evidence and distilled notes separate. Put source material in `raw/`
  and conclusions in `wiki/`.
- Link claims back to sources so future agents can check where a summary came
  from.
- Load a focused set of documents instead of dumping an entire base into chat.
- Promote repeated explanations, decisions, and recovery notes into Memory
  rather than re-explaining them in every session.
