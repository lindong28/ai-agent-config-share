#!/usr/bin/env python3
import argparse
import json
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aggregators import load_all_entries  # noqa: E402
from rollup import (  # noqa: E402
    BUCKET_FIELDS,
    DEFAULT_DB_PATH,
    DEFAULT_WINDOW_DAYS,
    PROTECTED_FIELDS,
    RollupBucketTimezoneMigrationRequired,
    _bucket_date,
    _bucket_entries,
    _read_connection,
    rollup_lock,
)


def check_coverage(
    db_path,
    entries_loader=lambda: load_all_entries(read_only=True, diagnostic=True),
    window_days=DEFAULT_WINDOW_DAYS,
    now=None,
):
    if window_days < 1:
        raise ValueError("window_days must be >= 1")

    db_path = Path(db_path)
    current = (now() if now else datetime.now().astimezone()).astimezone()
    today = _bucket_date(current)
    start_date = today - timedelta(days=window_days - 1)
    try:
        with rollup_lock(db_path, create=False):
            existing_by_key = _read_rows(db_path)
            buckets = _bucket_entries(entries_loader())
    except RollupBucketTimezoneMigrationRequired as exc:
        return _indeterminate_result(db_path, start_date, today, window_days, exc)

    existing_dates = {key[0] for key in existing_by_key}
    source_dates = {key[0] for key in buckets}
    recompute_dates = {
        (start_date + timedelta(days=offset)).isoformat()
        for offset in range(window_days)
    }
    backfill_dates = source_dates - recompute_dates - existing_dates
    # Must match rollup._write_scope.
    buckets_to_compare = {
        key: bucket
        for key, bucket in buckets.items()
        if key[0] in recompute_dates or key[0] in backfill_dates
    }

    orphan_items = [
        {"key": list(key)}
        for key in sorted(existing_by_key)
        if key not in buckets
    ]
    skip_items = []
    write_items = []
    shortfall_keys = []
    for key, new_bucket in sorted(buckets_to_compare.items()):
        old_bucket = existing_by_key.get(key)
        if old_bucket is None:
            write_items.append({"key": list(key), "reason": "new"})
            shortfall_keys.append(list(key))
            continue

        decreased = [
            field
            for field in PROTECTED_FIELDS
            if new_bucket[field] < old_bucket[field]
        ]
        if decreased:
            skip_items.append(
                {
                    "key": list(key),
                    "decreased_fields": decreased,
                }
            )
            continue

        changed = any(new_bucket[field] != old_bucket[field] for field in BUCKET_FIELDS)
        if changed:
            write_items.append({"key": list(key), "reason": "changed"})
        if any(old_bucket[field] < new_bucket[field] for field in PROTECTED_FIELDS):
            shortfall_keys.append(list(key))

    return {
        "db_path": str(db_path.resolve()),
        "window": {
            "start": start_date.isoformat(),
            "end": today.isoformat(),
            "days": window_days,
        },
        "orphan_rows": {"count": len(orphan_items), "items": orphan_items},
        "would_skip": {"count": len(skip_items), "items": skip_items},
        "would_write": {"count": len(write_items), "items": write_items},
        "shortfall_keys": shortfall_keys,
        "diagnostic_errors": [],
        "verdict": "attention" if skip_items else "safe",
        "status": "attention" if skip_items else "safe",
    }


def _read_rows(db_path):
    if not db_path.is_file():
        return {}
    # No WAL check here: _read_connection(immutable=True) already refuses when
    # frames are outstanding. A second copy of the rule is a second thing to
    # keep in step, and this one had already drifted to the wider predicate.
    with _read_connection(db_path, immutable=True) as conn:
        conn.row_factory = sqlite3.Row
        table_exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'daily_rollup'"
        ).fetchone()
        if table_exists is None:
            return {}
        conn.execute("BEGIN")
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
        rows_by_key = {
            (row["date"], row["agent_id"], row["project"], row["model"]): {
                field: row[field]
                for field in BUCKET_FIELDS
            }
            for row in rows
        }
        conn.rollback()
        return rows_by_key


def _indeterminate_result(db_path, start_date, today, window_days, exc):
    return {
        "db_path": str(db_path.resolve()),
        "window": {
            "start": start_date.isoformat(),
            "end": today.isoformat(),
            "days": window_days,
        },
        "orphan_rows": {"count": 0, "items": []},
        "would_skip": {"count": 0, "items": []},
        "would_write": {"count": 0, "items": []},
        "shortfall_keys": [],
        "diagnostic_errors": [
            {
                "stage": "bucket_timezone",
                "path": str(db_path.resolve()),
                "error": "%s: %s" % (type(exc).__name__, exc),
            }
        ],
        "verdict": "unknown",
        "status": "indeterminate",
    }


def _exit_code(result):
    if result["status"] == "indeterminate":
        return 2
    if result["shortfall_keys"]:
        return 1
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Compare current source buckets with a rollup database without writing it."
    )
    parser.add_argument("--db", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    result = check_coverage(args.db)
    if args.json:
        print(json.dumps(result, sort_keys=True))
        raise SystemExit(_exit_code(result))
    else:
        print(
            "rollup source coverage: status={status} verdict={verdict} orphan_rows={orphan} "
            "would_skip={skip} would_write={write} shortfall={shortfall}".format(
                verdict=result["verdict"],
                status=result["status"],
                orphan=result["orphan_rows"]["count"],
                skip=result["would_skip"]["count"],
                write=result["would_write"]["count"],
                shortfall=len(result["shortfall_keys"]),
            )
        )
        for key in result["shortfall_keys"]:
            print("shortfall_key=%s" % "/".join(key))
        for error in result["diagnostic_errors"]:
            print(
                "diagnostic_error stage={stage} path={path} error={error}".format(
                    **error
                )
            )
    exit_code = _exit_code(result)
    if exit_code:
        raise SystemExit(exit_code)


if __name__ == "__main__":
    main()
