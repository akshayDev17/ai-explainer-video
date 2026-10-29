# FLOWS.md — reference for the code-flow artifacts

This file grows with the skill. Today it describes the stage 1 artifacts: `codemap.json`, written
by `tools/mine.mjs`, with its readable twin `codemap.md`; `candidates.json`, written from it by
`tools/propose.mjs`; and `ranking.json` and `ranking.md`, written from that by `tools/rank.mjs` (each schema 1).

`mine`, `propose` and `rank` are pure functions of their input and the tool versions: they never write
inside the repo, never use the network and never run repo code. Two runs over the same input produce
byte-identical output (timings go to stdout only).

## Top level

| Field | What it holds |
|---|---|
| `schema`, `tool.versions` | `1`; the vendored tree-sitter runtime and grammar versions |
| `root`, `commit`, `treeHash` | the mined directory, its `git HEAD` (or `null`), a sha256 over every mined and config file |
| `languages`, `unsupported` | Python files and parse errors; files of other languages, by extension (grouped, not mined yet) |
| `groups` | the ordered group rules, the `--group` overrides, and file / symbol / entry counts per group |
| `files[]` | every source file: `path`, `group`, the `rule` that placed it, `lang`, `sha256`, `parseError?`, `unsupported?` |
| `symbols[]` | `id`, `group`, `kind` (`function`, `method`, `class`, `main`), `file`, `start`, `end`, `name`, `module`, `cls`, `decos`, `params`, `async?`, `sha256` of its source span |
| `classes[]` | `id`, resolved `bases`, raw `baseExprs`, `methods` (name → symbol id), `decos` |
| `edges[]`, `entries[]` | below |
| `tests[]`, `fixtures[]`, `fixtureBindings[]`, `mocks[]`, `testSummary` | below |
| `rules` | per-pack records: Depends links, queue producers, registry tables (with dropped constructors), Haystack pipelines, HTTP client calls (linked or not), spawns, callback count |
| `dispatchSites[]`, `factories` | every narrowed or CHA dispatch point; every function that can return two or more classes, with branch guards |
| `config` | git-tracked config files (`group`, `reader`, fact count), the number of `untracked` ones not read, and `notGitWorkTree` (the mined or `--config-root` directories outside a git work tree, whose config is not read at all), settings fields and properties, every fact (`key`, `file:line`, and `value` only for a key a dispatch guard reads), profiles and classified dispatch sites (below) |
| `frameworksWithoutPack[]` | known frameworks the repo imports that no rule pack covers: their wiring is not linked |
| `selfCheck` | below |

Symbol ids: `pkg.module:func`, `pkg.module:Class.method`, `pkg.module:Outer.Inner` for a nested class,
`…:outer.<locals>.inner` for a function or class defined in a function, `pkg.module:<main>`
for an `if __name__ == "__main__":` block. Modules are named from the repo root (`backend/app/x.py` is
`backend.app.x`). An absolute import resolves to the module of that name at the repo root; else, for a file in a
directory with no `__init__.py`, to a module beside it; else through a package root: a file's package root is the
top of the contiguous run of ancestor directories holding an `__init__.py`, and its dotted name there is that run
plus the file, so with `backend/app/__init__.py` (and no `backend/__init__.py`) `from app.x import f` finds
`backend/app/x.py`; the longest claimed prefix carries the rest (`app.api.routes` when `api/` has no `__init__.py`).
When several roots claim a name, the one holding the importing file wins; otherwise the name stays external. A
claim under a root that does not hold the importing file resolves across roots, unless the repo declares the
top-level name as a dependency (requirements*.txt, pyproject.toml `[project]` / Poetry dependencies, setup.cfg
`install_requires` / `extras_require`, Pipfile; case, `-` and `_` normalised): `integrations/stripe/` never
captures a declared `stripe`. A top-level name of the standard library never
resolves to an in-repo loose module, namespace directory or nested package (`app/logging/` never captures
`import logging`); only a repo-root package `logging/__init__.py` shadows it. `selfCheck.packageRoots` lists the
package roots below the repo root. A call made at module level has `from: pkg.module:<module>`.
A library target is `ext:<dotted.name>`.

## Groups

