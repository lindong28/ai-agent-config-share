#!/usr/bin/env python3
"""Extract every statusline field from the harness JSON, as shell assignments.

statusline.sh used to shell out to `jq` 37 times per render — once per field.
jq is deliberately not a runtime prerequisite of this repo (the installer uses it
only to merge settings.json, and degrades to manual wiring when it is missing),
so on a host without it every field silently resolved to empty and the statusline
collapsed to two lines. python3 *is* a declared prerequisite, so all parsing lives
here instead: one interpreter start, one pass, no external binary.

Input : raw statusline JSON on stdin.
Env   : STATUS_FILE, SPEED_CACHE, CLAUDE_DIR (all optional).
Output: `NAME=<shell-quoted>` lines for eval by the caller.

Also owns two side effects the parse already has the data for: persisting
tt-status.json for the `tt` CLI, and updating the output-speed cache.

Never raises: a malformed field yields the caller's default rather than a
traceback, because a broken statusline must not break the session.
"""

from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
except ImportError:  # stdlib only since 3.9; README pins no floor beyond "python3"
    ZoneInfo = None  # type: ignore[assignment]

HERE = Path(__file__).resolve().parent
ESC = "\033"


# ── Output ───────────────────────────────────────────────────────────────────

_out: list[str] = []


def emit(name: str, value: object) -> None:
    _out.append("%s=%s" % (name, shlex.quote(str(value))))


# ── jq-compatible accessors ──────────────────────────────────────────────────
# These mirror `//` exactly, because any divergence silently changes what the
# statusline shows. jq falls back on three things and three only: an absent key,
# `null`, and `false`. An empty string is a *value* to jq, so `"" // "x"` is `""`
# — a chain like `.project_dir // .cwd` must therefore keep an explicit empty
# project_dir rather than sliding on to a different directory.

MISSING = object()


def dig(root: object, *path: str) -> object:
    """Value at path, or None when any level is absent or not an object."""
    cur = root
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(key)
        if cur is None:
            return None
    return cur


def coalesce(*candidates: object) -> object:
    """The `//` chain: first candidate that is neither null nor false."""
    for value in candidates:
        if value is not None and value is not False:
            return value
    return None


def as_int(value: object, default: int = 0) -> int:
    """Integer for bash arithmetic. Truncates, mirroring the old `cut -d. -f1`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    try:
        return int(value)
    except (ValueError, OverflowError):
        return default


def as_num(value: object, default: object = 0) -> str:
    """Render a number the way `jq -r` would: integral floats lose the `.0`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(default)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def as_text(value: object, default: str = "") -> str:
    """`jq -r` rendering of a scalar, with `//`'s null/false fallback."""
    if value is None or value is False:
        return default
    if isinstance(value, str):
        return value
    if value is True:
        return "true"
    if isinstance(value, (int, float)):
        return as_num(value)
    return default


# ── Parse stdin ──────────────────────────────────────────────────────────────

raw = sys.stdin.read()
try:
    data = json.loads(raw)
    parsed = isinstance(data, dict)
except Exception:
    parsed = False
if not parsed:
    data = {}


# ── Persist tt-status.json ───────────────────────────────────────────────────
# Atomic rename, and the temp file is removed on every failure path. The previous
# shell version leaked its mktemp file whenever the write failed, which on a
# jq-less host meant one orphan per render — 60 of them landed in the git
# worktree, since ~/.claude is a symlink into this repo.


def persist(status_file: str) -> None:
    payload = dict(data)
    # `//`'s fallback set, same as everywhere else: absent, null, or false.
    if coalesce(payload.get("rate_limits")) is None:
        # Rate limits arrive only on some renders; carry the last known values
        # forward so the bars do not flicker between updates.
        try:
            with open(status_file, encoding="utf-8") as fh:
                previous = json.load(fh).get("rate_limits")
            if isinstance(previous, dict):
                payload["rate_limits"] = previous
        except Exception:
            pass
    payload["_received_at"] = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())

    directory = os.path.dirname(status_file) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=os.path.basename(status_file) + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, status_file)
        tmp = ""  # renamed away; nothing left to clean up
    finally:
        # `finally`, not `except Exception`, so an unwinding KeyboardInterrupt or
        # SystemExit still clears the temp file. SIGKILL remains uncoverable.
        # Only ever this exact path — a glob sweep here would race concurrent
        # sessions writing their own temp files in the same directory.
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


