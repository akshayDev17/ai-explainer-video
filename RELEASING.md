# Releasing

Two npm packages ship from this repo, and **GitHub Actions publishes both**. Nothing is
published from a laptop any more.

| package | source | consumers |
|---|---|---|
| `explainer-video-from-coursework` | repo root | Claude Code, Codex (npm) · Antigravity (git) |
| `explainer-video-from-coursework-dsh` | `dsh/` | DeepSeek Harness |

## A release is a tag

```sh
# 1. bump the version in all four places it is duplicated
#    package.json · plugin.json · .claude-plugin/plugin.json · dsh/package.json
# 2. commit
git commit -am "chore(release): v0.1.3"
# 3. tag and push — this IS the release
git tag v0.1.3
git push origin main --tags
```

Pushing the tag runs [`.github/workflows/release.yml`](./.github/workflows/release.yml),
which publishes both packages **root first** (the wrapper depends on it) and **fails the
run if the tag disagrees with either `package.json` version**.

Watch it with `gh run watch`, or the Actions tab.

The marketplace catalogs pin `"version": "^0.1.0"` as a *range*, so patch and minor bumps
need no catalog edit — Claude Code and Codex pick the new version up on their next install
or update.

## One-time setup: a Trusted Publisher per package

npm has to be told which workflow is allowed to publish. Do this once for **each** package,
under that package's settings on npmjs.com — `https://www.npmjs.com/package/<name>/access`:

| field | value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `akshayDev17` |
| Repository | `ai-explainer-video` |
| Workflow filename | `release.yml` |
| Environment name | **leave empty** — the workflow declares no `environment:` |

The filename must match exactly, and the environment must match the workflow, or npm
rejects the publish. Each package needs its own entry.

**Why we can do this at all:** a package has to exist on npm before a Trusted Publisher can
be attached. Both already do (0.1.0, 0.1.1), so there is no chicken-and-egg here — but a
brand-new package name would need one manual publish first.

## Why OIDC instead of a token

- **No long-lived secret.** Nothing to store, rotate, leak, or paste into a GitHub secret.
  The credential is minted per run and dies with it.
- **Provenance comes free.** Under trusted publishing the npm CLI emits a provenance
  attestation automatically — a cryptographic claim tying the tarball to this commit and
  this workflow run, so `--provenance` is no longer needed. Provenance requires a public
  source repo; this one is public.
- **2FA is already satisfied.** Publishing these packages requires 2FA, which is why local
  publishes needed `--otp`. OIDC is accepted as 2FA-equivalent, so CI passes no OTP.

## Gotchas worth knowing

- **CI npm must be ≥ 11.5.1.** Node 22 bundles npm 10, which cannot exchange the OIDC token
  — hence the workflow pinning `npm@11.5.1` through `npx`. The npm on this laptop is
  **10.9.8**, which is precisely why manual publishes needed `--otp`.
- **The two publishes are serialized** by a `sleep`. A second publish PUT racing the first
  one's registry processing returns `409 Failed to save packument`.
- **`registry-url` is required** in `setup-node`, or `npm publish` fails with `ENEEDAUTH`.
- **A tag without a matching version fails the run**, deliberately: shipping the wrong
  version is the one mistake a tag-triggered release makes cheap to commit.
- **The workflow only works once the Trusted Publisher exists.** Tagging before then gives a
  red run, not a publish.

## If a release fails

The root publish runs first, so a failure is one of:

- **Before either publish** (the guard) — fix it, then delete and re-push the tag:
  `git push --delete origin v0.1.3 && git tag -d v0.1.3`, then re-tag.
- **Between the two** — the root is live, the wrapper is not. Re-run the job from the
  Actions tab; the root publish will report a version-exists error, which is expected and
  harmless. Confirm the wrapper lands.
- **A bad version is already live** — npm will not let you republish it. Deprecate and move
  forward: `npm deprecate explainer-video-from-coursework@0.1.3 "broken — use 0.1.4"`.

The manual path still works as a fallback — `npm publish --otp <2FA_OTP>` from a machine
with the right npm — but it produces no provenance, and the laptop-publish era is ending
anyway.

## Deliberately not wired

- **A GitHub Release per tag** — add `contents: write` plus a `gh release create` step.
- **Tag protection** — a repository rule on `v*` stops a tag being moved or deleted.
- **An approval gate** — `environment: npm-production` on the job, mirrored in the npmjs.com
  config, turns a release into an approved action.
- **A post-publish smoke test** — `npm view <pkg> version` plus a clean install in a scratch
  directory, so a bad tarball is caught before anyone consumes it.
