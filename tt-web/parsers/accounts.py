"""Which account is currently signed in on this machine, per provider.

Quota is metered per account, not per machine, so a reading is only meaningful
next to the account it belongs to. Nothing in either agent's logs records that:
Codex rollout events carry no account field, and Claude's status file carries
none either. The only account fact a machine can state about itself is the one
in its credential file — who is signed in *right now*.

ADR-024 records the consequence: the dashboard attributes a machine's latest
reading to that machine's currently signed-in account, and the window right
after a switch — where the newest reading still belongs to the previous
account — is an accepted, waived risk. Read that ADR before tightening this.

No token, refresh token, or API key leaves this module; only the account id,
the e-mail that identifies it to a human, and the plan tier.
"""

import base64
import binascii
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

CODEX_AUTH = Path.home() / ".codex" / "auth.json"
CLAUDE_CONFIG = Path.home() / ".claude.json"


@dataclass(frozen=True)
class Account:
    account_id: str
    label: Optional[str] = None
    plan: Optional[str] = None


def codex_account(auth_path=None):
    """Signed-in Codex account, or None when signed out or unreadable."""
    payload = _read_json(auth_path or CODEX_AUTH)
    if not isinstance(payload, dict):
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None

    account_id = tokens.get("account_id")
    claims = _id_token_claims(tokens.get("id_token"))
    auth = claims.get("https://api.openai.com/auth")
    if not isinstance(auth, dict):
        auth = {}
    # The id_token is authoritative for the account id when both are present:
    # account_id is a cached copy beside it.
    account_id = auth.get("chatgpt_account_id") or account_id
    if not isinstance(account_id, str) or not account_id:
        return None

    return Account(
        account_id=account_id,
        label=_text(claims.get("email")),
        plan=_text(auth.get("chatgpt_plan_type")),
    )


def claude_account(config_path=None):
    """Signed-in Claude account, or None when signed out or unreadable."""
    payload = _read_json(config_path or CLAUDE_CONFIG)
    if not isinstance(payload, dict):
        return None
    oauth = payload.get("oauthAccount")
    if not isinstance(oauth, dict):
        return None

    account_id = oauth.get("accountUuid")
    if not isinstance(account_id, str) or not account_id:
        return None

    return Account(
        account_id=account_id,
        label=_text(oauth.get("emailAddress")),
        plan=_text(oauth.get("organizationRateLimitTier")),
    )


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        # A missing or malformed credential file means "no account known", which
        # the caller renders as such. It is never a reason to fail an export.
        return None


def _id_token_claims(token):
    """Claims out of a JWT payload segment. Signature is not verified.

    The token was written by the CLI into the user's own home directory; this
    reads it for a display label, and grants nothing on the strength of it.
    """
    if not isinstance(token, str):
        return {}
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    segment = parts[1]
    segment += "=" * (-len(segment) % 4)
    try:
        decoded = base64.urlsafe_b64decode(segment)
        claims = json.loads(decoded)
    except (binascii.Error, ValueError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _text(value):
    return value if isinstance(value, str) and value else None
