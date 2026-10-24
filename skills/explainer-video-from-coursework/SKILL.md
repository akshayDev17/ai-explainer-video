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

The skill's own files (`tools/`, `src/`, `scenes/`) live in **this skill's folder** — resolve
`tools/<tool>.mjs` against it; the tools then self-locate everything else, so they run
regardless of cwd. The eight `craft-video-<stage>` skills sit beside this one under `skills/`.
But the work and scratch paths (`out/`, `--work`, `--out`, `<notesDir>`) resolve against the
**current directory**, so run every command from the **scratch root** — the directory that
holds `out/`. Stage 0 fixes it once, defaulting beside the source. Never run from the skill's
install folder, and never from whatever directory you happen to be in: the wrong root
scatters a few hundred MB of scratch somewhere no `.gitignore` covers and nobody will think
to look.

> **For maintainers — the dual-file rule.** This skill is deliberately **monolithic**:
> the whole pipeline lives here, so a full run loads in one pass. Every stage *also* ships
> as its own sibling skill — `craft-video-<stage>/SKILL.md`, one per stage — a **complete
> contract** for that stage: its prerequisites, its command, what the agent writes, its
> hard checks and its `done when` gate. Those siblings are top-level under `skills/`, so
> every platform discovers them and any single stage can be re-run alone. Treat **this file
> as the contract of record**: every stage skill ends with a **Maintenance** note requiring
> its stage's section here to be reconciled whenever it changes. **If you add a stage, or
> change an existing one, update *both*** — the stage's section here *and* its sibling
> skill — or they will silently diverge.
> Stage skills reach the tools as `../explainer-video-from-coursework/tools/<tool>.mjs`;
> keep that path in step if the layout moves again. Cross-stage behaviour such as the
> `/scene ↔ /audio` loop lives in a tool, never in either file, so it stays in one place.
> See `ROADMAP.md` for the design record.

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
  finished MP4. A work dir belongs to exactly one video: the stage tools stamp a
  `.video-identity` marker into it and **refuse** a run whose `videoIndex` disagrees,
  because every video's `narration.wav`, `timeline.json`, `lines.json` and MP4 share
  the same names — a second video in the same dir would silently overwrite the
  first's timings. `--work` / `--out` are resolved against the current directory
  (an absolute path is fine); `render` converts it to a `file://` URL itself.
- **Videos are independent.** Nothing is shared between them, so two videos can
  coexist and either can be re-rendered or re-assembled on its own (ROADMAP §1,
  *Work-dir layout*). The only shared resource is Chromium's `--port`, so give every
  concurrent `render`/`assemble` its own: `assemble.mjs --port <n>` forwards the port
  to each segment render and **refuses a port already in use**, because sharing one
  does not fail cleanly — the second run attaches to the first browser's page and
  encodes the wrong video under its own filename, with exit 0.
- **One video end-to-end is a valid stopping point** (a pilot, or a single-target
  run). The series is the full deliverable, but each video is produced
  independently.

## Stage 0 — `/inputs`: source, destination, scratch

Ask for what the user must decide; everything else is the skill's. If the invocation
already names them, skip. Ask **together, one prompt, with defaults** for destination
and scratch so the user only adjusts, never invents:

- **Source** — the notes directory. If they referenced a path (`@…`), use it;
  otherwise list candidate directories that contain `.md` files and let them pick.
- **Destination** — where the finished video(s) land. Default: `videos/` beside the
  source. Each finished video lands in its **own folder** under the destination —
  `<destination>/<NN>-<slug>/` — holding the `.mp4`, `title.txt`, `description.md`
  and `captions.srt`. The folder name is derived from the plan's `videoIndex` (the
  consumption order) and a slug of the title, so a series sorts into watch order and
  a shared destination can never collide across videos. If the user puts it **inside**
  the source — `<source>/videos/` is a common choice — Stage 1 must `--exclude` it, or
  a published sidecar re-enters the plan as a note (Stage 1 has the detail).
- **Scratch root** — the directory that holds `out/`, i.e. the cwd for every command
  in Stages 1–8. Default: **`<source>/..`** — beside the source, the same anchor the
  destination uses, which also keeps it inside whatever repo already ignores `out/`.
  Not a throwaway: a series runs to hundreds of MB of WAV and MP4, so it is worth one
  line in the prompt rather than a surprise later. Say plainly that the default is
  fine; the user should not have to think about it.

Then `cd` to the scratch root once and stay there. It is the only cwd that makes the
`out/<name>/…` paths below resolve. If that root is inside a git work tree, `planner`
verifies `out/` is ignored and appends a rule when it is not, printing what it changed;
outside a repo there is nothing to ignore and it stays silent.

