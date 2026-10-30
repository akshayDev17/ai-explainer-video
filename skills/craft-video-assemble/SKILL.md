---
name: craft-video-assemble
description: Assemble one video from its segments — render each window silent, concatenate, mux the narration once, and verify. Stage 8 of explainer-video-from-coursework.
---

# craft-video-assemble — the finished video

> Part of the `explainer-video-from-coursework` pipeline — **stage 8 of 8**. The
> **orchestrator** over the render stage.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 8
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 8
> ```

**Prerequisites:** the script, `out/<name>/<NN>/timeline.json`, `manifest.json`, and
`narration.wav`; on the machine, `ffmpeg` + headless Chromium (see `SETUP.md`).

> A `[setup]` / `Playwright cache not found` failure means ffmpeg or Chromium is absent —
> relay the matching `SETUP.md` step to the user and re-run.

```bash
node ../explainer-video-from-coursework/tools/assemble.mjs --script out/<name>/scripts/<NN>-*.json \
                        --work out/<name>/<NN> --name <output> \
                        --dest <destination> [--port 9333]
```

`--port` (default 9333) is forwarded to every per-segment `render.mjs`, so **two videos can
assemble concurrently** when each is given its own port — one port per concurrent agent.
The run aborts before segment one if the port is already listening, because a shared CDP
port does not fail cleanly: the second assembly attaches to the first browser's page and
encodes the *other* video's scene under its own filename, exit 0. Verified — byte-identical
frames from the wrong video. This is what lets a per-video agent own stage 8 end to end.

Per segment: render its own window through its own host + config, **silent** — parts
are silent on purpose, because muxing narration onto each would restart the whole track
at every boundary. Then concatenate (`-c copy`), mux the single measured narration
track **once**, and verify. `--only <key>` renders a single segment, for a smoke test.

Asserts: every segment has a timeline window **and** a `manifest.json` entry · the
windows tile the timeline with no gaps · the finished audio matches the narration at
**sample level**.

**Done when:** the run exits **0** and prints `[done] …<output>.mp4` with `audio ok`.
The MP4 is copied into the video's own folder, `--dest/<NN>-<slug>/`, alongside the
`description.md` and `captions.srt` that publish wrote.

<!-- sync:codeflow-publish-render -->
**Code-flow videos only.** A code-flow video's plan, `plan.json` or `plan.enriched.json`, carries
`"kind": "codebase"`, and its `forms` are `overview`, `flow` and `core`. A coursework plan has no `kind`; nothing
in this block applies to its videos. A code-flow video adds these rules at stages 6–8:

- **Render.** A code segment renders through `src/scene-code.html?scene=<key>`. Pass `--work out/<name>/<NN>` so
  the host reads that video's `timeline.js`; `assemble` passes it for every segment.
- **Chapters.** Write each chapter title from that chapter's narration, as for any video.
- **Upload title.** The `youtubeTitle` names the flow in the viewer's terms, such as what a request does or what
  a command runs. Never use a module path.
<!-- /sync:codeflow-publish-render -->

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 8 — /assemble"** section must be
> reconciled to match, and name that section in your reply.
