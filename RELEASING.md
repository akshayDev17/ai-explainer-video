# Releasing

**One** npm package ships from this repo, and it serves all four platforms. GitHub Actions
publishes it on demand. No npm token exists anywhere, and no publish ever runs on a laptop.

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

## A release is a button click

Normal commits to `main` do **nothing** — no version, no tag, no email. A release happens only
when you deliberately run the workflow by hand: **Actions → release → Run workflow**.

The form asks two things:

- **bump** — `patch` (default) / `minor` / `major`. Leave it on `patch` for a routine fix.
- **version** — optional. Type an explicit version like `0.3.0` to override the bump.

Click **Run workflow** and CI does the rest: it computes the next version from the latest tag,
bumps `package.json`, `plugin.json` and `.claude-plugin/plugin.json` in lockstep, publishes
straight to npm, and only then commits + tags `v<version>`. If the publish fails, nothing is
committed or tagged — the next run recomputes the same version and retries cleanly.

The release is **live immediately** — there is no second approval step. The manual click is the
single gate: clicking Run workflow *is* the "ship this now" decision.

## Why direct, not staged

npm offers **staged publishing** — CI queues a version, then a human approves it in the browser
before it goes live. We used it for a while and dropped it: with a manual release, that approval
was a *second* gate on top of the click, and it caused version drift — a rejected staged version
left a dangling git tag, so the next release skipped a version number that had never actually
shipped.

Direct publish has exactly one gate (the click) and one source of truth (the tag and the npm
version are created together). For a solo maintainer who already has to click the button, the
second gate was pure friction.

## One-time setup: a Trusted Publisher

npm has to be told which workflow may publish. Once, for this one package, at
`https://www.npmjs.com/package/explainer-video-from-coursework/access`:

| field | value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `akshayDev17` |
| Repository | `ai-explainer-video` |
| Workflow filename | `release.yml` |
| Environment name | **leave empty** — the workflow declares no `environment:` |
| Allow npm publish | **check it** — this is what permits direct publish |
| Allow npm dist-tag | **leave unchecked** — see below |

The filename and environment must match the workflow exactly, or npm rejects the request.

## Why OIDC instead of a token

- **No long-lived secret.** Nothing to store, rotate, leak, or paste into a GitHub secret.
  The credential is minted per run and dies with it.
- **Provenance comes free.** Under trusted publishing the npm CLI emits a provenance
  attestation automatically, so `--provenance` is no longer needed. Provenance requires a
  public source repo; this one is public.
- **The human gate is the trigger.** The only way to publish is a maintainer clicking Run workflow —
  no long-lived token to leak, no way for a stray push to ship silently.
- **Publish tokens are being retired; trusted publishing is the replacement.** npm is restricting
  2FA-bypassing access tokens (account changes August 2026, direct token publish from January 2027).
  OIDC trusted publishing is unaffected — which is why this uses it.

## The release email

The workflow ends with a **Notify** step that renders
[`release.html.j2`](./.github/email/release.html.j2) — plus a `text/plain` twin — with Jinja, and
sends it over **plain SMTP**. It runs under `if: always()`, so failures are reported too.

