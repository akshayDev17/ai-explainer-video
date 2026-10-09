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

> **npmjs.com → Settings → Staged Packages**
> (`https://www.npmjs.com/settings/<your-username>/staged-packages`)
> → find the version → **Approve**. There is also **Inspect**, which downloads the tarball so
> you can open it *before* it goes live — the whole reason the extra click is worth it.
>
> No terminal is involved, and nothing is installable until you approve it.

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
- **Token publishing is being retired.** npm's own site carries the notice: tokens that bypass
  2FA are being restricted — account changes from August 2026, and **direct publishing from
  January 2027**. This setup is the destination, not a detour.

## The release email

The workflow ends with a **Notify** step that renders
[`release.html.j2`](./.github/email/release.html.j2) — plus a `text/plain` twin — with Jinja, and
sends it over **plain SMTP**. It runs under `if: always()`, so failures are reported too.

The transport is deliberately generic rather than one vendor's REST API. Every provider worth using
speaks SMTP, so changing provider is a change of repository variables rather than a change of code —
which matters, because most of the free email tiers have quietly stopped being free (see
[Why not a dedicated email API](#why-not-a-dedicated-email-api)).

Four things it does deliberately:

- **It stays silent on a no-op run.** The workflow fires on every push to `main` but only acts on a
  version bump, so a docs-only commit is green and releases nothing. Emailing that would be one mail
  per commit.
- **It says "staged", not "released".** A green run means the version is queued in npm's staging area,
  so the most useful line in the mail is the approval link, not the commit hash.
- **Unconfigured is not broken.** With no SMTP settings it warns in the log and exits 0: a notifier
  you have not set up yet must not fail a release that did succeed.
- **A configured send that fails exits 1.** The opposite case is worth a red run. You asked to be
  told about every release, and silence is the one outcome you cannot debug — so if the mail cannot
  go out, the run should say so. GitHub emails the actor when a run fails, which makes that mail the
  backstop telling you the notifier itself broke. Either way the release is unaffected: it was staged
  and tagged before this step ran.

### One-time setup (Gmail SMTP)

The notifier sends through a Gmail account using an **App Password**. It is the one option that costs
nothing and needs no new account, no domain, no card and no signup review — which is more than can be
said for most of the email APIs now (see [Why not a dedicated email API](#why-not-a-dedicated-email-api)).

1. Turn on **2-Step Verification** for the Google account: <https://myaccount.google.com/security>.
   App passwords do not exist without it, and the page in the next step will simply not offer them.

2. Create an **App Password**: <https://myaccount.google.com/apppasswords>. Google shows the
   16-character password once. The spaces it displays are cosmetic — keep them or drop them, both work.

3. Add these under *Settings → Secrets and variables → Actions*:

   | kind | name | value |
   |---|---|---|
   | secret | `SMTP_PASS` | the 16-character app password |
   | variable | `SMTP_HOST` | `smtp.gmail.com` |
   | variable | `SMTP_USER` | your full Gmail address |
   | variable | `MAIL_FROM` | the same address — Gmail sends as the authenticated account |
   | variable | `MAIL_TO` | where it goes; comma-separated for several |
   | variable | `NPM_USER` | your npm username, for the approval link (`akshaydev17`) |

   Leave `SMTP_PORT` and `SMTP_TLS` unset: the defaults are `587` and `starttls`, which is what Gmail
   wants.

4. Prove the credentials without sending anything:

   ```sh
   SMTP_HOST=smtp.gmail.com SMTP_USER=you@gmail.com SMTP_PASS='abcd efgh ijkl mnop' \
     python .github/scripts/notify.py --check-smtp
   ```

   This only connects and authenticates — it does not even need `jinja2` — so it is the fastest way
   to tell a wrong app password from a blocked connection or a refused sender.

**Three things to know about that app password:**

- **Changing your Google password revokes it.** Google: *"we revoke your app passwords when you change
  your Google Account password."* The next release then fails its Notify step and the run goes red —
  which is the notification working as designed. Reissue the password and update the secret.
- **It can send mail as you.** It is scoped to mail, but it is a real credential. Keep it in *secrets*,
  never in a variable, and never in a file in the repo.
- **Google caps consumer accounts at 500 recipients and 500 messages per day.** A release notifier is
  nowhere near that. A loop that mailed on every commit would find it quickly.

### Previewing without sending

The renderer has a dry run that needs no credentials:

```sh
python -m pip install jinja2
GITHUB_REPOSITORY=akshayDev17/ai-explainer-video GITHUB_RUN_ID=1 GITHUB_SHA=abc1234 \
GITHUB_ACTOR=you GITHUB_REF_NAME=main VERSION=0.1.2 GATE_RELEASE=true \
GATE_OUTCOME=success STAGE_OUTCOME=failure TAG_OUTCOME=skipped \
STAGE_LOG=/tmp/err.log PACKAGE=explainer-video-from-coursework NPM_USER=yourname \
python .github/scripts/notify.py --dry-run --out /tmp/preview
```

Open `/tmp/preview/render.html`. Point `STAGE_LOG` at any failed step's output to see how the Error
row renders: it pulls the error lines out of the log, truncates **server-side** (rather than hiding
them behind a scroll some clients can't perform), and matches them against a small table of known
failures to fill the "what to do" row.

### Why not a dedicated email API

Because most of the free tiers quietly stopped being free. This was checked against the providers'
own pages rather than their marketing, and it is the reason the notifier speaks generic SMTP instead
of one vendor's REST API:

- **SendGrid** — since 25 March 2025, new accounts get a **60-day trial**. Their support article:
  *"After the 60 day trial period, email send via any web API or SMTP integration for the account will
  stop unless an appropriate 'Email API' plan is chosen before then."* Paid starts at $19.95/mo.
- **Mailtrap** — requires a domain you control: *"Can I send emails without my domain? No, you can't."*
- **AWS SES** — no per-email free grant any more, only a 6-month credit window, and every new account
  starts in a sandbox capped at *"a maximum of 200 messages per 24-hour period"*.
- **Azure Communication Services Email** — no free tier at all.
- **SMTP2GO** — turns free-mail signups away at the door: *"Sorry, we don't allow email addresses at
  public domains such as Gmail and Yahoo."* Phone verification is mandatory as well.
- **MailerSend** — wants a card even on the free plan: *"we just ask that you provide this information
  to prevent abuse of the platform."*

If you ever do want a provider, the free tier being generous tells you nothing about whether they
will let you in the door — so the table below is about **admission**, not pricing. Everything in it
was checked against the providers' own signup forms and docs. Because the transport is plain SMTP,
moving to one is a change of repository variables, not of code:

| Provider | Free tier | Signing up and sending from a personal address |
|---|---|---|
| **Mailjet** | 6,000/mo, 200/day, no card | ✅ The frictionless one. No phone step; the sender validates with a confirmation link. Caveat: new accounts can land in a "Test Mode" capped at 10 emails/hour until support verifies your details, and upgrading does *not* lift it. |
| **Resend** | 3,000/mo, 100/day | ⚠️ Open signup, but **no DNS-free sending at all** — without a verified domain the `resend.dev` test domain delivers only to your own account address. Perfect for a notifier like this one, useless for anything broader. |
| **Elastic Email** | 3,000/mo, 100/day, no card, no expiry | ❌ Blocks *activation*, not signup: *"You need to verify your phone number before you can send."* And their docs say a single-address sender cannot be on a free provider like Gmail — so with no domain you have no usable `From` anyway. |
| **Brevo** | 300/day, no card, no time limit | ⚠️ A phone/identity step sits in the default onboarding, and generating the SMTP key itself demands *"the verification code sent to your device"* — so a fully hands-off setup breaks there. |
| **Postmark** | 100/mo, unlimited/day, no card | ❌ Refuses Gmail, Yahoo, Outlook, iCloud, AOL and Proton at signup — same wording as SMTP2GO — *and* the sender signature *"needs to be a private domain that you have access to"*. Despite the generous numbers, it is unreachable without a domain. |
| **Mailgun** | 100/day, no card | ❌ *"Do I have to use a domain to send email? Yes."* Without one you get a sandbox domain capped at **5 Authorized Recipients**, plus mandatory phone OTP at activation. |

`SMTP_USER` is the field that trips people up, and at most of these it is **not** your email address:

- **Resend** — the literal string `resend`, with your API key as the password.
- **Mailjet** — the **API key** as username, the **Secret key** as password.
- **Brevo** — either your account email or a generated `[ID]@smtp-brevo.com`, with a generated **SMTP
  key** (not its API key). Changing your login email does not change the SMTP login.
- **Elastic Email** — your account email, with a generated SMTP credential as the password.
- **Postmark** — the Server API Token is *both* the username and the password.

Run `--check-smtp` after any change; it reports which of those you got wrong.

One claim to be careful of if you go looking: the idea that free plans allow only **one SMTP user or
key** is not true of any provider checked here. Elastic Email documents 15 credentials per account,
Mailjet's one-subaccount limit is a different thing, and Resend and Postmark have no SMTP-user concept
at all.

### Why not just GitHub's own email

GitHub will email you about workflow runs natively — *Settings → Notifications → System → Actions* —
with no code at all. But the template is fixed: no version, no tag, no error text, and no link to the
npm approval page. It cannot replace this one.

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

- **CI npm must be ≥ 11.15.0.** Two separate floors: the OIDC token exchange landed in
  11.5.1, and `npm stage` needs 11.15.0 — so 11.15.0 is the real floor, hence the workflow
  pinning it through `npx`. Staging also requires Node ≥ 22.14.0; the workflow's
  `node-version: "22"` resolves to the newest 22.x, which satisfies it. This laptop's npm
  10.9.8 is why earlier manual publishes needed `--otp`.
- **`registry-url` is required** in `setup-node`, or the publish fails with `ENEEDAUTH`.
- **`repository.url` must point at this GitHub repo.** Provenance is emitted automatically
  under trusted publishing, and npm validates that field against the repository the workflow
  ran in — without it the stage fails
  `422 ... Error verifying sigstore provenance bundle: "repository.url" is ""`. A package with
  no `repository` field cannot use trusted publishing at all.
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
