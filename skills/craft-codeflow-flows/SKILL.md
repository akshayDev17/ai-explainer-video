---
name: craft-codeflow-flows
description: Propose a code-flow video series with a reason per flow (flows.json) from a ranked code map, validate it until every high-ranked row, entry, segment, hop and cited test is accounted for, then show the user the approval table and record their explicit yes. Stages 1b and 1b′ of explainer-video-from-codebase, and the only place the series is decided.
---

# craft-codeflow-flows — the series proposal, then the user's approval

> Part of the `explainer-video-from-codebase` pipeline: **stages 1b and 1b′**. This is the judgment stage and
> the **only** place the series is decided. It is also the only place the mined outputs are overridden: by
> declaring a link, promoting a dev row, or excluding an entry with a reason. Self-contained: it works on an
> existing mine. For a full run, use the main skill instead.
>
> The tools live in the sibling `explainer-video-from-codebase` skill. Run them as
> `node ../explainer-video-from-codebase/tools/<tool>.mjs`, resolved against this skill's folder, from the
> **scratch root**, outside the repo.

**Prerequisites:**

- `out/<name>/codemap.json`, `candidates.json` and `ranking.json` / `ranking.md`, from `craft-codeflow-mine`;
- the repo itself, to read the code;
- `out/<name>/trace.json`, when the user opted into the trace.

## Stage 1b — the series proposal

<!-- sync:flows-rules -->
You propose the series in `out/<name>/flows.json` (fields in [`FLOWS.md`](../explainer-video-from-codebase/FLOWS.md)), from every row of
`ranking.md`, the candidates you consider, the code, and `trace.json` when stage 1t ran. Each video has to teach
something, so choose flows that tell distinct stories. The ranking is evidence, not a series. Follow these rules.

**Account for every row.**

- Every series flow and core gets a one-line `why`. So does every **high-ranked** row you do not include: include
  it, list it as a variant, or skip it with a reason.
  - High-ranked means the top 10 production rows, the top 5 eval rows, and every row at or above the
    lowest-ranked row you include. The floor is the ranking's `--explain-top` / `--explain-top-eval` when those
    are larger; a smaller value never lowers it.
  - A glob never explains a high-ranked row.
- Every other entry is triaged: a flow, a continuation of one, a variant, skipped, or excluded with a reason
  (globs allowed). Eval rows are never implicit. Dev rows stay filtered unless promoted with a reason.
- Every segment of a kept candidate is kept, mentioned with a `say`, or excluded with a `why`.

**Hops.**

- Hops are a subset of the candidate's code, in teaching order, each connected to the hops before it.
- A config alternative that no profile selects is taught (`teach`, naming its selector), not narrated, unless an
  `outOfRepo` claim's `selects` names it.
- Declare a link only where no rule fires, with `file:line` evidence.
- Shared code with no entry of its own (auth, retries, a fee rule) is a `core`, which a hop hands over to with
  `uses`.
- `break` on a hop starts a new video.

**Tests.**

- Cite a test on a hop only where the test has a direct link to it and does not mock it. Narration may call a hop
  "tested" or "pinned" only for such a citation.
- A test that only reaches the hop is cited with `"strength": "reachable"` and is never called tested.
- Check `codemap.md`'s mocks first: a target every test in scope runs mocked is never tested.

**Eval flows.** An eval flow names the production flow it drives with `exercises` instead of re-narrating it.

Reasons (`why`, `say`, `claim`) are at least three words and never a placeholder (`tbd`, `todo`, `…`).
<!-- /sync:flows-rules -->

<!-- sync:flows-validate -->
```sh
node ../explainer-video-from-codebase/tools/apply-flows.mjs --candidates out/<name>/candidates.json --flows out/<name>/flows.json
```

It reads `codemap.json` and `ranking.json` beside the candidates, and the trace when one is there.

- **Exit 0** writes `flows.validated.json` and `flows.md`.
- **Exit 2** lists every problem in `flows.md` and on stderr, and removes a stale `flows.validated.json`. The
  checks are reasons, C1′ high-ranked rows, C1 entry triage, C2 segment triage, C3 hop fidelity, dispatch,
  C3′ test fidelity, groups and shape. Fix `flows.json` and rerun until it exits 0.
- **Exit 1** is a bad flag, unreadable or mismatched inputs, or an output inside the repo.

Never edit `flows.validated.json` or `flows.md`.

**Done when:** `apply-flows` exits 0 with `0 problems`: reasons on every series item and every high-ranked skip,
every entry triaged, every hop connected, and every cited test pinning its hop.
<!-- /sync:flows-validate -->

## Stage 1b′ — approve the flow list

<!-- sync:approve -->
Show the user the **approval table** at the top of `flows.md` in full:

- the series in video order, with each reason;
- the skipped rows with theirs;
- the variants, the promoted rows and the dev rows;
- the estimated videos and minutes.

Ask them to approve it or to edit it (add, drop, reorder, promote); never assume approval. **Never write
`flows.approved.json` without the user's explicit yes to the table as shown.** Silence, "looks interesting" or an
approval of an earlier table is not a yes. **Only on that yes:**

```sh
node ../explainer-video-from-codebase/tools/approve-flows.mjs --flows out/<name>/flows.validated.json --by user --note "<the user's words>"
```

It writes `flows.approved.json`, bound to the validated list's sha256. Exit 2 means the validated list is
missing, did not pass, or `flows.json` changed since it was validated: rerun `apply-flows`.

On any edit, change `flows.json`, rerun `apply-flows`, show the new table, and ask again. The old approval no
longer matches, and stage 1c refuses until there is a new one.

**Done when:** the user said yes to the table as shown and `approve-flows` exited 0.
<!-- /sync:approve -->

**Next:** `craft-codeflow-plan` plans the approved list.

## Maintenance

> If you modify this file, or the user asks to change these stages, tell the user that the main
> `explainer-video-from-codebase` skill's **"Stage 1b — /flows"** and **"Stage 1b′ — approve the flow list"**
> sections must be reconciled to match, and name those sections in your reply.
