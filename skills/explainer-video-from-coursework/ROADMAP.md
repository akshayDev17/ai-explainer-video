# Roadmap — what exists, what's left, what's questionable

Status snapshot for the `explainer-video-from-coursework` skill. Companion to
[`ARCHITECTURE.md`](./ARCHITECTURE.md), which states the code-vs-agent boundary.

Last updated after the `what-is-a-harness` run — videos 1–5 shipped end-to-end
(83 segments, 83 scenes, 29 min of finished video) and `/publish` built. Its P1 findings
are §2.9; the publish contract, the per-video work-dir layout and the beat model are
recorded as shipped in §1. Previously: the `high-level-design` run — video 30 through the
scene stage (15 scenes, `pacing-check` green, stills reviewed) — and the render and
assemble stages written into `SKILL.md`; video 6 (SOLID) completed end-to-end.

---

## 1. What exists

### The skill

`SKILL.md` — all eight stages (plan, enrich, script, audio, scene, publish, render,
assemble), each with its command, its `done when` gate, and the visual-check
protocol (vision gate + the `LOOK` step). Distributed as one plugin
(`plugin.json` + `skills/explainer-video-from-coursework/`) — see §2.3.

### The stage contracts

Eight internal contract files, one per stage, at `stages/craft-video-<stage>/SKILL.md`.
Each is a complete contract for its stage — prerequisites, command, what the agent writes,
hard checks, `done when` — read *by the main skill* when a single stage needs re-running,
not shipped as separate top-level skills.

`SKILL.md` stays **monolithic on purpose** — a full run loads in one pass — and is the
contract of record. Every stage file ends with a **Maintenance** note requiring the
matching `SKILL.md` section to be reconciled whenever the stage file changes: edit one,
edit both, or they silently diverge.

### The pipeline

```
source notes
   │
   ├─ /plan     tools/planner.mjs ............. decompose + assert coverage   [code]
   ├─ /enrich   agent writes enrichment.json
   │            tools/apply-enrichment.mjs .... merge + validate              [code]
   ├─ /script   agent writes scripts/NN-*.json
   │            tools/script-check.mjs ........ structure/speakability/budget [code]
   ├─ /audio    tools/build-audio.mjs ......... Gemini TTS + MEASURED timeline [code, API]
   ├─ /scene    agent writes scenes/*.js
   │            tools/pacing-check.mjs ........ reveal rate + dead air        [code]
   ├─ /publish  agent writes publish.json
   │            tools/publish.mjs ............. chapters + captions           [code]
   ├─ /render   tools/render.mjs .............. Chromium frames + ffmpeg      [code]
   └─ /assemble tools/assemble.mjs ............ per-segment render + concat   [code]
                tools/verify-audio.mjs ........ sample-level audio match      [code]
```

Stages are named in prose (`/render`, `/assemble`) rather than numbered, so inserting a
stage does not silently rewrite history: publish's insertion at 6 moved render to 7 and
assemble to 8, and "stages 6–7" had meant render/assemble.

### Renderers

| File | Covers | Vocabulary |
|---|---|---|
| `src/scene-svg.html` | the open lane — freeform SVG | author's own (`renderAt(t, svg, timeline)`) |
| `src/scene-core.js` | primitive library — `chart`, `hubSpoke`, `loopFlow`, `timeline`, `equation`, and the `flow` idiom | primitives take author params; `flow` keeps `client`, `server`, `hub`, `box` |
| `src/scene-code.js` | code walkthroughs, before/after refactors | code panels |

With no `work=` parameter, `src/scene-svg.html:34` resolves `?scene=<name>` to
`../scenes/<name>.js` — so the top-level `scenes/` is a live path for fixtures, not a
leftover directory. It holds the five `_pt-*` configs, one per primitive.

### Publish — chapters and captions (stage 6)

`tools/publish.mjs` exists and the stage runs; render and assemble do not depend on it. The
agent writes `out/<name>/<NN>/publish.json` — `chapters[]` (segment keys plus a `title`) and a
`blurb`. The tool resolves the timecodes from the measured windows, validates, and emits two
files, copied to publish's **own** `--dest` beside the MP4 (`assemble`'s `--dest` still
carries only the MP4):

