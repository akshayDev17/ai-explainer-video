---
name: explainer-video-from-codebase
description: Under construction — will turn the major code flows of a codebase into a narrated explainer-video series. Today its first stages exist: mining a Python repo into a code map (files grouped as prod/test/eval/dev, call graph, entry points, framework links, tests as evidence, config facts), proposing one candidate flow per entry point and ranking them per group as evidence, an opt-in sandboxed trace of the repo's own test suite (Python), validating the agent's series proposal (flows.json), recording the user's approval of the flow list, planning the videos in the coursework plan's shape, and the on-screen code tools for a code video's scenes (verified code panels, test panels, diagram skeletons). Use only when the user asks to mine a codebase, rank its candidate flows, propose and plan a code-flow series, or cut code panels for its scenes.
---

# explainer-video-from-codebase — under construction

The sibling of `explainer-video-from-coursework` for codebases: code proposes candidate
flows per entry point, the agent proposes the series with a reason per flow, the user
approves the flow list, and a coursework-shaped plan feeds the same per-video stages 3–8.
It is being built one milestone at a time; **the tools for stages 1 to 1c exist so far** (mine, propose, rank;
the opt-in trace; apply-flows, approve-flows, flow-plan), plus the on-screen code tools stage 5 will use (excerpt, excerpt-check,
flow-diagram). The code-video scene stage and its skill do not exist yet, so do not promise a video from this
skill yet.

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

Python and TypeScript / JavaScript are mined (into one code map: a frontend's HTTP calls link to the backend routes
they hit, and its UI routes are entries); Go, C and C++ are grouped and listed as "not mined yet".

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

## Stage 1t — `/trace`: the test suite, observed (opt-in)

Tracing runs the repo's own test code on this machine, so it is **never** run without the user's explicit yes, and
nothing but the test suite is ever traced: not a server, a sample request or an eval harness. Offer it at most once
per mined commit, and only when both hold:

- the repo has a test command you can name: `pytest`, `python -m pytest` or `python -m unittest`, run with the repo's
  own interpreter (its `.venv/bin/python` when it has one); or `node --test`, `npx jest` or `npx vitest run`, with the
  runner installed in the repo's `node_modules` (tracing never installs one); plus the arguments its own config or docs
  use;
- this platform has a sandbox: macOS (`sandbox-exec`) or Linux with `bwrap` (bubblewrap). Elsewhere, do not offer it.

Ask with exactly this text, filling in the command and the test count from `codemap.md`:

> This repo has a test suite (`<command>`, N tests). I can run it once, under a profiler, to mark which call paths
> the tests actually exercise. It runs the repo's test code on this machine, inside a sandbox, on a copy of the files
> git does not ignore: no network, no writes outside a scratch folder, no inherited environment variables, no
> handing work to a program outside the sandbox (opening a URL or an app, scripting another app), and no reads of your home folder or the original repo folder (only the copy, the Python interpreter and its virtualenv, or node and the repo's node_modules). It
> can still read system files outside those folders. Anything it prints that looks like a credential is redacted from
> its log. Run it?

A "no" skips the stage with no penalty. **Only on a yes** to that exact command:

```sh
node <skill>/tools/trace.mjs --codemap out/<name>/codemap.json --test-command "<command>" --i-ran-this-by-the-user \
     [--timeout 900]
```

The flag means the user said yes; never pass it otherwise, and a different command needs a new yes. The run happens
in a scratch copy inside this platform's sandbox: no network of any kind (localhost and unix sockets included), no
writes outside scratch, no program outside the sandbox acting for it, no reads of the home folder or the original
repo, an empty environment, no bytecode or cache
writes, a time limit. It writes `out/<name>/trace.json`, an overlay the code map is never edited for, and
`trace.log`, the run's output (credential-shaped strings redacted). Exit 0 is done; 5 is the time limit (the partial
trace is kept and marked); 1, 3 and 4 are refusals (no opt-in flag; not a test command; no sandbox): report them and
never work around one, least of all by running the tests yourself. Exit 2 means no test ran: show the user
`trace.log`'s end.

Tell the user the outcome (passed / failed / errors), the static edges observed, the share of direct test links that
ran under their own test, the callback links it confirmed, the calls that ran with no static edge, and **every test in
`deniedBySandbox`**: those need a service or a file the sandbox refused (a database, a socket, the network, a file
in the home folder or one git ignores), so they mark code the suite cannot exercise offline. Failing tests are data:
never retry one, never weaken the sandbox, never install anything to make them pass. A trace says what ran under the test configuration; narrate it as "observed in the test
suite", never as observed in production.

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

## Stages 3 and 5 for code videos — on-screen code (the tools that exist)

Narration is the reading time: a code panel shows only the lines being narrated, each highlighted while its
sentence plays, and every other line of the hop collapses into an elision marker.

**Stage 3 addendum.** Narrate every line a panel will show, one hop per segment. Only a block that must be read
whole gets a pause prompt: the segment's text says "pause" out loud, it carries `"pause": {"dwell": <s>}` with
0 < dwell ≤ 2 and the same `pad`, and a video has at most 3. `script-check` errors on a fourth: split the video.

**Code panels.** Never type code into a scene; cut every panel from the repo as mined:

```sh
node <skill>/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> [--lines 54-65,70]
node <skill>/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> --test <test id>
```

It prints the panel fragment (`file`, `lang`, `lines`, `numbers`, `elided`, `source`) to paste into a `code`
scene's `panels`. `--lines` picks the narrated lines (a hop's `lines` in the plan); over 22 shown lines exits 2:
narrow them or split the hop. `--test` cuts the test's side of a "pinned by" pair (its def line, the line that
calls the hop, its assertion lines); it exits 2 for a test that mocks the hop or only reaches it. Give each panel
one `focus` act per sentence that names the narration line it is synced to (`"narration": <line>` or
`[from, to]`, indices into the segment's lines in `lines.json`), starting at that line's onset; a pause segment
also gets a `pause` act over its spoken prompt (the on-screen badge).

```sh
node <skill>/tools/excerpt-check.mjs --work out/<name>/<NN> --repo <repo> --script out/<name>/scripts/<NN>-*.json
```

Stage 5 is not done until it exits 0. Exit 2 is drift: a panel that is not byte-identical to the file as mined
(or was typed, or hides lines without a marker); re-excerpt it. Exit 3 is a shown line outside every
narration-synced focus window (outside the ≤ 3 pause segments), or a pause badge out of place.

**Diagram skeletons.** The boxes and arrows come from the validated flows, the layout and beats from you:

```sh
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --as map [--flow <id>]
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as sequence
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as exercises
```

`map` is a `diagram` host config (the overview's system map); `sequence` is the params of the `svg` lane's
`SceneCore.primitives.sequence` (clear the stage at the top of `renderAt`); `exercises` draws an eval or dev
flow's hand-off to the production flow it drives as one box naming that flow's video ("see video 8"), never
re-narrated.

The fields of every artifact are described in [`FLOWS.md`](./FLOWS.md).
