import errno
import logging
import os
import sqlite3
import stat
import subprocess
import threading
from collections import OrderedDict, defaultdict
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from parsers import UsageEntry
from parsers import claude, codex


TIME_DIMS = {"day", "week", "month"}
USAGE_TIMEZONE = ZoneInfo("Asia/Shanghai")
ALL_DIMS = TIME_DIMS | {"project", "model", "agent"}
METRICS = {"cost", "input", "output", "cache_read", "cache_creation", "total", "messages"}
ROOT = Path(__file__).resolve().parent
PROJECT_IDENTITY_DB = ROOT / "state" / "project_identity.db"
_GLOBAL_USAGE_CACHE = None
_PROJECT_CACHE = {}
_LOAD_LOCK = threading.RLock()
logger = logging.getLogger(__name__)

PROJECT_IDENTITY_SCHEMA = """
CREATE TABLE IF NOT EXISTS project_identity (
  source_path TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('remote', 'fallback', 'legacy'))
)
"""

PROJECT_IDENTITY_BLOCKER_SCHEMA = """
CREATE TABLE IF NOT EXISTS project_identity_blocker (
  source_path TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  resolved_candidate TEXT,
  pin_candidate TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'resolved_pinned')
  )
)
"""


class ProjectIdentityBlocked(RuntimeError):
    def __init__(
        self,
        message,
        source_path,
        reason,
        resolved_project=None,
        pin_candidate=None,
    ):
        super().__init__(message)
        self.source_path = source_path
        self.reason = reason
        self.resolved_project = resolved_project
        self.pin_candidate = pin_candidate

    def as_dict(self):
        return {
            "source_path": self.source_path,
            "reason": self.reason,
            "resolved_project": self.resolved_project,
            "pin_candidate": self.pin_candidate,
        }


class ProjectIdentityUnavailable(ProjectIdentityBlocked):
    pass


class ProjectIdentityConflict(ProjectIdentityBlocked):
    pass


class ProjectIdentityRecoveryError(RuntimeError):
    pass


class LoadedEntries(list):
    def __init__(
        self,
        entries=(),
        blocked_sources=(),
        persisted_blockers=(),
        current_blockers=(),
        source_errors=(),
        scan_complete=True,
    ):
        super().__init__(entries)
        self.blocked_sources = list(blocked_sources)
        self.persisted_blockers = list(persisted_blockers)
        self.current_blockers = list(current_blockers)
        self.source_errors = list(source_errors)
        self.scan_complete = scan_complete


@dataclass(frozen=True)
class _IdentityRollupLockToken:
    identity_db: str
    rollup_db: str
    pid: int


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
        return entry.timestamp.astimezone(USAGE_TIMEZONE).date().isoformat()
    if dim == "week":
        local = entry.timestamp.astimezone(USAGE_TIMEZONE)
        monday = local.date() - timedelta(days=local.weekday())
        return monday.isoformat()
    if dim == "month":
        return entry.timestamp.astimezone(USAGE_TIMEZONE).strftime("%Y-%m")
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
    with _identity_rollup_lock():
        with _LOAD_LOCK:
            return _identify_project(path, cache)


