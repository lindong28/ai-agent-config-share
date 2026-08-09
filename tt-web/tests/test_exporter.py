import hashlib
import json
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import rollup


class ExporterTests(unittest.TestCase):
    def test_iv5_vacuum_into_includes_rows_present_only_in_uncheckpointed_wal(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "rollup.db"
            output = Path(tmp) / "snapshot.db"
            writer = sqlite3.connect(source)
            try:
                writer.execute("PRAGMA journal_mode=WAL")
                writer.executescript(rollup.SCHEMA)
                writer.execute(
                    "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', 'Asia/Shanghai')"
                )
                writer.commit()
                writer.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                writer.execute(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model, input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens, cost_usd,
                      cost_known_count, entry_count, message_count
                    ) VALUES ('2026-08-04', 'codex', 'repo', 'gpt-5', 41, 2, 3, 4, 1.5, 1, 1, 1)
                    """
                )
                writer.commit()

                self.assertTrue(Path(str(source) + "-wal").is_file())
                with closing(sqlite3.connect(source.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)) as stale:
                    self.assertEqual(stale.execute("SELECT COUNT(*) FROM daily_rollup").fetchone()[0], 0)

                with rollup.rollup_lock(source):
                    exporter._vacuum_into_locked(source, output)
            finally:
                writer.close()

            with closing(sqlite3.connect(output)) as exported:
                self.assertEqual(
                    exported.execute("SELECT COUNT(*), SUM(input_tokens) FROM daily_rollup").fetchone(),
                    (1, 41),
                )

    def test_a2_export_leaf_hard_fails_without_the_target_database_lock(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10)
            other = self.make_db(Path(tmp) / "other.db", 20)

            with self.assertRaises(rollup.RollupLockNotHeld):
                exporter._vacuum_into_locked(source, Path(tmp) / "no-lock.db")
            with rollup.rollup_lock(other):
                with self.assertRaises(rollup.RollupLockNotHeld):
                    exporter._vacuum_into_locked(source, Path(tmp) / "wrong-lock.db")

            self.assertFalse((Path(tmp) / "no-lock.db").exists())
            self.assertFalse((Path(tmp) / "wrong-lock.db").exists())

    def test_a2_export_serializes_against_a_writer_holding_the_same_lock(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10)
            bundle = Path(tmp) / "bundle"
            locked = threading.Event()
            release = threading.Event()
            finished = threading.Event()
            errors = []

            def writer():
                with rollup.rollup_lock(source):
                    locked.set()
                    release.wait(10)

            def export():
                try:
                    with mock.patch(
                        "exporter.exporter_version", return_value="a" * 40
                    ):
                        exporter.export_bundle(
                            source,
                            bundle,
                            refresh=False,
                            source_host_identity="host-v1:" + "1" * 64,
                            generated_at="2026-08-04T12:00:00Z",
                            rate_limits={},
                        )
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    finished.set()

            writer_thread = threading.Thread(target=writer)
            export_thread = threading.Thread(target=export)
            writer_thread.start()
            self.assertTrue(locked.wait(5))
            export_thread.start()
            time.sleep(0.15)
            self.assertFalse(finished.is_set())
            self.assertFalse(bundle.exists())
            release.set()
            writer_thread.join(5)
            export_thread.join(5)

            self.assertEqual(errors, [])
            self.assertTrue(finished.is_set())
            self.assertTrue((bundle / "snapshot.db").is_file())

    def test_iv6_export_performs_only_the_authorized_normal_rollup_refresh(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10, day="2020-01-02")
            control = self.make_db(Path(tmp) / "control.db", 10, day="2020-01-02")
            bundle = Path(tmp) / "bundle"
            fixed_now = lambda: datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
            before = self.application_contract(source)

            rollup.run(db_path=control, entries_loader=lambda: [], now=fixed_now)

            with mock.patch("exporter.exporter_version", return_value="b" * 40):
                exporter.export_bundle(
                    source,
                    bundle,
                    entries_loader=lambda: [],
                    rollup_now=fixed_now,
                    source_host_identity="host-v1:" + "2" * 64,
                    generated_at="2026-08-04T12:00:00Z",
                    rate_limits={},
                )

            self.assertNotEqual(self.application_contract(source), before)
            self.assertEqual(
                self.application_contract(source),
                self.application_contract(control),
            )
            with closing(sqlite3.connect(bundle / "snapshot.db")) as snapshot:
                self.assertEqual(
                    snapshot.execute(
                        "SELECT date, input_tokens FROM daily_rollup ORDER BY date"
                    ).fetchall(),
                    [("2020-01-02", 10)],
                )

    def test_export_space_preflight_leaves_no_bundle_or_staging(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            source = self.make_db(tmp_path / "rollup.db", 10)
            bundle = tmp_path / "bundle"
            disk_usage = type("Usage", (), {"free": 0})()

            with mock.patch(
                "exporter.exporter_version", return_value="e" * 40
            ), mock.patch("exporter.shutil.disk_usage", return_value=disk_usage):
                with self.assertRaises(exporter.ExportSpaceError):
                    exporter.export_bundle(
                        source,
                        bundle,
                        refresh=False,
                        source_host_identity="host-v1:" + "6" * 64,
                        generated_at="2026-08-04T12:00:00Z",
                        rate_limits={},
                    )

            self.assertFalse(bundle.exists())
            self.assertEqual(list(tmp_path.glob(".bundle.staging-*")), [])

    def test_export_manifest_binds_the_exact_snapshot_bytes_and_claims_no_row_lineage(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10)
            bundle = Path(tmp) / "bundle"
            with mock.patch("exporter.exporter_version", return_value="c" * 40):
                manifest = exporter.export_bundle(
                    source,
                    bundle,
                    refresh=False,
                    source_host_identity="host-v1:" + "3" * 64,
                    generated_at="2026-08-04T12:00:00Z",
                    rate_limits={"codex": {"updated_at": "2026-08-04T11:59:00Z"}},
                )

            snapshot_bytes = (bundle / "snapshot.db").read_bytes()
            on_disk = json.loads((bundle / "export.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest, on_disk)
            self.assertEqual(manifest["transfer_digest"], hashlib.sha256(snapshot_bytes).hexdigest())
            self.assertEqual(
                manifest["manifest_digest"],
                exporter.manifest_digest(manifest),
            )
            self.assertEqual(manifest["row_count"], 1)
            self.assertEqual(manifest["aliases"], [])

    def test_manifest_digest_rejects_metadata_tampering_even_when_snapshot_is_unchanged(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10)
            bundle = Path(tmp) / "bundle"
            with mock.patch("exporter.exporter_version", return_value="7" * 40):
                manifest = exporter.export_bundle(
                    source,
                    bundle,
                    refresh=False,
                    source_host_identity="host-v1:" + "7" * 64,
                    generated_at="2026-08-04T12:00:00Z",
                    rate_limits={"codex": {"updated_at": "2026-08-04T11:59:00Z"}},
                )
            manifest["source_host_identity"] = "host-v1:" + "8" * 64

            with self.assertRaisesRegex(exporter.ExportError, "manifest_digest"):
                exporter.validate_export_manifest(manifest, bundle / "snapshot.db")

    def test_exporter_version_rejects_dirty_runtime_authority_paths(self):
        import exporter

        responses = [
            subprocess.CompletedProcess([], 0, "a" * 40 + "\n", ""),
            subprocess.CompletedProcess([], 0, " M tt-web/exporter.py\n", ""),
        ]
        with mock.patch("exporter.subprocess.run", side_effect=responses):
            with self.assertRaisesRegex(exporter.ExportError, "differs from HEAD"):
                exporter.exporter_version()

    def test_dirty_version_refusal_precedes_rollup_mutation_and_output_creation(self):
        import exporter

        with tempfile.TemporaryDirectory() as tmp:
            source = self.make_db(Path(tmp) / "rollup.db", 10)
            bundle = Path(tmp) / "bundle"
            with mock.patch(
                "exporter.exporter_version",
                side_effect=exporter.ExportError("runtime authority differs from HEAD"),
            ), mock.patch(
                "exporter.rollup.run", side_effect=AssertionError("rollup called")
            ):
                with self.assertRaisesRegex(exporter.ExportError, "differs from HEAD"):
                    exporter.export_bundle(
                        source,
                        bundle,
                        entries_loader=lambda: [],
                        source_host_identity="host-v1:" + "9" * 64,
                        generated_at="2026-08-04T12:00:00Z",
                        rate_limits={},
                    )

            self.assertFalse(bundle.exists())

    def test_version_probe_is_rollup_free_when_runtime_authority_is_clean(self):
        import exporter

        responses = [
            subprocess.CompletedProcess([], 0, "a" * 40 + "\n", ""),
            subprocess.CompletedProcess([], 0, "", ""),
        ]
        with mock.patch(
            "exporter.subprocess.run", side_effect=responses
        ) as git_run, mock.patch(
            "exporter.rollup.run", side_effect=AssertionError("rollup called")
        ):
            version = exporter.exporter_version()
        self.assertEqual(version, "a" * 40)
        status_command = git_run.call_args_list[1].args[0]
        for pathspec in (
            ":(glob)*.py",
            ":(glob)parsers/**",
            "pricing.json",
            "tt-web",
            "install.sh",
            "machines.json",
        ):
            self.assertIn(pathspec, status_command)

    @staticmethod
    def make_db(path, input_tokens, day="2026-08-04"):
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.executescript(rollup.SCHEMA)
            conn.execute(
                """
                INSERT INTO daily_rollup (
                  date, agent_id, project, model, input_tokens, output_tokens,
                  cache_creation_tokens, cache_read_tokens, cost_usd,
                  cost_known_count, entry_count, message_count
                ) VALUES (?, 'codex', 'repo', 'gpt-5', ?, 2, 3, 4, 1.5, 1, 1, 1)
                """,
                (day, input_tokens),
            )
            conn.execute(
                "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', 'Asia/Shanghai')"
            )
        return path

    @staticmethod
    def application_contract(path):
        with closing(sqlite3.connect(path)) as conn:
            schema = conn.execute(
                "SELECT type, name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
            tables = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            ]
            rows = {
                table: conn.execute(
                    'SELECT * FROM "%s"' % table.replace('"', '""')
                ).fetchall()
                for table in tables
            }
            return schema, rows


if __name__ == "__main__":
    unittest.main()
