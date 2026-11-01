---
name: craft-video-thumbnail
description: Design the upload thumbnail for one video — a mildly tacky, attractive 1280x720 PNG with one clear hook over a still from the video's own scenes and, for a series, a "<playlist name>-Part X, <title>" label. Stage 6b of explainer-video-from-coursework.
---

# craft-video-thumbnail — the upload thumbnail

> Part of the `explainer-video-from-coursework` pipeline — **stage 6b of 8**, between
> publish (6) and render (7). It needs the final upload title (`title.txt`, from stage 6)
> and the stage-5 scenes, but not the finished MP4, so it runs before the expensive render.
>
> The pipeline's tools and scene hosts live in the sibling `explainer-video-from-coursework` skill: run them as `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder. Run from the **scratch root** — the directory holding `out/`, which Stage 0 fixes (default: beside your notes) — so every `out/<name>/…` path in this stage resolves.

> **Timing.** Bracket the stage with the stamp pair so the series accrues a per-video audit;
> `end` must run before the stage counts as done (see *Timing* in the main skill):
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 6b
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 6b
> ```

**Prerequisites:** `--dest/<NN>-<slug>/title.txt` (stage 6), the video's stage-5 scenes and
`manifest.json`, `out/<name>/plan.enriched.json`, and the Stage 0 playlist answer; on the
machine, headless Chromium (see `SETUP.md`) and `ffmpeg` for the phone-size preview.

> A `headless Chromium not found` / `Playwright cache not found` failure means Chromium is
> absent — relay the `SETUP.md` step to the user and re-run.

The output is `--dest/<NN>-<slug>/thumbnail.png`, beside `title.txt`: a 1280x720 PNG of at
most 2,000,000 bytes, exactly what `upload_yt_video` picks up. The upload takes
`thumbnail.png`, `.jpg` or `.jpeg` from the video's folder, PNG or JPG only, refuses a file
over 2 MB and ignores `thumbnail.svg`. It is rendered from an HTML template by the
pipeline's own headless Chromium, never by a paid image-generation API.

### The brief

A viewer reads the thumbnail and the title together, in a fraction of a second, usually at
phone size. Every thumbnail follows the owner's brief:

- **Mildly tacky, attractive.** Loud on purpose: fat outlined type, a hard drop shadow, one
  bright accent, a tilted sticker. But one hook and one visual, nothing else competing:
  tacky is the energy, not clutter.
- **One clear hook.** At most 5 big words (32 characters) that make a viewer want the
  answer: a tension, a surprise, a stake ("The bug nobody catches", "Your data is lying").
  It **complements the upload title and never repeats it**: the title says what the video
  is, the hook says why it is worth the click. Highlight the one word that carries the
  punch. Never promise what the video does not deliver, the same rule as the title.
- **High contrast.** White type with a black stroke over a darkened wedge, and one accent
  colour (default yellow `#FFD400`) picked to stand out against the still, not to match it.
- **A strong visual from the video itself.** A still rendered from one of this video's own
  stage-5 scenes, at the beat that shows the idea at its most dramatic (the failure, the
  reveal, the before and after), cropped with `focus` so its subject sits clear of the hook.
  Never stock art, never a logo on its own.
- **Readable at small mobile size.** If the hook cannot be read in the 320x180 preview, it
  is too long: cut words.

### The series label

When the video belongs to a series or an intended playlist, a band across the top reads
**`<playlist name>-Part X, <title>`**: the first link of chronology a new viewer sees.

- **The playlist name comes only from the user**: the Stage 0 answer. Never guess it, never
  default it, never derive it from the notes or the repo. A blank Stage 0 answer means a
  standalone video: pass `--standalone`, and there is no label.
- **Unset for a series means ask.** With neither `--playlist` nor `--standalone`, a plan of
  more than one video exits **3**. Ask the user whether the series is published as a
  playlist and under what name, then re-run with `--playlist "<name>"` or `--standalone`.
- **Part X** is computed by the tool: the video's 1-based position in
  `plan.enriched.json`'s `videos` list, its index after curation's skips and merges. It is
  not the raw `videoIndex`, which keeps the gaps curation left.
- **The title** is the final upload title, read from `title.txt`.

### Pick the still

Choose the beat from the scenes you authored at stage 5, then render that instant:

```bash
node ../explainer-video-from-coursework/tools/render.mjs --shots <t> --work out/<name>/<NN> \
     --scene "src/scene-diagram.html?scene=<name>" --shot-dir out/<name>/<NN>/thumbnail
```

