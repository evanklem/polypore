---
name: polyflow
description: Meta skill for the PolyFlow system. Loads the shared vocabulary (deep modules, deletion test, vertical slice, grill, mockup quick-mode, no-auto-commit) and describes when to invoke each polyflow-* skill. Use when starting a new task and unsure which polyflow skill applies, or when you need to ground reasoning in the shared vocabulary.
---

# PolyFlow

A TDD-driven iterative feedback loop for software development inside Polypore. 15 cohesive skills walk an idea from brainstorm → plan → execute → tdd → iterate, with checkpoints throughout. Polypore-native: the loop uses the host's editor, verify, preview, memory, and review surfaces without turning every task into a team-design exercise. Vertical-slice TDD, context resets at TDD cycle boundaries, and no-auto-commit are the defaults — the user controls every git op.

## Single Entry Point: `polyflow-go`

When the user says "let's polyflow this", "use polyflow", "polyflow this idea", "run this through polyflow", or anything similar — invoke `polyflow-go`. It's the orchestrator that walks the entire loop end-to-end (brainstorm → plan → execute → tdd → iterate → STOP), announces each step, respects checkpoints (design approval, plan approval), and hands off to the right sub-skill at each phase. The user gets the full PolyFlow workflow without having to remember which sub-skill applies when.

`polyflow-go` is conductor, not autopilot — every checkpoint is real and the user can interrupt or switch paths anytime.

## Shared Vocabulary

Every `polyflow-*` skill speaks this. Cross-reference here, don't redefine.

- **Module** — any unit with interface + implementation (function, class, package). Scale-agnostic.
- **Interface** — complete caller knowledge: type signature, invariants, ordering constraints, error modes, performance characteristics.
- **Depth** — large behavior behind a small interface = deep (good). Large interface, thin behavior = shallow (avoid).
- **Seam** — where an interface lives; a place behavior can shift without editing in place.
- **Adapter** — concrete implementation satisfying an interface at a seam.
- **Deletion test** — does removing this module concentrate complexity across N callers, or does complexity vanish? The first is a real module; the second is bloat.
- **Vertical slice** — one test → one impl → repeat. Never write all tests first then all code (horizontal slicing produces tests of imagined behavior).
- **Behavior through public interface** — tests describe *what*, not *how*. They survive refactors. If a rename breaks a test but behavior didn't change, the test was wrong.
- **Grill** — opt-in interview pattern, embedded as a labeled section inside planning skills. Stress-test before committing to a path. Not a separate skill invocation in PolyFlow.
- **Ubiquitous language** — canonical domain terms in `CONTEXT.md`. New terms added as discovered.
- **Mockup quick-mode** — when user just wants visual concepts, skip spec/plan ceremony. Produce mockups directly in whatever form the project uses (HTML files, Figma frames, ASCII layouts, etc.) — no full design loop required.

## Hard Rules (apply to every polyflow skill)

- **Never auto-commit, never auto-stage, never auto-finish.** Every git write op (`commit`, `push`, `merge`, `rebase`, `tag`, `branch -d/-D`) requires the user to explicitly ask for it in the current turn. Even `git add` should not happen on the agent's initiative — leave files unstaged until the user signals they're about to commit.
- **No "finish/integrate" workflow on the agent's initiative.** After implementation + iterate, the agent reports what was done and **stops**. The user decides whether to commit, merge, open a PR, keep iterating, or change direction.
- **Never invent values you don't authoritatively have.** This includes: file paths, env var values, API keys, secret values, IDs (UUIDs, foreign keys, third-party object IDs), URLs, port numbers, hostnames, version numbers, third-party service names, function names you haven't verified exist. **If unsure, STOP and ask** — don't guess. Action-hallucination (an agent confidently doing the wrong thing) is the most dangerous failure mode in agentic coding (industry research, 2026). The cost of asking is one round-trip; the cost of acting on a hallucinated value is potentially catastrophic.
- **Watch for context drift.** If you find yourself re-asking established questions, contradicting earlier decisions, or losing track of constraints set earlier in the session, invoke `polyflow-compact` to preserve anchors and propose a `/clear`. ~65% of agent failures trace to context drift, not raw token exhaustion.
- **No skill tax.** Ad-hoc questions don't require a skill invocation. Skills are tools, not a tollbooth.
- **No forced spec/plan paths.** Specs and plans live wherever the user wants. Default to `docs/` only if no preference is stated.
- **No forced sub-skill chains.** Each polyflow skill stands alone. Hand-offs are suggestions, not mandates.
- **Verify before claiming done.** Run the project's quality checks (typecheck, lint, test) and confirm output before reporting completion.
- **Never read raw secrets.** Do NOT `cat .env`, `printenv`, or `Read` files like `.env*`. Polypore scrubs known secret keys from your environment and replaces them with `POLYPORE_SECRET_HANDLE_<KEY>=<handle>` sentinels. When you need a secret, call `polypore.secrets.use` with the handle — polypore injects the value into the outbound request without exposing it to you. The breadcrumb env var `POLYPORE_AGENT_SCRUBBED=1` confirms you're running under polypore. If it's set, treat every secret-shaped file as off-limits and only access secrets through the mediated tool.

