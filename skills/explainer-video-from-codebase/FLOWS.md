# FLOWS.md — reference for the code-flow artifacts

This file grows with the skill. Today it describes the stage 1 artifacts: `codemap.json`, written
by `tools/mine.mjs`, with its readable twin `codemap.md`; `candidates.json`, written from it by
`tools/propose.mjs`; and `ranking.json` and `ranking.md`, written from that by `tools/rank.mjs` (each schema 1).
Then the stage 1b–1c artifacts: `flows.json`, the agent's series proposal; `flows.validated.json` and `flows.md`,
written by `tools/apply-flows.mjs`; `flows.approved.json`, written by `tools/approve-flows.mjs`; and `plan.json`
and `plan.md`, written by `tools/flow-plan.mjs`. Then the on-screen code for a video's scenes: code panels from
`tools/excerpt.mjs`, verified by `tools/excerpt-check.mjs`, and diagram skeletons from `tools/flow-diagram.mjs`.

`mine`, `propose` and `rank` are pure functions of their input and the tool versions: they never write
inside the repo, never use the network and never run repo code. Two runs over the same input produce
byte-identical output (timings go to stdout only). The opt-in `trace.json` (stage 1t, `tools/trace.mjs`) is the one
artifact made by running repo code: the repo's own test suite, sandboxed.

## Top level

| Field | What it holds |
|---|---|
| `schema`, `tool.versions` | `1`; the vendored tree-sitter runtime and grammar versions |
| `root`, `commit`, `treeHash` | the mined directory, its `git HEAD` (or `null`), a sha256 over every mined and config file |
| `languages`, `unsupported` | Python, TypeScript and JavaScript files and parse errors; files of other languages (Go, C, C++), by extension (grouped, not mined yet) |
| `groups` | the ordered group rules, the `--group` overrides, and file / symbol / entry counts per group |
| `files[]` | every source file: `path`, `group`, the `rule` that placed it, `lang`, `sha256`, `parseError?`, `unsupported?` |
| `symbols[]` | `id`, `group`, `kind` (`function`, `method`, `class`, `main`), `file`, `start`, `end`, `name`, `module`, `cls`, `decos`, `params`, `async?`, `sha256` of its source span |
| `classes[]` | `id`, resolved `bases`, raw `baseExprs`, `methods` (name → symbol id), `decos` |
| `edges[]`, `entries[]` | below |
| `tests[]`, `fixtures[]`, `fixtureBindings[]`, `mocks[]`, `testSummary` | below |
| `rules` | per-pack records: Depends links, queue producers, registry tables (with dropped constructors), Haystack pipelines, HTTP client calls (linked or not), spawns, callback count; with TS/JS files also `jsHttp` (every fetch / axios / ky call: `client`, `method`, folded `url`, `handler` or null, `unlinked` (why, when the method is unknown and the path serves more than one handler), `folded` consts, `env` keys, `match: "suffix"`), `uiRoutes`, Express `mounts`, `nextRoots`, `routeAliases` (a second route to a handler that already has an entry) and `setupFiles` |
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
`install_requires` / `extras_require`, Pipfile; case, `-` and `_` normalised; a pyproject.toml or Pipfile that is
not valid TOML is read line by line instead and listed in `selfCheck.dependencyFilesNotParsed`): `integrations/stripe/` never
captures a declared `stripe`, and a declared name several roots claim is a library import, never reported as
ambiguous. A top-level name of the standard library never
resolves to an in-repo loose module, namespace directory or nested package (`app/logging/` never captures
`import logging`); only a repo-root package `logging/__init__.py` shadows it. `selfCheck.packageRoots` lists the
package roots below the repo root. A call made at module level has `from: pkg.module:<module>`.
A library target is `ext:<dotted.name>`.

TypeScript / JavaScript ids name the module by its repo-relative path with its extension (`web/src/api.ts:searchBooks`,
`web/src/store.ts:Store.load`, `…:Page.<locals>.go`, `…:<main>` for an `if (require.main === module)` block), so they
never meet a Python id. Imports resolve the way graphify resolves them: relative specifiers (a `.js` naming a `.ts`
file, extensions probed, directory `index` files), the nearest tsconfig.json / jsconfig.json `paths` and `baseUrl`
(through `extends`), in-repo workspace packages by their package.json `name`, and `@/` as `src/` when no tsconfig
exists; ESM default, named and namespace imports, re-exports and `export *`, and CommonJS `require` /
`module.exports` / `exports.x`. A function or class assigned to a variable is named by it, an object literal's
functions by `obj.member`, an inline route handler by its route (`GET /health`), a test by its describe path
(`Cart > adds an item`). `selfCheck.typescript` holds its counts, and `unresolvedImports` the relative imports that
name no file.

