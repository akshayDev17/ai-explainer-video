# FLOWS.md — reference for the code-flow artifacts

This file grows with the skill. Today it describes the one artifact that exists:
`codemap.json`, written by `tools/mine.mjs` (schema 1). Its readable twin is `codemap.md`.

`mine` is a pure function of the repo tree and the tool versions: it never writes inside the
repo, never uses the network and never runs repo code. Two runs over the same tree produce
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
