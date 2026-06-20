#!/usr/bin/env python3
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aggregators import load_all_entries  # noqa: E402
from rollup import DEFAULT_DB_PATH  # noqa: E402


def has_cost_or_tokens(entry):
    return (
        entry.cost_usd is not None
        or entry.input_tokens
        or entry.output_tokens
        or entry.cache_creation_tokens
        or entry.cache_read_tokens
    )


def main():
    source_dates = {
        entry.timestamp.astimezone().date().isoformat()
        for entry in load_all_entries()
        if has_cost_or_tokens(entry)
    }
    with sqlite3.connect(DEFAULT_DB_PATH) as conn:
        rollup_dates = {row[0] for row in conn.execute("SELECT DISTINCT date FROM daily_rollup")}

    missing = sorted(source_dates - rollup_dates)
    print(
        "source_dates=%d source_span=%s..%s rollup_dates=%d rollup_span=%s..%s missing=%d"
        % (
            len(source_dates),
            min(source_dates) if source_dates else "none",
            max(source_dates) if source_dates else "none",
            len(rollup_dates),
            min(rollup_dates) if rollup_dates else "none",
            max(rollup_dates) if rollup_dates else "none",
            len(missing),
        )
    )
    if missing:
        print("missing_dates=%s" % ",".join(missing))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
