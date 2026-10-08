---
name: explainer-video-from-coursework
description: Plan an explainer-video series from a directory of coursework notes — decompose into videos (proving nothing is dropped), retitle and curate, write the narration, synthesize the audio, author the visuals, then render and assemble the finished cut. Use when the user wants to turn structured coursework notes into explainer videos.
---

# explainer-video-from-coursework — plan, enrich, script, audio, scene, publish, render, assemble

Turn a notes directory into a **video series**. Stage 0 gathers the source and the
destination; stages 1–2 run once over the whole directory and plan the series (the
planner decomposes and proves completeness; you retitle and curate); stages 3–8 then
run **once per video** — write the narration, TTS turns it into measured audio, you
author the visuals, generate the publishing metadata, then render and assemble that
video's finished cut.

The skill's own files (`tools/`, `src/`, `stages/`, `scenes/`) live in **this skill's folder**;
the tools self-locate them, so `node tools/<tool>.mjs …` runs regardless of cwd. But the
work and scratch paths (`out/`, `--work`, `--out`, `<notesDir>`) resolve against the
**current directory** — run every command from the **project** (where `out/` scratch and
the source notes live), never from the skill's install folder.

> **For maintainers — the dual-file rule.** This skill is deliberately **monolithic**:
> the whole pipeline lives here, so a full run loads in one pass. Every stage *also* has
> its own contract file — `stages/craft-video-<stage>/SKILL.md`, one per stage — a
> **complete contract** for that stage: its prerequisites, its command, what the agent
> writes, its hard checks and its `done when` gate. These stage files are **internal** to
> this plugin, not shipped as separate top-level skills. Treat **this file as the contract
> of record**: every stage file ends with a **Maintenance** note requiring its stage's
> section here to be reconciled whenever it changes. **If you add a stage, or change an
> existing one, update *both*** — the stage's section here *and* its stage file — or they
> will silently diverge.
> Cross-stage behaviour such as the `/scene ↔ /audio` loop lives in a tool, never in
> either file, so it stays in one place. See `ROADMAP.md` for the design record.

## Prerequisites

One-time machine setup before the first run — Node ≥ 22, `ffmpeg`/`ffprobe`, the headless
Chromium, and the Gemini API key. The commands and per-OS store steps live in
[`SETUP.md`](./SETUP.md) in this folder.

**Relay rule.** The tools fail loud on a missing prerequisite — `[node] …`, `[setup] …`,
`Playwright cache not found …`, or `No API key found …`. When one appears, do not debug the
scene: tell the user what is missing and the install steps from the matching `SETUP.md`
section, then re-run.

### Series scope — the per-video loop

- **Stages 1–2 run once.** They produce the plan for the whole directory; nothing
  below this point iterates the video list.
- **Stages 3–8 repeat once per video you ship.** Give each video its own work
  directory — `out/<name>/<NN>/` — which holds its own `timeline.js`,
  `manifest.json`, `scenes/`, `narration/`, `parts/`, `publish.json` and the
  finished MP4. *(Some stage commands below still show the older single-directory
  form `out/<name>`; `out/<name>/<NN>/` is the correct layout — tracked as ROADMAP
  §2.9.8.)*
- **Videos are independent.** Nothing is shared between them, so two videos can
  coexist and either can be re-rendered or re-assembled on its own (ROADMAP §1,
  *Work-dir layout*). The only shared resource is Chromium's `--port`, so run one
  render/assemble at a time.
- **One video end-to-end is a valid stopping point** (a pilot, or a single-target
  run). The series is the full deliverable, but each video is produced
  independently.

## Stage 0 — `/inputs`: source and destination

Ask for the two things the user must decide; everything else is the skill's. If the
invocation already names them, skip. Ask **together, one prompt, with a default** for
the destination so the user only adjusts, never invents:

- **Source** — the notes directory. If they referenced a path (`@…`), use it;
  otherwise list candidate directories that contain `.md` files and let them pick.
