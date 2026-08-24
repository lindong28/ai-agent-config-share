import argparse
import hashlib
import json
import logging
import math
import mimetypes
import os
import subprocess
import sys
import threading
import time
import uuid
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import rollup
import generation
import sync
from aggregators import extract_metric, load_all_entries
from parsers import claude_status, codex
from pricing_fetcher import is_estimated_pricing_model


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
logger = logging.getLogger("tt-web")
_NETWORK_CACHE = {"ts": 0.0, "data": None}
_NETWORK_TTL = 60.0
_SYNC_DUE_AFTER_SECONDS = 600
_STALE_AFTER_SECONDS = 6 * 60 * 60
RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90, "6m": 180, "1y": 365, "2y": 730}
_SYNC_LOCK = threading.Lock()
_ACCOUNT_MEMORY_LOCK = threading.Lock()
_ACCOUNT_MEMORY_DELETE_EPOCH = 0
_ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS = defaultdict(int)
_ACCOUNT_MEMORY_DELETED_AT_EPOCH = {}
_ACCOUNT_MEMORY_VERSION = 1
_ACCOUNT_MEMORY_PATH = ROOT / "state" / "account_memory.json"
_ACCOUNT_MEMORY_ENTRY_FIELDS = frozenset(
    {
        "provider",
        "account_id",
        "account_label",
        "account_plan",
        "five_hour_used_pct",
        "five_hour_resets_at",
        "seven_day_used_pct",
        "seven_day_resets_at",
        "observed_at",
    }
)
_ACCOUNT_MEMORY_NUMERIC_FIELDS = (
    "five_hour_used_pct",
    "five_hour_resets_at",
    "seven_day_used_pct",
    "seven_day_resets_at",
)
_SYNC_STATE = {
    "running": False,
    "started_at": None,
    "completed_at": None,
    "round_machines": (),
    "last_completed_round_machines": (),
    "known_machines": None,
    "observations": {},
}
SERVER_INSTANCE_ID = uuid.uuid4().hex

# Host/port this process is serving on, stashed by main() so /api/restart can
# re-exec with identical arguments.
_BIND_HOST = "127.0.0.1"
_BIND_PORT = 39001


def _source_files():
    """Python modules whose code is frozen into this running process. Static
    assets (web/*) are re-read from disk per request and never go stale, so only
    the imported .py files matter for detecting code drift."""
    files = sorted(ROOT.glob("*.py"))
    files += sorted((ROOT / "parsers").glob("**/*.py"))
    return files


def _web_files():
    return sorted(path for path in WEB_ROOT.rglob("*") if path.is_file())


def _source_signature():
    digest = hashlib.sha256()
    for path in _source_files():
        try:
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()[:16]


def _web_signature():
    digest = hashlib.sha256()
    for path in _web_files():
        try:
            digest.update(path.read_bytes())
        except OSError:
            continue
    return digest.hexdigest()[:16]


# Signature of the code this process actually loaded. health() compares it to a
# fresh signature each call, so the server self-reports when its on-disk source
# has changed since boot (the symptom: a long-lived daemon serving old code).
BOOT_SIGNATURE = _source_signature()


def overview(query):
    completed_before = _sync_runtime_snapshot()["completed_at"]
    sync_started = _maybe_sync_remotes(query)
    with generation.generation_admission_snapshot() as admission:
        with rollup.use_admitted_generations(admission.admitted):
            return _overview_from_admission(
                query,
                admission,
                completed_before=completed_before,
                sync_started=sync_started,
            )


def _overview_from_admission(
    query,
    admission,
    *,
    completed_before,
    sync_started,
):
    now = datetime.now().astimezone()
    range_value = _first(query, "range", "30d")
    rollup_range_window = rollup.range_window(range_value, now)
    cost_granularity = _auto_time_dim(range_value)
    cost_over_time = rollup.query_pivot(
        cost_granularity, "agent", "cost", time_range=rollup_range_window
    )
    today = now.astimezone(rollup.BUCKET_TIMEZONE).date()
    today_window = (today, today)
    week_window = (today - timedelta(days=today.weekday()), today)
    month_window = (today.replace(day=1), today)
    week_summary = _rollup_summary(week_window)
    week_summary["window"] = {
        "start": _start_of_week(now).isoformat(),
        "end": now.isoformat(),
    }

    sync_status = dict(_sync_status(now=now, admission=admission))
    sync_status["refresh_pending"] = bool(
        sync_started
        or sync_status["syncing"]
        or sync_status.get("completed_at") != completed_before
    )
    return {
        "rate_limits": _rate_limits(
            admission=admission,
            sync_status=sync_status,
        ),
        "sync": sync_status,
        "today": _rollup_summary(today_window),
        "week": week_summary,
        "range": _rollup_summary(rollup_range_window),
        "daily_cost_30d": _daily_cost_from_pivot(
            rollup.query_pivot(
                "day", "agent", "cost", time_range=rollup.range_window("30d", now)
            )
        ),
        "cost_over_time": cost_over_time,
        "cost_over_time_granularity": cost_granularity,
        "rollup_coverage": _rollup_coverage(rollup_range_window),
        "top_projects_week": _top_projects_from_rollup(week_window, limit=5),
        "model_mix_month": _model_mix_from_rollup(month_window),
        "history_gap": None,
        "codex_cost_estimated": True,
    }


def pivot_endpoint(query):
    _maybe_sync_remotes(query)
    now = datetime.now().astimezone()
    return rollup.query_pivot(
        _first(query, "x", "day"),
        _first(query, "group", "none"),
        _first(query, "metric", "cost"),
        agents=set(query.get("agent", [])) or None,
        projects=set(query.get("project", [])) or None,
        models=set(query.get("model", [])) or None,
        machines=set(query.get("machine", [])) or None,
        time_range=rollup.range_window(_first(query, "range", "30d"), now),
    )


def pivot_filters_endpoint(query):
    _maybe_sync_remotes(query)
    now = datetime.now().astimezone()
    return rollup.filter_options(
        time_range=rollup.range_window(_first(query, "range", "30d"), now)
    )


def sync_status_endpoint(_query):
    return _sync_status()


def sessions_endpoint(query):
    entries = load_all_entries()
    now = datetime.now().astimezone()
    visible = _filter_time(entries, _range_window(_first(query, "range", "30d"), now))
    visible = _filter_values(visible, query)
    sessions = [_session_stats(items) for items in _group_sessions(visible).values()]
    sort = _first(query, "sort", "time")
    reverse = _first(query, "order", "desc") != "asc"
    sessions.sort(key=lambda row: _session_sort_key(row, sort), reverse=reverse)
    return sessions


def session_detail(session_id):
    entries = [entry for entry in load_all_entries() if entry.session_id == session_id]
    entries.sort(key=lambda entry: entry.timestamp)
    if not entries:
        return {"meta": None, "entries": []}
    return {"meta": _session_stats(entries), "entries": [_entry_json(entry) for entry in entries]}


