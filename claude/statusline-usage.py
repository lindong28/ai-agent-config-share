#!/usr/bin/env python3
"""Refresh the model-scoped usage quotas that the statusline payload omits.

Claude Code hands the statusline only `rate_limits.five_hour` and
`rate_limits.seven_day`. Per-model windows — the Fable weekly quota, and
whatever else the account has scoped to a model — exist only in
`GET /api/oauth/usage`, under `limits[]`. A statusline that wants to show them
has to fetch them itself.

Runs detached and at most one at a time per host, writing the cache that
statusline-fields.py serves from. Renders never wait on this: they show whatever
the last successful run left behind, so a slow or failed fetch costs nothing.

Input : none (spawned with no arguments).
Env   : USAGE_CACHE, CLAUDE_CONFIG_DIR (both optional).
Output: none. Every failure path is silent — a broken refresh must degrade the
        statusline to its previous numbers, never break the session that spawned it.

OAuth access tokens are read from whichever credential stores this host keeps
them in and passed only as a request header: never logged, never placed in
argv, never written to the cache.
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from datetime import datetime, timezone

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
OAUTH_BETA = "oauth-2025-04-20"
TIMEOUT_S = 10
# Hard ceiling on one refresh, body read included. `urlopen`'s timeout bounds
# only individual socket operations, so a peer that trickles bytes forever
# keeps `json.load` — and with it this process and the flock it holds — alive
# indefinitely. flock gives mutual exclusion but no liveness: the kernel frees
# it when the holder dies, and a wedged holder never does. This deadline is
# what makes it die, so it MUST stay well under the render side's
# REFRESH_AFTER_S; a holder outliving that window would wedge the cache while
# every render spawned another loser that exits without recording an attempt.
DEADLINE_S = 30

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
CACHE = os.environ.get("USAGE_CACHE") or os.path.join(CLAUDE_DIR, "statusline-cache", ".usage.json")
CREDENTIALS = os.path.join(CLAUDE_DIR, ".credentials.json")
# The other half of the same credential: Claude Code writes the blob to the file
# above on Linux and to the login keychain on macOS. `/usr/bin/security` is
# spelled absolutely rather than looked up on PATH — that pins the macOS system
# tool, and on a host without one the probe fails on the exec instead of running
# whatever unrelated binary happens to be named `security` there. The absent
# path is therefore the platform check, which is why no `uname` branch guards
# it. No `-a` account filter: the item's account is the Claude Code login, which
# need not match the OS user this runs as.
KEYCHAIN_TOOL = "/usr/bin/security"
KEYCHAIN_SERVICE = "Claude Code-credentials"
# The keychain read is the one step here that can block on a human: an item
# whose ACL does not yet cover `security` raises a GUI approval dialog. This
# refresher is detached and invisible, so it must not wait behind one — it gives
# up, the previous numbers stand, and the next render's refresh retries. Kept
# well under DEADLINE_S so a stall here is absorbed rather than spending the
# whole budget the network leg still needs.
KEYCHAIN_TIMEOUT_S = 5


def to_epoch(value: object) -> int:
    """ISO-8601 instant as epoch seconds; 0 when absent or unparseable.

    The payload dates these in ISO while the statusline's `fmt_reset` speaks
    epoch seconds, same as the `rate_limits` windows already do.
    """
    if not isinstance(value, str) or not value.strip():
        return 0
    text = value.strip()
    if text.endswith("Z"):
        # fromisoformat rejects the military-zone suffix before Python 3.11.
        text = text[:-1] + "+00:00"
    try:
        stamp = datetime.fromisoformat(text)
    except ValueError:
        return 0
    if stamp.tzinfo is None:
        # These are instants, not local wall-clock times; reading a naive one as
        # local time would shift the countdown by the host's UTC offset.
        stamp = stamp.replace(tzinfo=timezone.utc)
    # Rounded up, not truncated. These carry sub-second precision in practice and
    # it straddles the whole second — two consecutive responses gave
    # `...T00:00:00.228772+00:00` and `...T23:59:59.590324+00:00` for the same
    # weekly reset. Under the current contract only whole seconds can be stored,
    # since the countdown is computed in bash integer arithmetic
    # (`$((resets_at - now))`), so the instant lands under a second off in one
    # direction and the only choice is which. Neither is free, and both last
    # until whatever render lands in that sub-second window is replaced by the
    # next one: truncating hides a window that is still live, rounding up keeps
    # showing one that has just reset — and that stale percentage can be far
    # from the new period's, which starts at 0. Rounding up, because a bar that
    # disappears reads as the feature being broken, which is the failure this
    # whole path exists to have stopped.
    return math.ceil(stamp.timestamp())


def token_from_blob(raw: str) -> str | None:
    """The live token a credential blob carries, or None when it has none.

    Both stores hold the same JSON, so the parsing and the freshness check are
    shared rather than duplicated per store.
    """
    try:
        oauth = json.loads(raw).get("claudeAiOauth") or {}
    except Exception:
        return None
    if not isinstance(oauth, dict):
        return None
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token:
        return None
    # A token that cannot go in a header is not a usable credential, and saying
    # so here is what keeps that judgement local to the store. Left to the
    # request, an embedded newline or non-ASCII byte raises `ValueError` before
    # anything is sent, which the caller can only read as the network having
    # failed — and it would then stop rather than try the store that does hold
    # a working credential.
    if not token.isascii() or not token.isprintable():
        return None
    expires_at = oauth.get("expiresAt")  # milliseconds
    if isinstance(expires_at, (int, float)) and not isinstance(expires_at, bool):
        # An expired token only earns 401s. Refreshing it is Claude Code's job:
        # racing its refresh from here risks spending the one-shot refresh token
        # the live sessions depend on.
        if expires_at / 1000.0 <= time.time():
            return None
    return token


def blob_from_file() -> str | None:
    """The credentials file's contents, or None when there is no reading it."""
    try:
        with open(CREDENTIALS, encoding="utf-8") as fh:
            return fh.read()
    except Exception:
        return None