def _identify_project(path, cache, persist=True, ignore_persisted_blocker=False):
    if not ignore_persisted_blocker:
        active_blocker = _project_identity_blocker(path)
        if active_blocker is not None:
            raise ProjectIdentityBlocked(
                "Project identity for %s is blocked pending explicit recovery" % path,
                source_path=path,
                reason=active_blocker["reason"],
                resolved_project=active_blocker["resolved_candidate"],
                pin_candidate=active_blocker["pin_candidate"],
            )
    if path in cache:
        return cache[path]
    stored = _stored_project_identity(path, immutable=ignore_persisted_blocker)
    if stored is not None:
        cache[path] = stored
        return stored

    project, resolution = _resolve_project(path)
    legacy_project, unclaimed_projects = _legacy_project_identity(
        path,
        project,
        immutable=ignore_persisted_blocker,
    )
    if legacy_project is not None:
        project = legacy_project
        resolution = "legacy"
    elif resolution == "unavailable" and unclaimed_projects:
        raise ProjectIdentityUnavailable(
            "Cannot assign a stable project identity for %s while git resolution is unavailable" % path,
            source_path=path,
            reason="source_unavailable",
            pin_candidate=_sole_project(unclaimed_projects),
        )
    elif resolution == "remote" and unclaimed_projects:
        raise ProjectIdentityUnavailable(
            "Resolved project %s for %s cannot be reconciled with existing rollup history"
            % (project, path),
            source_path=path,
            reason="unreconciled_remote",
            resolved_project=project,
            pin_candidate=_sole_project(unclaimed_projects),
        )
    if resolution in {"no_remote", "unavailable"}:
        resolution = "fallback"
    if not persist:
        return project
    project, stored_resolution, created = _store_project_identity(path, project, resolution)
    if created and stored_resolution == "fallback":
        logger.warning(
            "Could not resolve git remote for %s; persisted the source path as its stable project identity",
            path,
        )
    cache[path] = project
    return project


def _resolve_project(path):
    try:
        result = subprocess.run(
            ["git", "-C", path, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (subprocess.TimeoutExpired, OSError):
        return path, "unavailable"
    if result.returncode == 0 and result.stdout.strip():
        return normalize_remote(result.stdout.strip()), "remote"
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return path, "no_remote"
    return path, "unavailable"


def _stored_project_identity(path, immutable=False):
    identity_db = Path(PROJECT_IDENTITY_DB)
    if not identity_db.exists():
        return None

    uri = _read_only_uri(identity_db, immutable=immutable)
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        conn.execute("PRAGMA query_only=ON")
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_identity'"
        ).fetchone()
        if table_exists is None:
            return None
        row = conn.execute(
            "SELECT project FROM project_identity WHERE source_path = ?",
            (path,),
        ).fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def _legacy_project_identity(path, resolved_project, immutable=False):
    # Delayed to avoid the module cycle: rollup imports load_all_entries here.
    from rollup import RollupBucketTimezoneMigrationRequired, _read_connection

    rollup_db = Path(PROJECT_IDENTITY_DB).with_name("rollup.db")
    if not rollup_db.exists():
        return None, set()

    try:
        with _read_connection(rollup_db, immutable=immutable) as conn:
            if conn is None:
                return None, set()
            table_exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_rollup'"
            ).fetchone()
            if table_exists is None:
                return None, set()
            all_projects = {
                row[0]
                for row in conn.execute("SELECT DISTINCT project FROM daily_rollup")
            }
            matching_projects = all_projects.intersection({path, resolved_project})
            if len(matching_projects) > 1:
                raise ProjectIdentityConflict(
                    "Existing rollup rows already contain conflicting project identities for %s"
                    % path,
                    source_path=path,
                    reason="conflicting_history",
                    resolved_project=resolved_project,
                )
            claimed_projects = _stored_projects(immutable=immutable)
            return next(iter(matching_projects), None), all_projects - claimed_projects
    except RollupBucketTimezoneMigrationRequired:
        return None, set()


def _stored_projects(immutable=False):
    identity_db = Path(PROJECT_IDENTITY_DB)
    if not identity_db.exists():
        return set()

    uri = _read_only_uri(identity_db, immutable=immutable)
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        conn.execute("PRAGMA query_only=ON")
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_identity'"
        ).fetchone()
        if table_exists is None:
            return set()
        return {row[0] for row in conn.execute("SELECT DISTINCT project FROM project_identity")}
    finally:
        conn.close()


def list_project_identity_blockers(status="active", immutable=False):
    with _identity_rollup_lock():
        return _list_project_identity_blockers(status, immutable=immutable)


