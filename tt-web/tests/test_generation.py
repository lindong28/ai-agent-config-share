import json
import math
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import generation
import rollup
from machine_config import MachineConfigError, load_machine_config


class GenerationTests(unittest.TestCase):
    def test_iv9_component_failure_keeps_existing_current_and_never_stays_never(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            snapshot = self.make_db(Path(tmp) / "snapshot.db", 10)
            meta = self.make_meta(snapshot, "host-a", generated_at="2026-08-04T12:00:00Z")

            with self.assertRaises(FileNotFoundError):
                generation.publish_generation(
                    "macbook", Path(tmp) / "missing.db", meta, root=root
                )
            self.assertIsNone(generation.read_current_generation("macbook", root=root))

            first = generation.publish_generation("macbook", snapshot, meta, root=root)
            before_pointer = (root / "macbook" / "current").read_text(encoding="utf-8")
            before_published = first.meta["published_at"]
            broken_meta = self.make_meta(
                snapshot, "host-a", generated_at="2026-08-04T12:01:00Z"
            )

            with mock.patch("generation._write_json", side_effect=OSError("component failed")):
                with self.assertRaisesRegex(OSError, "component failed"):
                    generation.publish_generation(
                        "macbook", snapshot, broken_meta, root=root
                    )

            after = generation.read_current_generation("macbook", root=root)
            self.assertEqual((root / "macbook" / "current").read_text(encoding="utf-8"), before_pointer)
            self.assertEqual(after.meta["generation_id"], first.meta["generation_id"])
            self.assertEqual(after.meta["published_at"], before_published)

    def test_iv9_digest_mismatch_is_rejected_before_current_switch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            snapshot = self.make_db(Path(tmp) / "snapshot.db", 10)
            meta = self.make_meta(snapshot, "host-a")
            with closing(sqlite3.connect(snapshot)) as conn, conn:
                conn.execute("UPDATE daily_rollup SET input_tokens = 999")

            with self.assertRaisesRegex(
                generation.GenerationValidationError, "transfer_digest"
            ):
                generation.publish_generation("macbook", snapshot, meta, root=root)

            self.assertIsNone(generation.read_current_generation("macbook", root=root))

    def test_iv9_in_process_failure_before_switch_keeps_previous_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            first_db = self.make_db(Path(tmp) / "first.db", 10)
            second_db = self.make_db(Path(tmp) / "second.db", 20)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "host-a", "2026-08-04T12:00:00Z"), root=root
            )

            def crash(phase):
                if phase == "before_current_switch":
                    raise generation.InjectedGenerationFailure(phase)

            with self.assertRaises(generation.InjectedGenerationFailure):
                generation.publish_generation(
                    "macbook",
                    second_db,
                    self.make_meta(second_db, "host-a", "2026-08-04T12:01:00Z"),
                    root=root,
                    phase_hook=crash,
                )

            restarted = generation.read_current_generation("macbook", root=root)
            self.assertEqual(restarted.meta["generation_id"], first.meta["generation_id"])
            self.assertEqual(self.input_total(restarted.db_path), 10)

    def test_iv9_in_process_failure_after_switch_keeps_new_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            first_db = self.make_db(Path(tmp) / "first.db", 10)
            second_db = self.make_db(Path(tmp) / "second.db", 20)
            generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "host-a", "2026-08-04T12:00:00Z"), root=root
            )
            expected_meta = self.make_meta(second_db, "host-a", "2026-08-04T12:01:00Z")

            def crash(phase):
                if phase == "after_current_switch":
                    raise generation.InjectedGenerationFailure(phase)

            with self.assertRaises(generation.InjectedGenerationFailure):
                generation.publish_generation(
                    "macbook", second_db, expected_meta, root=root, phase_hook=crash
                )

            restarted = generation.read_current_generation("macbook", root=root)
            self.assertEqual(restarted.meta["generation_id"], expected_meta["generation_id"])
            self.assertEqual(self.input_total(restarted.db_path), 20)

    def test_iv9_reader_resolves_pointer_once_and_reads_both_components_from_that_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            first_db = self.make_db(Path(tmp) / "first.db", 10)
            second_db = self.make_db(Path(tmp) / "second.db", 20)
            first = generation.publish_generation(
                "macbook", first_db, self.make_meta(first_db, "host-a", "2026-08-04T12:00:00Z"), root=root
            )
            second = generation.publish_generation(
                "macbook", second_db, self.make_meta(second_db, "host-a", "2026-08-04T12:01:00Z"), root=root
            )
            current = root / "macbook" / "current"
            current.write_text(first.meta["generation_id"] + "\n", encoding="utf-8")
            original_read_pointer = generation._read_pointer

            def switch_after_resolve(path):
                resolved = original_read_pointer(path)
                current.write_text(second.meta["generation_id"] + "\n", encoding="utf-8")
                return resolved

            with mock.patch("generation._read_pointer", side_effect=switch_after_resolve) as read_pointer:
                observed = generation.read_current_generation("macbook", root=root)

            read_pointer.assert_called_once()
            self.assertEqual(observed.meta["generation_id"], first.meta["generation_id"])
            self.assertEqual(self.input_total(observed.db_path), 10)

    def test_iv9_retry_republishes_at_the_actual_pointer_switch_time_and_rejects_corruption(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            first_db = self.make_db(Path(tmp) / "first.db", 10)
            second_db = self.make_db(Path(tmp) / "second.db", 20)
            first_meta = self.make_meta(first_db, "host-a", "2026-08-04T12:00:00Z")
            first = generation.publish_generation("macbook", first_db, first_meta, root=root)
            second_meta = self.make_meta(second_db, "host-a", "2026-08-04T12:01:00Z")

            def crash(phase):
                if phase == "before_current_switch":
                    raise generation.InjectedGenerationFailure(phase)

            with self.assertRaises(generation.InjectedGenerationFailure):
                generation.publish_generation(
                    "macbook",
                    second_db,
                    second_meta,
                    root=root,
                    now=lambda: datetime(2026, 8, 4, 12, 2, tzinfo=timezone.utc),
                    phase_hook=crash,
                )

            retried = generation.publish_generation(
                "macbook",
                second_db,
                second_meta,
                root=root,
                now=lambda: datetime(2026, 8, 4, 12, 3, tzinfo=timezone.utc),
            )

            self.assertEqual(retried.meta["published_at"], "2026-08-04T12:03:00Z")
            self.assertEqual(
                generation.read_current_generation("macbook", root=root).meta["generation_id"],
                second_meta["generation_id"],
            )

            orphan_dir = retried.generation_dir
            before_inode = orphan_dir.stat().st_ino
            third = generation.publish_generation(
                "macbook",
                first_db,
                self.make_meta(first_db, "host-a", "2026-08-04T12:02:00Z"),
                root=root,
            )
            (orphan_dir / "snapshot.db").write_bytes(b"different existing contents")
            corrupted = (orphan_dir / "snapshot.db").read_bytes()

            with self.assertRaises(generation.GenerationValidationError):
                generation.publish_generation("macbook", second_db, second_meta, root=root)

            self.assertEqual(orphan_dir.stat().st_ino, before_inode)
            self.assertEqual((orphan_dir / "snapshot.db").read_bytes(), corrupted)
            self.assertEqual(
                generation.read_current_generation("macbook", root=root).meta["generation_id"],
                third.meta["generation_id"],
            )

    def test_iv9_generation_components_are_fsynced_before_current_pointer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "generations"
            snapshot = self.make_db(Path(tmp) / "snapshot.db", 10)
            events = []
            original_fsync_file = generation._fsync_file
            original_fsync_directory = generation._fsync_directory
            original_atomic_write_text = generation._atomic_write_text

            def fsync_file(path):
                events.append(("file", Path(path).name))
                return original_fsync_file(path)

            def fsync_directory(path):
                events.append(("directory", Path(path).name))
                return original_fsync_directory(path)

            def atomic_write_text(path, value):
                events.append(("pointer", Path(path).name))
                return original_atomic_write_text(path, value)

            with mock.patch("generation._fsync_file", side_effect=fsync_file), mock.patch(
                "generation._fsync_directory", side_effect=fsync_directory
            ), mock.patch("generation._atomic_write_text", side_effect=atomic_write_text):
                generation.publish_generation(
                    "macbook", snapshot, self.make_meta(snapshot, "host-a"), root=root
                )

            snapshot_sync = events.index(("file", "snapshot.db"))
            staging_sync = next(
                index
                for index, event in enumerate(events)
                if event[0] == "directory" and event[1].startswith(".staging-")
            )
            generation_parent_sync = events.index(("directory", "macbook"))
            pointer_switch = events.index(("pointer", "current"))
            self.assertLess(snapshot_sync, staging_sync)
            self.assertLess(staging_sync, generation_parent_sync)
            self.assertLess(generation_parent_sync, pointer_switch)

    def test_issue003_retirement_marker_survives_config_revert_gc_and_ordinary_uninstall(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            active = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "oldbox", "ssh_host": "oldbox", "self": False},
            ]
            self.write_config(config_path, machines=active)
            active_config = config_path.read_bytes()
            old_machine = load_machine_config(config_path).by_name["oldbox"]
            old_db = self.make_db(tmp_path / "oldbox.db", 10)
            old_meta = generation.build_generation_meta(
                old_db,
                machine_config_fingerprint=generation.machine_config_fingerprint(old_machine),
                source_host_identity="host-v1:" + "9" * 64,
                aliases=[],
                rate_limits={},
                exporter_commit="a" * 40,
                generated_at="2026-08-04T12:00:00Z",
            )
            generation.publish_generation("oldbox", old_db, old_meta, root=root)

            generation.retire_machines(["oldbox"], config_path=config_path, root=root)
            marker = root / "retirements.json"
            self.assertTrue(marker.is_file())
            original_marker = marker.read_bytes()

            superseded = root / "oldbox" / ("a" * 64)
            superseded.mkdir(parents=True)
            for child in (root / "oldbox").iterdir():
                if child.name != "retired.json" and child.is_dir():
                    generation._remove_generation_directory(child)
            self.assertFalse(superseded.exists())
            self.assertEqual(marker.read_bytes(), original_marker)

            config_path.write_bytes(active_config)
            with self.assertRaisesRegex(MachineConfigError, "persistently retired"):
                load_machine_config(config_path, retirement_root=root)
            with self.assertRaisesRegex(MachineConfigError, "persistently retired"):
                generation.admitted_generations(config_path=config_path, root=root)

            uninstall = (Path(__file__).parents[1] / "uninstall.sh").read_text(encoding="utf-8")
            self.assertIn("source + state/ kept", uninstall)
            self.assertNotIn('rm -rf "$ROOT/state"', uninstall)

    def test_issue003_multi_machine_retirement_is_one_marker_commit_before_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            machines = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "oldbox", "ssh_host": "oldbox", "self": False},
                {"name": "olderbox", "ssh_host": "olderbox", "self": False},
            ]
            self.write_config(config_path, machines=machines)
            before_config = config_path.read_bytes()

            def crash(phase):
                if phase == "after_retirement_commit":
                    raise generation.InjectedGenerationFailure(phase)

            with self.assertRaises(generation.InjectedGenerationFailure):
                generation.retire_machines(
                    ["oldbox", "olderbox"],
                    config_path=config_path,
                    root=root,
                    phase_hook=crash,
                )

            self.assertEqual(config_path.read_bytes(), before_config)
            marker = json.loads((root / "retirements.json").read_text(encoding="utf-8"))
            self.assertEqual(marker["retired_names"], ["oldbox", "olderbox"])
            with self.assertRaisesRegex(MachineConfigError, "persistently retired"):
                load_machine_config(config_path, retirement_root=root)

    def test_issue003_config_deactivation_is_reversible_and_not_retirement(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            active = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "oldbox", "ssh_host": "oldbox", "self": False},
            ]
            self.write_config(config_path, machines=active)
            active_config = config_path.read_bytes()
            machine = load_machine_config(config_path).by_name["oldbox"]
            db_path = self.make_db(tmp_path / "oldbox.db", 10)
            meta = generation.build_generation_meta(
                db_path,
                machine_config_fingerprint=generation.machine_config_fingerprint(machine),
                source_host_identity="host-v1:" + "8" * 64,
                aliases=[],
                rate_limits={},
                exporter_commit="a" * 40,
                generated_at="2026-08-04T12:00:00Z",
            )
            generation.publish_generation("oldbox", db_path, meta, root=root)

            self.write_config(config_path, machines=active[:1])
            self.assertEqual(generation.admitted_generations(config_path=config_path, root=root), ())
            self.assertFalse((root / "retirements.json").exists())

            config_path.write_bytes(active_config)
            admitted = generation.admitted_generations(config_path=config_path, root=root)
            self.assertEqual(
                [item.generation_dir.parent.name for item in admitted],
                ["oldbox"],
            )

            result = subprocess.run(
                [str(Path(__file__).parents[1] / "tt-web"), "machines", "retire", "--help"],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertIn("Deleting a machine declaration only deactivates it", result.stdout)
            self.assertIn("Permanent retirement only happens through this command", result.stdout)

    def test_issue003_generation_backed_deactivated_machine_can_be_retired_directly(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            active = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "oldbox", "ssh_host": "oldbox", "self": False},
            ]
            self.write_config(config_path, machines=active)
            machine = load_machine_config(config_path).by_name["oldbox"]
            db_path = self.make_db(tmp_path / "oldbox.db", 10)
            meta = generation.build_generation_meta(
                db_path,
                machine_config_fingerprint=generation.machine_config_fingerprint(machine),
                source_host_identity="host-v1:" + "7" * 64,
                aliases=[],
                rate_limits={},
                exporter_commit="a" * 40,
                generated_at="2026-08-04T12:00:00Z",
            )
            generation.publish_generation("oldbox", db_path, meta, root=root)
            self.write_config(config_path, machines=active[:1])

            retired = generation.retire_machines(
                ["oldbox"], config_path=config_path, root=root
            )

            self.assertEqual(retired.retired_names, frozenset({"oldbox"}))
            self.assertEqual(
                json.loads((root / "retirements.json").read_text(encoding="utf-8"))[
                    "retired_names"
                ],
                ["oldbox"],
            )
            self.assertEqual(generation.admitted_generations(config_path=config_path, root=root), ())
            self.write_config(config_path, machines=active)
            with self.assertRaisesRegex(MachineConfigError, "persistently retired"):
                load_machine_config(config_path, retirement_root=root)

    def test_issue004_admission_deduplicates_self_certified_host_identity_not_locator_strings(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            machines = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "samebox", "ssh_host": "macbook.local", "self": False},
            ]
            self.write_config(config_path, machines=machines)
            config = load_machine_config(config_path)
            for machine in config.machines:
                db_path = self.make_db(tmp_path / f"{machine.name}.db", 10)
                meta = generation.build_generation_meta(
                    db_path,
                    machine_config_fingerprint=generation.machine_config_fingerprint(machine),
                    source_host_identity="host-v1:" + "1" * 64,
                    aliases=[],
                    rate_limits={},
                    exporter_commit="a" * 40,
                    generated_at="2026-08-04T12:00:00Z",
                )
                generation.publish_generation(machine.name, db_path, meta, root=root)

            admitted = generation.admitted_generations(config_path=config_path, root=root)
            self.assertEqual(len(admitted), 0)

    def test_issue004_distinct_self_certified_identities_admit_every_declared_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            machines = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "macmini", "ssh_host": "macmini", "self": False},
            ]
            self.write_config(config_path, machines=machines)
            config = load_machine_config(config_path)
            for index, machine in enumerate(config.machines, start=1):
                db_path = self.make_db(tmp_path / f"{machine.name}.db", 10)
                meta = generation.build_generation_meta(
                    db_path,
                    machine_config_fingerprint=generation.machine_config_fingerprint(machine),
                    source_host_identity="host-v1:" + str(index) * 64,
                    aliases=[],
                    rate_limits={},
                    exporter_commit="a" * 40,
                    generated_at="2026-08-04T12:00:00Z",
                )
                generation.publish_generation(machine.name, db_path, meta, root=root)

            admitted = generation.admitted_generations(config_path=config_path, root=root)
            self.assertEqual(len(config.machines), 2)
            self.assertEqual(len({item.meta["source_host_identity"] for item in admitted}), 2)
            self.assertEqual(len(admitted), 2)

    def test_cost_total_does_not_depend_on_the_summation_strategy(self):
        """metric_totals decides whether a transferred snapshot is the exported
        one, and the two sides run whatever python each machine has. Builtin
        sum() changed for floats in CPython 3.12, so an export from 3.9 and a
        check on 3.13 disagreed in the last place over identical rows and the
        transfer was rejected. The costs below are chosen so naive accumulation
        and exact summation give different answers."""
        costs = [1e16, 1.0, -1e16, 1.0]
        naive = 0.0
        for cost in costs:
            naive += cost
        # Spelled out rather than compared against builtin sum(), which on 3.12
        # and later already agrees with fsum -- the divergence this guards is
        # only visible from the older interpreters still in the fleet.
        self.assertNotEqual(naive, math.fsum(costs))

        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "snapshot.db"
            with closing(sqlite3.connect(db_path)) as conn, conn:
                conn.executescript(rollup.SCHEMA)
                conn.executemany(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model, input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens, cost_usd,
                      cost_known_count, entry_count, message_count
                    ) VALUES ('2026-08-04', 'codex', ?, 'gpt-5', 1, 2, 3, 4, ?, 1, 1, 1)
                    """,
                    [("p%d" % index, cost) for index, cost in enumerate(costs)],
                )
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) "
                    "VALUES ('bucket_timezone', 'Asia/Shanghai')"
                )

            self.assertEqual(
                generation.snapshot_stats(db_path)["metric_totals"]["cost"],
                math.fsum(costs),
            )

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
    def make_meta(snapshot, host_identity, generated_at="2026-08-04T12:00:00Z"):
        return generation.build_generation_meta(
            snapshot,
            machine_config_fingerprint="f" * 64,
            source_host_identity="host-v1:" + __import__("hashlib").sha256(host_identity.encode()).hexdigest(),
            aliases=[],
            rate_limits={},
            exporter_commit="a" * 40,
            generated_at=generated_at,
        )

    @staticmethod
    def input_total(path):
        with closing(sqlite3.connect(path)) as conn:
            return conn.execute("SELECT SUM(input_tokens) FROM daily_rollup").fetchone()[0]

    @staticmethod
    def write_config(path, machines=None, retired_names=None):
        if machines is None:
            machines = [{"name": "macbook", "ssh_host": "macbook", "self": True}]
        path.write_text(
            json.dumps({"machines": machines, "retired_names": retired_names or []}),
            encoding="utf-8",
        )


if __name__ == "__main__":
    unittest.main()
