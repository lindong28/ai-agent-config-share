import errno
import fcntl
import json
import os
import sqlite3
import sys
import threading
import time
from collections import OrderedDict, defaultdict
from contextlib import closing, contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from aggregators import load_all_entries


ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = ROOT / "state" / "rollup.db"
DEFAULT_WINDOW_DAYS = 28
BUCKET_TIMEZONE_NAME = "Asia/Shanghai"
BUCKET_TIMEZONE = ZoneInfo(BUCKET_TIMEZONE_NAME)
RANGE_DAYS = {"7d": 7, "30d": 30, "90d": 90, "6m": 180, "1y": 365, "2y": 730}
TIME_DIMS = {"day", "week", "month"}
ALL_DIMS = TIME_DIMS | {"project", "model", "agent", "machine"}
METRICS = {"cost", "input", "output", "cache_read", "cache_creation", "total", "messages"}
TOP_DIMENSION_THRESHOLD = 15
TOP_DIMENSION_LIMIT = 12
OTHER_BUCKET = "Other"
PROTECTED_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "entry_count",
    "message_count",
)
BUCKET_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "cost_usd",
    "cost_known_count",
    "entry_count",
    "message_count",
)
_LOCKS_GUARD = threading.Lock()
_PATH_LOCKS = {}
_LOCK_OWNERSHIP = threading.local()
_PINNED_GENERATIONS = threading.local()
_OPEN_LOCK_FDS = set()
_ACTIVE_LOCK_HOLDERS = {}


SCHEMA = """
CREATE TABLE IF NOT EXISTS daily_rollup (
  date TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_known_count INTEGER NOT NULL DEFAULT 0,
  entry_count INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, agent_id, project, model)
);
CREATE INDEX IF NOT EXISTS idx_daily_rollup_date ON daily_rollup(date);
CREATE TABLE IF NOT EXISTS rollup_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
"""


class RollupLockNotHeld(RuntimeError):
    pass


class _RollupLockUnavailable(BlockingIOError):
    pass


class _RollupLockNotInitialized(FileNotFoundError):
    pass


class RollupLockNestingError(RuntimeError):
    pass


class RollupBucketTimezoneMigrationRequired(RuntimeError):
    pass


class RollupAdoptionError(RuntimeError):
    pass


@dataclass(frozen=True)
class AdmittedGeneration:
    host: str
    db_path: Path
    _source: object = field(default=None, repr=False, compare=False)

    def close(self):
        if self._source is not None:
            self._source.close()


def admitted_generations():
    from generation import admitted_generations as load_admitted_generations

    return tuple(
        AdmittedGeneration(current.host, current.db_path, current)
        for current in load_admitted_generations()
    )


@contextmanager
def _admitted_generation_snapshot():
    pinned = getattr(_PINNED_GENERATIONS, "value", None)
    if pinned is not None:
        yield pinned
        return
    generations = admitted_generations()
    try:
        yield generations
    finally:
        for generation in generations:
            generation.close()


@contextmanager
def use_admitted_generations(currents):
    if getattr(_PINNED_GENERATIONS, "value", None) is not None:
        raise RuntimeError("admitted generation snapshots cannot be nested")
    _PINNED_GENERATIONS.value = tuple(
        AdmittedGeneration(current.host, current.db_path)
        for current in currents
    )
    try:
        yield
    finally:
        del _PINNED_GENERATIONS.value


def range_window(value, now=None):
    if value == "all":
        return None
    if isinstance(value, str) and value.endswith("d") and value[:-1].isdigit():
        days = int(value[:-1])
    else:
        days = RANGE_DAYS.get(value, 30)
    if days < 1:
        raise ValueError("range days must be positive")
    current = now() if callable(now) else now
    if current is None:
        current = datetime.now().astimezone()
    if current.tzinfo is None or current.utcoffset() is None:
        raise ValueError("range now must be timezone-aware")
    today = current.astimezone(BUCKET_TIMEZONE).date()
    return today - timedelta(days=days - 1), today


@contextmanager
def rollup_lock(db_path, blocking=True, timeout=30, create=True):
    if timeout is None:
        raise ValueError("timeout=None is not supported for rollup locks")
    if timeout < 0:
        raise ValueError("timeout must be >= 0")

    normalized_path = _normalize_db_path(db_path)
    deadline = time.monotonic() + timeout
    creator_pid = os.getpid()
    lock_fd = None
    path_lock = None
    acquired_thread_lock = False
    try:
        if create:
            Path(normalized_path).parent.mkdir(parents=True, exist_ok=True)
        try:
            lock_fd = _open_lock_file(normalized_path + ".lock", create=create)
        except FileNotFoundError as exc:
            raise _RollupLockNotInitialized(
                errno.ENOENT,
                "rollup lock has not been initialised",
                normalized_path + ".lock",
            ) from exc
        lock_identity = _lock_identity(lock_fd)
        ownership = _ownership_holders()
        if ownership and lock_identity not in ownership:
            raise RollupLockNestingError(
                "cannot acquire rollup lock for %s while another rollup database lock is held"
                % normalized_path
            )

        path_lock = _path_lock(lock_identity)
        acquired_thread_lock = _acquire_thread_lock(path_lock, blocking, deadline)
        if not acquired_thread_lock:
            raise _RollupLockUnavailable(
                errno.EWOULDBLOCK,
                "rollup lock is already held",
                normalized_path,
            )

        holder = ownership.get(lock_identity)
        if holder is not None:
            if holder["pid"] != creator_pid:
                raise RollupLockNotHeld(
                    "rollup lock ownership for %s belongs to another process" % normalized_path
                )
            holder["depth"] += 1
            _close_lock_fd(lock_fd)
            lock_fd = None
            try:
                yield
            finally:
                if os.getpid() == creator_pid and holder["pid"] == creator_pid:
                    holder["depth"] -= 1
                    path_lock.release()
                    acquired_thread_lock = False
            return

        _acquire_file_lock(lock_fd, normalized_path, blocking, deadline)
        holder = {
            "depth": 1,
            "fd": lock_fd,
            "pid": creator_pid,
            "path": normalized_path,
        }
        ownership[lock_identity] = holder
        _register_active_holder(lock_identity, holder)
        try:
            yield
        finally:
            if os.getpid() == creator_pid and holder["pid"] == creator_pid:
                if ownership.get(lock_identity) is holder:
                    ownership.pop(lock_identity, None)
                _unregister_active_holder(lock_identity, holder)
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
    finally:
        if os.getpid() == creator_pid:
            if lock_fd is not None:
                _close_lock_fd(lock_fd)
            if acquired_thread_lock:
                path_lock.release()