STATUS_FILE = os.environ.get("STATUS_FILE", "")
if parsed and raw.strip() and STATUS_FILE:
    try:
        persist(STATUS_FILE)
    except Exception:
        pass


# ── Core fields ──────────────────────────────────────────────────────────────

project_dir = as_text(
    coalesce(
        dig(data, "workspace", "project_dir"),
        dig(data, "workspace", "current_dir"),
        dig(data, "cwd"),
    )
)
emit("PROJECT_DIR", project_dir)
emit("MODEL", as_text(dig(data, "model", "display_name"), "?"))
emit("EFFORT", as_text(dig(data, "effort", "level")))
emit("COST", as_num(dig(data, "cost", "total_cost_usd")))
emit("DURATION_MS", as_int(dig(data, "cost", "total_duration_ms")))
emit("TRANSCRIPT", as_text(dig(data, "transcript_path")))
session_id = as_text(dig(data, "session_id"))
emit("SESSION_ID", session_id)

emit("CTX_PCT", as_int(dig(data, "context_window", "used_percentage")))
emit("CTX_SIZE", as_int(dig(data, "context_window", "context_window_size")))
emit("TOTAL_IN", as_int(dig(data, "context_window", "total_input_tokens")))
emit("TOTAL_OUT", as_int(dig(data, "context_window", "total_output_tokens")))

usage = dig(data, "context_window", "current_usage")
cur_out = as_int(dig(usage, "output_tokens"))
emit("CUR_IN", as_int(dig(usage, "input_tokens")))
emit("CUR_OUT_FIELD", cur_out)
emit("CACHE_READ", as_int(dig(usage, "cache_read_input_tokens")))
emit("CACHE_CREATE", as_int(dig(usage, "cache_creation_input_tokens")))

for var, window in (("5H", "five_hour"), ("7D", "seven_day")):
    used = coalesce(dig(data, "rate_limits", window, "used_percentage"))
    resets = coalesce(dig(data, "rate_limits", window, "resets_at"))
    # Empty, not zero, when absent — the caller renders the bar only if set.
    emit("USAGE_" + var, "" if used is None else as_num(used))
    emit("RESET_" + var, "" if resets is None else as_int(resets))


# ── Model-scoped usage windows (Fable's weekly quota, and any peer) ──────────
# `rate_limits` above is everything the harness sends, and it carries only the
# two account-wide windows. Per-model quotas live in `GET /api/oauth/usage`,
# which statusline-usage.py polls in the background; all that happens here is a
# cache read plus, when it has gone stale, spawning that refresh detached. A
# render must never itself wait on the network.

USAGE_CACHE = os.environ.get("USAGE_CACHE", "")
REFRESH_AFTER_S = 300
# Past this the number stops being worth showing at all. A weekly percentage
# drifts slowly, so several stale hours still read true, but a bar left over
# from an account that has since been rate-limited would actively mislead.
DISPLAY_MAX_AGE_S = 6 * 3600

