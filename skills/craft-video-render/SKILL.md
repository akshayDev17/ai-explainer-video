---
name: craft-video-render
description: Render one scene config over one time window to an MP4 (or a handful of QA stills). Stage 7 of explainer-video-from-coursework — the render primitive.
---

# craft-video-render — frames to MP4

> Part of the `explainer-video-from-coursework` pipeline — **stage 7 of 8**. The render
> **primitive**; the assemble stage drives it per segment. It can also run alone for QA
> stills during scene authoring.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 7
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 7
> ```

**Prerequisites:** a scene config and, for windowed renders, `out/<name>/<NN>/timeline.json`; on the machine, `ffmpeg` + headless Chromium (see `SETUP.md`).

> A `[node]` / `[setup]` / `Playwright cache not found` failure means a prerequisite is
> absent — relay the matching `SETUP.md` step to the user and re-run.

```bash
node ../explainer-video-from-coursework/tools/render.mjs --scene "src/scene-diagram.html?scene=<name>" \
                      --range <t0>,<t1> --outdir out/<name>/<NN>/parts --name part-<key>
```

Renders one scene config over one window — headless Chromium via CDP → PNG sequence →
ffmpeg H.264. It is not a whole-video renderer: `--scene` takes a single
`host?scene=<config>`, so a multi-scene video is rendered window by window. A window
rendered with no `--narration` comes out silent, which is what assembly wants.

**Each distinct frame is captured once** (no flag; it is the only capture path). Because
`renderAt(t)` is pure, consecutive frames are often byte-identical — 82–99% measured — and
a screenshot costs ~63 ms, so the loop hashes the serialized `#stage` SVG after each
`renderAt(t)` and hardlinks the previous PNG when the markup is unchanged. Guards: scenes
declaring CSS/web animations take the plain capture path from frame 0, and every 30 frames
a real screenshot is diffed against the frame written (on disagreement it re-captures,
rewinds since the last audit, and falls back to plain capture). Verified at SSIM 1.000000
against every-frame renders on two full videos, 3.3×–4.3× faster. Read the closing
`[dedup]` line — screenshots vs total, reuse %, audit mismatches.

`--shots 6,20,34` renders QA stills instead of a full sequence (stills bypass the dedup
loop — each is a different instant); `--keep-frames` retains the PNG sequence.

**Done when:** the run exits **0** and prints `[done] …<name>.mp4`.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 7 — /render"** section must be
> reconciled to match, and name that section in your reply.