def run(
    window_days=DEFAULT_WINDOW_DAYS,
    db_path=DEFAULT_DB_PATH,
    entries_loader=load_all_entries,
    now=None,
    blocking=True,
):
    if window_days < 1:
        raise ValueError("window_days must be >= 1")

    lock_context = rollup_lock(db_path, blocking=blocking)
    try:
        lock_context.__enter__()
    except _RollupLockUnavailable:
        if not blocking:
            return None
        raise
    try:
        result = _run_locked(window_days, db_path, entries_loader, now)
    except BaseException:
        if not lock_context.__exit__(*sys.exc_info()):
            raise
    else:
        lock_context.__exit__(None, None, None)
        return result


def _run_locked(window_days, db_path, entries_loader, now):
    db_path = Path(db_path)
    _assert_lock_held(db_path)

    current = _now(now)
    today = _bucket_date(current)
    start_date = today - timedelta(days=window_days - 1)
    recompute_dates = [(start_date + timedelta(days=offset)).isoformat() for offset in range(window_days)]
    recompute_date_set = set(recompute_dates)
    if db_path.is_file():
        with _read_connection(db_path):
            pass
    loaded_entries = entries_loader()
    blocked_sources = list(getattr(loaded_entries, "blocked_sources", []))
    buckets = _bucket_entries(loaded_entries)

    db_path.parent.mkdir(parents=True, exist_ok=True)
    skipped_keys = []
    with closing(_connect(db_path)) as conn:
        with conn:
            conn.execute("BEGIN IMMEDIATE")
            buckets_to_write = _write_scope(buckets, recompute_date_set, conn)
            backfill_dates = {
                key[0] for key in buckets_to_write
            } - recompute_date_set
            for key, bucket in sorted(buckets_to_write.items()):
                old_values = conn.execute(
                    """
                    SELECT input_tokens,
                           output_tokens,
                           cache_creation_tokens,
                           cache_read_tokens,
                           cost_usd,
                           cost_known_count,
                           entry_count,
                           message_count
                    FROM daily_rollup
                    WHERE date = ? AND agent_id = ? AND project = ? AND model = ?
                    """,
                    key,
                ).fetchone()
                old_bucket = (
                    dict(zip(BUCKET_FIELDS, old_values))
                    if old_values is not None
                    else None
                )
                if _classify_bucket_change(old_bucket, bucket) == "skip":
                    skipped_keys.append(key)
                    continue

                conn.execute(
                    """
                    INSERT INTO daily_rollup (
                      date,
                      agent_id,
                      project,
                      model,
                      input_tokens,
                      output_tokens,
                      cache_creation_tokens,
                      cache_read_tokens,
                      cost_usd,
                      cost_known_count,
                      entry_count,
                      message_count
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(date, agent_id, project, model) DO UPDATE SET
                      input_tokens = excluded.input_tokens,
                      output_tokens = excluded.output_tokens,
                      cache_creation_tokens = excluded.cache_creation_tokens,
                      cache_read_tokens = excluded.cache_read_tokens,
                      cost_usd = excluded.cost_usd,
                      cost_known_count = excluded.cost_known_count,
                      entry_count = excluded.entry_count,
                      message_count = excluded.message_count
                    """,
                    _bucket_tuple(key, bucket),
                )
            conn.execute(
                """
                INSERT INTO rollup_meta (key, value)
                VALUES ('last_rollup_ts', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """,
                (current.isoformat(),),
            )

    return {
        "db_path": str(db_path),
        "window_days": window_days,
        "days_recomputed": len(recompute_dates),
        "dates_backfilled": len(backfill_dates),
        "buckets_written": len(buckets_to_write) - len(skipped_keys),
        "buckets_skipped": len(skipped_keys),
        "skipped_keys": skipped_keys,
        "sources_blocked": len(blocked_sources),
        "blocked_sources": blocked_sources,
        "last_rollup_ts": current.isoformat(),
    }