now_seconds = int(time.time())
model_limit_lines: list[str] = []
if USAGE_CACHE:
    attempted_at = 0
    try:
        with open(USAGE_CACHE, encoding="utf-8") as fh:
            usage_cached = json.load(fh)
        attempted_at = as_int(usage_cached.get("attempted_at"))
        # No lower bound on the age. A clock that has jumped backwards makes
        # this negative, and rejecting that would blank the bars for as long as
        # the skew lasted; the refresh trigger below reads the same skew as a
        # reason to refetch, so a bad stamp corrects itself instead.
        if now_seconds - as_int(usage_cached.get("fetched_at")) <= DISPLAY_MAX_AGE_S:
            for limit in usage_cached.get("limits") or []:
                if not isinstance(limit, dict):
                    continue
                limit_name = as_text(limit.get("name"))
                resets_at = as_int(limit.get("resets_at"))
                if not limit_name:
                    continue
                # A window whose reset has *passed* is still carrying the previous
                # period's percentage, which is simply the wrong number now — and
                # dropping only the countdown would leave a confident bar behind.
                #
                # An *absent* reset is the opposite case and must not be folded
                # into it. The refresher writes 0 whenever the payload carried no
                # parseable `resets_at`, and that has been observed live — beside
                # a Fable window reading 0%, which the next refresh replaced with
                # a percentage and a reset both present. Whatever makes the field
                # absent, its absence says nothing about the percentage: that is
                # still the server's current answer, and only the countdown is
                # unknown. Reading it as elapsed dropped the entry, which is what
                # made the bar vanish and reappear on its own. The renderer
                # already omits a countdown it cannot format, so 0 goes through.
                if resets_at and resets_at <= now_seconds:
                    continue
                model_limit_lines.append(
                    "%s|%d|%d" % (limit_name, as_int(limit.get("percent")), resets_at)
                )
    except Exception:
        pass
    # Keyed on the attempt, not the success: a host that is offline or holding
    # an expired token would otherwise spawn a refresher on every render. Out of
    # range in either direction, so a backwards clock refetches rather than
    # wedging refreshes off for the length of the skew.
    cache_dir = os.path.dirname(USAGE_CACHE) or "."
    lock_path = USAGE_CACHE + ".lock"
    try:
        # Created, not merely tested: `os.access` reports a directory that does
        # not exist yet as unwritable, which on a fresh host would suppress the
        # very first refresh — the one render with nothing cached to show. The
        # speed cache below creates this same directory anyway.
        os.makedirs(cache_dir, exist_ok=True)
    except OSError:
        pass
    # Two readings, because either one alone can freeze. `attempted_at` cannot
    # be written by a refresher on a full filesystem; the lock's mtime can,
    # since stamping an existing inode allocates nothing. Whichever is newer
    # wins, so a host that opens the cache but cannot write it still backs off
    # instead of forking a doomed refresher on every render.
    try:
        last_attempt = max(attempted_at, int(os.path.getmtime(lock_path)))
    except OSError:
        last_attempt = attempted_at
    spawn_refresh = False
    # Two probes, because neither subsumes the other. `os.access` is the only
    # one that notices a directory which has stopped being writable while the
    # lock file still sits in it — opening that existing lock needs no write
    # permission on its directory. The open is the only one that notices a
    # filesystem with no inodes or blocks left, which no permission bit
    # records. Either failure is the one that would otherwise leave both backoff
    # readings frozen and fork a doomed refresher on every render, forever.
    if not 0 <= now_seconds - last_attempt <= REFRESH_AFTER_S and os.access(cache_dir, os.W_OK):
        try:
            # Creating it is not itself an attempt: the refresher stamps the
            # mtime once it holds the lock, and O_RDONLY leaves an existing
            # file's mtime alone.
            os.close(os.open(lock_path, os.O_CREAT | os.O_RDONLY, 0o600))
            spawn_refresh = True
        except OSError:
            spawn_refresh = False
    if spawn_refresh:
        try:
            subprocess.Popen(
                [sys.executable, str(HERE / "statusline-usage.py")],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
                env={**os.environ, "USAGE_CACHE": USAGE_CACHE},
            )
        except Exception:
            pass
emit("MODEL_LIMIT_LINES", "\n".join(model_limit_lines))


# ── Output speed (tok/s) ─────────────────────────────────────────────────────

SPEED_CACHE = os.environ.get("SPEED_CACHE", "")
speed = ""
now_ms = int(time.time() * 1000)

# One cache file per session. Concurrent sessions on this host render within
# milliseconds of each other, so a single shared file would hand session B the
# output count of session A and report a rate that belongs to neither. The
# session id keeps each series to itself; without one there is nothing to key
# on, so fall back to the shared path rather than inventing a series.
if SPEED_CACHE and session_id:
    # Hashed rather than sanitised: substituting path characters and truncating
    # is lossy, so two distinct ids could normalise to one filename and silently
    # re-merge the series this split exists to separate.
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:16]
    SPEED_CACHE = os.path.join(os.path.dirname(SPEED_CACHE), ".speed-%s.json" % digest)

if SPEED_CACHE:
    try:
        with open(SPEED_CACHE, encoding="utf-8") as fh:
            cached = json.load(fh)
        delta_ms = now_ms - as_int(cached.get("ts"))
        delta_tok = cur_out - as_int(cached.get("out"))
        # Only consecutive renders describe a real rate; a stale cache would
        # average across an idle gap and report a meaningless number.
        if 0 < delta_ms <= 2000 and delta_tok > 0:
            speed = "%.1f" % (delta_tok / (delta_ms / 1000))
    except Exception:
        pass
    try:
        os.makedirs(os.path.dirname(SPEED_CACHE) or ".", exist_ok=True)
        with open(SPEED_CACHE, "w", encoding="utf-8") as fh:
            json.dump({"out": cur_out, "ts": now_ms}, fh)
    except Exception:
        pass
emit("SPEED", speed)


# ── Transcript-derived observability ─────────────────────────────────────────

