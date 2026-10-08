---
name: craft-video-plan
description: Decompose a coursework notes directory into an explainer-video plan and prove no content-bearing section is dropped. Stage 1 of explainer-video-from-coursework; run it alone to (re)plan a directory.
---

# craft-video-plan — decompose and prove coverage

> Part of the `explainer-video-from-coursework` pipeline — **stage 1 of 8**, the first of
> the two once-per-series stages. This skill is self-contained: it plans a directory
> from scratch. For a full run, use the main skill instead.
>
> Run every command from the skill folder (where `tools/` lives).

**Prerequisites:** a directory of markdown notes (`<notesDir>`).

```bash
node tools/planner.mjs <notesDir> --out out/<name> --max-min 14
```

Writes `out/<name>/plan.json` and `out/<name>/plan.md`. No network, no key, safe to
re-run. Read `plan.md`, not `plan.json`.

**Done when:** the run exits **0** and `plan.md`'s coverage line reads
`N assigned · M excluded as navigation · 0 orphaned`. A non-zero exit, or any orphan,
means the plan is incomplete — stop and fix it. Never enrich an incomplete plan.

Two facts that shape how the plan is read:

- **The coverage proof is the point.** The planner proves every content-bearing section
  is assigned to a video or is a navigation heading. `plan.json` also carries
  `sectionSpans` (each section's `src`, `title`, and 1-based `line`/`endLine`) — the raw
  material for the next stage.
- **The `Min` column is a guardrail, not a duration** — a planning estimate
  (`wpm 153 × expansion 1.10`), not measured audio. Use it to judge boundaries.

Only `.md` files are parsed; non-markdown content is invisible to the planner.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 1 — /plan"** section must be
> reconciled to match, and name that section in your reply.
