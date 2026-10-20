# Run findings — M6 · The Instruction Layer series (2026-10-20)

> **Status of the two items discussed in session.** Item **1** (stale stage-4 `--out`,
> ROADMAP §2.9.8) and item **4** (`--only` clobbering the global timeline) are **fixed
> and tested** — see the `RESOLVED` entry under ROADMAP §2.9.8 for the full record.
> In short: new `tools/workdir.mjs` stamps a `.video-identity` marker and
> `build-audio` / `align` / `assemble` refuse a `videoIndex` mismatch with exit 3;
> a partial `--only` run now stops with `timeline.<key>.json` and touches no global
> artefact; the stage 4/5/8 commands in `SKILL.md` and `PIPELINE.md` now show
> `out/<name>/<NN>`. Item **2** (no series state / dispatcher, ROADMAP §3.9) is still
> an open discussion — the proposal is per-video `state.json` with one writer per file
> plus a once-written selection manifest, rather than one shared `series.json`.


Defects and resolution proposals observed while running the full pipeline over
`GenAI_notes/Harness Engineering/modules/06-instruction-layer` and producing nine videos
(~180 min of finished video, 302 segments, 1,988 aligned narration lines).

Written by the agent that ran the series, for the maintainer. Each entry: symptom,
evidence from the run, proposed resolution, and where it belongs. Numbering matches the
in-session discussion; items **1** (stale stage-4 `--out` in `SKILL.md`, already tracked
as ROADMAP §2.9.8) and **2** (no series state / dispatcher, see ROADMAP §3.9) are being
resolved in conversation and are deliberately not repeated here.

---

## 3 · The "look at every still" gate cannot run while a render is running *(P1)*

**Symptom.** `SKILL.md` stage 5 and stage 7 both make visual review a *done-when* gate
("every still has been eyeballed"), and §*Series scope* requires one render at a time.
`render.mjs` defaults to a fixed `--remote-debugging-port=9333`, and neither `SKILL.md`
nor `PIPELINE.md` mentions that `--port` exists. The consequence is that the visual gate
is strictly serialized behind the render queue: you cannot QA video N's storyboard while
video N-1 is assembling.

**Evidence.** Every scene-authoring subagent in this run independently reported that it
*skipped* the still check, because the contract had to forbid `render.mjs` while a render
was in flight — e.g. *"the contract's hard constraints forbid running render.mjs, so no
QA stills exist for this video; the visual check is limited to the generated banner
configs."* I only discovered `--port` by reading `render.mjs:29`. With it, QA ran
concurrently on ports 9410+ and caught a real defect (video 5, `rejected3`: a lone pill in
a 19.5 s near-empty frame) that all config-level validators had passed.

**Resolution.** Delete the shared global instead of documenting the workaround:

1. Launch Chromium with `--remote-debugging-port=0` and parse the actual port from its
   `DevTools listening on ws://127.0.0.1:<PORT>/…` stderr line; keep `--port` as an
   override for reproducibility.
2. Add an `assemble.mjs` lockfile (`<work>/../render.lock`, pid + acquired_at + video) so
   two assembles cannot interleave.
3. Then state in stage 5/7 (both the monolithic `SKILL.md` and the two sibling
   `craft-video-scene` / `craft-video-render` skills) that stills may run concurrently
   with a render.

**Artefacts.** `tools/render.mjs` (`connect()` + the launch flags), `tools/assemble.mjs`
(lock), both docs. *Small.*

---

## 4 · `build-audio --only` destroys a finished video's timeline *(P1)*

