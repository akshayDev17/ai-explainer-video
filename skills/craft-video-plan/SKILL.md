---
name: craft-video-plan
description: Decompose a coursework notes directory into an explainer-video plan and prove no content-bearing section is dropped. Stage 1 of explainer-video-from-coursework; run it alone to (re)plan a directory.
---

# craft-video-plan — decompose and prove coverage

> Part of the `explainer-video-from-coursework` pipeline — **stage 1 of 8**, the first of
> the two once-per-series stages. This skill is self-contained: it plans a directory
> from scratch. For a full run, use the main skill instead.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, defaulting beside your notes — so `out/` scratch lands where Stage 0 said it would and inside a repo's ignore rules.

**Prerequisites:** a directory of markdown notes (`<notesDir>`).

```bash
node ../explainer-video-from-coursework/tools/planner.mjs <notesDir> --out out/<name> --max-min 25 \
  [--exclude <notesDir>/videos]
```

Writes `out/<name>/plan.json` and `out/<name>/plan.md`. No network, no key, safe to
re-run. Read `plan.md`, not `plan.json`.

> **Exclude a destination that lives inside the source.** `<notesDir>/videos/` is the
> usual destination, and the planner walks all of `<notesDir>`: a published
> `description.md` comes back in as a note and turns into a phantom video. Pass
> `--exclude` for it (repeatable, one per old output folder). The planner warns when
> it finds `description.md` inputs, because that filename is this pipeline's own
> output — but the flag is the fix.

> **`--max-min` is part of the plan.** Video indices are keyed by the split, so
> re-running with a different cap reshuffles them and invalidates any enrichment
> already written. The planner refuses (exit 4) to overwrite an enriched plan whose
> model differs; pass `--force` only when you intend to re-enrich from scratch.

**Done when:** the run exits **0**, `plan.md`'s coverage line reads
`N assigned · M excluded as navigation · 0 orphaned`, **and every planned video has
been shown to the user** (index, title, length — all of them, no sample and no
"…and N more"). A non-zero exit, or any orphan, means the plan is incomplete — stop and
fix it. Never enrich an incomplete plan.

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