def _list_project_identity_blockers(status="active", immutable=False):
    identity_db = Path(PROJECT_IDENTITY_DB)
    if not identity_db.exists():
        return []

    uri = _read_only_uri(identity_db, immutable=immutable)
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA query_only=ON")
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_identity_blocker'"
        ).fetchone()
        if table_exists is None:
            return []
        columns = {row[1] for row in conn.execute("PRAGMA table_info(project_identity_blocker)")}
        pin_candidate = "pin_candidate" if "pin_candidate" in columns else "NULL AS pin_candidate"
        sql = """
            SELECT source_path, reason, resolved_candidate, {pin_candidate},
                   first_seen, last_seen, status
            FROM project_identity_blocker
        """.format(pin_candidate=pin_candidate)
        params = ()
        if status is not None:
            sql += " WHERE status = ?"
            params = (status,)
        sql += " ORDER BY source_path"
        return [_blocker_dict(row) for row in conn.execute(sql, params)]
    finally:
        conn.close()


def _read_only_uri(db_path, immutable=False):
    db_path = Path(db_path)
    if immutable and Path(str(db_path) + "-wal").exists():
        raise sqlite3.OperationalError(
            "cannot take a non-writing snapshot while an uncheckpointed WAL exists"
        )
    query = "?mode=ro&immutable=1" if immutable else "?mode=ro"
    return db_path.resolve().as_uri() + query


def _project_identity_blocker(path):
    return next(
        (row for row in list_project_identity_blockers(status="active") if row["source_path"] == path),
        None,
    )


def _record_project_identity_blocker(blocker):
    with _identity_rollup_lock():
        return _record_project_identity_blocker_locked(blocker)