def _check_rollup(
    db_path,
    entries_loader,
    window_days=DEFAULT_WINDOW_DAYS,
    now=None,
):
    if window_days < 1:
        raise ValueError("window_days must be >= 1")

    normalized_path = _normalize_db_path(db_path)
    current = _now(now)
    today = _bucket_date(current)
    start_date = today - timedelta(days=window_days - 1)
    try:
        with rollup_lock(normalized_path, create=False):
            try:
                db_state, existing = _read_check_rows(normalized_path)
            except RollupBucketTimezoneMigrationRequired as exc:
                return _empty_check_result(
                    normalized_path,
                    start_date,
                    today,
                    window_days,
                    db_state="bucket_timezone_migration_required",
                    error=_check_error("bucket_timezone", normalized_path, exc),
                )
            except (OSError, sqlite3.Error) as exc:
                return _empty_check_result(
                    normalized_path,
                    start_date,
                    today,
                    window_days,
                    db_state="unreadable",
                    error=_check_error("database", normalized_path, exc),
                )
            if db_state != "ready":
                return _empty_check_result(
                    normalized_path,
                    start_date,
                    today,
                    window_days,
                    db_state=db_state,
                )
            try:
                loaded_entries = entries_loader()
            except Exception as exc:
                return _empty_check_result(
                    normalized_path,
                    start_date,
                    today,
                    window_days,
                    db_state="ready",
                    existing=existing,
                    source_error=_check_error("load", None, exc),
                )
            buckets = _bucket_entries(loaded_entries)
    except _RollupLockNotInitialized:
        db_state = "snapshot_unavailable" if Path(normalized_path).is_file() else "not_initialised"
        return _empty_check_result(
            normalized_path,
            start_date,
            today,
            window_days,
            db_state=db_state,
            error={
                "stage": "snapshot",
                "path": normalized_path + ".lock",
                "error": "rollup lock is not initialised; cannot obtain a consistent snapshot",
            },
        )

    existing_by_key = {tuple(item["key"]): item["values"] for item in existing}
    existing_dates = {key[0] for key in existing_by_key}
    source_dates = {key[0] for key in buckets}
    recompute_dates = {
        (start_date + timedelta(days=offset)).isoformat()
        for offset in range(window_days)
    }
    backfill_dates = source_dates - recompute_dates - existing_dates
    # Same scope as the writer's _write_scope.
    buckets_to_compare = {
        key: bucket
        for key, bucket in buckets.items()
        if key[0] in recompute_dates or key[0] in backfill_dates
    }

    orphan_items = [
        {"key": list(key), "old": _ordered_bucket(old_bucket)}
        for key, old_bucket in sorted(existing_by_key.items())
        if key not in buckets
    ]
    skip_items = []
    write_items = []
    for key, bucket in sorted(buckets_to_compare.items()):
        old_bucket = existing_by_key.get(key)
        classification = _classify_bucket_change(old_bucket, bucket)
        if classification == "skip":
            skip_items.append(
                {
                    "key": list(key),
                    "old": _ordered_bucket(old_bucket),
                    "new": _ordered_bucket(bucket),
                    "decreased_fields": [
                        field
                        for field in PROTECTED_FIELDS
                        if bucket[field] < old_bucket[field]
                    ],
                }
            )
        elif classification == "write":
            write_items.append(
                {
                    "key": list(key),
                    "reason": "new" if old_bucket is None else "changed",
                    "old": _ordered_bucket(old_bucket) if old_bucket is not None else None,
                    "new": _ordered_bucket(bucket),
                }
            )

    persisted_blockers = [
        dict(blocker)
        for blocker in getattr(loaded_entries, "persisted_blockers", [])
    ]
    current_blockers = [
        dict(blocker)
        for blocker in getattr(loaded_entries, "current_blockers", [])
    ]
    blockers_by_path = {
        blocker["source_path"]: dict(blocker)
        for blocker in getattr(loaded_entries, "blocked_sources", [])
    }
    blocked_sources = [blockers_by_path[path] for path in sorted(blockers_by_path)]
    source_errors = [dict(error) for error in getattr(loaded_entries, "source_errors", [])]
    scan_complete = bool(getattr(loaded_entries, "scan_complete", not source_errors))
    dates = sorted(key[0] for key in existing_by_key)
    verdict = "attention" if skip_items else "safe"
    if not scan_complete or source_errors:
        status = "indeterminate"
    elif blocked_sources or skip_items:
        status = "attention"
    else:
        status = "safe"
    return {
        "db_path": normalized_path,
        "db_state": "ready",
        "db_span": {
            "start": dates[0] if dates else None,
            "end": dates[-1] if dates else None,
            "rows": len(existing_by_key),
        },
        "window": {
            "start": start_date.isoformat(),
            "end": today.isoformat(),
            "days": window_days,
        },
        "orphan_rows": {"count": len(orphan_items), "items": orphan_items},
        "would_skip": {"count": len(skip_items), "items": skip_items},
        "would_write": {"count": len(write_items), "items": write_items},
        "scan_complete": scan_complete,
        "source_errors": source_errors,
        "diagnostic_errors": [],
        "sources_blocked": len(blocked_sources),
        "blocked_sources": blocked_sources,
        "persisted_blockers": persisted_blockers,
        "current_blockers": current_blockers,
        "verdict": verdict,
        "status": status,
    }


def _read_check_rows(db_path):
    with _read_connection(db_path, immutable=True) as conn:
        if conn is None:
            return "missing", []
        if not _table_exists(conn, "daily_rollup"):
            return "not_initialised", []
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN")
        try:
            rows = conn.execute(
                """
                SELECT date, agent_id, project, model,
                       input_tokens, output_tokens,
                       cache_creation_tokens, cache_read_tokens,
                       cost_usd, cost_known_count, entry_count, message_count
                FROM daily_rollup
                ORDER BY date, agent_id, project, model
                """
            ).fetchall()
        finally:
            conn.rollback()
    return "ready", [
        {
            "key": [row["date"], row["agent_id"], row["project"], row["model"]],
            "values": {field: row[field] for field in BUCKET_FIELDS},
        }
        for row in rows
    ]


def _empty_check_result(
    db_path,
    start_date,
    today,
    window_days,
    db_state,
    existing=(),
    source_error=None,
    error=None,
):
    dates = sorted(item["key"][0] for item in existing)
    source_errors = [source_error] if source_error is not None else []
    diagnostic_errors = [error] if error is not None else []
    return {
        "db_path": db_path,
        "db_state": db_state,
        "db_span": {
            "start": dates[0] if dates else None,
            "end": dates[-1] if dates else None,
            "rows": len(existing),
        },
        "window": {
            "start": start_date.isoformat(),
            "end": today.isoformat(),
            "days": window_days,
        },
        "orphan_rows": {"count": 0, "items": []},
        "would_skip": {"count": 0, "items": []},
        "would_write": {"count": 0, "items": []},
        "scan_complete": False,
        "source_errors": source_errors,
        "diagnostic_errors": diagnostic_errors,
        "sources_blocked": 0,
        "blocked_sources": [],
        "persisted_blockers": [],
        "current_blockers": [],
        "verdict": "unknown",
        "status": "indeterminate",
    }


def _check_error(stage, path, exc):
    return {
        "stage": stage,
        "path": str(path) if path is not None else None,
        "error": "%s: %s" % (type(exc).__name__, exc),
    }


def _classify_bucket_change(old_bucket, new_bucket):
    if old_bucket is None:
        return "write"
    if any(new_bucket[field] < old_bucket[field] for field in PROTECTED_FIELDS):
        return "skip"
    if any(new_bucket[field] != old_bucket[field] for field in BUCKET_FIELDS):
        return "write"
    return "unchanged"


def _ordered_bucket(bucket):
    return {field: bucket[field] for field in BUCKET_FIELDS}


def query_pivot(
    x_dim,
    group_dim,
    metric,
    agents=None,
    projects=None,
    models=None,
    machines=None,
    time_range=None,
    calendar_days=None,
    db_path=None,
    source_machine=None,
):
    _validate(x_dim, group_dim, metric)
    _validate_machine_source(x_dim, group_dim, machines, db_path, source_machine)
    filters = {
        "agent": set(agents or []),
        "project": set(projects or []),
        "model": set(models or []),
        "machine": set(machines or []),
    }
    rows = _daily_rows(
        db_path,
        time_range,
        calendar_days=calendar_days,
        source_machine=source_machine,
    )
    filtered = [row for row in rows if _row_included(row, filters)]
    x_values, x_map = _dimension_reduction(filtered, x_dim, metric)
    column_values, group_map = _dimension_reduction(filtered, group_dim, metric)

    if group_dim == "none":
        columns = ["value"]
    else:
        columns = column_values

    row_keys = OrderedDict()
    buckets = defaultdict(lambda: {"value": 0, "known": 0})
    for row in filtered:
        x_value = _mapped_dim(row, x_dim, x_map)
        column = "value" if group_dim == "none" else _mapped_dim(row, group_dim, group_map)
        row_keys.setdefault(x_value, None)
        bucket = buckets[(x_value, column)]
        if metric == "cost":
            if row["cost_known_count"] == 0:
                continue
            bucket["known"] += row["cost_known_count"]
        bucket["value"] += _row_metric(row, metric)

    result_rows = []
    for x_value in row_keys:
        values = {}
        for column in columns:
            bucket = buckets.get((x_value, column))
            if metric == "cost" and (not bucket or bucket["known"] == 0):
                values[column] = None
            else:
                values[column] = bucket["value"] if bucket else 0
        result_rows.append({"x": x_value, "values": values})

    if x_dim in TIME_DIMS:
        result_rows.sort(key=lambda row: row["x"])
    else:
        result_rows.sort(key=_row_total, reverse=True)
    return {"columns": columns, "rows": result_rows}


