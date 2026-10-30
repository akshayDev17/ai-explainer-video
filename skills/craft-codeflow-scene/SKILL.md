---
name: craft-codeflow-scene
description: Author one code video's visuals — code panels cut from the repo as mined (never typed), test panels for cited tests, one narration-synced focus window per sentence, pause badges only on pause segments, and flow diagrams generated from the validated flows — then verify every panel against the repo with excerpt-check. Stage 5 of explainer-video-from-codebase; craft-video-scene's contract plus the code rules.
---

# craft-codeflow-scene — verified code and generated diagrams

> Part of the `explainer-video-from-codebase` pipeline: **stage 5, for code videos**. It is
> `craft-video-scene`'s full contract (beats anchored to narration lines, the over-ask ladder, the visual
> check) plus the rules that put a repo's code on screen. Self-contained for one video's scenes. For a full run,
> use the main skill instead.
>
> The code tools live in the sibling `explainer-video-from-codebase` skill and the scene tools and hosts in
> `explainer-video-from-coursework`. Run them as `node ../explainer-video-from-codebase/tools/<tool>.mjs` and
> `node ../explainer-video-from-coursework/tools/<tool>.mjs`, resolved against this skill's folder, from the
> **scratch root** that holds `out/`.

> **Timing.** Bracket the stage with the stamp pair; `end` must run before the stage counts as done:
>
> ```bash
> node ../explainer-video-from-coursework/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 5
> node ../explainer-video-from-coursework/tools/stamp.mjs end   --out out/<name> --video <NN> --stage 5
> ```

**Also needed:** the headless Chromium, for the stills. A `Playwright cache not found` failure means Chromium is
absent. Relay the step from `../explainer-video-from-coursework/SETUP.md` to the user, then re-run.

**The script this stage assumes.** The scenes show only what the narration reads, so the video's script must
already follow the code-video rules. `script-check` enforces the pause rule; you enforce the rest:

<!-- sync:stage3-addendum -->
A code video's narration is the reading time: a panel shows only the lines being narrated, each highlighted while
its sentence plays. The script for a code video adds these rules:

- **Open** on the concrete request, UI action or command that starts the flow.
- **One hop per segment.** Name identifiers in words; spoken text holds no code, no URLs and no markdown.
- **Narrate every line a panel will show**: the hop's narrated lines (`sectionSpans[].lines` in the plan, or the
  lines you choose when that is `null`, at most 22), plus a cited test's def, call and assertion lines.
- **Branches.** Teach each `teach` branch in its own segment, naming its selector: the setting, flag or profile
  that picks it.
- **Tests.** Describe a cited test by what it asserts. Call a hop "tested" or "pinned" only for a direct, unmocked
  link, never for a `"strength": "reachable"` citation. For a traced run say "observed in the test suite", never
  "in production".
- **Evals.** An eval hop that drives a production flow names that flow's video instead of re-narrating it.
- **Pause prompts** are rare and bounded, only for a block that must be read whole.
  - The segment's text says "pause" out loud.
  - It carries `"pause": {"dwell": <s>}`, with 0 < dwell ≤ 2 and `pad` equal to the dwell.
  - A video has at most 3. `script-check` errors on a fourth, so split the video instead.
- **Secrets.** Never say a secret or a redacted value.
<!-- /sync:stage3-addendum -->

## The scenes

<!-- sync:code-scene -->
`craft-video-scene`'s whole contract holds:

- beats anchor to narration lines, never to seconds;
- `resolve-beats` passes before `pacing-check`;
- a shortfall means the scene over-asked: widen the beat's `lines` first, redesign it second, `pad` last;
- the stills are looked at.

Code videos add what follows. **Prerequisites:** `out/<name>/<NN>/timeline.json` and `lines.json` (stages 4 and
4b), the video's script, `out/<name>/codemap.json`, `flows.validated.json` and `plan.json`.

**Hosts, per segment** (`out/<name>/<NN>/manifest.json`, `key` → `{host, scene}`):

- a hop or test segment is a `code` scene (`src/scene-code.html`);
- the overview's system map, a flow's sequence and an eval's hand-off are `diagram` or `svg` scenes.

Each scene lives at `out/<name>/<NN>/scenes/<key>.js` and sets `window.SCENE_CONFIG`. Like any scene, it also
declares `window.SCENE_BEATS`, one beat per narration line, which is what `resolve-beats` and `pacing-check`
read.

**Code panels.** Never type code into a scene; cut every panel from the repo as mined:

```sh
node ../explainer-video-from-codebase/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> [--lines 54-65,70]
node ../explainer-video-from-codebase/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> --test <test id> [--lines 54-65,70]
```

