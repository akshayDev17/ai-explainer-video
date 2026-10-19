---
name: craft-video-align
description: Measure per-word and per-line timings for one video's narration, so scene beats can be anchored to the words they illustrate. Stage 4b of explainer-video-from-coursework.
---

# craft-video-align — word and line timings

> Part of the `explainer-video-from-coursework` pipeline — **stage 4b of 8**, between
> audio (4) and scene (5).
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 4b
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 4b
> ```

**Prerequisites:** `out/<name>/<NN>/narration/<key>.wav` and `timeline.json` — both
final once the audio stage exits.

```bash
node ../explainer-video-from-coursework/tools/align.mjs --script out/<name>/scripts/<NN>-*.json \
                        --work out/<name>/<NN>
```

## Why this stage exists

The audio stage measures each **segment**. Everything *inside* a segment was left to
guesswork, and a guess is where sync dies: on the module-07 pilot the "April" reveal
fired at 6.6s while the words "In April" begin at 12.6s — a 6-second error that every
check passed, because no check could see the narration's shape.

This stage measures the narration's shape. It emits the span of every **line**
(sentence) of the script, in audio time, so the scene stage can bind a beat to a line
instead of inventing a number.

## What it does

Transcribe the **whole narration track in one request** with `gemini-3.5-transcribe`
(requesting `wordTimestamp`), cut the returned words into segments using the measured
`timeline.json` boundaries, align each segment's words back onto that segment's script
words, then compute each line's span from the aligned words.

**Why one request, not one per segment.** The model is capped at **100 requests/day
per project per model**, the Batch API is not supported for it, and the cap is per
project — so it cannot be spread across keys. Per-segment alignment spent ~30 requests
on a 13-minute video (≈3 videos/day); a whole-track pass spends **one**.

The model allows 30 minutes per request *when word timestamps are enabled*, so a track
longer than that is cut at **segment boundaries** into multiple passes (never
mid-sentence). `--per-segment` keeps the old path as a fallback, and is chosen
automatically when only a few segments are missing. Already-cached segments are never
re-requested, so a full pass only fills what is absent and cannot overwrite good
measurements with worse ones.

On HTTP 429 the run **exits 3** rather than falling back — a daily-cap failure would
fail identically for every segment, so cascading would just burn the run.

**The alignment step is not optional.** The transcriber is not a faithful echo — it
rewrites punctuation and applies inverse text normalisation. Measured on real
narration it returned "In March, it pushes…" (inserted comma), "spends **40** minutes"
(we wrote *forty*), "**failed**" (we wrote *fail*), and merged two sentences into one.
So the transcript never decides a boundary: **our punctuation decides boundaries, the
aligned words supply times.**

**Word offsets can contain outliers.** One plan returned "A delta" at 3.7s in a
sentence whose neighbours were at 12.4s and 14.2s. Offsets are forced monotonic and
non-overlapping (`clampMonotonic`), which pulls an early outlier to the end of the
previous word — within a word or two of the truth. Repairs are reported.

## Outputs

- `narration/<key>.words.json` — per segment: every word with its offsets, the script
  index it maps to, and a cache stamp (wav size+mtime, text hash). Re-runs are free
  until the audio or the script text changes.
- `lines.json` — per video: for every segment, each line's `{ line, text, start, end }`
  plus `lead` and the window bounds.

**Line times are relative to the narration WAV.** A scene renders in window time,
which starts `lead` seconds earlier, so the conversion is:

```
beat time (scene) = line.start + lead
```

`lines.json` records `lead` per segment so nothing has to assume 0.6.

## Done when

`align` exits **0** and prints `✓ N segment(s) · M lines · written`. Any error means a
line could not be placed in the audio (usually a garbled transcript) — re-run with
`--force` for that segment, and if it persists treat the segment's narration as the
thing to fix.

Two things to watch in the report:

- **`only NN% of script words aligned`** — below `--min-match` (default 0.8) the
  transcript probably diverged; the line spans may still be right, but check them.
- **`NN word offset(s) came back out of order and were clamped`** — expected
  occasionally; a large number suggests the audio and the script text disagree.

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 4b — /align"** section must be
> reconciled to match, and name that section in your reply.
