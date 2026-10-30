---
name: craft-codeflow-plan
description: Turn an approved, validated code-flow list into an explainer-video plan in the coursework plan's shape (an overview, then each flow and core, split under a 25-minute cap), refusing an unapproved or stale list. Stage 1c of explainer-video-from-codebase; run it alone to re-plan an approved list.
---

# craft-codeflow-plan — plan the videos under the cap

> Part of the `explainer-video-from-codebase` pipeline: **stage 1c**, the last stage that is specific to code.
> Self-contained: it plans an approved list. For a full run, use the main skill instead.
>
> The tools live in the sibling `explainer-video-from-codebase` skill. Run them as
> `node ../explainer-video-from-codebase/tools/<tool>.mjs`, resolved against this skill's folder, from the
> **scratch root**, outside the repo.

**Prerequisites:** these files, from `craft-codeflow-flows`, both in the same folder:

- `out/<name>/flows.validated.json`;
- `out/<name>/flows.approved.json`, written only after the user said yes.

<!-- sync:plan -->
```sh
node ../explainer-video-from-codebase/tools/flow-plan.mjs --flows out/<name>/flows.validated.json [--max-min 25] [--estimate] [--force]
```

It writes `plan.json` and `plan.md` beside the validated flows: an overview video first, then each series flow
and core in order. A `break` hop starts a new video. Hops pack under the cap (25 minutes by default), and an item
that overflows splits at its latest crossing, else at the overflowing hop. A hop is never split, and two items
are never glued.

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | a bad flag or unreadable input |
| 2 | an orphaned hop or a video over the cap (C4: every kept hop lands in exactly one video) |
| 4 | the run would overwrite the plan an enriched plan was built from: rerun with `--force`, then rerun stage 2 |
| 5 | no matching approval (none, or the list changed after it): go back to stage 1b′, never work around it |

No plan, and so no script, exists before the user approves the list. `--estimate` prints the plan without an
approval and writes nothing; it is the estimate in the approval table, not a plan.

**`--max-min` is part of the plan.** Video indices are keyed by the split, so a different cap gives different
videos and invalidates any enrichment written for the old ones. Keep 25 unless the user asks otherwise.

The plan has the coursework plan's shape, so the coursework stages read it unchanged:

- `forms` is `overview`, `flow` and `core`;
- each video's `group` is its flow or core id, which `timing-report` groups by;
- `sections` are `"<file> :: <symbol> @L<start>"`, what a script's `covers` names;
- `sectionSpans` carry each hop's span, narrated lines and cited tests.

**Done when:** `flow-plan` exits 0, and every planned video has been shown to the user with the plan's
calibration banner, which says what the cost model is calibrated on and what is still uncalibrated. Show the index,
title, form and minutes of every video, with no sample and no "…and N more". The minutes are a planning
estimate, not measured audio.
<!-- /sync:plan -->

**Next:** run the coursework stages on `out/<name>/plan.json`, starting with `craft-video-enrich`. Its `form`
is one of the plan's `forms`: `overview`, `flow` or `core`. After the user chooses the scope, run
`craft-video-script` with the code-video addendum (in the main skill and in `craft-codeflow-scene`).

## Maintenance

> If you modify this file, or the user asks to change this stage, tell the user that the main
> `explainer-video-from-codebase` skill's **"Stage 1c — /plan"** section must be reconciled to match, and name
> that section in your reply.
