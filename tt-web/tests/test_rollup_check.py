import contextlib
import errno
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import aggregators
import pricing_fetcher
import rollup
from parsers import UsageEntry


class RollupCheckTests(unittest.TestCase):
    def test_check_reports_expected_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            initial = [
                self.entry(ts, "orphan", "repo-orphan", 50, 5.0),
                self.entry(ts, "shrink", "repo-shrink", 100, 10.0),
                self.entry(ts, "growth", "repo-growth", 10, 1.0),
                self.entry(ts, "cost", "repo-cost", 30, 5.0),
                self.entry(ts, "same", "repo-same", 40, 4.0),
            ]
            current = [
                self.entry(ts, "shrink", "repo-shrink", 90, 9.0),
                self.entry(ts, "growth", "repo-growth", 20, 2.0),
                self.entry(ts, "cost", "repo-cost", 30, 2.0),
                self.entry(ts, "same", "repo-same", 40, 4.0),
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: initial, now=lambda: now)

            result = rollup._check_rollup(
                db_path,
                lambda: current,
                now=lambda: now,
            )

            day = ts.date().isoformat()
            self.assertEqual(
                result["db_span"],
                {"start": day, "end": day, "rows": 5},
            )
            self.assertEqual(
                result["window"],
                {"start": "2026-05-17", "end": "2026-06-13", "days": 28},
            )
            self.assertEqual(result["orphan_rows"]["count"], 1)
            self.assertEqual(
                [item["key"] for item in result["orphan_rows"]["items"]],
                [[day, "codex", "repo-orphan", "gpt-5"]],
            )
            self.assertEqual(result["would_skip"]["count"], 1)
            self.assertEqual(
                [item["key"] for item in result["would_skip"]["items"]],
                [[day, "codex", "repo-shrink", "gpt-5"]],
            )
            self.assertEqual(
                result["would_skip"]["items"][0]["decreased_fields"],
                ["input_tokens"],
            )
            self.assertEqual(result["would_skip"]["items"][0]["old"]["input_tokens"], 100)
            self.assertEqual(result["would_skip"]["items"][0]["new"]["input_tokens"], 90)
            self.assertEqual(result["would_write"]["count"], 2)
            self.assertEqual(
                {tuple(item["key"]) for item in result["would_write"]["items"]},
                {
                    (day, "codex", "repo-growth", "gpt-5"),
                    (day, "codex", "repo-cost", "gpt-5"),
                },
            )
            reasons = {
                item["key"][2]: item["reason"]
                for item in result["would_write"]["items"]
            }
            self.assertEqual(reasons, {"repo-cost": "changed", "repo-growth": "changed"})
            reported_keys = {
                tuple(item["key"])
                for section in ("orphan_rows", "would_skip", "would_write")
                for item in result[section]["items"]
            }
            self.assertNotIn((day, "codex", "repo-same", "gpt-5"), reported_keys)
            self.assertEqual(result["verdict"], "attention")

    def test_check_is_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            missing = root / "missing" / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            missing_before = self.tree_snapshot(root)

            missing_result = rollup._check_rollup(missing, list, now=lambda: now)

            self.assertEqual(self.tree_snapshot(root), missing_before)
            self.assertEqual(missing_result["db_span"], {"start": None, "end": None, "rows": 0})
            self.assertEqual(missing_result["status"], "indeterminate")
            self.assertEqual(missing_result["verdict"], "unknown")

            db_path = root / "existing" / "rollup.db"
            entries = [self.entry(now - timedelta(days=1), "same", "repo", 10, 1.0)]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)
            before = self.tree_snapshot(root)

            result = rollup._check_rollup(db_path, lambda: entries, now=lambda: now)

            self.assertEqual(self.tree_snapshot(root), before)
            self.assertEqual(result["status"], "safe")

    def test_check_error_paths_preserve_the_full_directory_tree(self):
        now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
        with self.subTest("corrupt database without a lock"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                state = root / "state"
                state.mkdir()
                db_path = state / "rollup.db"
                db_path.write_bytes(b"not a sqlite database")
                before = self.tree_snapshot(root)

                result = rollup._check_rollup(db_path, list, now=lambda: now)

                self.assertEqual(self.tree_snapshot(root), before)
                self.assertEqual(result["status"], "indeterminate")
                self.assertEqual(result["verdict"], "unknown")

        with self.subTest("source loader failure with an existing lock"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                db_path = root / "state" / "rollup.db"
                rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
                before = self.tree_snapshot(root)

                def fail_loader():
                    raise PermissionError("source is unreadable")

                result = rollup._check_rollup(db_path, fail_loader, now=lambda: now)

                self.assertEqual(self.tree_snapshot(root), before)
                self.assertEqual(result["status"], "indeterminate")
                self.assertEqual(result["verdict"], "unknown")
                self.assertFalse(result["scan_complete"])
                self.assertEqual(result["source_errors"][0]["stage"], "load")

        with self.subTest("uncheckpointed WAL cannot be read without side effects"):
            with tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                db_path = root / "state" / "rollup.db"
                initial = [self.entry(now, "initial", "repo", 10, 1.0)]
                current = [self.entry(now, "current", "repo", 20, 2.0)]
                rollup.run(db_path=db_path, entries_loader=lambda: initial, now=lambda: now)
                reader = sqlite3.connect(db_path)
                try:
                    reader.execute("BEGIN")
                    reader.execute("SELECT COUNT(*) FROM daily_rollup").fetchone()
                    rollup.run(db_path=db_path, entries_loader=lambda: current, now=lambda: now)
                    self.assertTrue(Path(str(db_path) + "-wal").exists())
                    before = self.tree_snapshot(root)

                    result = rollup._check_rollup(db_path, lambda: current, now=lambda: now)

                    self.assertEqual(self.tree_snapshot(root), before)
                    self.assertEqual(result["status"], "indeterminate")
                    self.assertEqual(result["db_state"], "unreadable")
                    self.assertEqual(result["diagnostic_errors"][0]["stage"], "database")
                finally:
                    reader.close()

    def test_check_missing_table_is_indeterminate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            db_path = root / "state" / "rollup.db"
            db_path.parent.mkdir()
            with sqlite3.connect(db_path) as conn:
                conn.execute("CREATE TABLE unrelated (value TEXT)")
            db_path.with_suffix(".db.lock").touch()
            before = self.tree_snapshot(root)

            result = rollup._check_rollup(
                db_path,
                list,
                now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            )

            self.assertEqual(self.tree_snapshot(root), before)
            self.assertEqual(result["db_state"], "not_initialised")
            self.assertEqual(result["status"], "indeterminate")
            self.assertEqual(result["verdict"], "unknown")

    def test_check_serializes_with_writer(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            entries = [self.entry(now, "same", "repo", 10, 1.0)]
            rollup.run(db_path=db_path, entries_loader=lambda: entries, now=lambda: now)

            loader_entered = threading.Event()
            checker_done = threading.Event()

            def run_checker_waiting_for_writer():
                rollup._check_rollup(
                    db_path,
                    lambda: loader_entered.set() or entries,
                    now=lambda: now,
                )
                checker_done.set()

            with rollup.rollup_lock(db_path):
                checker = threading.Thread(target=run_checker_waiting_for_writer)
                checker.start()
                self.assertFalse(loader_entered.wait(0.2))
                self.assertFalse(checker_done.is_set())
            checker.join(3)
            self.assertFalse(checker.is_alive())
            self.assertTrue(loader_entered.is_set())
            self.assertTrue(checker_done.is_set())

            checker_holds_lock = threading.Event()
            release_checker = threading.Event()
            observed = []

            def load_while_holding_check_lock():
                checker_holds_lock.set()
                if not release_checker.wait(3):
                    raise TimeoutError("test did not release checker")
                return entries

            def run_holding_checker():
                try:
                    rollup._check_rollup(
                        db_path,
                        load_while_holding_check_lock,
                        now=lambda: now,
                    )
                except Exception as exc:
                    observed.append(exc)

            checker = threading.Thread(target=run_holding_checker)
            checker.start()
            self.assertTrue(checker_holds_lock.wait(2))
            self.assertIsNone(
                rollup.run(
                    db_path=db_path,
                    entries_loader=lambda: entries,
                    now=lambda: now,
                    blocking=False,
                )
            )
            release_checker.set()
            checker.join(3)
            self.assertFalse(checker.is_alive())
            self.assertEqual(observed, [])

    def test_check_reports_persisted_and_fresh_identity_blockers(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            persisted_source = root / "persisted-source"
            fresh_source = root / "fresh-source"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(fresh_source, "git@github.com:org/new-name.git")
            self.write_codex_session(sessions / "fresh.jsonl", fresh_source, "fresh", 25)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"
            historical = [
                self.entry(now, "old-a", "github.com/org/old-a", 100, 1.0),
                self.entry(now, "old-b", "github.com/org/old-b", 200, 2.0),
            ]

            with self.production_loader(sessions, identity_db) as get_pricing:
                rollup.run(db_path=db_path, entries_loader=lambda: historical, now=lambda: now)
                aggregators._record_project_identity_blocker(
                    aggregators.ProjectIdentityUnavailable(
                        "persisted source is unavailable",
                        source_path=str(persisted_source),
                        reason="source_unavailable",
                        pin_candidate="github.com/org/old-a",
                    )
                )
                identity_before = self.db_snapshot(identity_db)

                result = rollup._check_rollup(
                    db_path,
                    lambda: aggregators.load_all_entries(read_only=True, diagnostic=True),
                    now=lambda: now,
                )

                get_pricing.assert_called_with(persist=False)
                self.assertEqual(self.db_snapshot(identity_db), identity_before)
                persisted_after = aggregators.list_project_identity_blockers()
                self.assertEqual(
                    [row["source_path"] for row in persisted_after],
                    [str(persisted_source)],
                )
                self.assertIsNone(aggregators._stored_project_identity(str(fresh_source)))

            self.assertEqual(result["sources_blocked"], 2)
            blockers = {item["source_path"]: item for item in result["blocked_sources"]}
            self.assertEqual(set(blockers), {str(persisted_source), str(fresh_source)})
            self.assertEqual(blockers[str(persisted_source)]["reason"], "source_unavailable")
            self.assertTrue(blockers[str(persisted_source)]["first_seen"])
            self.assertEqual(blockers[str(fresh_source)]["reason"], "unreconciled_remote")
            self.assertEqual(blockers[str(fresh_source)]["resolved_candidate"], "github.com/org/new-name")
            self.assertIsNone(blockers[str(fresh_source)]["first_seen"])
            self.assertEqual(result["status"], "attention")
            self.assertEqual(
                [item["source_path"] for item in result["persisted_blockers"]],
                [str(persisted_source)],
            )
            self.assertEqual(
                [item["source_path"] for item in result["current_blockers"]],
                [str(fresh_source)],
            )

    def test_check_reports_persisted_and_current_blocker_for_the_same_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            source = root / "source"
            state.mkdir()
            sessions.mkdir()
            self.init_git_repo(source, "git@github.com:org/new-name.git")
            self.write_codex_session(sessions / "source.jsonl", source, "source", 25)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"
            historical = [
                self.entry(now, "old-a", "github.com/org/old-a", 100, 1.0),
                self.entry(now, "old-b", "github.com/org/old-b", 200, 2.0),
            ]

            with self.production_loader(sessions, identity_db):
                rollup.run(db_path=db_path, entries_loader=lambda: historical, now=lambda: now)
                aggregators._record_project_identity_blocker(
                    aggregators.ProjectIdentityUnavailable(
                        "source was unavailable",
                        source_path=str(source),
                        reason="source_unavailable",
                        pin_candidate="github.com/org/old-a",
                    )
                )
                identity_before = self.tree_snapshot(state)

                result = rollup._check_rollup(
                    db_path,
                    lambda: aggregators.load_all_entries(read_only=True, diagnostic=True),
                    now=lambda: now,
                )

                self.assertEqual(self.tree_snapshot(state), identity_before)

            self.assertEqual(result["status"], "attention")
            self.assertEqual(len(result["persisted_blockers"]), 1)
            self.assertEqual(len(result["current_blockers"]), 1)
            self.assertEqual(result["persisted_blockers"][0]["source_path"], str(source))
            self.assertEqual(result["current_blockers"][0]["source_path"], str(source))
            self.assertEqual(result["persisted_blockers"][0]["reason"], "source_unavailable")
            self.assertEqual(result["current_blockers"][0]["reason"], "unreconciled_remote")

    def test_check_unparseable_source_is_indeterminate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            state.mkdir()
            sessions.mkdir()
            (sessions / "broken.jsonl").write_text("{not-json}\n", encoding="utf-8")
            codex_state = root / "missing-state.sqlite"
            with contextlib.closing(sqlite3.connect(codex_state)) as conn:
                with conn:
                    conn.execute("PRAGMA journal_mode=WAL")
                    conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)")
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"
            historical = [self.entry(now, "old", "github.com/org/old", 100, 1.0)]

            with self.production_loader(sessions, identity_db):
                rollup.run(db_path=db_path, entries_loader=lambda: historical, now=lambda: now)
                before = self.tree_snapshot(root)

                result = rollup._check_rollup(
                    db_path,
                    lambda: aggregators.load_all_entries(read_only=True, diagnostic=True),
                    now=lambda: now,
                )

                self.assertEqual(self.tree_snapshot(root), before)

            self.assertEqual(result["orphan_rows"]["count"], 1)
            self.assertEqual(result["verdict"], "safe")
            self.assertEqual(result["status"], "indeterminate")
            self.assertFalse(result["scan_complete"])
            self.assertEqual(len(result["source_errors"]), 1)
            self.assertEqual(result["source_errors"][0]["path"], str(sessions / "broken.jsonl"))
            self.assertEqual(result["source_errors"][0]["stage"], "parse")

    def test_check_nested_walk_permission_error_is_indeterminate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            nested = sessions / "unreadable"
            state.mkdir()
            nested.mkdir(parents=True)
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"
            historical = [self.entry(now, "old", "github.com/org/old", 100, 1.0)]

            def walk_with_nested_permission_error(top, topdown=True, onerror=None, followlinks=False):
                del topdown, followlinks
                yield str(top), [nested.name], []
                onerror(
                    PermissionError(
                        errno.EACCES,
                        "permission denied",
                        str(nested),
                    )
                )

            with self.production_loader(sessions, identity_db), mock.patch.object(
                aggregators.os,
                "walk",
                side_effect=walk_with_nested_permission_error,
            ):
                rollup.run(db_path=db_path, entries_loader=lambda: historical, now=lambda: now)
                before = self.tree_snapshot(root)

                result = rollup._check_rollup(
                    db_path,
                    lambda: aggregators.load_all_entries(read_only=True, diagnostic=True),
                    now=lambda: now,
                )

                self.assertEqual(self.tree_snapshot(root), before)

            self.assertEqual(result["orphan_rows"]["count"], 1)
            self.assertEqual(result["verdict"], "safe")
            self.assertEqual(result["status"], "indeterminate")
            self.assertFalse(result["scan_complete"])
            self.assertEqual(len(result["source_errors"]), 1)
            self.assertEqual(result["source_errors"][0]["path"], str(nested))
            self.assertEqual(result["source_errors"][0]["stage"], "scan")

    def test_check_codex_metadata_error_is_reported_once_for_many_sessions(self):
        session_count = 6
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            state.mkdir()
            sessions.mkdir()
            for index in range(session_count):
                self.write_codex_session(
                    sessions / ("session-%d.jsonl" % index),
                    "repo",
                    "session-%d" % index,
                    10 + index,
                )
            codex_state = root / "missing-state.sqlite"
            codex_state.write_bytes(b"not a sqlite database")
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"

            with self.production_loader(sessions, identity_db), mock.patch.object(
                aggregators.codex,
                "_load_thread_models",
                wraps=aggregators.codex._load_thread_models,
            ) as load_thread_models:
                rollup.run(db_path=db_path, entries_loader=list, now=lambda: now)
                before = self.tree_snapshot(root)

                result = rollup._check_rollup(
                    db_path,
                    lambda: aggregators.load_all_entries(read_only=True, diagnostic=True),
                    now=lambda: now,
                )

                self.assertEqual(self.tree_snapshot(root), before)

            metadata_errors = [
                error
                for error in result["source_errors"]
                if error["path"] == str(codex_state) and error["stage"] == "metadata"
            ]
            self.assertEqual(load_thread_models.call_count, 1)
            self.assertEqual(len(metadata_errors), 1)
            self.assertEqual(len(result["source_errors"]), 1)
            self.assertEqual(result["status"], "indeterminate")
            self.assertNotEqual(result["status"], "safe")
            self.assertFalse(result["scan_complete"])

    def test_diagnostic_and_normal_loads_match_keys_with_codex_metadata_wal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / "state"
            sessions = root / "sessions"
            state.mkdir()
            sessions.mkdir()
            expected_models = {
                "session-a": "gpt-5.6-sol",
                "session-b": "codex-auto-review",
            }
            for index, session_id in enumerate(expected_models):
                self.write_codex_session(
                    sessions / (session_id + ".jsonl"),
                    "repo",
                    session_id,
                    10 + index,
                )

            codex_state = root / "state_5.sqlite"
            metadata_conn = sqlite3.connect(codex_state)
            try:
                metadata_conn.execute("PRAGMA journal_mode=WAL")
                metadata_conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)")
                metadata_conn.commit()
                metadata_conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                metadata_conn.executemany(
                    "INSERT INTO threads (id, model) VALUES (?, ?)",
                    expected_models.items(),
                )
                metadata_conn.commit()
                wal_path = Path(str(codex_state) + "-wal")
                self.assertTrue(wal_path.exists())
                self.assertGreater(wal_path.stat().st_size, 0)

                identity_db = state / "project_identity.db"
                with self.production_loader(sessions, identity_db), mock.patch.object(
                    aggregators.codex,
                    "STATE_DB",
                    str(codex_state),
                ):
                    normal = aggregators.load_all_entries(force_reload=True)
                    before = self.tree_snapshot(root)
                    diagnostic = aggregators.load_all_entries(
                        read_only=True,
                        diagnostic=True,
                    )
                    self.assertEqual(self.tree_snapshot(root), before)

                normal_keys = {self.coverage_key(entry) for entry in normal}
                diagnostic_keys = {self.coverage_key(entry) for entry in diagnostic}
                self.assertEqual(diagnostic_keys, normal_keys)
                self.assertEqual(
                    {entry.model for entry in normal if entry.agent_id == "codex"},
                    set(expected_models.values()),
                )
                self.assertEqual(
                    {entry.model for entry in diagnostic if entry.agent_id == "codex"},
                    set(expected_models.values()),
                )
                self.assertEqual(diagnostic.source_errors, [])
                self.assertTrue(diagnostic.scan_complete)
            finally:
                metadata_conn.close()

    def test_diagnostic_metadata_snapshot_handles_wal_created_during_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            codex_state = root / "state_5.sqlite"
            with contextlib.closing(sqlite3.connect(codex_state)) as conn:
                with conn:
                    conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)")

            real_optional_signature = aggregators.codex._optional_file_signature
            writer_connections = []

            def create_wal_after_absence_probe(path):
                if str(path).endswith("-wal") and not writer_connections:
                    writer = sqlite3.connect(codex_state)
                    writer.execute("PRAGMA journal_mode=WAL")
                    writer.execute(
                        "INSERT INTO threads (id, model) VALUES (?, ?)",
                        ("session-race", "gpt-5.6-sol"),
                    )
                    writer.commit()
                    writer_connections.append(writer)
                    return None
                return real_optional_signature(path)

            source_errors = []
            try:
                with mock.patch.object(
                    aggregators.codex,
                    "_optional_file_signature",
                    side_effect=create_wal_after_absence_probe,
                ):
                    models = aggregators.codex._load_thread_models(
                        codex_state,
                        immutable=True,
                        source_errors=source_errors,
                    )
            finally:
                for writer in writer_connections:
                    writer.close()

            self.assertEqual(models, {"session-race": "gpt-5.6-sol"})
            self.assertEqual(source_errors, [])

    def test_read_only_pricing_lookup_does_not_create_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / "state" / "pricing_cache.json"

            pricing = pricing_fetcher.get_pricing(
                cache_path=cache_path,
                fetcher=lambda: {"gpt-5": {"input_cost_per_token": 1.0}},
                now=lambda: 123.0,
                persist=False,
            )

            self.assertIn("gpt-5", pricing)
            self.assertFalse(cache_path.exists())
            self.assertFalse(cache_path.parent.exists())

    def test_rollup_check_cli_json_is_machine_readable(self):
        source_root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cli_root = root / "tt-web"
            cli_root.mkdir()
            for name in (
                "tt-web",
                "aggregators.py",
                "cache.py",
                "pricing.json",
                "pricing_fetcher.py",
                "rollup.py",
            ):
                shutil.copy2(source_root / name, cli_root / name)
            shutil.copytree(source_root / "parsers", cli_root / "parsers")
            state = cli_root / "state"
            state.mkdir()
            pricing_cache = state / "pricing_cache.json"
            pricing_cache.write_text(
                json.dumps({"fetched_at": time.time(), "data": {}}),
                encoding="utf-8",
            )
            cache_before = pricing_cache.read_bytes()
            rollup.run(
                db_path=state / "rollup.db",
                entries_loader=list,
                now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            )
            state_before = self.tree_snapshot(state)
            home = root / "home"
            home.mkdir()
            env = os.environ.copy()
            env.update(
                {
                    "HOME": str(home),
                    "CLAUDE_CONFIG_DIR": str(home / ".claude-empty"),
                    "TT_WEB_EXTRA_JSONL": "",
                }
            )

            completed = subprocess.run(
                [str(cli_root / "tt-web"), "rollup", "--check", "--json"],
                capture_output=True,
                text=True,
                check=False,
                env=env,
                cwd=cli_root,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            result = json.loads(completed.stdout)
            self.assertEqual(result["verdict"], "safe")
            self.assertEqual(result["status"], "safe")
            self.assertEqual(result["db_span"]["rows"], 0)
            self.assertEqual(pricing_cache.read_bytes(), cache_before)
            self.assertEqual(self.tree_snapshot(state), state_before)

            human = subprocess.run(
                [str(cli_root / "tt-web"), "rollup", "--check"],
                capture_output=True,
                text=True,
                check=False,
                env=env,
                cwd=cli_root,
            )
            self.assertEqual(human.returncode, 0, human.stderr)
            self.assertIn("Rollup check status: SAFE", human.stdout)
            self.assertIn("Identity blockers: 0; no action required.", human.stdout)

            (state / "rollup.db.lock").unlink()
            missing_lock_before = self.tree_snapshot(state)
            indeterminate = subprocess.run(
                [str(cli_root / "tt-web"), "rollup", "--check", "--json"],
                capture_output=True,
                text=True,
                check=False,
                env=env,
                cwd=cli_root,
            )
            self.assertEqual(indeterminate.returncode, 0, indeterminate.stderr)
            self.assertEqual(json.loads(indeterminate.stdout)["status"], "indeterminate")
            indeterminate_human = subprocess.run(
                [str(cli_root / "tt-web"), "rollup", "--check"],
                capture_output=True,
                text=True,
                check=False,
                env=env,
                cwd=cli_root,
            )
            self.assertEqual(indeterminate_human.returncode, 0, indeterminate_human.stderr)
            self.assertIn("Rollup check status: INDETERMINATE", indeterminate_human.stdout)
            self.assertNotIn("Rollup check status: SAFE", indeterminate_human.stdout)
            self.assertEqual(self.tree_snapshot(state), missing_lock_before)

    def test_source_coverage_oracle_classifies_keys_without_checker_helper(self):
        module_path = Path(__file__).with_name("check_rollup_source_coverage.py")
        spec = importlib.util.spec_from_file_location("rollup_source_coverage", module_path)
        oracle = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(oracle)

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)
            ts = now - timedelta(days=1)
            initial = [
                self.entry(ts, "orphan", "repo-orphan", 50, 5.0),
                self.entry(ts, "shrink", "repo-shrink", 100, 10.0),
                self.entry(ts, "write", "repo-write", 10, 1.0),
            ]
            current = [
                self.entry(ts, "shrink", "repo-shrink", 90, 9.0),
                self.entry(ts, "write", "repo-write", 20, 2.0),
            ]
            rollup.run(db_path=db_path, entries_loader=lambda: initial, now=lambda: now)
            before = self.tree_snapshot(Path(tmp))

            result = oracle.check_coverage(
                db_path,
                entries_loader=lambda: current,
                now=lambda: now,
            )

            self.assertEqual(self.tree_snapshot(Path(tmp)), before)
            self.assertEqual(result["orphan_rows"]["count"], 1)
            self.assertEqual(result["would_skip"]["count"], 1)
            self.assertEqual(result["would_write"]["count"], 1)
            self.assertEqual(result["verdict"], "attention")
            help_result = subprocess.run(
                [str(module_path), "--help"],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(help_result.returncode, 0)
            self.assertIn("--db", help_result.stdout)

    @staticmethod
    def entry(ts, sid, project, input_tokens, cost):
        return UsageEntry(
            timestamp=ts,
            session_id=sid,
            message_id=sid + "-message",
            request_id=sid + "-request",
            model="gpt-5",
            input_tokens=input_tokens,
            output_tokens=0,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cost_usd=cost,
            project=project,
            agent_id="codex",
            message_count=1,
        )

    @staticmethod
    def coverage_key(entry):
        return (
            entry.timestamp.astimezone().date().isoformat(),
            entry.agent_id,
            entry.project,
            entry.model,
        )

    @staticmethod
    def db_snapshot(db_path):
        uri = Path(db_path).resolve().as_uri() + "?mode=ro"
        with contextlib.closing(sqlite3.connect(uri, uri=True)) as conn:
            conn.execute("PRAGMA query_only=ON")
            journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            schema = conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
            table_names = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
                )
            ]
            tables = {
                name: conn.execute(
                    'SELECT * FROM "%s" ORDER BY rowid' % name.replace('"', '""')
                ).fetchall()
                for name in table_names
            }
        return {
            "journal_mode": journal_mode,
            "schema": schema,
            "tables": tables,
            "db_bytes": Path(db_path).read_bytes(),
        }

    @staticmethod
    def tree_snapshot(root):
        root = Path(root)
        if not root.exists():
            return {}
        snapshot = {".": ("directory", root.stat().st_mode & 0o7777)}
        for path in sorted(root.rglob("*")):
            relative = str(path.relative_to(root))
            mode = path.lstat().st_mode & 0o7777
            if path.is_symlink():
                snapshot[relative] = ("symlink", mode, os.readlink(path))
            elif path.is_dir():
                snapshot[relative] = ("directory", mode)
            else:
                snapshot[relative] = ("file", mode, path.read_bytes())
        return snapshot

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
            ) as get_pricing, mock.patch(
                "pricing_fetcher.calculate_cost", return_value=1.0
            ):
                aggregators._GLOBAL_USAGE_CACHE = None
                aggregators._PROJECT_CACHE = {}
                yield get_pricing
        finally:
            aggregators._GLOBAL_USAGE_CACHE = prior_usage_cache
            aggregators._PROJECT_CACHE = prior_project_cache

    @staticmethod
    def init_git_repo(path, remote=None):
        path.mkdir()
        subprocess.run(["git", "init", "-q", str(path)], check=True)
        if remote:
            subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote], check=True)

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


if __name__ == "__main__":
    unittest.main()
