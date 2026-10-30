---
name: craft-video-script
description: Write and validate the spoken narration for one explainer-video. Stage 3 of explainer-video-from-coursework; run it alone to (re)write a video's script.
---

# craft-video-script — write the narration

> Part of the `explainer-video-from-coursework` pipeline — **stage 3 of 8**, the first
> per-video stage. Self-contained: it needs an enriched plan, not a full run.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 3
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 3
> ```

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

<!-- sync:stage3-addendum -->
**Code-flow videos only.** A code-flow video's plan, `plan.json` or `plan.enriched.json`, carries
`"kind": "codebase"`, and its `forms` are `overview`, `flow` and `core`. A coursework plan has no `kind`; nothing
in this block applies to its videos.

A code video's narration is the reading time: a panel shows only the lines being narrated, each highlighted while
its sentence plays. The script for a code video adds these rules:

- **Open** on the concrete request, UI action or command that starts the flow.
- **One hop per segment.** Name identifiers in words; spoken text holds no code, no URLs and no markdown.
- **Narrate every line a panel will show**: the hop's narrated lines (`sectionSpans[].lines` in the plan, or the
  lines you choose when that is `null`, at most 22), plus a cited test's def, call and assertion lines.
- **Branches.** Teach each `teach` branch in its own segment, naming its selector: the setting, flag or profile
  that picks it.
- **Tests.** Describe a cited test by what it asserts. Call a hop "tested" or "pinned" only for a direct, unmocked
  link, never for a `"strength": "reachable"` citation. For a traced run say "observed in the test suite", never
  "in production".
- **Evals.** An eval hop that drives a production flow names that flow's video instead of re-narrating it.
- **Pause prompts** are rare and bounded, only for a block that must be read whole.
  - The segment's text says "pause" out loud.
  - It carries `"pause": {"dwell": <s>}`, with 0 < dwell ≤ 2 and `pad` equal to the dwell.
  - A video has at most 3. `script-check` errors on a fourth, so split the video instead.
- **Secrets.** Never say a secret or a redacted value.
<!-- /sync:stage3-addendum -->

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 3 — /script"** section must be
> reconciled to match, and name that section in your reply.
