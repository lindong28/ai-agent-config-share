import json
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import rollup
from parsers import UsageEntry


class RollupAdoptionTests(unittest.TestCase):
    def test_issue006_explicit_adoption_records_three_honest_evidence_layers(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path)
            entries = [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=False,
                    now=lambda: datetime(2026, 8, 4, 12, tzinfo=timezone.utc),
                )

            self.assertEqual(result["status"], "adopted")
            self.assertEqual(result["bucket_timezone"], "Asia/Shanghai")
            evidence = result["evidence"]
            self.assertEqual(
                evidence["reconstructible_overlap"]["protected_counter_verification"]["status"],
                "verified",
            )
            self.assertEqual(
                evidence["reconstructible_overlap"]["bucket_keys"],
                {"expected": 1, "matched": 1, "missing": 0},
            )
            self.assertEqual(
                evidence["reconstructible_overlap"]["non_equal_protected_counter_assumption"],
                {
                    "status": "not_used",
                    "bucket_keys": 0,
                    "assumption": (
                        "Buckets with non-equal protected counters are adopted by separate "
                        "explicit authorization; available values cannot distinguish pruning "
                        "or live growth from misdating."
                    ),
                },
            )
            self.assertEqual(
                evidence["reconstructible_overlap"]["protected_counter_verification"]["equal_bucket_keys"],
                {"expected": 1, "actual": 1},
            )
            self.assertEqual(
                evidence["reconstructible_overlap"]["cost_attribution_verification"],
                {
                    "status": "not_verified",
                    "fields": ["cost_usd", "cost_known_count"],
                    "reason": "Pricing changes can alter cost without changing protected counters.",
                },
            )
            self.assertEqual(evidence["known_offset"]["status"], "known_fact")
            self.assertEqual(evidence["known_offset"]["utc_offset"], "+08:00")
            self.assertEqual(
                evidence["pre_log_history"]["status"],
                "user_authorized_historical_assumption",
            )
            self.assertEqual(evidence["pre_log_history"]["start_date"], "2026-04-21")
            self.assertEqual(evidence["pre_log_history"]["end_by_agent"]["codex"], "2026-07-03")

            with closing(sqlite3.connect(db_path)) as conn:
                marker = conn.execute(
                    "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
                ).fetchone()[0]
                recorded = json.loads(
                    conn.execute(
                        "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone_adoption'"
                    ).fetchone()[0]
                )
            self.assertEqual(marker, "Asia/Shanghai")
            self.assertEqual(recorded, evidence)
            rows = rollup.query_pivot("day", "none", "input", db_path=db_path)["rows"]
            self.assertEqual(sum(row["values"]["value"] for row in rows), 11)

    def test_issue006_adoption_refuses_missing_authorization_offset_or_overlap(self):
        cases = (
            {
                "known_utc_offset": "+08:00",
                "authorize_pre_log_assumption": False,
                "authorize_non_exact_overlap_assumption": False,
            },
            {
                "known_utc_offset": "+00:00",
                "authorize_pre_log_assumption": True,
                "authorize_non_exact_overlap_assumption": False,
            },
        )
        for kwargs in cases:
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as tmp:
                db_path = Path(tmp) / "rollup.db"
                self.seed_unmarked(db_path)
                with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                    with self.assertRaises(rollup.RollupAdoptionError):
                        rollup.adopt_bucket_timezone(
                            db_path,
                            [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)],
                            raw_log_starts={"codex": "2026-07-04"},
                            **kwargs,
                        )
                self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path)
            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                with self.assertRaisesRegex(rollup.RollupAdoptionError, "missing"):
                    rollup.adopt_bucket_timezone(
                        db_path,
                        [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 999, project="missing")],
                        known_utc_offset="+08:00",
                        raw_log_starts={"codex": "2026-07-04"},
                        authorize_pre_log_assumption=True,
                        authorize_non_exact_overlap_assumption=False,
                    )
            self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))

    def test_issue006_cutoff_excludes_post_rollup_growth_and_records_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(
                db_path,
                dated_rows=(("2026-04-21", 1), ("2026-07-04", 10)),
                last_rollup_ts="2026-07-04T13:00:00+00:00",
            )
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                self.entry(
                    datetime(2026, 7, 4, 14, tzinfo=timezone.utc),
                    7,
                    project="post-cutoff-missing",
                    agent_id="future-agent",
                ),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=False,
                )

            overlap = result["evidence"]["reconstructible_overlap"]
            self.assertEqual(
                overlap["comparison_window"],
                {
                    "end_inclusive": "2026-07-04T13:00:00Z",
                    "source_entries_in_scope": 1,
                    "source_bucket_keys_in_scope": 1,
                },
            )
            self.assertEqual(
                overlap["post_rollup_source_growth"],
                {
                    "status": "outside_adoption_comparison",
                    "source_entries": 1,
                    "source_bucket_keys": 1,
                    "bucket_keys_missing_from_database": 1,
                },
            )
            self.assertEqual(
                overlap["bucket_keys"],
                {"expected": 1, "matched": 1, "missing": 0},
            )

    def test_issue006_growth_evidence_offers_no_proxy_for_the_cutoff_blind_spot(self):
        """The window can exclude rows the database already holds, and nothing in
        the evidence can tell. Bucket-key overlap is the tempting stand-in and a
        false one: it counts keys pre-cutoff rows already created, and reads zero
        in the very case that matters -- a row the database stored under the wrong
        day, whose recomputed key is therefore absent. A field like that would let
        zero pass for 'no blind spot', so the evidence carries none."""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(
                db_path,
                dated_rows=(("2026-04-21", 1), ("2026-07-04", 17)),
                last_rollup_ts="2026-07-04T13:00:00+00:00",
            )
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                # Appended after the rollup stamped its start time, onto a bucket
                # key the database already carries.
                self.entry(datetime(2026, 7, 4, 14, tzinfo=timezone.utc), 7),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=True,
                )

            growth = result["evidence"]["reconstructible_overlap"][
                "post_rollup_source_growth"
            ]
            self.assertEqual(
                set(growth),
                {
                    "status",
                    "source_entries",
                    "source_bucket_keys",
                    "bucket_keys_missing_from_database",
                },
            )

    def test_issue006_cutoff_still_rejects_missing_pre_rollup_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(
                db_path,
                last_rollup_ts="2026-07-04T13:00:00+00:00",
            )
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                self.entry(
                    datetime(2026, 7, 4, 12, 30, tzinfo=timezone.utc),
                    7,
                    project="pre-cutoff-missing",
                ),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                with self.assertRaisesRegex(
                    rollup.RollupAdoptionError,
                    "recomputed Shanghai overlap has 1 missing bucket key",
                ):
                    rollup.adopt_bucket_timezone(
                        db_path,
                        entries,
                        known_utc_offset="+08:00",
                        raw_log_starts={"codex": "2026-07-04"},
                        authorize_pre_log_assumption=True,
                        authorize_non_exact_overlap_assumption=False,
                    )
            self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))

    def test_issue006_cutoff_must_be_present_and_timezone_aware(self):
        cases = (None, "2026-07-04T13:00:00")
        for last_rollup_ts in cases:
            with self.subTest(last_rollup_ts=last_rollup_ts), tempfile.TemporaryDirectory() as tmp:
                db_path = Path(tmp) / "rollup.db"
                self.seed_unmarked(db_path, last_rollup_ts=last_rollup_ts)
                with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                    with self.assertRaisesRegex(
                        rollup.RollupAdoptionError,
                        "last_rollup_ts",
                    ):
                        rollup.adopt_bucket_timezone(
                            db_path,
                            [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)],
                            known_utc_offset="+08:00",
                            raw_log_starts={"codex": "2026-07-04"},
                            authorize_pre_log_assumption=True,
                            authorize_non_exact_overlap_assumption=False,
                        )
                self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))

    def test_issue006_pre_log_authorization_does_not_authorize_non_exact_overlap(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path, dated_rows=(("2026-04-21", 1), ("2026-07-04", 20)))
            entries = [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                with self.assertRaisesRegex(
                    rollup.RollupAdoptionError,
                    "non-exact overlap requires separate explicit authorization",
                ):
                    rollup.adopt_bucket_timezone(
                        db_path,
                        entries,
                        known_utc_offset="+08:00",
                        raw_log_starts={"codex": "2026-07-04"},
                        authorize_pre_log_assumption=True,
                        authorize_non_exact_overlap_assumption=False,
                    )

            self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone"))
            self.assertIsNone(self.fetch_meta(db_path, "bucket_timezone_adoption"))

    def test_issue006_cost_attribution_is_explicitly_outside_protected_counter_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path)
            with closing(sqlite3.connect(db_path)) as conn, conn:
                conn.execute(
                    "UPDATE daily_rollup SET cost_usd = 42, cost_known_count = 0 "
                    "WHERE date = '2026-07-04'"
                )
            entries = [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=False,
                )

            overlap = result["evidence"]["reconstructible_overlap"]
            self.assertEqual(overlap["protected_counter_verification"]["status"], "verified")
            self.assertEqual(
                overlap["protected_counter_verification"]["equal_bucket_keys"],
                {"expected": 1, "actual": 1},
            )
            self.assertEqual(overlap["cost_attribution_verification"]["status"], "not_verified")

    def test_issue006_cli_help_separates_assumption_scopes_and_cost_boundary(self):
        result = subprocess.run(
            [
                str(Path(__file__).parents[1] / "tt-web"),
                "rollup",
                "adopt-timezone",
                "--help",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        help_text = " ".join(result.stdout.split())
        self.assertIn("authorize only history before each agent's raw-log start", help_text)
        self.assertIn("does not cover in-range counter mismatches", help_text)
        self.assertIn("separately authorize in-range buckets", help_text)
        self.assertIn("cost attribution remains unverified", help_text)

    def test_issue006_adoption_report_text_claims_no_more_than_it_can_back(self):
        """Checks the report strings in the CLI source, not a rendered run.

        The earlier wording told the user post-cutoff records were stale source
        data the next rollup would pick up. Neither half holds: such records can
        already be in the database, and a rollup skips a date that is already
        present but outside its recompute window."""
        source = (Path(__file__).parents[1] / "tt-web").read_text(encoding="utf-8")

        self.assertNotIn("expected stale source data", source)
        self.assertNotIn("the next normal rollup will process it", source)
        self.assertIn("not at a source snapshot", source)
        self.assertIn("their bucketing was not verified here", source)
        self.assertIn("older dates already present need an", source)

    def test_issue006_exact_compensating_adjacent_day_misdating_is_not_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path, dated_rows=(("2026-07-04", 20), ("2026-07-05", 10)))
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                self.entry(datetime(2026, 7, 5, 12, tzinfo=timezone.utc), 20),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=True,
                    now=lambda: datetime(2026, 7, 6, 12, tzinfo=timezone.utc),
                )

            overlap = result["evidence"]["reconstructible_overlap"]
            self.assertEqual(overlap["protected_counter_verification"]["status"], "unverified")
            self.assertEqual(
                overlap["protected_counter_verification"]["equal_bucket_keys"],
                {"expected": 2, "actual": 0},
            )
            self.assertEqual(overlap["non_equal_protected_counter_assumption"]["bucket_keys"], 2)

    def test_issue006_pruning_masked_shift_is_assumed_not_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path, dated_rows=(("2026-07-04", 40), ("2026-07-05", 30)))
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                self.entry(datetime(2026, 7, 5, 12, tzinfo=timezone.utc), 20),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=True,
                    now=lambda: datetime(2026, 7, 6, 12, tzinfo=timezone.utc),
                )

            overlap = result["evidence"]["reconstructible_overlap"]
            self.assertEqual(overlap["protected_counter_verification"]["status"], "unverified")
            self.assertEqual(
                overlap["protected_counter_verification"]["equal_bucket_keys"],
                {"expected": 2, "actual": 0},
            )
            self.assertEqual(
                overlap["non_equal_protected_counter_assumption"]["status"],
                "user_authorized_overlap_assumption",
            )
            self.assertEqual(overlap["non_equal_protected_counter_assumption"]["bucket_keys"], 2)

    def test_issue006_current_growth_masked_shift_is_assumed_not_verified(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self.seed_unmarked(db_path, dated_rows=(("2026-07-04", 20), ("2026-07-05", 10)))
            entries = [
                self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10),
                self.entry(datetime(2026, 7, 5, 12, tzinfo=timezone.utc), 30),
            ]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", db_path):
                result = rollup.adopt_bucket_timezone(
                    db_path,
                    entries,
                    known_utc_offset="+08:00",
                    raw_log_starts={"codex": "2026-07-04"},
                    authorize_pre_log_assumption=True,
                    authorize_non_exact_overlap_assumption=True,
                    now=lambda: datetime(2026, 7, 5, 12, tzinfo=timezone.utc),
                )

            overlap = result["evidence"]["reconstructible_overlap"]
            self.assertEqual(overlap["protected_counter_verification"]["status"], "unverified")
            self.assertEqual(
                overlap["protected_counter_verification"]["equal_bucket_keys"],
                {"expected": 2, "actual": 0},
            )
            self.assertEqual(
                overlap["non_equal_protected_counter_assumption"]["status"],
                "user_authorized_overlap_assumption",
            )
            self.assertEqual(overlap["non_equal_protected_counter_assumption"]["bucket_keys"], 2)

    def test_issue006_adoption_binds_current_host_source_to_canonical_db_and_all_agents(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            canonical_db = tmp_path / "canonical" / "rollup.db"
            other_db = tmp_path / "other" / "rollup.db"
            canonical_db.parent.mkdir()
            other_db.parent.mkdir()
            self.seed_unmarked(canonical_db)
            self.seed_unmarked(other_db)
            entries = [self.entry(datetime(2026, 7, 4, 12, tzinfo=timezone.utc), 10)]

            with mock.patch.object(rollup, "DEFAULT_DB_PATH", canonical_db):
                with self.assertRaisesRegex(rollup.RollupAdoptionError, "canonical"):
                    rollup.adopt_bucket_timezone(
                        other_db,
                        entries,
                        known_utc_offset="+08:00",
                        raw_log_starts={"codex": "2026-07-04"},
                        authorize_pre_log_assumption=True,
                        authorize_non_exact_overlap_assumption=False,
                    )

            with closing(sqlite3.connect(canonical_db)) as conn, conn:
                conn.execute(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model, input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens, cost_usd,
                      cost_known_count, entry_count, message_count
                    ) VALUES ('2026-07-04', 'claude-code', 'repo', 'gpt-5', 10, 0, 0, 0, 0, 1, 1, 1)
                    """
                )
            with mock.patch.object(rollup, "DEFAULT_DB_PATH", canonical_db):
                with self.assertRaisesRegex(rollup.RollupAdoptionError, "every database agent"):
                    rollup.adopt_bucket_timezone(
                        canonical_db,
                        entries,
                        known_utc_offset="+08:00",
                        raw_log_starts={"codex": "2026-07-04"},
                        authorize_pre_log_assumption=True,
                        authorize_non_exact_overlap_assumption=False,
                    )
            self.assertIsNone(self.fetch_meta(canonical_db, "bucket_timezone"))

    @staticmethod
    def seed_unmarked(
        path,
        dated_rows=(("2026-04-21", 1), ("2026-07-04", 10)),
        last_rollup_ts="2026-07-06T00:00:00+00:00",
    ):
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.executescript(rollup.SCHEMA)
            if last_rollup_ts is not None:
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) VALUES ('last_rollup_ts', ?)",
                    (last_rollup_ts,),
                )
            conn.executemany(
                """
                INSERT INTO daily_rollup (
                  date, agent_id, project, model, input_tokens, output_tokens,
                  cache_creation_tokens, cache_read_tokens, cost_usd,
                  cost_known_count, entry_count, message_count
                ) VALUES (?, 'codex', 'repo', 'gpt-5', ?, 0, 0, 0, 0, 1, 1, 1)
                """,
                dated_rows,
            )
        Path(str(path) + ".lock").touch(mode=0o600)

    @staticmethod
    def entry(timestamp, input_tokens, project="repo", agent_id="codex"):
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
            project=project,
            agent_id=agent_id,
            message_count=1,
        )

    @staticmethod
    def fetch_meta(path, key):
        with closing(sqlite3.connect(path)) as conn:
            row = conn.execute("SELECT value FROM rollup_meta WHERE key = ?", (key,)).fetchone()
            return row[0] if row else None


if __name__ == "__main__":
    unittest.main()
