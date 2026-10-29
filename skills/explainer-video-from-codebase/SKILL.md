---
name: explainer-video-from-codebase
description: Under construction — will turn the major code flows of a codebase into a narrated explainer-video series. Today only its first stage exists, mining a Python repo into a code map (files grouped as prod/test/eval/dev, call graph, entry points, framework links, tests as evidence, config facts). Use only when the user asks to mine a codebase's code map.
---

# explainer-video-from-codebase — under construction

The sibling of `explainer-video-from-coursework` for codebases: code proposes candidate
flows per entry point, the agent proposes the series with a reason per flow, the user
approves the flow list, and a coursework-shaped plan feeds the same per-video stages 3–8.
It is being built one milestone at a time; **only stage 1's mining tool exists so far**.
Do not promise a video from this skill yet.

## Stage 1 — `/mine` (the part that exists)

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
The code map's fields are described in [`FLOWS.md`](./FLOWS.md).