## The Default Loop

```
1. (optional)  polyflow-brainstorming   — clarify intent, propose 2-3 approaches, embedded grill.
                                          Mockup-only requests use mockup quick-mode.
                                          (Hands off to polyflow-prd for substantial features.)
2. (if non-trivial) polyflow-writing-plans — file structure, bite-sized tasks, embedded grill.
3. EXECUTE     polyflow-executing-plans  — task harness: critical review, TaskCreate, inline
                                          verification, blockers, quality checks.

   ↳ INSIDE every code-writing task in EXECUTE:
       polyflow-tdd                      — vertical-slice RED → GREEN → REFACTOR per cycle.
                                          NOT a separate phase. The discipline that runs
                                          inside the task harness for any production code.

4.             polyflow-iterate          — self-review loop AFTER all tasks are done:
                                          re-read diff, fix issues, re-run checks,
                                          (UI) view the page. Repeat until clean.
5.             STOP. Report what was done. Await user direction.
```

**The loop is interlinked end-to-end.** Each step actively offers the right next-step skill when conditions match, while keeping execution sequential unless the user explicitly asks for another shape.

**Cross-cutting:** `polyflow-compact` runs alongside the loop whenever context drift symptoms appear or at clean phase boundaries. Don't wait for token-limit warnings — proactive compaction at boundaries is far higher quality than reactive mid-flow compaction.

**There is no auto-commit, no auto-finish, no auto-integration step.** The user controls when to commit, when to merge, when to push, when to open a PR. After step 5, the agent reports and waits.

Ad-hoc questions, quick mockups, exploratory reads: **no skill invoked**. Just answer.

## When to Invoke Each Skill

| Trigger | Skill |
|---|---|
| **"Let's polyflow this" / "use polyflow" / "polyflow this idea" / any "run this through polyflow"** | **`polyflow-go`** (entry point — walks the whole loop) |
| "Help me think through X" / "I want to build Y" / new feature scoping (without saying "polyflow") | `polyflow-brainstorming` (or invoke `polyflow-go` if user wants the full loop) |
| "Plan out Z" / spec exists, ready to break into tasks | `polyflow-writing-plans` |
| "Execute the plan" / picking up an existing plan doc | `polyflow-executing-plans` |
| Any production code change | `polyflow-tdd` |
| "Polish this" / "review this" / "make sure it's clean" / after implementation | `polyflow-iterate` |
| Long session, drift symptoms, major phase boundary, or session feels heavy | `polyflow-compact` |
| "Commit this" / "push" / "merge" / "open a PR" — **user-initiated only** | (no skill — just do it directly when explicitly asked) |
| "Write a PRD for X" / new feature in PRD shape | `polyflow-prd` |
| "Refactor X" / "this file is too big" / architecture concerns | `polyflow-improve-architecture` |
| "Design the API for X" / interface design | `polyflow-design-interface` |
| "Update CONTEXT.md" / new domain term emerged | `polyflow-glossary` |
| "Debug Y" / unexpected behavior, root-cause needed | `polyflow-debug` |
| Code review (giving or receiving) | `polyflow-review` |
| "File a bug for X" / QA session | `polyflow-qa` |
| Token-heavy session, want compression | `caveman` (upstream, kept as-is) |

## Compatible Tooling

PolyFlow is self-contained — none of these are required. But some standalone utilities from other Claude Code skill sets compose well alongside if you happen to have them installed:

- A **verification-before-completion** rule (already baked into `polyflow-executing-plans` and `polyflow-iterate`)
- A **token-compression** mode for very long sessions (complements `polyflow-compact`)

For the historical record of which existing-ecosystem skills inspired which PolyFlow skills, and which were deliberately not adopted, see `docs/skills-audit.md`.
