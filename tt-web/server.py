import argparse
import hashlib
import json
import logging
import mimetypes
import os
import subprocess
import sys
import threading
import time
import uuid
from collections import defaultdict
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


def _overview_from_admission(query, admission, *, completed_before, sync_started):
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
        "rate_limits": _rate_limits(admission=admission, sync_status=sync_status),
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
        if parsed.path == "/api/restart":
            self._handle_restart()
            return
        self.send_error(404)

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


def _rate_limits(admission=None, sync_status=None):
    if admission is None:
        with generation.generation_admission_snapshot() as loaded:
            return _rate_limits_from_admission(loaded, sync_status=sync_status)
    return _rate_limits_from_admission(admission, sync_status=sync_status)


def _rate_limits_from_admission(admission, sync_status=None):
    selected = {"claude": None, "codex": None}
    for current in admission.admitted:
        for provider in selected:
            block = current.meta["rate_limits"].get(provider)
            updated_at = _parse_timestamp(
                block.get("updated_at") if isinstance(block, dict) else None
            )
            if updated_at is None:
                continue
            previous = selected[provider]
            if previous is None or updated_at > previous[0]:
                selected[provider] = (updated_at, current.host, block)
    return {
        provider: _provider_block(value[2], source_machine=value[1])
        if value is not None
        else _provider_block(
            None,
            unavailable_reason=_quota_unavailable_reason(provider, sync_status),
        )
        for provider, value in selected.items()
    }


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


def _provider_block(limits, *, source_machine=None, unavailable_reason=None):
    if not limits:
        return {
            "five_hour_pct": None,
            "five_hour_resets_at": None,
            "seven_day_pct": None,
            "seven_day_resets_at": None,
            "updated_at": None,
            "source_machine": None,
            "unavailable_reason": unavailable_reason,
        }
    return {
        "five_hour_pct": limits.get("five_hour_pct"),
        "five_hour_resets_at": limits.get("five_hour_resets_at"),
        "seven_day_pct": limits.get("seven_day_pct"),
        "seven_day_resets_at": limits.get("seven_day_resets_at"),
        "updated_at": limits.get("updated_at"),
        "source_machine": source_machine,
        "unavailable_reason": None,
    }


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