Proceed to Stage 1 only once all three are set. After Stage 1, show the plan's own
numbers as a free confirmation — *"`<source>` → N markdown files → M videos, landing
in `<destination>`"* — before Stage 2 and the `Choose the scope` gate spend anything.

## Stage 1 — `/plan`: decompose and prove completeness

```bash
node tools/planner.mjs <notesDir> --out out/<name> --max-min 25 \
  [--exclude <notesDir>/videos]
```

Writes `out/<name>/plan.json` and `out/<name>/plan.md`. No network, no key, safe
to re-run. Read `plan.md`, not `plan.json`.

`--exclude` is not optional when the destination sits **inside** the source (the
common case: `<notesDir>/videos/`). The planner walks everything under `<notesDir>`,
so a published `description.md` re-enters as a note and becomes a phantom video
titled after its folder. The planner names this if it sees it — `description.md` is a
name this pipeline publishes — but passing the exclusion is the actual fix, and it is
repeatable if several old output folders exist.

**Done when:** the run exits **0**, `plan.md`'s coverage line reads
`N assigned · M excluded as navigation · 0 orphaned`, **and you have shown the user
every planned video**. A non-zero exit, or any orphan, means the plan is incomplete —
stop and fix it. Never enrich an incomplete plan.

**Show all of them.** The plan's whole point is that it can be argued with row by row,
so display the complete list — index, title, length — however many there are. Concretely:
no sample, no "first 10 of 136", no "…and 126 more", no relying on the user to open
`plan.md`. A 136-video plan is 136 lines and that is the correct amount of output; a
truncated list silently turns a reviewable proposal into a fait accompli. (`planner`
now prints the whole plan for exactly this reason — if you post-process it, keep every
row.)

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

**`--max-min` is part of the plan, not a preference.** The plan records the model that
produced it (`model.maxVideoMin`) and its video **indices** are keyed by that split, so
re-running with a different cap gives a different number of videos — on the module-07
tree, cap 14 → 136 videos, cap 25 → 96. Any `enrichment.json` is keyed by index, so
`planner` **refuses** (exit 4) to overwrite a `plan.enriched.json` whose model differs,
and asks for `--force` or a different `--out`. `script-check` warns when the plan it is
validating was built with a different cap than it is enforcing.

## Stage 2 — `/enrich`: retitle and curate

Write `out/<name>/enrichment.json` — one entry per video — then validate and merge:

```bash
node tools/apply-enrichment.mjs --plan out/<name>/plan.json \
                                --enrichment out/<name>/enrichment.json
```

Writes `plan.enriched.json` and `plan.enriched.md`.

**Done when:** the run exits **0** (no validation problems), `plan.enriched.md` shows
the final video list, **and you have shown the user that complete list** — every
surviving video, plus the removals you made with their stated reasons. A problem list
means your enrichment is wrong — fix and re-run.

Same rule as stage 1: all rows or it is not a review. `apply-enrichment` prints the
full table; do not summarise it away.

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
stages 3–8 — never assume "all of them".** Present **every** video (all N of them:
index + title), not a sample or a "top 10", and ask for:

- **all** videos, or
- a **subset by index** — `30`, or `5, 7, 9`, or `1-3, 30`.

Then run stages 3–8 only for the chosen set, one video at a time, each into its own
`out/<name>/<NN>/` (see *Series scope*). TTS and rendering are the expensive stages,
so never spend them on a video the user has not explicitly chosen.

## Timing — every stage 3–8 is stamped