Every file is in exactly one group. Ordered path rules, first match wins: **test** (a `tests/`,
`test/` or `__tests__/` dir; `test_*.py`, `*_test.py`, `conftest.py`) → **dev** by file name
(`debug_*`, `diagnose_*`, `*migration_controller*`, `dev.py`) → **eval** (`evals/`, `eval/`, `*_evals/`,
`evals_*/`, `evaluation(s)/`, `benchmark(s)/`, `bench/`) → **dev** by directory (`migrations/`, `alembic/`,
`dev_setup/`, `dev/`, `scripts/`, `verification/`, `debug/`) → **prod**. A file the path rules leave in prod
is moved by content: it imports pytest/unittest and defines tests → test; it imports an eval framework
(ragas, deepeval, promptfoo, lm_eval, inspect_ai, mteb, beir, trulens, langsmith `evaluate`) or has
training-loop markers → eval. `--group 'glob=group'` always wins.

## Entries

`kind` ∈ `http` (`method`, `path` with every `include_router` prefix up the chain and the router's own; only a
decorator whose receiver is an `APIRouter` or `FastAPI` app makes one), `queue-consumer` / `scheduled` (`key`),
`cli`, `main`, `registered-callback` (`via`, e.g. `FastAPI(lifespan=…)`). Each carries `group`, `file`,
`line` and the `rule` that made it. An entry in the test group is not a flow; `codemap.md` suggests the
override that moves it.

## Edges

`{ from, to, kind, line, … }`. Kinds: `static`, `ctor` (to the class and its `__init__`), `virtual` (a
subclass override reachable by CHA), `dispatch` (one of several narrowed targets), `framework`, `queue`,
`http`, `spawn`. Optional fields:

| Field | Meaning |
|---|---|
| `rule` | the pack that produced it: `fastapi.Depends`, `taskiq.literal-key`, `taskiq.kiq` / `.delay` / `.apply_async`, `registry`, `haystack.pipeline`, `py.http-client`, `process-spawn`, `pytest.fixture[.autouse]`, `py.callback`; `evidence` says why, with `file:line` |
| `groups` | `[fromGroup, toGroup]` when the edge crosses groups (labelled, never cut) |
| `group` | on `registry` and `py.http-client` links: the producer's group (a test that enqueues is test evidence, not a production crossing) |
| `recvClass`, `site`, `narrowedBy`, `self` | receiver typing: the concrete class, the call site, the factory or `class-attr` that narrowed it, a `self.m()` call |
| `super`, `passCtx` | a `super().m()` call; the receiver passes through |
| `selectors`, `order`, `component` | Haystack: the factory guards that select a component, its connect order |
| `cfg` | the config-reading guards around the call (`settings.…`, `getattr(settings, …)`, `is_prod`, `env_mode`, or a local assigned from one) |
| `onFailure` | the call sits in an `except` clause: it runs only when the guarded code raised, e.g. `except TimeoutError` |
| `passedBy`, `passedAt` | `py.callback`: the callee runs a callable or coroutine that `passedBy` handed it at `passedAt`. The link is only true for that caller: a walk that reached the callee some other way must not follow it |

## Tests as evidence

- `tests[]`: `id`, `file`, `line`, `end`, `asserts`, `assertLines`, and per test `direct[]` (`to`, `via` ∈
  `body` / `fixture` / `helper`, `viaId`, `kind`, `rule?`, `line`) and `mocked[]`. A direct link is an edge
  from the test's own side (its body, the fixtures it binds, test-side helpers, its test class) into
  non-test code that the test does not mock. It is the only link narration may call "tested".
- `fixtures[]` (`autouse`), `fixtureBindings[]` (parameter → fixture; class scope, then module, then the
  nearest `conftest.py`; autouse binds every test in scope).
- `mocks[]`: `fn`, `raw` target, resolved `target` (the name in the importing module, followed to its
  definition), `how`, and `scope: "session"` plus `conftest` for a patch started in `pytest_configure`,
  `pytest_sessionstart` or at conftest module level: it applies to every test under that conftest.
- `testSummary`: counts, including production functions with at least one direct link.

## Config-aware dispatch (`config.profiles`, `config.sites`)