def filter_options(
    time_range=None,
    calendar_days=None,
    db_path=None,
    source_machine=None,
):
    if db_path is None and source_machine is not None:
        raise ValueError("source_machine is only valid with an explicit db_path")
    rows = _daily_rows(
        db_path,
        time_range,
        calendar_days=calendar_days,
        source_machine=source_machine,
    )
    values = {"agent": set(), "project": set(), "model": set(), "machine": set()}
    for row in rows:
        values["agent"].add(row["agent_id"])
        values["project"].add(row["project"])
        values["model"].add(row["model"])
        if "host" in row:
            values["machine"].add(row["host"])
    return {key: sorted(items) for key, items in values.items()}


def last_rollup_ts(db_path=DEFAULT_DB_PATH):
    db_path = Path(db_path)
    with _read_connection(db_path) as conn:
        if conn is None or not _table_exists(conn, "rollup_meta"):
            return None
        row = conn.execute("SELECT value FROM rollup_meta WHERE key = 'last_rollup_ts'").fetchone()
    if not row:
        return None
    try:
        return datetime.fromisoformat(row[0])
    except ValueError:
        return None


def needs_run(max_age_seconds=600, db_path=DEFAULT_DB_PATH, now=None):
    try:
        previous = last_rollup_ts(db_path=db_path)
    except RollupBucketTimezoneMigrationRequired:
        return False
    if previous is None:
        return True
    age = (_now(now) - previous.astimezone()).total_seconds()
    return age > max_age_seconds


def latest_rollup_date(db_path=None):
    if db_path is None:
        dates = []
        with _admitted_generation_snapshot() as generations:
            for generation in generations:
                value = latest_rollup_date(generation.db_path)
                if value is not None:
                    dates.append(value)
        return max(dates) if dates else None
    db_path = Path(db_path)
    with _read_connection(db_path) as conn:
        if conn is None or not _table_exists(conn, "daily_rollup"):
            return None
        row = conn.execute("SELECT MAX(date) FROM daily_rollup").fetchone()
    return row[0] if row and row[0] else None


def earliest_rollup_date(db_path=None):
    if db_path is None:
        dates = []
        with _admitted_generation_snapshot() as generations:
            for generation in generations:
                value = earliest_rollup_date(generation.db_path)
                if value is not None:
                    dates.append(value)
        return min(dates) if dates else None
    db_path = Path(db_path)
    with _read_connection(db_path) as conn:
        if conn is None or not _table_exists(conn, "daily_rollup"):
            return None
        row = conn.execute("SELECT MIN(date) FROM daily_rollup").fetchone()
    return row[0] if row and row[0] else None


def history_gap(entries, max_gap_days=2, db_path=None, now=None):
    latest = latest_rollup_date(db_path=db_path)
    if latest is None:
        return None
    latest_date = date.fromisoformat(latest)
    current_date = _bucket_date(_now(now))
    gap_days = (current_date - latest_date).days
    if gap_days <= max_gap_days:
        return None

    source_dates = [_bucket_date(entry.timestamp) for entry in entries]
    if not source_dates or max(source_dates) <= latest_date:
        return None
    return {
        "latest_date": latest_date.isoformat(),
        "today": current_date.isoformat(),
        "gap_days": gap_days,
        "message": "History rollup is stale; cost before the latest rollup date may be incomplete.",
    }


def _connect(db_path):
    _assert_lock_held(db_path)
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        if _table_exists(conn, "daily_rollup"):
            _require_bucket_timezone(conn, db_path)
        _init_db(conn, db_path)
        with conn:
            _ensure_bucket_timezone(conn, db_path)
        return conn
    except BaseException:
        conn.close()
        raise


