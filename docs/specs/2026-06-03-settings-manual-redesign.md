# Settings & Manual — full redesign

> Date: 2026-06-03 · Status: design locked, implementing
> Supersedes the in-flight redesign recorded in memory `project-settings-manual-redesign`.

## 0. Why

The previous pass made Settings and Manual *real* (live plumbing, authored corpus) but
the **layout** is poor. Grounded in headless screenshots of the current surfaces:

- **Manual** is genuinely good — clean reader, solid typography, sane IA. It needs
  *unification + reading aids*, not a teardown.
- **Settings is the problem.** Three concrete failures:
  1. **Overview duplicates the left rail.** The entire right pane on first open is the
     same six destinations the rail already lists, each with an "open" button. Zero
     added information.
  2. **Project is a wall of empty forms.** Opening Project drops you into *seven stacked
     always-open add-forms* (runtime label / command / url / add runtime; server id /
     args / extensions …). It is data-entry-first, not state-first. A "jumpbar" of chips
     is a band-aid for the resulting length. You cannot see *what is configured* — only
     blank inputs.
  3. **Everything is the same glowing box.** Every section is `1px solid var(--line)`
     (accent-26) on a slightly-darker fill. The surface is a uniform field of identical
     bordered cards — no hierarchy, no rhythm. This is the exact "doubled accent seam"
     failure the UI-unification work fixed elsewhere, reproduced *inside* Settings.

## 1. Principles (the redesign rests on these)

1. **State-first, not form-first.** A settings screen's primary job is to show *current
   configuration* legibly. Editing/adding is a deliberate, secondary action — revealed on
   demand, never a wall of blank inputs.
2. **Hierarchy from space, not boxes.** Sections are separated by generous spacing and at
   most a quiet hairline (`--line-quiet`). The accent border/fill is reserved for
   *interactive* affordances (inputs, buttons) and *active/selected* state. No more
   "every block is an accent-bordered card." (Direct application of the UI-unification
   lesson to these surfaces.)
3. **One shell, two surfaces.** Settings and Manual share a single `SurfaceShell` (portal,
   top bar, two-column body, Escape, the warm-dark-glass takeover). Kills duplicated chrome
   CSS and guarantees they feel like one product.
4. **One type scale.** A small, explicit scale for the surfaces (page title / section /
   body / label / value). Stop the "10px uppercase muted everywhere" noise — eyebrows only.
5. **Respect the product voice.** Lowercase nav + labels (matches the app's panel labels
   `editor`/`agent`/`terminal`). Manual document titles stay as authored (prose).
6. **Preserve every real contract.** All `.polypore/*.json` write shapes, the secrets
   policy, the agent-delegated plugin install, the manual corpus/MCP parity — unchanged.
   Only layout + interaction change.

## 2. Shared shell

`src/surfaces/SurfaceShell.tsx` — props `{ label, title, subtitle?, trailing?, nav, children, onClose }`.
Renders: `createPortal` → fixed full-screen takeover → top bar (`title` + `subtitle` +
`trailing` slot + `esc` close) → body grid `[nav | content]`. Owns the Escape handler.
Both surfaces consume it. `surface.css` holds the shared chrome, nav, type scale, and the
new state-first primitives. `settings-surface.css` / `manual-surface.css` become thin
section-specific layers.

## 3. Settings IA & wireframes

Rail keeps the 7 top-level sections (tests + muscle-memory depend on the labels), grouped:
`workspace` (overview, panels, project) · `system` (extensions, agents, credentials) ·
`look` (appearance). Search box at top filters the rail (`find settings`).

### 3.1 Overview → status dashboard (not a nav clone)

