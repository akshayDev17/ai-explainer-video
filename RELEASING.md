# Releasing

**One** npm package ships from this repo, and it serves all four platforms. GitHub Actions
stages it; you approve it. No npm token exists anywhere, and no publish ever runs on a laptop.

| package | read by |
|---|---|
| `explainer-video-from-coursework` | Claude Code, Codex (npm) · DeepSeek Harness (npm) · Antigravity (git) |

The one package carries three manifest surfaces, and each consumer reads only its own:

| file | read by |
|---|---|
| `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` | Claude Code |
| `plugin.json` (root) + `.agents/plugins/marketplace.json` | Codex, Antigravity |
| `dsh.bundle.patch` → `cordis.patch.yml` → `lib/index.js` | DeepSeek Harness |

`skills/` holds all nine skills once, and every surface points at that single copy.

## A release is a version bump, then an approval

```sh
# 1. bump the version in all three places it is duplicated
#    package.json · plugin.json · .claude-plugin/plugin.json
# 2. commit and push to main — CI stages it
git commit -am "chore(release): v0.1.3"
git push origin main
```

Every push to `main` runs the workflow, but it only **acts** when `package.json`'s version
has no tag yet — ordinary commits are a no-op, and you never type `git tag`. After a
successful stage the workflow creates `v<version>` itself: that tag is the release record,
and it is what makes the guard unambiguous on the next push.

Then approve what CI queued — **in the browser**:

> **npmjs.com → the "Staged Packages" tab** → pick the version → click **Approve**.
>
> That is npm's own documented path, so no terminal is involved. You are prompted for 2FA
> either way, and nothing is installable until you approve it.

The CLI works too, if you'd rather:

```sh
npx npm@latest stage list                      # the staged version, with its stage id
npx npm@latest stage download <stage-id>       # optional: open the tarball and look
npx npm@latest stage approve <stage-id> --otp <6-digit code>
```

`npx npm@latest` rather than plain `npm`, because the npm on this laptop is **10.9.8**,
which predates `npm stage` entirely.

**One approval per release.** On the CLI, `npm stage reject <stage-id>` drops a queued
version instead of approving it.

## Why staged rather than direct

The trusted publisher is configured with **"Allow npm publish" unchecked**, so the
workflow's OIDC credential can queue a version but cannot make it live. That closes a hole
provenance does *not* close: if the release workflow were ever compromised, the provenance
attestation would still verify perfectly — because the code really did come from this repo.
Staging is the control that stops it, since a human sees the version before anyone can
install it. `npm stage download` exists so you can inspect the tarball first.

Checking that box instead would make a tag go live with no human in the loop; npm labels it
"Not recommended" for exactly this reason.

## One-time setup: a Trusted Publisher

npm has to be told which workflow may stage. Once, for this one package, at
`https://www.npmjs.com/package/explainer-video-from-coursework/access`:

| field | value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `akshayDev17` |
| Repository | `ai-explainer-video` |
| Workflow filename | `release.yml` |
| Environment name | **leave empty** — the workflow declares no `environment:` |
| Allow npm publish | **leave unchecked** — this is what forces staging |
| Allow npm dist-tag | **leave unchecked** — see below |

Also set **Publishing access** to *"Require two-factor authentication and disallow bypass 2fa
tokens"*. Your documented fallback (`npm publish --otp`) already satisfies 2FA, so this costs
you nothing and closes the one path that ships without a second factor.

The filename and environment must match the workflow exactly, or npm rejects the request.

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
`npm publish` sets `latest` as part of publishing, which the publish path already covers.
Leave it unchecked. The one thing it would buy is a token-free **rollback**; enable it if and
when a rollback workflow exists.

## Gotchas worth knowing

- **CI npm must be ≥ 11.15.0.** Two separate floors: the OIDC token exchange landed in
  11.5.1, and `npm stage` needs 11.15.0 — so 11.15.0 is the real floor, hence the workflow
  pinning it through `npx`. Staging also requires Node ≥ 22.14.0; the workflow's
  `node-version: "22"` resolves to the newest 22.x, which satisfies it. This laptop's npm
  10.9.8 is why earlier manual publishes needed `--otp`.
- **`registry-url` is required** in `setup-node`, or the publish fails with `ENEEDAUTH`.
- **The gate is the tag, not the push.** A push to `main` that doesn't change the version
  does nothing; an untagged version is staged once and then tagged, so re-pushing the same
  commit cannot double-release.
- **Nothing is live until you approve.** A green workflow run means "queued", not "released".
- **DSH needs no dependency declared.** `lib/index.js` imports
  `@deepseek-ai/dsh-skill-filesystem` without declaring it: the harness's module fallback
  supplies it, verified end to end. That keeps the manifest Claude Code and Codex install
  free of any DeepSeek reference.

## If a release fails

- **The stage failed** — the job stops before tagging, so the next push to `main` simply
  retries. Nothing was queued and no tag was written.
- **Staged but wrong** — `npm stage reject <stage-id>`, fix, and push a new version. Only
  reuse the same version after deleting its tag:
  `git push --delete origin v0.1.3 && git tag -d v0.1.3`.
- **Already approved and bad** — npm will not let you republish that version. Bump and move
  forward: `npm deprecate explainer-video-from-coursework@0.1.3 "broken — use 0.1.4"`.
  Moving `latest` back would need the dist-tag permission above.

## Deliberately not wired

- **A GitHub Release per tag** — add `contents: write` plus a `gh release create` step.
- **Tag protection** — a repository rule on `v*` stops a tag being moved or deleted.
- **A post-publish smoke test** — `npm view <pkg> version` and a clean install in a scratch
  directory, after approval, so a bad tarball is caught before anyone consumes it.
