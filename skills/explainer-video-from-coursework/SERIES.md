# SERIES.md — running a multi-video series

Stages 1–2 run once over the whole notes directory. Stages 3–8 run **per video**.
This file defines how a series run is organised, recorded, and resumed.

It exists because nothing else did. A nine-video run had no durable record of which
videos were selected, no per-video progress state, and no defined execution topology,
so the orchestrating agent hand-rolled a queue in `/tmp` and kept the remaining list in
its own context. When the session was interrupted, the pipeline's state was interrupted
with it, and the queue had to be re-derived three times. **A resumed session must be
able to continue from the filesystem alone.**

---

## Topology

```
assemble the run (once)
  ├─ read plan.enriched.json + the chosen indices  →  write series.json  (once, never rewritten)
  └─ loop, lazily:
        acquire a free port   →  spawn ONE per-video agent  →  on settle, read its state.json
```

**Two roles, strictly separated.**

| Role | Does | Never does |
|---|---|---|
| **Orchestrator** (the main session) | Writes `series.json`. Dispatches one agent per free port. Reads `state.json` and the timing ledger. Reports. | Runs any skill stage. Renders anything. Polls anything. |

| Role | Does |
|---|---|
| **Per-video agent** (one subagent per video) | Stages 3→8 for its own video, end to end, including script authoring and the visual QA loop. Owns its work dir. Writes its own `state.json`. |

**The port is the admission token.** A port in the pool means "one more video may be in
flight". The orchestrator spawns only when a port is free, so an agent never queues and
never waits — which is the entire point of lazy dispatch, and why no lock can starve.
A per-video agent's lifetime is its render window bound: author → audio → align → stills
→ render → QA → assemble, typically 1.5–2.5 hours.

**Consequence, stated plainly:** total in-flight videos ≤ `parallel`. On an 8-core,
8 GB machine that is 2–3. Authoring capacity is therefore bounded by render capacity.
Whether that costs throughput depends on how well concurrent renders scale, which is
unmeasured — see *Open parameter* at the end.

---

## Files

### `out/<name>/series.json` — written once by the orchestrator

```json
{
  "plan": "out/<name>/plan.enriched.json",
  "destination": "videos/",
  "parallel": 2,
  "portBase": 9333,
  "videos": [
    { "index": 1, "work": "out/<name>/01", "script": "out/<name>/scripts/01-<slug>.json",
      "slug": "1-the-instruction-layer-the-constitution-your-agent-runs-on",
      "name": "the-instruction-layer" }
  ]
}
```

`parallel` is the **one** concurrency number: it is simultaneously the pool size, the
batch size, and the maximum number of concurrent per-video agents — because the port *is*
the admission token, so one in-flight video means one port means one subagent. Ports are
derived, never stored: slot *i* renders on `portBase + i`. Storing a port list as well
would let the two drift, and a resumed session would then hand out a port a live agent
already holds.

It lives in this file rather than being a flag because a resumed session must not pick a
different value: `parallel` determines port allocation, and changing it mid-run
invalidates every port already claimed.

Titles are **not** duplicated here — they live in `plan.enriched.json`, which stays the
single source of truth for content. Two copies would drift.

### `out/<name>/<NN>/state.json` — written by that video's agent, and only by it

```json
{
  "videoIndex": 1,
  "status": "rendering",
  "stages": {
    "3":  { "done": true, "attempts": 1, "ended_at": "…", "by": "agent-abc" },
    "4":  { "done": true, "attempts": 1, "ended_at": "…" },
    "4b": { "done": true, "attempts": 1, "ended_at": "…" },
    "5":  { "done": true, "attempts": 1, "ended_at": "…" },
    "6":  { "done": true, "attempts": 1, "ended_at": "…" },
    "7":  { "done": true, "attempts": 1, "ended_at": "…" },
    "8":  { "done": false, "attempts": 1, "last_error": null }
  },
  "artefacts": {
    "script": "…", "lines": "…", "beats": "…", "manifest": "…",
    "mp4": "videos/<slug>/<name>.mp4",
    "description": "videos/<slug>/description.md", "captions": "videos/<slug>/captions.srt"
  },
  "render": { "port": 9333, "attempts": 1 },
  "qa": { "stills_checked": true, "beats_audited": 48, "verdict": "accept" }
}
```

`status` ∈ `queued · authoring · audio · aligning · scenes · publishing · rendering ·
qa · done · failed · needs-fresh`.

**One writer per file** — that video's agent. Write atomically (temp + `renameSync`).
No shared file has nine writers, so there is nothing to merge and no lost updates.

`state.json` is a *claim about* progress, not proof of it: on resume, verify the
artefacts actually exist before trusting a `"done": true`.

### `out/<name>/<NN>/.video-identity` — written by the *tools*, not the agent

Stamped by `tools/workdir.mjs` on the first stage that touches the dir; refuses a
`videoIndex` mismatch with exit 3. Identity answers *whose dir is this*; `state.json`
answers *how far along*. Keep them separate: the guard must work for a human running a
single stage by hand, with no agent and no state file.

### `out/<name>/<NN>/intent.md` — written by the agent at stage 5

One line per beat: what should be on screen, and on which words.

```
beat 3  "gate"     on "No authorization check"        three red pills appear left
beat 4  "gate"     on "No confirmation"               fourth pill, right column
beat 9  "fix3"     on "Only the tool…can guarantee"   final line lands, amber
```

