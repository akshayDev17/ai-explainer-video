# explainer-video-from-coursework

Turn a directory of structured coursework notes into a narrated, animated
explainer-video series.

A skill for AI coding agents — Claude Code, Codex, DeepSeek Harness and
Antigravity. Point it at a folder of course notes: it plans the series, writes
the narration, synthesizes the audio, authors the visuals, then renders and
assembles finished MP4s with YouTube-ready chapters and captions.

Its planner does not merely invent titles — it **proves completeness**: every
content-bearing section is assigned to a video or classified as navigation
(`0 orphaned`) before any expensive stage runs.

## The pipeline

Stage 0 (`/inputs`) collects the two things only you can decide — the source
notes directory, and where the finished videos land.

| # | stage | what it does | cost |
|---|-------|--------------|------|
| 1 | `/plan` | decompose the notes, prove coverage | free, local |
| 2 | `/enrich` | retitle and curate (skip / merge) | free, agent |
| 3 | `/script` | write the narration segments | free, agent |
| 4 | `/audio` | TTS → a measured timeline | **network — spends the Gemini key** |
| 5 | `/scene` | author the visuals (`diagram` / `code` / `svg`) | free, agent |
| 6 | `/publish` | YouTube chapters + captions | free — no TTS, no Chromium |
| 7 | `/render` | frames → H.264 MP4 | local CPU |
| 8 | `/assemble` | per-segment parts → the finished cut | local CPU |

Stages 1–2 run once for the whole directory; stages 3–8 run once per video. One
video end to end is a valid stopping point — a pilot, or a single-target run.

## Install

**Claude Code**

```sh
claude plugin marketplace add akshayDev17/ai-explainer-video
claude plugin install explainer-video-from-coursework@akshaydev17
```

**Codex**

```sh
codex plugin marketplace add akshayDev17/ai-explainer-video
codex plugin add explainer-video-from-coursework@akshaydev17
```

**DeepSeek Harness**

```sh
dsh plugin --profile web add explainer-video-from-coursework
```

**Antigravity**

```sh
agy plugin install https://github.com/akshayDev17/ai-explainer-video
```

All four commands install the **same** npm package — one package, three manifest surfaces,
one copy of all sixteen skills: the ten video skills, `coursework-author`, the companion
skill for writing the coursework these videos come from, and the five code-flow skills:
`explainer-video-from-codebase`, which makes explainer videos of a codebase's major code flows
(Python, TypeScript / JavaScript, Go, C, C++, or a mix), and its four stage skills. It mines the
repo, ranks candidate flows, optionally traces the test suite in a sandbox, has you approve the
flow list, plans the videos, then runs the same per-video stages with verified code panels and
generated flow diagrams. How each platform reads it, and how
to publish, is in
[`DISTRIBUTION.md`](./DISTRIBUTION.md).

## Prerequisites

- **Node ≥ 22** — `render.mjs` relies on the built-in global `WebSocket`.
- **`ffmpeg` + `ffprobe`** — H.264 encoding, muxing, and duration measurement.
- **Headless Chromium** — `npx playwright install --with-deps --only-shell`.
- **A Gemini API key** — for TTS. It lives in the **OS secret store** (macOS
  Keychain · Linux `secret-tool` · Windows Credential Manager) under the service
  name `gemini-tts` — never in env, never in a plaintext file. A free key:
  <https://aistudio.google.com/apikey>.

The tools **fail loud** on a missing prerequisite rather than quietly producing a
broken video. Per-OS commands and citations:
[`SETUP.md`](./skills/explainer-video-from-coursework/SETUP.md).

## Use it

Invoke the skill with the notes directory:

```
/explainer-video-from-coursework path/to/your/notes/
```

You get one `.mp4` per video, plus `description.md` (blurb and a paste-ready
chapter block) and `captions.srt`, copied to the destination you chose — by
default `videos/` beside the source. Scratch stays in a gitignored
`out/<name>/<NN>/`.

For a codebase, invoke the code-flow skill with the repo root instead:

```
/explainer-video-from-codebase path/to/your/repo/
```

It shows you the ranked candidate flows and its proposed series, and plans no video until you
approve the flow list. Its scratch root sits outside the repo.

Run every command from the **project** (where `out/` lives), not from the skill's
install folder. The tools self-locate their own `tools/`, `src/` and `scenes/`,
so only the work and scratch paths depend on the current directory.

## Repository layout

```
plugin.json                              Agent Plugins manifest (Codex, Antigravity)
.claude-plugin/                          plugin.json + marketplace.json (Claude Code)
.agents/plugins/                         marketplace.json (Codex)
cordis.patch.yml + lib/index.js          DSH bundle plugin (serves this package's skills/)
skills/explainer-video-from-coursework/  the main skill: SKILL.md, tools/, src/, scenes/, SETUP.md
skills/craft-video-<stage>/              the 9 stage skills, separately invocable
skills/coursework-author/                the companion skill: authoring the coursework (vendored copy)
skills/explainer-video-from-codebase/    the code-flow skill: SKILL.md, FLOWS.md, tools/, vendored tree-sitter
skills/craft-codeflow-<stage>/           its 4 stage skills (mine, flows, plan, scene), separately invocable
DISTRIBUTION.md                          publish + install commands
```

## Docs

| file | what it covers |
|------|----------------|
| [`SKILL.md`](./skills/explainer-video-from-coursework/SKILL.md) | the contract of record — the agent's entry point |
| [`SKILL.md`](./skills/explainer-video-from-codebase/SKILL.md) (codebase) | the code-flow pipeline's contract of record |
| [`FLOWS.md`](./skills/explainer-video-from-codebase/FLOWS.md) | every code-flow artifact's fields, from the code map to the code panels |
| [`SETUP.md`](./skills/explainer-video-from-coursework/SETUP.md) | cited, per-OS machine prerequisites |
| [`ARCHITECTURE.md`](./skills/explainer-video-from-coursework/ARCHITECTURE.md) | how the pieces fit together |
| [`PIPELINE.md`](./skills/explainer-video-from-coursework/PIPELINE.md) | the stage-by-stage pipeline |
| [`ROADMAP.md`](./skills/explainer-video-from-coursework/ROADMAP.md) | design record and open work |
| [`DISTRIBUTION.md`](./DISTRIBUTION.md) | publishing, and installing on each platform |
| [`RELEASING.md`](./RELEASING.md) | how a release works — a dispatch, not a merge |

## License

MIT — see [`LICENSE`](./LICENSE).
