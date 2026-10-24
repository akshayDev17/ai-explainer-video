---
name: craft-video-publish
description: Generate the upload title, YouTube chapters and English captions for one finished video. Stage 6 of explainer-video-from-coursework.
---

# craft-video-publish — title, chapters and captions

> Part of the `explainer-video-from-coursework` pipeline — **stage 6 of 8**.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 6
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 6
> ```

**Prerequisites:** `out/<name>/<NN>/timeline.json` and `narration/<key>.src` — both
final once the scene stage exits.

The agent writes `out/<name>/<NN>/publish.json` — a `youtubeTitle`, a chapter list
(`segments` keys + `title`) and a `blurb`. The tool resolves timecodes, validates, and
emits **three files** into the video's own folder, `--dest/<NN>-<slug>/`: `title.txt`
(one line, what YouTube shows), `description.md` (the blurb, then the chapter block,
paste-ready plain text) and `captions.srt`. The folder name is derived from the script's
`videoIndex` + title — do not pick it by hand.

- **Title** — `title.txt` is the upload title, and it is also the file `upload_yt_video`
  reads out of that folder, so a missing one is an incomplete upload. It is *not* the
  same thing as the video's `title`: that one is structural (set at stage 2, it names the
  folder and must not move); this one is written here because only now does the video
  exist to be described honestly. Keep it a real search phrase — the subject someone
  would type — and never promise what the video does not deliver: retention past the
  first seconds is measured, and a hook the video does not pay off is the one thing that
  gets actively suppressed.

- **Chapters** — `M:SS Title`, start-time only, one per segment by default; grouping is
  two keys in one list, and a chapter's time is the first segment's window start.
  Titles are authored from the narration — never the scene `stageNames` (uppercase,
  one missing, near-duplicate pairs).
- **Captions** — one cue per segment, text from `narration/<key>.src` (the exact text
  the WAV was built from — the audio is the truth, not `script.json`).
- **Hard checks** — first timecode `0:00` · ≥3 chapters · each ≥10s · ascending · every
  segment key resolves · titles ≤40 chars, not duplicated/near-duplicated · cues
  ascend and don't overlap · `youtubeTitle` ≤100 chars, one line.
- **Soft checks** (warnings, not failures) — title past ~70 chars (mobile truncation) ·
  all-uppercase · stacked `!!`/`??` · a near-duplicate of a sibling video's title, which
  buries a series' own parts. The tool can police the shape of a title, never its
  appeal; that judgement stays yours.

**Chapters need channel eligibility.** They are a YouTube advanced feature: a channel that
has not qualified for advanced-feature eligibility renders **no** chapters, however valid
the list — its timestamps still work as jump-to-section links, but the segmented progress
bar and Google key moments do not appear. Nothing in `description.md` affects this, so
absent chapters are not a formatting fault: `0:00` (one digit), a `-` after the timecode, a
blurb above the block and a 2:39 runtime were each verified live on eligible channels, and
the hard checks above already mirror YouTube's rules.

**Done when:** `publish` exits 0 and both files land in `--dest/<NN>-<slug>/` beside the MP4.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 6 — /publish"** section must be
> reconciled to match, and name that section in your reply.