## Groups

Every file is in exactly one group. Ordered path rules, first match wins: **test** (a `tests/`,
`test/` or `__tests__/` dir; `test_*.py`, `*_test.py`, `conftest.py`; `*.test.*` / `*.spec.*` for JS/TS,
`setupTests.*`, `jest.setup.*`, `vitest.setup.*`) → **dev** by file name (`debug_*`, `diagnose_*`,
`*migration_controller*`, `dev.py`; `debug*.[jt]s`, `*.dev.[jt]s`, jest/vitest/vite/webpack/… `.config.[jt]s`) → **eval** (`evals/`, `eval/`, `*_evals/`,
`evals_*/`, `evaluation(s)/`, `benchmark(s)/`, `bench/`) → **dev** by directory (`migrations/`, `alembic/`,
`dev_setup/`, `dev/`, `scripts/`, `verification/`, `debug/`) → **prod**. A file the path rules leave in prod
is moved by content: it imports pytest/unittest and defines tests → test; it imports an eval framework
(ragas, deepeval, promptfoo, lm_eval, inspect_ai, mteb, beir, trulens, langsmith `evaluate`) or has
training-loop markers → eval; a JS/TS file that imports vitest, `@jest/globals`, `node:test` or mocha and defines
tests → test, one that imports promptfoo, evalite, autoevals or braintrust → eval: in every language, an
eval-framework import puts a file in the eval group (design rev3 §3.15). `--group 'glob=group'` always wins.

## Entries

`kind` ∈ `http` (`method`, `path` with every `include_router` prefix up the chain and the router's own; only a
decorator whose receiver is an `APIRouter` or `FastAPI` app makes one), `queue-consumer` / `scheduled` (`key`),
`cli`, `main`, `registered-callback` (`via`, e.g. `FastAPI(lifespan=…)`), and from TS/JS: `http` from Express
(`app`/`router` methods and `.route()` chains, every `app.use(prefix, router)` mount up the chain, `:id` written
`{id}`) and Next.js route handlers and API routes, and `ui-route` (`path`) from React Router (route objects and
`<Route>` elements, nested) and Next.js pages, at the component rendered; a handler or component a second route also
reaches keeps one entry and lists the other routes in `alsoAt`. Each carries `group`, `file`,
`line` and the `rule` that made it. An entry in the test group is not a flow; `codemap.md` suggests the
override that moves it.

## Edges

`{ from, to, kind, line, … }`. Kinds: `static`, `ctor` (to the class and its `__init__`), `virtual` (a
subclass override reachable by CHA), `dispatch` (one of several narrowed targets), `framework`, `queue`,
`http`, `spawn`. Optional fields:

| Field | Meaning |
|---|---|
| `rule` | the pack that produced it: `fastapi.Depends`, `taskiq.literal-key`, `taskiq.kiq` / `.delay` / `.apply_async`, `registry`, `haystack.pipeline`, `py.http-client`, `process-spawn`, `pytest.fixture[.autouse]`, `py.callback`; from TS/JS `js.http-client` (a frontend call to a route in any language), `express.middleware`, `js.test-hook`, `js.callback` (a function handed to a call or a JSX event prop runs from there); `evidence` says why, with `file:line` |
| `groups` | `[fromGroup, toGroup]` when the edge crosses groups (labelled, never cut) |
| `group` | on `registry` and `py.http-client` links: the producer's group (a test that enqueues is test evidence, not a production crossing) |
| `recvClass`, `site`, `narrowedBy`, `self` | receiver typing: the concrete class, the call site, the factory or `class-attr` that narrowed it, a `self.m()` call |
| `super`, `passCtx` | a `super().m()` call; the receiver passes through |
| `selectors`, `order`, `component` | Haystack: the factory guards that select a component, its connect order |
| `cfg` | the config-reading guards around the call (`settings.…`, `getattr(settings, …)`, `is_prod`, `env_mode`, or a local assigned from one) |
| `onFailure` | the call sits in an `except` clause: it runs only when the guarded code raised, e.g. `except TimeoutError` (TS/JS: `catch (e)`) |
| `jsx` | the edge is a rendered component (`<Page />`): to the function, or to a class's constructor and `render` |
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
- TS/JS (jest, vitest, node:test, mocha in test-group files): a test is an `it` / `test` call (with `.each` titles kept
  as written), named by its describe path; `beforeEach` / `beforeAll` / `afterEach` / `afterAll` are autouse
  fixtures for the tests under their `describe`, and a hook in a setup file (`setupTests.*`, `jest.setup.*`,
  `vitest.setup.*`, or one a jest / vitest config lists in `setupFiles`) binds every test below it (`covers`: the
  config's directory for a listed one). `jest.mock('mod')` / `vi.mock('mod')` replace every export of the module the
  string resolves to, or only the factory's keys when the factory spreads the real module; they are hoisted, so their
  `fn` is the test file's `<module>`, and in a setup file they are `scope: "session"` mocks. `jest.spyOn` /
  `vi.spyOn` replaces a method only when a `.mockImplementation` / `.mockReturnValue` / `.mockResolvedValue` /
  `.mockRejectedValue` follows. One mock record per replaced symbol.

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
both branches of an `if` / `try` is one). Also reported: files with syntax errors, dependency files that are not
valid TOML (`dependencyFilesNotParsed`, above), resolved calls, unresolved calls
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

