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
dsh plugin --profile web add explainer-video-from-coursework-dsh
```

**Antigravity**

```sh
agy plugin install https://github.com/akshayDev17/ai-explainer-video
```

Why four commands sit behind two npm packages — and how to publish — is in
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

Run every command from the **project** (where `out/` lives), not from the skill's
install folder. The tools self-locate their own `tools/`, `src/` and `scenes/`,
so only the work and scratch paths depend on the current directory.

## Repository layout

```
plugin.json                              Agent Plugins manifest (Codex, Antigravity)
.claude-plugin/                          plugin.json + marketplace.json (Claude Code)
.agents/plugins/                         marketplace.json (Codex)
skills/explainer-video-from-coursework/  the main skill: SKILL.md, tools/, src/, scenes/, SETUP.md
skills/craft-video-<stage>/              the 8 stage skills, separately invocable
dsh/                                     DSH bundle wrapper (a separate npm package; no skill files)
DISTRIBUTION.md                          publish + install commands
```

## Docs

| file | what it covers |
|------|----------------|
| [`SKILL.md`](./skills/explainer-video-from-coursework/SKILL.md) | the contract of record — the agent's entry point |
| [`SETUP.md`](./skills/explainer-video-from-coursework/SETUP.md) | cited, per-OS machine prerequisites |
| [`ARCHITECTURE.md`](./skills/explainer-video-from-coursework/ARCHITECTURE.md) | how the pieces fit together |
| [`PIPELINE.md`](./skills/explainer-video-from-coursework/PIPELINE.md) | the stage-by-stage pipeline |
| [`ROADMAP.md`](./skills/explainer-video-from-coursework/ROADMAP.md) | design record and open work |
| [`DISTRIBUTION.md`](./DISTRIBUTION.md) | publishing, and installing on each platform |
| [`RELEASING.md`](./RELEASING.md) | how a release works — a tag, not a command line |

## License

MIT — see [`LICENSE`](./LICENSE).
