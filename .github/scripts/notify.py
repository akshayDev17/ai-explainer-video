#!/usr/bin/env python3
"""Render the release notification and send it over SMTP.

Runs as the last step of .github/workflows/release.yml under `if: always()`, so it
sees both outcomes — and the no-op case where the gate found nothing to release.

Three rules shape this file:

  1. **It never fails a release that already succeeded.** Missing configuration is a
     loud warning and exit 0: a notifier you have not set up yet is not a broken
     build.
  2. **Once SMTP is configured, a send failure exits non-zero.** You asked to be told
     about every release, so silence is the one outcome you cannot debug. GitHub
     mails the actor when a run fails, so that mail becomes the backstop telling you
     the notifier itself broke. The release is unaffected — it was staged and tagged
     long before this step ran.
  3. **It decides the state itself**, from the step outcomes the workflow hands it.
     GitHub gives a step no idea what the steps before it did.

The transport is deliberately generic SMTP rather than one vendor's REST API, so
switching provider is a secrets change and not a code change. For Gmail it accepts
either an app password or OAuth: set OAUTH_REFRESH_TOKEN to use the latter (XOAUTH2).

Usage:
    python .github/scripts/notify.py                    # render and send
    python .github/scripts/notify.py --dry-run          # render, print, send nothing
    python .github/scripts/notify.py --dry-run --out d  # write render.html / render.txt
    python .github/scripts/notify.py --check-smtp       # prove host + auth work (SMTP or OAuth)
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from email.message import EmailMessage

ROOT = pathlib.Path(__file__).resolve().parents[2]
EMAIL_DIR = ROOT / ".github" / "email"

STATE_SUCCESS = "success"
STATE_FAILURE = "failure"
STATE_NOOP = "noop"

# Google's OAuth token endpoint. Stdlib urllib only, so the runner needs no
# Google client library — just a refresh token and the matching client id/secret.
TOKEN_URL = "https://oauth2.googleapis.com/token"

# Known failure signatures → the one line that tells you what to do about it.
# Deliberately a small table: an unmatched error still ships, just without advice.
# Plain prose, not HTML — the same string feeds the HTML and the text/plain twin,
# so markup here would leak into the text version.
HINTS: list[tuple[str, str]] = [
    (
        r'repository\.url"?\s+is\s+""',
        "npm validates the repository.url field against the repository the workflow ran in, "
        "because trusted publishing emits provenance automatically. Set it in package.json and "
        "push again — no tag was written, so the next push retries on its own.",
    ),
    (
        r"ENEEDAUTH",
        "setup-node needs registry-url, or the OIDC token exchange failed. Check the workflow's "
        "registry-url and the trusted-publisher configuration on npmjs.com.",
    ),
    (
        r"No matching version found|404 Not Found",
        "A version range in a manifest points at something not on the registry yet. Publish the "
        "package it depends on first.",
    ),
    (
        r"Failed to save packument|\b409\b",
        "Two registry writes raced. Re-run the job — nothing was half-published.",
    ),
    (
        r"\b403\b|Forbidden|not authorized",
        "The trusted publisher may not match this workflow's filename, or its permissions do not "
        "cover staging. Re-check the npmjs.com configuration.",
    ),
    (
        r"EPERM|EACCES|permission denied",
        "A filesystem permission problem on the runner.",
    ),
]


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def pick_error_lines(text: str, limit: int = 6, width: int = 400) -> tuple[list[str], bool]:
    """The most useful tail of a failed step's output, plus whether we dropped any."""
    lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return [], False
    interesting = [ln for ln in lines if re.search(r"\berror\b|ERR!|E\d{3}\b|fail", ln, re.I)]
    pool = interesting or lines
    chosen = pool[-limit:]
    truncated = len(pool) > len(chosen)
    return [ln[:width] + ("…" if len(ln) > width else "") for ln in chosen], truncated


