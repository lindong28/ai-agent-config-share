import sqlite3
from collections import OrderedDict, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from aggregators import load_all_entries


ROOT = Path(__file__).resolve().parent
DEFAULT_DB_PATH = ROOT / "state" / "rollup.db"
DEFAULT_WINDOW_DAYS = 28
TIME_DIMS = {"day", "week", "month"}
ALL_DIMS = TIME_DIMS | {"project", "model", "agent"}
METRICS = {"cost", "input", "output", "cache_read", "cache_creation", "total", "messages"}
TOP_DIMENSION_THRESHOLD = 15
TOP_DIMENSION_LIMIT = 12
OTHER_BUCKET = "Other"


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


def run(window_days=DEFAULT_WINDOW_DAYS, db_path=DEFAULT_DB_PATH, entries_loader=load_all_entries, now=None):
    if window_days < 1:
        raise ValueError("window_days must be >= 1")

    current = _now(now)
    today = current.date()
    start_date = today - timedelta(days=window_days - 1)
    recompute_dates = [(start_date + timedelta(days=offset)).isoformat() for offset in range(window_days)]
    recompute_date_set = set(recompute_dates)
    buckets = _bucket_entries(entries_loader())

    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _init_db(conn)
        with conn:
            existing_dates = _existing_rollup_dates(conn)
            source_dates = {key[0] for key in buckets}
            backfill_dates = source_dates - recompute_date_set - existing_dates
            buckets_to_write = {
                key: value
                for key, value in buckets.items()
                if key[0] in recompute_date_set or key[0] in backfill_dates
            }
            # Recompute deletes only the (date, agent) groups we are about to
            # rewrite from fresh source. An in-window day whose agent source was
            # deleted (e.g. pruned raw logs) keeps its last collected rows instead
            # of being wiped, while other agents on that same day still refresh.
            refreshed_date_agents = {
                (key[0], key[1])
                for key in buckets_to_write
                if key[0] in recompute_date_set
            }
            for day, agent_id in refreshed_date_agents:
                conn.execute(
                    "DELETE FROM daily_rollup WHERE date = ? AND agent_id = ?",
                    (day, agent_id),
                )
            conn.executemany(
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
                """,
                [_bucket_tuple(key, value) for key, value in sorted(buckets_to_write.items())],
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
        "buckets_written": len(buckets_to_write),
        "last_rollup_ts": current.isoformat(),
    }


def query_pivot(
    x_dim,
    group_dim,
    metric,
    agents=None,
    projects=None,
    models=None,
    time_range=None,
    db_path=DEFAULT_DB_PATH,
):
    _validate(x_dim, group_dim, metric)
    filters = {
        "agent": set(agents or []),
        "project": set(projects or []),
        "model": set(models or []),
    }
    rows = _daily_rows(db_path, time_range)
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


def filter_options(time_range=None, db_path=DEFAULT_DB_PATH):
    rows = _daily_rows(db_path, time_range)
    values = {"agent": set(), "project": set(), "model": set()}
    for row in rows:
        values["agent"].add(row["agent_id"])
        values["project"].add(row["project"])
        values["model"].add(row["model"])
    return {key: sorted(items) for key, items in values.items()}


def last_rollup_ts(db_path=DEFAULT_DB_PATH):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _init_db(conn)
        row = conn.execute("SELECT value FROM rollup_meta WHERE key = 'last_rollup_ts'").fetchone()
    if not row:
        return None
    try:
        return datetime.fromisoformat(row[0])
    except ValueError:
        return None


def needs_run(max_age_seconds=600, db_path=DEFAULT_DB_PATH, now=None):
    previous = last_rollup_ts(db_path=db_path)
    if previous is None:
        return True
    age = (_now(now) - previous.astimezone()).total_seconds()
    return age > max_age_seconds


def latest_rollup_date(db_path=DEFAULT_DB_PATH):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _init_db(conn)
        row = conn.execute("SELECT MAX(date) FROM daily_rollup").fetchone()
    return row[0] if row and row[0] else None


def earliest_rollup_date(db_path=DEFAULT_DB_PATH):
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _init_db(conn)
        row = conn.execute("SELECT MIN(date) FROM daily_rollup").fetchone()
    return row[0] if row and row[0] else None


def history_gap(entries, max_gap_days=2, db_path=DEFAULT_DB_PATH, now=None):
    latest = latest_rollup_date(db_path=db_path)
    if latest is None:
        return None
    latest_date = date.fromisoformat(latest)
    current_date = _now(now).date()
    gap_days = (current_date - latest_date).days
    if gap_days <= max_gap_days:
        return None

    source_dates = [entry.timestamp.astimezone().date() for entry in entries]
    if not source_dates or max(source_dates) <= latest_date:
        return None
    return {
        "latest_date": latest_date.isoformat(),
        "today": current_date.isoformat(),
        "gap_days": gap_days,
        "message": "History rollup is stale; cost before the latest rollup date may be incomplete.",
    }


def _connect(db_path):
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def _init_db(conn):
    conn.executescript(SCHEMA)


def _existing_rollup_dates(conn):
    return {row[0] for row in conn.execute("SELECT DISTINCT date FROM daily_rollup")}


def _daily_rows(db_path, time_range):
    clauses = []
    params = []
    if time_range is not None:
        start, end = time_range
        clauses.append("date >= ?")
        params.append(start.astimezone().date().isoformat())
        clauses.append("date <= ?")
        params.append(end.astimezone().date().isoformat())
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    sql = "SELECT * FROM daily_rollup" + where + " ORDER BY date, agent_id, project, model"

    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with _connect(db_path) as conn:
        _init_db(conn)
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params)]


def _now(now):
    value = now() if now else datetime.now().astimezone()
    return value.astimezone()


def _bucket_entries(entries):
    buckets = defaultdict(_empty_bucket)
    for entry in entries:
        day = entry.timestamp.astimezone().date()
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
    return True


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