## `trace.json` (`trace.mjs`, opt-in)

Written only after the user said yes to one exact test command (`--i-ran-this-by-the-user`). `trace.mjs` refuses
(exit 1) without that flag; refuses (exit 3) anything but `pytest`, `py.test`, `python -m pytest` or `python -m
unittest` (python, python3 or python3.N, by name or path; a bare name is found in the repo's `.venv/bin` or
`venv/bin`, then on PATH), `node --test` (only `--test-*` and type-stripping flags), `npx jest` or `npx vitest [run]`
(no npx flags, no watch mode, none of the flags the trace sets itself: reporter, coverage, pool; a flag's value as
`-t=name` or `-t name`, split only for the jest and vitest flags that take a value, so a word after any other flag is
a test path or filter), or `jest` / `vitest`
from the repo's `node_modules/.bin`; refuses (exit 1) a jest or vitest the repo has not installed (nothing is ever
installed, and `npx` itself is never run). jest and vitest run from the package that holds them: the repo root, else
the one package below it (a `package.json` beside a `node_modules/.bin` holding the runner, such as `frontend/`) that
holds the code map's test files, whose test files and the paths given are read relative to it (`cwd` in `trace.json`);
two such packages holding test files are refused (exit 1). It refuses (exit 3), too, a command with any shell syntax (`;`, `&&`, `|`, redirects, `$`, backticks) or a wrapper (`uv run`,
`env`); and refuses (exit 4) on a platform with no OS sandbox, or where this platform's sandbox does not start
(`sandbox-exec` on macOS, `bwrap` on Linux, always chosen by platform; there is no option to pick or skip one). It
never runs unsandboxed.

The run: the repo's git-tracked and unignored files (every file but `.git` and virtualenvs, outside a git work tree;
a submodule or a nested repo by its own git view, never whole, so nothing its own `.gitignore` ignores) are copied to a scratch dir, and the command runs there with the repo's own interpreter, in place and read-only,
inside the sandbox. The sandbox hides the user's home folder and the original repo: the run reads only the copy, the
interpreter's prefix, its virtualenv (even one inside the repo) and the prefix that virtualenv was made from; a
prefix that would expose a hidden path whole (an interpreter installed straight into the home folder) is not exposed,
and the run says so.

- **macOS**: `sandbox-exec` with `tools/trace/sandbox/macos-nonet.sb` plus read rules `lib/sandbox.mjs` adds per run:
  IP traffic denied (localhost included), unix socket connects denied (so no DNS resolver), every write outside
  scratch denied, every read under the home folder and the original repo denied except the exposed paths (and the
  metadata, not the contents, of the dirs above them); no program outside the sandbox acting for the run: opening a
  URL, file or app through LaunchServices, Apple Events and launchd job submission denied (the services behind them
  too), and `open`, `osascript` and `launchctl` not executable;
