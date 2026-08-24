import contextlib
import hashlib
import http.client
import json
import socket
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import generation
import rollup
import server
import sync
from machine_config import Machine, machine_config_fingerprint


class AccountMemoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.memory_path = Path(self.temporary.name) / "state" / "account_memory.json"
        self.path_patcher = mock.patch("server._ACCOUNT_MEMORY_PATH", self.memory_path)
        self.path_patcher.start()
        self.addCleanup(self.path_patcher.stop)
        server._reset_sync_state_for_tests()
        self.addCleanup(server._reset_sync_state_for_tests)

    def test_overview_remembers_every_known_account_once(self):
        admission = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T07:52:00Z", 38, "claude-a"),
                codex=self.limit("2026-08-20T07:50:00", 52, "codex-a"),
            ),
            self.current(
                "macmini",
                claude=self.limit("2026-08-20T07:53:00+00:00", 39, "claude-a"),
                codex=self.limit("2026-08-20T07:51:00Z", 61, "codex-b"),
            ),
            self.current(
                "legacy",
                codex=self.limit("2026-08-20T07:54:00Z", 70, None, stamped=False),
            ),
        )

        limits = server._rate_limits(admission=admission)
        first_bytes = self.memory_path.read_bytes()
        first_mtime = self.memory_path.stat().st_mtime_ns
        time.sleep(0.01)
        server._rate_limits(admission=admission)

        payload = json.loads(first_bytes)
        self.assertEqual(payload["version"], 1)
        self.assertEqual(
            set(payload["accounts"]),
            {"claude:claude-a", "codex:codex-a", "codex:codex-b"},
        )
        self.assertEqual(
            payload["accounts"]["claude:claude-a"],
            {
                "provider": "claude",
                "account_id": "claude-a",
                "account_label": "claude-a@example.com",
                "account_plan": "plan-claude-a",
                "five_hour_used_pct": 39,
                "five_hour_resets_at": 100,
                "seven_day_used_pct": 40,
                "seven_day_resets_at": 200,
                "observed_at": "2026-08-20T07:53:00+00:00",
            },
        )
        for provider in ("claude", "codex"):
            for entry in limits[provider]["accounts"]:
                if entry["account_state"] != "known":
                    continue
                key = f"{provider}:{entry['account_id']}"
                self.assertEqual(
                    payload["accounts"][key],
                    {
                        "provider": provider,
                        "account_id": entry["account_id"],
                        "account_label": entry["account_label"],
                        "account_plan": entry["account_plan"],
                        "five_hour_used_pct": entry["five_hour_used_pct"],
                        "five_hour_resets_at": entry["five_hour_resets_at"],
                        "seven_day_used_pct": entry["seven_day_used_pct"],
                        "seven_day_resets_at": entry["seven_day_resets_at"],
                        "observed_at": server._observed_at(entry["updated_at"])
                        .astimezone(server.timezone.utc)
                        .isoformat(),
                    },
                )
        self.assertEqual(self.memory_path.read_bytes(), first_bytes)
        self.assertEqual(self.memory_path.stat().st_mtime_ns, first_mtime)

    def test_only_strictly_newer_observation_replaces_memory(self):
        newest = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 40, "claude-a"),
            )
        )
        server._rate_limits(admission=newest)
        expected = self.memory_path.read_bytes()

        for observed_at, pct in (
            ("2026-08-20T07:59:59Z", 99),
            ("2026-08-20T08:00:00", 98),
        ):
            with self.subTest(observed_at=observed_at):
                stale = self.admission(
                    self.current(
                        "macmini",
                        claude=self.limit(observed_at, pct, "claude-a"),
                    )
                )
                server._rate_limits(admission=stale)
                self.assertEqual(self.memory_path.read_bytes(), expected)

        later = self.admission(
            self.current(
                "macmini",
                claude=self.limit("2026-08-20T08:00:01Z", 41, "claude-a"),
            )
        )
        server._rate_limits(admission=later)
        remembered = json.loads(self.memory_path.read_bytes())["accounts"][
            "claude:claude-a"
        ]
        self.assertEqual(remembered["five_hour_used_pct"], 41)
        self.assertEqual(remembered["observed_at"], "2026-08-20T08:00:01+00:00")

    def test_overview_appends_every_absent_memory_record_with_frozen_values(self):
        self.write_memory(
            {
                "claude:claude-old": self.remembered_record(
                    "claude",
                    "claude-old",
                    "2026-08-20T07:00:00+00:00",
                    30,
                    label="shared@example.com",
                ),
                "claude:claude-new": self.remembered_record(
                    "claude",
                    "claude-new",
                    "2026-08-20T07:30:00+00:00",
                    40,
                    label="shared@example.com",
                ),
                "codex:codex-old": self.remembered_record(
                    "codex", "codex-old", "2026-08-20T07:15:00+00:00", 50
                ),
            }
        )
        admission = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 60, "claude-live"),
                codex=self.limit("2026-08-20T08:01:00Z", 70, "codex-live"),
            )
        )

        limits = server._rate_limits(admission=admission)

        self.assertEqual(
            [entry["account_id"] for entry in limits["claude"]["accounts"]],
            ["claude-live", "claude-new", "claude-old"],
        )
        self.assertEqual(
            [entry["account_id"] for entry in limits["codex"]["accounts"]],
            ["codex-live", "codex-old"],
        )
        entries = [
            (provider, entry)
            for provider in ("claude", "codex")
            for entry in limits[provider]["accounts"]
        ]
        self.assertEqual(
            {entry["presence"] for _, entry in entries},
            {"in_use", "remembered"},
        )
        remembered = {
            f"{provider}:{entry['account_id']}": entry
            for provider, entry in entries
            if entry["presence"] == "remembered"
        }
        live = {
            f"{provider}:{entry['account_id']}"
            for provider, entry in entries
            if entry["presence"] == "in_use" and entry["account_state"] == "known"
        }
        stored = set(json.loads(self.memory_path.read_bytes())["accounts"])
        self.assertEqual(set(remembered), stored - live)
        self.assertEqual(remembered["claude:claude-new"]["account_state"], "known")
        self.assertEqual(remembered["claude:claude-new"]["machines"], [])
        self.assertIsNone(remembered["claude:claude-new"]["this_machine"])
        self.assertEqual(
            remembered["claude:claude-new"]["updated_at"],
            "2026-08-20T07:30:00+00:00",
        )
        self.assertEqual(remembered["claude:claude-new"]["five_hour_used_pct"], 40)

    def test_remembered_account_returns_to_live_section_without_a_duplicate(self):
        self.write_memory(
            {
                "claude:claude-a": self.remembered_record(
                    "claude", "claude-a", "2026-08-20T07:00:00+00:00", 99
                )
            }
        )
        admission = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 40, "claude-a"),
            )
        )

        accounts = server._rate_limits(admission=admission)["claude"]["accounts"]

        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["account_id"], "claude-a")
        self.assertEqual(accounts[0]["presence"], "in_use")
        self.assertEqual(accounts[0]["five_hour_used_pct"], 40)
        self.assertEqual(accounts[0]["machines"], ["macbook"])

    def test_malformed_quota_values_cannot_escape_memory_or_break_overview_json(self):
        malformed_stored = self.remembered_record(
            "claude", "stored-bad", "2026-08-20T07:00:00+00:00", 30
        )
        malformed_stored.update(
            {
                "five_hour_used_pct": float("nan"),
                "five_hour_resets_at": "tomorrow",
                "seven_day_used_pct": float("inf"),
                "seven_day_resets_at": True,
            }
        )
        good_stored = self.remembered_record(
            "codex", "stored-good", "2026-08-20T07:01:00+00:00", 50
        )
        self.write_memory(
            {
                "claude:stored-bad": malformed_stored,
                "codex:stored-good": good_stored,
            }
        )
        malformed_live = self.limit(
            "2026-08-20T08:00:00Z", 40, "live-bad"
        )
        malformed_live.update(
            {
                "five_hour_pct": float("-inf"),
                "five_hour_resets_at": [100],
                "seven_day_pct": "41",
                "seven_day_resets_at": False,
            }
        )

        limits = server._rate_limits(
            admission=self.admission(self.current("macbook", claude=malformed_live))
        )

        json.dumps(limits, allow_nan=False)
        entries = {
            entry["account_id"]: entry
            for provider in ("claude", "codex")
            for entry in limits[provider]["accounts"]
        }
        for account_id in ("live-bad", "stored-bad"):
            self.assertEqual(
                [
                    entries[account_id]["five_hour_used_pct"],
                    entries[account_id]["five_hour_resets_at"],
                    entries[account_id]["seven_day_used_pct"],
                    entries[account_id]["seven_day_resets_at"],
                ],
                [None, None, None, None],
            )
        self.assertEqual(entries["stored-good"]["five_hour_used_pct"], 50)
        persisted = self.memory_path.read_text(encoding="utf-8")
        self.assertNotIn("NaN", persisted)
        self.assertNotIn("Infinity", persisted)
        self.assertEqual(
            [
                json.loads(persisted)["accounts"]["claude:live-bad"][field]
                for field in (
                    "five_hour_used_pct",
                    "five_hour_resets_at",
                    "seven_day_used_pct",
                    "seven_day_resets_at",
                )
            ],
            [None, None, None, None],
        )

    def test_unreadable_or_unsupported_memory_is_never_overwritten(self):
        live = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 40, "claude-a"),
            )
        )
        cases = {
            "invalid_json": b'{"version":1,"accounts":',
            "unsupported_version": b'{"version":2,"accounts":{}}\n',
        }

        for name, original in cases.items():
            with self.subTest(name=name):
                self.memory_path.parent.mkdir(parents=True, exist_ok=True)
                self.memory_path.write_bytes(original)
                with self.assertLogs("tt-web", level="WARNING") as logs:
                    limits = server._rate_limits(admission=live)
                self.assertEqual(limits["claude"]["accounts"][0]["account_id"], "claude-a")
                self.assertEqual(self.memory_path.read_bytes(), original)
                self.assertIn("account memory", "\n".join(logs.output).lower())

    def test_memory_write_failure_does_not_break_live_rate_limits(self):
        live = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 40, "claude-a"),
            )
        )

        with mock.patch(
            "server.generation._fsync_file", side_effect=PermissionError("read-only state")
        ), self.assertLogs("tt-web", level="WARNING") as logs:
            limits = server._rate_limits(admission=live)

        self.assertEqual(limits["claude"]["accounts"][0]["account_id"], "claude-a")
        self.assertIn("read-only state", "\n".join(logs.output))

    def test_pivot_sync_publish_remembers_account_before_later_signed_out_publish(self):
        generations_root = Path(self.temporary.name) / "generations"
        config_path = Path(self.temporary.name) / "machines.json"
        machine = Machine("macbook", "macbook", True)
        config_path.write_text(
            json.dumps(
                {
                    "machines": [machine.as_config_dict()],
                    "retired_names": [],
                }
            ),
            encoding="utf-8",
        )
        real_admission_snapshot = generation.generation_admission_snapshot
        published_ids = []

        def admission_snapshot():
            return real_admission_snapshot(config_path=config_path, root=generations_root)

        def sync_all():
            round_number = len(published_ids) + 1
            source = Path(self.temporary.name) / f"source-{round_number}.db"
            self.make_generation_db(source, round_number)
            account_id = "claude-a" if round_number == 1 else None
            observed_at = (
                "2026-08-20T08:00:00Z"
                if round_number == 1
                else "2026-08-20T08:01:00Z"
            )
            meta = generation.build_generation_meta(
                source,
                machine_config_fingerprint=machine_config_fingerprint(machine),
                source_host_identity="host-v1:"
                + hashlib.sha256(machine.name.encode()).hexdigest(),
                aliases=[],
                rate_limits={
                    "claude": self.limit(observed_at, 40, account_id),
                },
                exporter_commit="a" * 40,
                generated_at=observed_at,
            )
            current = generation.publish_generation(
                machine.name,
                source,
                meta,
                root=generations_root,
                now=datetime(2026, 8, 20, 8, round_number - 1, tzinfo=timezone.utc),
            )
            published_ids.append(current.meta["generation_id"])
            return {machine.name: sync.SyncResult(generation=current)}

        with mock.patch(
            "server.generation.generation_admission_snapshot",
            side_effect=admission_snapshot,
        ), mock.patch("server.sync.sync_all", side_effect=sync_all), mock.patch(
            "server.rollup.query_pivot", return_value={"columns": [], "rows": []}
        ):
            server.pivot_endpoint({"force": ["1"]})
            self.wait_for_sync()
            self.assertIn(
                "claude:claude-a", json.loads(self.memory_path.read_bytes())["accounts"]
            )
            first_pointer = (
                generations_root / machine.name / "current"
            ).read_text(encoding="utf-8").strip()
            self.assertEqual(first_pointer, published_ids[0])
            with real_admission_snapshot(
                config_path=config_path, root=generations_root
            ) as admission:
                self.assertEqual(
                    admission.admitted[0].meta["rate_limits"]["claude"]["account_id"],
                    "claude-a",
                )

            server.pivot_endpoint({"force": ["1"]})
            self.wait_for_sync()

            second_pointer = (
                generations_root / machine.name / "current"
            ).read_text(encoding="utf-8").strip()
            self.assertEqual(second_pointer, published_ids[1])
            self.assertNotEqual(second_pointer, first_pointer)
            with real_admission_snapshot(
                config_path=config_path, root=generations_root
            ) as admission:
                self.assertIsNone(
                    admission.admitted[0].meta["rate_limits"]["claude"]["account_id"]
                )

        remembered = json.loads(self.memory_path.read_bytes())["accounts"]
        self.assertEqual(set(remembered), {"claude:claude-a"})

    def test_remove_endpoint_guards_and_success_contract(self):
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )

        cases = (
            (
                "live account",
                self.admission(
                    self.current(
                        "macbook",
                        claude=self.limit(
                            "2026-08-20T08:00:00Z", 25, "claude-old"
                        ),
                    )
                ),
                409,
                "macbook",
            ),
            (
                "unstamped machine",
                self.admission(
                    self.current(
                        "legacy",
                        claude=self.limit(
                            "2026-08-20T08:00:00Z", 25, None, stamped=False
                        ),
                    )
                ),
                409,
                "legacy",
            ),
            (
                "malformed account id",
                self.admission(
                    self.current(
                        "malformed",
                        claude=dict(
                            self.limit(
                                "2026-08-20T08:00:00Z", 25, None, stamped=True
                            ),
                            account_id="",
                        ),
                    )
                ),
                409,
                "malformed",
            ),
        )
        for name, admission, expected_status, expected_machine in cases:
            with self.subTest(name=name):
                self.write_memory({"claude:claude-old": target})
                before = self.memory_path.read_bytes()

                status, payload = self.post_remove(admission)

                self.assertEqual(status, expected_status)
                self.assertIn(expected_machine, payload["error"])
                self.assertIn(expected_machine, payload["machines"])
                self.assertEqual(self.memory_path.read_bytes(), before)
                if name == "malformed account id":
                    entry = server._live_rate_limits_from_admission(admission)[
                        "claude"
                    ]["accounts"][0]
                    self.assertEqual(entry["account_state"], "unstamped")

        with self.subTest("signed out does not block deletion"):
            target_without_label = dict(target, account_label=None)
            self.write_memory({"claude:claude-old": target_without_label})
            admission = self.admission(
                self.current(
                    "macbook",
                    claude=self.limit(
                        "2026-08-20T08:00:00Z", 25, None, stamped=True
                    ),
                )
            )

            status, payload = self.post_remove(admission)

            self.assertEqual(status, 200)
            self.assertEqual(set(payload), {"account_label", "observed_at"})
            self.assertIsNone(payload["account_label"])
            self.assertEqual(payload["observed_at"], target["observed_at"])
            self.assertIsNotNone(server._observed_at(payload["observed_at"]))
            self.assertNotIn(
                "claude:claude-old",
                json.loads(self.memory_path.read_bytes())["accounts"],
            )

        with self.subTest("missing memory key"):
            self.write_memory({"claude:claude-old": target})
            before = self.memory_path.read_bytes()

            status, payload = self.post_remove(
                self.admission(), account_id="not-remembered"
            )

            self.assertEqual(status, 404)
            self.assertIn("not found", payload["error"].lower())
            self.assertEqual(self.memory_path.read_bytes(), before)

        with self.subTest("record changed after confirmation"):
            changed = dict(
                target,
                observed_at="2026-08-20T09:00:00+00:00",
                seven_day_used_pct=88,
            )
            self.write_memory({"claude:claude-old": changed})
            before = self.memory_path.read_bytes()

            status, payload = self.post_remove(
                self.admission(), observed_at=target["observed_at"]
            )

            self.assertEqual(status, 409)
            self.assertIn("changed", payload["error"].lower())
            self.assertIn("refresh", payload["error"].lower())
            self.assertEqual(self.memory_path.read_bytes(), before)

        with self.subTest("content type is required input validation"):
            self.write_memory({"claude:claude-old": target})
            before = self.memory_path.read_bytes()

            status, payload = self.post_remove(
                self.admission(), content_type=None
            )

            self.assertEqual(status, 400)
            self.assertIn("application/json", payload["error"])
            self.assertEqual(self.memory_path.read_bytes(), before)

        with self.subTest("observed record identity is required"):
            self.write_memory({"claude:claude-old": target})
            before = self.memory_path.read_bytes()

            status, payload = self.post_remove(
                self.admission(), observed_at=None
            )

            self.assertEqual(status, 400)
            self.assertIn("observed_at", payload["error"])
            self.assertEqual(self.memory_path.read_bytes(), before)

    def test_negative_content_length_returns_json_400_without_waiting_for_eof(self):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        client = socket.create_connection(
            ("127.0.0.1", httpd.server_port), timeout=1
        )
        client.settimeout(0.5)
        try:
            client.sendall(
                b"POST /api/account-memory/remove HTTP/1.1\r\n"
                b"Host: 127.0.0.1\r\n"
                b"Content-Type: application/json\r\n"
                b"Content-Length: -1\r\n"
                b"Connection: close\r\n"
                b"\r\n"
            )
            response = http.client.HTTPResponse(client)
            response.begin()
            with response:
                self.assertEqual(response.status, 400)
                self.assertEqual(
                    json.load(response),
                    {"error": "Request body must be valid JSON"},
                )
        finally:
            client.close()
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)

    def test_remove_endpoint_persist_failure_has_no_success_receipt(self):
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        self.write_memory({"claude:claude-old": target})
        before = self.memory_path.read_bytes()

        with mock.patch(
            "server._write_account_memory", side_effect=OSError("disk full")
        ):
            status, payload = self.post_remove(self.admission())

        self.assertGreaterEqual(status, 400)
        self.assertNotIn("account_label", payload)
        self.assertNotIn("observed_at", payload)
        self.assertEqual(self.memory_path.read_bytes(), before)

    def test_remove_and_overview_share_one_lock_in_both_orders(self):
        target_key = "claude:claude-old"
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        overview_admission = self.admission(
            self.current(
                "macbook",
                codex=self.limit("2026-08-20T08:00:00Z", 40, "codex-live"),
            )
        )
        delete_live = server._live_rate_limits_from_admission(self.admission())

        for first_name in ("overview", "remove"):
            with self.subTest(first=first_name):
                self.write_memory({target_key: target})
                lock = self.CoordinatedLock(first_name)
                errors = []

                def run(name, action):
                    try:
                        action()
                    except BaseException as exc:
                        errors.append((name, exc))

                actions = {
                    "overview": lambda: server._rate_limits(
                        admission=overview_admission
                    ),
                    "remove": lambda: server._remove_account_memory(
                        "claude",
                        "claude-old",
                        target["observed_at"],
                        delete_live,
                    ),
                }
                second_name = "remove" if first_name == "overview" else "overview"
                with mock.patch("server._ACCOUNT_MEMORY_LOCK", lock):
                    first = threading.Thread(
                        target=run,
                        args=(first_name, actions[first_name]),
                        name=first_name,
                    )
                    second = threading.Thread(
                        target=run,
                        args=(second_name, actions[second_name]),
                        name=second_name,
                    )
                    first.start()
                    self.assertTrue(lock.first_entered.wait(1))
                    second.start()
                    self.assertTrue(lock.second_attempted.wait(1))
                    self.assertTrue(second.is_alive())
                    lock.release_first.set()
                    first.join(2)
                    second.join(2)

                self.assertFalse(first.is_alive())
                self.assertFalse(second.is_alive())
                self.assertEqual(errors, [])
                accounts = json.loads(self.memory_path.read_bytes())["accounts"]
                self.assertNotIn(target_key, accounts)

    def test_remove_rejects_an_upsert_candidate_derived_before_delete(self):
        target_key = "claude:claude-old"
        unrelated_key = "codex:codex-b"
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        stale_overview = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:00:00Z", 40, "claude-old"),
                codex=self.limit("2026-08-20T09:00:00Z", 50, "codex-b"),
            )
        )
        signed_out = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:01:00Z", 0, None, stamped=True),
            )
        )
        self.write_memory({target_key: target})
        candidate_derived = threading.Event()
        allow_upsert = threading.Event()
        original_upsert = server._upsert_account_memory
        errors = []

        def delayed_upsert(*args, **kwargs):
            candidate_derived.set()
            if not allow_upsert.wait(2):
                raise TimeoutError("test did not release the derived upsert candidate")
            return original_upsert(*args, **kwargs)

        def load_stale_overview():
            try:
                server._rate_limits(admission=stale_overview)
            except BaseException as exc:
                errors.append(exc)

        with mock.patch("server._upsert_account_memory", side_effect=delayed_upsert):
            overview_thread = threading.Thread(target=load_stale_overview)
            overview_thread.start()
            self.assertTrue(candidate_derived.wait(1))

            status, _ = self.post_remove(signed_out)
            self.assertEqual(status, 200)
            self.assertNotIn(
                target_key, json.loads(self.memory_path.read_bytes())["accounts"]
            )

            allow_upsert.set()
            overview_thread.join(2)

        self.assertFalse(overview_thread.is_alive())
        self.assertEqual(errors, [])
        accounts = json.loads(self.memory_path.read_bytes())["accounts"]
        self.assertNotIn(target_key, accounts)
        self.assertEqual(
            accounts[unrelated_key]["observed_at"],
            "2026-08-20T09:00:00+00:00",
        )

    def test_remove_rejects_a_sync_candidate_derived_before_delete(self):
        target_key = "claude:claude-old"
        unrelated_key = "codex:codex-b"
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        stale_sync = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:00:00Z", 40, "claude-old"),
                codex=self.limit("2026-08-20T09:00:00Z", 50, "codex-b"),
            )
        )
        signed_out = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:01:00Z", 0, None, stamped=True),
            )
        )
        self.write_memory({target_key: target})
        candidate_derived = threading.Event()
        allow_upsert = threading.Event()
        original_remember = server._remember_rate_limit_accounts
        errors = []

        def delayed_remember(*args, **kwargs):
            candidate_derived.set()
            if not allow_upsert.wait(2):
                raise TimeoutError("test did not release the derived sync candidate")
            return original_remember(*args, **kwargs)

        def remember_stale_sync():
            try:
                server._remember_accounts_after_sync_publish()
            except BaseException as exc:
                errors.append(exc)

        with mock.patch(
            "server.generation.generation_admission_snapshot",
            side_effect=lambda: contextlib.nullcontext(stale_sync),
        ), mock.patch(
            "server._remember_rate_limit_accounts", side_effect=delayed_remember
        ):
            sync_thread = threading.Thread(target=remember_stale_sync)
            sync_thread.start()
            self.assertTrue(candidate_derived.wait(1))

            status, _ = self.post_remove(signed_out)
            self.assertEqual(status, 200)
            allow_upsert.set()
            sync_thread.join(2)

        self.assertFalse(sync_thread.is_alive())
        self.assertEqual(errors, [])
        accounts = json.loads(self.memory_path.read_bytes())["accounts"]
        self.assertNotIn(target_key, accounts)
        self.assertEqual(
            accounts[unrelated_key]["observed_at"],
            "2026-08-20T09:00:00+00:00",
        )

    def test_admission_processed_after_delete_is_remembered(self):
        # This does not distinguish whether admission was obtained before or
        # after the delete; its tombstone may already be GC'd when epoch registration runs.
        target_key = "claude:claude-old"
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        post_delete = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:00:00Z", 40, "claude-old"),
            )
        )
        signed_out = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T08:00:00Z", 0, None, stamped=True),
            )
        )

        for entrypoint in ("overview", "sync"):
            with self.subTest(entrypoint=entrypoint):
                self.write_memory({target_key: target})
                before_derivation = threading.Event()
                allow_derivation = threading.Event()
                errors = []

                def wait_before_derivation():
                    before_derivation.set()
                    if not allow_derivation.wait(2):
                        raise TimeoutError("test did not release candidate derivation")

                def load_overview():
                    try:
                        server.overview({})
                    except BaseException as exc:
                        errors.append(exc)

                def delayed_overview(_query, admission, **_kwargs):
                    wait_before_derivation()
                    return {
                        "rate_limits": server._rate_limits(admission=admission)
                    }

                @contextlib.contextmanager
                def delayed_sync_snapshot():
                    wait_before_derivation()
                    yield post_delete

                def load_sync():
                    try:
                        server._remember_accounts_after_sync_publish()
                    except BaseException as exc:
                        errors.append(exc)

                if entrypoint == "overview":
                    patches = (
                        mock.patch(
                            "server._sync_runtime_snapshot",
                            return_value={"completed_at": None},
                        ),
                        mock.patch("server._maybe_sync_remotes", return_value=False),
                        mock.patch(
                            "server.generation.generation_admission_snapshot",
                            side_effect=lambda: contextlib.nullcontext(post_delete),
                        ),
                        mock.patch(
                            "server.rollup.use_admitted_generations",
                            side_effect=lambda _admitted: contextlib.nullcontext(),
                        ),
                        mock.patch(
                            "server._overview_from_admission",
                            side_effect=delayed_overview,
                        ),
                    )
                    action = load_overview
                else:
                    patches = (
                        mock.patch(
                            "server.generation.generation_admission_snapshot",
                            side_effect=delayed_sync_snapshot,
                        ),
                    )
                    action = load_sync

                with contextlib.ExitStack() as stack:
                    for patcher in patches:
                        stack.enter_context(patcher)
                    worker = threading.Thread(target=action)
                    worker.start()
                    if not before_derivation.wait(1):
                        worker.join(1)
                        self.fail(
                            "entrypoint exited before candidate derivation: %r"
                            % errors
                        )

                    status, _ = self.post_remove(signed_out)
                    self.assertEqual(status, 200)
                    allow_derivation.set()
                    worker.join(2)

                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])
                record = json.loads(self.memory_path.read_bytes())["accounts"][
                    target_key
                ]
                self.assertEqual(record["observed_at"], "2026-08-20T09:00:00+00:00")
                self.assertEqual(record["five_hour_used_pct"], 40)

    def test_upsert_epoch_lifetime_is_counted_and_pruned_on_exception(self):
        target_key = "claude:claude-old"
        target = self.remembered_record(
            "claude", "claude-old", "2026-08-20T07:00:00+00:00", 24
        )
        signed_out = self.admission(
            self.current(
                "macbook",
                claude=self.limit("2026-08-20T09:01:00Z", 0, None, stamped=True),
            )
        )
        self.write_memory({target_key: target})

        with self.assertRaisesRegex(RuntimeError, "derived candidate failed"):
            with server._account_memory_upsert_epoch() as first_epoch:
                with server._account_memory_upsert_epoch() as second_epoch:
                    self.assertEqual(second_epoch, first_epoch)
                    status, _ = self.post_remove(signed_out)
                    self.assertEqual(status, 200)
                    self.assertEqual(
                        server._ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[first_epoch],
                        2,
                    )
                    self.assertIn(
                        target_key, server._ACCOUNT_MEMORY_DELETED_AT_EPOCH
                    )

                self.assertEqual(
                    server._ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS[first_epoch],
                    1,
                )
                self.assertIn(target_key, server._ACCOUNT_MEMORY_DELETED_AT_EPOCH)
                raise RuntimeError("derived candidate failed")

        self.assertEqual(server._ACCOUNT_MEMORY_ACTIVE_UPSERT_EPOCHS, {})
        self.assertEqual(server._ACCOUNT_MEMORY_DELETED_AT_EPOCH, {})

    def post_remove(
        self,
        admission,
        *,
        provider="claude",
        account_id="claude-old",
        observed_at="2026-08-20T07:00:00+00:00",
        content_type="application/json",
    ):
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request = urllib.request.Request(
            "http://127.0.0.1:%d/api/account-memory/remove" % httpd.server_port,
            data=json.dumps(
                {
                    "provider": provider,
                    "account_id": account_id,
                    "observed_at": observed_at,
                }
            ).encode("utf-8"),
            method="POST",
        )
        if content_type is not None:
            request.add_header("Content-Type", content_type)
        try:
            with mock.patch(
                "server.generation.generation_admission_snapshot",
                side_effect=lambda: contextlib.nullcontext(admission),
            ):
                try:
                    response = opener.open(request, timeout=2)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    return response.status, json.load(response)
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)

    class CoordinatedLock:
        def __init__(self, first_name):
            self.first_name = first_name
            self.lock = threading.Lock()
            self.first_entered = threading.Event()
            self.second_attempted = threading.Event()
            self.release_first = threading.Event()
            self.blocked_first = False

        def __enter__(self):
            name = threading.current_thread().name
            if name != self.first_name:
                self.second_attempted.set()
            self.lock.acquire()
            if name == self.first_name and not self.blocked_first:
                self.blocked_first = True
                self.first_entered.set()
                if not self.release_first.wait(1):
                    raise TimeoutError("test did not release the first memory writer")
            return self

        def __exit__(self, exc_type, exc_value, traceback):
            self.lock.release()

    def wait_for_sync(self):
        deadline = time.monotonic() + 2
        while server._sync_runtime_snapshot()["syncing"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertFalse(server._sync_runtime_snapshot()["syncing"])

    @staticmethod
    def make_generation_db(path, multiplier):
        with closing(sqlite3.connect(path)) as conn:
            with conn:
                conn.executescript(rollup.SCHEMA)
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', 'Asia/Shanghai')"
                )
                conn.execute(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model, input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens, cost_usd,
                      cost_known_count, entry_count, message_count
                    ) VALUES (
                      '2026-08-20', 'codex', 'repo', 'gpt-5', ?, 2, 3, 4,
                      1.5, 1, 1, 1
                    )
                    """,
                    (10 * multiplier,),
                )

    @staticmethod
    def admission(*currents):
        machine = SimpleNamespace(name="macbook")
        return SimpleNamespace(
            admitted=currents,
            records=(SimpleNamespace(machine=machine),),
        )

    @staticmethod
    def current(name, **rate_limits):
        return SimpleNamespace(host=name, meta={"rate_limits": rate_limits})

    @staticmethod
    def limit(observed_at, pct, account_id, *, stamped=True):
        block = {
            "five_hour_pct": pct,
            "five_hour_resets_at": 100,
            "seven_day_pct": pct + 1,
            "seven_day_resets_at": 200,
            "updated_at": observed_at,
            "account_label": f"{account_id}@example.com" if account_id else None,
            "account_plan": f"plan-{account_id}" if account_id else None,
        }
        if stamped:
            block["account_id"] = account_id
        return block

    def write_memory(self, accounts):
        self.memory_path.parent.mkdir(parents=True, exist_ok=True)
        self.memory_path.write_text(
            json.dumps({"version": 1, "accounts": accounts}),
            encoding="utf-8",
        )

    @staticmethod
    def remembered_record(provider, account_id, observed_at, pct, *, label=None):
        return {
            "provider": provider,
            "account_id": account_id,
            "account_label": label or f"{account_id}@example.com",
            "account_plan": f"plan-{account_id}",
            "five_hour_used_pct": pct,
            "five_hour_resets_at": 100,
            "seven_day_used_pct": pct + 1,
            "seven_day_resets_at": 200,
            "observed_at": observed_at,
        }


if __name__ == "__main__":
    unittest.main()