def _record_project_identity_blocker_locked(blocker):
    ownership_token = _assert_identity_rollup_lock_held()
    identity_db = Path(PROJECT_IDENTITY_DB)
    identity_db.parent.mkdir(parents=True, exist_ok=True)
    observed_at = datetime.now(timezone.utc).isoformat()
    conn = sqlite3.connect(identity_db, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        _assert_identity_connection_matches(conn, ownership_token)
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("BEGIN IMMEDIATE")
        _ensure_project_identity_blocker_schema(conn, ownership_token)
        conn.execute(
            """
            INSERT INTO project_identity_blocker (
              source_path, reason, resolved_candidate, pin_candidate,
              first_seen, last_seen, status
            ) VALUES (?, ?, ?, ?, ?, ?, 'active')
            ON CONFLICT(source_path) DO UPDATE SET
              reason = excluded.reason,
              resolved_candidate = excluded.resolved_candidate,
              pin_candidate = excluded.pin_candidate,
              last_seen = excluded.last_seen,
              status = 'active'
            """,
            (
                blocker.source_path,
                blocker.reason,
                blocker.resolved_project,
                blocker.pin_candidate,
                observed_at,
                observed_at,
            ),
        )
        row = _select_blocker(conn, blocker.source_path)
        conn.commit()
        return _blocker_dict(row)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def pin_project_identity(source_path, existing_project):
    with _identity_rollup_lock():
        with _LOAD_LOCK:
            resolved_project, resolution = _resolve_project(source_path)
            conn, ownership_token = _begin_identity_recovery()
            try:
                blocker = _require_active_blocker(conn, source_path)
                pin_candidate = _derive_pin_candidate(
                    conn,
                    source_path,
                    blocker,
                    resolved_project,
                    resolution,
                )
                if existing_project != pin_candidate:
                    raise ProjectIdentityRecoveryError(
                        "Cannot pin %s to %s: the only identity directly derivable for this source is %s"
                        % (source_path, existing_project, pin_candidate)
                    )
                _upsert_project_identity(
                    conn,
                    source_path,
                    existing_project,
                    "legacy",
                    ownership_token,
                )
                _resolve_blocker(conn, source_path, "resolved_pinned", ownership_token)
                recovered = _blocker_dict(_select_blocker(conn, source_path))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
            _PROJECT_CACHE[source_path] = existing_project
            return recovered


def _begin_identity_recovery():
    ownership_token = _assert_identity_rollup_lock_held()
    identity_db = Path(PROJECT_IDENTITY_DB)
    rollup_db = identity_db.with_name("rollup.db")
    if not rollup_db.exists():
        raise ProjectIdentityRecoveryError("Cannot recover identity: daily rollup database does not exist")
    # Delayed to avoid the module cycle: rollup imports load_all_entries here.
    from rollup import RollupBucketTimezoneMigrationRequired, _read_connection

    try:
        # The caller holds the sibling rollup lock, so the marker cannot change
        # between this preflight and the ATTACH below.
        with _read_connection(rollup_db):
            pass
    except RollupBucketTimezoneMigrationRequired as exc:
        raise ProjectIdentityRecoveryError(
            "Cannot recover identity: rollup history failed the bucket_timezone contract. "
            "Complete explicit rollup adoption before retrying; identity and blocker state "
            "were not changed. (%s)" % exc
        ) from exc
    identity_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(identity_db, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        _assert_identity_connection_matches(conn, ownership_token)
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("ATTACH DATABASE ? AS rollup", (str(rollup_db),))
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(PROJECT_IDENTITY_SCHEMA)
        _ensure_project_identity_blocker_schema(conn, ownership_token)
        table_exists = conn.execute(
            "SELECT 1 FROM rollup.sqlite_master WHERE type = 'table' AND name = 'daily_rollup'"
        ).fetchone()
        if table_exists is None:
            raise ProjectIdentityRecoveryError("Cannot recover identity: daily_rollup table does not exist")
        return conn, ownership_token
    except Exception:
        conn.close()
        raise


def _ensure_project_identity_blocker_schema(conn, ownership_token):
    _assert_identity_connection_matches(conn, ownership_token)
    conn.execute(PROJECT_IDENTITY_BLOCKER_SCHEMA)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(project_identity_blocker)")}
    if "pin_candidate" not in columns:
        conn.execute("ALTER TABLE project_identity_blocker ADD COLUMN pin_candidate TEXT")


def _require_active_blocker(conn, source_path):
    row = _select_blocker(conn, source_path)
    if row is None or row["status"] != "active":
        raise ProjectIdentityRecoveryError(
            "Cannot recover %s: no active project identity blocker exists" % source_path
        )
    return row


def _derive_pin_candidate(conn, source_path, blocker, resolved_project, resolution):
    if blocker["reason"] == "conflicting_history":
        raise ProjectIdentityRecoveryError(
            "Cannot pin %s: conflicting historical identities cannot be resolved without source-path lineage"
            % source_path
        )
    if resolution == "unavailable":
        raise ProjectIdentityRecoveryError(
            "Cannot pin %s: restore the source path and git metadata before retrying" % source_path
        )

    direct_candidates = {source_path}
    if resolution == "remote":
        direct_candidates.add(resolved_project)
    placeholders = ", ".join("?" for _candidate in direct_candidates)
    rows = conn.execute(
        "SELECT DISTINCT project FROM rollup.daily_rollup WHERE project IN (%s)" % placeholders,
        tuple(sorted(direct_candidates)),
    ).fetchall()
    matching_projects = {row[0] for row in rows}
    if len(matching_projects) != 1:
        raise ProjectIdentityRecoveryError(
            "Cannot pin %s: current path/remote does not identify exactly one existing rollup project"
            % source_path
        )

    candidate = next(iter(matching_projects))
    if blocker["pin_candidate"] is None:
        raise ProjectIdentityRecoveryError(
            "Cannot pin %s: no unique historical identity was derivable when this blocker was recorded"
            % source_path
        )
    if candidate != blocker["pin_candidate"]:
        raise ProjectIdentityRecoveryError(
            "Cannot pin %s: current path/remote matches %s, but this blocker's unique historical "
            "identity is %s"
            % (source_path, candidate, blocker["pin_candidate"])
        )
    return candidate


def _upsert_project_identity(conn, source_path, project, resolution, ownership_token):
    _assert_identity_connection_matches(conn, ownership_token)
    conn.execute(
        """
        INSERT INTO project_identity (source_path, project, resolution)
        VALUES (?, ?, ?)
        ON CONFLICT(source_path) DO UPDATE SET
          project = excluded.project,
          resolution = excluded.resolution
        """,
        (source_path, project, resolution),
    )


def _resolve_blocker(conn, source_path, status, ownership_token):
    _assert_identity_connection_matches(conn, ownership_token)
    cursor = conn.execute(
        "UPDATE project_identity_blocker SET status = ? WHERE source_path = ? AND status = 'active'",
        (status, source_path),
    )
    if cursor.rowcount != 1:
        raise ProjectIdentityRecoveryError(
            "Cannot recover %s: active blocker changed during recovery" % source_path
        )


def _select_blocker(conn, source_path):
    return conn.execute(
        """
        SELECT source_path, reason, resolved_candidate, pin_candidate,
               first_seen, last_seen, status
        FROM project_identity_blocker
        WHERE source_path = ?
        """,
        (source_path,),
    ).fetchone()


def _blocker_dict(row):
    candidate = row["resolved_candidate"]
    return {
        "source_path": row["source_path"],
        "reason": row["reason"],
        "resolved_candidate": candidate,
        "resolved_project": candidate,
        "pin_candidate": row["pin_candidate"],
        "first_seen": row["first_seen"],
        "last_seen": row["last_seen"],
        "status": row["status"],
    }


def _store_project_identity(path, project, resolution):
    ownership_token = _assert_identity_rollup_lock_held()
    identity_db = Path(PROJECT_IDENTITY_DB)
    identity_db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(identity_db, timeout=30)
    try:
        _assert_identity_connection_matches(conn, ownership_token)
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(PROJECT_IDENTITY_SCHEMA)
        cursor = conn.execute(
            """
            INSERT OR IGNORE INTO project_identity (source_path, project, resolution)
            VALUES (?, ?, ?)
            """,
            (path, project, resolution),
        )
        row = conn.execute(
            "SELECT project, resolution FROM project_identity WHERE source_path = ?",
            (path,),
        ).fetchone()
        conn.commit()
        return row[0], row[1], cursor.rowcount == 1
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


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


def _sole_project(projects):
    return next(iter(projects)) if len(projects) == 1 else None


def load_all_entries(force_reload=False, read_only=False, diagnostic=False):
    with _identity_rollup_lock():
        with _LOAD_LOCK:
            global _GLOBAL_USAGE_CACHE
            from cache import MtimeCache

            source_errors = []
            if diagnostic:
                diagnostic_paths = _usage_paths(source_errors=source_errors)
                codex_models = {}
                if any(_is_codex_usage_path(path) for path in diagnostic_paths):
                    codex_models = codex._load_thread_models(
                        codex.STATE_DB,
                        immutable=True,
                        source_errors=source_errors,
                    )
                usage_cache = MtimeCache(
                    lambda: diagnostic_paths,
                    lambda path: _parse_usage_file(
                        path,
                        source_errors=source_errors,
                        codex_models=codex_models,
                    ),
                )
                entries = usage_cache.load(source_errors=source_errors)
            else:
                if _GLOBAL_USAGE_CACHE is None:
                    _GLOBAL_USAGE_CACHE = MtimeCache(_usage_paths, _parse_usage_file)
                if force_reload:
                    _GLOBAL_USAGE_CACHE.clear()
                entries = _GLOBAL_USAGE_CACHE.load()
            return _with_calculated_costs(
                _deduped(entries),
                read_only=read_only,
                diagnostic=diagnostic,
                source_errors=source_errors,
            )


def _identity_rollup_lock():
    from rollup import rollup_lock

    return rollup_lock(_identity_rollup_db())


def _identity_rollup_db():
    return Path(PROJECT_IDENTITY_DB).with_name("rollup.db")


def _assert_identity_rollup_lock_held(ownership_token=None):
    from rollup import RollupLockNotHeld, _assert_lock_held, _normalize_db_path

    identity_db = Path(PROJECT_IDENTITY_DB)
    rollup_db = _identity_rollup_db()
    normalized_identity_db = _normalize_db_path(identity_db)
    normalized_rollup_db = _normalize_db_path(rollup_db)
    if ownership_token is not None and (
        ownership_token.pid != os.getpid()
        or ownership_token.identity_db != normalized_identity_db
        or ownership_token.rollup_db != normalized_rollup_db
    ):
        raise RollupLockNotHeld(
            "project identity mutation does not own sibling rollup lock for %s"
            % normalized_rollup_db
        )
    _assert_lock_held(rollup_db)
    return _IdentityRollupLockToken(
        normalized_identity_db,
        normalized_rollup_db,
        os.getpid(),
    )


def _assert_identity_connection_matches(conn, ownership_token):
    from rollup import RollupLockNotHeld, _normalize_db_path

    _assert_identity_rollup_lock_held(ownership_token)
    if type(conn) is not sqlite3.Connection:
        raise RollupLockNotHeld(
            "project identity mutation requires a native sqlite3.Connection"
        )
    main_rows = [
        row
        for row in sqlite3.Connection.execute(conn, "PRAGMA database_list")
        if row[1] == "main"
    ]
    main_path = main_rows[0][2] if len(main_rows) == 1 else ""
    if not main_path or _normalize_db_path(main_path) != ownership_token.identity_db:
        raise RollupLockNotHeld(
            "project identity connection does not match protected database %s"
            % ownership_token.identity_db
        )


def _deduped(entries):
    # Files are parsed independently, so one API call reaches this point once
    # per file that records it. Claude Code copies a whole transcript into a new
    # session file on resume/fork, which is where the duplicates come from.
    seen = set()
    unique = []
    for entry in entries:
        if entry.dedup_key in seen:
            continue
        seen.add(entry.dedup_key)
        unique.append(entry)
    return unique


def _with_calculated_costs(entries, read_only=False, diagnostic=False, source_errors=()):
    try:
        from pricing_fetcher import calculate_cost, get_pricing
    except ImportError:
        return LoadedEntries(
            sorted(entries, key=lambda entry: entry.timestamp),
            source_errors=source_errors,
            scan_complete=not source_errors,
        )

    pricing = get_pricing(persist=not read_only)
    project_paths = sorted({entry.project for entry in entries if _looks_like_path(entry.project)})
    projects = {}
    pending = []
    blocked = {}
    persisted_blockers = list_project_identity_blockers(
        status="active",
        immutable=diagnostic,
    )
    persisted_by_path = {
        item["source_path"]: item
        for item in persisted_blockers
    }
    identity_cache = {} if read_only else _PROJECT_CACHE
    for path in project_paths:
        try:
            projects[path] = _identify_project(
                path,
                identity_cache,
                persist=not read_only,
                ignore_persisted_blocker=diagnostic,
            )
        except ProjectIdentityBlocked:
            pending.append(path)

    for path in pending:
        try:
            projects[path] = _identify_project(
                path,
                identity_cache,
                persist=not read_only,
                ignore_persisted_blocker=diagnostic,
            )
        except ProjectIdentityBlocked as exc:
            if read_only:
                blocked[path] = _unpersisted_blocker_dict(exc)
            else:
                blocked[path] = _record_project_identity_blocker(exc)
            logger.warning("Blocking source path %s from this rollup: %s", path, exc)

    enriched = []
    blocked_paths = set(blocked) | set(persisted_by_path)
    for entry in entries:
        if entry.project in blocked_paths:
            continue
        cost = calculate_cost(entry, pricing=pricing)
        project = projects.get(entry.project, entry.project)
        enriched.append(replace(entry, cost_usd=cost, project=project))
    enriched.sort(key=lambda entry: entry.timestamp)
    blockers_by_path = dict(persisted_by_path)
    for path, blocker in blocked.items():
        if diagnostic:
            blockers_by_path[path] = blocker
        else:
            blockers_by_path.setdefault(path, blocker)
    active_blockers = [blockers_by_path[path] for path in sorted(blockers_by_path)]
    current_blockers = [blocked[path] for path in sorted(blocked)]
    return LoadedEntries(
        enriched,
        blocked_sources=active_blockers,
        persisted_blockers=persisted_blockers if diagnostic else (),
        current_blockers=current_blockers if diagnostic else (),
        source_errors=source_errors,
        scan_complete=not source_errors,
    )


def _unpersisted_blocker_dict(blocker):
    return {
        "source_path": blocker.source_path,
        "reason": blocker.reason,
        "resolved_candidate": blocker.resolved_project,
        "resolved_project": blocker.resolved_project,
        "pin_candidate": blocker.pin_candidate,
        "first_seen": None,
        "last_seen": None,
        "status": "active",
    }


def _usage_paths(source_errors=None):
    paths = []
    for base_dir in claude._get_claude_dirs():
        base = Path(base_dir)
        if source_errors is not None:
            paths.extend(_walk_jsonl_paths(base, source_errors))
        elif base.is_dir():
            paths.extend(base.rglob("*.jsonl"))
    codex_sessions = Path(codex.SESSIONS_DIR)
    if source_errors is not None:
        paths.extend(_walk_jsonl_paths(codex_sessions, source_errors))
    elif codex_sessions.is_dir():
        paths.extend(codex_sessions.rglob("*.jsonl"))
    extra = os.environ.get("TT_WEB_EXTRA_JSONL", "")
    for raw_path in extra.split(","):
        if raw_path.strip():
            paths.append(Path(raw_path.strip()))
    return paths


def _walk_jsonl_paths(base, source_errors):
    try:
        mode = os.stat(base).st_mode
    except OSError as exc:
        if exc.errno != errno.ENOENT:
            _append_source_error(source_errors, base, "scan", exc)
        return []
    if not stat.S_ISDIR(mode):
        _append_source_error(
            source_errors,
            base,
            "scan",
            NotADirectoryError(errno.ENOTDIR, "session root is not a directory", str(base)),
        )
        return []

    paths = []

    def record_walk_error(exc):
        if exc.errno == errno.ENOENT:
            return
        _append_source_error(
            source_errors,
            getattr(exc, "filename", None) or base,
            "scan",
            exc,
        )

    try:
        for root, _dirs, filenames in os.walk(
            base,
            onerror=record_walk_error,
            followlinks=False,
        ):
            paths.extend(
                Path(root) / filename
                for filename in filenames
                if filename.endswith(".jsonl")
            )
    except OSError as exc:
        record_walk_error(exc)
    return paths


def _parse_usage_file(path, source_errors=None, codex_models=None):
    path = Path(path)
    if _is_codex_usage_path(path):
        if codex_models is None:
            codex_models = codex._load_thread_models(
                codex.STATE_DB,
                immutable=source_errors is not None,
                source_errors=source_errors,
            )
        return codex.parse_file(
            path,
            models=codex_models,
            source_errors=source_errors,
        )

    fallback_project = "unknown"
    for base_dir in claude._get_claude_dirs():
        base = Path(base_dir)
        try:
            path.relative_to(base)
        except ValueError:
            continue
        fallback_project = claude._extract_project_from_dir(path, base)
        break
    return claude.parse_file(
        path,
        fallback_project=fallback_project,
        source_errors=source_errors,
    )


def _is_codex_usage_path(path):
    try:
        Path(path).relative_to(Path(codex.SESSIONS_DIR))
    except ValueError:
        return False
    return True


def _append_source_error(source_errors, path, stage, exc):
    if source_errors is None:
        return
    error = {
        "path": str(path),
        "stage": stage,
        "error": "%s: %s" % (type(exc).__name__, exc),
    }
    if error not in source_errors:
        source_errors.append(error)


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
