---
name: craft-video-publish
description: Generate YouTube chapters and English captions for one finished video. Stage 6 of explainer-video-from-coursework.
---

# craft-video-publish — chapters and captions

> Part of the `explainer-video-from-coursework` pipeline — **stage 6 of 8**.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **project**, so `out/` scratch lands beside your notes.

**Prerequisites:** `out/<name>/<NN>/timeline.json` and `narration/<key>.src` — both
final once the scene stage exits.

The agent writes `out/<name>/<NN>/publish.json` — a chapter list (`segments` keys +
`title`) and a `blurb`. The tool resolves timecodes, validates, and emits **two files**
to `--dest`: `description.md` (the blurb, then the chapter block, paste-ready plain
text) and `captions.srt`.

- **Chapters** — `M:SS Title`, start-time only, one per segment by default; grouping is
  two keys in one list, and a chapter's time is the first segment's window start.
  Titles are authored from the narration — never the scene `stageNames` (uppercase,
  one missing, near-duplicate pairs).
- **Captions** — one cue per segment, text from `narration/<key>.src` (the exact text
  the WAV was built from — the audio is the truth, not `script.json`).
- **Hard checks** — first timecode `0:00` · ≥3 chapters · each ≥10s · ascending · every
  segment key resolves · titles ≤40 chars, not duplicated/near-duplicated · cues
  ascend and don't overlap.

**Chapters need channel eligibility.** They are a YouTube advanced feature: a channel that
has not qualified for advanced-feature eligibility renders **no** chapters, however valid
the list — its timestamps still work as jump-to-section links, but the segmented progress
bar and Google key moments do not appear. Nothing in `description.md` affects this, so
absent chapters are not a formatting fault: `0:00` (one digit), a `-` after the timecode, a
blurb above the block and a 2:39 runtime were each verified live on eligible channels, and
the hard checks above already mirror YouTube's rules.

**Done when:** `publish` exits 0 and both files land beside the MP4.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 6 — /publish"** section must be
> reconciled to match, and name that section in your reply.
