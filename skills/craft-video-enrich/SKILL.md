---
name: craft-video-enrich
description: Retitle and curate the videos in an explainer-video plan — write enrichment.json and merge it. Stage 2 of explainer-video-from-coursework; run it alone to retitle an existing plan.
---

# craft-video-enrich — retitle and curate

> Part of the `explainer-video-from-coursework` pipeline — **stage 2 of 8**, the second
> once-per-series stage. Self-contained: it operates on an existing `plan.json`. For a
> full run, use the main skill instead.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

**Prerequisites:** `out/<name>/plan.json` from the plan stage.

The agent writes `out/<name>/enrichment.json` — one entry per video — then validates
and merges:

```bash
node ../explainer-video-from-coursework/tools/apply-enrichment.mjs --plan out/<name>/plan.json \
                                --enrichment out/<name>/enrichment.json
```

Writes `plan.enriched.json` and `plan.enriched.md`.

**Done when:** the run exits **0** (no validation problems), `plan.enriched.md` shows
the final video list, **and that full list has been shown to the user** — every
surviving video plus the removals with their reasons. Never summarise it into a sample:
`apply-enrichment` prints the whole table, and the whole table is what gets reviewed.

**Title contract.** The planner's titles are placeholders. Replace each with a real
title: descriptive, **unique**, written for a human scrolling YouTube — never a
directory slug. Title from the content, not the name: read the source at the video's
`sectionSpans` before naming it. The tool rejects empty titles, `Part N` placeholders,
ellipses, slugs, and duplicates.

**Curation.** The planner cannot tell an overview page from real content, so it plans
both — the agent decides. An entry may carry `skip: true` or `mergeInto: <index>`, both
requiring a `why`. Every skip/merge lands in `plan.removed` with its reason and
sections, so coverage stays auditable.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 2 — /enrich"** section must be
> reconciled to match, and name that section in your reply.
