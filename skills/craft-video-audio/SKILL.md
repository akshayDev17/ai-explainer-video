---
name: craft-video-audio
description: Synthesize narration and build the measured timeline for one video. Stage 4 of explainer-video-from-coursework — the one-shot TTS primitive.
---

# craft-video-audio — TTS and the measured timeline

> Part of the `explainer-video-from-coursework` pipeline — **stage 4 of 8**. This is the
> **primitive**: it builds audio once and stops. This skill itself never loops.
>
> The scene stage may re-invoke it, but **padding is not the expected path any more**.
> Beat dwells are measured from the narration (stage 4b), so a shortfall now means the
> scene over-asked — the fix is to widen the beat's line range, not to insert silence.
> Only if a visual genuinely needs more screen time than its words take is a `pad`
> justified; see stage 5's over-ask ladder.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 4
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 4
> ```

**Prerequisites:** `out/<name>/scripts/<NN>-*.json` from the script stage; on the machine, the Gemini key in the OS secret store (see `SETUP.md`).

> A `No API key found` failure means the key isn't in the OS secret store — relay the
> matching `SETUP.md` step to the user and re-run.

```bash
node ../explainer-video-from-coursework/tools/build-audio.mjs --script out/<name>/scripts/<NN>-*.json \
                           --out out/<name>/<NN> --voice Aoede
```

Writes `narration/<seg>.wav`, `narration.wav`, `timeline.json`, and `timeline.js` into
the per-video work dir. This is **the only network stage** — it spends the Gemini TTS
key.

Next: **stage 4b (`/align`)** measures the words *inside* each of those windows —
`node ../explainer-video-from-coursework/tools/align.mjs --script out/<name>/scripts/<NN>-*.json --work out/<name>/<NN>`.
Without it, scene beats have nothing measured to anchor to.

**Done when:** the run exits **0** and prints one window per segment, ending in
`[out] …/timeline.json`.

- **Durations are measured, not estimated** — each WAV is measured with `ffprobe`; the
  plan's `Min` was a guardrail, this is the real number later stages bind to.
- **The cache is text-keyed** — `narration/<key>.src` stores the exact spoken text, so a
  re-run after a wording tweak costs 0 calls. It does **not** cover `--voice`, `style`,
  or `--model`: change one and the old audio is silently reused. Pass `--force` to
  re-synthesize.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 4 — /audio"** section must be
> reconciled to match, and name that section in your reply.