- **Linux**: `bwrap` through `tools/trace/sandbox/linux-bwrap.sh`: new network, user, pid, ipc and uts namespaces;
  `/` read-only with `/run`, `/tmp`, `/var/tmp`, home dirs, the user's home folder and the original repo replaced by
  empty tmpfs mounts (the exposed paths mounted back read-only); scratch the only writable path; a seccomp filter
  failing `socket(AF_UNIX)` with EPERM. A new network namespace has its own loopback, so a test may reach a server it
  started itself, which the macOS profile denies;
- an empty environment: `HOME` and `TMPDIR` in scratch, `PYTHONDONTWRITEBYTECODE=1`, pytest's `-p no:cacheprovider`;
- an editable install that points into the original repo (a `.pth` path line, a setuptools finder's mapping, an
  `editables` redirect) is sent to the copy by the collector, since the original is hidden;
- credential-shaped strings (private-key blocks, AWS access key ids, bearer and basic auth values, known token
  formats, JWTs, a URL's password, the value of a key that names a secret) are redacted from `trace.log`, the output
  tail trace.mjs prints and the failure messages in `trace.json`;
- a time limit (`--timeout`, 900 s): the process group gets SIGTERM, then SIGKILL; what the collector wrote by then
  is kept, `timedOut: true`, exit 5.

The collector (`tools/trace/python/sitecustomize.py`, on `PYTHONPATH`; it runs the interpreter's own
`sitecustomize` it shadows) records every Python call as (nearest in-repo caller, in-repo callee, current test):
library frames between the two are skipped; code objects are keyed by identity, since twin bodies in two files
compare equal; lambdas, comprehensions and generator bodies count as the function holding them; an interpreter or
virtualenv under the repo is library code. The current test is set around each test's setup, call and teardown by
`fmtrace_plugin.py` (pytest, via `PYTEST_PLUGINS`) or a `TestCase.run` wrapper (unittest), so a call a framework makes
(a fixture, a DI provider) is still attributed to its test. Only the repo's own tests count: a run a test starts
inside itself over tests outside the copy (pytester's tmp dir) or an inner unittest suite records no outcome and leaves
the outer test current; a pytest process over the copy's own tests (an xdist worker, or a child a test starts) records
them, and `collected` is never less than the tests recorded. Audit hooks record each test's network attempts. Method
names come from `co_qualname` (Python 3.11+; older interpreters report bare function names, which miss methods). With
`HOME` in scratch, packages installed only in the user's site dir (`pip install --user`) are not found: use the repo's
virtualenv.

A JavaScript / TypeScript runner is run once per test file (the code map's test files that match the runner's own
default pattern, selected by the command's positionals as the runner reads them: a path or directory for node, a
case-insensitive regex over the path for jest, as is jest's `--testPathPattern` (never passed on, since
`--runTestsByPath` ignores it), a case-insensitive substring of it for vitest), each in its own
sandboxed process under V8 precise coverage (`NODE_V8_COVERAGE`), on the `node` the command names by path, else the one on PATH, with the repo's
`node_modules` linked into the copy entry by entry and exposed read-only (all but vite's caches, `.vite`, `.vite-temp`
and `.vitest`, which the run writes into, so it makes its own in the copy); a workspace package's link (a symlink into
the repo, such as `node_modules/@app/shared -> ../../packages/shared`) points at its copy, never at the hidden repo.
Reports: node --test's TAP on stdout; jest `--json --outputFile --runInBand --watchman=false --passWithNoTests`;
vitest `run --reporter=json --outputFile --pool=threads --passWithNoTests` (a forked worker is killed before it
writes its coverage). A file whose run ends cleanly with no test reported (the repo's own runner config does not
collect it, or it defines none) is listed in `notCollected` (`{file, tests}`: the code map's tests in it), never
counted as an error; those tests never ran, so they are not in `byTest` or `directLinksPerTest`. A covered
function is matched to a symbol through the script's source map when there is one (Node's own, or the inline map of a
file jest or vitest compiled through `node:vm`, which `tools/trace/js/fmtrace-srcmap.cjs` records), else by position
when the script V8 ran is the file (plain JavaScript, or TypeScript with its types stripped in place and a comment
appended), and otherwise by a name only one symbol of that file has. `tools/trace/js/fmtrace-net.cjs` (`NODE_OPTIONS=--require`) records each process's
and worker thread's connects and DNS lookups as they happen (a worker its runner terminates never reaches its exit);
where it cannot, the target is read from the error. A run in which no test file reported a test is exit 2. Attribution is per
test file and there are no caller → callee pairs, so `pairs`, `edges`, `noStaticEdge` and `callbacks` are empty;
`granularity: "test-file"`, `files` / `ranFiles` (the test files, and those run before the time limit), `ran`
(symbol → the test files it ran under), `byFile` (what ran in each) and `byTest` (`file`, `status`, `direct` counted
against what ran in that file) take their place, and `summary` has `functionsRan`, `unmappedFunctions` (named
functions that matched no symbol), `anonymousCallbacks`, `directLinksPerTest` and `fixtureLinks` (hooks that ran).