Its purpose is QA fidelity — an agent judging frames against its *own recorded intent*
rather than against a memory of it — and anti-leniency, since a checklist resists
rubber-stamping far better than an impression does. Read it fresh at QA time; do not
recall it.

---

## The per-video agent's duties

Each stage, in order, with its gate:

| Stage | Duty | Gate before moving on |
|---|---|---|
| **3** | Write `scripts/<NN>-<slug>.json`. **Read the plan's `sectionSpans` for this video and the source markdown itself** — a summary is not enough for a faithful script | `script-check` exits 0 |
| **4** | `build-audio --out out/<name>/<NN>` — measured durations, tiled windows | exits 0; every segment has a window |
| **4b** | `align` — word and line timings | exits 0; a line for every segment |
| **5** | Author `scenes/` + `manifest.json` + `intent.md`; `resolve-beats`; `pacing-check` per segment | pacing is sound for every segment |
| **5·QA** | **Stills gate** — `render --shots` at 3–5 mid-segment times on the assigned port, then **look at them** | no collision, no missing heading, nothing cropped |
| **6** | `publish.json` → `publish` | chapters and cues validate |
| **7–8** | `assemble --dest videos` | exits 0 with `audio ok` |

Then: sample the finished MP4, look, and either accept or fix-and-re-render.

**Fix loops are bounded.** Two render attempts, two QA rounds. On the second failure
write `status: "needs-fresh"` with the reason and stop — a drifting session that keeps
re-rendering is worse than a fresh one that resumes from `state.json`.

**Release the port between attempts**, not at the end of the agent's life, so a fix loop
cannot starve the other videos waiting to be admitted.

---

## Hard rules

1. **Never write into another video's work dir.** One dir per video; the guard enforces
   it, and the refusal (exit 3) is not to be worked around by deleting the marker.
2. **One port per agent.** Never omit `--port`; a second render on 9333 does not fail
   cleanly, it attaches to the running browser's page.
3. **Never run `build-audio --only` against a finished video.** Partial runs are isolated
   now, but the intent of `--only` is a smoke test on a video you have not finished.
4. **Scope every per-video command at `out/<name>/<NN>`.** `stamp`, `planner` and
   `timing-report` legitimately take the plan dir; nothing else does.
5. **`timing.jsonl` is append-only and already concurrency-safe** — `appendFileSync` of a
   sub-4KB line is atomic. Do not rewrite it as read-modify-write.
6. **Scratch is disposable, deliverables are not.** `out/` is git-ignored; **`videos/`
   currently is not** — a `git clean -fd` in the notes repo deletes the finished MP4s.

---

## Acceptance tests

Design against these; they are also how you would verify a re-implementation.

1. **Cold resume.** Kill every session mid-run. A fresh agent with no conversation
   history reads `series.json` + the `state.json` files and continues correctly.
2. **No cross-contamination.** Two videos, one directory → exit 3, and the victim's
   `timeline.json` byte-identical afterwards.
3. **Port reclamation.** An agent killed while holding a port does not block the series;
   the port is reclaimable by pid-liveness or age.
4. **No silent partial.** A `--only` run leaves `timeline.json` and `narration.wav`
   untouched and writes `timeline.<key>.json`.
5. **Untouched happy path.** A dir holding plan files with no marker is accepted — the
   guard must not fire on legitimate layouts.

---

## Batch size — measured

Measured on this machine (8 cores, 8 GB), one fixed 612-frame window of one real scene,
distinct work-dir copies, distinct ports, nothing else running:

| trial | per-slot wall fps | aggregate | vs solo |
|---|---|---|---|
| N=1 | 12.21 | 12.21 f/s | 100% |
| N=1 (repeat) | 12.46 | 12.46 f/s | 102% — noise is ~2% |
| **N=2** | 12.05 | **24.10 f/s** | **197%** |
| **N=3** | 10.77 | **32.31 f/s** | **265%** |

**Set `parallel: 3`.** A second render costs almost nothing (1.3% per slot); a third
costs ~12% per slot and still nets +34% aggregate over N=2. Concurrency buys *throughput*
here, not just latency, so the batch is justified on its own merits. Cap at 3 on 8 GB —
each slot is a Chromium plus an ffmpeg.

### What the profile actually says

`render.mjs` reports 13.4 / 14.2 / 13.9 fps at N=1/2/3 while wall clock rises, so the
per-frame capture loop is **not** what degrades under contention — the extra time is
process startup and the ffmpeg encode. Overhead, computed per trial as wall minus
(612 ÷ reported fps): **N=1 ≈ 4.4 s, N=2 ≈ 7.7 s, N=3 ≈ 12.8 s**.

That overhead is paid **per segment, not per video**, because `assemble` invokes
`render.mjs` once per segment and each invocation launches a fresh Chromium and reloads
the page. On a 48-segment video that is ~48 × 4.4 s ≈ **3.5 minutes of pure relaunch**,
about 7% of a 50-minute render — a cheaper win than a codec or pipe change, and it needs
no change to how frames are captured. (An earlier draft of this section said ~5 minutes /
10%, from flatly assuming 14 fps; the per-trial figures above are the measured ones.)

**Consequence for this topology:** `frames/` and `preview/` are derived from `--work`, so
two concurrent renders can never share a work dir even on different ports. One dir per
video satisfies this by construction; a benchmark or smoke test must copy the dir per slot.
