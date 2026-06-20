import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import rollup
from parsers import UsageEntry


class RollupTests(unittest.TestCase):
    def test_run_creates_schema_and_buckets_recent_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            entries = [
                self.entry(ts, "s1", "repo-a", "gpt-5", "codex", 1.25, 10, 4, 2, 1, 1),
                self.entry(ts + timedelta(hours=1), "s2", "repo-a", "gpt-5", "codex", None, 5, 3, 0, 0, 2),
            ]

            result = rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            self.assertEqual(result["days_recomputed"], 28)
            rows = self.fetch_daily_rows(db_path)
            expected_day = ts.astimezone().date().isoformat()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["date"], expected_day)
            self.assertEqual(rows[0]["agent_id"], "codex")
            self.assertEqual(rows[0]["project"], "repo-a")
            self.assertEqual(rows[0]["model"], "gpt-5")
            self.assertEqual(rows[0]["input_tokens"], 15)
            self.assertEqual(rows[0]["output_tokens"], 7)
            self.assertEqual(rows[0]["cache_read_tokens"], 2)
            self.assertEqual(rows[0]["cache_creation_tokens"], 1)
            self.assertAlmostEqual(rows[0]["cost_usd"], 1.25)
            self.assertEqual(rows[0]["cost_known_count"], 1)
            self.assertEqual(rows[0]["entry_count"], 2)
            self.assertEqual(rows[0]["message_count"], 3)
            self.assertIsNotNone(self.fetch_meta(db_path, "last_rollup_ts"))

    def test_window_outside_source_date_is_inserted_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            old_ts = now - timedelta(days=40)
            old_day = old_ts.astimezone().date().isoformat()
            entries = [
                self.entry(old_ts, "old-1", "repo-old", "gpt-5", "codex", 9.99, 99, 9, 3, 2, 1),
                self.entry(old_ts + timedelta(hours=1), "old-2", "repo-old", "gpt-5", "codex", 1.01, 1, 1, 0, 0, 2),
            ]

            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["date"], old_day)
            self.assertAlmostEqual(rows[0]["cost_usd"], 11.0)
            self.assertEqual(rows[0]["input_tokens"], 100)
            self.assertEqual(rows[0]["output_tokens"], 10)
            self.assertEqual(rows[0]["cache_read_tokens"], 3)
            self.assertEqual(rows[0]["cache_creation_tokens"], 2)
            self.assertEqual(rows[0]["entry_count"], 2)
            self.assertEqual(rows[0]["message_count"], 3)

    def test_run_replaces_recent_days_idempotently(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=2)

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "s1", "repo-a", "gpt-5", "codex", 1.0, 1, 1, 0, 0, 1)],
                now=lambda: now,
            )
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "s2", "repo-a", "gpt-5", "codex", 3.0, 3, 2, 0, 0, 4)],
                now=lambda: now,
            )

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(len(rows), 1)
            self.assertAlmostEqual(rows[0]["cost_usd"], 3.0)
            self.assertEqual(rows[0]["input_tokens"], 3)
            self.assertEqual(rows[0]["entry_count"], 1)
            self.assertEqual(rows[0]["message_count"], 4)

    def test_unknown_costs_are_tracked_for_none_restoration(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=3)

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "s1", "repo-a", "unknown", "claude-code", None, 7, 8, 9, 10, 2)],
                now=lambda: now,
            )

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["cost_usd"], 0.0)
            self.assertEqual(rows[0]["cost_known_count"], 0)
            self.assertEqual(rows[0]["entry_count"], 1)

    def test_window_outside_day_is_preserved_when_source_no_longer_covers_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            old_day = (now - timedelta(days=400)).date().isoformat()
            rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
            self.seed_row(db_path, old_day, cost=12.5, input_tokens=100)

            rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["date"], old_day)
            self.assertAlmostEqual(rows[0]["cost_usd"], 12.5)
            self.assertEqual(rows[0]["input_tokens"], 100)

    def test_partial_deleted_source_outside_window_does_not_shrink_frozen_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            old_ts = now - timedelta(days=35)
            old_day = old_ts.astimezone().date().isoformat()
            rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
            self.seed_row(db_path, old_day, cost=20.0, input_tokens=200, entry_count=5)

            partial_source = [
                self.entry(old_ts, "partial", "repo-a", "gpt-5", "codex", 2.0, 20, 2, 0, 0, 1)
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: partial_source, now=lambda: now)

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["date"], old_day)
            self.assertAlmostEqual(rows[0]["cost_usd"], 20.0)
            self.assertEqual(rows[0]["input_tokens"], 200)
            self.assertEqual(rows[0]["entry_count"], 5)

    def test_in_window_day_preserves_agent_whose_source_was_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            day_ts = now - timedelta(days=5)  # inside the 28-day recompute window

            # Both agents produce data on the same in-window day.
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(day_ts, "cx", "repo-a", "gpt-5", "codex", 5.0, 50, 5, 0, 0, 1),
                    self.entry(day_ts, "cc", "repo-a", "sonnet", "claude-code", 1.0, 10, 1, 0, 0, 1),
                ],
                now=lambda: now,
            )

            # Codex raw logs get deleted; only claude-code source survives (refreshed total).
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(day_ts, "cc", "repo-a", "sonnet", "claude-code", 2.0, 20, 2, 0, 0, 1),
                ],
                now=lambda: now,
            )

            rows = {row["agent_id"]: row for row in self.fetch_daily_rows(db_path)}
            # Codex preserved at its last-known value despite its source being gone.
            self.assertIn("codex", rows)
            self.assertAlmostEqual(rows["codex"]["cost_usd"], 5.0)
            self.assertEqual(rows["codex"]["input_tokens"], 50)
            # Claude-code refreshed from current source (proves live agents still recompute).
            self.assertAlmostEqual(rows["claude-code"]["cost_usd"], 2.0)
            self.assertEqual(rows["claude-code"]["input_tokens"], 20)

    def test_query_pivot_restores_none_for_all_unknown_costs(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            known_ts = now - timedelta(days=1)
            unknown_ts = now - timedelta(days=2)
            entries = [
                self.entry(known_ts, "known", "repo-a", "gpt-5", "codex", 2.5, 10, 0, 0, 0, 1),
                self.entry(unknown_ts, "unknown", "repo-b", "missing", "claude-code", None, 20, 0, 0, 0, 1),
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            result = rollup.query_pivot("day", "project", "cost", db_path=db_path)

            unknown_day = unknown_ts.astimezone().date().isoformat()
            known_day = known_ts.astimezone().date().isoformat()
            by_day = {row["x"]: row["values"] for row in result["rows"]}
            self.assertIsNone(by_day[unknown_day]["repo-b"])
            self.assertAlmostEqual(by_day[known_day]["repo-a"], 2.5)

    def test_query_pivot_aggregates_week_and_month_from_daily_rollup(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            first = datetime(2026, 6, 9, 8, 0, tzinfo=timezone.utc)
            second = datetime(2026, 6, 10, 8, 0, tzinfo=timezone.utc)
            entries = [
                self.entry(first, "s1", "repo-a", "gpt-5", "codex", 1.0, 10, 1, 0, 0, 1),
                self.entry(second, "s2", "repo-a", "gpt-5", "codex", 2.0, 20, 2, 0, 0, 1),
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            weekly = rollup.query_pivot("week", "agent", "cost", db_path=db_path)
            monthly = rollup.query_pivot("month", "none", "input", db_path=db_path)

            week_key = first.astimezone().date() - timedelta(days=first.astimezone().weekday())
            self.assertEqual(weekly["rows"], [{"x": week_key.isoformat(), "values": {"codex": 3.0}}])
            self.assertEqual(monthly["rows"], [{"x": "2026-06", "values": {"value": 30}}])

    def test_query_pivot_folds_large_group_dimension_into_top_12_and_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            entries = [
                self.entry(ts, f"s{i}", f"repo-{i:02d}", "gpt-5", "codex", float(i), i, 0, 0, 0, 1)
                for i in range(1, 17)
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            result = rollup.query_pivot("day", "project", "cost", db_path=db_path)

            self.assertEqual(len(result["columns"]), 13)
            self.assertIn("Other", result["columns"])
            self.assertEqual(set(result["columns"]) - {"Other"}, {f"repo-{i:02d}" for i in range(5, 17)})
            values = result["rows"][0]["values"]
            self.assertAlmostEqual(values["Other"], sum(range(1, 5)))
            self.assertAlmostEqual(sum(value or 0 for value in values.values()), sum(range(1, 17)))

    def test_query_pivot_folds_large_non_time_x_dimension_into_top_12_and_other(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            entries = [
                self.entry(ts, f"s{i}", f"repo-{i:02d}", "gpt-5", "codex", float(i), i, 0, 0, 0, 1)
                for i in range(1, 17)
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            result = rollup.query_pivot("project", "none", "cost", db_path=db_path)

            by_x = {row["x"]: row["values"]["value"] for row in result["rows"]}
            self.assertEqual(len(result["rows"]), 13)
            self.assertIn("Other", by_x)
            self.assertEqual(set(by_x) - {"Other"}, {f"repo-{i:02d}" for i in range(5, 17)})
            self.assertAlmostEqual(by_x["Other"], sum(range(1, 5)))
            self.assertAlmostEqual(sum(value or 0 for value in by_x.values()), sum(range(1, 17)))

    def test_query_pivot_leaves_dimensions_with_15_or_fewer_values_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            entries = [
                self.entry(ts, f"s{i}", "repo-a", f"model-{i:02d}", "codex", float(i), i, 0, 0, 0, 1)
                for i in range(1, 16)
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            result = rollup.query_pivot("day", "model", "cost", db_path=db_path)

            self.assertEqual(len(result["columns"]), 15)
            self.assertNotIn("Other", result["columns"])
            self.assertEqual(set(result["columns"]), {f"model-{i:02d}" for i in range(1, 16)})

    def test_needs_run_uses_last_rollup_ts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            self.assertTrue(rollup.needs_run(db_path=db_path, now=lambda: now, max_age_seconds=600))
            rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
            self.assertFalse(rollup.needs_run(db_path=db_path, now=lambda: now + timedelta(minutes=9), max_age_seconds=600))
            self.assertTrue(rollup.needs_run(db_path=db_path, now=lambda: now + timedelta(minutes=11), max_age_seconds=600))

    def test_history_gap_reports_stale_latest_rollup_date_when_source_has_newer_entries(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            stale = now - timedelta(days=10)
            fresh = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(stale, "stale", "repo-a", "gpt-5", "codex", 1.0, 1, 0, 0, 0, 1)],
                now=lambda: stale,
            )

            gap = rollup.history_gap(
                [self.entry(fresh, "fresh", "repo-a", "gpt-5", "codex", 1.0, 1, 0, 0, 0, 1)],
                db_path=db_path,
                now=lambda: now,
                max_gap_days=2,
            )

            self.assertIsNotNone(gap)
            self.assertEqual(gap["latest_date"], stale.astimezone().date().isoformat())
            self.assertEqual(gap["today"], now.astimezone().date().isoformat())

    @staticmethod
    def fetch_daily_rows(db_path):
        with sqlite3.connect(db_path) as conn:
            conn.row_factory = sqlite3.Row
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM daily_rollup ORDER BY date, agent_id, project, model"
                )
            ]

    @staticmethod
    def fetch_meta(db_path, key):
        with sqlite3.connect(db_path) as conn:
            row = conn.execute("SELECT value FROM rollup_meta WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None

    @staticmethod
    def seed_row(db_path, day, cost, input_tokens, entry_count=1):
        with sqlite3.connect(db_path) as conn:
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
                ) VALUES (?, 'codex', 'repo-a', 'gpt-5', ?, 0, 0, 0, ?, 1, ?, 1)
                """,
                (day, input_tokens, cost, entry_count),
            )

    @staticmethod
    def entry(ts, sid, project, model, agent, cost, input_tokens, output_tokens, cache_read, cache_creation, messages):
        return UsageEntry(
            timestamp=ts,
            session_id=sid,
            message_id=f"{sid}-msg",
            request_id=f"{sid}-req",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_tokens=cache_creation,
            cache_read_tokens=cache_read,
            cost_usd=cost,
            project=project,
            agent_id=agent,
            message_count=messages,
        )


if __name__ == "__main__":
    unittest.main()
