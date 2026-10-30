---
name: craft-codeflow-mine
description: Mine a codebase (Python, TypeScript / TSX, JavaScript, Go, C, C++, or a mix such as a Python backend with a TypeScript frontend) into one grouped code map, propose one candidate flow per entry point and rank them per group as evidence; and, only on the user's explicit yes, trace the repo's own test suite once inside an OS sandbox. Stages 1 and 1t of explainer-video-from-codebase; run it alone to mine or re-mine a repo.
---

# craft-codeflow-mine — mine, propose, rank; the opt-in trace

> Part of the `explainer-video-from-codebase` pipeline: **stages 1 and 1t**, the first of its once-per-series
> stages. This skill is self-contained: it mines a repo from scratch. For a full run, use the main skill instead.
>
> The tools live in the sibling `explainer-video-from-codebase` skill. Run them as
> `node ../explainer-video-from-codebase/tools/<tool>.mjs`, resolved against this skill's folder. Run them from
> the **scratch root**, the directory that holds `out/`. It is always **outside the repo**: every tool here
> refuses to write inside it.

**Prerequisites:**

- Node ≥ 22, and nothing else for stage 1. The tree-sitter runtime and grammars are vendored, so there is no
  `npm install`, no network and no key.
- A repo root and a scratch root outside it.
- Stage 1t also uses the repo's own toolchain and the OS sandbox, and never installs anything.

**What you own here.** Grouping, test links, candidate proposal, ranking, framework rules, config resolution and
tracing are code, and this skill is their single owner. Run the tools and never edit their outputs. The only
place their outputs are overridden, and the only place the series is chosen, is `craft-codeflow-flows`.

**Secrets.**

- `mine` reads config only from git-tracked files and keeps a value only for a key a dispatch guard reads. It
  writes a secret-looking key or a credential-shaped value as `set (redacted)`. Never look one up or guess it.
- The trace runs with an empty environment and redacts credential-shaped strings from its log, the output tail
  it prints and its failure messages.

## Stage 1 — mine, propose, rank

<!-- sync:mine -->
```sh
node ../explainer-video-from-codebase/tools/mine.mjs <repo> --out out/<name> [--group 'glob=prod|test|eval|dev' ...] \
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
node ../explainer-video-from-codebase/tools/propose.mjs --codemap out/<name>/codemap.json [--fanin 6] [--leafy 5] [--no-iface-fold]
node ../explainer-video-from-codebase/tools/rank.mjs --candidates out/<name>/candidates.json [--explain-top 10] [--explain-top-eval 5]
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

## Stage 1t — the test suite, observed (opt-in)

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
node ../explainer-video-from-codebase/tools/trace.mjs --codemap out/<name>/codemap.json --test-command "<command>" --i-ran-this-by-the-user \
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

**Next:** `craft-codeflow-flows` proposes the series from `ranking.md`, the candidates and, when it was made,
`trace.json`.

## Maintenance

> If you modify this file, or the user asks to change these stages, tell the user that the main
> `explainer-video-from-codebase` skill's **"Stage 1 — /mine"** and **"Stage 1t — /trace"** sections must be
> reconciled to match, and name those sections in your reply.
