#!/usr/bin/env python3
"""One-time helper: turn Google's client_secret.json into a refresh token.

Run this ONCE, on your laptop, with the JSON you downloaded from the Cloud
console (Google Auth platform -> Clients -> your Desktop client -> download):

    python3 -m pip install --quiet google-auth-oauthlib
    python3 .github/scripts/oauth_token.py --secrets ~/Downloads/client_secret_*.json

A browser opens. Sign in as the account you want to SEND FROM
(akshayprabhakant@gmail.com), accept the expected "Google hasn't verified this
app" screen (Advanced -> continue), and the script prints the three values to
paste as GitHub secrets.

The client_secret.json and the refresh token are credentials: do not commit
either. The client_secret.json is never needed again once you have the refresh
token.
"""

from __future__ import annotations

import argparse
import json
import pathlib

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


def load_client(secrets_path: str) -> tuple[str, str]:
    raw = pathlib.Path(secrets_path).read_text()
    cfg = json.loads(raw)
    inst = cfg.get("installed") or cfg.get("web") or {}
    client_id = inst.get("client_id", "")
    client_secret = inst.get("client_secret", "")
    if not client_id or not client_secret:
        raise SystemExit(
            "token: no client_id/client_secret in that file — is it the downloaded "
            "client_secret_*.json?"
        )
    return client_id, client_secret


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--secrets", required=True, help="path to client_secret_*.json")
    args = parser.parse_args()

    client_id, client_secret = load_client(args.secrets)

    try:
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        raise SystemExit("token: pip install --quiet google-auth-oauthlib first") from None

    # prompt="consent" forces a re-consent even if you authorised before, which
    # is what guarantees a refresh token is issued.
    flow = InstalledAppFlow.from_client_secrets_file(args.secrets, SCOPES)
    creds = flow.run_local_server(port=0, prompt="consent")

    if not creds.refresh_token:
        raise SystemExit("token: no refresh token returned — re-run; consent was skipped.")

    print()
    print("Refresh token obtained. Paste these into GitHub, Settings -> Secrets and")
    print("variables -> Actions:")
    print()
    print("  Variables tab:")
    print(f"    OAUTH_CLIENT_ID    = {client_id}")
    print()
    print("  Secrets tab:")
    print(f"    OAUTH_CLIENT_SECRET = {client_secret}")
    print(f"    OAUTH_REFRESH_TOKEN = {creds.refresh_token}")
    print()
    print("And the SMTP variables stay as before:")
    print("    SMTP_HOST = smtp.gmail.com")
    print("    SMTP_USER = akshayprabhakant@gmail.com")
    print("    MAIL_FROM = akshayprabhakant@gmail.com")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