| Field | What it holds |
|---|---|
| `optIn` | `{by: "user", at, command}`: who opted in, when, and the exact command |
| `sandbox`, `runner`, `argv` | `macos-sandbox-exec:macos-nonet.sb` or `linux-bwrap:linux-bwrap.sh`; `pytest`, `unittest`, `node-test`, `jest` or `vitest`; the command as run (for a JS runner, one file's command with `<test file>`) |
| `timeoutSec`, `timedOut`, `exitCode`, `durationMs` | the limit and how the run ended |
| `codemap` | the code map's file, sha256, `commit`, `treeHash`, and `changedFiles`: mined files that differ in the copy (mine again first) |
| `outcome` | `collected`, `passed`, `failed`, `errors` (collection and setup errors, failed teardowns, a failing unittest class or module fixture, a test the time limit cut off), `skipped`, `xfailed`, `xpassed` |
| `failures[]` | `test` (code-map id, or null: a collection error, a unittest class or module fixture such as `unittest::setUpClass (pkg.mod.Class)`), `nodeid`, `status`, `phase` (`collect`, `setup`, `call`, `teardown`), `message` |
| `deniedBySandbox[]` | failing tests that attempted a network connect, or failed on a permission error or on a hidden path not found (bwrap hides a path by mounting an empty dir over it): `network` (the attempts), `permission`. They need a service or a file the sandbox refused; never retried |
| `pairs[]` | `{from, to, n, tests}`: distinct in-repo caller → callee pairs, with calls and how many tests they ran under |
| `edges[]` | the code-map edges that fired as a pair: `from`, `to`, `kind`, `rule?`, `passedBy?`, `n`, `tests` (ids). The overlay: an edge not listed is not observed, never removed |
| `noStaticEdge[]` | pairs no code-map edge of any kind explains, with a `category`: `test-side`, `validator`, `property`, `dunder`, `init`, `other` |
| `callbacks[]` | the `py.callback` links that fired |
| `byTest{id}` | per test (parametrized cases merged): `nodeids`, `status`, `ran` (every in-repo function that ran while it was current), `direct` (`total`, `observed`, `missing`: its direct links that did not run under it) |
| `summary` | records, distinct pairs, functions that ran per group; static edges observed by kind for all edges, production → production and test → non-test; direct links observed per test (and production only); fixture links observed by attribution; no-static-edge counts by category; unmapped records |

A fixture, a FastAPI `Depends` provider or a queue consumer has no in-repo caller frame, so those links are never
observed as pairs; a fixture link is observed by attribution (the fixture ran under its test). The trace is one
configuration with one set of mocks: narration says "observed in the test suite", naming the test configuration.

## `flows.json` (written by the agent)

The series proposal. Every reason (`why`, `say`, `claim`) is at least three words and not a placeholder (`tbd`,
`todo`, `…`). An unknown field is a problem, so a typo never passes silently.

| Field | What it holds |
|---|---|
| `series[]` | `{flow \| core, why}` in video order: every flow and core defined below, once each |
| `skipped[]` | `{entry, rank?, why}`: one entry each, never a glob; `rank` ("prod #6"), when given, must match the ranking |
| `promote[]` | `{entry, why}`: a dev-group row brought into consideration; it then needs a decision like any other row |
| `flows[]` | `{id, title, from, group?, hops, segments?, variants?, teach?, links?}`: `from` is an entry with a candidate; `group`, when given, is the entry's |
| `cores[]` | `{id, title, hops, pinnedBy?, variants?, teach?, links?}`: shared code with no entry of its own; `pinnedBy` here is `{symbol, test, say, lines?, strength?}` |
| `triage.excluded[]` | `{match, why}`: a glob (`*`, `?`) over entry ids and segment roots; it must match something |
| `outOfRepo[]` | `{claim, evidence, selects?}`: context outside the repo, checked for shape only and printed as **unverified**; `selects` names the config sites the claim decides |
| `codemap`, `candidates`, `trace` | accepted for the reader; the inputs are always the files beside `--candidates` |

A hop is a symbol id or `{symbol, lines?, pinnedBy?, exercises?, uses?, break?}`: `lines` ("54-65,70") narrows the
narrated lines inside the symbol's span; `pinnedBy[]` is `{test, say, lines?, strength?}`; `exercises` names the
production flow an eval or dev hop drives; `uses` names the core a hop hands over to; `break` starts a new video.
A flow's first hop is its `from`. `segments` is `{keep: [root], mention: [{root, say}], exclude: [{root, why}]}`.
A variant is `{entry, why}`. `teach[]` is `{dispatch, say}` (a config site, a factory or a recorded dispatch site)
or `{guard, say}` (`<symbol>@<line>` of a call under a config read). A declared link is `{from, to, kind, evidence}`
whose evidence starts with `file:line` or `file:a-b` that exists in the repo.

## `flows.validated.json` and `flows.md` (`apply-flows.mjs`)

`apply-flows` exits 2 on any problem, writes `flows.md` with every problem, and removes a stale
`flows.validated.json`, so nothing can approve or plan an invalid list. The checks:

| Check | Rule |
|---|---|
| reasons | every series item, skip, variant, promotion, exclusion, mention and citation carries a real reason |
| C1′ high-ranked rows | in each group, a row ranked at most 10 (prod) / 5 (eval) / 0 (dev), or the ranking's `explainTop` / `explainTopEval` when larger (a smaller one never lowers the floor), or at or above the lowest-ranked row the series includes, is a series flow's `from`, a variant or a skip, each with a reason; an exclusion glob does not count |
| C1 entry triage | every non-test entry is a flow's `from`, a continuation of one, a variant, skipped, excluded, or a dev row (filtered unless promoted; a dev continuation is filtered with its parent). Eval rows are never implicit |
| C2 segment triage | every segment of a kept candidate (a series flow's `from`) is kept, mentioned with a `say`, or excluded (in `segments.exclude` or by a glob) |
| C3 hop fidelity | each hop is within 4 calls of the previous hop, or of the nearest earlier hop that reaches it (back up the narrated stack): a path in the flow's candidate walk (or a variant's; for a core, every series flow's), returning up the tree then calling down, never down then up; or a directed path over recorded edges of any kind, never into test code; or a declared link. A hop that is a variant's entry starts that variant's chain |
| dispatch | a hop on a config alternative that no profile selects is refused unless an `outOfRepo` claim's `selects` names its site (then printed as selected only by an unverified claim); a hop reached through a CHA or dispatch edge must be in a walk tree, where the receiver resolved it |
| C3′ test fidelity | a cited test has a direct link to the hop and does not mock it; a test that only reaches the hop may be cited only with `"strength": "reachable"` |
| groups | no hop is test-group code; an eval or dev flow's hops are not production code, and its `exercises` hop must call, cross into or declare a link into that flow's code |
| shape | no unknown field, unique ids, real titles (not slugs, ellipses or "Part N"), a flow's `group`, when given, is its entry's, `uses` names a core with no cycle, a `lines` range inside its span, `teach` names a recorded point |

`flows.validated.json` (schema 1, `ok: true`) holds everything `flow-plan` needs: `inputs` (the flows, candidates,
code map and ranking files with their sha256), `params` (`explainTop`, `explainTopEval`: the effective K, never below 10 and 5; `maxPath`), `series[]`
(`kind`, `id`, `title`, `why`, `rank`), `flows[]` and `cores[]` with every hop resolved (`symbol`, `name`, `file`,
`start`, `end`, `sha256`, `lines`, `connection` (`how`: entry, start, variant, candidate, edges or link; `path`; `steps[{from, to, kind, rule, evidence, down}]`),
`crossing`, `break`, `uses`, `exercises`, `drive` (an `exercises` hop's `{kind, to, evidence}`: the walk's crossing into that flow's code, else a declared link, else a direct call, `kind: "call"`), `selectedBy`,
`pinnedBy[{test, file, line, end, asserts, assertLines, lines, say, strength, via, observed}]`), segments with their
decision, variants with their rank, `teach[{dispatch, guard, say, hop, alternatives}]` (the hop that holds the
point, else its nearest narrated ancestor), `links`; `skipped`, `promote`, `excluded` (with what each rule matched);
`triage` (every entry's status and the high-ranked rows per group); `outOfRepo` (`verified: false`); and `tests`
(`sessionMocks`, `autouseMocks`: mocks every test under a conftest runs with).

`flows.md` opens with the **approval table**: the series with group, rank, size and reason; the skipped rows; the
variants; the promoted and dev rows; and the estimate from `flow-plan`'s cost model. Then the C1′ and C1
accounting, every flow and core with every hop, how it is reached, the rule and evidence of each edge and the cited
tests with their assertion lines, the segments, taught branches and declared links, the hops kept by two or more
flows (core candidates), the out-of-repo claims and the test configuration. Two runs give byte-identical outputs.

## `flows.approved.json` (`approve-flows.mjs`)

`{schema, tool, flowsFile, flowsHash, series[{kind, id, title, why}], approvedBy, at, note}`: `flowsHash` is the
sha256 of `flows.validated.json`. It is written only after the user's explicit yes (the skill's rule: code cannot
prove a human said yes). `approve-flows` exits 2 when the validated list is missing, did not pass, or `flows.json`
changed since it was validated.

## `plan.json` and `plan.md` (`flow-plan.mjs`)

`flow-plan` refuses (exit 5) unless `flows.approved.json` carries the current `flows.validated.json`'s sha256 and
`flows.json` still matches what was validated: no plan, so no script, exists before the user approves the list.

The plan has the coursework plan's shape, so `apply-enrichment`, `script-check`, `timing-report` and the per-video
stages read it unchanged: `generatedFrom`, `kind: "codebase"`, `model` (below), `forms: ["overview", "flow",
"core"]` (what `apply-enrichment` accepts), `approval` (`by`, `at`, `note`, `flowsHash`), `inputs`, `totals`
(`videos`, `seriesMinutes`, `longestVideoMin`, `capMinutes`, `hops`, `flows`, `cores`), `coverage[]` (every hop:
`item`, `hop`, `symbol`, `section`, `video`), `orphans`, `capViolations`, `outOfRepo`, `tests`, and `videos[]`:
`index`, `title` (a placeholder for `/enrich`), `form`, `group` (the flow or core id; `timing-report` groups by it),
`flowGroup` (prod or eval), `words`, `seconds`, `minutes`, `formWhy` (the series reason), `sources` (the hops'
files), `artefacts` (the cited tests' files), `evidence`, `teach`, `sections` (`"<file> :: <symbol> @L<start>"`,
what a script's `covers` names) and `sectionSpans` (each hop's span, sha256, narrated lines and `pinnedBy`).

Videos: one `overview` first (its sections are the series items), then each series item in order. A hop with
`break` starts a new video; hops pack greedily under `--max-min` (25); on overflow a video splits at its latest
crossing, else at the overflowing hop; a hop is never split and two items are never glued; a piece under 2.5
minutes merges with a neighbour of the same item when the two fit (never across a `break`). C4: every kept hop is
assigned to exactly one video; an orphan or a video over the cap exits 2. Re-planning when `plan.enriched.json`
exists and the tree, candidates, flows, approval or cap changed exits 4 unless `--force`.

The cost model (`lib/decompose.mjs`). WPM and EXPANSION are coursework's measured `model.mjs`; FRAME, HOP_BASE,
WPL, BRANCH and TEST are calibrated on one narrated pilot code video (8 hops, 96 narrated lines, 2 taught branches,
3 cited tests, 1032 words; `CALIBRATION` holds the counts). BOUNDARY and the overview's words are still estimates:
the pilot crossed no boundary and produced no overview.

```
words   = FRAME 150 + Σ hops (HOP_BASE 5 + WPL 6 × narrated) + crossings × BOUNDARY 60
        + taught branches × BRANCH 70 + min(3, cited tests) × TEST 45          (the overview: 1000 words)
narrated = count(hop.lines) or min(22, ceil(0.5 × span lines))
minutes  = words / 153 × 1.10
```

A crossing is a hop reached through a queue, HTTP or spawn edge, or an eval hop that `exercises` a production flow.

## Code panels (`excerpt.mjs`)

A panel fragment for a `code` scene, printed to stdout, cut from the file as mined (the file's sha256 must still be
the code map's, and a symbol's span its own; else exit 2: re-mine):

| Field | What it holds |
|---|---|
| `file`, `lang` | the file's path (the panel's tab) and its language |
| `lines[]` | the shown lines, byte for byte, and the elision markers between them |
| `numbers[]` | each line's real line number; `null` on an elision marker |
| `elided[]` | `{at, from, to}`: the marker at index `at` stands for lines `from`–`to` |
| `source` | `{file, symbol \| test + pins + via, start, end, sha256, fileSha256, commit}`: the span shown, its sha256, the file's sha256 when mined and the mined commit; what `excerpt-check` verifies |

`--lines` ("54-65,70", inside the span) picks the narrated lines; each unshown run inside the span becomes one
marker, `⋯ N lines`, at the run's outer indent (a run of blank lines is shown instead). Without it the whole span is
shown. More than 22 shown lines exits 2. With `--test <id>` the span is the test's: its def line, the line
where it calls `--symbol` (when that call is in its own body; a fixture or helper calls from elsewhere, recorded in
`via`) and its assertion lines. The test must have a direct link to the symbol and must not mock it (C3′), else
exit 2.

Scene-code reads `numbers[]` for the number column and styles the `elided[]` lines apart. A panel with
`numbers[]` takes one `focus` act per sentence (`{op: "focus", panel, lines: [1-based panel lines], from, to,
narration}`), and a window that starts as the previous one ends keeps the dim; a coursework panel keeps its single
focus act. A `{op: "pause", from, to, text?}` act shows the pause badge. A scene with `segment: "<key>"` is
timed from that segment's window: the host (opened with `?work=`) reads the window from `timeline.js` and plays
the scene at video time minus the window's start, and draws no progress bar; a named
segment with no window throws. A coursework scene, with no `segment`, keeps the video clock and its own `total`.

## `excerpt-check.mjs` (C6)

`--work out/<name>/<NN> --repo <root> --script …` reads the video's code scenes (the manifest's `code` segments),
`lines.json` and the video's script (exit 1 without any of them):

- **drift, exit 2**: every panel has an excerpt `source`; the file it names is the mined one (the working tree's
  file when its sha256 matches, else `git show <commit>:<file>`); the span's sha256 matches; each numbered line
  equals that line of the file, in order, inside the span, with no line hidden except behind a marker that names
  exactly its gap; at most 22 shown lines.
- **focus, exit 3**: every shown non-blank line is in a focus act whose `narration` names lines of the segment in
  `lines.json` and whose window starts at the first line's onset and ends between the last line's end and the next
  line's onset (scene time = line time + `lead`, ±0.06 s). A pause segment (its script segment carries `pause`; it must be a code scene with panels) is exempt, must carry a `pause` act, and a video has at most 3;
  a `pause` act on any other segment is an error. Every code scene names its own segment (`segment` equal to its
  manifest key), since its acts are timed from that window.

A pause segment's script carries `"pause": {"dwell": <s>}` with 0 < dwell ≤ 2, said out loud ("pause" in its
text), with `pad` equal to the dwell; `script-check` adds the dwell to its estimate and errors on a `pad` that
differs from the dwell and on a fourth pause segment.