Per-video work starts here. Each stage is bracketed by a `stamp` pair so the series
accrues a per-video, per-stage audit; the `end` stamp is part of the stage's *Done
when*, so a stage is not complete until it is timed:

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage <n> [--note …]
… run the stage …
node tools/stamp.mjs end   --out out/<name> --video <NN> --stage <n>
```

`begin` writes a throwaway marker; `end` subtracts it and appends one row to
`out/<name>/timing.jsonl` — `{video, stage, attempt, seconds, ended_at, note}` — and a
retry of the same stage becomes the next `attempt` automatically. Render the audit with:

```bash
node tools/timing-report.mjs --out out/<name>   # → timing.csv · timing.md · timing.svg · timing.html
```

`timing.html` is the interactive view — self-contained (Plotly and the chart script are
inlined, so it opens with no network): horizontal stacked bars, hover for exact seconds,
legend-click to toggle a stage, zoom/pan/download from the modebar. `timing.svg` is the
no-JS fallback; `timing.csv`/`timing.md` carry the full per-video, per-attempt detail.

**Grouping is automatic.** The plan already groups videos by module — the first path
segment of a video's first source — so an 85-video series is really 17 modules. When the
ledger spans more than one module, the chart shows **one aggregate bar per module** and a
click breaks that module down by video; a single-module series renders every video
instead, since grouping it would be a pointless extra click. `--flat` forces the
per-video chart for a multi-module series.

**When to render it** — the ledger is the record and the views are free to regenerate, so
this is never urgent:

- **Series end** — always; this is the audit deliverable.
- **Module boundary** — during a long run, when the next video's module differs from the
  one just finished. The bar for that module is complete, so it is worth a look.
- **On demand** — any time you or the user wants it.

Do **not** render mid-video (a stage may be stamped, so its totals are partial) or after a
`--force` re-plan (the ledger keys on the plan index, which reshuffling breaks).

The stage lives in the `stage` *value*, never a column name, so stages can be added,
renamed, or merged later without touching the file's shape.

## Stage 3 — `/script`: write the narration

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 3
```


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


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 3
```

## Stage 4 — `/audio`: TTS and the measured timeline

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 4
```


```bash
node tools/build-audio.mjs --script out/<name>/scripts/<NN>-*.json --out out/<name>/<NN> --voice Aoede
```

Writes `narration/<seg>.wav`, `narration.wav`, `timeline.json`, and `timeline.js`
(browser-loadable) — all into the work dir.

A **partial** run (`--only <key>`, a smoke test) writes none of the three global
artefacts. It stops with a segment-scoped `timeline.<key>.json` and leaves an
existing `timeline.json` / `narration.wav` untouched, so a smoke test can never
leave a finished video with a one-scene timeline.
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


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 4
```

## Stage 4b — `/align`: word and line timings

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 4b
```


```bash
node tools/align.mjs --script out/<name>/scripts/<NN>-*.json --work out/<name>/<NN>
```

Transcribes the **whole narration track in one request** with word offsets, cuts those
words into segments at the measured `timeline.json` boundaries, **aligns each segment's
words back onto that segment's script words**, and writes the span of every narration
line to `lines.json` (plus `narration/<key>.words.json`, cached per segment).

One request per video, not one per segment: `gemini-3.5-transcribe` is capped at **100
requests/day per project per model** with no Batch API, so per-segment alignment would
cap the pipeline at ~3 videos/day. A track over ~28 minutes is cut at segment
boundaries into several passes, since 30 min is the model ceiling with word timings.

Why the alignment step is mandatory: the transcriber is not a faithful echo. Measured
on real narration it returned `In March, it pushes…` (inserted comma), `spends 40
minutes` (we wrote *forty*), `failed` (we wrote *fail*), and merged two sentences into
one. So **our punctuation decides the boundaries and the aligned words supply the
times** — never the transcript's own segmentation.

Word offsets occasionally contain outliers (one plan put `A delta` at 3.7s between
neighbours at 12.4s and 14.2s); they are forced monotonic, and the repairs are
reported.

**Done when:** `align` exits **0** and prints `✓ N segment(s) · M lines · written`.
Line times are relative to the narration WAV; `lines.json` records `lead` per segment,
so scene time is `line.start + lead`.


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 4b
```

## Stage 5 — `/scene`: author the visuals

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 5
```


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

### Two chrome defaults worth knowing

- **No in-frame progress bar.** `overlays.progress` is opt-in (`scene-core.js` draws one
  only when it is `true`). The finished MP4 plays in a player that already reports
  progress, so a bar duplicates it — and because the bar is the only element that changes
  on an otherwise static frame, it defeats static-frame skipping. Measured on a real
  scene: with the bar excluded, **82% of frames are byte-identical to their predecessor**.
- **The stage badge is on by default.** It is a position marker, not a title; several
  segments legitimately share one. Do not reuse badge text as chapter titles (stage 6) —
  it is typically uppercased and sometimes absent.

### The beat anchors to a line, never to a second

A beat declares **which narration line it illustrates**, not a time:

```js
window.SCENE_BEATS = { beats: [
  { id: 'march',   line: 1 },                    // the line this reveal belongs to
  { id: 'april',   line: 2 },
  { id: 'caption', lines: [3, 4], hold: true },  // holds across those two lines
]};
```

`line` is a 0-based index into that segment's lines in `lines.json` (stage 4b).
`lines: [from, to]` claims a range — a closing caption legitimately holds while the
last two or three sentences play — and `hold: true` lets the final beat run to the cut.