| File | Contents | Delivered to |
|---|---|---|
| `description.md` | the blurb, **then** the chapter block, paste-ready as **plain text** (no markdown — the field does not render it) | the video **description** box |
| `captions.srt` | the cue list, one cue per segment | the **caption track** upload |

Granularity is one chapter and one cue per segment, SRT only, and chapter titles are
**authored** rather than taken from the scene badges.

**The rationale is in [`PIPELINE.md`](./PIPELINE.md) §6** — why the stage sits before the
expensive ones, why authored titles beat reusing `stageNames`, and why chapters can only come
from the description. The calls it made are §3.8.

### Work-dir layout — one directory per video

Each video's work dir (`out/<name>/<NN>/`) holds its own `timeline.js`, `manifest.json`,
and `scenes/`, so nothing is global:

- `build-audio` writes `timeline.js` beside `timeline.json` in `--out` (was `src/`).
- `assemble` reads `manifest.json` from `--work` (was `scenes/manifest.json`).
- the scene hosts resolve `timeline.js` and the scene config from a `?work=` query param,
  forwarded by `render.mjs` and `assemble.mjs`.

Two videos can now coexist and be re-rendered independently; only Chromium's `--port` is
shared, so renders still run one at a time. This closed the structural gap that the
pipeline assumes one video at a time.

### The beat model — the scene declares its own timing

A segment's visual is authored as a list of **beats**, each with a minimum dwell, declared
as `window.SCENE_BEATS` alongside the config. `pacing-check` resolves each beat against the
**measured** narration, reports shortfalls as prompts (exit 0), and errors only when a beat
cannot fit inside its segment at all. The dead-air check works in window-relative seconds
throughout, so it no longer mixes absolute event times with the relative window, and a
declared `hold` is no longer flagged as dead air.

The scene↔audio loop is wired: a shortfall is resolved by setting `pad` (hold silence) on
the script segment and `hold: true` on the beat, then re-running `/audio` — the TTS is
text-cached, so that is free and the window re-tiles wider.

**Two open questions about it** are recorded in §2.9.9.

### Proven output

Two runs went end-to-end. **Neither's work dir survives** — see §2.11.

**Video 6 (SOLID)** — 7 segments, 205.70s, Aoede narration, audio verified at residual
0.0155. Produced from real notes (`DEVELOPER-NOTES/.../low-level-design`) by the full
pipeline.

**A five-video series**, from `GenAI_Notes/Harness Engineering/modules/01-what-is-a-harness`:
83 segments, 83 scenes, 29.0 min finished, every video audio-verified (residuals
0.013–0.017). The first run to exercise the per-video work dirs at scale — five videos
coexisting, each re-rendered independently. Delivered to
`GenAI_Notes/Harness Engineering/modules/videos/`: the five MP4s plus video 02's
`description.md` and `captions.srt` are the surviving artifacts.

### Checks (4 of them)

| Check | Ask | Catches |
|---|---|---|
| coverage (in planner) | is every source heading assigned? | silently dropped content |
| `script-check` | is the narration speakable and on budget? | URLs, markdown, uncovered sections |
| `pacing-check` | can a human read this? is anything still happening? | unreadable reveals, dead air |
| `verify-audio` | does the finished audio match the narration? | wrong-slice muxing |

---

## 2. Remaining

**Numbering has gaps on purpose.** §2.2, §2.8 and §2.10 were resolved or built and now
live in §1; §2.4 (no dispatcher, no preflight) and §2.5 (Node ≥22 undeclared) were resolved
by making the tools fail loud and recording the agent-driven decision in §3. Numbers are
left vacant rather than reused — §2.9.8 is cited by number from `SKILL.md` and
`PIPELINE.md`, so renumbering §2 would break those. A gap means "done", not "deleted".

### 2.1 Portability — implemented, unverified off macOS

