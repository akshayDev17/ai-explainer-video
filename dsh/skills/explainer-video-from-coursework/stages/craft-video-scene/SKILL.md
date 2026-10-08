---
name: craft-video-scene
description: Author and iterate the animated visuals for one video's segments. Stage 5 of explainer-video-from-coursework; it re-invokes the audio stage when a beat needs a hold.
---

# craft-video-scene — author the visuals

> Part of the `explainer-video-from-coursework` pipeline — **stage 5 of 8**. This is the
> **orchestrator** over the audio stage: it loops, and it re-invokes `build-audio` when a
> beat cannot fit. The audio stage itself is one-shot and never loops back.
>
> Run every command from the skill folder (where `tools/` lives).

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

**The beat owns the timing** — declare `SCENE_BEATS` per segment:
`{ id, at, min, hold }`. `at` is seconds from the narration start, `min` is the minimum
dwell, and `hold: true` marks a beat allowed to run past the narration.

### The loop, expressed as tool invocations

```
write / edit a scene
  → node tools/pacing-check.mjs --scene out/<name>/<NN>/scenes/<name>.js \
        --timeline out/<name>/<NN>/timeline.json --segment <key>
        (a shortfall = "beat X needs +3s" → add `pad` to the script segment,
         set `hold: true` on the beat)
  → if you added a pad:
        node tools/build-audio.mjs --script out/<name>/scripts/<NN>-*.json \
              --out out/<name>/<NN> --voice Aoede
        (free — TTS is text-cached — and it re-tiles the timeline wider)
  → node tools/render.mjs --shots 6,20,34 --work out/<name>/<NN> \
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