**Symptom.** `--only <key>` is documented as a smoke test ("synthesize just one
segment"). It writes the **global** artefacts from a one-segment run, so `timeline.json`
and `timeline.js` are rewritten containing a single scene, and `narration.wav` is replaced
by that one segment's audio. Everything downstream — `assemble`, `publish` chapter
timestamps, `render --range` — now points at a timeline that no longer describes the
video.

**Evidence.** `build-audio --only module` on video 1 replaced a 48-scene `timeline.js`
with a 1-scene one. It was harmless only because the full run was re-issued afterwards
and the text-keyed cache made it free. On a finished video with no re-run, the timeline is
silently destroyed.

**Resolution.** A partial run must not emit global artefacts:

- with `--only`, write `timeline.<key>.json` and `narration.<key>.wav`;
- emit `timeline.json` / `timeline.js` / `narration.wav` only when **every** segment in
  the script is present in the narration set;
- add `--partial-ok` to make the smoke-test intent explicit.

**Artefacts.** `tools/build-audio.mjs`. *Small.*

---

## 5 · Cards break the beat model's own line-anchoring promise *(P2)*

**Symptom.** The beat model's central claim is that a visual beat names *which narration
line* it illustrates, because "a hand-written second cannot be validated, so it is never
caught" (`resolve-beats.mjs` header). The `cards` overlay violates exactly that: cards
stagger off a single uniform gap derived from the first two lines, so card *i* lands at
`line1_onset + i × (line2_onset − line1_onset)` regardless of when line *i+1* actually
starts.

**Evidence.** Three separate subagents flagged it unprompted:

- video 3 `tags`: the third card (`cf.`) lands **≈2.8 s** after its own line onset;
- video 3 `tdad`: card 3 **≈1.6 s** late;
- video 8 `shape-of-the-field`: card 3 **≈2.1 s** into the wrong line.

All passed `resolve-beats` and `pacing-check` cleanly, because neither can see it.

**Resolution.** Two halves, matching the tool's own doctrine:

1. **Make it derivable** — honour a per-item `at` in `scene-core.js`'s cards overlay
   (`cards.items[i].at`), resolved through the existing `deepResolve` `"scene@offset"`
   mechanism, so a generator can pass each line's measured onset.
2. **Guard what remains** — have `resolve-beats` compare each card's computed reveal time
   against its line's onset and warn past 0.5 s, so the uniform-stagger path cannot pass
   silently.

**Artefacts.** `src/scene-core.js`, `tools/resolve-beats.mjs`. *Small–medium.*

---

## 6 · The emitted folder name is unpadded, so the destination does not sort *(P2)*

**Symptom.** `naming.mjs`'s own docstring promises `<destination>/<NN>-<slug>/` and
asserts that *"listing the destination sorts it into watch order"*. The implementation is
`const idx = hasIdx ? String(script.videoIndex) : ''` — **unpadded**, so a ten-plus video
series sorts as `1-, 11-, 12-, 2-, 3- …`.

**Evidence.** `ls videos/` on this series lists
`11-compiling-an-ops-triage-assistant-with-dspy` and
`12-do-agent-frameworks-make-dspy-redundant` *before*
`2-design-exercise-write-a-policy-then-attack-it`. The module's comment already describes
the intended behaviour; the code contradicts it. Nothing in `tools/` parses the folder
name back, so there is no round-trip to break.

**Resolution.** `String(idx).padStart(2, '0')`, plus `--pad 3` for series ≥100. The tool
owns the folder name (`publish.mjs` and `assemble.mjs` both import `videoDir`), so no
agent-side convention changes. Optionally `--legacy-naming` for a series that must not be
renamed.

**Artefacts.** `tools/naming.mjs`. *One line.*

---

## 7 · `publish` has no dry-run, so chapter authoring cannot be validated up front *(P3)*

**Symptom.** Stage 6 is deliberately placed *before* the expensive render so metadata can
be reviewed while a fix is cheap. But the YouTube rules (first timestamp `0:00`, ≥3
chapters, each ≥10 s, ascending, titles ≤40 chars, no near-duplicates) are enforced only
by running the real `publish.mjs`, which also writes into the destination folder. For a
series there is no way to author nine `publish.json` files and validate them as a batch.

**Evidence.** Four of nine `publish.json` files failed on first use — two for chapter
titles over 40 characters (`Step Three: Split Declaration From Enforcement`, 46;
`Three Learned Modules, One Deterministic Retriever`, 50) and two because the files were
never written at all, which surfaced only when `publish` exited non-zero mid-queue. The
net effect was two destination folders containing an MP4 but no `description.md` or
`captions.srt`, discovered late.

**Resolution.** `publish.mjs --check`: extract the existing validators, add a flag that
resolves `publish.json` against `timeline.json` and the YouTube rules, prints the resolved
chapter table with timecodes, writes nothing, and exits non-zero on any violation. Then
stage 6's loop becomes write-all → `--check`-all → render.

**Artefacts.** `tools/publish.mjs`. *Small.*

---

## Cross-cutting: two interface properties both ranked items above depend on

**Unbuffered progress.** Every long stage goes silent for minutes. That silence is what
trains an agent to poll, and polling is pure overhead on a job bound by frame rate. Tools
should write line-buffered progress to stderr and accept `--log <file>`. This run lost
real time to it: a queue launched through `| tail -60` showed *no* output until exit, which
is why progress had to be re-derived from directory listings.

**State must be reconstructible from the filesystem alone.** The orchestrating agent's
memory is the weakest component in a multi-hour run — it compacts, and it re-derives.
Anything a resumed session needs (which videos, in what order, which stages are done)
must live on disk, one writer per file. See the in-session discussion of per-video
`state.json` plus a once-written selection manifest, as the alternative to a single
shared `series.json` with nine writers.