The transport is deliberately generic SMTP rather than one vendor's REST API, so the provider is a
config choice rather than a code change. It talks to a Gmail account — the reason for that is in
[why not an email API](#why-not-an-email-api) below.

Four things it does deliberately:

- **It emails once per release, never per commit.** There is no push trigger, so ordinary commits
  never run the notifier at all. The only email is for the release you deliberately triggered.
- **It says "published", not "queued".** A green run means the version is live on npm, so the mail
  links the package page rather than asking for an approval click.
- **Unconfigured is not broken.** With no SMTP settings it warns in the log and exits 0: a notifier
  you have not set up yet must not fail a release that did succeed.
- **A configured send that fails exits 1.** The opposite case is worth a red run. You asked to be
  told about every release, and silence is the one outcome you cannot debug — so if the mail cannot
  go out, the run should say so. GitHub emails the actor when a run fails, which makes that mail the
  backstop telling you the notifier itself broke. Either way the release is unaffected: it was
  published and tagged before this step ran.

### One-time setup (Gmail)

The notifier sends through a Gmail account. Two ways to authenticate — pick one. **OAuth** is
recommended: no app password, works even when Google withholds app passwords (passkey-only 2FA), and
its credential survives password changes and is revocable per-client. It is not narrower than an app
password, though — SMTP has no send-only scope, so the token covers full Gmail (read and send). An
**App Password** is simpler on paper but is gated behind the right 2FA method.

#### Option A — OAuth (XOAUTH2)

1. In the Google Cloud console: create a project, enable the **Gmail API**, configure the **OAuth
   consent screen** (user type **External**, add yourself as a test user, and add the
   `https://mail.google.com/` scope), then create an **OAuth client** of type
   **Desktop app** and download its `client_secret_*.json`. Google's own walkthrough — modulo the
   scope — is <https://ai.google.dev/gemini-api/docs/oauth>.

   **Publishing status matters.** Google expires refresh tokens for OAuth clients in **Testing**
   status after 7 days. Set the app to **In production** (Google Auth platform → Audience →
   publishing status) so the token lasts indefinitely. It stays "unverified" — fine for a
   single-user app — but stops expiring.

2. Run the one-time helper. It opens a browser and prints the values to paste:

   ```sh
   python3 -m pip install --quiet google-auth-oauthlib
   python3 .github/scripts/oauth_token.py --secrets ~/Downloads/client_secret_*.json
   ```

   Sign in as the account you send from, and click through the expected "Google hasn't verified this
   app" screen (Advanced → continue).

3. Add these under *Settings → Secrets and variables → Actions*:

   | kind | name | value |
   |---|---|---|
   | secret | `OAUTH_CLIENT_SECRET` | the client secret |
   | secret | `OAUTH_REFRESH_TOKEN` | the refresh token the helper printed |
   | variable | `OAUTH_CLIENT_ID` | the client id |
   | variable | `SMTP_HOST` | `smtp.gmail.com` |
   | variable | `SMTP_USER` | the authorized Gmail address |
   | variable | `MAIL_FROM` | the same address |
   | variable | `MAIL_TO` | where it goes |
   | variable | `MAIL_FROM_NAME` | optional display name — see below |

   There is no `SMTP_PASS`: the access token is minted fresh on every run from the refresh token, and
   the refresh token lives in a secret.

4. Prove it:

   ```sh
   SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com \
   OAUTH_CLIENT_ID=… OAUTH_CLIENT_SECRET=… OAUTH_REFRESH_TOKEN=… \
     python .github/scripts/notify.py --check-smtp
   ```

#### Option B — App Password

1. Turn on **2-Step Verification** for the Google account: <https://myaccount.google.com/security>.
   App passwords do not exist without it, and Google withholds them for passkey-only accounts.

2. Create an **App Password**: <https://myaccount.google.com/apppasswords>. Google shows the
   16-character password once. Paste it into the secret **without the spaces**.

3. Add these under *Settings → Secrets and variables → Actions*:

   | kind | name | value |
   |---|---|---|
   | secret | `SMTP_PASS` | the 16-character app password |
   | variable | `SMTP_HOST` | `smtp.gmail.com` |
   | variable | `SMTP_USER` | your full Gmail address |
   | variable | `MAIL_FROM` | the same address — Gmail sends as the authenticated account |
   | variable | `MAIL_TO` | where it goes; comma-separated for several |
   | variable | `MAIL_FROM_NAME` | optional display name — see below |

4. Prove it:

   ```sh
   SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS='abcdefghijklmnop' \
     python .github/scripts/notify.py --check-smtp
   ```

   **App-password caveats.** Changing your Google password revokes it. It can send *and* read mail.
   Google caps consumer accounts at 500 recipients / 500 messages a day — nowhere near a release
   notifier.

Both options leave `SMTP_PORT` and `SMTP_TLS` unset: the defaults are `587` and `starttls`, which is
what Gmail wants.

**On the sender address.** You cannot send as `noreply@github.com`, or as anything on a domain you do
not own. GitHub can send as `github.com` because they publish SPF and DKIM records for it; a provider
can neither verify nor authenticate an address you cannot receive at, and mail claiming to be GitHub
from a non-GitHub IP fails that domain's DMARC policy. So `MAIL_FROM` has to be an address you can
actually read — which, without a domain, means this same Gmail account.

What you *can* choose freely is the **display name**. Set `MAIL_FROM_NAME` to something like
`explainer-video releases` and the inbox shows `explainer-video releases <you@gmail.com>`: the address
stays honest, the label reads like a project rather than a stray personal email. That is where project
identity lives until you own a domain.

### Previewing without sending

The renderer has a dry run that needs no credentials:

```sh
python -m pip install jinja2
GITHUB_REPOSITORY=akshayDev17/ai-explainer-video GITHUB_RUN_ID=1 GITHUB_SHA=abc1234 \
GITHUB_ACTOR=you GITHUB_REF_NAME=main VERSION=0.2.0 RELEASED=true RELEASE_OUTCOME=success \
PACKAGE=explainer-video-from-coursework \
python .github/scripts/notify.py --dry-run --out /tmp/preview
```

Open `/tmp/preview/render.html`. For a failure preview, set `RELEASE_OUTCOME=failure` and
`RELEASE_LOG=/tmp/err.log` (point it at any failed step's output). The Error row pulls the error lines
out of the log, truncates **server-side** (rather than hiding them behind a scroll some clients can't
perform), and matches them against a small table of known failures to fill the "what to do" row.

### Why not an email API

Gmail is the only sender available without owning a domain. The free email APIs either demand a "work
email" on a private domain at signup — SMTP2GO rejects it with *"we don't allow email addresses at
public domains such as Gmail and Yahoo"*, and Postmark refuses Gmail, Yahoo, Outlook and iCloud
outright — or they insist you authenticate a domain before you can send to anyone but yourself. A
domain (roughly $10/year) is what unlocks them, and since the transport is plain SMTP, moving to one
is a change of variables rather than of code.

The one worth recording by name is **SendGrid**, which was the free default here until it wasn't:
since 25 March 2025 new accounts get a **60-day trial**, after which *"email send via any web API or
SMTP integration for the account will stop"* until you pay from $19.95/mo.

### Why not just GitHub's own email

GitHub will email you about workflow runs natively — *Settings → Notifications → System → Actions* —
with no code at all. But the template is fixed: no version, no tag, no error text, and no link to the
package page. It cannot replace this one.

It is still worth leaving on, because it is the **backstop**. If the Gmail app password is revoked or
the SMTP settings go stale, this notifier fails its step by design — so the run goes red and GitHub's
own mail is what reaches you even though the release mail could not.

## Dist-tags, and what that permission is not

`Allow npm dist-tag` is for re-pointing tags on **already-published** versions — "promoting a
version to `latest`", moving `next`/`beta`. It is **not** how a release acquires `latest`:
`npm publish` sets `latest` as part of publishing, which the publish path already covers.
Leave it unchecked. The one thing it would buy is a token-free **rollback**; enable it if and
when a rollback workflow exists.

## Gotchas worth knowing

- **The publish pins npm 11.15.0.** Node 22's bundled npm 10 is too old for the OIDC token exchange
  (which landed in 11.5.1), so the workflow runs `npx --yes npm@11.15.0 publish`. Node ≥ 22.14.0 is
  also required; `node-version: "22"` resolves to the newest 22.x.
- **`registry-url` is required** in `setup-node`, or the publish fails with `ENEEDAUTH`. The
  workflow's `npx npm publish` reads the registry config that `setup-node` writes.
- **`repository.url` must point at this GitHub repo.** Provenance is emitted automatically
  under trusted publishing, and npm validates that field against the repository the workflow
  ran in — without it the publish fails
  `422 ... Error verifying sigstore provenance bundle: "repository.url" is ""`. A package with
  no `repository` field cannot use trusted publishing at all.
- **The gate is the manual button, not the push.** Normal commits to `main` do nothing; only a
  manually-dispatched run releases. The version is committed and tagged only after a successful
  publish, so a failed publish never consumes a version.
- **The release is live immediately.** A green run means the version is on npm, not queued.
- **DSH needs no dependency declared.** `lib/index.js` imports
  `@deepseek-ai/dsh-skill-filesystem` without declaring it: the harness's module fallback
  supplies it, verified end to end. That keeps the manifest Claude Code and Codex install
  free of any DeepSeek reference.

## If a release fails

- **The publish failed** — the release email carries the tail of `release.log`. Because publishing
  happens *before* commit + tag, nothing was committed or tagged: the next manual run recomputes the
  same version and retries cleanly.
- **Published and bad** — npm will not let you republish that version. Release the next one and
  `npm deprecate explainer-video-from-coursework@X.Y.Z "broken — use <next>"`.

## Deliberately not wired

- **A GitHub Release per tag** — a `gh release create` step after the tag push.
- **Tag protection** — a repository rule on `v*` stops a tag being moved or deleted.
- **A post-publish smoke test** — `npm view <pkg> version` and a clean install in a scratch
  directory, after publish, so a bad tarball is caught before anyone consumes it.