def health(query):
    return {
        "ok": True,
        "instance_id": SERVER_INSTANCE_ID,
        "signature": BOOT_SIGNATURE,
        "web_signature": _web_signature(),
        "stale": _source_signature() != BOOT_SIGNATURE or _first(query, "asset_watch", "") != "1",
    }


def _compile_check():
    """py_compile every source file; return a list of error strings (empty when
    all compile). Guards /api/restart from re-exec'ing into broken code — without
    an external supervisor, a crash on boot would take the dashboard down."""
    import py_compile

    errors = []
    for path in _source_files():
        try:
            py_compile.compile(str(path), doraise=True)
        except py_compile.PyCompileError as exc:
            errors.append(str(exc))
    return errors


def _schedule_reexec():
    def _reexec():
        os.execv(
            sys.executable,
            [sys.executable, str(ROOT / "server.py"), "--host", _BIND_HOST, "--port", str(_BIND_PORT)],
        )

    threading.Timer(0.4, _reexec).start()


def _valid_zone(name):
    if not name:
        return None
    try:
        ZoneInfo(name)
    except Exception:
        return None
    return name


def local_timezone():
    """IANA name of the machine's current timezone, resolved live so it can't
    drift from the system configuration. Prefers /etc/localtime (the OS-level
    setting the system clock uses, re-read on every call and updated whenever the
    user changes timezone) over the TZ env var, which is frozen per-process at
    launch and would otherwise pin a stale zone. Returns None when unresolved."""
    try:
        link = os.readlink("/etc/localtime")
    except OSError:
        link = ""
    marker = "zoneinfo/"
    idx = link.rfind(marker)
    zone = _valid_zone(link[idx + len(marker):]) if idx != -1 else None
    return zone or _valid_zone(os.environ.get("TZ"))


def timezone_endpoint(_query):
    return {"timezone": local_timezone()}


