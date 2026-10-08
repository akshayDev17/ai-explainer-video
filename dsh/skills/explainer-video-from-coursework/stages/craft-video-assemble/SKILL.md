---
name: craft-video-assemble
description: Assemble one video from its segments — render each window silent, concatenate, mux the narration once, and verify. Stage 8 of explainer-video-from-coursework.
---

# craft-video-assemble — the finished video

> Part of the `explainer-video-from-coursework` pipeline — **stage 8 of 8**. The
> **orchestrator** over the render stage.
>
> Run every command from the **project** (where `out/` scratch lives), not the skill install folder — the tools self-locate `tools/` and `src/`.

**Prerequisites:** the script, `out/<name>/<NN>/timeline.json`, `manifest.json`, and
`narration.wav`; on the machine, `ffmpeg` + headless Chromium (see `SETUP.md`).

> A `[setup]` / `Playwright cache not found` failure means ffmpeg or Chromium is absent —
> relay the matching `SETUP.md` step to the user and re-run.

```bash
node tools/assemble.mjs --script out/<name>/scripts/<NN>-*.json \
                        --work out/<name>/<NN> --name <output> \
                        --dest <destination>
```

Per segment: render its own window through its own host + config, **silent** — parts
are silent on purpose, because muxing narration onto each would restart the whole track
at every boundary. Then concatenate (`-c copy`), mux the single measured narration
track **once**, and verify. `--only <key>` renders a single segment, for a smoke test.

Asserts: every segment has a timeline window **and** a `manifest.json` entry · the
windows tile the timeline with no gaps · the finished audio matches the narration at
**sample level**.

**Done when:** the run exits **0** and prints `[done] …<output>.mp4` with `audio ok`.
The MP4 is copied to `--dest`.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 8 — /assemble"** section must be
> reconciled to match, and name that section in your reply.
