#!/usr/bin/env python3
"""Extract every statusline field from the harness JSON, as shell assignments.

statusline.sh used to shell out to `jq` 37 times per render — once per field.
jq is deliberately not a prerequisite of this repo (see lib/install-platform.sh),
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
from pathlib import Path

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


# ── Output speed (tok/s) ─────────────────────────────────────────────────────

SPEED_CACHE = os.environ.get("SPEED_CACHE", "")
speed = ""
now_ms = int(time.time() * 1000)

# One cache file per session. Concurrent sessions on this host render within
# milliseconds of each other, so a single shared file would hand session B the
# output count of session A and report a rate that belongs to neither. The
# session id keeps each series to itself; without one there is nothing to key
# on, so fall back to the shared path rather than inventing a series.
session_id = as_text(dig(data, "session_id"))
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