```
 overview                                          workspace · at a glance
 ──────────────────────────────────────────────────────────────────────────
 ┌── needs attention ───────────────────────────────────────────────────┐
 │  ⚠ claude CLI not found        npm i -g @anthropic-ai/claude-code  [fix]│   ← only if issues
 │  ⚠ GITHUB_TOKEN not configured                              [add key →] │
 └────────────────────────────────────────────────────────────────────────┘

   ┌ panels ───────┐  ┌ agents ───────┐  ┌ credentials ──┐  ┌ theme ────────┐
   │  4 / 6        │  │  1 ready       │  │  2 configured │  │  ● honey      │
   │  enabled      │  │  1 missing     │  │  1 missing    │  │  cozy         │
   │      open →   │  │      open →    │  │      open →   │  │     open →    │
   └───────────────┘  └───────────────┘  └───────────────┘  └───────────────┘

   project configuration · .polypore                                  open →
   runtimes 2 · servers 1 · verify 3 · diagnostics 0 · formatters 1 · debug 0
```

The "needs attention" strip is the genuine value: it surfaces a missing agent CLI or an
unconfigured-but-referenced credential, each with an inline fix. Stat cards show *real
numbers* and double as navigation. Agent status is fetched (`project_agent_status`).

### 3.2 Project → state-first groups, add-on-demand

Single scrolling column (no nested rail). A quiet **sticky sub-nav** lets you jump between
the 7 domains. Each domain is a *group*, not a form:

```
 project configuration                    runtimes · servers · verify · …  (sticky sub-nav)
 ──────────────────────────────────────────────────────────────────────────
 runtime commands                                       .polypore/runtime.json   [+ add]
   ▸ roc app            roc run app.roc                                      [remove]
   ▸ web dev            npm run dev                                          [remove]
   ── (when [+ add] toggled, ONE inline form appears here) ──
   [ label ] [ command name ] [ kind ▾ ]
   [ command…………………… ] [ url ]                                    [cancel] [save]

 language servers                              .polypore/language-servers.json   [+ add]
   no language servers yet                                            [+ add the first]
```

- **Has entries** → rows render; the add-form is hidden behind `[+ add]`.
- **Empty** → a one-line empty state + a prominent "add the first …" button.
- Removing an entry is now possible (rewrites the file without it) — the old UI was
  add-only, a real gap.
- Deep-link from a panel ("open runtime commands") still scrolls to + highlights the
  target group (`settings-fieldset--focus`, `[data-settings-group]`) — preserved.

Pure data logic (types, normalizers, read/write, splitters, compactors, the per-domain
metadata) moves to `src/settings/tabs/project/projectConfig.ts`. The 1143-line monolith
becomes: `projectConfig.ts` (data) + a `ProjectTab.tsx` shell + small per-domain editors.
**Write shapes are byte-for-byte preserved** by reusing the existing normalizers/writers.

### 3.3 Other sections

- **panels** — keep master/detail, but the inner panel list becomes a quiet column (no
  competing accent borders) and the detail is the focus. "settings · <panel>" header kept.
- **extensions / agents / credentials** — state-first lists (your installed plugins / agent
  CLIs / saved handles as readable rows); add/install is secondary. Advanced disclosure,
  source-review-to-agent, and copy-install-hint behaviors preserved exactly.
- **appearance** — already decent; just re-home onto the shared primitives (swatches, hex,
  segmented controls).

## 4. Manual redesign (refine, don't rebuild)

Same `SurfaceShell`. Reader changes:
- **Breadcrumb eyebrow** (`group › title`) + cleaner header; the "ask the agent about this"
  action moves into the shell's `trailing` slot / header row (no floating mid-header button).
- **prev / next pager** at the foot of each page, walking the corpus in canonical order.
- Refined **facts strip** (panel id / version / permissions / capabilities) and prose spacing.
- Search, nav tree, markdown-link hardening, duplicate-heading strip — all preserved.

## 5. Self-grill (recursive — asked and answered until dry)

**Q1. Splitting Project risks the most-tested file. Worth it?**
Yes. The write *contracts* are the real asset and are preserved verbatim (reused
normalizers). Only the *interaction* changes (reveal form before typing), which is a small,
honest test update. The UX win (see your config; no blank-form wall) is the whole point of
the task.

