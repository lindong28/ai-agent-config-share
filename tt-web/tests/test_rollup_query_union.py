import contextlib
import os
import sqlite3
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import rollup
from parsers import UsageEntry
from tests import check_rollup_source_coverage


class RollupQueryUnionTests(unittest.TestCase):
    def test_iv1_unions_admitted_generations_and_labels_every_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = self.make_db(Path(tmp) / "macbook.db", [("2026-06-13", "repo-a", 10)])
            second = self.make_db(
                Path(tmp) / "macmini.db",
                [("2026-06-12", "repo-b", 20), ("2026-06-13", "repo-c", 30)],
            )
            generations = (
                rollup.AdmittedGeneration("macbook", first),
                rollup.AdmittedGeneration("macmini", second),
            )

            with mock.patch("rollup.admitted_generations", return_value=generations):
                rows = rollup._daily_rows(None, None)

            self.assertEqual(len(rows), 3)
            self.assertEqual([row["host"] for row in rows], ["macbook", "macmini", "macmini"])

    def test_same_directory_on_two_operating_systems_is_one_project(self):
        """A Mac records /Users/me/x and a Linux box records /home/me/x for the
        same working directory. Left as stored they are two rows nobody would
        think to add up, so the query layer relabels both to ~/x."""
        with tempfile.TemporaryDirectory() as tmp:
            mac = self.make_db(
                Path(tmp) / "macbook.db", [("2026-06-13", "/Users/lindong/research/x", 10)]
            )
            linux = self.make_db(
                Path(tmp) / "dgx.db", [("2026-06-13", "/home/lindong/research/x", 20)]
            )
            generations = (
                rollup.AdmittedGeneration("macbook", mac),
                rollup.AdmittedGeneration("gpu-box", linux),
            )

            with mock.patch("rollup.admitted_generations", return_value=generations):
                rows = rollup._daily_rows(None, None)
                pivot = rollup.query_pivot("project", "none", "input")
                options = rollup.filter_options()

            self.assertEqual({row["project"] for row in rows}, {"~/research/x"})
            self.assertEqual(
                [(r["x"], r["values"]["value"]) for r in pivot["rows"]],
                [("~/research/x", 30)],
            )
            # The axis, the filter values and filter matching have to agree on
            # the label; a consumer left on the raw path silently filters to
            # nothing.
            self.assertEqual(options["project"], ["~/research/x"])
            with mock.patch("rollup.admitted_generations", return_value=generations):
                filtered = rollup.query_pivot(
                    "machine", "none", "input", projects={"~/research/x"}
                )
            self.assertEqual(
                sorted((r["x"], r["values"]["value"]) for r in filtered["rows"]),
                [("gpu-box", 20), ("macbook", 10)],
            )

    def test_iv2_machine_pivot_matches_each_generation_queried_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = self.make_db(
                Path(tmp) / "macbook.db",
                [("2026-06-12", "repo-a", 10), ("2026-06-13", "repo-b", 11)],
            )
            second = self.make_db(
                Path(tmp) / "macmini.db",
                [("2026-06-12", "repo-c", 20), ("2026-06-13", "repo-d", 22)],
            )
            generations = (
                rollup.AdmittedGeneration("macbook", first),
                rollup.AdmittedGeneration("macmini", second),
            )

            with mock.patch("rollup.admitted_generations", return_value=generations):
                combined = rollup.query_pivot("machine", "none", "input")
                only_macmini = rollup.query_pivot(
                    "day", "none", "input", machines={"macmini"}
                )

            combined_totals = {
                row["x"]: row["values"]["value"] for row in combined["rows"]
            }
            expected_first = self.pivot_total(first)
            expected_second = self.pivot_total(second)
            self.assertEqual(
                combined_totals,
                {"macbook": expected_first, "macmini": expected_second},
            )
            self.assertEqual(
                sum(row["values"]["value"] for row in only_macmini["rows"]),
                expected_second,
            )

    def test_iv3_single_self_generation_preserves_existing_pivot_results(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "self.db",
                [("2026-06-12", "repo-a", 10), ("2026-06-13", "repo-b", 20)],
            )
            expected = rollup.query_pivot(
                "day", "agent", "input", db_path=db_path
            )

            with mock.patch(
                "rollup.admitted_generations",
                return_value=(rollup.AdmittedGeneration("macbook", db_path),),
            ):
                actual = rollup.query_pivot("day", "agent", "input")

            self.assertEqual(actual, expected)

    def test_iv4_explicit_db_path_does_not_consult_generations(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "isolated.db", [("2026-06-13", "repo-a", 10)]
            )

            with mock.patch(
                "rollup.admitted_generations",
                side_effect=AssertionError("explicit db_path must stay isolated"),
            ):
                result = rollup.query_pivot(
                    "machine",
                    "none",
                    "input",
                    machines={"macbook"},
                    db_path=db_path,
                    source_machine="macbook",
                )
                options = rollup.filter_options(
                    db_path=db_path, source_machine="macbook"
                )

            self.assertEqual(
                result["rows"],
                [{"x": "macbook", "values": {"value": 10}}],
            )
            self.assertEqual(options["project"], ["repo-a"])
            self.assertEqual(options["machine"], ["macbook"])

    def test_iv16_nd_range_is_exact_shanghai_calendar_days_at_local_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "range.db",
                [
                    (
                        (datetime(2026, 6, 14) - timedelta(days=offset)).date().isoformat(),
                        "repo",
                        1,
                    )
                    for offset in range(31)
                ],
            )
            local_now = datetime(2026, 6, 13, 17, 30, tzinfo=timezone(timedelta(hours=-7)))

            calendar_range = rollup.range_window("7d", local_now)
            thirty_calendar_range = rollup.range_window("30d", local_now)
            explicit = rollup.query_pivot(
                "day", "none", "input", time_range=calendar_range, db_path=db_path
            )
            legacy_datetime_range = rollup.query_pivot(
                "day",
                "none",
                "input",
                time_range=(local_now - timedelta(days=7), local_now),
                calendar_days=7,
                db_path=db_path,
            )
            thirty_day_range = rollup.query_pivot(
                "day",
                "none",
                "input",
                time_range=(local_now - timedelta(days=30), local_now),
                calendar_days=30,
                db_path=db_path,
            )

            self.assertEqual(
                calendar_range,
                (datetime(2026, 6, 8).date(), datetime(2026, 6, 14).date()),
            )
            self.assertEqual([row["x"] for row in explicit["rows"]], [
                "2026-06-08",
                "2026-06-09",
                "2026-06-10",
                "2026-06-11",
                "2026-06-12",
                "2026-06-13",
                "2026-06-14",
            ])
            self.assertEqual(len(legacy_datetime_range["rows"]), 7)
            self.assertEqual(
                sum(row["values"]["value"] for row in legacy_datetime_range["rows"]),
                7,
            )
            self.assertEqual(
                (thirty_calendar_range[1] - thirty_calendar_range[0]).days + 1,
                30,
            )
            self.assertEqual(len(thirty_day_range["rows"]), 30)
            self.assertEqual(
                sum(row["values"]["value"] for row in thirty_day_range["rows"]),
                30,
            )

    def test_iv16_datetime_adapter_uses_nominal_days_across_dst_offset_change(self):
        start = datetime(2026, 10, 26, 8, 30, tzinfo=timezone(timedelta(hours=-7)))
        end = datetime(2026, 11, 2, 8, 30, tzinfo=timezone(timedelta(hours=-8)))

        first_day, last_day = rollup._calendar_date_bounds(
            (start, end), calendar_days=7
        )

        self.assertEqual((last_day - first_day).days + 1, 7)

    def test_datetime_adapter_rejects_ranges_without_explicit_calendar_days(self):
        start = datetime(2026, 10, 26, 8, 30, tzinfo=timezone(timedelta(hours=-7)))
        end = datetime(2026, 11, 2, 8, 30, tzinfo=timezone(timedelta(hours=-8)))

        with self.assertRaisesRegex(ValueError, "calendar_days"):
            rollup._calendar_date_bounds((start, end))

    def test_day_boundary_writer_and_reader_agree_when_system_timezone_is_not_shanghai(self):
        with tempfile.TemporaryDirectory() as tmp, self.system_timezone("America/Los_Angeles"):
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 14, 0, 30, tzinfo=timezone(timedelta(hours=8)))
            entry = self.entry(datetime(2026, 6, 8, 0, 30, tzinfo=now.tzinfo), input_tokens=9)

            rollup.run(db_path=db_path, entries_loader=lambda: [entry], now=lambda: now)
            result = rollup.query_pivot(
                "day",
                "none",
                "input",
                time_range=rollup.range_window("7d", now),
                db_path=db_path,
            )

            self.assertEqual(
                result["rows"],
                [{"x": "2026-06-08", "values": {"value": 9}}],
            )

    def test_day_boundary_recompute_window_uses_shanghai_today(self):
        with tempfile.TemporaryDirectory() as tmp, self.system_timezone("America/Los_Angeles"):
            db_path = self.make_db(
                Path(tmp) / "rollup.db", [("2026-06-14", "repo", 10)]
            )
            self.set_meta(db_path, "bucket_timezone", "Asia/Shanghai")
            now = datetime(2026, 6, 14, 0, 30, tzinfo=timezone(timedelta(hours=8)))
            entry = self.entry(datetime(2026, 6, 14, 0, 15, tzinfo=now.tzinfo), input_tokens=20)

            rollup.run(
                window_days=1,
                db_path=db_path,
                entries_loader=lambda: [entry],
                now=lambda: now,
            )

            rows = self.fetch_rows(db_path)
            self.assertEqual([(row["date"], row["input_tokens"]) for row in rows], [("2026-06-14", 20)])

    def test_day_boundary_source_coverage_oracle_uses_shanghai_window(self):
        with tempfile.TemporaryDirectory() as tmp, self.system_timezone("America/Los_Angeles"):
            db_path = self.make_db(Path(tmp) / "rollup.db", [])
            Path(str(db_path) + ".lock").touch(mode=0o600)
            now = datetime(2026, 6, 14, 0, 30, tzinfo=timezone(timedelta(hours=8)))

            result = check_rollup_source_coverage.check_coverage(
                db_path,
                entries_loader=list,
                window_days=7,
                now=lambda: now,
            )

            self.assertEqual(
                result["window"],
                {"start": "2026-06-08", "end": "2026-06-14", "days": 7},
            )

    def test_day_boundary_history_gap_uses_shanghai_today(self):
        with tempfile.TemporaryDirectory() as tmp, self.system_timezone("America/Los_Angeles"):
            db_path = self.make_db(
                Path(tmp) / "rollup.db", [("2026-06-11", "repo", 10)]
            )
            now = datetime(2026, 6, 14, 0, 30, tzinfo=timezone(timedelta(hours=8)))
            entry = self.entry(datetime(2026, 6, 13, 12, 0, tzinfo=now.tzinfo))

            result = rollup.history_gap(
                [entry], db_path=db_path, now=lambda: now, max_gap_days=2
            )

            self.assertEqual(result["today"], "2026-06-14")
            self.assertEqual(result["gap_days"], 3)

    def test_existing_unmarked_history_requires_explicit_timezone_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )
            before = self.fetch_rows(db_path)
            now = datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc)
            loader = mock.Mock(return_value=[self.entry(now, input_tokens=20)])

            with self.assertRaises(rollup.RollupBucketTimezoneMigrationRequired):
                rollup.run(
                    db_path=db_path,
                    entries_loader=loader,
                    now=lambda: now,
                )

            loader.assert_not_called()
            self.assertEqual(self.fetch_rows(db_path), before)
            self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))

    def test_read_chokepoint_rejects_unmarked_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )

            with self.assertRaises(rollup.RollupBucketTimezoneMigrationRequired):
                rollup.query_pivot("day", "none", "input", db_path=db_path)

    def test_read_chokepoint_rejects_mismatched_empty_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "mismatched.db", [], bucket_timezone="Etc/UTC"
            )

            with self.assertRaises(rollup.RollupBucketTimezoneMigrationRequired):
                rollup.query_pivot("day", "none", "input", db_path=db_path)

    def test_unmarked_history_does_not_schedule_an_ordinary_rollup(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )

            self.assertFalse(rollup.needs_run(db_path=db_path))

    def test_default_date_metadata_readers_use_only_admitted_generations(self):
        with mock.patch("rollup.admitted_generations", return_value=()), mock.patch(
            "rollup._read_connection",
            side_effect=AssertionError("excluded databases must not be opened"),
        ):
            self.assertIsNone(rollup.earliest_rollup_date())
            self.assertIsNone(rollup.latest_rollup_date())
            self.assertIsNone(rollup.history_gap([]))

    def test_checker_reports_marker_rejection_without_loading_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )
            Path(str(db_path) + ".lock").touch(mode=0o600)
            loader = mock.Mock(side_effect=AssertionError("loader must not run"))

            result = rollup._check_rollup(
                db_path,
                loader,
                now=lambda: datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc),
            )

            loader.assert_not_called()
            self.assertEqual(result["db_state"], "bucket_timezone_migration_required")
            self.assertEqual(result["status"], "indeterminate")
            self.assertEqual(result["verdict"], "unknown")
            self.assertEqual(result["diagnostic_errors"][0]["stage"], "bucket_timezone")

    def test_source_coverage_oracle_reports_marker_rejection_without_loading_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )
            Path(str(db_path) + ".lock").touch(mode=0o600)
            loader = mock.Mock(side_effect=AssertionError("loader must not run"))

            result = check_rollup_source_coverage.check_coverage(
                db_path,
                entries_loader=loader,
                now=lambda: datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc),
            )

            loader.assert_not_called()
            self.assertEqual(result["status"], "indeterminate")
            self.assertEqual(result["verdict"], "unknown")
            self.assertEqual(result["diagnostic_errors"][0]["stage"], "bucket_timezone")
            self.assertEqual(check_rollup_source_coverage._exit_code(result), 2)

    def test_new_database_records_fixed_bucket_timezone(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "new.db"
            now = datetime(2026, 6, 14, 12, 0, tzinfo=timezone.utc)

            rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)

            self.assertEqual(
                self.fetch_meta(db_path, "bucket_timezone"), "Asia/Shanghai"
            )

    def test_generation_provider_never_admits_a_bare_rollup_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(
                Path(tmp) / "legacy.db",
                [("2026-06-13", "repo", 10)],
                bucket_timezone=None,
            )
            baseline = rollup.admitted_generations()

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                self.assertEqual(rollup.admitted_generations(), baseline)

            self.set_meta(db_path, "bucket_timezone", "Etc/UTC")
            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                self.assertEqual(rollup.admitted_generations(), baseline)

            self.set_meta(db_path, "bucket_timezone", "Asia/Shanghai")
            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                generations = rollup.admitted_generations()
            self.assertEqual(generations, baseline)
            self.assertNotIn(db_path, {generation.db_path for generation in generations})

    @staticmethod
    def make_db(db_path, rows, bucket_timezone="Asia/Shanghai"):
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            with conn:
                conn.executescript(rollup.SCHEMA)
                conn.executemany(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model,
                      input_tokens, output_tokens, cache_creation_tokens,
                      cache_read_tokens, cost_usd, cost_known_count,
                      entry_count, message_count
                    ) VALUES (?, 'codex', ?, 'gpt-5', ?, 0, 0, 0, 0, 1, 1, 1)
                    """,
                    rows,
                )
                if bucket_timezone is not None:
                    conn.execute(
                        "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', ?)",
                        (bucket_timezone,),
                    )
        return db_path

    @staticmethod
    def pivot_total(db_path):
        result = rollup.query_pivot("day", "none", "input", db_path=db_path)
        return sum(row["values"]["value"] for row in result["rows"])

    @staticmethod
    def entry(timestamp, input_tokens=1):
        return UsageEntry(
            timestamp=timestamp,
            session_id="session",
            message_id="message",
            request_id="request",
            model="gpt-5",
            input_tokens=input_tokens,
            output_tokens=0,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cost_usd=0.0,
            project="repo",
            agent_id="codex",
            message_count=1,
        )

    @staticmethod
    def fetch_rows(db_path):
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            conn.row_factory = sqlite3.Row
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM daily_rollup ORDER BY date, agent_id, project, model"
                )
            ]

    @staticmethod
    def fetch_meta(db_path, key):
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            row = conn.execute(
                "SELECT value FROM rollup_meta WHERE key = ?", (key,)
            ).fetchone()
            return row[0] if row else None

    @staticmethod
    def set_meta(db_path, key, value):
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            with conn:
                conn.execute(
                    "INSERT OR REPLACE INTO rollup_meta (key, value) VALUES (?, ?)",
                    (key, value),
                )

    @staticmethod
    @contextlib.contextmanager
    def system_timezone(name):
        previous = os.environ.get("TZ")
        try:
            os.environ["TZ"] = name
            time.tzset()
            yield
        finally:
            if previous is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = previous
            time.tzset()


if __name__ == "__main__":
    unittest.main()
