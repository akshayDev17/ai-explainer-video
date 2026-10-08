# Pipeline — the stage sequence

How a directory of notes becomes a finished video. Eight stages.

**Bold = a stage where the agent supplies judgment.** Everything else is code.

> **The `/plan` … `/assemble` names are stage labels, not executable commands — there
> is still no dispatcher, and `package.json` declares no `bin`.** Every stage is a
> `node tools/<tool>.mjs` invocation, which is what each section shows.
>
> [`SKILL.md`](./SKILL.md) is the **agent-facing contract** — what to do, and each
> stage's `done when` gate. This file is the **flow and its rationale**: what each
> stage consumes and produces, and why it sits where it does. Where the two could
> drift, `SKILL.md` wins.

> **Path note.** The stage commands below still show the older single-work-dir form
> (`out/<name>`) in places; the per-video layout is `out/<name>/<NN>/`. Tracked as
> ROADMAP §2.9.8.

Companion docs: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (who does what, and why no
LLM API is used for reasoning) · [`ROADMAP.md`](./ROADMAP.md) (what's missing).

---

## Prerequisites

| | |
|---|---|
| Node ≥ 22 | `render.mjs` uses the global `WebSocket` for CDP |
| `ffmpeg`, `ffprobe` | encoding, muxing, measurement |
| A Chromium build | headless frame capture |
| A Gemini API key | TTS only — stages 1–3 and 5–8 need no network; stored in the OS secret store, never in env or a file |

| Tool | Role |
|---|---|
| `tools/key-source.mjs` | resolves the key from the OS secret store — macOS Keychain · Linux `secret-tool` · Windows Credential Manager — never env or a plaintext file |
| `tools/tts-gemini.mjs` | Gemini TTS client — **the only file that calls an API** |

The full, cited, per-OS setup for all four prerequisites lives in
[`SETUP.md`](./SETUP.md) — the single source, kept in the skill folder so the skill is
self-contained. The per-stage files point at it too, and the tools print the relevant
command when a prerequisite is missing.

---

## The stages

### 1 · `/plan` — decompose the source

```bash
node tools/planner.mjs <notesDir> --out out/<name> --max-min 14
```

There is **no dedupe flag and no name-based inference**. The planner excludes
exactly one category — navigation headings ("Table of Contents", "Contents",
"TOC", "Index") — because that is unambiguous in any tree. Everything else is
planned.

An earlier version inferred "index pointers" by matching section titles against
directory names. It was deleted: it silently dropped real content on unfamiliar
trees, gating it behind a flag only moved that burden onto the user, and on the
reference tree it changed no video count, no orphan count, and no longest video —
only the series total, by 3.2 min out of 62.5.

Errors (exit 1) on: a path that doesn't exist, a path that isn't a directory, or a
tree with no markdown at all.

| | |
|---|---|
| Tool | `tools/planner.mjs` |
| In | a directory of notes (markdown + code artefacts) |
| Out | `out/<name>/plan.json`, `out/<name>/plan.md` |
| Asserts | **coverage** — every content-bearing heading is assigned to a video, or is a navigation heading. Orphans exit non-zero. |
| Network | none |

Also emits a parser self-check: raw heading lines vs parsed headings, so a
swallowed section can't pass coverage vacuously.

**The duration model is a guardrail, not a prediction.** Both constants are now
**measured, not guessed**, and live in one place (`tools/model.mjs`): `wpm 153`
(Gemini Aoede, 508 words → 199s of audio) and `expansion 1.10` (205.7s picture /
199s narration = 1.03, plus a small buffer). The planner, `script-check`, and
`pacing-check` all import from there, so the stages cannot disagree about the
budget. Use the plan to partition the source and keep each video under the cap;
take real durations from stage 4, which *measures* them.

### 2 · `/enrich` — titles, forms, and curation

```bash
node tools/apply-enrichment.mjs --plan out/<name>/plan.json \
                                --enrichment out/<name>/enrichment.json
```

| | |
|---|---|
| **Agent writes** | `out/<name>/enrichment.json` — one entry per video |
| Tool | `tools/apply-enrichment.mjs` |
| Out | `plan.enriched.json`, `plan.enriched.md` |
| Network | none |

**Title contract.** The planner's titles are placeholders; the agent replaces them
with real ones — descriptive, **unique**, written for a human scrolling YouTube,
not a directory name. The content is given precisely: `plan.json` carries
`sectionSpans` (each section's `src`, `title`, and 1-based `line`/`endLine`), so the
agent titles from the substance it reads at those spans, not from a slug.
`apply-enrichment` enforces the floor: it rejects empty titles, `Part N`
placeholders, ellipses, **directory-slug titles** (`load-balancing`), **duplicates**,
forms outside the enum, and references to non-existent videos.

**Curation.** A deterministic planner cannot tell an overview page from real
content, so it plans both — the agent decides. Each entry may carry `skip: true` or
`mergeInto: <index>`, both requiring a stated `why`. `skip` drops the video and
records its sections; `mergeInto` folds the video's sections and words into the
target. Both land in `plan.removed` with the reason, so nothing is dropped silently
and coverage stays auditable.

### 3 · `/script` — narration

| | |
|---|---|
| **Agent writes** | `out/<name>/scripts/<NN>-<slug>.json` — per segment: `key`, `text`, `style`, `visual`, `covers` |
| Tool | `tools/script-check.mjs` |
| Asserts | unique keys · speakability (no URLs, markdown, code) · duration budget vs the plan · **every source section the plan assigned is actually narrated** |
| Network | none |

`style` is sent to TTS as `speech_metadata` (delivery direction); `text` is sent
**verbatim**.

**Script contract.** The agent composes the spoken narration; `script-check` gates
it. The rules:

- **Register** — a calm, methodical teacher who explains through story: each
  concept opens as a concrete scenario ("a request arrives…", "one server falls
  over…"), then unpacks step by step. No edge, no hot takes; steady and warm;
  analogies are welcome as teaching devices.
- **Granularity** — one segment per visual beat (one idea, one reveal). Roughly
  40–80 words; **≤130 words** hard ("one breath"). Split rather than bloat.
- **Per segment** — `key` (unique, short), `text` (spoken **verbatim**; no URLs,
  markdown, or code), `style` (delivery direction), `visual` (a hint for the scene
  stage), `covers` (the plan sections this segment narrates).
- **`covers`** — copy the exact section identity from `plan.enriched.json`
  (`"src :: title @L<line>"`). Every assigned section must appear in some segment's
  `covers`; `script-check` errors on any uncovered section.
- **Budget** — target `planTargetMinutes` from the plan; stay within its 55%–125%
  band (`script-check` errors below, warns above).

### 4 · `/audio` — TTS and the measured timeline

```bash
node tools/build-audio.mjs --script out/<name>/scripts/NN-*.json --out out/<name> --voice Aoede
```

| | |
|---|---|
| Tool | `tools/build-audio.mjs` → `tools/tts-gemini.mjs` |
| Out | `narration/<seg>.wav`, `narration.wav`, `timeline.json`, `timeline.js` |
| Network | **yes — the only API-spending stage** |
| Notes | durations are **measured** with ffprobe, never estimated. Emits per-segment **windows** that tile the timeline. |

The cache is keyed on the **spoken text only** — `narration/<key>.src` stores the
exact text the `.wav` was built from — so re-running after a wording tweak costs 0
calls. It does **not** cover `--voice`, `style`, or `--model`: change one of those
and the previous audio is silently reused. Pass `--force` when you mean to
re-synthesize.

### 5 · `/scene` — author the visuals

| | |
|---|---|
| **Agent writes** | `scenes/<name>.js` — one config per segment |
| Binding | `scenes/manifest.json` maps segment → `{host, scene}` |
| Tool | `tools/pacing-check.mjs` |
| Asserts | reveal rate 0.45–1.6 lines/sec · scene fits the **measured** narration · **dead air** (no visual change *and* no narration) ≤ 3.5s |
| Network | none |

Timings are written **relative to narration** — `"srp@4.6"` resolves to
`segment_start + 4.6`, so regenerating audio re-locks the choreography.

### 6 · `/publish` — chapters and captions

| | |
|---|---|
| **Agent writes** | `out/<name>/<NN>/publish.json` — `chapters[]` (segment keys + `title`) and a `blurb` |
| Tool | `tools/publish.mjs` |
| Out | `description.md` (blurb + chapter block), `captions.srt` — copied to `--dest` |
| Asserts | first timecode `0:00` · ≥3 chapters · each ≥10s · ascending · every segment key resolves · titles present, ≤40 chars, not duplicated or near-duplicated · cues ascend, don't overlap, one per segment |
| Network | none |

Placed **before** the expensive stages on purpose. Both artifacts are pure functions of
data already frozen when stage 5 exits — the measured windows in `timeline.json`, and
the verbatim narration — so the metadata can be reviewed while a fix is still cheap.
No TTS, no Chromium, so re-running it is free.

Chapter **titles are authored** (read the chapter's narration, then name it); the
**times are resolved** from the windows, so a re-render regenerates correct timecodes
for free. Reusing the scene `stageNames` badges would cost nothing but is wrong: they
are presentation labels — all uppercase, one missing (the title card disables its
badge), near-duplicate pairs — and they resist mechanical title-casing, because a video
contains `IT · TOOLS`, which would become `It · Tools`.

Captions are one cue per segment, text taken from `narration/<key>.src` (the exact text
the WAV was built from — the audio is the truth, not `script.json`), emitted as **SRT
only**. YouTube accepts both SRT and VTT, so one file covers the upload; VTT matters
only for an HTML5 `<track>` in a web embed, and re-running this stage is free, so it is
deferred rather than pre-built. Finer cue splitting is possible only by estimation — the TTS
returns audio with **no word timings** — so it is deliberately not attempted.

**Chapters come from the description, nothing else.** YouTube builds them only from
timestamp lines in the **description**, start-time only. A caption file (SRT/VTT) does
**not** create chapters, and neither does embedded MP4 chapter metadata. The Data API
confirms the asymmetry: captions get a whole resource with an `insert` verb
([`captions`](https://developers.google.com/youtube/v3/docs/captions)), while the
[`videos`](https://developers.google.com/youtube/v3/docs/videos) resource has no
chapters field anywhere — `snippet.description` is a plain string, and
`contentDetails.caption` is only a yes/no flag. Chapters therefore have nowhere to live
except the description text, which is why the block is emitted **inside**
`description.md` rather than as its own file or a caption by-product.

**Chapters also need channel eligibility.** They are a YouTube advanced feature: a channel
that has not qualified for advanced-feature eligibility renders **no** chapters at all,
however valid the list. Its description timestamps still work as jump-to-section links —
what is missing is the segmented progress bar and Google key moments. Nothing in
`description.md` can change this, so absent chapters are not a formatting fault.

### 7 · `/render` — frames to MP4

| | |
|---|---|
| Tool | `tools/render.mjs` |
| Does | headless Chromium via CDP → PNG sequence → ffmpeg |
| Flags | `--scene`, `--shots` (QA stills), `--range t0,t1`, `--outdir`, `--name`, `--narration` · also `--fps`, `--crf`, `--shot-dir`, `--keep-frames` |
| Diagnose | `tools/debug-page.mjs` — prints boot-time console errors; `render.mjs` only reports "never exposed VIDEO_META" |

### 8 · `/assemble` — the finished video

```bash
node tools/assemble.mjs --script out/<name>/scripts/NN-*.json \
                        --work out/<name> --name <output>
```

| | |
|---|---|
| Tool | `tools/assemble.mjs` + `tools/verify-audio.mjs` |
| Does | per-segment time-sliced render (**silent**) → concat → mux narration **once** → verify |
| Asserts | windows tile the timeline with no gaps · finished audio matches the narration at **sample level** (residual energy ≤ 0.25) |
| Network | none |

Parts are rendered silent deliberately. Muxing narration per part restarts the
whole track at every segment boundary — a bug this stage used to have.

---

## Renderers

| File | Role |
|---|---|
| `src/scene-core.js` | diagram renderer — node kinds `client`/`server`/`hub`/`box` (UML), edges, flows, pings, rules, banners, overlays |
| `src/scene-diagram.html` | host; selects the config via `?scene=<name>` |
| `src/scene-code.js` | code + refactor renderer — code panels, before/after |
| `src/scene-code.html` | host; selects the config via `?scene=<name>` |
| `<work>/timeline.js` | **generated** by stage 4 into the per-video work dir; browser-loadable measured timeline |

---

## End-to-end (video 6, as run)

```bash
# 1 + 2 — plan, then enrich
node tools/planner.mjs <lld-notes> --out out/lld --max-min 14
#     → agent writes out/lld/enrichment.json
node tools/apply-enrichment.mjs --plan out/lld/plan.json --enrichment out/lld/enrichment.json

# 3 — script (agent writes scripts/06-solid-principles-violated-and-fixed.json)
node tools/script-check.mjs --script out/lld/scripts/06-*.json --plan out/lld/plan.enriched.json

# 4 — audio
node tools/build-audio.mjs --script out/lld/scripts/06-*.json --out out/video6 --voice Aoede

# 5 — scenes (agent writes 7 configs in scenes/, registered in scenes/manifest.json)
node tools/pacing-check.mjs --scene scenes/<name>.js --timeline out/video6/timeline.json --segment <key>

# 6 — publish (agent writes publish.json: chapters + blurb)
node tools/publish.mjs --work out/video6 --script out/lld/scripts/06-*.json --dest <destination>

# 7 + 8 — render and assemble
node tools/assemble.mjs --script out/lld/scripts/06-*.json --work out/video6 --name video6-solid
```

Result: `out/video6/video6-solid.mp4` — 7 segments, 205.70s of picture against
199.00s of measured narration (the final segment holds past its narration).

---

## The authoring loop (where the real time goes)

Stage 5 is not a single command. The inner loop is:

```
write / edit a scene config
   → node tools/pacing-check.mjs …            (timing, readability, dead air)
   → node tools/render.mjs --shots 6,20,34 …   (a handful of stills)
   → LOOK at the stills                        ← the step nothing automates
   → fix → repeat
```

That loop ran roughly **eight times** for video 6.

**The checkers caught timing and structure. They never once caught a visual fault.**
Every visual bug — missing chips, orphaned connectors, green clients, an absent
fail marker, a box drawn from an empty API field — was found by looking at a
rendered frame.

---

## Bug log

What went wrong, and what actually surfaced it.

| Bug | Surfaced by |
|---|---|
| Diagram renderer read the SDK's convenience field instead of the REST path | dumping the real response |
| Retry logic fought a *daily* quota for 8 minutes | reading the error text |
| A `<script>` fence behind a list marker swallowed 3 headings | parser self-check added afterwards |
| Coverage passing *vacuously* (a subtree over-claim masked real orphans) | fixing the over-claim |
| Reveals 2.5× too fast to read | **the user's eye** |
| 7.3s of dead air at the end | **the user's eye** |
| Audio restarting at every segment boundary | **the user's ear** |
| A patch that silently matched nothing (`+ 30` had become `+ 32`) | the rendered frame still showing no marker |

The last four are the lesson: **cheap checks passed while the real question went
unasked.** Declaring "verified" off a per-stage check is not verification of the
artefact a human consumes.

---

## Current limitations

See [`ROADMAP.md`](./ROADMAP.md) §2. In short: renders run **one at a time** (the
shared Chromium `--port` — per-video work dirs mean the videos themselves are
independent), the Chromium and key locations are per-platform but have only been
verified on macOS (§2.1), and `SKILL.md` has not yet passed the **acceptance test** in §4:
hand a fresh agent the skill with no conversation history and see whether it ships a
video unaided.
