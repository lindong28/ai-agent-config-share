import contextlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import aggregators
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

    def test_partial_source_loss_preserves_other_projects(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(ts, "a-1", "repo-a", "gpt-5", "codex", 5.0, 50, 5, 4, 3, 2),
                    self.entry(ts, "b-1", "repo-b", "gpt-5", "codex", 1.0, 10, 1, 0, 0, 1),
                ],
                now=lambda: now,
            )
            prior_repo_a = {
                row["project"]: row
                for row in self.fetch_daily_rows(db_path)
            }["repo-a"]

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(ts, "b-2", "repo-b", "gpt-5", "codex", 2.0, 20, 2, 0, 0, 2),
                ],
                now=lambda: now,
            )

            rows = {row["project"]: row for row in self.fetch_daily_rows(db_path)}
            self.assertIn("repo-a", rows)
            self.assertEqual(rows["repo-a"], prior_repo_a)
            self.assertEqual(
                {
                    field: rows["repo-b"][field]
                    for field in self.protected_fields()
                },
                {
                    "input_tokens": 20,
                    "output_tokens": 2,
                    "cache_creation_tokens": 0,
                    "cache_read_tokens": 0,
                    "entry_count": 1,
                    "message_count": 2,
                },
            )
            self.assertAlmostEqual(rows["repo-b"]["cost_usd"], 2.0)

    def test_path_to_remote_reclassification_does_not_double_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            identity_db = Path(tmp) / "project-identity.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            source_path = "/old/path"
            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db, create=True):
                first_project = self.identify_project(source_path, returncode=1, stdout="")
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "same-session", first_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )

                second_project = self.identify_project(
                    source_path,
                    returncode=0,
                    stdout="git@github.com:org/repo.git\n",
                )
                result = rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "same-session", second_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual([(row["project"], row["input_tokens"]) for row in rows], [(source_path, 100)])
            self.assertEqual(sum(row["input_tokens"] for row in rows), 100)
            self.assertEqual(result["buckets_written"], 1)
            self.assertEqual(result["buckets_skipped"], 0)
            self.assertEqual(result["skipped_keys"], [])
            self.assertEqual(second_project, source_path)

    def test_remote_to_path_reclassification_does_not_double_count(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            identity_db = Path(tmp) / "project-identity.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            source_path = "/old/path"
            remote = "github.com/org/repo"
            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db, create=True):
                first_project = self.identify_project(
                    source_path,
                    returncode=0,
                    stdout="git@github.com:org/repo.git\n",
                )
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "same-session", first_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )

                second_project = self.identify_project(source_path, returncode=1, stdout="")
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "same-session", second_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual([(row["project"], row["input_tokens"]) for row in rows], [(remote, 100)])
            self.assertEqual(sum(row["input_tokens"] for row in rows), 100)

    def test_vanished_source_preserves_row_and_project_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            identity_db = Path(tmp) / "project-identity.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            source_path = "/old/path"
            remote = "github.com/org/repo"
            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db, create=True):
                project = self.identify_project(
                    source_path,
                    returncode=0,
                    stdout="git@github.com:org/repo.git\n",
                )
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "same-session", project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )
                before = self.fetch_daily_rows(db_path)

                rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
                after = self.fetch_daily_rows(db_path)
                project_during_failure = self.identify_project(source_path, returncode=1, stdout="")

            self.assertEqual(after, before)
            self.assertEqual(sum(row["input_tokens"] for row in after), 100)
            self.assertEqual(project_during_failure, remote)

    def test_genuinely_new_project_gets_own_stable_row(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            identity_db = Path(tmp) / "project-identity.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            first_path = "/work/first"
            second_path = "/work/second"
            first_remote = "github.com/org/first"
            second_remote = "github.com/org/second"
            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db, create=True):
                first_project = self.identify_project(
                    first_path,
                    returncode=0,
                    stdout="git@github.com:org/first.git\n",
                )
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "first-session", first_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1)
                    ],
                    now=lambda: now,
                )

                second_project = self.identify_project(
                    second_path,
                    returncode=0,
                    stdout="git@github.com:org/second.git\n",
                )
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "first-session", first_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1),
                        self.entry(now, "second-session", second_project, "gpt-5", "codex", 1.0, 50, 0, 0, 0, 1),
                    ],
                    now=lambda: now,
                )

                second_project_after_failure = self.identify_project(second_path, returncode=1, stdout="")
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: [
                        self.entry(now, "first-session", first_project, "gpt-5", "codex", 1.0, 100, 0, 0, 0, 1),
                        self.entry(
                            now,
                            "second-session",
                            second_project_after_failure,
                            "gpt-5",
                            "codex",
                            1.0,
                            50,
                            0,
                            0,
                            0,
                            1,
                        ),
                    ],
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(db_path)
            self.assertEqual(
                {(row["project"], row["input_tokens"]) for row in rows},
                {(first_remote, 100), (second_remote, 50)},
            )
            self.assertEqual(sum(row["input_tokens"] for row in rows), 150)

    def test_load_all_entries_path_to_remote_preserves_exact_sum(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            source = root / "path-project"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(source)
            self.write_codex_session(sessions / "session.jsonl", source, "same-session", 100)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            with self.production_loader(sessions, state / "project_identity.db"):
                with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", state / "legacy-identity.db"):
                    first = rollup.run(
                        db_path=state / "rollup.db",
                        entries_loader=aggregators.load_all_entries,
                        now=lambda: now,
                    )
                self.set_git_remote(source, "git@github.com:org/repo.git")
                self.reset_loader_process_state()
                second = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(state / "rollup.db")
            self.assertEqual(first["sources_blocked"], 0)
            self.assertEqual(second["sources_blocked"], 0)
            self.assertEqual(second["blocked_sources"], [])
            self.assertEqual([(row["project"], row["input_tokens"]) for row in rows], [(str(source), 100)])
            self.assertEqual(sum(row["input_tokens"] for row in rows), 100)

    def test_load_all_entries_remote_to_missing_path_blocks_only_that_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            missing_source = root / "missing-project"
            stable_source = root / "stable-project"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(missing_source, "git@github.com:org/missing.git")
            self.init_git_repo(stable_source, "git@github.com:org/stable.git")
            self.write_codex_session(sessions / "00-missing.jsonl", missing_source, "missing-session", 100)
            self.write_codex_session(sessions / "99-stable.jsonl", stable_source, "stable-session", 10)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            with self.production_loader(sessions, state / "project_identity.db"):
                with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", state / "legacy-identity.db"):
                    rollup.run(
                        db_path=state / "rollup.db",
                        entries_loader=aggregators.load_all_entries,
                        now=lambda: now,
                    )
                self.remove_tree(missing_source)
                self.write_codex_session(sessions / "99-stable.jsonl", stable_source, "stable-session", 20)
                self.reset_loader_process_state()
                result = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(state / "rollup.db")
            self.assertEqual(
                [(row["project"], row["input_tokens"]) for row in rows],
                [("github.com/org/missing", 100), ("github.com/org/stable", 20)],
            )
            self.assertEqual(sum(row["input_tokens"] for row in rows), 120)
            self.assertEqual(result["sources_blocked"], 1)
            self.assertEqual(result["blocked_sources"][0]["source_path"], str(missing_source))
            self.assertEqual(result["blocked_sources"][0]["reason"], "source_unavailable")

    def test_load_all_entries_remote_change_blocks_path_and_collects_other_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            changed_source = root / "changed-project"
            stable_source = root / "stable-project"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(changed_source, "git@github.com:org/old-name.git")
            self.init_git_repo(stable_source, "git@github.com:org/stable.git")
            self.write_codex_session(sessions / "00-changed.jsonl", changed_source, "changed-session", 100)
            self.write_codex_session(sessions / "99-stable.jsonl", stable_source, "stable-session", 10)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            with self.production_loader(sessions, state / "project_identity.db"):
                with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", state / "legacy-identity.db"):
                    rollup.run(
                        db_path=state / "rollup.db",
                        entries_loader=aggregators.load_all_entries,
                        now=lambda: now,
                    )
                self.set_git_remote(changed_source, "git@github.com:org/new-name.git")
                self.write_codex_session(sessions / "99-stable.jsonl", stable_source, "stable-session", 20)
                self.reset_loader_process_state()
                result = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )
                self.reset_loader_process_state()
                repeated = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(state / "rollup.db")
            self.assertEqual(
                [(row["project"], row["input_tokens"]) for row in rows],
                [("github.com/org/old-name", 100), ("github.com/org/stable", 20)],
            )
            self.assertEqual(sum(row["input_tokens"] for row in rows), 120)
            self.assertNotIn("github.com/org/new-name", {row["project"] for row in rows})
            self.assertEqual(result["sources_blocked"], 1)
            self.assertEqual(result["blocked_sources"][0]["source_path"], str(changed_source))
            self.assertEqual(result["blocked_sources"][0]["reason"], "unreconciled_remote")
            self.assertEqual(
                result["blocked_sources"][0]["pin_candidate"],
                "github.com/org/old-name",
            )
            self.assertEqual(repeated["blocked_sources"][0]["source_path"], str(changed_source))
            self.assertEqual(repeated["blocked_sources"][0]["reason"], "unreconciled_remote")
            self.assertEqual(
                repeated["blocked_sources"][0]["first_seen"],
                result["blocked_sources"][0]["first_seen"],
            )
            self.assertGreaterEqual(
                repeated["blocked_sources"][0]["last_seen"],
                result["blocked_sources"][0]["last_seen"],
            )
            self.assertEqual(repeated["blocked_sources"][0]["status"], "active")
            with sqlite3.connect(state / "project_identity.db") as conn:
                stored_paths = {
                    row[0] for row in conn.execute("SELECT source_path FROM project_identity")
                }
            self.assertNotIn(str(changed_source), stored_paths)

    def test_persisted_blocker_survives_restart_and_source_log_disappearance(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            changed_source = root / "changed-project"
            stable_source = root / "stable-project"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(changed_source, "git@github.com:org/old-name.git")
            self.init_git_repo(stable_source, "git@github.com:org/stable.git")
            changed_log = sessions / "00-changed.jsonl"
            stable_log = sessions / "99-stable.jsonl"
            self.write_codex_session(changed_log, changed_source, "changed-session", 100)
            self.write_codex_session(stable_log, stable_source, "stable-session", 10)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            with self.production_loader(sessions, state / "project_identity.db"):
                with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", state / "legacy-identity.db"):
                    rollup.run(
                        db_path=state / "rollup.db",
                        entries_loader=aggregators.load_all_entries,
                        now=lambda: now,
                    )
                self.set_git_remote(changed_source, "git@github.com:org/new-name.git")
                self.write_codex_session(stable_log, stable_source, "stable-session", 20)
                self.reset_loader_process_state()
                blocked = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )

                changed_log.unlink()
                self.write_codex_session(stable_log, stable_source, "stable-session", 30)
                self.reset_loader_process_state()
                after_restart = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )
                process_probe = subprocess.run(
                    [
                        sys.executable,
                        "-c",
                        (
                            "import json, sys; from pathlib import Path; import aggregators; "
                            "aggregators.PROJECT_IDENTITY_DB = Path(sys.argv[1]); "
                            "print(json.dumps(aggregators.list_project_identity_blockers()))"
                        ),
                        str(state / "project_identity.db"),
                    ],
                    cwd=Path(__file__).resolve().parents[1],
                    capture_output=True,
                    text=True,
                    check=True,
                )

            rows = self.fetch_daily_rows(state / "rollup.db")
            self.assertEqual(
                [(row["project"], row["input_tokens"]) for row in rows],
                [("github.com/org/old-name", 100), ("github.com/org/stable", 30)],
            )
            self.assertEqual(sum(row["input_tokens"] for row in rows), 130)
            self.assertEqual(blocked["sources_blocked"], 1)
            self.assertEqual(after_restart["sources_blocked"], 1)
            persisted = after_restart["blocked_sources"][0]
            self.assertEqual(persisted["source_path"], str(changed_source))
            self.assertEqual(persisted["reason"], "unreconciled_remote")
            self.assertEqual(persisted["resolved_candidate"], "github.com/org/new-name")
            self.assertEqual(persisted["status"], "active")
            self.assertTrue(persisted["first_seen"])
            self.assertTrue(persisted["last_seen"])
            self.assertEqual(json.loads(process_probe.stdout), after_restart["blocked_sources"])

    def test_load_all_entries_new_no_remote_project_does_not_abort_other_projects(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            stable_source = root / "stable-project"
            new_source = root / "new-no-remote"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(stable_source, "git@github.com:org/stable.git")
            self.init_git_repo(new_source)
            self.write_codex_session(sessions / "00-stable.jsonl", stable_source, "stable-session", 10)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

            with self.production_loader(sessions, state / "project_identity.db"):
                rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )
                self.write_codex_session(sessions / "00-stable.jsonl", stable_source, "stable-session", 20)
                self.write_codex_session(sessions / "99-new.jsonl", new_source, "new-session", 50)
                self.reset_loader_process_state()
                result = rollup.run(
                    db_path=state / "rollup.db",
                    entries_loader=aggregators.load_all_entries,
                    now=lambda: now,
                )

            rows = self.fetch_daily_rows(state / "rollup.db")
            self.assertEqual(
                [(row["project"], row["input_tokens"]) for row in rows],
                [(str(new_source), 50), ("github.com/org/stable", 20)],
            )
            self.assertEqual(sum(row["input_tokens"] for row in rows), 70)
            self.assertEqual(result["sources_blocked"], 0)
            self.assertEqual(result["blocked_sources"], [])

    def test_protected_field_shrink_is_skipped(self):
        now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
        ts = now - timedelta(days=1)
        base = self.entry(ts, "base", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 5)
        cases = {
            "input_tokens": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 9, 8, 4, 6, 5)],
            "output_tokens": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 10, 7, 4, 6, 5)],
            "cache_read_tokens": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 3, 6, 5)],
            "cache_creation_tokens": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 5, 5)],
            "message_count": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 4)],
            "entry_count": [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
        }
        initial_entries = {
            name: [base]
            for name in cases
        }
        initial_entries["entry_count"] = [
            self.entry(ts, "base-1", "repo-a", "gpt-5", "codex", 2.5, 5, 4, 2, 3, 1),
            self.entry(ts, "base-2", "repo-a", "gpt-5", "codex", 2.5, 5, 4, 2, 3, 1),
        ]

        for field, shrunk_entries in cases.items():
            with self.subTest(field=field), tempfile.TemporaryDirectory() as tmp:
                db_path = Path(tmp) / "rollup.db"
                rollup.run(db_path=db_path, entries_loader=lambda values=initial_entries[field]: values, now=lambda: now)
                before = self.fetch_daily_rows(db_path)[0]

                result = rollup.run(
                    db_path=db_path,
                    entries_loader=lambda values=shrunk_entries: values,
                    now=lambda: now,
                )

                self.assertEqual(self.fetch_daily_rows(db_path)[0], before)
                self.assertEqual(result["buckets_skipped"], 1)
                self.assertEqual(
                    result["skipped_keys"],
                    [(ts.astimezone().date().isoformat(), "codex", "repo-a", "gpt-5")],
                )

    def test_cost_only_decline_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "old", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 2.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            row = self.fetch_daily_rows(db_path)[0]
            self.assertEqual(
                {field: row[field] for field in self.protected_fields()},
                {
                    "input_tokens": 10,
                    "output_tokens": 8,
                    "cache_creation_tokens": 6,
                    "cache_read_tokens": 4,
                    "entry_count": 1,
                    "message_count": 2,
                },
            )
            self.assertAlmostEqual(row["cost_usd"], 2.0)

    def test_cost_only_decline_reports_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "old", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            result = rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 2.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            self.assertEqual(result.get("buckets_skipped"), 0)
            self.assertEqual(result.get("skipped_keys"), [])

    def test_cost_decline_with_token_shrink_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "old", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )
            before = self.fetch_daily_rows(db_path)[0]

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 2.0, 9, 8, 4, 6, 2)],
                now=lambda: now,
            )

            self.assertEqual(self.fetch_daily_rows(db_path)[0], before)

    def test_growth_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "old", "repo-a", "gpt-5", "codex", 1.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "new", "repo-a", "gpt-5", "codex", 3.0, 20, 16, 8, 12, 4)],
                now=lambda: now,
            )

            row = self.fetch_daily_rows(db_path)[0]
            self.assertEqual(
                {field: row[field] for field in self.protected_fields()},
                {
                    "input_tokens": 20,
                    "output_tokens": 16,
                    "cache_creation_tokens": 12,
                    "cache_read_tokens": 8,
                    "entry_count": 1,
                    "message_count": 4,
                },
            )
            self.assertAlmostEqual(row["cost_usd"], 3.0)

    def test_known_to_unknown_cost_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "known", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "unknown", "repo-a", "gpt-5", "codex", None, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            row = self.fetch_daily_rows(db_path)[0]
            self.assertEqual(
                {field: row[field] for field in self.protected_fields()},
                {
                    "input_tokens": 10,
                    "output_tokens": 8,
                    "cache_creation_tokens": 6,
                    "cache_read_tokens": 4,
                    "entry_count": 1,
                    "message_count": 2,
                },
            )
            self.assertEqual(row["cost_known_count"], 0)
            self.assertAlmostEqual(row["cost_usd"], 0.0)

    def test_known_to_unknown_cost_reports_not_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "known", "repo-a", "gpt-5", "codex", 5.0, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            result = rollup.run(
                db_path=db_path,
                entries_loader=lambda: [self.entry(ts, "unknown", "repo-a", "gpt-5", "codex", None, 10, 8, 4, 6, 2)],
                now=lambda: now,
            )

            self.assertEqual(result.get("buckets_skipped"), 0)
            self.assertEqual(result.get("skipped_keys"), [])

    def test_skipped_key_does_not_block_sibling_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            day_one = now - timedelta(days=1)
            day_two = now - timedelta(days=2)
            rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(day_one, "a-old", "repo-a", "gpt-5", "codex", 5.0, 50, 5, 0, 0, 1),
                    self.entry(day_one, "b-old", "repo-b", "gpt-5", "codex", 1.0, 10, 1, 0, 0, 1),
                    self.entry(day_two, "c-old", "repo-c", "gpt-5", "codex", 1.0, 10, 1, 0, 0, 1),
                ],
                now=lambda: now,
            )

            result = rollup.run(
                db_path=db_path,
                entries_loader=lambda: [
                    self.entry(day_one, "a-new", "repo-a", "gpt-5", "codex", 2.0, 20, 2, 0, 0, 1),
                    self.entry(day_one, "b-new", "repo-b", "gpt-5", "codex", 2.0, 20, 2, 0, 0, 2),
                    self.entry(day_two, "c-new", "repo-c", "gpt-5", "codex", 3.0, 30, 3, 0, 0, 3),
                ],
                now=lambda: now,
            )

            rows = {(row["date"], row["project"]): row for row in self.fetch_daily_rows(db_path)}
            self.assertEqual(rows[(day_one.astimezone().date().isoformat(), "repo-a")]["input_tokens"], 50)
            self.assertEqual(rows[(day_one.astimezone().date().isoformat(), "repo-b")]["input_tokens"], 20)
            self.assertEqual(rows[(day_two.astimezone().date().isoformat(), "repo-c")]["input_tokens"], 30)
            self.assertEqual(result["buckets_skipped"], 1)

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
    def protected_fields():
        return (
            "input_tokens",
            "output_tokens",
            "cache_creation_tokens",
            "cache_read_tokens",
            "entry_count",
            "message_count",
        )

    @staticmethod
    def identify_project(path, returncode, stdout):
        completed = mock.Mock(returncode=returncode, stdout=stdout, stderr="git resolution failed")
        with mock.patch("aggregators.subprocess.run", return_value=completed):
            return aggregators.identify_project(path, {})

    @staticmethod
    @contextlib.contextmanager
    def production_loader(sessions_dir, identity_db):
        prior_usage_cache = aggregators._GLOBAL_USAGE_CACHE
        prior_project_cache = aggregators._PROJECT_CACHE
        try:
            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db), mock.patch.object(
                aggregators.codex, "SESSIONS_DIR", str(sessions_dir)
            ), mock.patch.object(
                aggregators.codex, "STATE_DB", str(Path(sessions_dir).parent / "missing-state.sqlite")
            ), mock.patch.object(
                aggregators.claude, "_get_claude_dirs", return_value=[]
            ), mock.patch.dict(
                aggregators.os.environ, {"TT_WEB_EXTRA_JSONL": ""}, clear=False
            ), mock.patch(
                "pricing_fetcher.get_pricing", return_value={}
            ), mock.patch(
                "pricing_fetcher.calculate_cost", return_value=1.0
            ):
                RollupTests.reset_loader_process_state()
                yield
        finally:
            aggregators._GLOBAL_USAGE_CACHE = prior_usage_cache
            aggregators._PROJECT_CACHE = prior_project_cache

    @staticmethod
    def reset_loader_process_state():
        aggregators._GLOBAL_USAGE_CACHE = None
        aggregators._PROJECT_CACHE = {}

    @staticmethod
    def init_git_repo(path, remote=None):
        path.mkdir()
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        if remote:
            subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)

    @staticmethod
    def set_git_remote(path, remote):
        result = subprocess.run(
            ["git", "-C", str(path), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
        )
        command = "set-url" if result.returncode == 0 else "add"
        subprocess.run(["git", "-C", str(path), "remote", command, "origin", remote], check=True)

    @staticmethod
    def write_codex_session(path, cwd, session_id, input_tokens):
        rows = [
            {
                "timestamp": "2026-06-13T12:00:00.000Z",
                "type": "session_meta",
                "payload": {
                    "id": session_id,
                    "timestamp": "2026-06-13T12:00:00.000Z",
                    "cwd": str(cwd),
                    "model": "gpt-5",
                },
            },
            {
                "timestamp": "2026-06-13T12:01:00.000Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": input_tokens,
                            "cached_input_tokens": 0,
                            "output_tokens": 0,
                            "reasoning_output_tokens": 0,
                        }
                    },
                },
            },
        ]
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")

    @staticmethod
    def remove_tree(path):
        shutil.rmtree(path)

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