**Why not `at`.** A hand-written second cannot be validated, so it is never caught.
The module-07 pilot shipped `at: 6.6` for a phrase that begins at **12.6s**; every
check passed because none of them could see the narration. `resolve-beats` therefore
**rejects** a beat carrying `at` without `line`, and rejects a baked `at` that
disagrees with the measured line onset by more than 60 ms.

```bash
node tools/resolve-beats.mjs --work out/<name>/<NN> [--print]
```

It resolves `line` → `at = line.start + lead`, writes `beats.json`, and fails when a
line does not exist, beats run out of order, or **a narration line has no beat** —
which is narration playing with nothing changing on screen.

- **Dead air** is *undeclared* silence with nothing changing — that is still a bug.

`pacing-check` reads `beats.json` and resolves the beats against the measured
narration, reporting shortfalls (`beat "legend" needs 8.0s, has 5.0s (+3.0s)`). A
shortfall is a prompt to hold / pad / extend, **not** a failure — only a beat that
cannot fit inside its segment at all is an error. A beat that still carries a
hand-written `at` is reported as a defect, never silently honoured.

A beat's dwell should default to **how long its lines are spoken**
(`lines[to].end − lines[from].start`). That makes a shortfall arithmetically
impossible: `at + min` lands inside the window by construction. A line-anchored scene
should therefore report **no** shortfalls at all — the module-07 pilot ran 123 beats
across 30 scenes with zero.

**A shortfall now means you over-asked, not that the audio ran short.** You declared a
`min` longer than the lines the beat covers. Resolve it in this order:

1. **Widen the range** — `lines: [from, to]`, so the beat holds across the following
   line too. Free: no audio re-tile, no re-alignment.
2. **Redesign the beat** — a visual needing longer than its words is usually the wrong
   visual for them. Four one-word lines ("Staleness." … "Recall failure.") cannot carry
   four sequential card reveals; show all four at once and highlight each as it is
   named.
3. **`pad` the segment** — last resort. It buys screen time with silence: costs a
   re-tile, lengthens the video, adds no content.

Padding used to be step one because a guessed beat could not be trusted to fit inside
its window. Beat times are measured now, so padding is a design decision you should
have to argue for, not a routine repair.

**If you do reach step 3** — the `/scene ↔ /audio` loop. Set `pad` on the script
segment and `hold: true` on the beat, then re-run `/audio` (text-cached, so free; it
re-tiles the window wider). A `pad` widens the **window** only, never
`narration/<key>.wav`, so `lines.json` still describes the audio that plays and the
resolved beat times stay correct.

**Rewriting the narration is not free the same way.** Changing a segment's `text`
re-synthesises its WAV and invalidates every line time measured for it:

```
pad  → /audio                       → (line data still valid)
text → /audio → /align → /resolve-beats
```

`align.mjs` stamps each segment's text hash into `lines.json`, and
`resolve-beats --script …` **fails** when the script no longer matches, naming the
segment (the word cache makes re-aligning free unless the audio changed).

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
  → render --shots 6,20,34 --work out/<name>/<NN> --scene "src/scene-diagram.html?scene=<name>"
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


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 5
```

## Stage 6 — `/publish`: chapters and captions

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 6
```


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
  "youtubeTitle": "The Harness Is Not the Prompt",
  "chapters": [
    { "segments": ["framing"], "title": "What Is a Harness?" },
    { "segments": ["demo"],    "title": "The Demo That Worked" }
  ],
  "blurb": "Two or three sentences on what the video covers."
}
```

`youtubeTitle` is the line YouTube shows, and the one a viewer reads before deciding.
Write it **here**, not at stage 2: only now does the video exist to be described
honestly. It must be a subject someone would actually search, it must not promise what
the video does not deliver, and it must differ from every other video in the series — a
series whose parts are titled alike buries itself.

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

Outputs, copied into the video's own folder — `--dest/<NN>-<slug>/` — alongside the
MP4 because they are deliverables rather than scratch — three files:

- **`description.md`** — the blurb, then the chapter block, **paste-ready as plain
  text**. YouTube reads chapters only from the description, so the block lives here and
  nowhere else: there is deliberately no separate chapters file. Keep it free of
  markdown syntax (`#`, `**`, backticks) — the description field does not render
  markdown, so those characters would paste in literally.
- **`captions.srt`** — the cue list, uploaded as a caption track.
- **`title.txt`** — one line: the `youtubeTitle`. This is the file `upload_yt_video`
  reads out of the folder, so a video folder without it is an incomplete upload.