def match_hint(text: str) -> str:
    for pattern, hint in HINTS:
        if re.search(pattern, text, re.I):
            return hint
    return ""


def human_duration(seconds: int) -> str:
    if seconds <= 0:
        return ""
    if seconds < 60:
        return f"{seconds}s"
    return f"{seconds // 60}m {seconds % 60:02d}s"


def build_context() -> dict:
    repo = env("GITHUB_REPOSITORY")
    server = env("GITHUB_SERVER_URL", "https://github.com")
    run_id = env("GITHUB_RUN_ID")
    sha = env("GITHUB_SHA")
    actor = env("GITHUB_ACTOR")
    branch = env("GITHUB_REF_NAME")
    event = env("GITHUB_EVENT_NAME", "push")
    package = env("PACKAGE", "explainer-video-from-coursework")
    version = env("VERSION") or "unknown"
    npm_user = env("NPM_USER")

    gate_outcome = env("GATE_OUTCOME")
    stage_outcome = env("STAGE_OUTCOME")
    tag_outcome = env("TAG_OUTCOME")
    release = env("GATE_RELEASE") == "true"

    # ---- decide the state -------------------------------------------------
    failed_step = ""
    if gate_outcome == "failure":
        state, failed_step = STATE_FAILURE, "Release only if this version is untagged"
    elif not release:
        state = STATE_NOOP
    elif stage_outcome == "failure":
        state, failed_step = STATE_FAILURE, "Stage the package"
    elif tag_outcome == "failure":
        state, failed_step = STATE_FAILURE, "Tag the release"
    else:
        state = STATE_SUCCESS

    # ---- the error tail --------------------------------------------------
    log_path = env("STAGE_LOG")
    raw = ""
    if log_path and pathlib.Path(log_path).is_file():
        raw = pathlib.Path(log_path).read_text(errors="replace")
    if not raw:
        raw = env("GATE_LOG_TEXT")

    error_lines, truncated = ([], False)
    hint = ""
    if state == STATE_FAILURE:
        error_lines, truncated = pick_error_lines(raw)
        hint = match_hint(raw)

    # ---- presentation ----------------------------------------------------
    success = state == STATE_SUCCESS
    try:
        start = int(env("START_EPOCH") or 0)
    except ValueError:
        start = 0
    duration = human_duration(int(time.time()) - start) if start else ""

    tag_created = success or tag_outcome == "success"
    run_url = f"{server}/{repo}/actions/runs/{run_id}" if repo and run_id else ""
    approve_url = (
        f"https://www.npmjs.com/settings/{npm_user}/staged-packages" if npm_user else ""
    )

    if success:
        heading = "RELEASE SUCCEEDED"
        subhead = "staged — waiting on your approval"
        cta_label = f"Approve {version} on npm"
        cta_url = approve_url or run_url
        footnote = (
            "Nothing is installable until you approve it."
            if approve_url
            else "Set the NPM_USER repository variable to get a direct approval link."
        )
        preheader = f"{package} {version} is staged — approve it on npm"
        subject = f"✅ release {version} staged — approve on npm"
    else:
        where = failed_step or "the release"
        heading = "RELEASE FAILED"
        subhead = f"stopped at “{where}” — nothing was published"
        cta_label = "View the failed run"
        cta_url = run_url
        footnote = (
            "No tag was written, so the next push to the branch retries automatically."
            if not tag_created
            else "The tag was written; the version may still need attention."
        )
        preheader = f"{package} {version} failed at {where}"
        subject = f"❌ release {version} failed — {where}"

    return {
        "state": state,
        "success": success,
        "subject": subject,
        "preheader": preheader,
        "heading": heading,
        "subhead": subhead,
        "accent": "#137333" if success else "#b3261e",
        "accent_text": "#ceead6" if success else "#f9dedc",
        "package": package,
        "version": version,
        "tag_created": tag_created,
        "tag_display": f"v{version}" if tag_created else "not created",
        "commit_short": sha[:7] or "unknown",
        "branch": branch or "main",
        "actor": actor or "unknown",
        "event": event,
        "duration": duration,
        "failed_step": failed_step,
        "error": error_lines,
        "truncated": truncated,
        "hint": hint,
        "cta_label": cta_label,
        "cta_url": cta_url,
        "footnote": footnote,
        "run_id": run_id,
        "run_url": run_url,
    }


