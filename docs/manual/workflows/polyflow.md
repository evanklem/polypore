---
title: polyflow
group: workflows
order: 2
---

**polyflow** is Polypore's built-in skillset — a TDD-driven, iterative feedback
loop made of cohesive skills that walk an idea from brainstorming through to a
reviewed change. It's how the agent approaches non-trivial work by default,
rather than improvising. Invoke it by asking the agent to "use polyflow" (or by
running a specific polyflow skill); the agent announces each step and stops at
the checkpoints where you keep control.

## the loop

```
brainstorm → plan → execute → tdd → iterate → handoff
```

For unclear or multi-step work, Polyflow starts by brainstorming the approach.
From there the work moves through writing a bite-sized plan, executing it
task-by-task, and driving each behaviour with vertical-slice TDD — one test, one
implementation, repeat. It never auto-commits: every git op is yours.
Durable findings should move into Memory as wiki notes, ADRs, or handoffs
instead of living only in the agent transcript.

## the skills

- **polyflow** — the meta skill; loads the shared vocabulary and points to the
  right skill for the moment.
- **brainstorming** — clarify intent, propose 2–3 approaches, stress-test the
  chosen one with an embedded *grill*.
- **writing-plans** — turn a spec into a file-structure-first, bite-sized plan.
- **executing-plans** — work a plan task-by-task with inline verification, stop
  and ask on blockers.
- **tdd** — vertical-slice TDD; tests verify behaviour through public
  interfaces, not internals.
- **iterate** — re-read the change with fresh eyes (including a visual pass for
  UI), fix what's found, repeat until clean.
- **debug** — root-cause discipline; grill the hypothesis before writing fix
  code.
- **review** — give and receive code review, verifying observed behaviour over
  agreement.
- **design-interface** — design an API twice in parallel, then synthesize.
- **improve-architecture** — surface refactoring friction via the deletion test
  and deep-modules lens.
- **prd / qa / glossary / compact** — scope a big feature, triage bugs into
  issues, extract canonical domain terms, and manage long-session context.

## the vocabulary

polyflow leans on a few shared ideas: **deep modules** (a simple interface over
real depth), the **deletion test** (could this just be removed?), the **vertical
slice** (end-to-end behaviour, not a horizontal layer), the **grill** (an
adversarial pass that stress-tests a choice before committing to it), and
**no-auto-commit** (the user owns every git op).

## why a loop, not a fixed script

Polyflow keeps the workflow deliberate without forcing ceremony. A small bugfix
can go straight to TDD; unclear product work starts with brainstorming; larger
changes get a written plan before implementation. Context is reset at TDD cycle
boundaries to prevent drift, and the user stays in control of every integration
step.
