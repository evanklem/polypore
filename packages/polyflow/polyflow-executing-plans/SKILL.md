---
name: polyflow-executing-plans
description: Execute a written implementation plan task-by-task with inline verification. Stop and ask on blockers. No forced sub-skill chains. Use when a plan exists and you're ready to implement.
---

# PolyFlow: Executing Plans



## Vocabulary

See `polyflow` meta-skill. Key terms: **vertical slice**, **behavior through public interface**.

## When to Use

- A plan file exists (`docs/plans/...` or wherever the user put it)
- Ready to start implementation

## The Flow

### 1. Load and Critically Review

- Read the plan in full
- Identify ambiguities, gaps, or assumptions you'd make differently
- If anything is unclear or wrong, raise it with the user **before** starting
- Set up TaskCreate items mirroring the plan's tasks

### 2. Execute Task-by-Task

For each task:

1. Mark the task `in_progress`
2. Follow the plan's bite-sized steps exactly
3. For code steps, default to TDD via `polyflow-tdd` (skip only when plan flags an exception)
4. Run the inline verifications the plan specifies
5. Run the project-wide quality checks before claiming done. The exact commands are project-specific — find them in CLAUDE.md or the project's README. Typically:
   - typecheck (e.g., `tsc --noEmit`, `pnpm typecheck`, `cargo check`, `go vet ./...`)
   - lint (e.g., `eslint .`, `pnpm lint`, `cargo clippy`, `ruff check .`)
   - test for affected workspaces (e.g., `pnpm test`, `pytest`, `cargo test`, `go test ./...`)
6. Mark the task `completed`

### 3. Handle Blockers

**Stop immediately when:**

- Missing dependency or environment problem
- Plan instruction is ambiguous or contradicts the code
- Verification fails repeatedly
- Discover the plan's assumption was wrong

**Don't force through.** Surface the blocker and ask. If the plan needs revision, return to `polyflow-writing-plans`.

### 4. Iterate, Then Stop

After all tasks pass quality checks, hand off to `polyflow-iterate` for the self-review loop. Iterate finds issues a single pass missed (dead code, naming, scope creep, missing tests). For UI changes, iterate also views the rendered page.

When iterate converges: **report what was done and STOP**. Do NOT stage files (`git add`), do NOT commit, do NOT push, do NOT propose integration. The user decides every step from here.

A good "done" report includes: what files changed (one line each), what behaviors were added/changed, what verifications passed. Then await user direction.

## Hard Rules

- **Never auto-commit, never auto-stage, never auto-finish.** Period. After all tasks pass and iterate converges, **report and stop**. The user decides what comes next.
- **No forced sub-skill chain.** Extra execution tooling is an explicit user choice, not a requirement.
- **Verify before claiming done.** Run the project's quality checks and confirm output before marking a task complete or reporting success.
- **Match scope.** Don't add features or refactor beyond what the plan calls for.

## Hand-offs

- All tasks complete → `polyflow-iterate` (self-review loop) → **report and STOP**
- Plan needs revision → back to `polyflow-writing-plans`