transcript = as_text(dig(data, "transcript_path"))
tdata: dict = {}
if transcript and os.path.isfile(transcript):
    try:
        # No timeout: the parser writes its mtime+size cache only after a full
        # pass, so killing a slow parse would re-miss the same cache on every
        # subsequent render and permanently drop these fields on exactly the
        # long sessions that need them most.
        completed = subprocess.run(
            [sys.executable, str(HERE / "statusline-transcript.py"), transcript],
            capture_output=True,
            text=True,
        )
        loaded = json.loads(completed.stdout)
        if isinstance(loaded, dict):
            tdata = loaded
    except Exception:
        tdata = {}

emit("HAS_TDATA", "1" if tdata else "0")

tokens = tdata.get("session_tokens") if isinstance(tdata.get("session_tokens"), dict) else {}
st_in = as_int(tokens.get("in"))
st_out = as_int(tokens.get("out"))
st_cache = as_int(tokens.get("cache_creation")) + as_int(tokens.get("cache_read"))
emit("ST_IN", st_in)
emit("ST_OUT", st_out)
emit("ST_CACHE", st_cache)
emit("ST_TOTAL", st_in + st_out + st_cache)

session_start = tdata.get("session_start_ts")
emit("SST", "" if session_start is None else as_num(session_start))

# 「最后对话」— when this session last exchanged a message, for telling apart the
# many idle tabs a user keeps open. Three sources were possible and two are wrong:
#   - the render clock: correct only by coincidence, and it silently becomes the
#     answer whenever a timestamp fails to parse, which looks identical to a
#     correct reading.
#   - the transcript's mtime: measured across 59 live transcripts, it runs ahead
#     of the last conversational entry by a median of 160s and by up to 2.6 days,
#     because Claude Code keeps appending timestamp-less bookkeeping entries
#     (`last-prompt` and kin were the final line of 48 of 60 sampled files) long
#     after the exchange ended. It errs *fresh*, which is the direction that
#     misranks a stale tab as recent — the one judgement this field exists for.
# So: read the tail of the transcript directly. Not via statusline-transcript.py,
# whose result cache is keyed on mtime+size and therefore stays valid — and stays
# missing this field — for precisely the idle sessions being ranked.
# Restricted to user/assistant entries. What that buys is dropping the *other*
# timestamp-carrying entries — `system` (api_error) above all, so a retry storm
# does not read as activity. It is not the same as "human turns only": tool
# results are logged as `user` entries (3925 of 3925 sampled), and they stay in.
# So the stamp tracks the exchange, and it does not advance during a long tool
# call — a busy session and an abandoned one can read alike.
_TAIL_WINDOWS = (128 * 1024, 4 * 1024 * 1024)


def last_exchange_ts(path: str) -> float | None:
    for window in _TAIL_WINDOWS:
        try:
            size = os.path.getsize(path)
            with open(path, "rb") as fh:
                if size > window:
                    fh.seek(size - window)
                    fh.readline()  # drop the line the window cut in half
                chunk = fh.read()
        except OSError:
            return None
        for raw in reversed(chunk.splitlines()):
            try:
                entry = json.loads(raw)
            except Exception:
                continue
            if not isinstance(entry, dict) or entry.get("type") not in ("user", "assistant"):
                continue
            ts = entry.get("timestamp")
            if not isinstance(ts, str):
                continue
            try:
                # Own parse rather than the transcript parser's: that one returns
                # `time.time()` on failure, which would hand back the render clock
                # under the guise of a transcript reading. Here failure stays None.
                return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
        if size <= window:
            break
    return None


def machine_zone():
    """The zone `/etc/localtime` names — the machine's, not this process's.

    `time.localtime` honours $TZ, and this process does not necessarily hold the
    machine's: `claude/settings.json` sets `env.TZ` (America/Los_Angeles as of
    this writing) and that env reaches what Claude Code spawns, this script
    included. Measured from the field itself, which read 15h off the host clock
    until this stopped asking the process.

    Read the TZif bytes rather than parse a zone key out of the symlink target:
    `/etc/localtime` is a plain copy on some hosts, leaving no key to parse, and a
    key re-resolved through Python's own tzdata may be a different vintage of the
    same zone. The bytes are what the host itself keeps time by.

    A shell that exports its own $TZ is out of scope — that is a per-shell
    override, and this reports the machine.

    None means "could not tell": no zoneinfo module (< 3.9), no readable
    `/etc/localtime`, or unparseable data. The caller then falls back to $TZ, the
    old behaviour — a stamp in the wrong zone still beats losing the field.
    """
    if ZoneInfo is None:
        return None
    try:
        with open("/etc/localtime", "rb") as tzif:
            return ZoneInfo.from_file(tzif)
    except Exception:
        return None