def render(context: dict, out_dir: str | None, dry_run: bool) -> tuple[str, str]:
    try:
        from jinja2 import Environment, FileSystemLoader
    except ImportError:
        sys.exit("notify: jinja2 is not installed (pip install jinja2)")

    # Escape the HTML template ONLY. select_autoescape keys off the final extension,
    # so it would see "j2" on both files and escape the text twin too — turning
    # quotes in the error output into &#34; in the plain-text part.
    def autoescape(template_name: str | None) -> bool:
        return bool(template_name) and template_name.endswith(".html.j2")

    jenv = Environment(
        loader=FileSystemLoader(str(EMAIL_DIR)),
        autoescape=autoescape,
        trim_blocks=True,
        lstrip_blocks=True,
    )
    html = jenv.get_template("release.html.j2").render(**context)
    text = jenv.get_template("release.txt.j2").render(**context)

    if dry_run:
        print("─" * 72)
        print("SUBJECT:", context["subject"])
        print("─" * 72)
        print(text)
        print("─" * 72)
        print(f"html: {len(html)} bytes · text: {len(text)} bytes")
    if out_dir:
        d = pathlib.Path(out_dir)
        d.mkdir(parents=True, exist_ok=True)
        (d / "render.html").write_text(html)
        (d / "render.txt").write_text(text)
        print(f"notify: wrote {d/'render.html'} and {d/'render.txt'}")
    return html, text


def smtp_config() -> dict:
    """The transport, as data — so no provider name is baked into this file."""
    return {
        "host": env("SMTP_HOST"),
        "port": int(env("SMTP_PORT") or 587),
        "user": env("SMTP_USER"),
        # Deliberately NOT via env(): it strips, and a password may legitimately
        # begin or end with whitespace. Only strip if it is entirely blank.
        "password": os.environ.get("SMTP_PASS", ""),
        "mode": (env("SMTP_TLS") or "starttls").lower(),
        "from_name": env("MAIL_FROM_NAME") or "release",
        "oauth_client_id": env("OAUTH_CLIENT_ID"),
        "oauth_client_secret": env("OAUTH_CLIENT_SECRET"),
        "oauth_refresh_token": env("OAUTH_REFRESH_TOKEN"),
    }


def oauth_enabled(cfg: dict) -> bool:
    """OAuth mode wins whenever any of its three values is present."""
    return bool(cfg["oauth_refresh_token"] or cfg["oauth_client_id"] or cfg["oauth_client_secret"])