- **Destination** — where the finished video(s) land. Default: `videos/` beside the
  source. Scratch goes to a gitignored `out/<name>/` the user never opens; only the
  finished `.mp4` is copied out (assemble's `--dest`).

Proceed to Stage 1 only once both are set. After Stage 1, show the plan's own
numbers as a free confirmation — *"`<source>` → N markdown files → M videos, landing
in `<destination>`"* — before Stage 2 and the `Choose the scope` gate spend anything.

## Stage 1 — `/plan`: decompose and prove completeness

```bash
node tools/planner.mjs <notesDir> --out out/<name> --max-min 14
```

Writes `out/<name>/plan.json` and `out/<name>/plan.md`. No network, no key, safe
to re-run. Read `plan.md`, not `plan.json`.

**Done when:** the run exits **0** and `plan.md`'s coverage line reads
`N assigned · M excluded as navigation · 0 orphaned`. A non-zero exit, or any
orphan, means the plan is incomplete — stop and fix it. Never enrich an
incomplete plan.

Two facts that shape how you read the output:

- **The coverage proof is the point.** The planner's job is not to write titles —
  it proves every content-bearing section is assigned to a video or is a
  navigation heading. `plan.json` also carries `sectionSpans` (each section's
  `src`, `title`, and 1-based `line`/`endLine`); those spans are your raw material
  for stage 2.
- **The `Min` column is a guardrail, not a duration.** It is a planning estimate
  (`wpm 153 × expansion 1.10`, in `tools/model.mjs`), not measured audio. Use it
  to judge boundaries, not real length.

Only `.md` files are parsed; non-markdown content is invisible to the planner.

## Stage 2 — `/enrich`: retitle and curate

Write `out/<name>/enrichment.json` — one entry per video — then validate and merge:

```bash
node tools/apply-enrichment.mjs --plan out/<name>/plan.json \
                                --enrichment out/<name>/enrichment.json
```

Writes `plan.enriched.json` and `plan.enriched.md`.

**Done when:** the run exits **0** (no validation problems) and `plan.enriched.md`
shows the final video list. A problem list means your enrichment is wrong — fix
and re-run.

### The title contract

The planner's titles are placeholders. Replace each with a real title:
descriptive, **unique**, written for a human scrolling YouTube — never a directory
slug (`load-balancing`). Title from the content, not the name: read the source at
the video's `sectionSpans` before naming it. The tool rejects empty titles, `Part
N` placeholders, ellipses, slugs, and duplicates — a slug or duplicate you leave
in is a hard failure, not a nit.

### Curation — skip and merge

The planner cannot tell an overview page from real content, so it plans both. You
decide. An entry may carry:

- `skip: true` — drop the video; its sections are recorded, not silently lost.
- `mergeInto: <index>` — fold the video's sections and words into another video.

Both require a `why`. Every skip/merge lands in `plan.removed` with its reason and
sections, so coverage stays auditable.

## Choose the scope — after `/enrich`, before `/script`

The enriched plan is the decision point. **Ask the user which videos to run through
stages 3–8 — never assume "all of them".** Present the final list (index + title) and
ask for:

- **all** videos, or
- a **subset by index** — `30`, or `5, 7, 9`, or `1-3, 30`.

Then run stages 3–8 only for the chosen set, one video at a time, each into its own
`out/<name>/<NN>/` (see *Series scope*). TTS and rendering are the expensive stages,
so never spend them on a video the user has not explicitly chosen.

## Stage 3 — `/script`: write the narration

One video at a time, write `out/<name>/scripts/<NN>-<slug>.json`, then validate:

```bash
node tools/script-check.mjs --script out/<name>/scripts/<NN>-*.json \
                            --plan out/<name>/plan.enriched.json
```

**Done when:** the run exits **0** (`✓ script is valid`). An `UNCOVERED source
section` error — or any other error — means the script is incomplete; fix and
re-run.

### The script contract

- **Register** — a calm, methodical teacher who explains through story: each
  concept opens as a concrete scenario ("a request arrives…", "one server falls
  over…"), then unpacks step by step. No edge, no hot takes; steady and warm;
  analogies are welcome as teaching devices.
- **Granularity** — one segment per visual beat (one idea, one reveal). Roughly
  40–80 words; **≤130 words** hard ("one breath"). Split rather than bloat.
- **Per segment** — `key` (unique, short), `text` (spoken **verbatim**; no URLs,
  markdown, or code), `style` (delivery direction), `visual` (a hint for the scene
  stage), `covers` (the plan sections this segment narrates), and optionally `pad`
  (hold silence in seconds — see Stage 5).
- **`covers`** — copy the exact section identity from `plan.enriched.json`
  (`"src :: title @L<line>"`). Every assigned section must appear in some segment's
  `covers`; `script-check` errors on any uncovered section.
- **Budget** — target `planTargetMinutes` from the plan; stay within its 55%–125%
  band (`script-check` errors below, warns above).

## Stage 4 — `/audio`: TTS and the measured timeline

```bash
node tools/build-audio.mjs --script out/<name>/scripts/<NN>-*.json --out out/<name> --voice Aoede
```

Writes `narration/<seg>.wav`, `narration.wav`, `timeline.json`, and `timeline.js`
(browser-loadable) — all into the work dir.
This is **the only network stage** — it spends the Gemini TTS key. The key is read from
the OS secret store — macOS Keychain · Linux `secret-tool` · Windows Credential Manager — never env or
a plaintext file. If it is missing, `build-audio` prints the exact one-time store command
for the platform; tell the user to run it.

**Done when:** the run exits **0** and prints one window per segment tiling the
timeline, ending in `[out] …/timeline.json`.

Two facts:

- **Durations are measured, not estimated.** Each WAV is measured with `ffprobe`;
  the plan's `Min` was a guardrail, this is the real number the later stages bind to.
- **The cache is text-keyed.** `narration/<key>.src` stores the exact spoken text,
  so a re-run after a wording tweak costs 0 calls — but the key does **not** cover
  `--voice`, `style`, or `--model`: change one of those and the old audio is silently
  reused. Pass `--force` to re-synthesize.

## Stage 5 — `/scene`: author the visuals

Each segment is a **beat**: narration plus the visual that illustrates it. Author the
visual as a list of **visual beats** — steps, each with a minimum dwell and an
alignment to the narration — never as raw seconds.

### Three hosts — pick per segment (`out/<name>/<NN>/manifest.json`, `key` → `{host, scene}`)

- **`diagram`** (`src/scene-diagram.html`) — the declarative lane, and the default for
  most segments. Write a config of `nodes` / `edges` / `reveal` / `hide` / `draw` /
  `flows` / `banners`; `SceneCore.createScene` renders it. `src/scene-core.js` holds
  the node kinds (`client` / `server` / `hub` / `box`), the `flow` idiom, and the
  overlay vocabulary (`title`, `cards`, `chips`, `finalLine`).
- **`code`** (`src/scene-code.html`) — a segment that walks code. Constrained and
  declarative; mechanical.
- **`svg`** (`src/scene-svg.html`) — the open lane, for whatever the declarative lane
  can't express. Write your own SVG with one contract: expose
  `renderAt(t, svg, timeline)` (a pure function of time) on `window.SCENE_CONFIG`.
  `scene-core.js` also exports standalone primitives for this lane, each a pure
  `(t, params) → SVG`: `chart` (pie / bar), `hubSpoke`, `loopFlow`, `timeline`,
  `equation` (a small TeX subset — runs, `^{}` / `_{}`, `\frac`, `\sqrt`, Greek and
  relation macros). Compose them where a beat matches one; drop to raw SVG where it
  doesn't. **Primitives are a floor, not a ceiling.**

### The beat owns the timing

Declare the scene's beats alongside its config:

```js
window.SCENE_BEATS = [
  { id: 'title',  at: 0,    min: 4 },              // needs ≥ 4s to be read
  { id: 'pool',   at: 12.5, min: 5 },
  { id: 'legend', at: 18,   min: 8, hold: true },  // may outlive the narration
];
```

`at` is seconds from the segment's narration start, `min` is the beat's minimum
dwell, and `hold: true` marks a beat allowed to run past the narration. The visual's
own beat sequence is now explicit, parallel to the narration's measured beats; each
aligned beat resolves to `max(narration_beat, visual_beat_min)`.

- If the visual needs **more** than the narration, hold the frame — a **declared
  hold**, not dead air. Cover it instead (pad the audio gap, or extend the
  narration) if you prefer; re-run `/audio` when you do.
- **Dead air** is *undeclared* silence with nothing changing — that is still a bug.

`pacing-check` resolves the beats against the measured narration and reports
shortfalls (`beat "legend" needs 8.0s, has 5.0s (+3.0s)`). A shortfall is a prompt to
hold / pad / extend, **not** a failure — only a beat that cannot fit inside its
segment at all is an error. A scene without `SCENE_BEATS` falls back to the older
budget and dead-air checks.

**Resolving a shortfall:** set `pad` on the script segment (the hold silence in
seconds) and `hold: true` on the overflowing beat, then re-run `/audio` — the TTS is
text-cached, so this is free and just re-tiles the timeline with the wider window.

### Design rules

- **Reveal dwell is content-weighted** — a reveal stays up long enough to read its
  words, not a fixed beat.
- **Note windows come from reading time, not leftover space.**
- **Connectors retire with their source node** — fade a connector before its source
  hides, or it dangles.

### Validate timing

```bash
node tools/pacing-check.mjs --scene out/<name>/scenes/<name>.js \
                            --timeline out/<name>/timeline.json --segment <key>
```

Asserts: the scene fits the **measured** narration · every silent stretch is either a
declared hold or an error.

### The authoring loop, and the visual check

```
write/edit a scene
  → pacing-check            (timing, shortfalls, dead air)
  → render --shots 6,20,34 --work out/<name> --scene "src/scene-diagram.html?scene=<name>"
  → LOOK at the stills      ← the step nothing automates
  → fix → repeat
```

The checkers catch timing and structure, never a visual fault — a missing chip, an
orphaned connector, a wrong colour, an absent fail marker. Only looking at a
rendered frame catches those.

**Vision gate:** `read_image` the first still. If it errors, you are on a text-only
model — ask the user whether to switch to a vision model and re-run, or to skip the
visual check. Either answer is fine; never "look" blind.

**Done when:** `pacing-check` exits 0 **and** every still has been eyeballed — or the
user skipped the visual check.

## Stage 6 — `/publish`: chapters and captions

```bash
node tools/publish.mjs --work out/<name>/<NN> \
                       --script out/<name>/scripts/<NN>-*.json \
                       --dest <destination>
```

Both artifacts are **derived** from data already final when stage 5 exits: the
measured windows in `timeline.json`, and the verbatim narration. It costs no TTS and
no Chromium, so it is free to re-run. It sits here — before the expensive render — so
the metadata can be reviewed while a fix is still cheap.

### Chapters — you author them, the tool resolves the times

You write `out/<name>/<NN>/publish.json`:

```json
{
  "chapters": [
    { "segments": ["framing"], "title": "What Is a Harness?" },
    { "segments": ["demo"],    "title": "The Demo That Worked" }
  ],
  "blurb": "Two or three sentences on what the video covers."
}
```

A chapter is a **list of segment keys** plus a short title. One per segment by
default; grouping is just two keys in one list. A chapter's timestamp is the
**first** segment's window start, so grouping needs no new timing logic.

**Write each title from that chapter's narration** (`narration/<key>.src`) — read it,
then name it. Do **not** reuse the scene `stageNames` badges: they are *presentation*
labels and carry defects as chapter titles — all uppercase (`THE MAP`), one missing
entirely (the title card sets `stageBadge: false`), and near-duplicate pairs 14s apart
(`SIX FAMILIES` / `THE SIX FAMILIES`). They also resist mechanical title-casing: one
video contains `IT · TOOLS`, which would become `It · Tools`.

### Captions — verbatim, from the audio

One cue per segment, text taken from `narration/<key>.src` — the exact text the WAV
was built from. Prefer it over `script.json`: if anyone edits the script without
re-running audio, `.src` is the one that matches what a viewer hears.

Emitted as `.srt`. YouTube accepts both SRT and VTT, and SRT is the more widely
accepted of the two, so one file covers the upload; VTT earns its place only for an
HTML5 `<track>` in a web embed. Deferred rather than pre-built — re-running this stage
is free, so it can be added when a web target actually exists. (If it ever is: the
millisecond separator differs, SRT `,` vs VTT `.`, and a mismatch parses silently as
nothing.)

Segment-level cues are exact but coarse: 13–28s and 32–67 words each. That is
readable — it implies the speaking rate, ~153 wpm — but it renders as a multi-line
block. Splitting finer needs word timings the TTS does not return (it sends audio
only), so it would have to be estimated. Deliberately not done here.

### What the tool asserts

YouTube **silently ignores** a chapter list that breaks its rules, so they are hard
checks: the first timestamp is `0:00` · at least three chapters · every chapter ≥10s ·
timecodes ascend · every referenced segment key exists · titles present, ≤40 chars,
and neither duplicated nor near-duplicated. Cues must ascend, not overlap, and number
one per segment.

The **blurb is the one thing not checked** — its shape is validated, its prose is not.

### Chapters need channel eligibility, not just a valid list

Chapters are one of YouTube's
[advanced features](https://support.google.com/youtube/answer/9884579): a channel that has
not qualified for advanced-feature eligibility renders **no** chapters at all, however
valid the list. Its description timestamps still work as jump-to-section links — what is
missing is the segmented progress bar and Google key moments.

Nothing in `description.md` affects this, so absent chapters are **not** a formatting
fault and rewriting a passing list will not help. `0:00` (one digit), a `-` after the
timecode, a blurb above the block and a 2:39 runtime were each verified live on eligible
channels, and the hard checks above already mirror YouTube's rules.

Outputs, copied to `--dest` beside the MP4 because they are deliverables rather than
scratch — just two files:

- **`description.md`** — the blurb, then the chapter block, **paste-ready as plain
  text**. YouTube reads chapters only from the description, so the block lives here and
  nowhere else: there is deliberately no separate chapters file. Keep it free of
  markdown syntax (`#`, `**`, backticks) — the description field does not render
  markdown, so those characters would paste in literally.
- **`captions.srt`** — the cue list, uploaded as a caption track.

**Done when:** `publish` exits 0 and those two files land beside the MP4.

## Stage 7 — `/render`: frames to MP4

```bash
node tools/render.mjs --scene "src/scene-diagram.html?scene=<name>" \
                      --range <t0>,<t1> --outdir out/<name>/parts --name part-<key>
```

Renders **one scene config over one window** — headless Chromium via CDP → PNG
sequence → ffmpeg H.264. It is not a whole-video renderer: `--scene` takes a single
`host?scene=<config>`, so a multi-scene video is rendered window by window, which
stage 8 drives. A window rendered with no `--narration` comes out silent, which is
what assembly wants.

If the run fails with `Playwright cache not found`, the headless Chromium is not
installed — point the user at `SETUP.md` (*Headless Chromium*) rather than touching the
scene.

**Done when:** the run exits **0** and prints `[done] …<name>.mp4`.

### The review loop, and the visual check

```
render a window
  → --keep-frames          (keep the PNG sequence)
  → LOOK at the frames     ← the step nothing automates
  → fix out/<name>/scenes/<name>.js → re-render
```

Stage 5 judged a handful of sampled stills. This looks at every frame of the window,
so it catches what falls *between* those samples — a chip that flickers, a connector
that dangles mid-transition, a beat that pops.

**Vision gate:** `read_image` the first frame. If it errors, you are on a text-only
model — ask the user whether to switch to a vision model and re-run, or to skip the
visual check. Either answer is fine; never "look" blind.

**Done when:** the render exits 0 **and** the window's frames have been eyeballed —
or the user skipped the visual check.

## Stage 8 — `/assemble`: the finished video

```bash
node tools/assemble.mjs --script out/<name>/scripts/<NN>-*.json \
                        --work out/<name> --name <output>
```

Per segment: render its own window through its own host + config, **silent** — parts
are silent on purpose, because muxing narration onto each one would restart the whole
track at every boundary. Then concatenate (`-c copy`), mux the single measured
narration track **once**, and verify. `--only <key>` renders a single segment, for a
smoke test before the full pass.

Asserts: every segment has a timeline window **and** a `manifest.json` entry ·
the windows tile the timeline with no gaps · the finished audio matches the narration
at **sample level**.

**Done when:** the run exits **0** and prints the final `[done] …<output>.mp4` with
`audio ok`. A pre-flight failure means an upstream artifact is wrong — a missing
window (stage 4) or a missing manifest entry (stage 5) — not the assembly.

### The review loop, and the visual check

```
assemble
  → sample the finished MP4    (ffmpeg -i <output>.mp4 -vf fps=1 frames/%04d.png)
  → LOOK at the frames         ← the step nothing automates
  → fix out/<name>/scenes/<name>.js → re-assemble
```

This is the first artifact that exists as a whole video, so it is the first place a
fault can show that no per-window check can see: a bad seam between two windows, a
mux that drifts, a beat that breaks only at the join.

**Vision gate:** `read_image` the first frame. If it errors, you are on a text-only
model — ask the user whether to switch to a vision model and re-run, or to skip the
visual check. Either answer is fine; never "look" blind.

**Done when:** the run exits 0 with `audio ok` **and** the assembled frames have been
eyeballed — or the user skipped the visual check.

## Reference — enrichment.json

```json
{
  "seriesNote": "optional one-line framing for the whole series",
  "videos": [
    { "index": 1, "title": "The 5 Databases That Matter in a System Design Interview", "form": "concept", "why": "prose comparison of access patterns" },
    { "index": 33, "skip": true, "why": "phase index — content lives in #34/#35" },
    { "index": 33, "mergeInto": 35, "why": "fold the 'why this phase' prose into #35" }
  ]
}
```

`form` ∈ `concept`, `diagram`, `code`, `refactor`, `catalogue`. `skip` and
`mergeInto` are mutually exclusive; `mergeInto` must target a live video (no
chains). A missing `why` on either is a validation error.

## Reference — script.json

```json
{
  "videoIndex": 30,
  "title": "L4 vs L7 Load Balancing and the Algorithms Behind It",
  "form": "concept",
  "planTargetMinutes": 7.9,
  "sources": ["scalability-building-blocks/load-balancing/README.md"],
  "artefacts": ["scalability-building-blocks/load-balancing/code/l4-vs-l7/main.go"],
  "segments": [
    {
      "key": "hook",
      "text": "Every scale-out system hits the same moment eventually…",
      "style": "calm and inviting",
      "visual": "title card, then a single server that fills up",
      "covers": ["scalability-building-blocks/load-balancing/README.md :: 1. Why Load Balance @L9"]
    }
  ]
}
```

`videoIndex`, `title`, `form`, `planTargetMinutes`, `sources`, `artefacts` are
copied from the enriched plan's video; only `text`, `style`, `visual`, `covers` are
authored — plus optional `pad` (hold silence) and `hold` is set on beats, not
segments. `covers` must match `plan.enriched.json`'s `sections` strings
exactly (the `@L<line>` form).

## Reference — publish.json

Written per video at `out/<name>/<NN>/publish.json`, then resolved and checked by
`publish` (stage 6).

```json
{
  "chapters": [
    { "segments": ["framing"], "title": "What Is a Harness?" },
    { "segments": ["demo"],    "title": "The Demo That Worked" },
    { "segments": ["smell"],   "title": "The Question No Demo Prepares For" }
  ],
  "blurb": "Module one of a harness-engineering course: what a harness is, the six failure families, and how value and risk sit in different layers of three real products."
}
```

`segments` holds one or more segment `key`s from the script, in playlist order; the
chapter's timestamp is the **first** one's window start. Grouping is expressed by
listing several keys — there is no separate group field. `title` is short (≤40 chars)
and must not duplicate or near-duplicate another chapter's. `blurb` is prose and is
the only field with no mechanical check.
