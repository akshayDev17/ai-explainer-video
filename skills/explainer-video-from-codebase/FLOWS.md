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
| `config` | config files (`group`, `reader`, fact count), settings fields and properties, every fact (`key`, `value`, `file:line`), profiles and classified dispatch sites (below) |
| `frameworksWithoutPack[]` | known frameworks the repo imports that no rule pack covers: their wiring is not linked |
| `selfCheck` | below |

Symbol ids: `pkg.module:func`, `pkg.module:Class.method`, `…:outer.<locals>.inner`, `pkg.module:<main>`
for an `if __name__ == "__main__":` block. A call made at module level has `from: pkg.module:<module>`.
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

`kind` ∈ `http` (`method`, `path` with every router prefix), `queue-consumer` / `scheduled` (`key`),
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
`getattr(settings, "x", d)` reads setting `x`, falling back to `d` when no field declares it.

## Self-check

`ok` is false — and `mine` exits 2 — when the parser saw a definition the extractor did not record
(`defsExtracted` < `defNodes`). Also reported: files with syntax errors, resolved calls, unresolved calls
by where their head name comes from (`inRepo`, `external`, `builtin`, `local`), and the in-repo miss rate:
calls whose head is an in-repo name but whose target could not be resolved.