`--shots` takes seconds of video time; pick one inside the segment's window in
`timeline.json`. Use the segment's own host (`scene-diagram`, `scene-svg` or `scene-code`).

### Write `thumbnail.json`

Write `out/<name>/<NN>/thumbnail.json`:

```json
{
  "hook": "The bug nobody catches",
  "highlight": "nobody",
  "still": "thumbnail/t000042.png",
  "focus": { "x": 0.7, "y": 0.45, "zoom": 1.3 },
  "accent": "#FFD400",
  "badge": "8 MIN"
}
```

- `hook` (required) — at most 5 words and 32 characters; it must not repeat the upload title.
- `highlight` (optional) — a word of the hook, or a list of them, drawn in the accent colour.
- `still` (required) — the PNG from the step above, relative to the work dir.
- `focus` (optional) — the still's point to keep in view, `x` and `y` as fractions (0–1),
  and a `zoom` of 1–4. The hook sits on the left, so frame the subject to the right.
- `accent` (optional) — a hex colour for the highlight, the label band, the badge and the bar.
- `badge` (optional) — a short tilted sticker, 1–16 characters ("8 MIN", "FIXED").

### Render and check

```bash
node ../explainer-video-from-coursework/tools/thumbnail.mjs --work out/<name>/<NN> \
     --script out/<name>/scripts/<NN>-*.json --plan out/<name>/plan.enriched.json \
     --dest <destination> [--playlist "<name>" | --standalone]
```

It validates `thumbnail.json`, adds the series label, photographs `src/thumbnail.html` at
1280x720, checks the PNG and copies it into `--dest/<NN>-<slug>/`. It also writes
`out/<name>/<NN>/thumbnail.small.png`, a 320x180 copy for the phone-size look. It costs no
TTS and takes about a second, so iterate freely.

| Exit | Meaning |
|---|---|
| 0 | written: `thumbnail.png` in the work dir and in `--dest/<NN>-<slug>/` |
| 1 | a missing input or prerequisite: no `thumbnail.json`, no `title.txt` (run `/publish` first), a video not in the enriched plan, no Chromium |
| 2 | a check failed: the hook, the still, the crop, or the PNG (not 1280x720, not a PNG, over 2,000,000 bytes) |
| 3 | a series with no playlist decision: ask the user, never invent a name |

`--check <file>` re-validates any thumbnail on its own (dimensions, format, size), such as
one the user edited by hand:

```bash
node ../explainer-video-from-coursework/tools/thumbnail.mjs --check <destination>/<NN>-<slug>/thumbnail.png
```

### Look at it

The tool checks the shape of the thumbnail, never its appeal. **Vision gate:** read
`thumbnail.png` as an image. If that fails, you are on a text-only model: ask the user
whether to switch to a vision model or to skip the visual check. Never "look" blind.

Read both `thumbnail.png` and `thumbnail.small.png`, and check:

- the hook reads in the small copy, and the highlighted word is the punch;
- the hook does not cover the still's subject (move `focus`, or pick another still);
- the label, when there is one, is whole and names the right part and title;
- nothing is clipped at an edge, and the accent stands out against the still;
- it is loud and a little tacky, and still one idea, not a collage.

**Done when:** `thumbnail` exits 0, `thumbnail.png` sits in `--dest/<NN>-<slug>/` beside
`title.txt`, and both PNGs have been looked at, or the user skipped the visual check.

<!-- sync:codeflow-thumbnail -->
**Code-flow videos only.** A code-flow video's plan, `plan.json` or `plan.enriched.json`, carries
`"kind": "codebase"`, and its `forms` are `overview`, `flow` and `core`. A coursework plan has no `kind`; nothing
in this block applies to its videos. A code-flow video adds these rules at stage 6b:

- **Hook.** Name the flow in the viewer's terms, such as what a request does, what breaks or what a command runs
  ("One click, three services"). Never use a module path, a file name or an identifier: `thumbnail` refuses a hook
  word with a `/`, `::`, `()`, `_`, a file extension or camelCase.
- **Still.** Take it from a diagram beat (the overview's system map, a flow's sequence, an eval's hand-off), never
  from a code panel: a wall of code is unreadable texture at thumbnail size.
- **Secrets.** Never put a secret or a redacted value on the thumbnail.
<!-- /sync:codeflow-thumbnail -->

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the
> main `explainer-video-from-coursework` skill's **"Stage 6b — /thumbnail"** section must be
> reconciled to match, and name that section in your reply.