def adopt_bucket_timezone(
    db_path,
    entries,
    *,
    known_utc_offset,
    raw_log_starts,
    authorize_pre_log_assumption,
    authorize_non_exact_overlap_assumption,
    now=None,
):
    """Explicitly adopt an unmarked +08:00 legacy database.

    The caller must materialize the source snapshot before entering this
    function. Reader and ordinary writer chokepoints remain fail-closed.
    """
    db_path = Path(db_path)
    if _normalize_db_path(db_path) != _normalize_db_path(DEFAULT_DB_PATH):
        raise RollupAdoptionError(
            "legacy adoption target must be this owning host's canonical rollup database"
        )
    if known_utc_offset != "+08:00":
        raise RollupAdoptionError(
            "legacy adoption requires the known +08:00 machine fact"
        )
    if authorize_pre_log_assumption is not True:
        raise RollupAdoptionError(
            "legacy adoption requires explicit authorization for pre-log history"
        )
    if not isinstance(raw_log_starts, dict) or not raw_log_starts:
        raise RollupAdoptionError("raw_log_starts must name every adopted agent")
    try:
        parsed_starts = {
            agent: date.fromisoformat(value)
            for agent, value in raw_log_starts.items()
        }
    except (TypeError, ValueError) as exc:
        raise RollupAdoptionError("raw_log_starts must contain ISO dates") from exc
    if any(not isinstance(agent, str) or not agent for agent in parsed_starts):
        raise RollupAdoptionError("raw_log_starts agent names must be non-empty strings")
    if getattr(entries, "scan_complete", True) is not True:
        raise RollupAdoptionError("source scan is incomplete; adoption did not write")
    entries = list(entries)
    observed_now = _now(now)
    adopted_at = observed_now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    with rollup_lock(db_path):
        conn = sqlite3.connect(db_path, timeout=30)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=30000")
            conn.execute("BEGIN IMMEDIATE")
            if not _table_exists(conn, "daily_rollup") or not _table_exists(conn, "rollup_meta"):
                raise RollupAdoptionError("legacy rollup schema is incomplete")
            marker = conn.execute(
                "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
            ).fetchone()
            if marker is not None:
                raise RollupAdoptionError(
                    "legacy adoption only accepts an unmarked database; found %s" % marker[0]
                )
            last_rollup = conn.execute(
                "SELECT value FROM rollup_meta WHERE key = 'last_rollup_ts'"
            ).fetchone()
            if last_rollup is None:
                raise RollupAdoptionError(
                    "legacy adoption requires last_rollup_ts to bound source comparison"
                )
            try:
                comparison_cutoff = datetime.fromisoformat(
                    last_rollup[0].replace("Z", "+00:00")
                )
            except (AttributeError, TypeError, ValueError) as exc:
                raise RollupAdoptionError(
                    "legacy adoption requires a valid last_rollup_ts"
                ) from exc
            if comparison_cutoff.tzinfo is None or comparison_cutoff.utcoffset() is None:
                raise RollupAdoptionError(
                    "legacy adoption requires timezone-aware last_rollup_ts"
                )
            comparison_cutoff_utc = comparison_cutoff.astimezone(timezone.utc)
            comparison_entries = []
            post_rollup_entries = []
            for entry in entries:
                if entry.timestamp.tzinfo is None or entry.timestamp.utcoffset() is None:
                    raise RollupAdoptionError(
                        "source entries must have timezone-aware timestamps"
                    )
                if entry.timestamp.astimezone(timezone.utc) <= comparison_cutoff_utc:
                    agent = entry.agent_id or "unknown"
                    if (
                        agent in parsed_starts
                        and _bucket_date(entry.timestamp) >= parsed_starts[agent]
                    ):
                        comparison_entries.append(entry)
                else:
                    post_rollup_entries.append(entry)
            expected = _bucket_entries(comparison_entries)
            if not expected:
                raise RollupAdoptionError(
                    "reconstructible overlap is empty through last_rollup_ts; adoption did not write"
                )
            post_rollup_bucket_keys = set(_bucket_entries(post_rollup_entries))
            rows = [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM daily_rollup ORDER BY date, agent_id, project, model"
                )
            ]
            if not rows:
                raise RollupAdoptionError("legacy adoption requires existing history")
            actual = {
                (row["date"], row["agent_id"], row["project"], row["model"]): row
                for row in rows
            }
            database_agents = {row["agent_id"] for row in rows}
            if set(parsed_starts) != database_agents:
                raise RollupAdoptionError(
                    "raw_log_starts must name every database agent; expected %s, actual %s"
                    % (sorted(database_agents), sorted(parsed_starts))
                )
            comparison_source_agents = {
                entry.agent_id or "unknown"
                for entry in entries
                if entry.timestamp.astimezone(timezone.utc) <= comparison_cutoff_utc
            }
            missing_database_agents = comparison_source_agents - database_agents
            if missing_database_agents:
                raise RollupAdoptionError(
                    "source agents through last_rollup_ts are absent from database: %s; "
                    "adoption did not write" % sorted(missing_database_agents)
                )
            expected_agents = {key[1] for key in expected}
            if expected_agents != database_agents:
                raise RollupAdoptionError(
                    "reconstructible overlap must contain every database agent; expected %s, actual %s"
                    % (sorted(database_agents), sorted(expected_agents))
                )
            missing = sorted(set(expected) - set(actual))
            if missing:
                raise RollupAdoptionError(
                    "recomputed Shanghai overlap has %d missing bucket key(s); adoption did not write"
                    % len(missing)
                )
            protected_counter_equal = sum(
                all(expected[key][field] == actual[key][field] for field in PROTECTED_FIELDS)
                for key in expected
            )
            non_equal_protected_counter = len(expected) - protected_counter_equal
            if (
                non_equal_protected_counter
                and authorize_non_exact_overlap_assumption is not True
            ):
                raise RollupAdoptionError(
                    "non-exact overlap requires separate explicit authorization; "
                    "adoption did not write"
                )
            if protected_counter_equal == len(expected):
                protected_counter_status = "verified"
            elif protected_counter_equal:
                protected_counter_status = "partially_verified"
            else:
                protected_counter_status = "unverified"
            non_equal_assumption_status = (
                "not_used"
                if non_equal_protected_counter == 0
                else "user_authorized_overlap_assumption"
            )
            db_start = min(row["date"] for row in rows)
            end_by_agent = {
                agent: (start - timedelta(days=1)).isoformat()
                for agent, start in parsed_starts.items()
            }
            evidence = {
                "schema_version": 2,
                "adopted_at": adopted_at,
                "reconstructible_overlap": {
                    "raw_log_starts": {
                        agent: start.isoformat()
                        for agent, start in sorted(parsed_starts.items())
                    },
                    "bucket_keys": {
                        "expected": len(expected),
                        "matched": len(expected) - len(missing),
                        "missing": len(missing),
                    },
                    "comparison_window": {
                        "end_inclusive": comparison_cutoff_utc.isoformat().replace(
                            "+00:00", "Z"
                        ),
                        "source_entries_in_scope": len(comparison_entries),
                        "source_bucket_keys_in_scope": len(expected),
                    },
                    "post_rollup_source_growth": {
                        "status": "outside_adoption_comparison",
                        "source_entries": len(post_rollup_entries),
                        "source_bucket_keys": len(post_rollup_bucket_keys),
                        # No field here reports whether the window excluded rows the
                        # database already holds. last_rollup_ts is stamped when a
                        # rollup starts, before it reads the source, so records
                        # appended during that read reach the database with a later
                        # timestamp -- and nothing distinguishes them afterwards.
                        # Bucket-key overlap looks like that signal and is not: a key
                        # can already exist from pre-cutoff rows, and the dangerous
                        # case (a row stored under the wrong day) recomputes to a key
                        # the database lacks, reading as zero. The CLI states the gap
                        # instead, rather than offering a count that reads as absence
                        # of one.
                        "bucket_keys_missing_from_database": len(
                            post_rollup_bucket_keys - set(actual)
                        ),
                    },
                    "protected_counter_verification": {
                        "status": protected_counter_status,
                        "fields": list(PROTECTED_FIELDS),
                        "equal_bucket_keys": {
                            "expected": len(expected),
                            "actual": protected_counter_equal,
                        },
                    },
                    "cost_attribution_verification": {
                        "status": "not_verified",
                        "fields": ["cost_usd", "cost_known_count"],
                        "reason": (
                            "Pricing changes can alter cost without changing protected counters."
                        ),
                    },
                    "non_equal_protected_counter_assumption": {
                        "status": non_equal_assumption_status,
                        "bucket_keys": non_equal_protected_counter,
                        "assumption": (
                            "Buckets with non-equal protected counters are adopted by separate "
                            "explicit authorization; available values cannot distinguish pruning "
                            "or live growth from misdating."
                        ),
                    },
                    "uncovered_existing_bucket_keys": len(set(actual) - set(expected)),
                },
                "known_offset": {
                    "status": "known_fact",
                    "utc_offset": known_utc_offset,
                },
                "pre_log_history": {
                    "status": "user_authorized_historical_assumption",
                    "start_date": db_start,
                    "end_by_agent": end_by_agent,
                    "assumption": (
                        "Legacy buckets before reconstructible raw logs are accepted as "
                        "Asia/Shanghai by explicit user authorization, not retrospective verification."
                    ),
                },
            }
            conn.execute(
                "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone_adoption', ?)",
                (json.dumps(evidence, sort_keys=True, separators=(",", ":")),),
            )
            conn.execute(
                "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', ?)",
                (BUCKET_TIMEZONE_NAME,),
            )
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()
    return {
        "status": "adopted",
        "bucket_timezone": BUCKET_TIMEZONE_NAME,
        "evidence": evidence,
    }


