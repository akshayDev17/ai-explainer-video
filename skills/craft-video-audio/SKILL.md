---
name: craft-video-audio
description: Synthesize narration and build the measured timeline for one video. Stage 4 of explainer-video-from-coursework — the one-shot TTS primitive.
---

# craft-video-audio — TTS and the measured timeline

> Part of the `explainer-video-from-coursework` pipeline — **stage 4 of 8**. This is the
> **primitive**: it builds audio once and stops. The scene stage re-invokes it when a
> beat needs a hold; this skill itself never loops.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **project**, so `out/` scratch lands beside your notes.

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
