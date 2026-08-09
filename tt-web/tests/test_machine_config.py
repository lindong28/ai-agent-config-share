import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from machine_config import (
    MachineConfigError,
    admit_machine,
    load_machine_config,
    machine_config_fingerprint,
)


class MachineConfigTests(unittest.TestCase):
    def test_tracked_config_declares_one_self_and_two_remotes(self):
        config = load_machine_config()

        self.assertEqual([machine.name for machine in config.machines], ["macbook", "macmini", "gpu-box"])
        self.assertEqual(config.self_machine.name, "macbook")
        self.assertEqual(config.retired_names, frozenset())

    def test_admission_identity_axis_rejects_duplicate_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(
                path,
                [
                    {"name": "macbook", "ssh_host": "macbook", "self": True},
                    {"name": "macbook", "ssh_host": "other", "self": False},
                ],
            )

            with self.assertRaisesRegex(MachineConfigError, "duplicate machine name"):
                load_machine_config(path)

    def test_generation_directory_axis_rejects_case_only_machine_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(
                path,
                [
                    {"name": "macbook", "ssh_host": "macbook", "self": True},
                    {"name": "MacBook", "ssh_host": "macmini", "self": False},
                ],
            )

            with self.assertRaisesRegex(MachineConfigError, "lowercase ASCII slug"):
                load_machine_config(path)

    def test_generation_directory_axis_rejects_unsafe_path_components(self):
        unsafe_names = ("../macbook", "mac/book", ".macbook", "macbook.", "mácbook")
        for name in unsafe_names:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "machines.json"
                self.write_config(path, [{"name": name, "ssh_host": "macbook", "self": True}])

                with self.assertRaisesRegex(MachineConfigError, "lowercase ASCII slug"):
                    load_machine_config(path)

    def test_pull_target_axis_rejects_duplicate_ssh_host(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(
                path,
                [
                    {"name": "first", "ssh_host": "same-target", "self": True},
                    {"name": "second", "ssh_host": "same-target", "self": False},
                ],
            )

            with self.assertRaisesRegex(MachineConfigError, "duplicate ssh_host"):
                load_machine_config(path)

    def test_pull_target_axis_rejects_casefolded_ssh_host_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(
                path,
                [
                    {"name": "first", "ssh_host": "SharedTarget", "self": True},
                    {"name": "second", "ssh_host": "sharedtarget", "self": False},
                ],
            )

            with self.assertRaisesRegex(MachineConfigError, "duplicate ssh_host"):
                load_machine_config(path)

    def test_data_source_role_axis_requires_exactly_one_self(self):
        cases = {
            "zero": [
                {"name": "macbook", "ssh_host": "macbook", "self": False},
                {"name": "macmini", "ssh_host": "macmini", "self": False},
            ],
            "multiple": [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "macmini", "ssh_host": "macmini", "self": True},
            ],
        }
        for label, machines in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "machines.json"
                self.write_config(path, machines)

                with self.assertRaisesRegex(MachineConfigError, "exactly one self machine"):
                    load_machine_config(path)

    def test_fingerprint_is_sha256_of_canonical_machine_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            machine_payload = {"name": "macbook", "ssh_host": "macbook", "self": True}
            self.write_config(path, [machine_payload])
            machine = load_machine_config(path).self_machine
            canonical = json.dumps(machine_payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True)

            self.assertEqual(
                machine_config_fingerprint(machine),
                hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            )

    def test_ssh_host_change_excludes_old_generation_until_new_publish_after_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(path, [{"name": "macbook", "ssh_host": "old-alias", "self": True}])
            before_restart = load_machine_config(path)
            old_fingerprint = machine_config_fingerprint(before_restart.self_machine)

            self.write_config(path, [{"name": "macbook", "ssh_host": "new-alias", "self": True}])
            after_restart = load_machine_config(path)
            new_fingerprint = machine_config_fingerprint(after_restart.self_machine)

            self.assertIsNone(admit_machine(after_restart, "macbook", old_fingerprint))
            self.assertEqual(admit_machine(after_restart, "macbook", new_fingerprint), after_restart.self_machine)

    def test_self_migration_excludes_both_old_generations_until_republished(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            before = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "macmini", "ssh_host": "macmini", "self": False},
            ]
            self.write_config(path, before)
            old_config = load_machine_config(path)
            old_fingerprints = {
                machine.name: machine_config_fingerprint(machine) for machine in old_config.machines
            }

            after = [
                {"name": "macbook", "ssh_host": "macbook", "self": False},
                {"name": "macmini", "ssh_host": "macmini", "self": True},
            ]
            self.write_config(path, after)
            restarted_config = load_machine_config(path)

            for machine in restarted_config.machines:
                with self.subTest(machine=machine.name):
                    self.assertIsNone(
                        admit_machine(restarted_config, machine.name, old_fingerprints[machine.name])
                    )
                    new_fingerprint = machine_config_fingerprint(machine)
                    self.assertEqual(
                        admit_machine(restarted_config, machine.name, new_fingerprint),
                        machine,
                    )

    def test_process_restart_reloads_config_and_keeps_admission_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            self.write_config(path, [{"name": "macbook", "ssh_host": "old-alias", "self": True}])
            old_fingerprint = machine_config_fingerprint(load_machine_config(path).self_machine)
            self.write_config(path, [{"name": "macbook", "ssh_host": "new-alias", "self": True}])
            new_fingerprint = machine_config_fingerprint(load_machine_config(path).self_machine)

            self.assertEqual(self.admission_in_fresh_process(path, old_fingerprint), "excluded")
            self.assertEqual(self.admission_in_fresh_process(path, new_fingerprint), "admitted")

    def test_retired_name_cannot_be_reactivated_and_old_generation_is_not_admitted(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            active = [
                {"name": "macbook", "ssh_host": "macbook", "self": True},
                {"name": "oldbox", "ssh_host": "oldbox", "self": False},
            ]
            self.write_config(path, active)
            old_config = load_machine_config(path)
            oldbox = old_config.by_name["oldbox"]
            old_fingerprint = machine_config_fingerprint(oldbox)

            self.write_config(
                path,
                [{"name": "macbook", "ssh_host": "macbook", "self": True}],
                retired_names=["oldbox"],
            )
            retired_config = load_machine_config(path)
            self.assertIsNone(admit_machine(retired_config, "oldbox", old_fingerprint))

            self.write_config(path, active, retired_names=["oldbox"])
            with self.assertRaisesRegex(MachineConfigError, "retired machine name"):
                load_machine_config(path)

    def test_unknown_fields_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            payload = {
                "machines": [
                    {"name": "macbook", "ssh_host": "macbook", "self": True, "enabled": True}
                ],
                "retired_names": [],
            }
            path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaisesRegex(MachineConfigError, "unknown machine fields"):
                load_machine_config(path)

    def test_duplicate_json_object_key_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "machines.json"
            path.write_text(
                '{"machines":[{"name":"macbook","ssh_host":"macbook","self":true,"self":false}],'
                '"retired_names":[]}',
                encoding="utf-8",
            )

            with self.assertRaisesRegex(MachineConfigError, "duplicate JSON object key"):
                load_machine_config(path)

    @staticmethod
    def write_config(path, machines, retired_names=None):
        payload = {"machines": machines, "retired_names": retired_names or []}
        path.write_text(json.dumps(payload), encoding="utf-8")

    @staticmethod
    def admission_in_fresh_process(path, fingerprint):
        code = (
            "from machine_config import admit_machine, load_machine_config; "
            "import sys; "
            "config = load_machine_config(sys.argv[1]); "
            "print('admitted' if admit_machine(config, 'macbook', sys.argv[2]) else 'excluded')"
        )
        completed = subprocess.run(
            [sys.executable, "-c", code, str(path), fingerprint],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            check=True,
        )
        return completed.stdout.strip()


if __name__ == "__main__":
    unittest.main()