def fetch_access_token(cfg: dict) -> str:
    """Exchange the refresh token for a short-lived access token, stdlib only."""
    data = urllib.parse.urlencode(
        {
            "client_id": cfg["oauth_client_id"],
            "client_secret": cfg["oauth_client_secret"],
            "refresh_token": cfg["oauth_refresh_token"],
            "grant_type": "refresh_token",
        }
    ).encode("ascii")
    request = urllib.request.Request(
        TOKEN_URL,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(
            f"notify: OAuth token refresh failed — HTTP {exc.code}: {body}. The refresh token is "
            "likely revoked, or OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET no longer match the client "
            "that issued it. Re-run oauth_token.py to mint a fresh one."
        ) from None
    except urllib.error.URLError as exc:
        raise SystemExit(f"notify: could not reach Google's token endpoint — {exc.reason}") from None
    access = payload.get("access_token")
    if not access:
        raise SystemExit(f"notify: token endpoint returned no access_token — {json.dumps(payload)[:200]}")
    return access


def xoauth2(user: str, access_token: str) -> str:
    return f"user={user}\x01auth=Bearer {access_token}\x01\x01"


def connect(cfg: dict) -> smtplib.SMTP:
    """Open, upgrade and authenticate a connection. Caller closes it."""
    if cfg["mode"] == "ssl":
        server = smtplib.SMTP_SSL(
            cfg["host"], cfg["port"], timeout=30, context=ssl.create_default_context()
        )
    else:
        server = smtplib.SMTP(cfg["host"], cfg["port"], timeout=30)
        server.ehlo()
        if cfg["mode"] != "none":
            server.starttls(context=ssl.create_default_context())
            server.ehlo()
    if oauth_enabled(cfg):
        if not cfg["user"]:
            raise SystemExit(
                "notify: OAuth mode needs SMTP_USER set to the authorized Gmail address"
            )
        access = fetch_access_token(cfg)
        # authobject is called with no args for the SASL initial response, and
        # with the challenge bytes if Gmail challenges — return the same string.
        server.auth("XOAUTH2", lambda *_: xoauth2(cfg["user"], access))
    elif cfg["user"]:
        server.login(cfg["user"], cfg["password"])
    return server


def smtp_failure(exc: BaseException, cfg: dict) -> str:
    """Turn an smtplib exception into the one sentence that says what to fix."""
    # SMTPAuthenticationError subclasses SMTPResponseException, so it goes first.
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        if oauth_enabled(cfg):
            return (
                f"notify: OAuth (XOAUTH2) was rejected ({exc.smtp_code} {exc.smtp_error!r}) for "
                f"{cfg['user']!r}. The refresh token is stale or its scope is wrong — re-run "
                "oauth_token.py to mint a fresh one, and check OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET match "
                "the client that issued it."
            )
        return (
            f"notify: SMTP login was rejected ({exc.smtp_code} {exc.smtp_error!r}) for user "
            f"{cfg['user']!r}. Check SMTP_USER/SMTP_PASS against the provider's SMTP "
            "credentials — several providers issue these separately from your dashboard "
            "login, and some allow only one active SMTP user on a free tier."
        )
    if isinstance(exc, smtplib.SMTPSenderRefused):
        return (
            f"notify: the server refused the sender address {exc.sender!r} "
            f"({exc.smtp_code} {exc.smtp_error!r}). Most providers accept mail only from a "
            "sender you have verified in their dashboard, so verify MAIL_FROM first."
        )
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        detail = "; ".join(f"{a}: {c} {m!r}" for a, (c, m) in exc.recipients.items())
        return f"notify: the server refused every recipient — {detail}"
    if isinstance(exc, smtplib.SMTPResponseException):
        return f"notify: the server rejected the message — {exc.smtp_code} {exc.smtp_error!r}"
    if isinstance(exc, smtplib.SMTPException):
        return f"notify: SMTP error — {exc}"
    if isinstance(exc, ssl.SSLError):
        return (
            f"notify: TLS failed talking to {cfg['host']}:{cfg['port']} — {exc}. Port 587 "
            "usually wants SMTP_TLS=starttls and port 465 wants SMTP_TLS=ssl."
        )
    if isinstance(exc, OSError):
        return f"notify: could not reach {cfg['host']}:{cfg['port']} — {exc}"
    return f"notify: could not send — {type(exc).__name__}: {exc}"


def send_via_smtp(cfg: dict, sender: str, to: list[str], subject: str, text: str, html: str) -> None:
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = f"{cfg['from_name']} <{sender}>"
    msg["To"] = ", ".join(to)
    # set_content + add_alternative builds multipart/alternative with the right
    # part order, so clients that render HTML take it and the rest fall back.
    msg.set_content(text)
    msg.add_alternative(html, subtype="html")

    with connect(cfg) as server:
        refused = server.send_message(msg, from_addr=sender, to_addrs=to)

    if refused:
        detail = "; ".join(f"{a}: {c} {m!r}" for a, (c, m) in refused.items())
        raise SystemExit(f"notify: the server refused some recipients — {detail}")
    print(f"notify: sent to {len(to)} recipient(s) via {cfg['host']}:{cfg['port']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="render and print, send nothing")
    parser.add_argument("--out", metavar="DIR", help="write render.html / render.txt into DIR")
    parser.add_argument("--force", action="store_true", help="also send for a no-op run")
    parser.add_argument(
        "--check-smtp",
        action="store_true",
        help="connect and authenticate, then stop — sends nothing",
    )
    args = parser.parse_args()

    cfg = smtp_config()

    # Standalone credential check, so you can prove host/user/pass on a laptop with
    # no CI environment at all. Deliberately before any release state is read.
    if args.check_smtp:
        if not cfg["host"]:
            print("notify: SMTP_HOST is not set — nothing to check", file=sys.stderr)
            return 1
        try:
            with connect(cfg) as _server:
                if oauth_enabled(cfg):
                    who = f"authenticated as {cfg['user']} via OAuth"
                elif cfg["user"]:
                    who = f"authenticated as {cfg['user']}"
                else:
                    who = "no auth"
                print(f"notify: SMTP ok — {cfg['host']}:{cfg['port']} ({cfg['mode']}, {who})")
        except SystemExit as exc:
            print(str(exc), file=sys.stderr)
            return 1
        except Exception as exc:  # noqa: BLE001 — the message is the entire point
            print(smtp_failure(exc, cfg), file=sys.stderr)
            return 1
        return 0

    context = build_context()

    if context["state"] == STATE_NOOP and not args.force:
        print("notify: nothing was released (version already tagged) — not sending")
        return 0

    html, text = render(context, args.out, args.dry_run)
    if args.dry_run:
        return 0

    sender = env("MAIL_FROM")
    to = [a.strip() for a in env("MAIL_TO").replace(";", ",").split(",") if a.strip()]

    if oauth_enabled(cfg):
        required = (
            ("SMTP_HOST", cfg["host"]),
            ("SMTP_USER", cfg["user"]),
            ("OAUTH_CLIENT_ID", cfg["oauth_client_id"]),
            ("OAUTH_CLIENT_SECRET", cfg["oauth_client_secret"]),
            ("OAUTH_REFRESH_TOKEN", cfg["oauth_refresh_token"]),
            ("MAIL_FROM", sender),
            ("MAIL_TO", to),
        )
        advice = (
            "Set OAUTH_CLIENT_SECRET and OAUTH_REFRESH_TOKEN as secrets, and "
            "OAUTH_CLIENT_ID/SMTP_HOST/SMTP_USER/MAIL_FROM/MAIL_TO as variables."
        )
    else:
        required = (
            ("SMTP_HOST", cfg["host"]),
            ("SMTP_PASS", cfg["password"].strip() if cfg["user"] else "(not needed)"),
            ("MAIL_FROM", sender),
            ("MAIL_TO", to),
        )
        advice = (
            "Set SMTP_PASS as a repository secret and SMTP_HOST/SMTP_USER/MAIL_FROM/"
            "MAIL_TO as repository variables."
        )
    missing = [name for name, value in required if not value]
    if missing:
        # Unconfigured is not broken. Warn loudly, but do not fail a release that
        # already succeeded because you have not set up email yet.
        print(
            "notify: WARNING — not sending: missing " + ", ".join(missing) + ". " + advice
            + " The release itself is unaffected.",
            file=sys.stderr,
        )
        return 0

    try:
        send_via_smtp(cfg, sender, to, context["subject"], text, html)
    except SystemExit as exc:
        # Configured but undelivered: that is a real problem, and a green run would
        # tell you nothing. GitHub mails the actor on failure, so you still hear
        # about it even though this mail did not go out.
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 — the message is the entire point
        print(smtp_failure(exc, cfg), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
