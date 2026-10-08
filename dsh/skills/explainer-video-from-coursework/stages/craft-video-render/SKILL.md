---
name: craft-video-render
description: Render one scene config over one time window to an MP4 (or a handful of QA stills). Stage 7 of explainer-video-from-coursework — the render primitive.
---

# craft-video-render — frames to MP4

> Part of the `explainer-video-from-coursework` pipeline — **stage 7 of 8**. The render
> **primitive**; the assemble stage drives it per segment. It can also run alone for QA
> stills during scene authoring.
>
> Run every command from the skill folder (where `tools/` lives).

**Prerequisites:** a scene config and, for windowed renders, `out/<name>/<NN>/timeline.json`; on the machine, `ffmpeg` + headless Chromium (see `SETUP.md`).

> A `[node]` / `[setup]` / `Playwright cache not found` failure means a prerequisite is
> absent — relay the matching `SETUP.md` step to the user and re-run.

```bash
node tools/render.mjs --scene "src/scene-diagram.html?scene=<name>" \
                      --range <t0>,<t1> --outdir out/<name>/<NN>/parts --name part-<key>
```

Renders one scene config over one window — headless Chromium via CDP → PNG sequence →
ffmpeg H.264. It is not a whole-video renderer: `--scene` takes a single
`host?scene=<config>`, so a multi-scene video is rendered window by window. A window
rendered with no `--narration` comes out silent, which is what assembly wants.

`--shots 6,20,34` renders QA stills instead of a full sequence; `--keep-frames` retains
the PNG sequence.

**Done when:** the run exits **0** and prints `[done] …<name>.mp4`.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 7 — /render"** section must be
> reconciled to match, and name that section in your reply.