def network(query):
    force = query.get("force", [None])[0] == "1"
    now = time.time()
    if (not force) and _NETWORK_CACHE["data"] and (now - _NETWORK_CACHE["ts"] < _NETWORK_TTL):
        return _NETWORK_CACHE["data"]
    try:
        result = subprocess.run(["ip-check", "--json"], capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return {
                "error": result.stderr or "ip-check exited non-zero",
                "installed": True,
                "verdict": "unknown",
            }
        data = json.loads(result.stdout)
        _NETWORK_CACHE["ts"] = now
        _NETWORK_CACHE["data"] = data
        return data
    except FileNotFoundError:
        return {
            "error": "ip-check command not found in PATH",
            "installed": False,
            "verdict": "unknown",
            "hint": "Run tt-web/install.sh to install",
        }
    except subprocess.TimeoutExpired:
        return {
            "error": "ip-check timeout (>30s) - external APIs may be slow",
            "installed": True,
            "verdict": "unknown",
        }
    except json.JSONDecodeError as exc:
        return {
            "error": f"ip-check returned invalid JSON: {exc}",
            "installed": True,
            "verdict": "unknown",
        }


ROUTES = {
    "/api/health": health,
    "/api/timezone": timezone_endpoint,
    "/api/overview": overview,
    "/api/pivot": pivot_endpoint,
    "/api/pivot-filters": pivot_filters_endpoint,
    "/api/sync-status": sync_status_endpoint,
    "/api/sessions": sessions_endpoint,
    "/api/network": network,
}


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self._handle_request(send_body=False)

    def do_GET(self):
        self._handle_request(send_body=True)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/account-memory/remove":
            self._handle_account_memory_remove()
            return
        if parsed.path == "/api/restart":
            self._handle_restart()
            return
        self.send_error(404)

    def _handle_account_memory_remove(self):
        # This is input-format validation only. The endpoint deliberately has
        # the same reachability as the server's existing write endpoints.
        if self.headers.get_content_type() != "application/json":
            self._send_json(
                {"error": "Content-Type must be application/json"}, status=400
            )
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
            if content_length < 0:
                raise ValueError("negative Content-Length")
            payload = json.loads(self.rfile.read(content_length))
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            self._send_json({"error": "Request body must be valid JSON"}, status=400)
            return
        provider = payload.get("provider") if isinstance(payload, dict) else None
        account_id = payload.get("account_id") if isinstance(payload, dict) else None
        observed_at = payload.get("observed_at") if isinstance(payload, dict) else None
        if provider not in ("claude", "codex") or not isinstance(
            account_id, str
        ) or not account_id or not isinstance(observed_at, str) or not observed_at or (
            _observed_at(observed_at) is None
        ):
            self._send_json(
                {
                    "error": (
                        "provider must be claude or codex and account_id must be "
                        "a non-empty string; observed_at must be a non-empty "
                        "ISO-8601 string"
                    )
                },
                status=400,
            )
            return
        try:
            with generation.generation_admission_snapshot() as admission:
                live_rate_limits = _live_rate_limits_from_admission(admission)
            status, receipt = _remove_account_memory(
                provider, account_id, observed_at, live_rate_limits
            )
        except Exception as exc:
            logger.exception(
                "account memory removal failed: %s: %s",
                type(exc).__name__,
                exc,
            )
            self._send_json(
                {"error": "Account memory removal could not be persisted"},
                status=500,
            )
            return
        self._send_json(receipt, status=status)

    def _handle_restart(self):
        errors = _compile_check()
        if errors:
            self._send_json({"restarting": False, "error": errors[0]})
            return
        self._send_json({"restarting": True})
        try:
            self.wfile.flush()
        except OSError:
            pass
        logger.info("restart requested via /api/restart; re-executing")
        _schedule_reexec()

    def _handle_request(self, send_body=True):
        parsed = urlparse(self.path)
        try:
            if parsed.path.startswith("/api/session/"):
                session_id = parsed.path[len("/api/session/") :]
                self._send_json(session_detail(session_id), send_body=send_body)
                return
            route = ROUTES.get(parsed.path)
            if route:
                self._send_json(route(parse_qs(parsed.query)), send_body=send_body)
                return
            if parsed.path in ("/", "/explore", "/sessions", "/network", "/ip-check-docs") or parsed.path.startswith("/web/"):
                self._serve_static(parsed.path, send_body=send_body)
                return
            self.send_error(404)
        except Exception as exc:
            logger.exception("Request failed: %s", exc)
            self.send_error(500, str(exc))

    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _send_json(self, payload, status=200, send_body=True):
        data = json.dumps(payload, default=_json_default).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(data)

    def _serve_static(self, path, send_body=True):
        if path == "/":
            file_path = WEB_ROOT / "index.html"
        elif path == "/explore":
            file_path = WEB_ROOT / "explore.html"
        elif path == "/sessions":
            file_path = WEB_ROOT / "sessions.html"
        elif path == "/network":
            file_path = WEB_ROOT / "network.html"
        elif path == "/ip-check-docs":
            file_path = ROOT / "ip_check" / "README.md"
        elif path.startswith("/web/"):
            file_path = ROOT / path.lstrip("/")
        else:
            self.send_error(404)
            return

        try:
            resolved = file_path.resolve()
            if not str(resolved).startswith(str(ROOT.resolve())) or not resolved.is_file():
                self.send_error(404)
                return
            data = resolved.read_bytes()
        except OSError:
            self.send_error(404)
            return

        content_type = mimetypes.guess_type(str(resolved))[0]
        if content_type is None and resolved.suffix == ".md":
            content_type = "text/markdown"
        if content_type is None:
            content_type = "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if send_body:
            self.wfile.write(data)


def _range_window(value, now):
    calendar_window = rollup.range_window(value, now)
    if calendar_window is None:
        return None
    start_date, _ = calendar_window
    start = datetime.combine(
        start_date, datetime.min.time(), tzinfo=rollup.BUCKET_TIMEZONE
    )
    return start, now


def _auto_time_dim(range_value):
    if range_value == "all":
        return "month"
    days = RANGE_DAYS.get(range_value, 30)
    if days <= 90:
        return "day"
    if days <= 365:
        return "week"
    return "month"


def _rollup_coverage(range_window):
    earliest = rollup.earliest_rollup_date()
    range_start = None
    partial = False
    if earliest:
        if range_window is None:
            partial = True
        else:
            range_start = rollup._calendar_date_bounds(range_window)[0].isoformat()
            partial = range_start < earliest
    return {
        "earliest_date": earliest,
        "range_start": range_start,
        "partial_before_range": partial,
    }


def _maybe_sync_remotes(query):
    if _first(query, "sync", "1") == "0":
        return False
    force = _first(query, "force", "0") == "1"
    if not force and not _automatic_sync_due():
        return False
    with generation.generation_admission_snapshot() as admission:
        round_machines = tuple(record.machine.name for record in admission.records)
    with _SYNC_LOCK:
        _reconcile_machine_config_locked(set(round_machines))
        if _SYNC_STATE["running"]:
            return False
        _SYNC_STATE.update(
            running=True,
            started_at=_utc_timestamp(),
            completed_at=None,
            round_machines=round_machines,
            last_completed_round_machines=(),
        )
    try:
        thread = threading.Thread(
            target=_run_sync_round,
            args=(round_machines,),
            name="tt-web-sync",
            daemon=True,
        )
        thread.start()
    except Exception as exc:
        reason = "Failed to start sync worker: %s: %s" % (type(exc).__name__, exc)
        logger.exception("%s", reason)
        completed_at = _utc_timestamp()
        with _SYNC_LOCK:
            observations = dict(_SYNC_STATE["observations"])
            for name in round_machines:
                observations[name] = _attempt_failure_observation(
                    observations.get(name), completed_at, reason
                )
            _SYNC_STATE.update(
                running=False,
                completed_at=completed_at,
                last_completed_round_machines=round_machines,
                observations=observations,
            )
        return False
    return True


def _automatic_sync_due(now=None):
    current_time = _aware_now(now)
    completed_at = _parse_timestamp(_sync_runtime_snapshot()["completed_at"])
    if completed_at is not None:
        attempt_age = max(
            (current_time.astimezone(timezone.utc) - completed_at).total_seconds(),
            0.0,
        )
        if attempt_age < _SYNC_DUE_AFTER_SECONDS:
            return False
    return _sync_due(now=current_time)


def _sync_due(now=None):
    current_time = _aware_now(now)
    with generation.generation_admission_snapshot() as admission:
        for record in admission.records:
            if not record.admitted:
                return True
            if _generation_age_seconds(record.current.meta, current_time) >= _SYNC_DUE_AFTER_SECONDS:
                return True
    return False


def _run_sync_round(round_machines=()):
    results = {}
    outcomes = {}
    completed_round_machines = tuple(round_machines)
    completed_at = None
    observations = None
    try:
        results = sync.sync_all()
        outcomes = _normalize_sync_outcomes(results, round_machines)
        completed_round_machines = tuple(sorted(outcomes))
        completed_at = _utc_timestamp()
        with _SYNC_LOCK:
            observations = dict(_SYNC_STATE["observations"])
        for name, outcome in outcomes.items():
            if outcome["kind"] == "failure":
                observations[name] = _failed_observation(
                    observations.get(name), completed_at, outcome["reason"]
                )
            elif outcome["kind"] == "success":
                observations[name] = {
                    "contact_status": "reachable",
                    "last_attempt_outcome": "success",
                    "last_attempt_ts": completed_at,
                    "last_successful_contact_ts": completed_at,
                    "reason": None,
                }
            else:
                observations[name] = _attempt_failure_observation(
                    observations.get(name),
                    completed_at,
                    outcome["reason"],
                    outcome="malformed_result",
                )
    except Exception as exc:
        logger.exception("cross-machine sync failed: %s", exc)
        completed_at = _utc_timestamp()
        reason = "%s: %s" % (type(exc).__name__, exc)
        with _SYNC_LOCK:
            observations = dict(_SYNC_STATE["observations"])
        for name in round_machines:
            observations[name] = _attempt_failure_observation(
                observations.get(name), completed_at, reason
            )
    finally:
        _remember_accounts_after_sync_publish()
        completed_at = completed_at or _utc_timestamp()
        if observations is None:
            with _SYNC_LOCK:
                observations = dict(_SYNC_STATE["observations"])
        for name, outcome in outcomes.items():
            if outcome["kind"] != "success":
                continue
            current = outcome["generation"]
            if current is not None and hasattr(current, "close"):
                try:
                    current.close()
                except Exception as exc:
                    logger.exception("generation cleanup failed for %s: %s", name, exc)
                    previous = observations.get(name) or {}
                    observations[name] = {
                        "contact_status": (
                            "reachable"
                            if outcome["kind"] == "success"
                            else previous.get("contact_status", "unknown")
                        ),
                        "last_attempt_outcome": "cleanup_failed",
                        "last_attempt_ts": completed_at,
                        "last_successful_contact_ts": (
                            completed_at
                            if outcome["kind"] == "success"
                            else previous.get("last_successful_contact_ts")
                        ),
                        "reason": "Generation cleanup failed: %s: %s"
                        % (type(exc).__name__, exc),
                    }
        with _SYNC_LOCK:
            _SYNC_STATE.update(
                running=False,
                completed_at=completed_at,
                last_completed_round_machines=completed_round_machines,
                observations=observations,
            )


def _normalize_sync_outcomes(results, round_machines):
    if not isinstance(results, dict):
        raise TypeError("sync_all must return a machine-to-SyncResult mapping")
    outcomes = {}
    for name in sorted(set(round_machines) | set(results)):
        result = results.get(name)
        if not isinstance(result, sync.SyncResult):
            outcomes[name] = {
                "kind": "malformed",
                "generation": None,
                "reason": "Malformed sync result: expected SyncResult with one explicit outcome.",
            }
            continue
        has_generation = result.generation is not None
        has_error = result.error is not None
        if has_generation and not has_error:
            outcomes[name] = {
                "kind": "success",
                "generation": result.generation,
                "reason": None,
            }
        elif has_error and not has_generation:
            outcomes[name] = {
                "kind": "failure",
                "generation": None,
                "reason": str(result.error),
            }
        else:
            outcomes[name] = {
                "kind": "malformed",
                "generation": None,
                "reason": "SyncResult has no explicit outcome or has conflicting outcomes.",
            }
    return outcomes


def _failed_observation(previous, attempted_at, reason):
    previous = previous or {}
    return {
        "contact_status": "unreachable",
        "last_attempt_outcome": "failure",
        "last_attempt_ts": attempted_at,
        "last_successful_contact_ts": previous.get("last_successful_contact_ts"),
        "reason": reason,
    }


def _attempt_failure_observation(previous, attempted_at, reason, *, outcome="failure"):
    previous = previous or {}
    return {
        "contact_status": previous.get("contact_status", "unknown"),
        "last_attempt_outcome": outcome,
        "last_attempt_ts": attempted_at,
        "last_successful_contact_ts": previous.get("last_successful_contact_ts"),
        "reason": reason,
    }


def _sync_runtime_snapshot(current_machines=None):
    with _SYNC_LOCK:
        if current_machines is not None:
            _reconcile_machine_config_locked(set(current_machines))
        snapshot = dict(_SYNC_STATE)
        snapshot["round_machines"] = tuple(_SYNC_STATE["round_machines"])
        snapshot["last_completed_round_machines"] = tuple(
            _SYNC_STATE["last_completed_round_machines"]
        )
        snapshot["known_machines"] = (
            None
            if _SYNC_STATE["known_machines"] is None
            else frozenset(_SYNC_STATE["known_machines"])
        )
        snapshot["observations"] = {
            name: dict(observation)
            for name, observation in _SYNC_STATE["observations"].items()
        }
    snapshot["errors"] = {
        name: observation["reason"]
        for name, observation in snapshot["observations"].items()
        if observation.get("reason")
    }
    snapshot["syncing"] = snapshot.pop("running")
    snapshot["terminal"] = not snapshot["syncing"]
    return snapshot


def _reset_sync_state_for_tests():
    with _SYNC_LOCK:
        _SYNC_STATE.update(
            running=False,
            started_at=None,
            completed_at=None,
            round_machines=(),
            last_completed_round_machines=(),
            known_machines=None,
            observations={},
        )


def _reconcile_machine_config_locked(current_machines):
    known = _SYNC_STATE["known_machines"]
    if known is None:
        _SYNC_STATE["known_machines"] = set(current_machines)
        return
    observations = dict(_SYNC_STATE["observations"])
    for name in current_machines - known:
        observations[name] = {
            "contact_status": "unknown",
            "last_attempt_outcome": "not_attempted_since_added",
            "last_attempt_ts": None,
            "last_successful_contact_ts": None,
            "reason": "Machine was added after this server process started and has not been included in a sync attempt yet.",
        }
    _SYNC_STATE["known_machines"] = set(current_machines)
    _SYNC_STATE["observations"] = observations


def _capture_startup_machine_config():
    """Anchor which machines existed when this process started.

    Tests and direct function callers can still establish the anchor lazily via
    _sync_status(); the real server captures it before accepting requests so a
    machine added before the first status request is not mislabeled as a
    restart-unknown machine.
    """
    with generation.generation_admission_snapshot() as admission:
        current_machines = {record.machine.name for record in admission.records}
    with _SYNC_LOCK:
        if _SYNC_STATE["known_machines"] is None:
            _SYNC_STATE["known_machines"] = current_machines


def _sync_status(now=None, admission=None):
    current_time = _aware_now(now)
    if admission is None:
        with generation.generation_admission_snapshot() as loaded:
            runtime = _sync_runtime_snapshot(
                record.machine.name for record in loaded.records
            )
            return _sync_status_from_admission(loaded, current_time, runtime)
    runtime = _sync_runtime_snapshot(
        record.machine.name for record in admission.records
    )
    return _sync_status_from_admission(admission, current_time, runtime)


def _sync_status_from_admission(admission, current_time, runtime):
    machine_rows = []
    admitted_names = {current.host for current in admission.admitted}
    declared_names = {record.machine.name for record in admission.records}
    for record in admission.records:
        name = record.machine.name
        meta = record.current.meta if record.admitted else None
        observation = _runtime_observation(runtime, name, meta)
        if record.never:
            availability = "never"
        elif not record.admitted:
            availability = None
        else:
            availability = observation["contact_status"]
        stale = bool(
            meta
            and _generation_age_seconds(meta, current_time)
            >= _STALE_AFTER_SECONDS
        )
        machine_rows.append(
            {
                "name": name,
                "declared": True,
                "this_machine": record.machine.is_self,
                "admitted": record.admitted,
                "availability": availability,
                "stale": stale,
                "syncing": runtime["syncing"] and name in runtime.get("round_machines", ()),
                "reason": observation["reason"],
                "exclusion_reason": record.exclusion_reason,
                "last_sync_ts": meta.get("published_at") if meta else None,
                "generated_at": meta.get("generated_at") if meta else None,
                "data_start_date": meta.get("data_start_date") if meta else None,
                "generation_id": meta.get("generation_id") if meta else None,
                "last_attempt_outcome": observation["last_attempt_outcome"],
                "last_attempt_ts": observation["last_attempt_ts"],
                "last_successful_contact_ts": observation["last_successful_contact_ts"],
            }
        )
    reportable_undeclared = set(runtime.get("last_completed_round_machines", ()))
    if runtime["syncing"]:
        reportable_undeclared.update(runtime.get("round_machines", ()))
    for name, observation in sorted(runtime.get("observations", {}).items()):
        if name in declared_names:
            continue
        if name not in reportable_undeclared:
            continue
        machine_rows.append(
            {
                "name": name,
                "declared": False,
                "this_machine": False,
                "admitted": False,
                "availability": observation["contact_status"],
                "stale": False,
                "syncing": runtime["syncing"] and name in runtime.get("round_machines", ()),
                "reason": observation["reason"],
                "exclusion_reason": "no_longer_declared_after_latest_attempt",
                "last_sync_ts": None,
                "generated_at": None,
                "data_start_date": None,
                "generation_id": None,
                "last_attempt_outcome": observation["last_attempt_outcome"],
                "last_attempt_ts": observation["last_attempt_ts"],
                "last_successful_contact_ts": observation["last_successful_contact_ts"],
            }
        )
    declared = len(admission.config.machines)
    return {
        "instance_id": SERVER_INSTANCE_ID,
        "coverage": {"admitted": len(admitted_names), "declared": declared},
        "all_machines": sorted(admitted_names),
        "machines": machine_rows,
        "syncing": runtime["syncing"],
        "terminal": runtime["terminal"],
        "started_at": runtime["started_at"],
        "completed_at": runtime["completed_at"],
    }


def _runtime_observation(runtime, name, meta):
    observation = runtime.get("observations", {}).get(name)
    if observation is not None:
        merged = dict(observation)
        if not merged.get("last_successful_contact_ts") and meta:
            merged["last_successful_contact_ts"] = meta.get("published_at")
        return merged
    error = runtime.get("errors", {}).get(name) or runtime.get("errors", {}).get("*")
    if error:
        return {
            "contact_status": "unreachable",
            "last_attempt_outcome": "failure",
            "last_attempt_ts": runtime.get("completed_at"),
            "last_successful_contact_ts": meta.get("published_at") if meta else None,
            "reason": error,
        }
    return {
        "contact_status": "unknown",
        "last_attempt_outcome": "unknown_since_restart",
        "last_attempt_ts": None,
        "last_successful_contact_ts": meta.get("published_at") if meta else None,
        "reason": "Contact status unknown since server restart; no sync attempt has completed in this process.",
    }


def _generation_age_seconds(meta, now):
    published = _parse_timestamp(meta.get("published_at"))
    if published is None:
        return float("inf")
    return max((now.astimezone(timezone.utc) - published).total_seconds(), 0.0)


def _aware_now(value=None):
    current = value() if callable(value) else value
    current = current or datetime.now(timezone.utc)
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError("sync status time must be timezone-aware")
    return current


def _utc_timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _filter_time(entries, time_range):
    if time_range is None:
        return list(entries)
    start, end = time_range
    return [entry for entry in entries if start <= entry.timestamp.astimezone() <= end]


def _filter_values(entries, query):
    agents = set(query.get("agent", []))
    projects = set(query.get("project", []))
    models = set(query.get("model", []))
    result = []
    for entry in entries:
        if agents and entry.agent_id not in agents:
            continue
        if projects and entry.project not in projects:
            continue
        if models and entry.model not in models:
            continue
        result.append(entry)
    return result


def _summary(entries):
    by_agent = defaultdict(float)
    total_cost = 0.0
    for entry in entries:
        if entry.cost_usd is not None:
            total_cost += entry.cost_usd
            by_agent[entry.agent_id] += entry.cost_usd
    return {
        "cost_usd": total_cost,
        "tokens": sum(extract_metric(entry, "total") for entry in entries),
        "by_agent": {"claude-code": by_agent["claude-code"], "codex": by_agent["codex"]},
    }


def _rollup_summary(time_range):
    cost_rows = rollup.query_pivot(
        "agent", "none", "cost", time_range=time_range
    )["rows"]
    token_rows = rollup.query_pivot(
        "agent", "none", "total", time_range=time_range
    )["rows"]
    by_agent = {"claude-code": 0.0, "codex": 0.0}
    for row in cost_rows:
        value = row["values"].get("value")
        if value is not None:
            by_agent[row["x"]] = value
    return {
        "cost_usd": sum(by_agent.values()),
        "tokens": sum(
            row["values"].get("value") or 0
            for row in token_rows
        ),
        "by_agent": by_agent,
    }


def _daily_cost_from_pivot(pivot):
    return [
        {
            "date": row["x"],
            "claude_cost": row["values"].get("claude-code") or 0.0,
            "codex_cost": row["values"].get("codex") or 0.0,
        }
        for row in pivot["rows"]
    ]


def _top_projects_from_rollup(time_range, limit):
    pivot = rollup.query_pivot(
        "project", "none", "cost", time_range=time_range
    )
    return [
        {"project": row["x"], "cost_usd": row["values"].get("value")}
        for row in pivot["rows"]
        if row["values"].get("value") is not None
    ][:limit]


def _model_mix_from_rollup(time_range):
    pivot = rollup.query_pivot(
        "model", "none", "total", time_range=time_range
    )
    rows = [
        {"model": row["x"], "tokens": row["values"].get("value") or 0}
        for row in pivot["rows"]
    ]
    grand_total = sum(row["tokens"] for row in rows) or 1
    for row in rows:
        row["pct"] = row["tokens"] / grand_total
    return rows


def _daily_cost(entries, now):
    days = []
    by_day = defaultdict(lambda: {"claude_cost": 0.0, "codex_cost": 0.0})
    for entry in entries:
        day = entry.timestamp.astimezone(rollup.BUCKET_TIMEZONE).date().isoformat()
        if entry.cost_usd is None:
            continue
        key = "codex_cost" if entry.agent_id == "codex" else "claude_cost"
        by_day[day][key] += entry.cost_usd
    start = now.astimezone(rollup.BUCKET_TIMEZONE).date() - timedelta(days=29)
    for offset in range(30):
        day = (start + timedelta(days=offset)).isoformat()
        row = {"date": day}
        row.update(by_day[day])
        days.append(row)
    return days


def _top_projects(entries, limit):
    totals = defaultdict(float)
    for entry in entries:
        if entry.cost_usd is not None:
            totals[entry.project] += entry.cost_usd
    return [
        {"project": project, "cost_usd": cost}
        for project, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]


def _model_mix(entries):
    totals = defaultdict(int)
    for entry in entries:
        totals[entry.model] += extract_metric(entry, "total")
    grand_total = sum(totals.values()) or 1
    return [
        {"model": model, "tokens": tokens, "pct": tokens / grand_total}
        for model, tokens in sorted(totals.items(), key=lambda item: item[1], reverse=True)
    ]


def _group_sessions(entries):
    sessions = defaultdict(list)
    for entry in entries:
        sessions[entry.session_id].append(entry)
    return sessions


def _session_stats(entries):
    entries = sorted(entries, key=lambda entry: entry.timestamp)
    known_costs = [entry.cost_usd for entry in entries if entry.cost_usd is not None]
    cost = sum(known_costs) if len(known_costs) == len(entries) else None
    start = entries[0].timestamp
    end = entries[-1].timestamp
    return {
        "session_id": entries[0].session_id,
        "agent_id": entries[0].agent_id,
        "project": entries[0].project,
        "model": entries[0].model,
        "started_at": start.isoformat(),
        "ended_at": end.isoformat(),
        "duration_seconds": max(int((end - start).total_seconds()), 0),
        "cost_usd": cost,
        "tokens": sum(extract_metric(entry, "total") for entry in entries),
        "messages": sum(entry.message_count for entry in entries),
        "estimated": entries[0].agent_id == "codex" or is_estimated_pricing_model(entries[0].model),
    }


def _entry_json(entry):
    return {
        "timestamp": entry.timestamp.isoformat(),
        "session_id": entry.session_id,
        "message_id": entry.message_id,
        "request_id": entry.request_id,
        "model": entry.model,
        "input_tokens": entry.input_tokens,
        "output_tokens": entry.output_tokens,
        "cache_creation_tokens": entry.cache_creation_tokens,
        "cache_read_tokens": entry.cache_read_tokens,
        "cost_usd": entry.cost_usd,
        "project": entry.project,
        "agent_id": entry.agent_id,
        "message_count": entry.message_count,
    }


def _session_sort_key(row, sort):
    if sort == "cost":
        return row["cost_usd"] if row["cost_usd"] is not None else -1
    if sort == "tokens":
        return row["tokens"]
    if sort == "duration":
        return row["duration_seconds"]
    return row["started_at"]


def _rate_limits(admission=None, sync_status=None, expected_delete_epoch=None):
    if admission is None:
        with generation.generation_admission_snapshot() as loaded:
            return _rate_limits_from_admission(
                loaded,
                sync_status=sync_status,
                expected_delete_epoch=expected_delete_epoch,
            )
    return _rate_limits_from_admission(
        admission,
        sync_status=sync_status,
        expected_delete_epoch=expected_delete_epoch,
    )


def _rate_limits_from_admission(
    admission, sync_status=None, *, expected_delete_epoch=None
):
    if expected_delete_epoch is None:
        with _account_memory_upsert_epoch() as registered_epoch:
            result = _live_rate_limits_from_admission(
                admission, sync_status=sync_status
            )
            _remember_rate_limit_accounts(
                result, expected_delete_epoch=registered_epoch
            )
    else:
        result = _live_rate_limits_from_admission(
            admission, sync_status=sync_status
        )
        _remember_rate_limit_accounts(
            result, expected_delete_epoch=expected_delete_epoch
        )
    _merge_remembered_rate_limit_accounts(result)
    return result


def _live_rate_limits_from_admission(admission, sync_status=None):
    """Quota grouped by account, because quota is metered per account.

    Machines are not the unit: three machines signed into one Claude account
    report one counter three times, and picking the freshest of them is right.
    Two machines signed into different Codex accounts report two independent
    pools, and picking the freshest is a coin toss between them — the bug this
    replaces. Grouping by account gets both cases right.

    A machine whose exporter predates account stamping groups under its own key
    rather than merging with anything: an unknown account is not evidence of a
    shared one, and merging unknowns would recreate the same bug one level down.
    """
    grouped = {"claude": {}, "codex": {}}
    for current in admission.admitted:
        rate_limits = current.meta.get("rate_limits")
        if not isinstance(rate_limits, dict):
            continue
        for provider, buckets in grouped.items():
            block = rate_limits.get(provider)
            if not isinstance(block, dict):
                continue
            updated_at = _observed_at(block.get("updated_at"))
            if updated_at is None:
                continue
            account_id = _account_id(block)
            key = account_id if account_id else ("unattributed", current.host)
            bucket = buckets.get(key)
            if bucket is None:
                buckets[key] = {"latest": (updated_at, block), "machines": [current.host]}
            else:
                bucket["machines"].append(current.host)
                if updated_at > bucket["latest"][0]:
                    bucket["latest"] = (updated_at, block)

    self_machine = _self_machine_name(admission)
    result = {}
    for provider, buckets in grouped.items():
        # Freshest account first; it is the one the reader is most likely using.
        ordered = sorted(buckets.values(), key=lambda b: b["latest"][0], reverse=True)
        entries = [
            _account_entry(bucket["latest"][1], bucket["machines"], self_machine)
            for bucket in ordered
        ]
        result[provider] = {
            "accounts": entries,
            "unavailable_reason": None
            if entries
            else _quota_unavailable_reason(provider, sync_status),
        }
    return result


def _remember_accounts_after_sync_publish():
    """Remember the current admission snapshot while this sync round is still running."""
    try:
        with generation.generation_admission_snapshot() as admission:
            with _account_memory_upsert_epoch() as expected_delete_epoch:
                rate_limits = _live_rate_limits_from_admission(admission)
                _remember_rate_limit_accounts(
                    rate_limits, expected_delete_epoch=expected_delete_epoch
                )
    except Exception as exc:
        logger.warning(
            "account memory upsert after sync publish failed: %s: %s",
            type(exc).__name__,
            exc,
            exc_info=True,
        )


def _remember_rate_limit_accounts(rate_limits, *, expected_delete_epoch):
    try:
        return _upsert_account_memory(
            rate_limits, expected_delete_epoch=expected_delete_epoch
        )
    except Exception as exc:
        logger.warning(
            "account memory upsert failed: %s: %s",
            type(exc).__name__,
            exc,
            exc_info=True,
        )
        return False


def _merge_remembered_rate_limit_accounts(rate_limits):
    for provider in ("claude", "codex"):
        provider_limits = rate_limits.get(provider)
        if not isinstance(provider_limits, dict):
            continue
        for entry in provider_limits.get("accounts", ()):
            entry["presence"] = "in_use"

    with _ACCOUNT_MEMORY_LOCK:
        state, payload = _load_account_memory()
    if state != "valid":
        return

    remembered = sorted(
        payload["accounts"].values(),
        key=lambda record: _observed_at(record["observed_at"]),
        reverse=True,
    )
    for provider in ("claude", "codex"):
        provider_limits = rate_limits.get(provider)
        if not isinstance(provider_limits, dict):
            continue
        entries = provider_limits.get("accounts")
        if not isinstance(entries, list):
            continue
        live_account_ids = {
            entry.get("account_id")
            for entry in entries
            if entry.get("account_state") == "known"
        }
        entries.extend(
            _remembered_rate_limit_entry(record)
            for record in remembered
            if record["provider"] == provider
            and record["account_id"] not in live_account_ids
        )


def _remembered_rate_limit_entry(record):
    return {
        "account_id": record["account_id"],
        "account_label": record["account_label"],
        "account_plan": record["account_plan"],
        # Memory stores neither, and must not start: its record shape is
        # validated by exact set equality, so one extra field would make the
        # whole file unreadable and drop every remembered account (ADR
        # 20260822-586a). Null is also the honest value — a remembered row
        # states a past observation, not what any machine is signed into now.
        "reading_plan": None,
        "credential_plan": None,
        "account_state": "known",
        "presence": "remembered",
        "five_hour_used_pct": _quota_number(record["five_hour_used_pct"]),
        "five_hour_resets_at": _quota_number(record["five_hour_resets_at"]),
        "seven_day_used_pct": _quota_number(record["seven_day_used_pct"]),
        "seven_day_resets_at": _quota_number(record["seven_day_resets_at"]),
        "updated_at": record["observed_at"],
        "machines": [],
        "this_machine": None,
    }


@contextmanager
def _account_memory_upsert_epoch():
    with _ACCOUNT_MEMORY_LOCK:
        epoch = _ACCOUNT_MEMORY_DELETE_EPOCH
        _ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[epoch] += 1
    try:
        yield epoch
    finally:
        with _ACCOUNT_MEMORY_LOCK:
            remaining = _ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[epoch] - 1
            if remaining:
                _ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[epoch] = remaining
            else:
                del _ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[epoch]
            _prune_account_memory_deletions_locked()


def _prune_account_memory_deletions_locked():
    if not _ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS:
        _ACCOUNT_MEMORY_DELETED_AT_EPOCH.clear()
        return
    oldest_active_epoch = min(_ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS)
    for key, deleted_at_epoch in tuple(_ACCOUNT_MEMORY_DELETED_AT_EPOCH.items()):
        if deleted_at_epoch <= oldest_active_epoch:
            del _ACCOUNT_MEMORY_DELETED_AT_EPOCH[key]


def _upsert_account_memory(rate_limits, *, expected_delete_epoch):
    candidates = []
    for provider in ("claude", "codex"):
        provider_limits = rate_limits.get(provider)
        if not isinstance(provider_limits, dict):
            continue
        for entry in provider_limits.get("accounts", ()):
            candidate = _account_memory_entry(provider, entry)
            if candidate is not None:
                candidates.append(candidate)
    if not candidates:
        return False

    with _ACCOUNT_MEMORY_LOCK:
        state, payload = _load_account_memory()
        if state == "unreadable_or_unsupported":
            return False
        accounts = {
            key: _normalized_account_memory_record(record)
            for key, record in payload["accounts"].items()
        }
        changed = False
        for key, candidate in candidates:
            if (
                _ACCOUNT_MEMORY_DELETED_AT_EPOCH.get(key, 0)
                > expected_delete_epoch
            ):
                continue
            existing = accounts.get(key)
            if existing is not None:
                candidate_time = _observed_at(candidate["observed_at"])
                existing_time = _observed_at(existing["observed_at"])
                if candidate_time <= existing_time:
                    continue
            accounts[key] = candidate
            changed = True
        if not changed:
            return False
        _write_account_memory(
            {
                "version": _ACCOUNT_MEMORY_VERSION,
                "accounts": accounts,
            }
        )
        return True


def _remove_account_memory(provider, account_id, observed_at, live_rate_limits):
    global _ACCOUNT_MEMORY_DELETE_EPOCH
    key = "%s:%s" % (provider, account_id)
    with _ACCOUNT_MEMORY_LOCK:
        provider_limits = live_rate_limits.get(provider)
        entries = (
            provider_limits.get("accounts", ())
            if isinstance(provider_limits, dict)
            else ()
        )
        in_use_entries = [
            entry
            for entry in entries
            if entry.get("account_state") == "known"
            and entry.get("account_id") == account_id
        ]
        in_use_machines = sorted(
            {
                machine
                for entry in in_use_entries
                for machine in entry.get("machines", ())
            }
        )
        if in_use_entries:
            return 409, {
                "error": "Account is still in use on: %s"
                % ", ".join(in_use_machines),
                "machines": in_use_machines,
            }
        unstamped_entries = [
            entry for entry in entries if entry.get("account_state") == "unstamped"
        ]
        unstamped_machines = sorted(
            {
                machine
                for entry in unstamped_entries
                for machine in entry.get("machines", ())
            }
        )
        if unstamped_entries:
            return 409, {
                "error": (
                    "Account ownership cannot be confirmed; update tt-web on: %s"
                    % ", ".join(unstamped_machines)
                ),
                "machines": unstamped_machines,
            }

        state, payload = _load_account_memory()
        if state == "unreadable_or_unsupported":
            return 500, {"error": "Account memory is unreadable or unsupported"}
        accounts = dict(payload["accounts"])
        record = accounts.get(key)
        if record is None:
            return 404, {"error": "Remembered account not found"}
        if record["observed_at"] != observed_at:
            return 409, {
                "error": (
                    "Remembered account changed since confirmation; refresh the "
                    "page and review the latest reading before removing it"
                )
            }
        del accounts[key]
        _write_account_memory(
            {
                "version": _ACCOUNT_MEMORY_VERSION,
                "accounts": accounts,
            }
        )
        _ACCOUNT_MEMORY_DELETE_EPOCH += 1
        _ACCOUNT_MEMORY_DELETED_AT_EPOCH[key] = _ACCOUNT_MEMORY_DELETE_EPOCH
        _prune_account_memory_deletions_locked()
        return 200, {
            "account_label": record["account_label"],
            "observed_at": record["observed_at"],
        }


def _account_memory_entry(provider, entry):
    if not isinstance(entry, dict) or entry.get("account_state") != "known":
        return None
    account_id = entry.get("account_id")
    observed_at = _observed_at(entry.get("updated_at"))
    if (
        provider not in ("claude", "codex")
        or not isinstance(account_id, str)
        or not account_id
    ):
        return None
    if observed_at is None:
        return None
    record = {
        "provider": provider,
        "account_id": account_id,
        "account_label": entry.get("account_label"),
        "account_plan": entry.get("account_plan"),
        "five_hour_used_pct": _quota_number(entry.get("five_hour_used_pct")),
        "five_hour_resets_at": _quota_number(entry.get("five_hour_resets_at")),
        "seven_day_used_pct": _quota_number(entry.get("seven_day_used_pct")),
        "seven_day_resets_at": _quota_number(entry.get("seven_day_resets_at")),
        "observed_at": observed_at.astimezone(timezone.utc).isoformat(),
    }
    return "%s:%s" % (provider, account_id), record


def _normalized_account_memory_record(record):
    normalized = dict(record)
    for field in _ACCOUNT_MEMORY_NUMERIC_FIELDS:
        normalized[field] = _quota_number(normalized.get(field))
    return normalized


def _load_account_memory():
    try:
        raw = _ACCOUNT_MEMORY_PATH.read_bytes()
    except FileNotFoundError:
        return "missing", {"version": _ACCOUNT_MEMORY_VERSION, "accounts": {}}
    except OSError as exc:
        logger.warning("account memory is unreadable: %s: %s", type(exc).__name__, exc)
        return "unreadable_or_unsupported", None
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        logger.warning("account memory is unreadable: %s: %s", type(exc).__name__, exc)
        return "unreadable_or_unsupported", None
    if not _valid_account_memory(payload):
        logger.warning("account memory has an unreadable shape or unsupported version")
        return "unreadable_or_unsupported", None
    return "valid", payload


def _valid_account_memory(payload):
    if not isinstance(payload, dict) or set(payload) != {"version", "accounts"}:
        return False
    if payload.get("version") != _ACCOUNT_MEMORY_VERSION:
        return False
    accounts = payload.get("accounts")
    if not isinstance(accounts, dict):
        return False
    for key, record in accounts.items():
        if not isinstance(key, str) or not isinstance(record, dict):
            return False
        if set(record) != _ACCOUNT_MEMORY_ENTRY_FIELDS:
            return False
        provider = record.get("provider")
        account_id = record.get("account_id")
        if provider not in ("claude", "codex"):
            return False
        if not isinstance(account_id, str) or not account_id:
            return False
        if key != "%s:%s" % (provider, account_id):
            return False
        if record.get("account_label") is not None and not isinstance(
            record["account_label"], str
        ):
            return False
        if record.get("account_plan") is not None and not isinstance(
            record["account_plan"], str
        ):
            return False
        if _observed_at(record.get("observed_at")) is None:
            return False
    return True


def _write_account_memory(payload):
    parent = _ACCOUNT_MEMORY_PATH.parent
    parent_created = not parent.exists()
    parent.mkdir(parents=True, exist_ok=True)
    if parent_created:
        generation._fsync_directory(parent.parent)
    temporary = parent / (".%s-%s" % (_ACCOUNT_MEMORY_PATH.name, uuid.uuid4().hex))
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(
                payload,
                handle,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
                allow_nan=False,
            )
            handle.write("\n")
            handle.flush()
        generation._fsync_file(temporary)
        os.replace(temporary, _ACCOUNT_MEMORY_PATH)
        generation._fsync_directory(parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def _observed_at(value):
    """Observation time, always tz-aware, so readings stay comparable.

    Codex rollouts carry tz-naive timestamps (`parsers/codex.py` normalizes them
    for its own `max()`, and `tests/test_codex_rate_limits.py` pins that they
    occur), while Claude's are offset-aware. Comparing one of each raises, and
    both comparisons here span machines — so one machine with a naive timestamp
    would take out the Overview for all of them. Naive is read as UTC, which is
    what the exporters mean by it.
    """
    parsed = _parse_timestamp(value)
    if parsed is None:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _account_id(block):
    """The account id, or None. Anything that is not a usable id reads as None.

    The generation schema validates `rate_limits` only as "an object" — nothing
    checks what is inside it — and this value is now a dict key and a rendered
    string. A machine publishing a malformed field must cost its own quota row,
    not the whole Overview payload it happens to travel in.
    """
    account_id = block.get("account_id")
    return account_id if isinstance(account_id, str) and account_id else None


def _quota_number(value):
    """A standard-JSON number, or None when one malformed field is unusable.

    `rate_limits` blocks intentionally have no inner wire schema. Normalizing at
    each server-side boundary keeps one machine or remembered record's bad
    field from turning the whole Overview response into JSON the browser cannot
    parse, without rejecting the other rows in the same memory file.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value):
        return value
    return None


def _plan_to_show(block):
    """The plan a row displays, derived here rather than taken on trust.

    An exporter that predates the two raw fields sends neither key, and its
    `account_plan` is then the only plan available. Once a block carries the
    keys, that value is a claim by one writer among several — every machine
    runs its own exporter, at its own version, and nothing between them checks
    that it agrees with the pair beside it. Past that point the pair is the
    whole answer, including when the answer is "neither source reported one".
    """
    reading = _text(block.get("reading_plan"))
    credential = _text(block.get("credential_plan"))
    if reading or credential:
        return reading or credential
    if "reading_plan" in block or "credential_plan" in block:
        return None
    return _text(block.get("account_plan"))


def _account_entry(block, machines, self_machine=None):
    account_id = _account_id(block)
    if account_id:
        account_state = "known"
    elif block.get("account_id") is None and "account_id" in block:
        account_state = "signed_out"
    else:
        account_state = "unstamped"
    return {
        "account_id": account_id,
        "account_label": _text(block.get("account_label")),
        # Derived here, not taken from the block. The exporter derives the same
        # value, but it is one of several writers — every other machine runs its
        # own, at its own version, and nothing between them validates that a
        # published `account_plan` agrees with the pair beside it. Trusting it
        # would let a block claim a plan neither source reported, and that value
        # does not stop at the screen: it is what the account memory persists,
        # and that file cannot be rebuilt. Recomputing costs nothing and makes
        # the contradiction unrepresentable downstream.
        #
        # The block's own value is the last resort, and only for exporters older
        # than the pair — where it is the one plan on offer. That is a question
        # about whether the keys are there, not about whether they hold
        # anything: a current exporter that read neither source publishes both
        # keys as null, and falling back on falsiness would hand that block the
        # very value this recomputation exists to distrust. `account_id` two
        # fields up already draws the line this way, for the same reason.
        "account_plan": _plan_to_show(block),
        # The two facts behind it, passed through unmerged so that having
        # fewer than two comparable sources stays tellable apart from two that
        # agree — the derived value alone cannot express the difference. An
        # exporter that predates ADR 20260822-586a sends neither key, so such a
        # row has zero sources, not one; either way nothing is compared, and
        # that is not the same as comparing and finding them equal.
        "reading_plan": _text(block.get("reading_plan")),
        "credential_plan": _text(block.get("credential_plan")),
        # Three states, not two. "Signed out" and "reported by an exporter too
        # old to stamp accounts" both leave no account, but only the second is
        # fixed by updating that machine — telling a current machine to update
        # itself sends the reader after a problem they do not have.
        "account_state": account_state,
        # `*_used_pct`, not `*_pct`: the page shows headroom, and a name that
        # does not say which direction it runs is one rename away from being
        # rendered upside down. The wire field it comes from keeps its old name
        # — that one is written by other machines and cannot be renamed without
        # a flag day.
        "five_hour_used_pct": _quota_number(block.get("five_hour_pct")),
        "five_hour_resets_at": _quota_number(block.get("five_hour_resets_at")),
        "seven_day_used_pct": _quota_number(block.get("seven_day_pct")),
        "seven_day_resets_at": _quota_number(block.get("seven_day_resets_at")),
        "updated_at": block.get("updated_at"),
        "machines": sorted(machines),
        # Marked so a row can say which account the session in front of the
        # reader is spending. Three e-mail addresses do not tell them that; the
        # machine list does, but only once one of the names is singled out.
        "this_machine": self_machine if self_machine in machines else None,
    }


def _self_machine_name(admission):
    """Which declared machine is this one, via the config's own accessor.

    `load_machine_config` already refuses a config that does not name exactly
    one, so this does not re-derive that rule — it only tolerates an admission
    built without a config, which happens in tests.
    """
    config = getattr(admission, "config", None)
    if config is None:
        return None
    try:
        return config.self_machine.name
    except (AttributeError, StopIteration):
        return None


def _text(value):
    return value if isinstance(value, str) and value else None


def _quota_unavailable_reason(provider, sync_status):
    machine_errors = [
        "%s: %s" % (machine["name"], machine["reason"])
        for machine in (sync_status or {}).get("machines", ())
        if machine.get("reason")
        and machine.get("last_attempt_outcome")
        in {"failure", "cleanup_failed", "malformed_result"}
    ]
    if machine_errors:
        return (
            "Latest sync failed before an admitted generation supplied %s quota data: %s."
            % (provider, "; ".join(machine_errors))
        )
    if (sync_status or {}).get("syncing"):
        return (
            "Admitted generations do not yet contain %s quota data; sync is in progress."
            % provider
        )
    return (
        "Admitted generations do not yet contain %s quota data; a successful refresh is required."
        % provider
    )


def _first(query, key, default):
    values = query.get(key)
    return values[0] if values else default


def _start_of_day(value):
    return value.astimezone(rollup.BUCKET_TIMEZONE).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def _start_of_week(value):
    start = _start_of_day(value)
    return start - timedelta(days=start.weekday())


def _start_of_month(value):
    return value.astimezone(rollup.BUCKET_TIMEZONE).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0
    )


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError("Unsupported JSON value: %r" % (value,))


def main():
    global _BIND_HOST, _BIND_PORT
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=39001)
    args = parser.parse_args()
    _BIND_HOST, _BIND_PORT = args.host, args.port

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    _capture_startup_machine_config()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logger.info("tt-web listening on http://%s:%s", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
