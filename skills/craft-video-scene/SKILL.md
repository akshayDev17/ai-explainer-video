---
name: craft-video-scene
description: Author and iterate the animated visuals for one video's segments. Stage 5 of explainer-video-from-coursework; beats anchor to measured narration lines, not hand-written seconds.
---

# craft-video-scene — author the visuals

> Part of the `explainer-video-from-coursework` pipeline — **stage 5 of 8**. This is the
> **orchestrator** over the audio stage: it loops, and it re-invokes `build-audio` when a
> beat cannot fit. The audio stage itself is one-shot and never loops back.
>
> **A shortfall is no longer routine.** Beat dwells default to the measured span of
> the lines they cover, so `at + min` is inside the window by construction and a
> line-anchored scene should report none. If `pacing-check` does report one, the scene
> **over-asked**: widen the beat's `lines` range first, redesign the beat second, and
> `pad` the segment only as a last resort.
>
> If you do pad, line times survive it (a pad widens the window, never the segment
> WAV) — but *rewriting the narration* invalidates every line time for that segment, so
> re-run `/audio` → `/align` → `/resolve-beats`. `resolve-beats --script …` enforces
> that by comparing the text hash `align` recorded.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 5
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 5
> ```

**Prerequisites:** `out/<name>/<NN>/timeline.json` (from the audio stage) and the
script for the video; headless Chromium for the `--shots` look (see `SETUP.md`).

> A `Playwright cache not found` failure on the `--shots` render means Chromium is absent —
> relay the `SETUP.md` step to the user and re-run.

Each segment is a **beat**: narration plus the visual that illustrates it. Author the
visual as **visual beats** — steps, each with a minimum dwell and an alignment to the
narration — never as raw seconds.

**Hosts, per segment** (`out/<name>/<NN>/manifest.json`, `key` → `{host, scene}`):

- **`svg`** (`src/scene-svg.html`) — the open lane; expose `renderAt(t, svg, timeline)`
  plus `SCENE_BEATS`.
- **`code`** (`src/scene-code.html`) — code walkthroughs.
- **`diagram`** (`src/scene-diagram.html`) — declarative `nodes`/`edges`/`reveal`/
  `banners` configs built on `scene-core.js`.

**The beat anchors to a line, never to a second** — declare per segment:

```js
window.SCENE_BEATS = { beats: [
  { id: 'march',   line: 1 },                    // index into lines.json for this segment
  { id: 'caption', lines: [3, 4], hold: true },  // holds across those lines
]};
```

`line` indexes that segment's lines in `lines.json` (stage 4b). `lines: [from, to]`
claims a range, and `hold: true` lets a final beat run to the cut.

**Do not write `at`.** A hand-written second cannot be validated and will not be
caught: the module-07 pilot shipped `at: 6.6` for a phrase that begins at 12.6s and
passed every check. `resolve-beats` rejects a beat with `at` but no `line`, and
rejects a baked `at` that disagrees with the measured onset by more than 60 ms.

```bash
node ../explainer-video-from-coursework/tools/resolve-beats.mjs --work out/<name>/<NN>
```

Run this before `pacing-check`: it resolves each `line` to seconds, writes `beats.json`,
and fails when a line does not exist, beats run out of order, or a narration line has
no beat (narration playing with nothing changing on screen).

A beat's dwell should be **how long its lines are spoken**. Only add `min` when the
visual genuinely needs longer than its line — and then reach for a wider `lines` range
before reaching for `pad` (stage 5's over-ask ladder).

### The loop, expressed as tool invocations

```
write / edit a scene
  → node ../explainer-video-from-coursework/tools/pacing-check.mjs --scene out/<name>/<NN>/scenes/<name>.js \
        --timeline out/<name>/<NN>/timeline.json --segment <key>
        (a shortfall means the scene over-asked — widen the beat's `lines` range,
         or redesign the beat. Only then consider a pad.)
  → last resort, if the visual really needs more screen time than its words take:
        set `pad` on the script segment and `hold: true` on the beat, then:
        node ../explainer-video-from-coursework/tools/build-audio.mjs --script out/<name>/scripts/<NN>-*.json \
              --out out/<name>/<NN> --voice Aoede
        (free — TTS is text-cached — and it re-tiles the timeline wider)
        line times stay valid: a pad widens the window, never the segment WAV
  → if you REWROTE the narration instead (extending it):
        re-run build-audio, then align.mjs, then resolve-beats.mjs — a new WAV
        invalidates every line time. resolve-beats --script … catches the omission.
  → node ../explainer-video-from-coursework/tools/render.mjs --shots 6,20,34 --work out/<name>/<NN> \
        --scene "src/scene-diagram.html?scene=<name>"
  → LOOK at the stills      ← the step nothing automates
  → fix → repeat
```

The checkers catch timing and structure, never a visual fault — a missing chip, an
orphaned connector, a wrong colour. Only looking at a rendered frame catches those.

**Done when:** `pacing-check` exits 0 **and** every still has been eyeballed.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 5 — /scene"** section must be
> reconciled to match, and name that section in your reply.