last_fmt = ""
try:
    if transcript and os.path.isfile(transcript):
        _ts = last_exchange_ts(transcript)
        if _ts is not None:
            _zone = machine_zone()
            _dt = datetime.fromtimestamp(_ts, _zone)
            # Year only when it is not the current one: a tab left open across New
            # Year would otherwise read as this year, and the extra width costs
            # nothing for the 364-days-out-of-365 case.
            _pat = "%m-%d %H:%M" if _dt.year == datetime.now(_zone).year else "%Y-%m-%d %H:%M"
            last_fmt = _dt.strftime(_pat)
except Exception:
    # Module contract (see docstring): a broken field degrades to the caller's
    # default, never a traceback that would take the whole statusline down.
    last_fmt = ""
emit("LAST_FMT", last_fmt)

running = []
for tool in tdata.get("tools_running") or []:
    if not isinstance(tool, dict):
        continue
    target = tool.get("target")
    running.append("%s%s" % (tool.get("name", "?"), ": %s" % target if target else ""))
emit("TOOLS_RUNNING_LINES", "\n".join(running))

completed_tools = tdata.get("tools_completed")
done = []
if isinstance(completed_tools, dict):
    ranked = sorted(completed_tools.items(), key=lambda kv: -as_int(kv[1]))
    done = ["%s ×%s" % (name, count) for name, count in ranked[:4]]
emit("TOOLS_DONE_LINES", "\n".join(done))

agents = [a for a in (tdata.get("agents") or []) if isinstance(a, dict)]
# Running agents first, then finished ones; the tail three are what fits.
ordered = [a for a in agents if a.get("status") == "running"] + [
    a for a in agents if a.get("status") != "running"
]
agent_lines = []
for agent in ordered[-3:]:
    parts = ["R " if agent.get("status") == "running" else "D ", str(agent.get("type", ""))]
    if agent.get("model"):
        parts.append(" %s[2m[%s]%s[0m" % (ESC, agent["model"], ESC))
    if agent.get("desc", "") != "":
        parts.append("%s[2m: %s%s[0m" % (ESC, agent["desc"], ESC))
    elapsed = as_int(agent.get("elapsed_s"))
    if elapsed < 0:
        span = "0s"
    elif elapsed < 60:
        span = "%ds" % elapsed
    else:
        span = "%dm %ds" % (elapsed // 60, elapsed % 60)
    parts.append(" %s[2m(%s)%s[0m" % (ESC, span, ESC))
    agent_lines.append("".join(parts))
emit("AGENT_LINES", "\n".join(agent_lines))

skill_lines = []
for skill in tdata.get("skills") or []:
    if not isinstance(skill, dict):
        continue
    icon = "R" if skill.get("status") == "running" else "D"
    count = skill.get("count")
    skill_lines.append(
        "%s|%s|%d" % (icon, skill.get("name", "?"), as_int(count, 1) if count is not None else 1)
    )
emit("SKILL_LINES", "\n".join(skill_lines))

todos = tdata.get("todos") if isinstance(tdata.get("todos"), dict) else {}
emit("TODO_CONTENT", as_text(todos.get("content")))
emit("TODO_COMPLETED", "" if todos.get("completed") is None else as_int(todos.get("completed")))
emit("TODO_TOTAL", "" if todos.get("total") is None else as_int(todos.get("total")))


# ── Environment metadata (MCP servers / hook events) ─────────────────────────


def count_key(path: str, key: str) -> int:
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh).get(key)
        return len(value) if isinstance(value, (dict, list)) else 0
    except Exception:
        return 0


CLAUDE_DIR = os.environ.get("CLAUDE_DIR", "")
settings = os.path.join(CLAUDE_DIR, "settings.json") if CLAUDE_DIR else ""
mcp_count = count_key(settings, "mcpServers") if settings else 0
if project_dir:
    mcp_count += count_key(os.path.join(project_dir, ".mcp.json"), "mcpServers")
emit("MCP_COUNT", mcp_count)
emit("HOOKS_COUNT", count_key(settings, "hooks") if settings else 0)


sys.stdout.write("\n".join(_out) + "\n")
