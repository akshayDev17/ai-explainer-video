---
name: explainer-video-from-codebase
description: Under construction — will turn the major code flows of a codebase into a narrated explainer-video series. Today its first stages exist: mining a Python repo into a code map (files grouped as prod/test/eval/dev, call graph, entry points, framework links, tests as evidence, config facts), proposing one candidate flow per entry point and ranking them per group as evidence, validating the agent's series proposal (flows.json), recording the user's approval of the flow list, and planning the videos in the coursework plan's shape. Use only when the user asks to mine a codebase, rank its candidate flows, or propose and plan a code-flow series.
---

# explainer-video-from-codebase — under construction

The sibling of `explainer-video-from-coursework` for codebases: code proposes candidate
flows per entry point, the agent proposes the series with a reason per flow, the user
approves the flow list, and a coursework-shaped plan feeds the same per-video stages 3–8.
It is being built one milestone at a time; **the tools for stages 1 to 1c exist so far** (mine, propose, rank;
apply-flows, approve-flows, flow-plan). On-screen code for code videos does not exist yet, so do not promise a
video from this skill yet.

## Stage 1 — `/mine` (the part that exists)

### Mine

Resolve `tools/mine.mjs` against this skill's folder; run it from the scratch root, never
inside the repo being mined (the tool refuses to write there):

```sh
node <skill>/tools/mine.mjs <repo> --out out/<name> [--group 'glob=prod|test|eval|dev' ...] \
     [--exclude path,...] [--config-root <dir>]
```

It writes `out/<name>/codemap.json` and `out/<name>/codemap.md`. Exit 0 is done; exit 1 is
a bad path or flag, or a repo with no Python; exit 2 is a failed self-check (a definition
the parser saw was not extracted, or two collapsed into one symbol) — report it, do not edit the output. Show the user
`codemap.md` in full: every group with the rule that placed each file, every entry, every
rule link with its evidence, the mocks every test runs under, config profiles, and any
entry that landed in the test group (suggest the `--group` override it prints).

Config facts come only from git-tracked files; a value is kept only for a key a dispatch
guard reads, and a secret-looking key or value is shown as `set (redacted)`. If the
self-check reports calls into imports named like in-repo directories, say so: those
calls are not linked.

Only Python is mined; other languages are grouped and listed as "not mined yet".

### Propose and rank

```sh
node <skill>/tools/propose.mjs --codemap out/<name>/codemap.json [--fanin 6] [--leafy 5] [--no-iface-fold]
node <skill>/tools/rank.mjs --candidates out/<name>/candidates.json [--explain-top 10] [--explain-top-eval 5]
```

`propose` writes `out/<name>/candidates.json`: one candidate flow per prod, eval and dev entry, with how far each
test's direct links reach. Exit 2 means an entry could not be walked; report it. `rank` writes `ranking.json` and
`ranking.md`. Show the user `ranking.md` in full: every row of every group, the shared heavily-tested table, the
continuations and the merged order. There is no cut line: do not present the top rows as the series, and do not
drop a row because its gain is small. Choosing the series is stage 1b.

## Stage 1b — `/flows`: the series proposal

You propose the series in `out/<name>/flows.json` (fields in [`FLOWS.md`](./FLOWS.md)), from every row of
`ranking.md`, the candidates you consider, and the code:

- every series flow and core gets a one-line `why`, and so does every **high-ranked** row you do not include (the
  top 10 production and top 5 eval rows, plus every row at or above the lowest-ranked row you include): include
  it, list it as a variant, or skip it with a reason. A glob never explains a high-ranked row;
- every other entry is triaged (a flow, a continuation of one, a variant, skipped, or excluded with a reason;
  globs allowed); eval rows are never implicit; dev rows stay filtered unless promoted with a reason;
- every segment of a kept candidate is kept, mentioned with a `say`, or excluded with a `why`;
- hops are a subset of the candidate's code in teaching order; a config alternative no profile selects is taught,
  not narrated (or named by an `outOfRepo` claim's `selects`); declare a link only where no rule fires;
- cite a test on a hop only where it has a direct link and does not mock the hop. Narration may call a hop
  "tested" or "pinned" only for such a citation; a test that only reaches the hop is cited with
  `"strength": "reachable"` and is never called tested;
- an eval flow names the production flow it drives with `exercises` instead of re-narrating it.

```sh
node <skill>/tools/apply-flows.mjs --candidates out/<name>/candidates.json --flows out/<name>/flows.json
```

Exit 0 writes `flows.validated.json` and `flows.md`; exit 2 lists every problem in `flows.md` and on stderr:
fix `flows.json` and rerun until it exits 0. Never edit `flows.validated.json`.

## Stage 1b′ — approve the flow list

Show the user the **approval table** at the top of `flows.md` in full: the series with each reason, the skipped
rows with theirs, the variants, the dev rows, and the estimated videos and minutes. Ask them to approve it or to
edit it (add, drop, reorder, promote); never assume approval. **Only on an explicit yes** to the table as shown:

```sh
node <skill>/tools/approve-flows.mjs --flows out/<name>/flows.validated.json --by user --note "<the user's words>"
```

It writes `flows.approved.json`, bound to the validated list's sha256. After any edit, rerun `apply-flows` and ask
again: the old approval no longer matches.

## Stage 1c — `/plan`

```sh
node <skill>/tools/flow-plan.mjs --flows out/<name>/flows.validated.json [--max-min 25] [--estimate] [--force]
```

It writes `plan.json` and `plan.md` beside the validated flows: an overview video, then each series flow and core
in order, split under the cap (25 minutes by default) at `break` hops, else at the latest crossing. Exit 5 means
no matching approval (none, or the list changed after it): go back to stage 1b′, never work around it. Exit 2 is
an orphaned hop or a video over the cap; exit 4 would overwrite the plan an enriched plan was built from (rerun
with `--force`, then rerun apply-enrichment). Show the user every planned video with the plan's "uncalibrated"
banner. `--estimate` prints the plan without an approval and writes nothing.

The plan has the coursework plan's shape: `craft-video-enrich` (apply-enrichment reads the plan's `forms`:
overview, flow, core) and the per-video stages run on it. A script's `covers` names its video's `sections`
(`"<file> :: <symbol> @L<start>"`).

The fields of every artifact are described in [`FLOWS.md`](./FLOWS.md).
