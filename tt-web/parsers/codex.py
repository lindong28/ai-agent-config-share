import json
import logging
import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import RateLimits, UsageEntry


# Ported and dependency-stripped from token-tracker src/adapters/codex.py.
CODEX_DIR = os.path.expanduser("~/.codex")
SESSIONS_DIR = os.path.join(CODEX_DIR, "sessions")
STATE_DB = os.path.join(CODEX_DIR, "state_5.sqlite")
DEFAULT_CODEX_MODEL = "gpt-5"

logger = logging.getLogger(__name__)


def load_entries(hours_back=0, sessions_dir=None, state_db=None):
    entries = []
    seen = set()
    cutoff = None
    if hours_back > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours_back)

    models = _load_thread_models(state_db or STATE_DB)
    sessions_path = Path(sessions_dir or SESSIONS_DIR)
    if not sessions_path.is_dir():
        return entries

    for jsonl_path in sessions_path.rglob("*.jsonl"):
        try:
            for entry in parse_file(jsonl_path, models=models):
                if cutoff and entry.timestamp < cutoff:
                    continue
                if entry.session_id in seen:
                    continue
                seen.add(entry.session_id)
                entries.append(entry)
        except Exception as exc:
            logger.warning("Skipping Codex session %s: %s", jsonl_path, exc)

    entries.sort(key=lambda entry: entry.timestamp)
    return entries


def parse_file(path, models=None):
    models = models or {}
    session_id = ""
    session_ts = ""
    project = "unknown"
    model = DEFAULT_CODEX_MODEL
    last_usage = None
    message_count = 0

    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue

                row_type = data.get("type")
                if row_type == "session_meta":
                    payload = data.get("payload", {})
                    if not isinstance(payload, dict):
                        continue
                    session_id = payload.get("id", "") or ""
                    session_ts = payload.get("timestamp", "") or data.get("timestamp", "")
                    cwd = payload.get("cwd", "")
                    if cwd:
                        project = _project_from_cwd(cwd)
                    model = models.get(session_id) or payload.get("model") or DEFAULT_CODEX_MODEL
                    continue

                if row_type != "event_msg":
                    continue

                payload = data.get("payload", {})
                if not isinstance(payload, dict) or payload.get("type") != "token_count":
                    continue
                info = payload.get("info")
                if isinstance(info, dict) and isinstance(info.get("total_token_usage"), dict):
                    last_usage = info["total_token_usage"]
                    message_count += 1
    except (OSError, PermissionError):
        return []

    if not last_usage or not session_id:
        return []

    input_tokens = max(_int(last_usage.get("input_tokens")) - _int(last_usage.get("cached_input_tokens")), 0)
    cache_read = _int(last_usage.get("cached_input_tokens"))
    output_tokens = _int(last_usage.get("output_tokens")) + _int(last_usage.get("reasoning_output_tokens"))

    if input_tokens == 0 and output_tokens == 0 and cache_read == 0:
        return []

    try:
        timestamp = datetime.fromisoformat(session_ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return []

    return [
        UsageEntry(
            timestamp=timestamp,
            session_id=session_id,
            message_id=session_id,
            request_id="",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_tokens=0,
            cache_read_tokens=cache_read,
            cost_usd=None,
            project=project,
            agent_id="codex",
            message_count=message_count,
        )
    ]


def load_rate_limits(sessions_dir=None, state_db=None):
    sessions_path = Path(sessions_dir or SESSIONS_DIR)
    if not sessions_path.is_dir():
        return None

    models = _load_thread_models(state_db or STATE_DB)
    jsonl_files = sorted(sessions_path.rglob("*.jsonl"), key=lambda path: path.stat().st_mtime, reverse=True)
    for path in jsonl_files[:5]:
        rate_limits = _extract_rate_limits(path, models)
        if rate_limits:
            return rate_limits
    return None


def _load_thread_models(state_db):
    if not state_db or not os.path.exists(state_db):
        return {}
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % state_db, uri=True)
        rows = conn.execute("SELECT id, model FROM threads WHERE model IS NOT NULL").fetchall()
        conn.close()
        return {row[0]: row[1] for row in rows if row[0] and row[1]}
    except (sqlite3.Error, OSError):
        return {}


def _extract_rate_limits(path, models):
    session_id = ""
    last_rate_limits = None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(data, dict):
                    continue
                if data.get("type") == "session_meta":
                    session_id = data.get("payload", {}).get("id", "")
                if data.get("type") != "event_msg":
                    continue
                payload = data.get("payload", {})
                if payload.get("type") != "token_count":
                    continue
                rate_limits = payload.get("rate_limits")
                if rate_limits:
                    last_rate_limits = (rate_limits, data.get("timestamp", ""), session_id)
    except (OSError, PermissionError):
        return None

    if not last_rate_limits:
        return None

    rate_limits, timestamp, session_id = last_rate_limits
    primary = rate_limits.get("primary") or {}
    secondary = rate_limits.get("secondary") or {}
    five_pct = primary.get("used_percent")
    five_reset = primary.get("resets_at")
    seven_pct = secondary.get("used_percent")
    seven_reset = secondary.get("resets_at")

    now_ts = datetime.now(timezone.utc).timestamp()
    if five_reset and five_reset < now_ts:
        five_pct = 0.0
    if seven_reset and seven_reset < now_ts:
        seven_pct = 0.0

    if five_pct is None and seven_pct is None:
        return None

    return RateLimits(
        five_hour_pct=five_pct,
        five_hour_resets_at=five_reset,
        seven_day_pct=seven_pct,
        seven_day_resets_at=seven_reset,
        model=models.get(session_id, DEFAULT_CODEX_MODEL),
        updated_at=timestamp,
    )


def _project_from_cwd(cwd):
    return cwd or "unknown"


def _int(value):
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0
