# Releasing

Two npm packages ship from this repo. GitHub Actions **stages** them; you **approve** them.
No npm token exists anywhere, and no publish ever runs on a laptop.

| package | source | consumers |
|---|---|---|
| `explainer-video-from-coursework` | repo root | Claude Code, Codex (npm) · Antigravity (git) |
| `explainer-video-from-coursework-dsh` | `dsh/` | DeepSeek Harness |

## A release is a tag, then an approval

```sh
# 1. bump the version in all four places it is duplicated
#    package.json · plugin.json · .claude-plugin/plugin.json · dsh/package.json
# 2. commit
git commit -am "chore(release): v0.1.3"
# 3. tag and push — CI stages both packages
git tag v0.1.3
git push origin main --tags
```

Then approve what CI queued:

```sh
npx npm@latest stage list                      # each staged version, with its stage id
npx npm@latest stage download <stage-id>       # optional: open the tarball and look
npx npm@latest stage approve <stage-id> --otp <6-digit code>
```

`npx npm@latest` rather than plain `npm`, because the npm on this laptop is **10.9.8**,
which predates the `stage` command. The `--otp` is the code from your authenticator app —
approval is the step that requires 2FA, deliberately.

**Two approvals per release**, one per package. Nothing is installable until you approve it.
`npm stage reject <stage-id>` drops a queued version instead.

## Why staged rather than direct

The trusted publisher is configured with **"Allow npm publish" unchecked**, so the
workflow's OIDC credential can queue a version but cannot make it live. That closes a hole
provenance does *not* close: if the release workflow were ever compromised, the provenance
attestation would still verify perfectly — because the code really did come from this repo.
Staging is the control that stops it, since a human sees the version before anyone can
install it. `npm stage download` exists so you can inspect the tarball first.

Checking that box instead would make a tag go live with no human in the loop; npm labels it
"Not recommended" for exactly this reason.

## One-time setup: a Trusted Publisher per package

npm has to be told which workflow may stage. Do this once for **each** package, under that
package's settings — `https://www.npmjs.com/package/<name>/access`:

| field | value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `akshayDev17` |
| Repository | `ai-explainer-video` |
| Workflow filename | `release.yml` |
| Environment name | **leave empty** — the workflow declares no `environment:` |
| Allow npm publish | **leave unchecked** — this is what forces staging |
| Allow npm dist-tag | **leave unchecked** — see below |

The filename and environment must match the workflow exactly, or npm rejects the request.

**Why we can do this at all:** a package must exist on npm before a Trusted Publisher can be
attached. Both already do (0.1.0, 0.1.1), so there is no chicken-and-egg here — a brand-new
package name would need a first publish or `npm stage publish` to create it.

## Why OIDC instead of a token

- **No long-lived secret.** Nothing to store, rotate, leak, or paste into a GitHub secret.
  The credential is minted per run and dies with it.
- **Provenance comes free.** Under trusted publishing the npm CLI emits a provenance
  attestation automatically, so `--provenance` is no longer needed. Provenance requires a
  public source repo; this one is public.
- **2FA moves to the approval**, where a human is — instead of a token that bypasses it.

## Dist-tags, and what that permission is not

`Allow npm dist-tag` is for re-pointing tags on **already-published** versions — "promoting a
version to `latest`", moving `next`/`beta`. It is **not** how a release acquires `latest`:
`npm publish` sets `latest` as part of publishing, which is covered by the publish path.
Leave it unchecked. The one thing it would buy is a token-free **rollback**; enable it if and
when a rollback workflow exists.

## Gotchas worth knowing

- **CI npm must be ≥ 11.5.1.** Node 22 bundles npm 10, which cannot exchange the OIDC token —
  hence the workflow pinning `npm@11.5.1` through `npx`. This laptop's npm 10.9.8 is also why
  earlier manual publishes needed `--otp`.
- **`registry-url` is required** in `setup-node`, or the publish fails with `ENEEDAUTH`.
- **The two stages are serialized** by a `sleep`; a second registry write racing the first
  one's processing returns `409 Failed to save packument`.
- **A tag without a matching version fails the run**, deliberately — shipping the wrong
  version is the one mistake a tag-triggered release makes cheap to commit.
- **Nothing is live until you approve.** A green workflow run means "queued", not "released".

## If a release fails

- **Before staging** (the version guard) — fix it, then delete and re-push the tag:
  `git push --delete origin v0.1.3 && git tag -d v0.1.3`, then re-tag.
- **Between the two stages** — the root is queued and the wrapper is not. Re-run the job from
  the Actions tab; the root stage may error as a duplicate, which is harmless.
- **Staged but wrong** — `npm stage reject <stage-id>`, fix, re-tag. Nothing was ever
  installable, so there is nothing to un-publish.
- **Already approved and bad** — npm will not let you republish that version. Deprecate and
  move forward: `npm deprecate explainer-video-from-coursework@0.1.3 "broken — use 0.1.4"`.
  Moving `latest` back would need the dist-tag permission above.

## Deliberately not wired

- **A GitHub Release per tag** — add `contents: write` plus a `gh release create` step.
- **Tag protection** — a repository rule on `v*` stops a tag being moved or deleted.
- **A post-publish smoke test** — `npm view <pkg> version` and a clean install in a scratch
  directory, after approval, so a bad tarball is caught before anyone consumes it.
