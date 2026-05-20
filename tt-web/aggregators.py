import subprocess
import os
from collections import OrderedDict, defaultdict
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

from parsers import UsageEntry
from parsers import claude, codex


TIME_DIMS = {"day", "week", "month"}
ALL_DIMS = TIME_DIMS | {"project", "model", "agent"}
METRICS = {"cost", "input", "output", "cache_read", "cache_creation", "total", "messages"}
_GLOBAL_USAGE_CACHE = None
_PROJECT_CACHE = {}


def pivot(
    entries,
    x_dim,
    group_dim,
    metric,
    agents=None,
    projects=None,
    models=None,
    time_range=None,
):
    _validate(x_dim, group_dim, metric)
    filtered = [
        entry
        for entry in entries
        if _included(entry, agents=agents, projects=projects, models=models, time_range=time_range)
    ]

    columns = ["value"] if group_dim == "none" else _ordered_unique(extract_dim(entry, group_dim) for entry in filtered)
    buckets = defaultdict(lambda: {"value": 0, "known": 0})
    row_keys = OrderedDict()

    for entry in filtered:
        x_value = extract_dim(entry, x_dim)
        column = "value" if group_dim == "none" else extract_dim(entry, group_dim)
        row_keys.setdefault(x_value, None)
        metric_value = extract_metric(entry, metric)
        bucket = buckets[(x_value, column)]
        if metric == "cost":
            if metric_value is None:
                continue
            bucket["known"] += 1
        bucket["value"] += metric_value or 0

    rows = []
    for x_value in row_keys:
        values = {}
        for column in columns:
            bucket = buckets.get((x_value, column))
            if metric == "cost" and (not bucket or bucket["known"] == 0):
                values[column] = None
            else:
                values[column] = bucket["value"] if bucket else 0
        rows.append({"x": x_value, "values": values})

    if x_dim in TIME_DIMS:
        rows.sort(key=lambda row: row["x"])
    else:
        rows.sort(key=lambda row: _row_total(row), reverse=True)

    return {"columns": columns, "rows": rows}


def extract_dim(entry, dim):
    if dim == "day":
        return entry.timestamp.astimezone().date().isoformat()
    if dim == "week":
        local = entry.timestamp.astimezone()
        monday = local.date() - timedelta(days=local.weekday())
        return monday.isoformat()
    if dim == "month":
        return entry.timestamp.astimezone().strftime("%Y-%m")
    if dim == "project":
        return entry.project
    if dim == "model":
        return entry.model
    if dim == "agent":
        return entry.agent_id
    raise ValueError("Unsupported dimension: %s" % dim)


def extract_metric(entry, metric):
    if metric == "cost":
        return entry.cost_usd
    if metric == "input":
        return entry.input_tokens
    if metric == "output":
        return entry.output_tokens
    if metric == "cache_read":
        return entry.cache_read_tokens
    if metric == "cache_creation":
        return entry.cache_creation_tokens
    if metric == "total":
        return (
            entry.input_tokens
            + entry.output_tokens
            + entry.cache_read_tokens
            + entry.cache_creation_tokens
        )
    if metric == "messages":
        return entry.message_count
    raise ValueError("Unsupported metric: %s" % metric)


def identify_project(path, cache):
    if path in cache:
        return cache[path]
    try:
        result = subprocess.run(
            ["git", "-C", path, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0 and result.stdout.strip():
            project = normalize_remote(result.stdout.strip())
        else:
            project = path
    except (subprocess.TimeoutExpired, FileNotFoundError):
        project = path
    cache[path] = project
    return project


def normalize_remote(remote):
    remote = remote.strip()
    if remote.startswith("git@"):
        remote = remote[4:].replace(":", "/", 1)
    elif remote.startswith("ssh://git@"):
        remote = remote[len("ssh://git@") :].replace(":", "/", 1)
    elif "://" in remote:
        remote = remote.split("://", 1)[1]
    if remote.endswith(".git"):
        remote = remote[:-4]
    return remote.strip("/")


def load_all_entries(force_reload=False):
    global _GLOBAL_USAGE_CACHE
    if _GLOBAL_USAGE_CACHE is None:
        from cache import MtimeCache

        _GLOBAL_USAGE_CACHE = MtimeCache(_usage_paths, _parse_usage_file)
    if force_reload:
        _GLOBAL_USAGE_CACHE.clear()
    entries = _GLOBAL_USAGE_CACHE.load()
    return _with_calculated_costs(entries)


def _with_calculated_costs(entries):
    try:
        from pricing_fetcher import calculate_cost, get_pricing
    except ImportError:
        return sorted(entries, key=lambda entry: entry.timestamp)

    pricing = get_pricing()
    enriched = []
    for entry in entries:
        cost = calculate_cost(entry, pricing=pricing)
        project = identify_project(entry.project, _PROJECT_CACHE) if _looks_like_path(entry.project) else entry.project
        enriched.append(replace(entry, cost_usd=cost, project=project))
    enriched.sort(key=lambda entry: entry.timestamp)
    return enriched


def _usage_paths():
    paths = []
    for base_dir in claude._get_claude_dirs():
        base = Path(base_dir)
        if base.is_dir():
            paths.extend(base.rglob("*.jsonl"))
    codex_sessions = Path(codex.SESSIONS_DIR)
    if codex_sessions.is_dir():
        paths.extend(codex_sessions.rglob("*.jsonl"))
    extra = os.environ.get("TT_WEB_EXTRA_JSONL", "")
    for raw_path in extra.split(","):
        if raw_path.strip():
            paths.append(Path(raw_path.strip()))
    return paths


def _parse_usage_file(path):
    path = Path(path)
    codex_root = str(Path(codex.SESSIONS_DIR))
    if str(path).startswith(codex_root):
        return codex.parse_file(path, models=codex._load_thread_models(codex.STATE_DB))

    fallback_project = "unknown"
    for base_dir in claude._get_claude_dirs():
        base = Path(base_dir)
        try:
            path.relative_to(base)
        except ValueError:
            continue
        fallback_project = claude._extract_project_from_dir(path, base)
        break
    return claude.parse_file(path, fallback_project=fallback_project)


def _looks_like_path(value):
    return isinstance(value, str) and (value.startswith("/") or value.startswith("~"))


def _included(entry, agents=None, projects=None, models=None, time_range=None):
    if agents is not None and entry.agent_id not in agents:
        return False
    if projects is not None and entry.project not in projects:
        return False
    if models is not None and entry.model not in models:
        return False
    if time_range is not None:
        start, end = time_range
        if entry.timestamp < start or entry.timestamp >= end:
            return False
    return True


def _ordered_unique(values):
    seen = OrderedDict()
    for value in values:
        seen.setdefault(value, None)
    return sorted(seen.keys())


def _row_total(row):
    total = 0
    for value in row["values"].values():
        total += value or 0
    return total


def _validate(x_dim, group_dim, metric):
    if x_dim not in ALL_DIMS:
        raise ValueError("Unsupported x_dim: %s" % x_dim)
    if group_dim != "none" and group_dim not in ALL_DIMS:
        raise ValueError("Unsupported group_dim: %s" % group_dim)
    if metric not in METRICS:
        raise ValueError("Unsupported metric: %s" % metric)
