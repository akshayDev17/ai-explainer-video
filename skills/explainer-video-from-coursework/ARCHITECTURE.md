# Architecture — who does what

The single rule this project is built on:

> **Code does what must be exact. The host agent does what requires judgment.
> Gemini is used for one thing only: text-to-speech.**

## Why

An LLM is already in the loop — it is the agent running this skill. Delegating
judgment to a *second* LLM via an API call is strictly worse:

- **Less context.** A fresh API call sees only the prompt we construct. The agent
  has the plan, the sources, the conversation, and the user's stated preferences.
- **More failure modes.** Rate limits, 503s, quota exhaustion, a second vendor, a
  key on disk. During development, an optional text adapter cost ~10 wasted API
  calls and three model fallbacks to do something the agent could do natively.
- **No reproducibility gain.** Judgment is not the part that needs to be
  deterministic — the *merge and validation* around it is, and that stays in code.

## Division of labour

| Stage | Owner | Network? |
|---|---|---|
| `planner.mjs` — parse, count, pack, assert coverage | **code** | none |
| enrichment — titles, forms, curation (skip / merge) | **agent** | none |
| `apply-enrichment.mjs` — merge + validate | **code** | none |
| script writing — narration, styles, beats | **agent** | none |
| audio — TTS | **code** | **Gemini TTS API** ← the only API call in the pipeline |
| publish config — chapter grouping, titles, blurb | **agent** | none |
| `publish.mjs` — resolve timecodes, emit chapters/captions, validate | **code** | none |
| `render.mjs` — Chromium frames, ffmpeg | **code** | none |

Everything except audio runs offline. The planner and the merge/validate step
require **no API key at all** — verified by running them with no key set.

## Why the determinism lives in code

The agent's output is *checked*, not trusted. `apply-enrichment.mjs` rejects
empty titles, `Part N` placeholders, ellipses, directory-slug titles
(`load-balancing`), duplicate titles, forms outside the enum, references to videos
that don't exist, and `skip`/`mergeInto` entries without a stated reason. That is
the same discipline as
`compare-shots.mjs` for the scene port and the coverage assertion in the planner:
**assert, don't assume.**

## The trap this rule avoids

A pipeline that reaches for an API whenever it needs "an LLM step" ends up with
two models, two quotas, two failure modes, and a reasoning step that is worse
than the agent it already had. If a stage needs judgment, the skill's `SKILL.md`
should say *what* to decide and let the host agent decide it — not shell out.

## If you ever genuinely need unattended batch runs

Running 40 topics overnight with no agent present is a real use case, and it is
the *only* justification for an API-backed enrichment step. If that need appears,
add it back deliberately — as a clearly separate adapter, not as the default path
— and accept the quota and context costs knowingly.
