#!/usr/bin/env python3
"""Render the release notification and send it through SendGrid's v3 API.

Runs as the last step of .github/workflows/release.yml under `if: always()`, so it
sees both outcomes — and the no-op case where the gate found nothing to release.

Two rules shape this file:

  1. **It never fails the job.** A notification problem must not mark a release
     that actually succeeded as failed. Missing configuration is a loud warning
     and exit 0.
  2. **It decides the state itself**, from the step outcomes the workflow hands
     it. GitHub gives a step no idea what the steps before it did.

Usage:
    python .github/scripts/notify.py                  # render and send
    python .github/scripts/notify.py --dry-run         # render, print, send nothing
    python .github/scripts/notify.py --dry-run --out d # write render.html / render.txt
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send"

ROOT = pathlib.Path(__file__).resolve().parents[2]
EMAIL_DIR = ROOT / ".github" / "email"

STATE_SUCCESS = "success"
STATE_FAILURE = "failure"
STATE_NOOP = "noop"

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


def send(api_key: str, sender: str, to: list[str], subject: str, html: str, text: str) -> None:
    payload = {
        "personalizations": [{"to": [{"email": addr} for addr in to], "subject": subject}],
        "from": {"email": sender, "name": "release"},
        "content": [
            {"type": "text/plain", "value": text},
            {"type": "text/html", "value": html},
        ],
    }
    request = urllib.request.Request(
        SENDGRID_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            # SendGrid answers 202 Accepted with an empty body.
            print(f"notify: sent — HTTP {response.status}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"notify: SendGrid rejected the message — HTTP {exc.code}: {body}") from None
    except urllib.error.URLError as exc:
        raise SystemExit(f"notify: could not reach SendGrid — {exc.reason}") from None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="render and print, send nothing")
    parser.add_argument("--out", metavar="DIR", help="write render.html / render.txt into DIR")
    parser.add_argument("--force", action="store_true", help="also send for a no-op run")
    args = parser.parse_args()

    context = build_context()

    if context["state"] == STATE_NOOP and not args.force:
        print("notify: nothing was released (version already tagged) — not sending")
        return 0

    html, text = render(context, args.out, args.dry_run)
    if args.dry_run:
        return 0

    api_key = env("SENDGRID_API_KEY")
    sender = env("MAIL_FROM")
    to = [a.strip() for a in env("MAIL_TO").replace(";", ",").split(",") if a.strip()]

    missing = [
        name
        for name, value in (("SENDGRID_API_KEY", api_key), ("MAIL_FROM", sender), ("MAIL_TO", to))
        if not value
    ]
    if missing:
        print(
            "notify: WARNING — not sending: missing "
            + ", ".join(missing)
            + ". Set SENDGRID_API_KEY as a secret and MAIL_FROM/MAIL_TO as repository variables. "
            "The release itself is unaffected.",
            file=sys.stderr,
        )
        return 0

    try:
        send(api_key, sender, to, context["subject"], html, text)
    except SystemExit as exc:
        # Loud, but never fatal: the release already happened.
        print(str(exc), file=sys.stderr)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
