---
name: explainer-video-from-codebase
description: Turn the major code flows of a codebase (Python, TypeScript / TSX, JavaScript, Go, C, C++, or a mix such as a Python backend with a TypeScript frontend) into a narrated explainer-video series. Mine the repo into a grouped code map, rank candidate flows as evidence, optionally trace the test suite in a sandbox, propose the series with a reason per flow for the user to approve, plan the videos under a 25-minute cap, then script, voice, animate (verified code panels and generated flow diagrams), publish, render and assemble each one. Use when the user wants explainer videos of how a codebase works.
---

# explainer-video-from-codebase — mine, propose, approve, plan, then the per-video stages

Turn a repo into a **video series about its code flows**. Stage 0 gathers the repo, the destination and the
scratch root. Stages 1–1c run once over the whole repo:

- code mines the repo and proposes one candidate flow per entry point, ranked as evidence;
- you propose the series, with a reason per flow;
- **the user approves the flow list**;
- code plans the videos in the coursework plan's shape.

Stages 2–8 are `explainer-video-from-coursework`'s own stages, run on that plan: retitle once, then per video
write the narration, synthesize the audio, author the visuals, generate the publishing metadata, render and
assemble. Three places differ for code. Stage 3 adds the code-video rules below, and stages 6–8 add a render and
a title rule. Stage 5 uses `craft-codeflow-scene`: code panels cut from the repo and diagrams generated from the
validated flows.

**Paths.** `<skill>` is this skill's folder and `<coursework>` is the sibling `../explainer-video-from-coursework`,
both resolved against this skill's folder. The tools self-locate everything else, so they run regardless of cwd.
The work paths (`out/`, `--out`, `--work`) resolve against the **current directory**, so run every command from
the **scratch root** that Stage 0 fixes. The scratch root is always **outside the repo**:
`mine`, `propose`, `rank` and `apply-flows` refuse to write inside it.

> **For maintainers — the dual-file rule.** This file is the **contract of record** for the whole pipeline and
> is deliberately monolithic, so a full run loads in one pass. Four stages also ship as their own sibling skill:
>
> - `craft-codeflow-mine`: stages 1 and 1t;
> - `craft-codeflow-flows`: stages 1b and 1b′;
> - `craft-codeflow-plan`: stage 1c;
> - `craft-codeflow-scene`: stage 5 for code videos.
>
> Each is a complete contract for its stage, top-level under `skills/` so any stage can be re-run alone.
> Stages 2–4b and 6–8 are the coursework `craft-video-<stage>` skills. Stages 2, 4 and 4b are unchanged for code;
> `craft-video-script` (stage 3) and `craft-video-publish`, `-render` and `-assemble` (stages 6–8) also carry this
> file's code-video rules for their stage, in a sync block that opens **Code-flow videos only**. Every
> `craft-codeflow-*` skill ends with a **Maintenance** note naming its section here. **If you change a stage, update
> both files.**
> `scripts/check-skill-sync.mjs` (CI) fails when they drift:
>
> - a Maintenance note names a section that does not exist;
> - a child and its sections here invoke different tools or flags;
> - a passage marked `<!-- sync:<id> -->` differs between the two files.
>
> Child skills reach the tools as `../explainer-video-from-codebase/tools/<tool>.mjs`. The field reference for
> every artifact is [`FLOWS.md`](./FLOWS.md).

## Prerequisites

- **Stages 0–1c and the stage 5 code tools need only Node ≥ 22.** The tree-sitter runtime and the seven grammars
  are vendored in `vendor/tree-sitter/`. There is no `npm install`, no network and no key.
- **Stage 1t** (opt-in) uses the repo's own toolchain (its interpreter or virtualenv, its installed jest or
  vitest, `go`, or `cc` + `make` + `gcov`) and the OS sandbox: `sandbox-exec` on macOS, `bwrap` on Linux. It
  never installs anything.
- **Stages 4–8 need the coursework pipeline's machine setup**: `ffmpeg` / `ffprobe`, the headless Chromium, and
  the **Gemini API key**, stored in the OS secret store (macOS Keychain · Linux `secret-tool` · Windows
  Credential Manager), never in env or a plaintext file. The commands and per-OS steps are in
  [`<coursework>/SETUP.md`](../explainer-video-from-coursework/SETUP.md).