def _init_db(conn, db_path):
    _assert_lock_held(db_path)
    conn.executescript(SCHEMA)


def _ensure_bucket_timezone(conn, db_path):
    row = conn.execute(
        "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
    ).fetchone()
    configured = row[0] if row else None
    if configured == BUCKET_TIMEZONE_NAME:
        return

    has_history = conn.execute("SELECT 1 FROM daily_rollup LIMIT 1").fetchone() is not None
    if configured is None and not has_history:
        conn.execute(
            "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', ?)",
            (BUCKET_TIMEZONE_NAME,),
        )
        return

    actual = configured or "unmarked"
    raise RollupBucketTimezoneMigrationRequired(
        "rollup database %s uses %s day buckets; explicit migration to %s is required"
        % (Path(db_path), actual, BUCKET_TIMEZONE_NAME)
    )


def _require_bucket_timezone(conn, db_path):
    if not _table_exists(conn, "daily_rollup"):
        return
    configured = None
    if _table_exists(conn, "rollup_meta"):
        row = conn.execute(
            "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
        ).fetchone()
        configured = row[0] if row else None
    if configured == BUCKET_TIMEZONE_NAME:
        return
    has_history = conn.execute("SELECT 1 FROM daily_rollup LIMIT 1").fetchone() is not None
    if configured is None and not has_history:
        return
    actual = configured or "unmarked"
    raise RollupBucketTimezoneMigrationRequired(
        "rollup database %s uses %s day buckets; explicit migration to %s is required"
        % (Path(db_path), actual, BUCKET_TIMEZONE_NAME)
    )


def _existing_rollup_dates(conn):
    return {row[0] for row in conn.execute("SELECT DISTINCT date FROM daily_rollup")}


def _write_scope(buckets, recompute_dates, conn):
    """Pick the buckets a rollup may write, leaving frozen history alone.

    Anything inside the recompute window qualifies, as does any date the
    database has never held. Nothing else: an existing date is treated as
    finished even if the source now offers a bucket key it does not contain.

    That last part is a known gap, not an oversight -- a project that ran on a
    day already recorded, but was never written, stays missing forever. Writing
    such keys was tried and reverted: the database cannot tell a bucket that was
    missed from the same usage re-keyed under a new project or model name, so
    adding the "missing" one beside a stored row that means the same thing
    double-counts the day. Telling those apart needs per-row lineage the schema
    does not carry, which is the same wall that keeps generation alias coverage
    empty. Measured exposure at the time of the revert was zero buckets."""
    existing_dates = _existing_rollup_dates(conn)
    source_dates = {key[0] for key in buckets}
    backfill_dates = source_dates - set(recompute_dates) - existing_dates
    return {
        key: value
        for key, value in buckets.items()
        if key[0] in recompute_dates or key[0] in backfill_dates
    }


def _daily_rows(
    db_path=None,
    time_range=None,
    calendar_days=None,
    source_machine=None,
):
    if db_path is not None:
        rows = _daily_rows_from_db(db_path, time_range, calendar_days)
        _canonicalise_projects(rows, None)
        if source_machine is not None:
            for row in rows:
                row["host"] = source_machine
        return rows
    if source_machine is not None:
        raise ValueError("source_machine is only valid with an explicit db_path")

    rows = []
    with _admitted_generation_snapshot() as generations:
        for generation in generations:
            generation_rows = _daily_rows_from_db(
                generation.db_path, time_range, calendar_days
            )
            _canonicalise_projects(
                generation_rows, _generation_aliases(generation)
            )
            for row in generation_rows:
                row["host"] = generation.host
            rows.extend(generation_rows)
    return rows


def _canonicalise_projects(rows, aliases):
    """Relabel each row's project the way the reader should group it.

    Rows carry whatever path the machine recorded, so the same directory
    reaches this point as /Users/me/x from a Mac and /home/me/x from Linux and
    would otherwise sit in two rows that no reader would think to add up. Doing
    it here rather than per consumer keeps the pivot axis, the filter values and
    the filter matching quoting the same label -- they diverge the moment one of
    them canonicalises and another does not.

    Note what this does not establish: paths that merely coincide are merged on
    that coincidence alone. Two machines' ~/Downloads become one row without
    anything proving they hold the same work. The user chose that over splitting
    them, since the machine dimension can always take the row back apart; see
    the project-alias issue in docs/issues/general.md.
    """
    from project_alias import canonical_project

    for row in rows:
        row["project"] = canonical_project(row["project"], aliases)


def _generation_aliases(generation):
    # AdmittedGeneration keeps the published generation in `_source`; reading a
    # `current` attribute that does not exist yields None on every call, which
    # looks like "this generation has no aliases" and never like a wiring bug.
    meta = getattr(getattr(generation, "_source", None), "meta", None)
    return (meta or {}).get("aliases") or None