**Q2. Add-on-demand forms — does that break the "writes all 7 files" test?**
It changes it: the test must click `[+ add <domain>]` before the fields exist. I rewrite
the test to drive the new flow and assert the *same* JSON. Contract intact, interaction
updated. Acceptable for a redesign.

**Q3. Is the Overview dashboard over-engineering vs. just dropping Overview?**
Dropping it means opening Settings lands on a config section cold. A *status* dashboard
(missing agent, unconfigured key, theme, counts) answers "is anything wrong / what's my
setup" in one glance and is not a nav clone. Kept, but lean. The async agent probe is the
only added complexity — bounded, already used by AgentsTab.

**Q4. Does removing accent borders kill the warm-glass identity?**
No. Identity lives in the surface gradient + blur + accent on *active* elements, not in
bordering every box. Removing redundant borders is exactly what UI-unification did
app-wide; this aligns Settings with canon rather than diverging.

**Q5. Sticky sub-nav in Project vs. a second rail vs. accordion?**
Second rail = rail-in-content (heavy, nested). Accordion = lots of expand/collapse for
short lists. Sticky sub-nav over a short state-first column is the lightest: domains are
compact now (empty ones are one line), so the page is scannable and the sub-nav is a jump
aid, not a crutch. Chosen.

**Q6. Reversibility — if a layout choice is wrong, what's the cost?**
Low. It's CSS + component structure behind a stable surface API (`SurfaceShell`,
`GlobalSettingsServices`, the corpus). No data migration, no RPC change. Revert = restore
files. The git working tree already isolates this (untracked `src/settings`, `src/manual`).

**Q7. Out of scope (explicitly NOT in this pass)?**
Native human-driven from-source plugin installer (still agent-delegated — backend feature,
unchanged). New `.polypore` config *kinds*. Changing the secrets policy or MCP manual
contract. The dockview/panel chrome. The launcher.

**Q8. Voice — lowercase vs. title case, settings vs. manual mismatch?**
Keep lowercase for nav/labels/section headings (app voice). Manual *document* titles stay
as authored prose. Page H1s in settings stay lowercase to match the app. The unification is
*chrome* (shared shell, scale), not recasing.

**Q9. Will the shell refactor break the existing tests' selectors?**
Tests query by `role=dialog`/`navigation`/`region`, aria-labels (`settings`, `manual`,
`find settings`, `settings sections`, `manual contents`), and visible text. The shell
preserves all of these. Manual tests are behavioral (render slug, nav, facts, dedup, ask,
search) and survive. Verified against both test files before starting.

**Q10. Down to the wireframe: where does the add-form live, exactly?**
Inside the group, *between* the header row and the entries list, collapsed by default,
toggled by the header's `[+ add]`. Save commits + collapses + clears; cancel collapses +
clears. Empty groups render the empty-state line with the add button in place of rows.
(Wireframe in §3.2.)

**Q11. Anything left to ask?** No open design questions remain — proceeding to build.

## 6. File plan

New:
- `src/surfaces/SurfaceShell.tsx` + `src/surfaces/surface.css`
- `src/settings/tabs/project/projectConfig.ts` (pure data, extracted + tested)

Rewritten:
- `SettingsSurface.tsx` (consume shell), `ManualSurface.tsx` (consume shell + pager)
- `settings-surface.css`, `manual-surface.css` (state-first visual language)
- `ProjectTab.tsx` (state-first groups), `OverviewTab.tsx` (dashboard)
- light restyle markup in Panels/Plugins/Agents/Credentials/Interface tabs

Tests:
- rewrite the Project writes test for add-on-demand (same JSON asserts)
- update Overview test for the dashboard
- add `projectConfig.test.ts` for the extracted pure logic
- add a `SurfaceShell` test (portal, esc, title)
- keep all Manual + AdvancedDisclosure + corpus tests green

## 7. Verification

`npm run typecheck` clean · headless chromium screenshots of every settings section + the
manual via `scripts/shoot.mjs` → visual iterate · full vitest is run by the user.