**Open — Windows Chromium has no command-free path yet.** The `win32` branch searches the
Playwright cache, so a Windows user must run `npx playwright install --only-shell` — a
command, against this skill's GUI-over-commands stance. *Candidate fix:* auto-detect the
preinstalled Edge/Chrome on `win32`
(`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
`C:\Program Files\Google\Chrome\Application\chrome.exe`) and use it before falling back to
the cache. Undecided, not implemented.

**Remaining:** one real run each on Linux and Windows — that alone flips this to "resolved".

### 2.3 Packaging — restructured; publish + register remain

The repo is now an Agent Plugins plugin: root `plugin.json` + `.claude-plugin/plugin.json`
+ `package.json`, the whole skill self-contained under
`skills/explainer-video-from-coursework/` (docs + `tools/` + `src/` + `scenes/` +
`SETUP.md`), and the 8 stage contracts internal under `stages/`. Targets: Claude Code,
Codex, DSH via **npm**; Antigravity via **git** (Cursor parked — marketplace-only, manual
review).

**Done:** the restructure, the manifests, the self-contained layout.

**Remaining:**
- `npm publish` (consumed by Claude Code and Codex marketplaces with `source: npm`, and by
  DSH) + a git tag (consumed by `agy plugin install <url>`).
- four one-line registrations: a thin `marketplace.json` for Claude Code and one for Codex,
  the `dsh plugin add` command, the Antigravity git URL.
- pin the exact `source: npm` syntax and the `dsh plugin add` invocation against primary
  docs at publish time.

### 2.6 `planner.mjs` — remaining input gaps

Robustness against odd inputs is done: zero-content input errors instead of emitting
a 1-video/0-minute plan, bad paths (nonexistent, or a file instead of a directory)
error cleanly, and the `--index-targets` dedupe was **deleted rather than flagged**.
What remains:

- **Only `.md` is parsed.** `.mdx`, `.rst`, `.txt`, `.ipynb` are invisible — silent
  omission, not an error. In one tree, 633 non-md files of which 72 matched the
  code-extension list leave ~560 files unaccounted for.
- **The code-extension list is hardcoded** (`.java .py .ts .js .go .cpp .c .rs`) —
  no `.kt .swift .rb .php .cs .scala .sh .sql`.
- **Coverage is structure-dependent.** The same file reported 0 orphans planned
  alone and 2 orphans planned inside a larger tree. "0 orphans" is a property of
  the run, not of the content.

### 2.7 `render.mjs` parts are silent by convention, not by flag

`assemble.mjs` never passes `--narration` to `render.mjs`, which defaults it to
`out/narration.wav`. Parts come out silent only because no such file exists — a
project keeps its track at `out/<name>/narration.wav` instead. The silence is
intentional ("muxing narration onto each one would restart the whole track at every
boundary"), but it is inherited from a directory convention rather than stated:
any run that ever leaves a track at `out/narration.wav` re-muxes the full narration
onto every part and silently reintroduces the double-mux bug.

Needs: `assemble.mjs` to pass an explicit `--silent` (or `--narration ''`).

---

### 2.9 Findings from the `what-is-a-harness` run

Recorded while producing five videos end-to-end (83 narrated segments, 83 authored
scenes, 29 min of finished video) from
`GenAI_Notes/Harness Engineering/modules/01-what-is-a-harness`.

**Every item below was observed in that run, not theorised.** Priorities are tagged per
item — all P1 except 2.9.9; this file does not track the P0 queue. Two are marked
*(applied in-run)* — those exist only in the working tree that produced these videos:
`explainer-video/` is **not a git repository**, so there is no baseline to diff them
against and they are not preserved anywhere else.

#### 2.9.1 `draw` silently accepts the wrong shape *(P1)*

`reveal` takes a bare two-element array — `reveal: { node: ['seg@2.0', 'seg@3.0'] }` —
but `draw` takes a wrapper — `draw: { edge: { at: ['seg@2.0', 'seg@3.0'] } }`.
Passing the bare array to `draw` does not error:

- `scene-core.js:563` reads `drawSpec.at[0]`;
- `drawSpec.at` therefore resolves to `Array.prototype.at` — a *function* — so `[0]`
  is `undefined`, `fadeIn(t, undefined, undefined)` returns `NaN`, and
  `setAttribute('opacity', 'NaN')` is rejected by the DOM, leaving the attribute at
  its default `1`.

The edge consequently renders **fully visible from frame 0**: a connector floating
before the nodes it joins exist. Both `script-check` and `pacing-check` stay green,
because neither looks at geometry — it was caught only by sampling the assembled MP4.

Observed in `v1-demo`. **Fix:** normalise both shapes at load, or validate `draw`
keys. *Small.*

#### 2.9.2 `size: { w }` silently disables a box's auto-height *(P1)*

`scene-core.js:158` is `if (kind === 'box' && !nd.size)`. Supplying *any* `size` —
even only `w` — skips the height computation entirely.

Widening a box to stop its member text overflowing therefore silently clips the last
member line against the bottom border. Observed in `v1-blur`: three members in a
`size: { w: 640 }` box rendered at the default `h: 132` instead of the required 160.

**Fix:** keep auto-height when `members` exist and `size.h` was not given explicitly.
*Small.*

#### 2.9.3 Flows that terminate on a wide node draw a stray ring *(P1)*

`scene-core.js:292` gives every flow target an arrival ring of fixed `r: 58`,
independent of node size. On a 470px `box` (or a 252px `hub`) that ring sits wholly
inside the node, so it reads as a random circle rather than an arrival highlight.

The skill already knows this, but only as example-scene lore:
`out/hld-full/scenes/lb-l4-vs-l7.js` carries the comment *"route THROUGH the boxes,
never INTO them"*. Nothing enforces it.

Observed in 4 scenes: `v1-demo`, `v1-loop`, `v3-agenttool`, `v3-ex-agenttool`.

**Fix:** warn at load when a target's half-width or half-height exceeds the ring
radius, or scale the ring to the node bounds. *Small.*

#### 2.9.4 Nothing asserts that a scene *opens* with something on screen *(P1)*

`pacing-check`'s dead-air rule subtracts the narration windows before measuring
silence, so "blank stage with a voice over it" is deliberately never flagged. A
scene can be entirely pacing-clean and still show an empty frame for seconds after a
hard cut.

Observed: **16 of 83** scenes had a first visual onset later than 2.5s; the worst —
`v1-support`, `v1-coding`, `v1-research` — sat empty for 5–6s.

`tools/onset-audit.mjs` was written during the run for exactly this: it computes each
scene's earliest visual event in seconds, and reported 83/83 clean once the fixes
landed. **Fix:** fold it into `pacing-check` as a third assertion. *Small — the
script already exists.*

#### 2.9.5 Nothing checks that text fits its container *(P1)*

Every checker is timing- and structure-only; overflow, clipping and overlap are
invisible to all four of them.

The clearest case was the stage badge in `scene-core.js`: a hardcoded 292px pill that
never measured its label, with the text merely centred inside it. Measured off a real
frame:

| Label | Text | Pill | Result |
|---|---|---|---|
| `CAPABILITY VS SYSTEM` | 273px | 292px | fits (10px margin) |
| `NOT AN AFTERTHOUGHT` | 284px | 292px | fits by ~4px — reads as touching |
| `EXAMPLE · CHAT TRANSFER` | 323px | 293px | overflows 15px per side |
| `EXAMPLE · AGENT AS A TOOL` | 341px | 291px | overflows 24 / 26px |

*(Applied in-run: the pill now measures with `textW()` and re-centres, right edge
pinned at `W − 74`, wrapped in `Math.max(292, …)` so short labels are unchanged.)*

Still unchecked and carrying the same exposure: box `members` (21px mono — roughly
33 characters is the limit in a 470px box), box labels, and `cards` labels.

**Fix:** a headless pass asserting measured text width against container width.
**Largest item in this section.**

#### 2.9.6 `progress` defaults to on *(P1)*

`scene-core.js:324` is `if (OV.progress !== false)`. The overlay draws a 6px track
plus an amber fill that tracks playback. A scrubber is a *player* affordance, but it
is drawn into the frames, so it ends up burned into the exported MP4 — where the
player draws its own controls. All 83 scenes had to opt out explicitly.

**Fix:** default it off, or drop the overlay. *One line.*

#### 2.9.7 Re-rendering is all-or-nothing *(P1)*

`assemble.mjs:89` filters the segment order down to `--only` and then concatenates
only those parts — so `--only` emits a *one-segment* video and cannot patch an
existing cut. `assemble.mjs:178` then deletes every part on success.

Fixing 4 segments of video 1 therefore cost a full re-render (23 segments, ~19 min),
because the other 19 parts no longer existed. A reuse pass keyed on `part` mtime vs
`scene` + `timeline` mtime would have taken about two minutes.

**Fix:** add `--reuse` (skip segments whose part is newer than their scene and the
timeline), and/or keep parts by default. *Medium.*

#### 2.9.8 `SKILL.md`'s work-dir convention contradicts its own "Series scope" *(P1)*

- **The contradiction:** "Series scope" says each video gets its own
  `out/<name>/<NN>/`, but every stage command in `SKILL.md` shows `--out out/<name>`
  / `--work out/<name>`. §1 *Work-dir layout* records the per-video layout as resolved,
  yet the commands were never updated to match, so the agent has to reconcile the two
  itself.
- **An undocumented rule:** `--work` must be a path *relative to `src/`*, because the
  hosts resolve `'../' + WORK + '/timeline.js'` (`src/scene-diagram.html:31`,
  `src/scene-svg.html:31`). A repo-root-relative or absolute path silently fails to
  load the timeline.

**Fix:** update the stage commands to `out/<name>/<NN>`, and document the `--work`
path rule. *Small.*

#### 2.9.9 The beat model: two things worth resolving *(P2)*

- **Nothing but the checker reads `SCENE_BEATS`.** All three scene hosts
  (`scene-diagram.html`, `scene-svg.html`, `scene-code.html`) and `scene-core.js` reference
  it **zero** times, so beats are a *lint* input and not a rendering input — yet `SKILL.md`
  says each aligned beat "resolves to `max(narration_beat, visual_beat_min)`". Holds are in
  fact realised by padding the audio, so either that sentence overstates the mechanism or a
  renderer-side piece is missing.
- **It fails silently when undeclared.** `tools/pacing-check.mjs:174` yields `null`, and
  both the beat branch (`:175`) and its fallback (`:210`) require `BEATS && BEATS.length` —
  so a scene with no beats prints no beat line at all, rather than "none declared". You
  cannot tell "no beats" from "beats declared and fine" without noticing the absent line.

Adoption on a real segment is also unverified: the five surviving `_pt-*` fixtures declare
no beats, and the 83 harness configs no longer exist.

---

### 2.11 Repo metadata, before this is pushed anywhere *(P2)*

- No `README.md`. `SKILL.md` is written for an agent, not for a human arriving at the repo.
- No `LICENSE`.
- `package.json` is bare `{"type": "module"}` — no `name`, `description`, or `scripts`, so
  `npm run` does nothing. There is no test suite; the five delivered videos are the golden
  corpus.
- `.gitignore` carries two dead lines, `frames/` and `.explainer-video/` — neither path has
  ever existed here. (`preview/` and `parts/` are absent right now too, but the tools
  recreate them, so those entries stay.)

---

## 3. Design decisions worth challenging

These are the calls I made. Some may be wrong.

### 3.1 Code vs agent boundary

Code does anything that must be exact (parsing, packing, coverage, timing math,
rendering, verification). The agent does judgment (titles, forms, scripts, scene
authoring). No LLM API is used for reasoning — only for TTS.

*Challenge if:* you think some judgment step is too expensive/variable to leave to
an agent, or that a deterministic step should be model-assisted.

### 3.2 One config file per segment, not a single DSL

Each segment gets its own `scenes/*.js`. There is no cross-segment timeline in
config — `assemble` stitches windows.

*Challenge if:* you'd rather have one project-level config describing the whole
video, with segments as sections.

### 3.3 Per-segment render + concat (hard cuts)

Chosen so segments stay independently reviewable and re-renderable.

*Tradeoff:* hard cuts, no cross-fades. Deferred by request.

### 3.4 Timing is relative to narration, not absolute

`"srp@4.6"` resolves to `segment_start + 4.6`. This fixed a real desync where
hardcoded absolute times drifted when the voice changed.

*Challenge if:* scene authoring becomes harder to reason about than absolute
times.

### 3.5 Four separate checkers rather than one

Each is small, single-purpose, and independently runnable.

*Challenge if:* this fragments the QA story instead of giving one "is this video
good?" gate.

### 3.6 Text-keyed audio cache

Re-runs reuse a segment's WAV only if the spoken text is unchanged, so iterating on
scene timing never re-spends TTS quota.

*Challenge if:* the script changes for non-text reasons (voice, style, model) and
the cache silently serves stale audio — **this is a real hole**: `style`, `voice`
and `model` are NOT part of the cache key.

### 3.7 The planner's duration model — recalibrated

The `×1.35` visual-overhead factor was a guess and ran **37% over** (video 6
predicted 4.7 min, actual 3.43). Now measured and centralized in
`tools/model.mjs`: `wpm 153` (508 words → 199s of audio) and `expansion 1.10`
(205.7s picture / 199s narration = 1.03, plus a buffer). `planner`,
`script-check` and `pacing-check` all import it, so they can't drift. Re-verify
against a code-heavy video, where `codeNarration 0.15` may still under-count.

### 3.8 Chapter granularity is bounded by segment granularity

A chapter's time is its first segment's window start, so a chapter can **group** segments
but never **split** one. A boundary can only land where the narration already breaks.

*Challenge if:* a segment carries two ideas and deserves two chapters. Grouping is a
format-compatible later change; splitting needs a second timestamp source and is not.

### 3.9 No dispatcher — the agent is the orchestrator

There is no `pipeline.mjs` or `bin` entry point. `SKILL.md` sequences the stages and the
agent composes the `tools/*.mjs` calls, because stages 1–2 are once-per-series, 3–8 are
once-per-video, and judgment steps (authored JSON) interleave with code. Each stage is also
its own skill.

*Challenge if:* you want a non-agent entry point — a CLI or CI job that runs the whole
series unattended — which would need a driver that encodes the series/per-video loop and
the judgment steps.

---

## Open questions

Unresolved, captured for later. Do not act on these yet.

### Q1 · Artefacts attribution in `planner.mjs`

The rule at `planner.mjs:340–343` attaches a code file to a video by **path
prefix** of the video's source directory. It is:

- **depth-blind** — a phase-hub README (e.g. `distributed-systems-theory/README.md`)
  inherits every demo in every sub-chapter beneath it (10 files for one video).
- **content-blind** — when one README is split across N videos, all N siblings get
  the identical list, whether or not their own text mentions any demo.

It never *misses* (every referenced demo is present) — it only over-includes.
Counted on `hld-full`: 107 planned entries vs 60 referenced by the carrying video's
own text; 47 inherited, 15 surviving after curation.

Open because:

- **The field's meaning is undecided.** Three rules give different answers for the
  same chapter (`database-types`: 9 vs 3 vs 6 entries):
  1. *prefix* — current.
  2. *reference-evidenced* — a demo belongs to a video iff that video's own section
     text mentions it (supported by the source's own structure; concept videos then
     carry zero code artefacts).
  3. *topic-attributed* — map each demo to the video covering its topic (needs a
     hand-built demo→topic ontology the source does not contain).
- **Nothing consumes `artefacts`.** The planner writes it and `plan.md` prints its
  count; no renderer, checker, or scene reads it. Informational only today.

### Q2 · `apply-enrichment.mjs` merge drops artefacts

The `mergeInto` branch unions `sections`, `sectionSpans` and `words` — but **not**
`artefacts`. Merging a video silently drops the folded-in video's code files from
the target's list. Never fired on `hld-full` (curation used `skip`, not
`mergeInto`), but it is a latent drop.

Related: the agreed "let `/enrich` curate artefacts" escape hatch is **not
implemented** — `enrichment.json` has no `artefacts` field, `apply-enrichment`
passes the list through untouched, and there is no subset validation.

---

## 4. Acceptance test

Hand a fresh agent only the skill — no conversation history — point it at a notes
directory, and see whether it produces a video without asking questions.

Today the likely failure is no longer scene authoring — that is documented — but the
platform-specific bits: Chromium discovery and the key's OS secret store, both implemented
but only verified on macOS (§2.1).

---

## 5. Explicitly out of scope for now

- Scripts and videos 1–5 and 7
- Cross-fades between segments
- Per-member highlighting in the UML box kind
- Productising the load-balancer project (now legacy duplication)

---

## 6. Planned skill family

This skill is `explainer-video-from-coursework` — it assumes structured coursework
notes (markdown READMEs, a heading per topic, `code/` demos) and is **not known to
generalise** beyond that. Two siblings are planned, split by where the source
material comes from:

| Skill | Source | What it adds over this one |
|---|---|---|
| `explainer-video-from-coursework` *(this)* | structured coursework notes | decompose + prove coverage + narrate + animate |
| `explainer-video-from-source` | a general source — docs, papers, codebases, arbitrary notes | generalise the planner's assumptions (README layout, heading structure, `code/` convention) so non-coursework sources decompose cleanly |
| `explainer-video` | no source — a narrow-to-broad topic description | author the study material first (a pre-stage that builds the notes), then feed it through the same plan→video pipeline |

Not started. Recorded here so the naming is reserved and the "from coursework"
scope of this skill stays explicit.