def _daily_rows_from_db(db_path, time_range, calendar_days=None):
    clauses = []
    params = []
    if time_range is not None:
        start, end = _calendar_date_bounds(
            time_range, calendar_days=calendar_days
        )
        clauses.append("date >= ?")
        params.append(start.isoformat())
        clauses.append("date <= ?")
        params.append(end.isoformat())
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    sql = "SELECT * FROM daily_rollup" + where + " ORDER BY date, agent_id, project, model"

    db_path = Path(db_path)
    with _read_connection(db_path) as conn:
        if conn is None or not _table_exists(conn, "daily_rollup"):
            return []
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params)]


def _calendar_date_bounds(time_range, calendar_days=None):
    start, end = time_range
    if isinstance(start, datetime) and isinstance(end, datetime):
        if any(value.tzinfo is None or value.utcoffset() is None for value in (start, end)):
            raise ValueError("datetime range endpoints must be timezone-aware")
        if end < start:
            raise ValueError("time range end must not precede start")
        if type(calendar_days) is not int or calendar_days < 1:
            raise ValueError(
                "datetime ranges require a positive explicit calendar_days value"
            )
        end_date = end.astimezone(BUCKET_TIMEZONE).date()
        return end_date - timedelta(days=calendar_days - 1), end_date
    if type(start) is date and type(end) is date:
        if calendar_days is not None:
            raise ValueError("calendar_days is only valid with datetime ranges")
        if end < start:
            raise ValueError("time range end must not precede start")
        return start, end
    raise TypeError("time range endpoints must both be dates or timezone-aware datetimes")


@contextmanager
def _read_connection(
    db_path,
    immutable=False,
    *,
    allow_unmarked_for_marker_probe=False,
):
    db_path = Path(db_path)
    if not db_path.is_file():
        yield None
        return
    base_uri = db_path.resolve().as_uri()
    conn = _open_read_only(base_uri, db_path, immutable)
    try:
        if not allow_unmarked_for_marker_probe:
            _require_bucket_timezone(conn, db_path)
        yield conn
    finally:
        conn.close()


def _open_read_only(base_uri, db_path, immutable):
    """Open a read-only connection, tolerating a WAL database nobody has open.

    A WAL database needs a -shm to be read, and SQLite deletes it when the last
    connection closes. From 3.51 on, a mode=ro connection will not recreate one,
    so reading a database whose writer has exited fails outright -- which is the
    normal state of a machine that is exported from rather than browsed on.

    Falling back to immutable=1 is sound only while no -wal sits beside the file:
    no frames exist to be missed, so the snapshot is the whole database. Should a
    writer arrive between the two opens it will have left both siblings behind,
    and mode=ro then works on the retry."""
    if immutable and _wal_has_frames(db_path):
        raise sqlite3.OperationalError(
            "cannot take a non-writing snapshot while an uncheckpointed WAL exists"
        )
    query = "?mode=ro&immutable=1" if immutable else "?mode=ro"
    try:
        return _connect_read_only(base_uri + query)
    except sqlite3.OperationalError:
        if immutable or _wal_sibling(db_path).exists():
            raise
    conn = _connect_read_only(base_uri + "?mode=ro&immutable=1")
    if not _wal_sibling(db_path).exists():
        return conn
    conn.close()
    return _connect_read_only(base_uri + "?mode=ro")


def _connect_read_only(uri):
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        conn.execute("PRAGMA query_only=ON")
        # sqlite3.connect is lazy and PRAGMA query_only never touches the file,
        # so without a real read the caller learns the database is unopenable
        # only once some later query fails -- too late for a fallback to help.
        conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchone()
    except BaseException:
        conn.close()
        raise
    return conn


def _wal_sibling(db_path):
    return Path(str(db_path) + "-wal")


def _wal_has_frames(db_path):
    """Whether the WAL holds writes the main file does not.

    The question an immutable read needs answered is whether frames are waiting
    outside the main database, and the answer is the WAL's length: SQLite
    truncates it to zero on checkpoint and leaves it at zero while a reader
    merely holds the database open. Testing the file's existence instead
    answered a different and much broader question -- any live connection
    creates the file -- so a running server made every immutable read refuse,
    which is how the integrity checker came to report `indeterminate` in the
    one state it is most often run in.
    """
    wal = _wal_sibling(db_path)
    try:
        return wal.stat().st_size > 0
    except FileNotFoundError:
        return False


def _table_exists(conn, table_name):
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        is not None
    )


def _rollup_bucket_timezone(db_path):
    # Deliberate diagnostic exception: admission must inspect the marker in
    # order to decide whether the database may enter the normal read path.
    with _read_connection(
        db_path, allow_unmarked_for_marker_probe=True
    ) as conn:
        if conn is None or not _table_exists(conn, "rollup_meta"):
            return None
        row = conn.execute(
            "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
        ).fetchone()
    return row[0] if row else None


def _normalize_db_path(db_path):
    return os.path.realpath(os.path.abspath(os.path.expanduser(os.fspath(db_path))))


def _lock_identity(lock_fd):
    stat_result = os.fstat(lock_fd)
    return stat_result.st_dev, stat_result.st_ino


def _path_lock(lock_identity):
    with _LOCKS_GUARD:
        return _PATH_LOCKS.setdefault(lock_identity, threading.RLock())


def _ownership_holders():
    holders = getattr(_LOCK_OWNERSHIP, "holders", None)
    if holders is None:
        holders = {}
        _LOCK_OWNERSHIP.holders = holders
    return holders


def _open_lock_file(lock_path, create=True):
    with _LOCKS_GUARD:
        flags = os.O_RDWR | (os.O_CREAT if create else 0)
        lock_fd = os.open(lock_path, flags, 0o600)
        _OPEN_LOCK_FDS.add(lock_fd)
        return lock_fd


def _close_lock_fd(lock_fd):
    with _LOCKS_GUARD:
        _OPEN_LOCK_FDS.discard(lock_fd)
        os.close(lock_fd)


def _register_active_holder(lock_identity, holder):
    with _LOCKS_GUARD:
        _ACTIVE_LOCK_HOLDERS[lock_identity] = holder


def _unregister_active_holder(lock_identity, holder):
    with _LOCKS_GUARD:
        if _ACTIVE_LOCK_HOLDERS.get(lock_identity) is holder:
            _ACTIVE_LOCK_HOLDERS.pop(lock_identity, None)


def _reset_rollup_locks_after_fork():
    global _ACTIVE_LOCK_HOLDERS
    global _LOCKS_GUARD
    global _LOCK_OWNERSHIP
    global _OPEN_LOCK_FDS
    global _PATH_LOCKS

    for lock_fd in tuple(_OPEN_LOCK_FDS):
        try:
            os.close(lock_fd)
        except OSError:
            pass
    _LOCKS_GUARD = threading.Lock()
    _PATH_LOCKS = {}
    _LOCK_OWNERSHIP = threading.local()
    _OPEN_LOCK_FDS = set()
    _ACTIVE_LOCK_HOLDERS = {}