## Diagram skeletons (`flow-diagram.mjs`)

`--flows out/<name>/flows.validated.json --as map|sequence|exercises [--flow <id>]` prints JSON; exit 1 on bad
flags, an unknown flow, or `exercises` on a flow with no `exercises` hop.

| `--as` | Output |
|---|---|
| `map` | `{host: "diagram", items, config: {layout, nodes, edges}, crossings}`: one `box` per module the hops run through (every series item, or `--flow`'s), members = its hops, an arrow per call between modules (queue amber, HTTP green, spawn red); `crossings` lists every queue, HTTP and spawn hand-off and every eval hop's drive into production, with evidence |
| `sequence` | `{host: "svg", primitive: "sequence", params: {participants, messages}}` for `SceneCore.primitives.sequence`: the caller (an HTTP entry's route, a queue key, a command), then each module in order; one message per hop from the module that calls it (`kind` call / http / queue / spawn; `via` counts the unnarrated calls between) |
| `exercises` | `{host: "diagram", exercises, config}` for an eval or dev flow: its hops as the harness lane, each production flow it drives as one box with `see video N`, and its `drive` between (`kind`, `to`, `evidence`) |

The video number comes from `plan.json` beside the validated flows when it was planned from that exact file
(`videoFrom: "plan.json"`), else from the planner at the default cap (`videoFrom: "estimate …"`).
