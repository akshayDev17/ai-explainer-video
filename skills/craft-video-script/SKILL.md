---
name: craft-video-script
description: Write and validate the spoken narration for one explainer-video. Stage 3 of explainer-video-from-coursework; run it alone to (re)write a video's script.
---

# craft-video-script — write the narration

> Part of the `explainer-video-from-coursework` pipeline — **stage 3 of 8**, the first
> per-video stage. Self-contained: it needs an enriched plan, not a full run.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **project**, so `out/` scratch lands beside your notes.

**Prerequisites:** `out/<name>/plan.enriched.json` from the enrich stage.

The agent writes `out/<name>/scripts/<NN>-<slug>.json`, then validates:

```bash
node ../explainer-video-from-coursework/tools/script-check.mjs --script out/<name>/scripts/<NN>-*.json \
                            --plan out/<name>/plan.enriched.json
```

**Done when:** the run exits **0** (`✓ script is valid`). An `UNCOVERED source
section` error — or any other error — means the script is incomplete.

**Script contract.**

- **Register** — a calm, methodical teacher who explains through story; each concept
  opens as a concrete scenario, then unpacks step by step. No edge, no hot takes;
  analogies welcome.
- **Granularity** — one segment per visual beat. Roughly 40–80 words; ≤130 words hard.
- **Per segment** — `key` (unique, short), `text` (spoken **verbatim**; no URLs,
  markdown, or code), `style` (delivery direction), `visual` (a hint for the scene
  stage), `covers` (the plan sections this segment narrates), and optional `pad` (hold
  silence in seconds).
- **`covers`** — copy the exact section identity from `plan.enriched.json`
  (`"src :: title @L<line>"`). Every assigned section must appear in some segment's
  `covers`.
- **Budget** — target `planTargetMinutes`; stay within its 55%–125% band.

`videoIndex`, `title`, `form`, `planTargetMinutes`, `sources`, `artefacts` are copied
from the enriched plan's video; only `text`, `style`, `visual`, `covers` are authored.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 3 — /script"** section must be
> reconciled to match, and name that section in your reply.