**Done when:** `publish` exits 0 and those three files land in `--dest/<NN>-<slug>/`
next to the MP4. The folder name is derived by the tool from the script's
`videoIndex` + title — do not hand-pick a different folder name, or a series will
sprawl out of watch order.


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 6
```

## Stage 7 — `/render`: frames to MP4

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 7
```


```bash
node tools/render.mjs --scene "src/scene-diagram.html?scene=<name>" \
                      --range <t0>,<t1> --outdir out/<name>/parts --name part-<key>
```

Renders **one scene config over one window** — headless Chromium via CDP → PNG
sequence → ffmpeg H.264. It is not a whole-video renderer: `--scene` takes a single
`host?scene=<config>`, so a multi-scene video is rendered window by window, which
stage 8 drives. A window rendered with no `--narration` comes out silent, which is
what assembly wants.

**Each distinct frame is captured once.** `renderAt(t)` is a pure function of time, so
consecutive frames are very often byte-identical — measured on this pipeline: 82% on a
declarative diagram scene, 90% on an `svg` scene, 99.7% on a held card. A screenshot is
~63 ms, the bulk of render wall time, so the capture loop asks the *page* instead: after
each `renderAt(t)` it hashes the serialized `#stage` SVG (~4 ms) and, when the markup is
unchanged, hardlinks the previous PNG to this frame number — same inode, zero extra
bytes — leaving the ffmpeg step untouched. There is **no flag**; this is the only capture
path. Two guards make a silently-wrong result impossible: a scene that declares CSS/web
animations (`document.getAnimations()`) takes the plain capture path from frame 0, and
every 30 frames a real screenshot is diffed against the frame that was written — on
disagreement the run writes the truthful frame, re-captures every frame since the last
audit, and drops to plain capture for the rest of the segment. Measured across two full
videos (72 scenes, ~54,000 frames): SSIM 1.000000 against renders that photographed every
frame, at 3.3× and 4.3× the speed. The final `[dedup]` line reports screenshots taken vs
total, reuse %, and audit results; a `dedup off from frame N` line means a guard fired and
is informational, not an error.

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


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 7
```

## Stage 8 — `/assemble`: the finished video

```bash
node tools/stamp.mjs begin --out out/<name> --video <NN> --stage 8
```


```bash
node tools/assemble.mjs --script out/<name>/scripts/<NN>-*.json \
                        --work out/<name>/<NN> --name <output> --dest <destination> \
                        [--port 9333]
```

`--port` (default 9333) is forwarded to every per-segment `render.mjs`, so **two
videos can assemble concurrently** when each is given its own port — the batch
caveat from `SERIES.md` applies to stage 8 too. The run aborts before segment one
if the port is already listening, because a shared port is the one failure this
tool cannot detect afterwards: the second assembly silently encodes the first
video's scene (verified — byte-identical frames, exit 0, a valid MP4 of the wrong
video). This is why the per-video agent can own stage 8 end to end on its own port.

With `--dest`, the finished MP4 lands in `<destination>/<NN>-<slug>/<output>.mp4` —
the same folder `publish` (stage 6) wrote `description.md` and `captions.srt` into.

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


```bash
node tools/stamp.mjs end --out out/<name> --video <NN> --stage 8
```

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
  "youtubeTitle": "The Harness Is Not the Prompt",
  "chapters": [
    { "segments": ["framing"], "title": "What Is a Harness?" },
    { "segments": ["demo"],    "title": "The Demo That Worked" },
    { "segments": ["smell"],   "title": "The Question No Demo Prepares For" }
  ],
  "blurb": "Module one of a harness-engineering course: what a harness is, the six failure families, and how value and risk sit in different layers of three real products."
}
```

`youtubeTitle` is the upload title written to `title.txt`, and the only field a viewer
sees before deciding whether to click. ≤100 chars is a hard error (YouTube's limit);
past ~70 warns (mobile truncation); all-caps and stacked punctuation warn; a
near-duplicate of a sibling video's title warns. Omitted, it falls back to the script
title with a warning — the fallback exists so the folder is never upload-incomplete, not
because the script title is a good marketing title. It is deliberately **not** the
`title` used for `<NN>-<slug>`: that one is structural and must not move.

`segments` holds one or more segment `key`s from the script, in playlist order; the
chapter's timestamp is the **first** one's window start. Grouping is expressed by
listing several keys — there is no separate group field. `title` is short (≤40 chars)
and must not duplicate or near-duplicate another chapter's. `blurb` is prose and is
the only field with no mechanical check.