**Relay rule.** The tools fail loud on a missing prerequisite: `[node] …`, `[setup] …`,
`Playwright cache not found …`, `No API key found …`. When one appears, do not debug the scene. Tell the user
what is missing and the install steps from the matching `SETUP.md` section, then re-run.

### Who owns what

- **Code** does what must be exact. It owns grouping, test links, candidate proposal, ranking, framework rules,
  config resolution and tracing (`craft-codeflow-mine` is their single owner). It also owns validation, the
  approval binding, planning, and cutting and verifying code panels.
- **You** do the judgment: the series proposal and its reasons (`craft-codeflow-flows` is the **only** place the
  series is decided and the only place the mined outputs are overridden), the narration and the scenes. Never edit
  a tool's output file. Change its input and re-run.
- **The user** decides three things: whether the test suite is traced (stage 1t), the flow list (stage 1b′), and
  which videos are made (scope).
- **Gemini** is used only at stages 4 and 4b, for speech and transcription.

### Secrets

- `mine` reads config only from git-tracked files. It keeps a value only for a key a dispatch guard reads, and
  writes a secret-looking key or a credential-shaped value as `set (redacted)` everywhere in `codemap.json` and
  `codemap.md`. Never look up, guess or narrate a redacted value.
- The trace runs with an empty environment, so no credentials reach it. It redacts credential-shaped strings
  from `trace.log`, the output tail it prints and the failure messages in `trace.json`.
- A code panel shows the file byte for byte. When a narrated line holds a credential (a hardcoded token, a URL
  with a password), leave that line out of `--lines` so it collapses into an elision marker. Never say the
  value aloud.
- The Gemini key stays in the OS secret store. `build-audio` prints the exact store command when it is missing.

### Series scope — the per-video loop

- **Stages 0–2 run once**; nothing before the scope choice iterates the video list.
- **Stages 3–8 repeat once per video**, each in its own work dir `out/<name>/<NN>/`. The coursework tools stamp
  a `.video-identity` marker into it and refuse a run whose `videoIndex` disagrees.
- **Videos are independent.** Give every concurrent `render` / `assemble` its own `--port`.
- **One video end to end is a valid stopping point** (a pilot, or a single-target run).

## The stages

| Stage | Name | Runs | Skill | Done when |
|---|---|---|---|---|
| 0 | `/inputs` | once | — | repo, destination and scratch root set; optional scope flags noted |
| 1 | `/mine` | once | `craft-codeflow-mine` | `mine`, `propose`, `rank` exit 0; `codemap.md` and `ranking.md` shown in full, every group |
| 1t | `/trace` (opt-in) | at most once per mined commit | `craft-codeflow-mine` | offered only within its boundary; a "no" skips it; on a yes, the run ended and its report was relayed |
| 1b | `/flows` | once | `craft-codeflow-flows` | `apply-flows` exits 0 |
| 1b′ | approve | once, again after any change | `craft-codeflow-flows` | the user said yes to the approval table as shown; `flows.approved.json` written |
| 1c | `/plan` | once | `craft-codeflow-plan` | `flow-plan` exits 0 (exit 5 without approval); every video shown with the calibration banner |
| 2 | `/enrich` | once | `craft-video-enrich` | `apply-enrichment` exits 0; the full list shown |
| scope | choose | once | — | the user chose the videos by index |
| 3 | `/script` | per video | `craft-video-script` (its code-flow block, the addendum below) | `script-check` exits 0 (pause rule included) |
| 4, 4b | `/audio`, `/align` | per video | `craft-video-audio`, `craft-video-align` | unchanged |
| 5 | `/scene` | per video | **`craft-codeflow-scene`** | `excerpt-check` and `pacing-check` exit 0; the stills looked at |
| 6–8 | `/publish`, `/render`, `/assemble` | per video | `craft-video-publish`, `-render`, `-assemble` (their code-flow block) | unchanged |

## Stage 0 — `/inputs`: repo, destination, scratch

Ask for what the user must decide. If the invocation already names them, skip the question. Ask **together, in
one prompt, with defaults**, so the user only adjusts and never invents:

- **Repo** — the root of the codebase. If they referenced a path, use it; otherwise ask for one.
- **Destination** — where the finished videos land. Default: `videos/` in the scratch root. Each video lands in
  its own `<destination>/<NN>-<slug>/` folder. Never put it inside the repo: the next mine would read it.
- **Scratch root** — the directory that holds `out/`, the cwd for every command from stage 1 on. Default: a new
  folder beside the repo, `<repo>/../<repo name>-videos/`. It must be outside the repo, since the tools refuse to
  write there. A series runs to hundreds of MB of WAV and MP4, so it is worth one line in the prompt. Say
  plainly that the default is fine.

Note, without asking unless the user raises them, the optional scope flags stage 1 takes:

- `--lang` to mine only some languages;
- `--exclude` for a vendored or generated tree;
- `--group 'glob=prod|test|eval|dev'` for a file the group rules misplace;
- `--config-root` for config kept outside the repo, such as a deploy repo's Helm values.

Then change to the scratch root once and stay there. Proceed to stage 1 only once all three are set.

## Stage 1 — `/mine`: code map, candidates, ranking

<!-- sync:mine -->
```sh
node <skill>/tools/mine.mjs <repo> --out out/<name> [--group 'glob=prod|test|eval|dev' ...] \
     [--exclude path,...] [--lang python,typescript,go,c,cpp] [--config-root <dir>]
```

It writes `out/<name>/codemap.json` and `out/<name>/codemap.md`. It never writes inside the repo, never uses the
network and never runs repo code.

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | a bad path or flag, `--out` inside the repo, or a repo with no supported files |
| 2 | a failed self-check: a definition the parser saw was not extracted, or two collapsed into one symbol |

On exit 2, report the failure and do not edit the output.

**What it mines.** Python, TypeScript / TSX, JavaScript, Go, C and C++ are mined into one code map;
`--lang typescript` covers JavaScript too. Across languages:

- a frontend's or a client's HTTP calls link to the routes they hit in any language (FastAPI, Express, Next.js,
  net/http, gin, echo, chi);
- UI routes, gRPC methods and C / C++ command tables are entries;
- each language's tests (pytest, unittest, jest / vitest, node:test, go test, gtest, Catch2, C test functions)
  are evidence.

**Groups.** Every file is in exactly one group, `prod`, `test`, `eval` or `dev`, by ordered path rules, then by
content. A `--group` override wins over all of them. An entry that lands in the test group is not a flow;
`codemap.md` prints the override that moves it.

**Show the user `codemap.md` in full:**

- every group, with the rule that placed each file;
- every entry;
- every rule link with its evidence, and the frameworks imported without a rule pack (their wiring is not
  linked);
- the test inventory with the mocks every test runs under (session-wide and autouse ones included);
- the config profiles with their group, and the config-selected dispatch;
- the self-check.

If the self-check reports calls into imports named like in-repo directories, ambiguous imports, or dependency
files it could not parse, say so: those calls are not linked.
<!-- /sync:mine -->

<!-- sync:propose-rank -->
```sh
node <skill>/tools/propose.mjs --codemap out/<name>/codemap.json [--fanin 6] [--leafy 5] [--no-iface-fold]
node <skill>/tools/rank.mjs --candidates out/<name>/candidates.json [--explain-top 10] [--explain-top-eval 5]
```

`propose` writes `out/<name>/candidates.json`: one candidate flow per prod, eval and dev entry, and how far each
test's direct links reach. A non-test walk never enters test code. An eval or dev walk folds production code
into `uses-prod` leaves and records the production flows it `exercises`. Exit 2 means an entry could not be
walked; report it.

`rank` writes `ranking.json` and `ranking.md`, each group ranked on its own by the new code each row covers.
**Show the user `ranking.md` in full**:

- every row of every group, with what each eval row exercises;
- the dev rows, filtered by default;
- the shared heavily-tested table, the continuations and the merged order;
- the explained top rows.

There is no cut line. Do not present the top rows as the series, and do not drop a row because its gain is small.
Choosing the series is stage 1b.

**Done when:** `mine`, `propose` and `rank` all exit 0, the self-check is clean, and `codemap.md` and
`ranking.md` have been shown in full: every group, nothing sampled.
<!-- /sync:propose-rank -->