A profile is code defaults, or one in-repo config file (`.env`, YAML incl. Helm env lists, TOML, JSON;
plus `--config-root` dirs) that sets a key a dispatch guard reads; each carries its file's `group`.
Production and dev sites are decided under code defaults and prod/dev profiles only; eval and test
profiles decide only eval and test sites. Each site lists its alternatives (with their group, so an
eval-group mock is visibly an alternative), the guards, a yes / no / ? per profile, the settings read,
the files that set them, and a classification: `config-narrowed` (every profile decides one class),
`config-dependent (runtime input)` (a guard reads a parameter) or `config-dependent (value not in repo)`.
`getattr(settings, "x", d)` reads a declared field `x` exactly as `settings.x` does (a profile's value, else the
field's default); when no field declares `x`, `d` decides, since a settings object ignores undeclared env vars.

Config is read only from git-tracked files (a local, untracked `.env` never is; a tracked `sample.env` or
`.env.example` is) and never from an `--exclude`d path. A value is recorded only for a key a dispatch guard
reads; any other fact records its key and file only. A secret-looking key (containing KEY, TOKEN, SECRET,
PASSWORD, CREDENTIAL, PRIVATE, AUTH, …) or a credential-shaped value (a URL with a password, a private key, a
JWT, a provider token, a long random string) is written as `set (redacted)` everywhere in `codemap.json` and
`codemap.md`, settings defaults included; dispatch is still decided on the value as read.

## Self-check

`ok` is false — and `mine` exits 2 — when the parser saw a definition the extractor did not record
(`defsExtracted` < `defNodes`), or when two definitions in different scopes collapsed into one symbol
(fewer non-`main` symbols than `defScopes`, the distinct qualified names the parser saw; a definition repeated in
both branches of an `if` / `try` is one). Also reported: files with syntax errors, resolved calls, unresolved calls
by where their head name comes from (`inRepo`, `external`, `builtin`, `local`), and the in-repo miss rate:
calls whose head is an in-repo name but whose target could not be resolved. `packageRoots` lists the package roots
below the repo root (above); `crossRootImports` the calls resolved through a root that does not hold the importing
file (`name`, `root`, `calls`: right only when that root is on its sys.path) and `ambiguousImports` the calls lost
because several roots claim their import and none holds the importer (`name`, `roots`, `calls`). `externalLikeRepoDirs` counts calls into imports that resolved as external although an
in-repo directory with no `__init__.py` (a namespace package) has their name, with their `rate` among in-repo calls:
a high rate means those in-repo calls are not linked.

## `candidates.json` (`propose.mjs`)

One candidate per prod, eval and dev entry (test-group entries are not walked). A candidate is the tree of paths from its entry, walked over `static`, `ctor`, `framework`,
`dispatch`, `virtual`, `queue`, `http` and `spawn` edges with the receiver class carried, so a `self.m()` call
resolves under the class that was constructed. No candidate is chosen here.

The walk's rules:

- **A non-test walk never enters test-group code.** A test subclass or fake that production CHA reaches is a
  *test double*: listed in `testDoubles`, never walked.
- **A production walk expands any non-test code** it reaches; a node from another group is listed in `crossGroup`.
- **An eval or dev walk folds every production symbol** into a `uses-prod` leaf, and its crossings into production
  are `exercises` links: an eval flow is the harness's own story plus the production flows it drives.
- **Helpers fold by same-group fan-in.** A symbol with at least `--fanin` (6) callers from its own group and an
  in-repo subtree of at most `--leafy` (5) symbols is a `helper` leaf. Test callers never count, so a production
  function many tests call is not folded.
- **Collaborators fold at the interface.** An abstract target is an `interface` leaf; two or more concrete targets
  of one call site are `alternative` leaves, with the config site that selects them. `--no-iface-fold` expands them.
- **Data-model constructors** (dataclasses, pydantic models, exceptions, enums) are listed in `constructs`, not walked.
- **A `py.callback` link is followed only from the caller that handed the callable over**, as a child of the callee
  that runs it (`via: callback`).

| Field | What it holds |
|---|---|
| `params` | `fanin`, `leafy`, `ifaceFold` |
| `totals` | entries per group, candidates and top-level candidates per group, `continuations`, `helpers` (symbols that fold, all groups), `testDoublesRefused`, production functions with a direct test link and reached from tests |
| `unwalked[]` | entries whose symbol is not in the code map (`propose` exits 2) |
| `candidates{entry id}` | `group`, the entry's `kind` / `method` / `path` / `key` / `file` / `line`; `continues` (below); `symbols`, `own`, `folded`, `modules`, `maxDepth`; `ownIds[]`; `nodes[]` (`id`, `depth`, `via`, `ctx` receiver, `parent`, `folded` ∈ `helper` / `interface` / `alternative` / `uses-prod`); `crossings[]` (`from`, `to`, `kind`, `evidence`, `intoGroup`); `exercises[]` (the crossings into another group); `dispatch[]` (`site`, `how` ∈ `receiver` / `cha` / `factory`, `before` → `after` target counts, `targets`, `narrowedBy`, `config` = the factory's classification and alternatives with their guards, Haystack `selectors`); `branches[]` (followed calls under a config guard: `cfg`, `onFailure`); `constructs`, `testDoubles`, `usesProd`, `crossGroup`; `segments[]` |
| `testLinks[]` | per test: `asserts`, `assertLines`, `mocked`, `direct[]` (mine's direct links) and `exercised` / `exercisedIds` |
| `bySymbol{id}` | `direct[]` (the tests with a direct link to it) and `exercised` (how many tests reach it) |
| `symbols{id}` | `group`, `kind`, `file`, `start`, `end`, `module` of every symbol a candidate or test link touches |

**Segments and continuations.** A candidate is cut into segments at each crossing that stays in its group: the
entry, then each crossing target (`root`, the `from` that crosses, `kind`, its own and folded counts, `ownIds`).
A crossing into another group is an `exercises` link, not a segment. An entry reached through another candidate's
same-group crossing is a **continuation**: `continues` lists the candidates that reach it, and it is not ranked
on its own.

**Test reach is reach, not proof.** From each direct link's target, with the call site's receiver, the walk runs
until it meets a symbol the test mocks (`mocked`, session-wide mocks included), a crossing or test code. Only
expanded symbols and helpers count. Narration calls a hop "tested" only for a direct link.

## `ranking.json` and `ranking.md` (`rank.mjs`)

Each group's top-level candidates (prod, eval, dev; continuations excluded), ordered by greedy marginal coverage of
that group's own symbols, ties broken by more crossings. **There is no cut line and no series**: no row is marked
chosen, and `--min-new`, `--min-share` and `--series` do not exist. The agent proposes the series from the full
tables.

| Field | What it holds |
|---|---|
| `params` | `explainTop` (10) and `explainTopEval` (5): how many prod and eval rows `ranking.md` explains in full |
| `totals` | top-level rows and universe (distinct own symbols) per group, continuations |
| `ranked.{prod,eval,dev}[]` | per row: `rank`, the entry and its route or key, `gain` (new own symbols), `cumulative`, `coverage`, `own`, `folded`, `modules`, `crossings`; `nearest` (the most-overlapping higher row) and `jaccard`; `pinned` (own functions with a direct test link), `tests` (distinct tests pinning own code), `testsNew` (tests pinning this row's new code); `cfg` (distinct dispatch points, one per site and target set, that a config read narrows, that have two or more concrete targets, or that Haystack selectors pick: the same points the explained rows list); `evals` (top-level eval rows whose `uses-prod` leaves or crossings reach this row's own code). Eval and dev rows add `exercises[]` and `usesProd[]`, each with `flowRank`, the first production row that owns it |
| `merged[]` | prod and eval top-level rows on one list, evidence only |
| `shared[]` | production modules whose functions appear in at least 3 production rows and that at least 5 tests pin directly: `module`, `candidates`, `firstOwner` (rank) and `firstOwnerEntry`, `functions`, `directTests`. Cross-cutting code (auth, retry, tokens) has no entry point of its own, so this table is where it shows |
| `continuations[]` | every continuation with its parents |

`ranking.md` prints every row of every group with these columns, what each eval row exercises, the dev group as
filtered by default (promotable in `flows.json`), the shared table, the continuations, the merged order, and for the
top prod and eval rows their segment table, dispatch points with the config that selects them, and config-guarded
branches.
