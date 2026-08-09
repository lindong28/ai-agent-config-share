import json
import shutil
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest import mock

import generation
import rollup
from machine_config import load_machine_config


class SyncTests(unittest.TestCase):
    def test_remote_sync_uses_bounded_noninteractive_ssh_and_cleans_remote_temp(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            fixture = self.make_bundle(exporter, tmp_path / "fixture", 33, "d" * 40)
            source_manifest = self.read_manifest(fixture)
            machine = self.remote_machine(tmp_path)
            calls = []

            def runner(args, **kwargs):
                calls.append((args, kwargs))
                if args[0] == "ssh" and "find /tmp" in args[-1]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "ssh" and args[-1].startswith("mktemp"):
                    return subprocess.CompletedProcess(args, 0, "/tmp/tt-web-export.A1b2C3d4\n", "")
                if args[0] == "ssh" and "tt-web export --out" in args[-1]:
                    return subprocess.CompletedProcess(
                        args, 0, json.dumps(source_manifest) + "\n", ""
                    )
                if args[0] == "scp":
                    shutil.copytree(fixture, Path(args[-1]))
                return subprocess.CompletedProcess(args, 0, "", "")

            installed = sync.sync_machine(
                machine,
                root=root,
                runner=runner,
                timeout=30,
                accept_first_use_ssh_target=True,
            )

            self.assertEqual(installed.meta["row_count"], 1)
            self.assertTrue(all(call[1]["timeout"] <= 30 for call in calls))
            self.assertIn("find /tmp", calls[0][0][-1])
            self.assertEqual(
                calls[1][0][:7],
                ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "builder"],
            )
            self.assertIn("~/.local/bin/tt-web export --out", calls[2][0][-1])
            self.assertEqual(calls[3][0][0], "scp")
            self.assertEqual(calls[-1][0][-1], "rm -rf -- /tmp/tt-web-export.A1b2C3d4")

    def test_remote_cleanup_has_an_independent_budget_after_the_main_deadline_fails(self):
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            machine = self.remote_machine(Path(tmp))
            calls = []

            def runner(args, **kwargs):
                calls.append((args, kwargs))
                if args[0] == "ssh" and "find /tmp" in args[-1]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "ssh" and args[-1].startswith("mktemp"):
                    return subprocess.CompletedProcess(
                        args, 0, "/tmp/tt-web-export.A1b2C3d4\n", ""
                    )
                if args[0] == "ssh" and "tt-web export --out" in args[-1]:
                    raise subprocess.TimeoutExpired(args, kwargs["timeout"])
                return subprocess.CompletedProcess(args, 0, "", "")

            with self.assertRaises(subprocess.TimeoutExpired):
                sync.sync_machine(
                    machine,
                    root=Path(tmp) / "generations",
                    runner=runner,
                    timeout=0.01,
                )

            cleanup = calls[-1]
            self.assertEqual(cleanup[0][-1], "rm -rf -- /tmp/tt-web-export.A1b2C3d4")
            self.assertEqual(cleanup[1]["timeout"], 10)

    def test_remote_sync_rejects_a_bundle_that_does_not_match_export_stdout(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            source_bundle = self.make_bundle(
                exporter, tmp_path / "source", 10, "a" * 40
            )
            received_bundle = self.make_bundle(
                exporter, tmp_path / "received", 20, "b" * 40
            )
            source_manifest = self.read_manifest(source_bundle)
            machine = self.remote_machine(tmp_path)

            def runner(args, **kwargs):
                if args[0] == "ssh" and "find /tmp" in args[-1]:
                    return subprocess.CompletedProcess(args, 0, "", "")
                if args[0] == "ssh" and args[-1].startswith("mktemp"):
                    return subprocess.CompletedProcess(
                        args, 0, "/tmp/tt-web-export.A1b2C3d4\n", ""
                    )
                if args[0] == "ssh" and "tt-web export --out" in args[-1]:
                    return subprocess.CompletedProcess(
                        args, 0, json.dumps(source_manifest) + "\n", ""
                    )
                if args[0] == "scp":
                    shutil.copytree(received_bundle, Path(args[-1]))
                return subprocess.CompletedProcess(args, 0, "", "")

            with self.assertRaisesRegex(sync.TransferValidationError, "transfer_digest"):
                sync.sync_machine(
                    machine,
                    root=root,
                    runner=runner,
                    timeout=30,
                    accept_first_use_ssh_target=True,
                )

            self.assertIsNone(generation.read_current_generation("macbook", root=root))

    def test_sync_all_keeps_other_machine_results_when_one_machine_times_out(self):
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            config_path = tmp_path / "machines.json"
            config_path.write_text(
                json.dumps(
                    {
                        "machines": [
                            {"name": "macbook", "ssh_host": "macbook", "self": True},
                            {"name": "dgx", "ssh_host": "dgx", "self": False},
                        ],
                        "retired_names": [],
                    }
                ),
                encoding="utf-8",
            )
            sentinel = object()

            def fake_sync(machine, **kwargs):
                if machine.name == "macbook":
                    return sentinel
                raise subprocess.TimeoutExpired("ssh", 30)

            with mock.patch.object(sync, "sync_machine", side_effect=fake_sync):
                results = sync.sync_all(config_path=config_path, root=tmp_path / "generations")

            self.assertIs(results["macbook"].generation, sentinel)
            self.assertIsNone(results["macbook"].error)
            self.assertIsNone(results["dgx"].generation)
            self.assertEqual(results["dgx"].error, "timeout")

    def test_transfer_digest_oracle_rejects_tampering_without_switching_current(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            self.write_config(config_path)
            machine = load_machine_config(config_path).self_machine
            first_bundle = self.make_bundle(exporter, tmp_path / "first", 10, "a" * 40)
            first_manifest = self.read_manifest(first_bundle)
            first = sync.install_export_bundle(
                machine,
                first_bundle,
                expected_manifest=first_manifest,
                accept_first_use=True,
                root=root,
            )
            before = (root / "macbook" / "current").read_bytes()

            second_bundle = self.make_bundle(exporter, tmp_path / "second", 20, "b" * 40)
            second_manifest = self.read_manifest(second_bundle)
            with closing(sqlite3.connect(second_bundle / "snapshot.db")) as conn, conn:
                conn.execute("UPDATE daily_rollup SET input_tokens = 999")

            with self.assertRaisesRegex(sync.TransferValidationError, "transfer_digest"):
                sync.install_export_bundle(
                    machine,
                    second_bundle,
                    expected_manifest=second_manifest,
                    root=root,
                )

            self.assertEqual((root / "macbook" / "current").read_bytes(), before)
            self.assertEqual(
                generation.read_current_generation("macbook", root=root).meta["generation_id"],
                first.meta["generation_id"],
            )

    def test_install_export_bundle_preserves_export_identity_and_snapshot_digest(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            self.write_config(config_path)
            machine = load_machine_config(config_path).self_machine
            bundle = self.make_bundle(exporter, tmp_path / "bundle", 42, "c" * 40)
            manifest = self.read_manifest(bundle)

            installed = sync.install_export_bundle(
                machine,
                bundle,
                expected_manifest=manifest,
                accept_first_use=True,
                root=root,
            )

            self.assertEqual(installed.meta["source_host_identity"], manifest["source_host_identity"])
            self.assertEqual(installed.meta["exporter_commit"], manifest["exporter_commit"])
            self.assertEqual(installed.meta["transfer_digest"], manifest["transfer_digest"])
            self.assertEqual(installed.meta["row_count"], 1)
            self.assertEqual(installed.meta["aliases"], [])

    def test_sender_manifest_is_bound_to_the_received_bundle_not_replaced_by_self_consistency(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            self.write_config(config_path)
            machine = load_machine_config(config_path).self_machine
            bundle = self.make_bundle(exporter, tmp_path / "bundle", 42, "c" * 40)
            sender_manifest = self.read_manifest(bundle)
            replaced = dict(sender_manifest)
            replaced["rate_limits"] = {"codex": {"updated_at": "2026-08-04T12:01:00Z"}}
            replaced["manifest_digest"] = exporter.manifest_digest(replaced)
            (bundle / "export.json").write_text(
                json.dumps(replaced, sort_keys=True, separators=(",", ":")) + "\n",
                encoding="utf-8",
            )

            with self.assertRaisesRegex(sync.TransferValidationError, "sending exporter"):
                sync.install_export_bundle(
                    machine,
                    bundle,
                    expected_manifest=sender_manifest,
                    root=root,
                )

            self.assertIsNone(generation.read_current_generation("macbook", root=root))

    def test_machine_slot_requires_explicit_tofu_acceptance_and_rejects_later_drift(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            self.write_config(config_path)
            machine = load_machine_config(config_path).self_machine
            first_identity = "host-v1:" + "4" * 64
            first_bundle = self.make_bundle(
                exporter, tmp_path / "first", 10, "a" * 40, identity=first_identity
            )
            first_manifest = self.read_manifest(first_bundle)

            with self.assertRaisesRegex(
                sync.TransferValidationError,
                "same machine on later syncs, not that the SSH alias points to the intended machine",
            ):
                sync.install_export_bundle(
                    machine,
                    first_bundle,
                    expected_manifest=first_manifest,
                    root=root,
                )
            self.assertIsNone(generation.read_current_generation("macbook", root=root))

            first = sync.install_export_bundle(
                machine,
                first_bundle,
                expected_manifest=first_manifest,
                accept_first_use=True,
                root=root,
            )
            before = (root / "macbook" / "current").read_bytes()

            second_identity = "host-v1:" + "5" * 64
            second_bundle = self.make_bundle(
                exporter, tmp_path / "second", 20, "b" * 40, identity=second_identity
            )
            second_manifest = self.read_manifest(second_bundle)
            with self.assertRaisesRegex(sync.TransferValidationError, "pinned"):
                sync.install_export_bundle(
                    machine,
                    second_bundle,
                    expected_manifest=second_manifest,
                    root=root,
                )

            self.assertEqual((root / "macbook" / "current").read_bytes(), before)
            self.assertEqual(
                generation.read_current_generation("macbook", root=root).meta["generation_id"],
                first.meta["generation_id"],
            )

    def test_candidate_manifest_identity_cannot_authorize_first_use(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            machine = self.remote_machine(tmp_path)
            bundle = self.make_bundle(exporter, tmp_path / "bundle", 10, "a" * 40)
            manifest = self.read_manifest(bundle)

            with self.assertRaises(TypeError):
                sync.install_export_bundle(
                    machine,
                    bundle,
                    expected_manifest=manifest,
                    expected_source_identity=manifest["source_host_identity"],
                    root=root,
                )

            self.assertIsNone(generation.read_current_generation("remote", root=root))

    def test_sync_recovers_pending_publication_before_a_new_export_can_fail(self):
        import exporter
        import sync

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            root = tmp_path / "generations"
            config_path = tmp_path / "machines.json"
            self.write_config(config_path)
            machine = load_machine_config(config_path).self_machine
            published = []
            for index, tokens in enumerate((10, 20, 30), start=1):
                snapshot = self.make_db(tmp_path / ("source-%d.db" % index), tokens)
                current = generation.publish_generation(
                    "macbook",
                    snapshot,
                    generation.build_generation_meta(
                        snapshot,
                        machine_config_fingerprint=generation.machine_config_fingerprint(machine),
                        source_host_identity="host-v1:" + "4" * 64,
                        aliases=[],
                        rate_limits={},
                        exporter_commit="a" * 40,
                        generated_at="2026-08-04T12:0%d:00Z" % index,
                    ),
                    root=root,
                )
                published.append(current.meta["generation_id"])

            machine_dir = root / "macbook"
            generation._atomic_write_text(machine_dir / "previous", published[0] + "\n")
            generation._atomic_write_json(
                machine_dir / ".publication-pending.json",
                {
                    "schema_version": 1,
                    "old_generation_id": published[1],
                    "new_generation_id": published[2],
                },
            )

            with mock.patch(
                "sync.exporter.export_bundle",
                side_effect=exporter.ExportError("new export failed"),
            ):
                with self.assertRaisesRegex(exporter.ExportError, "new export failed"):
                    sync.sync_machine(machine, root=root)

            self.assertEqual((machine_dir / "previous").read_text().strip(), published[1])
            self.assertFalse((machine_dir / ".publication-pending.json").exists())

    @staticmethod
    def make_bundle(exporter, bundle, input_tokens, commit, *, identity=None):
        source = bundle.with_suffix(".db")
        SyncTests.make_db(source, input_tokens)
        with mock.patch("exporter.exporter_version", return_value=commit):
            exporter.export_bundle(
                source,
                bundle,
                refresh=False,
                source_host_identity=identity or "host-v1:" + "4" * 64,
                generated_at="2026-08-04T12:00:00Z",
                rate_limits={},
            )
        return bundle

    @staticmethod
    def make_db(source, input_tokens):
        with closing(sqlite3.connect(source)) as conn, conn:
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
        return source

    @staticmethod
    def read_manifest(bundle):
        return json.loads((bundle / "export.json").read_text(encoding="utf-8"))

    @staticmethod
    def write_config(path):
        path.write_text(
            json.dumps(
                {
                    "machines": [
                        {"name": "macbook", "ssh_host": "macbook", "self": True}
                    ],
                    "retired_names": [],
                }
            ),
            encoding="utf-8",
        )

    @staticmethod
    def remote_machine(tmp_path):
        config_path = tmp_path / "remote-machines.json"
        config_path.write_text(
            json.dumps(
                {
                    "machines": [
                        {"name": "macbook", "ssh_host": "macbook", "self": True},
                        {"name": "remote", "ssh_host": "builder", "self": False},
                    ],
                    "retired_names": [],
                }
            ),
            encoding="utf-8",
        )
        return load_machine_config(config_path).by_name["remote"]


if __name__ == "__main__":
    unittest.main()