## Stage 1t — `/trace`: the test suite, observed (opt-in)

<!-- sync:trace-offer -->
Tracing runs the repo's own test code on this machine, so it is **never** run without the user's explicit yes.
Nothing but the test suite is ever traced: not a server, a sample request or an eval harness. Offer it at most
once per mined commit, and only when both of these hold.

**The repo has a test command you can name**, plus the arguments its own config or docs use:

- **Python:** `pytest`, `python -m pytest` or `python -m unittest`, run with the repo's own interpreter (its
  `.venv/bin/python` when it has one).
- **JavaScript / TypeScript:** `node --test`, `npx jest` or `npx vitest run`.
  - The runner must already be installed in the repo's `node_modules`, at its root or in the one package below
    it that holds the tests, such as `frontend/`. Paths are then given as you would from that package.
  - A jest or vitest flag's value is written as `-t=name` or `-t name`. Any other flag is boolean, so a path
    after it stays a path.
- **Go:** `go test ./...`, or `go -C <module dir> test ./...` when the repo holds several Go modules, with the
  `go` on PATH.
- **C / C++:** `make test` or `make check` (or `make -C <dir> test`), when the repo's Makefile builds and runs its
  tests with `$(CC)` / `$(CXX)`, and `cc`, `make` and `gcov` are installed.

**This platform has a sandbox**: macOS (`sandbox-exec`), or Linux with `bwrap` (bubblewrap). Elsewhere, do not
offer it.
<!-- /sync:trace-offer -->

Ask with exactly this text, filling in the command and the test count from `codemap.md`:

<!-- sync:trace-prompt -->
> This repo has a test suite (`<command>`, N tests). I can run it once, under a profiler, to mark which call paths
> the tests actually exercise. It runs the repo's test code on this machine, inside a sandbox, on a copy of the files
> git does not ignore: no network, no writes outside a scratch folder, no inherited environment variables, no
> handing work to a program outside the sandbox (opening a URL or an app, scripting another app), and no reads of your home folder or the original repo folder (only the copy, the Python interpreter and its virtualenv, node and the repo's node_modules, or, for Go, exactly the two folders `go env` names as GOROOT and GOMODCACHE, read-only, even inside your home folder; never anything else of it). It
> can still read system files outside those folders. Anything it prints that looks like a credential is redacted from
> its log. Run it?
<!-- /sync:trace-prompt -->

<!-- sync:trace-run -->
A "no" skips the stage with no penalty: stage 1b works from the static code map alone. **Only on a yes** to that
exact command:

```sh
node <skill>/tools/trace.mjs --codemap out/<name>/codemap.json --test-command "<command>" --i-ran-this-by-the-user \
     [--timeout 900]
```

`--i-ran-this-by-the-user` means the user said yes. Never pass it otherwise; a different command needs a new yes.

The run is held to this boundary:

- it runs in a scratch copy of the repo's git-tracked and unignored files, inside this platform's sandbox;
- it has no network of any kind, localhost and unix sockets included;
- it writes nothing outside scratch;
- no program outside the sandbox acts for it;
- it reads neither the home folder nor the original repo;
- it starts with an empty environment;
- it writes no bytecode or cache;
- it stops at a time limit.

There is no option to weaken or skip the sandbox, and no sandbox means no run.

It writes `out/<name>/trace.json` and `trace.log`, the run's output with credential-shaped strings redacted.
`trace.json` is an overlay recording the opt-in (who, when, the exact command). The code map is never edited for
it, and no static edge is ever removed or demoted.

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | refused: no opt-in flag, bad flags or inputs, a jest / vitest the repo has not installed, two JS packages holding tests, several Go modules and no `-C`, a GOROOT or GOMODCACHE that is or holds the home folder, no Makefile, no gcov |
| 2 | no test ran: show the user `trace.log`'s end |
| 3 | refused: not a recognised test command (shell syntax and wrappers such as `uv run` or `env` included) |
| 4 | refused: no sandbox on this platform, or it does not start here |
| 5 | the time limit: the partial trace is kept and marked `timedOut` |

Report a refusal and never work around it, least of all by running the tests yourself.

Tell the user:

- the outcome (passed / failed / errors) and the static edges observed;
- the share of direct test links that ran under their own test. jest / vitest, go test and make record coverage,
  so they say what ran in each test file, test or test binary (the trace's `granularity`) and record no
  caller → callee pair;
- the callback links the trace confirmed, and the calls that ran with no static edge;
- **every test in `deniedBySandbox`**. Those tests need a service or a file the sandbox refused (a database, a
  socket, the network, a file in the home folder or one git ignores), so they mark code the suite cannot
  exercise offline.

Failing tests are data: never retry one, never weaken the sandbox, never install anything to make them pass. A
trace says what ran under the test configuration. Narrate it as "observed in the test suite", never as observed
in production.

**Done when:** the user declined, or the run ended (exit 0 or 5) and its report has been relayed, or a refusal
has been reported.
<!-- /sync:trace-run -->

## Stage 1b — `/flows`: the series proposal

<!-- sync:flows-rules -->
You propose the series in `out/<name>/flows.json` (fields in [`FLOWS.md`](./FLOWS.md)), from every row of
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
node <skill>/tools/apply-flows.mjs --candidates out/<name>/candidates.json --flows out/<name>/flows.json
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
node <skill>/tools/approve-flows.mjs --flows out/<name>/flows.validated.json --by user --note "<the user's words>"
```

It writes `flows.approved.json`, bound to the validated list's sha256. Exit 2 means the validated list is
missing, did not pass, or `flows.json` changed since it was validated: rerun `apply-flows`.

On any edit, change `flows.json`, rerun `apply-flows`, show the new table, and ask again. The old approval no
longer matches, and stage 1c refuses until there is a new one.

**Done when:** the user said yes to the table as shown and `approve-flows` exited 0.
<!-- /sync:approve -->

## Stage 1c — `/plan`: videos under the cap

<!-- sync:plan -->
```sh
node <skill>/tools/flow-plan.mjs --flows out/<name>/flows.validated.json [--max-min 25] [--estimate] [--force]
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

## Stage 2 — `/enrich`: retitle the plan

Run `craft-video-enrich` on `out/<name>/plan.json` unchanged:

```sh
node <coursework>/tools/apply-enrichment.mjs --plan out/<name>/plan.json --enrichment out/<name>/enrichment.json
```

- **Forms.** `form` is one of the plan's own `forms`: `overview`, `flow` or `core`.
- **Titles.** The plan's titles are placeholders. Title each video from its hops' code and the series reason
  (`formWhy`), for a human scrolling YouTube.
- **Skip and merge.** A `skip` or `mergeInto` here changes the series the user approved, so ask before making
  one. To drop a whole flow, go back to stage 1b instead.

**Done when:** `apply-enrichment` exits 0 and the complete enriched list has been shown to the user.

## Choose the scope — after `/enrich`, before `/script`

**Ask the user which videos to run through stages 3–8; never assume "all of them".** Present every video (index
and title), then ask for all, or a subset by index (`3`, `2, 4`, `1-3, 6`). TTS and rendering are the expensive
stages, so never spend them on a video the user has not chosen.

## Timing — every stage 3–8 is stamped

Bracket every per-video stage with a stamp pair, as in the coursework skill. The `end` stamp is part of each
stage's done-when:

```sh
node <coursework>/tools/stamp.mjs begin --out out/<name> --video <NN> --stage <n>
node <coursework>/tools/stamp.mjs end   --out out/<name> --video <NN> --stage <n>
node <coursework>/tools/timing-report.mjs --out out/<name>
```

`timing-report` groups the videos by flow (the plan's `group`). Render it at series end, and at a flow boundary
during a long run.

## Stage 3 — `/script`: the code-video addendum

Write `out/<name>/scripts/<NN>-<slug>.json` and validate it with `craft-video-script`. Copy `videoIndex`,
`title`, `form`, `sources` and `artefacts` from the enriched plan's video. `planTargetMinutes` is its
`minutes`, and `covers` names its `sections` exactly.

```sh
node <coursework>/tools/script-check.mjs --script out/<name>/scripts/<NN>-*.json --plan out/<name>/plan.enriched.json
```

<!-- sync:stage3-addendum -->
**Code-flow videos only.** A code-flow video's plan, `plan.json` or `plan.enriched.json`, carries
`"kind": "codebase"`, and its `forms` are `overview`, `flow` and `core`. A coursework plan has no `kind`; nothing
in this block applies to its videos.

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

**Done when:** `script-check` exits 0 (`✓ script is valid`, the pause rule included).

## Stages 4 and 4b — `/audio` and `/align`

Run `craft-video-audio` (`build-audio.mjs`, the only stage that spends the Gemini TTS key), then
`craft-video-align` (`align.mjs`, one transcription request per video). Both are unchanged for code videos.
Stage 5 needs `lines.json` from 4b, since every focus window is timed from it.

## Stage 5 — `/scene` for code videos: verified code and generated diagrams

```sh
node <coursework>/tools/stamp.mjs begin --out out/<name> --video <NN> --stage 5
```

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
node <skill>/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> [--lines 54-65,70]
node <skill>/tools/excerpt.mjs --codemap out/<name>/codemap.json --symbol <id> --test <test id> [--lines 54-65,70]
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
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --as map [--flow <id>]
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as sequence
node <skill>/tools/flow-diagram.mjs --flows out/<name>/flows.validated.json --flow <id> --as exercises
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
node <coursework>/tools/resolve-beats.mjs --work out/<name>/<NN> --script out/<name>/scripts/<NN>-*.json
node <coursework>/tools/pacing-check.mjs --scene out/<name>/<NN>/scenes/<key>.js \
     --timeline out/<name>/<NN>/timeline.json --segment <key>
node <skill>/tools/excerpt-check.mjs --work out/<name>/<NN> --repo <repo> --script out/<name>/scripts/<NN>-*.json
node <coursework>/tools/render.mjs --shots <t1>,<t2>,<t3> --work out/<name>/<NN> --scene "src/scene-code.html?scene=<key>"
```

`--shots` takes seconds of video time, and a code scene's acts are timed from its segment's window, so a still
outside that window shows nothing of the scene. Pick the shot times inside `timeline.json`'s `windows["<key>"]`: a
few seconds after its `start`, its middle, and just before its `end`.

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

```sh
node <coursework>/tools/stamp.mjs end --out out/<name> --video <NN> --stage 5
```

## Stages 6–8 — `/publish`, `/render`, `/assemble`

Run `craft-video-publish`, `craft-video-render` and `craft-video-assemble`, each with its code-flow block:

<!-- sync:codeflow-publish-render -->
**Code-flow videos only.** A code-flow video's plan, `plan.json` or `plan.enriched.json`, carries
`"kind": "codebase"`, and its `forms` are `overview`, `flow` and `core`. A coursework plan has no `kind`; nothing
in this block applies to its videos. A code-flow video adds these rules at stages 6–8:

- **Render.** A code segment renders through `src/scene-code.html?scene=<key>`. Pass `--work out/<name>/<NN>` so
  the host reads that video's `timeline.js`; `assemble` passes it for every segment.
- **Chapters.** Write each chapter title from that chapter's narration, as for any video.
- **Upload title.** The `youtubeTitle` names the flow in the viewer's terms, such as what a request does or what
  a command runs. Never use a module path.
<!-- /sync:codeflow-publish-render -->

**Done when:** each stage's own gate holds, ending in `assemble`'s `[done] …<output>.mp4` with `audio ok`, and
the assembled frames have been looked at.

## Reference

Every artifact's fields are in [`FLOWS.md`](./FLOWS.md):

- `codemap.json`, `candidates.json`, `ranking.json`, `trace.json`;
- `flows.json`, `flows.validated.json`, `flows.approved.json`;
- `plan.json`;
- the panel fragment, `excerpt-check`'s rules, and the diagram skeletons.

The worked fixtures are synthetic code in `skills/explainer-video-from-codebase/fixtures/` of the source
repository, https://github.com/akshayDev17/ai-explainer-video, only; the installed package does not include them:

- `fixtures/flows/repo/`, a small lending library with tests and an eval harness;
- `fixtures/flows/flows.json`, its series proposal;
- `fixtures/polyglot/`, a Python backend with a TypeScript frontend, a Go service and a C library.

The enrichment, script and publish formats are in the coursework skill's reference sections.
