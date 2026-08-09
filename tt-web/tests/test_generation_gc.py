import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import generation
import rollup


class GenerationGCTests(unittest.TestCase):
    def test_iv17_space_preflight_preserves_current_and_leaves_no_staging(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            second_db = self.make_db(tmp_path / "second.db", 20)
            disk_usage = type("Usage", (), {"free": 0})()

            with mock.patch("generation.shutil.disk_usage", return_value=disk_usage):
                with self.assertRaises(generation.GenerationError):
                    generation.publish_generation(
                        "macbook",
                        second_db,
                        self.make_meta(second_db, "2026-08-04T12:01:00Z"),
                        root=root,
                    )

            machine_dir = root / "macbook"
            self.assertEqual((machine_dir / "current").read_text().strip(), first.meta["generation_id"])
            self.assertEqual(self.generation_ids(machine_dir), {first.meta["generation_id"]})
            self.assertEqual(list(machine_dir.glob(".staging-*")), [])

    def test_iv17_success_and_real_failure_exit_keep_only_current_and_previous(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            published = []
            for index, tokens in enumerate((10, 20, 30, 40), start=1):
                snapshot = self.make_db(tmp_path / ("%d.db" % index), tokens)
                current = generation.publish_generation(
                    "macbook",
                    snapshot,
                    self.make_meta(snapshot, "2026-08-04T12:0%d:00Z" % index),
                    root=root,
                )
                published.append(current.meta["generation_id"])

            machine_dir = root / "macbook"
            self.assertEqual(self.generation_ids(machine_dir), set(published[-2:]))
            self.assertEqual((machine_dir / "current").read_text().strip(), published[-1])
            self.assertEqual((machine_dir / "previous").read_text().strip(), published[-2])
            self.assertEqual(list(machine_dir.glob(".staging-*")), [])
            self.assertFalse((machine_dir / ".publication-pending.json").exists())
            self.assertEqual(self.input_total(machine_dir / published[-1] / "snapshot.db"), 40)
            self.assertEqual(self.input_total(machine_dir / published[-2] / "snapshot.db"), 30)

            failing = self.make_db(tmp_path / "failing.db", 50)

            def fail_before_switch(phase):
                if phase == "before_current_switch":
                    raise generation.InjectedGenerationFailure(phase)

            with self.assertRaises(generation.InjectedGenerationFailure):
                generation.publish_generation(
                    "macbook",
                    failing,
                    self.make_meta(failing, "2026-08-04T12:05:00Z"),
                    root=root,
                    phase_hook=fail_before_switch,
                )

            self.assertEqual(self.generation_ids(machine_dir), set(published[-2:]))
            self.assertEqual(list(machine_dir.glob(".staging-*")), [])
            self.assertFalse((machine_dir / ".publication-pending.json").exists())

    def test_iv17_repeated_distinct_failures_are_bounded_by_the_production_failure_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            retained = []
            for index, tokens in enumerate((10, 20), start=1):
                snapshot = self.make_db(tmp_path / ("success-%d.db" % index), tokens)
                published = generation.publish_generation(
                    "macbook",
                    snapshot,
                    self.make_meta(snapshot, "2026-08-04T12:0%d:00Z" % index),
                    root=root,
                )
                retained.append(published.meta["generation_id"])

            def fail_before_switch(phase):
                if phase == "before_current_switch":
                    raise generation.InjectedGenerationFailure(phase)

            machine_dir = root / "macbook"
            for index, tokens in enumerate((30, 40, 50, 60), start=3):
                snapshot = self.make_db(tmp_path / ("failure-%d.db" % index), tokens)
                with self.assertRaises(generation.InjectedGenerationFailure):
                    generation.publish_generation(
                        "macbook",
                        snapshot,
                        self.make_meta(snapshot, "2026-08-04T12:0%d:00Z" % index),
                        root=root,
                        phase_hook=fail_before_switch,
                    )
                self.assertEqual(self.generation_ids(machine_dir), set(retained))
                self.assertFalse((machine_dir / ".publication-pending.json").exists())

    def test_iv17_gc_does_not_delete_a_generation_held_by_an_active_reader(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            lease = generation.read_current_generation("macbook", root=root)
            second_db = self.make_db(tmp_path / "second.db", 20)
            generation.publish_generation(
                "macbook", second_db, self.make_meta(second_db, "2026-08-04T12:01:00Z"), root=root
            )
            third_db = self.make_db(tmp_path / "third.db", 30)
            generation.publish_generation(
                "macbook", third_db, self.make_meta(third_db, "2026-08-04T12:02:00Z"), root=root
            )

            self.assertTrue((root / "macbook" / first.meta["generation_id"]).is_dir())
            self.assertEqual(self.input_total(lease.db_path), 10)
            lease.close()
            fourth_db = self.make_db(tmp_path / "fourth.db", 40)
            generation.publish_generation(
                "macbook", fourth_db, self.make_meta(fourth_db, "2026-08-04T12:03:00Z"), root=root
            )
            self.assertFalse((root / "macbook" / first.meta["generation_id"]).exists())

    def test_iv17_same_id_republish_refuses_while_an_active_reader_holds_the_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first_meta = self.make_meta(first_db, "2026-08-04T12:00:00Z")
            first = generation.publish_generation(
                "macbook", first_db, first_meta, root=root
            )
            lease = generation.read_current_generation("macbook", root=root)
            try:
                retained = []
                for index, tokens in enumerate((20, 30), start=1):
                    snapshot = self.make_db(tmp_path / ("next-%d.db" % index), tokens)
                    current = generation.publish_generation(
                        "macbook",
                        snapshot,
                        self.make_meta(snapshot, "2026-08-04T12:0%d:00Z" % index),
                        root=root,
                    )
                    retained.append(current.meta["generation_id"])

                first_dir = root / "macbook" / first.meta["generation_id"]
                self.assertTrue(first_dir.is_dir())
                with self.assertRaisesRegex(generation.GenerationError, "active reader lease"):
                    generation.publish_generation(
                        "macbook",
                        first_db,
                        first_meta,
                        root=root,
                        now=lambda: datetime(2026, 8, 4, 12, 4, tzinfo=timezone.utc),
                    )

                machine_dir = root / "macbook"
                self.assertTrue(first_dir.is_dir())
                self.assertTrue(lease.db_path.is_file())
                self.assertEqual(self.input_total(lease.db_path), 10)
                self.assertEqual((machine_dir / "current").read_text().strip(), retained[-1])
                self.assertEqual((machine_dir / "previous").read_text().strip(), retained[-2])
            finally:
                lease.close()

    def test_iv17_gc_honors_an_active_reader_lease_in_another_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            script = """
import sys
import generation
current = generation.read_current_generation('macbook', root=sys.argv[1])
print('ready', flush=True)
sys.stdin.readline()
current.close()
"""
            reader = subprocess.Popen(
                [sys.executable, "-c", script, str(root)],
                env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            try:
                self.assertEqual(reader.stdout.readline().strip(), "ready")
                for index, tokens in enumerate((20, 30), start=1):
                    snapshot = self.make_db(tmp_path / ("next-%d.db" % index), tokens)
                    generation.publish_generation(
                        "macbook",
                        snapshot,
                        self.make_meta(snapshot, "2026-08-04T12:0%d:00Z" % index),
                        root=root,
                    )
                self.assertTrue((root / "macbook" / first.meta["generation_id"]).is_dir())
                reader.stdin.write("done\n")
                reader.stdin.flush()
                self.assertEqual(reader.wait(timeout=5), 0, reader.stderr.read())
                fourth = self.make_db(tmp_path / "fourth.db", 40)
                generation.publish_generation(
                    "macbook", fourth, self.make_meta(fourth, "2026-08-04T12:03:00Z"), root=root
                )
                self.assertFalse((root / "macbook" / first.meta["generation_id"]).exists())
            finally:
                if reader.poll() is None:
                    reader.kill()
                    reader.wait(timeout=5)
                reader.stdin.close()
                reader.stdout.close()
                reader.stderr.close()

    def test_iv17_next_real_publish_recovers_a_process_crash_before_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            second_db = self.make_db(tmp_path / "second.db", 20)
            self.crash_publish(root, second_db, self.make_meta(second_db, "2026-08-04T12:01:00Z"), "before_current_switch")

            third_db = self.make_db(tmp_path / "third.db", 30)
            third = generation.publish_generation(
                "macbook", third_db, self.make_meta(third_db, "2026-08-04T12:02:00Z"), root=root
            )
            current = generation.read_current_generation("macbook", root=root)
            try:
                self.assertEqual(current.meta["generation_id"], third.meta["generation_id"])
                self.assertEqual(self.input_total(current.db_path), 30)
            finally:
                current.close()
            self.assertEqual(
                self.generation_ids(root / "macbook"),
                {first.meta["generation_id"], third.meta["generation_id"]},
            )
            self.assertEqual(
                (root / "macbook" / "previous").read_text().strip(),
                first.meta["generation_id"],
            )
            self.assertFalse((root / "macbook" / ".publication-pending.json").exists())

    def test_retry_after_a_real_before_pointer_crash_uses_the_retry_switch_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            second_db = self.make_db(tmp_path / "second.db", 20)
            second_meta = self.make_meta(second_db, "2026-08-04T12:01:00Z")
            self.crash_publish(root, second_db, second_meta, "before_current_switch")

            retried = generation.publish_generation(
                "macbook",
                second_db,
                second_meta,
                root=root,
                now=lambda: datetime(2026, 8, 4, 12, 5, tzinfo=timezone.utc),
            )

            machine_dir = root / "macbook"
            self.assertEqual(retried.meta["published_at"], "2026-08-04T12:05:00Z")
            self.assertEqual((machine_dir / "current").read_text().strip(), second_meta["generation_id"])
            self.assertEqual((machine_dir / "previous").read_text().strip(), first.meta["generation_id"])
            self.assertEqual(
                self.generation_ids(machine_dir),
                {first.meta["generation_id"], second_meta["generation_id"]},
            )

    def test_iv17_next_real_publish_recovers_a_process_crash_after_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            first_db = self.make_db(tmp_path / "first.db", 10)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "2026-08-04T12:00:00Z"), root=root
            )
            second_db = self.make_db(tmp_path / "second.db", 20)
            second_meta = self.make_meta(second_db, "2026-08-04T12:01:00Z")
            self.crash_publish(root, second_db, second_meta, "after_current_switch")

            third_db = self.make_db(tmp_path / "third.db", 30)
            third = generation.publish_generation(
                "macbook", third_db, self.make_meta(third_db, "2026-08-04T12:02:00Z"), root=root
            )
            machine_dir = root / "macbook"
            self.assertEqual((machine_dir / "current").read_text().strip(), third.meta["generation_id"])
            self.assertEqual((machine_dir / "previous").read_text().strip(), second_meta["generation_id"])
            self.assertEqual(self.generation_ids(machine_dir), {second_meta["generation_id"], third.meta["generation_id"]})
            self.assertEqual(self.input_total(machine_dir / second_meta["generation_id"] / "snapshot.db"), 20)
            self.assertFalse((machine_dir / ".publication-pending.json").exists())

    def crash_publish(self, root, snapshot, meta, phase):
        script = """
import json, os, sys
import generation
root, snapshot, meta_path, phase = sys.argv[1:]
meta = json.loads(open(meta_path, encoding='utf-8').read())
def crash(observed):
    if observed == phase:
        os._exit(73)
generation.publish_generation('macbook', snapshot, meta, root=root, phase_hook=crash)
"""
        meta_path = Path(root).parent / (phase + ".json")
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, "-c", script, str(root), str(snapshot), str(meta_path), phase],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1])},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 73, result.stderr)

    @staticmethod
    def make_db(path, input_tokens):
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.executescript(rollup.SCHEMA)
            conn.execute(
                """
                INSERT INTO daily_rollup (
                  date, agent_id, project, model, input_tokens, output_tokens,
                  cache_creation_tokens, cache_read_tokens, cost_usd,
                  cost_known_count, entry_count, message_count
                ) VALUES ('2026-08-04', 'codex', 'repo', 'gpt-5', ?, 2, 3, 4, 1.5, 1, 1, 1)
                """,
                (input_tokens,),
            )
            conn.execute(
                "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', 'Asia/Shanghai')"
            )
        return path

    @staticmethod
    def make_meta(snapshot, generated_at):
        return generation.build_generation_meta(
            snapshot,
            machine_config_fingerprint="f" * 64,
            source_host_identity="host-v1:" + "5" * 64,
            aliases=[],
            rate_limits={},
            exporter_commit="a" * 40,
            generated_at=generated_at,
        )

    @staticmethod
    def generation_ids(machine_dir):
        return {
            child.name
            for child in machine_dir.iterdir()
            if child.is_dir() and len(child.name) == 64 and all(c in "0123456789abcdef" for c in child.name)
        }

    @staticmethod
    def input_total(path):
        with closing(sqlite3.connect(path)) as conn:
            return conn.execute("SELECT SUM(input_tokens) FROM daily_rollup").fetchone()[0]


if __name__ == "__main__":
    unittest.main()