It prints the panel fragment (`file`, `lang`, `lines`, `numbers`, `elided`, `source`) to paste whole into the
scene's `panels`, with an `id` added.

- `--lines` picks the narrated lines: the hop's `lines` in the plan, or, when that is `null`, the lines the script
  narrates. Every unshown run inside the span becomes one `⋯ N lines` marker. Without `--lines` the whole span is
  shown.
- **Exit 2** covers more than 22 shown lines (narrow `--lines` or split the hop), a missing symbol or test, a line
  outside the span, and a file changed since it was mined (mine again).
- `--test` cuts the test's side of a "pinned by" pair: its def line, the line that calls the hop, and its
  assertion lines. It exits 2 for a test that mocks the hop or only reaches it. For a cited test, show the hop's
  panel and the test's panel together.

**The panel's acts.**

- **Focus.** Give each panel one `focus` act per sentence, `{op: "focus", panel, lines, from, to, narration}`.
  - `lines` are 1-based panel lines.
  - `narration` is the narration line it is synced to: an index, or `[from, to]`, into the segment's lines in
    `lines.json`.
  - `from` is that line's onset (`start + lead`), and `to` falls between the line's end and the next line's onset.
  - Every shown non-blank line is in some focus window.
- **Pause.** A pause segment gets a `{op: "pause", from, to}` act over its spoken prompt: the on-screen badge. Only
  a pause segment gets one.
- **Segment.** Every code scene names its own segment, `segment: "<key>"`, equal to its manifest key. Its acts are
  timed from that segment's window, and it draws no progress bar.
- **Taught branches.** A `teach` branch's segment shows each alternative as its own excerpted panel, placed side
  by side with `initLayout` / `layout` acts, and the narration names the selector.

**Diagram skeletons.** The boxes and arrows come from the validated flows; the layout polish and the beats come
from you:

```sh
node ../explainer-video-from-codebase/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --as map [--flow <id>]
node ../explainer-video-from-codebase/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as sequence
node ../explainer-video-from-codebase/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as exercises
```

- `map` is a `diagram` host config: one box per module the hops run through, with the queue, HTTP and spawn
  crossings for banners. It is the overview's system map.
- `sequence` is the params of the `svg` lane's `SceneCore.primitives.sequence`; clear the stage at the top of
  `renderAt`.
- `exercises` draws an eval or dev flow's hand-off to each production flow it drives as one box naming that flow's
  video ("see video 8"). The production flow is never re-drawn.
- Exit 1 is an unknown flow, or `exercises` on a flow with no `exercises` hop.

**Secrets.** Leave a line that holds a credential out of `--lines`, so it shows only as an elision marker.

**Check, then look.** Resolve the beats, check the pacing, verify the panels, then render stills and look at
them:

```sh
node ../explainer-video-from-coursework/tools/resolve-beats.mjs --work out/<name>/<NN> --script out/<name>/scripts/<NN>-*.json
node ../explainer-video-from-coursework/tools/pacing-check.mjs --scene out/<name>/<NN>/scenes/<key>.js \
     --timeline out/<name>/<NN>/timeline.json --segment <key>
node ../explainer-video-from-codebase/tools/excerpt-check.mjs --work out/<name>/<NN> --repo <repo> --script out/<name>/scripts/<NN>-*.json
node ../explainer-video-from-coursework/tools/render.mjs --shots 6,20,34 --work out/<name>/<NN> --scene "src/scene-code.html?scene=<key>"
```

`excerpt-check` is C6:

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | no manifest, scenes, `lines.json` or script |
| 2 | drift: a panel that is not byte-identical to the file as mined, was typed, or hides lines without a marker; re-excerpt it |
| 3 | a shown line outside every narration-synced focus window, a pause badge out of place, more than 3 pause segments, or a code scene that does not name its own segment |

The checkers catch timing and structure, never a visual fault. **Vision gate:** read the first still as an image.
If that fails, you are on a text-only model: ask the user whether to switch to a vision model or to skip the visual
check. Never "look" blind.

**Done when:** `resolve-beats`, `pacing-check` (each scene) and `excerpt-check` exit 0, and every still has been
looked at, or the user skipped the visual check.
<!-- /sync:code-scene -->

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the main
> `explainer-video-from-codebase` skill's **"Stage 5 — /scene for code videos"** section must be reconciled to
> match, and so must the `explainer-video-from-coursework` skill's **"Stage 5 — /scene"** section wherever the
> shared scene contract changed. Name those sections in your reply.
