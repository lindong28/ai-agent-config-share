import argparse
import json
import logging
import mimetypes
import os
import subprocess
import time
from collections import defaultdict
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

from aggregators import extract_metric, load_all_entries, pivot
from parsers import claude_status, codex


ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
logger = logging.getLogger("tt-web")
_NETWORK_CACHE = {"ts": 0.0, "data": None}
_NETWORK_TTL = 60.0


def overview(query):
    entries = load_all_entries()
    now = datetime.now().astimezone()
    range_window = _range_window(_first(query, "range", "30d"), now)
    visible = _filter_time(entries, range_window)
    today_window = (_start_of_day(now), now)
    week_window = (_start_of_week(now), now)
    month_window = (_start_of_month(now), now)
    last_30_window = (now - timedelta(days=30), now)

    return {
        "rate_limits": _rate_limits(),
        "today": _summary(_filter_time(entries, today_window)),
        "week": _summary(_filter_time(entries, week_window)),
        "range": _summary(visible),
        "daily_cost_30d": _daily_cost(_filter_time(entries, last_30_window), now),
        "top_projects_week": _top_projects(_filter_time(entries, week_window), limit=5),
        "model_mix_month": _model_mix(_filter_time(entries, month_window)),
        "codex_cost_estimated": True,
    }


def pivot_endpoint(query):
    entries = load_all_entries()
    now = datetime.now().astimezone()
    return pivot(
        entries,
        _first(query, "x", "day"),
        _first(query, "group", "none"),
        _first(query, "metric", "cost"),
        agents=set(query.get("agent", [])) or None,
        projects=set(query.get("project", [])) or None,
        models=set(query.get("model", [])) or None,
        time_range=_range_window(_first(query, "range", "30d"), now),
    )


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


def health(_query):
    return {"ok": True}


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
    "/api/sessions": sessions_endpoint,
    "/api/network": network,
}


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        self._handle_request(send_body=False)

    def do_GET(self):
        self._handle_request(send_body=True)

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
        self.end_headers()
        if send_body:
            self.wfile.write(data)


def _range_window(value, now):
    if value == "all":
        return None
    days = {"7d": 7, "30d": 30, "90d": 90}.get(value, 30)
    return (now - timedelta(days=days), now)


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


def _daily_cost(entries, now):
    days = []
    by_day = defaultdict(lambda: {"claude_cost": 0.0, "codex_cost": 0.0})
    for entry in entries:
        day = entry.timestamp.astimezone().date().isoformat()
        if entry.cost_usd is None:
            continue
        key = "codex_cost" if entry.agent_id == "codex" else "claude_cost"
        by_day[day][key] += entry.cost_usd
    start = (now - timedelta(days=29)).date()
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
        "estimated": entries[0].agent_id == "codex",
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


def _rate_limits():
    return {
        "claude": _provider_block(claude_status.load_rate_limits()),
        "codex": _provider_block(codex.load_rate_limits()),
    }


def _provider_block(limits):
    if not limits:
        return {
            "five_hour_pct": None,
            "five_hour_resets_at": None,
            "seven_day_pct": None,
            "seven_day_resets_at": None,
            "updated_at": None,
        }
    return {
        "five_hour_pct": limits.five_hour_pct,
        "five_hour_resets_at": limits.five_hour_resets_at,
        "seven_day_pct": limits.seven_day_pct,
        "seven_day_resets_at": limits.seven_day_resets_at,
        "updated_at": limits.updated_at,
    }


def _first(query, key, default):
    values = query.get(key)
    return values[0] if values else default


def _start_of_day(value):
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def _start_of_week(value):
    start = _start_of_day(value)
    return start - timedelta(days=start.weekday())


def _start_of_month(value):
    return value.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def _json_default(value):
    if isinstance(value, datetime):
        return value.isoformat()
    raise TypeError("Unsupported JSON value: %r" % (value,))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=39001)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logger.info("tt-web listening on http://%s:%s", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