def _prepare_rollup_locks_for_fork():
    _LOCKS_GUARD.acquire()


def _resume_rollup_locks_after_fork_parent():
    _LOCKS_GUARD.release()


def _assert_lock_held(db_path):
    normalized_path = _normalize_db_path(db_path)
    try:
        stat_result = os.stat(normalized_path + ".lock")
    except OSError:
        holder = None
    else:
        holder = _ownership_holders().get((stat_result.st_dev, stat_result.st_ino))
    if holder is None or holder["pid"] != os.getpid() or holder["depth"] < 1:
        raise RollupLockNotHeld("rollup lock is not held for %s" % normalized_path)


def _acquire_thread_lock(path_lock, blocking, deadline):
    if not blocking:
        return path_lock.acquire(blocking=False)
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("timed out acquiring in-process rollup lock")
    if not path_lock.acquire(timeout=remaining):
        raise TimeoutError("timed out acquiring in-process rollup lock")
    return True


def _acquire_file_lock(lock_fd, normalized_path, blocking, deadline):
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if not blocking:
                raise _RollupLockUnavailable(
                    errno.EWOULDBLOCK,
                    "rollup lock is already held",
                    normalized_path,
                )
            if time.monotonic() >= deadline:
                raise TimeoutError("timed out acquiring rollup lock for %s" % normalized_path)
            sleep_for = 0.05
            sleep_for = min(sleep_for, max(0, deadline - time.monotonic()))
            time.sleep(sleep_for)


if hasattr(os, "register_at_fork"):
    os.register_at_fork(
        before=_prepare_rollup_locks_for_fork,
        after_in_parent=_resume_rollup_locks_after_fork_parent,
        after_in_child=_reset_rollup_locks_after_fork,
    )


def _now(now):
    value = now() if now else datetime.now().astimezone()
    return value.astimezone()


def _bucket_date(value):
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("usage timestamps must be timezone-aware")
    return value.astimezone(BUCKET_TIMEZONE).date()


def _bucket_entries(entries):
    buckets = defaultdict(_empty_bucket)
    for entry in entries:
        day = _bucket_date(entry.timestamp)
        key = (
            day.isoformat(),
            entry.agent_id or "unknown",
            entry.project or "unknown",
            entry.model or "unknown",
        )
        bucket = buckets[key]
        bucket["input_tokens"] += entry.input_tokens
        bucket["output_tokens"] += entry.output_tokens
        bucket["cache_creation_tokens"] += entry.cache_creation_tokens
        bucket["cache_read_tokens"] += entry.cache_read_tokens
        if entry.cost_usd is not None:
            bucket["cost_usd"] += entry.cost_usd
            bucket["cost_known_count"] += 1
        bucket["entry_count"] += 1
        bucket["message_count"] += entry.message_count
    return buckets


def _empty_bucket():
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_creation_tokens": 0,
        "cache_read_tokens": 0,
        "cost_usd": 0.0,
        "cost_known_count": 0,
        "entry_count": 0,
        "message_count": 0,
    }


def _bucket_tuple(key, bucket):
    date, agent_id, project, model = key
    return (
        date,
        agent_id,
        project,
        model,
        bucket["input_tokens"],
        bucket["output_tokens"],
        bucket["cache_creation_tokens"],
        bucket["cache_read_tokens"],
        bucket["cost_usd"],
        bucket["cost_known_count"],
        bucket["entry_count"],
        bucket["message_count"],
    )


def _row_included(row, filters):
    if filters["agent"] and row["agent_id"] not in filters["agent"]:
        return False
    if filters["project"] and row["project"] not in filters["project"]:
        return False
    if filters["model"] and row["model"] not in filters["model"]:
        return False
    if filters["machine"] and row.get("host") not in filters["machine"]:
        return False
    return True


def _validate_machine_source(x_dim, group_dim, machines, db_path, source_machine):
    if db_path is None:
        if source_machine is not None:
            raise ValueError("source_machine is only valid with an explicit db_path")
        return
    uses_machine = x_dim == "machine" or group_dim == "machine" or bool(machines)
    if uses_machine and source_machine is None:
        raise ValueError(
            "machine dimension and filter require source_machine with an explicit db_path"
        )


def _dimension_reduction(rows, dim, metric):
    if dim == "none":
        return ["value"], {}
    values = sorted({_row_dim(row, dim) for row in rows})
    if dim in TIME_DIMS or len(values) <= TOP_DIMENSION_THRESHOLD:
        return values, {value: value for value in values}

    totals = {value: 0 for value in values}
    for row in rows:
        value = _row_dim(row, dim)
        if metric == "cost" and row["cost_known_count"] == 0:
            continue
        totals[value] += _row_metric(row, metric)

    top_values = [
        value
        for value, _total in sorted(totals.items(), key=lambda item: (-item[1], item[0]))[:TOP_DIMENSION_LIMIT]
    ]
    top_set = set(top_values)
    mapped = {value: value if value in top_set else OTHER_BUCKET for value in values}
    return top_values + [OTHER_BUCKET], mapped


def _mapped_dim(row, dim, mapping):
    value = _row_dim(row, dim)
    return mapping.get(value, value)


def _row_dim(row, dim):
    if dim == "day":
        return row["date"]
    if dim == "week":
        value = date.fromisoformat(row["date"])
        return (value - timedelta(days=value.weekday())).isoformat()
    if dim == "month":
        return row["date"][:7]
    if dim == "project":
        return row["project"]
    if dim == "model":
        return row["model"]
    if dim == "agent":
        return row["agent_id"]
    if dim == "machine":
        return row["host"]
    raise ValueError("Unsupported dimension: %s" % dim)


def _row_metric(row, metric):
    if metric == "cost":
        return row["cost_usd"]
    if metric == "input":
        return row["input_tokens"]
    if metric == "output":
        return row["output_tokens"]
    if metric == "cache_read":
        return row["cache_read_tokens"]
    if metric == "cache_creation":
        return row["cache_creation_tokens"]
    if metric == "total":
        return (
            row["input_tokens"]
            + row["output_tokens"]
            + row["cache_read_tokens"]
            + row["cache_creation_tokens"]
        )
    if metric == "messages":
        return row["message_count"]
    raise ValueError("Unsupported metric: %s" % metric)


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