def blob_from_keychain() -> str | None:
    """The login keychain's copy of the same blob, or None when unavailable.

    The secret comes back on stdout and is captured, never echoed: `-w` prints
    the password alone, and the service name is the only thing on the command
    line, which `ps` shows to every user on the host.
    """
    try:
        completed = subprocess.run(
            [KEYCHAIN_TOOL, "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            # Nothing to read, and a child inheriting this process's stdin could
            # consume input meant for whoever spawned it.
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=KEYCHAIN_TIMEOUT_S,
        )
    except Exception:
        # No such binary — the ordinary non-macOS case — or a read that blocked
        # past the timeout and was killed with it.
        return None
    if completed.returncode != 0:
        # No such item, a locked keychain, a denied ACL. All the same here.
        return None
    return completed.stdout


def read_tokens() -> Iterator[str]:
    """Every token this host offers, in the order they should be tried.

    Lazy on purpose. A store is only opened once the caller has run out of
    earlier candidates, so a host whose first credential is accepted never
    touches the second store at all — which on macOS is the one that can cost
    seconds, or raise a dialog, for an answer nobody needed.

    Every store is read on every host rather than selected by platform. The
    file is where Linux keeps the blob and the keychain is where macOS keeps
    it, but a host can carry either — a macOS checkout with a leftover
    credentials file, say — and the probe that does not apply costs a failed
    open or a failed exec.

    Deliberately not narrowed to one winner here, because locally *unexpired*
    is not the same as *accepted*: a token whose `expiresAt` is still in the
    future can already have been revoked, superseded, or issued for a different
    account, and nothing on this side of the request can tell. Returning the
    first one would let a stale file that merely looks fresh permanently shadow
    the live keychain entry beside it — the same silent, self-renewing blank
    this refresher exists to have fixed. Only the server settles it, so the
    caller tries them in turn.
    """
    seen: list[str] = []
    for store in (blob_from_file, blob_from_keychain):
        raw = store()
        if not raw:
            continue
        token = token_from_blob(raw)
        # A host can hold the same blob in both stores; asking the server twice
        # with one it already rejected buys nothing.
        if token and token not in seen:
            seen.append(token)
            yield token


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    """Fail on any 3xx rather than following it.

    urllib's default handler carries the original request's headers onto the
    redirected request, so a cross-origin redirect would hand this account's
    bearer token to whatever host the response names — and one to `http://`
    would put it on the wire in the clear. The usage endpoint has no legitimate
    reason to redirect, so the safe response to one is a failed refresh.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


_OPENER = urllib.request.build_opener(_RefuseRedirect)


def fetch(token: str) -> object:
    request = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": "Bearer " + token,
            "anthropic-beta": OAUTH_BETA,
            "Accept": "application/json",
        },
    )
    with _OPENER.open(request, timeout=TIMEOUT_S) as response:
        return json.load(response)


def model_limits(payload: object) -> list[dict]:
    """The model-scoped entries of `limits[]`.

    Read by scope rather than by name: `limits[]` is the generic representation,
    where each entry declares what it applies to. Any window the account later
    has scoped to another model therefore shows up with no change here.
    """
    if not isinstance(payload, dict):
        return []
    found = []
    for item in payload.get("limits") or []:
        if not isinstance(item, dict):
            continue
        # `is_active` is deliberately not consulted. Its meaning is unverified:
        # on this account the only `true` is also the highest-percentage window,
        # which reads at least as well as "the limit closest to binding" as it
        # does "this quota applies" — and under that reading, filtering on it
        # would make the model's bar vanish whenever the 5h or 7d window
        # overtook it. The CLI's own parser declares the sibling fields and not
        # this one, so it settles nothing either. A superseded-but-unexpired
        # entry therefore still shows; that is the cheaper wrong answer.
        scope = item.get("scope")
        model = (scope or {}).get("model") if isinstance(scope, dict) else None
        name = model.get("display_name") if isinstance(model, dict) else None
        percent = item.get("percent")
        if not isinstance(name, str) or not name.strip():
            continue
        if isinstance(percent, bool) or not isinstance(percent, (int, float)):
            continue
        found.append(
            {
                # `|` and newline are the delimiters the render side splits on,
                # and a backslash would be re-interpreted by its `printf %b`.
                # Scrubbing them here keeps a name the API chose from being able
                # to forge a field boundary or an extra row.
                "name": re.sub(r"[|\\\r\n\t]+", " ", name).strip(),
                "percent": int(percent),
                "resets_at": to_epoch(item.get("resets_at")),
            }
        )
    return found


def write_cache(limits: list[dict] | None) -> None:
    """Persist the attempt, and the limits when the fetch produced any.

    `attempted_at` moves on every run, success or not, and is what the render
    side backs off on: without it an offline host — or one whose token has
    expired — would spawn a refresher on every single render, forever.
    `fetched_at` and `limits` only move on success, so a failed attempt keeps
    displaying the last good numbers instead of blanking the bars.
    """
    now = int(time.time())
    payload = {"attempted_at": now, "fetched_at": 0, "limits": []}
    try:
        with open(CACHE, encoding="utf-8") as fh:
            previous = json.load(fh)
        if isinstance(previous, dict):
            payload["fetched_at"] = previous.get("fetched_at") or 0
            payload["limits"] = previous.get("limits") or []
    except Exception:
        pass
    if limits is not None:
        payload["fetched_at"] = now
        payload["limits"] = limits

    directory = os.path.dirname(CACHE) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=os.path.basename(CACHE) + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        os.replace(tmp, CACHE)
        tmp = ""
    finally:
        # `finally`, not `except`, so an unwinding SystemExit still clears the
        # temp file rather than leaking one per failed refresh.
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def claim(lock_path: str) -> int | None:
    """Exclusive right to refresh, as a held fd; None when another run has it.

    Concurrent sessions all render at once and all see the same stale cache, so
    without this they would all fetch. The lock is an advisory `flock` rather
    than an exclusively-created file with a staleness timeout: a timeout has to
    guess when a holder died, and two losers could both judge the same lock
    expired, unlink it, and re-create it — each then believing it held the lock
    alone, and each removing whichever lock it found on the way out. The kernel
    releases a flock the moment its holder dies, so there is no stale state to
    reap and no window to race over. The file itself is never removed; the lock
    lives in the fd, which is why it is returned rather than closed here.
    """
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    except OSError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    try:
        # Doubles as the backoff of last resort. Stamping an existing inode
        # allocates nothing, so it still lands on a filesystem too full to hold
        # the cache write below — the one case where `attempted_at` cannot
        # record that an attempt happened, and every render would otherwise
        # keep spawning refreshers that can never persist anything.
        os.utime(lock_path, None)
    except OSError:
        pass
    return fd


class _Deadline(BaseException):
    """DEADLINE_S has elapsed; this refresh must unwind, not retry.

    `BaseException`, for the same reason `KeyboardInterrupt` is one. Every
    failure path in this file is a broad `except Exception` — that is the
    design, since a refresh must degrade rather than break the session — and an
    alarm can land inside any of them. Deriving from `Exception` would let the
    notice that the ceiling is gone be swallowed by whichever handler happened
    to be on the stack, after which the run continues unbounded with the flock
    still held. Only the entry point below may catch it, because unwinding ends
    there. `TimeoutError` cannot serve either: `urlopen` raises that for its own
    socket timeout, which is an ordinary request failure.
    """


def _expire(signum: int, frame: object) -> None:
    raise _Deadline("refresh exceeded DEADLINE_S")


def main() -> None:
    try:
        signal.signal(signal.SIGALRM, _expire)
        signal.alarm(DEADLINE_S)
    except (AttributeError, OSError, ValueError):
        # No SIGALRM here (or not the main thread). The refresh proceeds without
        # the ceiling rather than not at all.
        pass
    os.makedirs(os.path.dirname(CACHE) or ".", exist_ok=True)
    lock_fd = claim(CACHE + ".lock")
    if lock_fd is None:
        return
    try:
        # Stamp the attempt before going near the network, not after. The render
        # side backs off on `attempted_at`, so leaving it unwritten until the
        # response lands would keep every render during a slow request — the
        # response body has no end-to-end deadline — deciding a refresh was
        # still owed and forking another one.
        write_cache(None)
        limits = None
        for token in read_tokens():
            try:
                limits = model_limits(fetch(token))
            except urllib.error.HTTPError as refusal:
                if refusal.code not in (401, 403):
                    # The server answered and the objection is not the
                    # credential; another one would earn the same reply.
                    break
                continue
            except Exception:
                # Never reached the server — DNS, TLS, a socket timeout. No
                # credential is implicated, so there is nothing for the next one
                # to fix, and trying it only spends more of the deadline.
                break
            # An empty `limits[]` still counts: that answer came from the
            # server, so the account genuinely has no model-scoped window.
            break
        if limits is not None:
            write_cache(limits)
    finally:
        signal.alarm(0)
        # Releases the flock; the lock file stays behind with nothing to clean.
        os.close(lock_fd)


if __name__ == "__main__":
    try:
        main()
    except (Exception, _Deadline):
        # The one place `_Deadline` may be caught: nothing runs after this, so
        # swallowing it cannot let an expired deadline turn into more work. The
        # spawner already routes this process's stderr to /dev/null, but a
        # hand-run must stay silent too — this script promises no output.
        pass
