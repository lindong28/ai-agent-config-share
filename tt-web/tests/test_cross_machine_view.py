import contextlib
import hashlib
import json
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from contextlib import closing

import generation
import exporter
import rollup
import server
import sync
from machine_config import Machine, machine_config_fingerprint
from parsers import UsageEntry


class CrossMachineOverviewTests(unittest.TestCase):
    def test_iv11_overview_usage_fields_are_all_computed_from_rollup(self):
        def pivot(x_dim, group_dim, metric, **_kwargs):
            if x_dim == "agent" and metric == "cost":
                return {
                    "columns": ["value"],
                    "rows": [
                        {"x": "claude-code", "values": {"value": 2.0}},
                        {"x": "codex", "values": {"value": 3.0}},
                    ],
                }
            if x_dim == "agent" and metric == "total":
                return {
                    "columns": ["value"],
                    "rows": [
                        {"x": "claude-code", "values": {"value": 20}},
                        {"x": "codex", "values": {"value": 30}},
                    ],
                }
            if x_dim == "project":
                return {
                    "columns": ["value"],
                    "rows": [{"x": "repo", "values": {"value": 5.0}}],
                }
            if x_dim == "model":
                return {
                    "columns": ["value"],
                    "rows": [{"x": "gpt-5", "values": {"value": 50}}],
                }
            return {
                "columns": ["claude-code", "codex"],
                "rows": [
                    {
                        "x": "2026-08-04",
                        "values": {"claude-code": 2.0, "codex": 3.0},
                    }
                ],
            }

        sync_status = {
            "coverage": {"admitted": 3, "declared": 3},
            "machines": [],
            "syncing": False,
            "terminal": True,
        }
        with (
            mock.patch(
                "server.load_all_entries",
                side_effect=AssertionError("Overview must not read live entries"),
            ),
            mock.patch("server._maybe_sync_remotes", return_value=False),
            mock.patch("server._sync_status", return_value=sync_status),
            mock.patch("server._rate_limits", return_value={"claude": {}, "codex": {}}),
            mock.patch(
                "server.generation.generation_admission_snapshot",
                return_value=contextlib.nullcontext(
                    SimpleNamespace(
                        admitted=(),
                        records=(),
                        config=SimpleNamespace(machines=()),
                    )
                ),
            ),
            mock.patch("server.rollup.query_pivot", side_effect=pivot),
            mock.patch("server.rollup.earliest_rollup_date", return_value="2026-04-21"),
        ):
            payload = server.overview({"range": ["30d"]})

        for key in ("today", "week", "range"):
            self.assertEqual(payload[key]["cost_usd"], 5.0)
            self.assertEqual(payload[key]["tokens"], 50)
            self.assertEqual(
                payload[key]["by_agent"],
                {"claude-code": 2.0, "codex": 3.0},
            )
        self.assertEqual(payload["top_projects_week"], [{"project": "repo", "cost_usd": 5.0}])
        self.assertEqual(
            payload["model_mix_month"],
            [{"model": "gpt-5", "tokens": 50, "pct": 1.0}],
        )
        self.assertEqual(payload["sync"]["coverage"], sync_status["coverage"])
        self.assertFalse(payload["sync"]["refresh_pending"])

    def test_iv8_rate_limits_choose_latest_admitted_generation_per_provider(self):
        admitted = (
            self.current(
                "macbook",
                {
                    "claude": self.limit("2026-08-04T10:00:00Z", 10),
                    "codex": self.limit("2026-08-04T12:00:00Z", 30),
                },
            ),
            self.current(
                "macmini",
                {
                    "claude": self.limit("2026-08-04T11:00:00Z", 20),
                    "codex": self.limit("2026-08-04T09:00:00Z", 40),
                },
            ),
            self.current(
                "gpu-box",
                {
                    "claude": self.limit("2026-08-04T10:30:00Z", 99),
                    "codex": self.limit("2026-08-04T13:00:00Z", 50),
                },
            ),
        )
        admission = SimpleNamespace(admitted=admitted, records=())
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server.claude_status.load_rate_limits",
            side_effect=AssertionError("must not read viewer-local quota"),
        ), mock.patch(
            "server.codex.load_rate_limits",
            side_effect=AssertionError("must not read viewer-local quota"),
        ):
            limits = server._rate_limits()

        self.assertEqual(limits["claude"]["five_hour_pct"], 20)
        self.assertEqual(limits["claude"]["source_machine"], "macmini")
        self.assertEqual(limits["codex"]["five_hour_pct"], 50)
        self.assertEqual(limits["codex"]["source_machine"], "gpu-box")
        self.assertNotEqual(limits["claude"]["five_hour_pct"], 10 + 20 + 99)
        self.assertNotEqual(limits["codex"]["five_hour_pct"], 30 + 40 + 50)

    def test_iv8_legacy_generation_quota_unavailability_names_latest_sync_failure(self):
        admission = SimpleNamespace(
            admitted=(self.current("macbook", {}),),
            records=(),
        )
        sync_status = {
            "syncing": False,
            "machines": [
                {
                    "name": "macbook",
                    "reason": "exporter runtime authority differs from HEAD",
                    "last_attempt_outcome": "failure",
                },
                {
                    "name": "macmini",
                    "reason": "remote export returned non-zero exit status 2",
                    "last_attempt_outcome": "failure",
                },
            ],
        }

        limits = server._rate_limits(admission=admission, sync_status=sync_status)

        expected = (
            "Latest sync failed before an admitted generation supplied claude quota data: "
            "macbook: exporter runtime authority differs from HEAD; "
            "macmini: remote export returned non-zero exit status 2."
        )
        self.assertEqual(limits["claude"]["unavailable_reason"], expected)
        self.assertIsNone(limits["claude"]["five_hour_pct"])

    def test_iv8_unknown_contact_is_not_misreported_as_latest_sync_failure(self):
        admission = SimpleNamespace(admitted=(self.current("macbook", {}),), records=())
        sync_status = {
            "syncing": False,
            "machines": [{
                "name": "macbook",
                "reason": "Contact status unknown since server restart",
                "last_attempt_outcome": "unknown_since_restart",
            }],
        }

        limits = server._rate_limits(admission=admission, sync_status=sync_status)

        reason = limits["claude"]["unavailable_reason"]
        self.assertIn("successful refresh is required", reason)
        self.assertNotIn("Latest sync failed", reason)

    @staticmethod
    def current(name, rate_limits):
        return SimpleNamespace(host=name, meta={"rate_limits": rate_limits})

    @staticmethod
    def limit(updated_at, pct):
        return {
            "five_hour_pct": pct,
            "five_hour_resets_at": 1,
            "seven_day_pct": pct + 1,
            "seven_day_resets_at": 2,
            "updated_at": updated_at,
        }


class BackgroundSyncTests(unittest.TestCase):
    def tearDown(self):
        release = getattr(self, "release", None)
        if release is not None:
            release.set()
        deadline = time.monotonic() + 2
        while getattr(server, "_SYNC_STATE", {}).get("running") and time.monotonic() < deadline:
            time.sleep(0.01)
        if hasattr(server, "_reset_sync_state_for_tests"):
            server._reset_sync_state_for_tests()

    def test_iv10_force_starts_one_nonblocking_round_and_status_reaches_terminal(self):
        self.release = threading.Event()
        calls = []

        def slow_sync_all(**_kwargs):
            calls.append("started")
            self.release.wait(2)
            return {
                "macbook": sync.SyncResult(generation=SimpleNamespace(meta={})),
                "macmini": sync.SyncResult(error="timeout"),
                "gpu-box": sync.SyncResult(error="offline"),
            }

        if hasattr(server, "_reset_sync_state_for_tests"):
            server._reset_sync_state_for_tests()
        with mock.patch("server.sync.sync_all", side_effect=slow_sync_all):
            started = time.monotonic()
            server._maybe_sync_remotes({"force": ["1"]})
            server._maybe_sync_remotes({"force": ["1"]})
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 0.1)
            deadline = time.monotonic() + 1
            while not calls and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(calls, ["started"])
            self.assertTrue(server._sync_runtime_snapshot()["syncing"])
            self.release.set()
            deadline = time.monotonic() + 2
            while server._sync_runtime_snapshot()["syncing"] and time.monotonic() < deadline:
                time.sleep(0.01)

        final = server._sync_runtime_snapshot()
        self.assertFalse(final["syncing"])
        self.assertTrue(final["terminal"])
        self.assertEqual(final["errors"], {"macmini": "timeout", "gpu-box": "offline"})

    def test_g6_outcome_less_sync_result_is_malformed_not_contact_success(self):
        machine, admission = self.single_admitted_machine()
        server._reset_sync_state_for_tests()
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server.sync.sync_all",
            return_value={machine.name: sync.SyncResult()},
        ):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            self.wait_for_terminal()

        row = server._sync_status(admission=admission)["machines"][0]
        self.assertEqual(row["availability"], "unknown")
        self.assertEqual(row["last_attempt_outcome"], "malformed_result")
        self.assertIn("no explicit outcome", row["reason"])

    def test_g6_none_result_cannot_bypass_terminal_commit(self):
        machine, admission = self.single_admitted_machine()
        server._reset_sync_state_for_tests()
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server.sync.sync_all",
            return_value={machine.name: None},
        ):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            self.wait_for_terminal()

        runtime = server._sync_runtime_snapshot()
        row = server._sync_status(admission=admission)["machines"][0]
        self.assertTrue(runtime["terminal"])
        self.assertFalse(runtime["syncing"])
        self.assertEqual(row["last_attempt_outcome"], "malformed_result")
        self.assertIn("malformed", row["reason"].lower())

    def test_g6_new_round_preserves_prior_unreachable_observation_until_contact(self):
        self.release = threading.Event()
        machine = Machine("macbook", "macbook", True)
        current = SimpleNamespace(
            host="macbook",
            meta={"published_at": "2026-08-04T11:00:00Z"},
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )
        attempts = [
            {"macbook": sync.SyncResult(error="ssh timeout")},
            None,
        ]

        def sync_all():
            result = attempts.pop(0)
            if result is None:
                self.release.wait(2)
                return {"macbook": sync.SyncResult(generation=SimpleNamespace(meta={}))}
            return result

        server._reset_sync_state_for_tests()
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch("server.sync.sync_all", side_effect=sync_all):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            self.wait_for_terminal()
            failed = server._sync_status(admission=admission)
            self.assertEqual(failed["machines"][0]["availability"], "unreachable")
            self.assertEqual(failed["machines"][0]["reason"], "ssh timeout")
            self.assertEqual(
                failed["machines"][0]["last_successful_contact_ts"],
                "2026-08-04T11:00:00Z",
            )

            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            during = server._sync_status(admission=admission)

        self.assertTrue(during["syncing"])
        self.assertEqual(during["machines"][0]["availability"], "unreachable")
        self.assertEqual(during["machines"][0]["reason"], "ssh timeout")

    def test_g6_thread_start_failure_rolls_back_to_terminal_attempt_failure(self):
        machine = Machine("macbook", "macbook", True)
        current = SimpleNamespace(
            host="macbook",
            meta={"published_at": "2026-08-04T11:00:00Z"},
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )
        server._reset_sync_state_for_tests()
        with self.assertLogs("tt-web", level="ERROR") as logs:
            with mock.patch(
                "server.generation.generation_admission_snapshot",
                return_value=contextlib.nullcontext(admission),
            ), mock.patch("server.threading.Thread.start", side_effect=RuntimeError("no thread")):
                self.assertFalse(server._maybe_sync_remotes({"force": ["1"]}))

        runtime = server._sync_runtime_snapshot()
        status = server._sync_status(admission=admission)
        self.assertTrue(runtime["terminal"])
        self.assertFalse(runtime["syncing"])
        self.assertEqual(status["machines"][0]["availability"], "unknown")
        self.assertEqual(status["machines"][0]["last_attempt_outcome"], "failure")
        self.assertIn("no thread", status["machines"][0]["reason"])
        self.assertIn("no thread", "\n".join(logs.output))

    def test_g6_generation_cleanup_failure_still_commits_terminal_observation(self):
        machine = Machine("macbook", "macbook", True)
        admitted_current = SimpleNamespace(
            host="macbook",
            meta={"published_at": "2026-08-04T11:00:00Z"},
        )
        admission = SimpleNamespace(
            admitted=(admitted_current,),
            records=(
                generation.AdmissionRecord(
                    machine, True, False, current=admitted_current
                ),
            ),
            config=SimpleNamespace(machines=(machine,)),
        )
        current = mock.Mock()
        current.close.side_effect = OSError("close failed")
        server._reset_sync_state_for_tests()
        with self.assertLogs("tt-web", level="ERROR") as logs:
            with mock.patch(
                "server.generation.generation_admission_snapshot",
                return_value=contextlib.nullcontext(admission),
            ), mock.patch(
                "server.sync.sync_all",
                return_value={"macbook": sync.SyncResult(generation=current)},
            ):
                self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
                self.wait_for_terminal()

        runtime = server._sync_runtime_snapshot()
        status = server._sync_status(admission=admission)
        self.assertTrue(runtime["terminal"])
        self.assertEqual(status["machines"][0]["availability"], "reachable")
        self.assertEqual(status["machines"][0]["last_attempt_outcome"], "cleanup_failed")
        self.assertIn("close failed", status["machines"][0]["reason"])
        self.assertIn("close failed", "\n".join(logs.output))

    def test_g6_machine_removed_during_sync_retains_terminal_observation(self):
        machine_a = Machine("macbook", "macbook", True)
        machine_b = Machine("macmini", "macmini", False)
        starting = SimpleNamespace(
            admitted=(),
            records=(
                generation.AdmissionRecord(machine_a, False, True),
                generation.AdmissionRecord(machine_b, False, True),
            ),
            config=SimpleNamespace(machines=(machine_a, machine_b)),
        )
        final = SimpleNamespace(
            admitted=(),
            records=(generation.AdmissionRecord(machine_a, False, True),),
            config=SimpleNamespace(machines=(machine_a,)),
        )
        server._reset_sync_state_for_tests()
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(starting),
        ), mock.patch(
            "server.sync.sync_all",
            return_value={
                "macbook": sync.SyncResult(error="self export failed"),
                "macmini": sync.SyncResult(error="ssh timeout"),
            },
        ):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            self.wait_for_terminal()

        status = server._sync_status(admission=final)
        removed = next(row for row in status["machines"] if row["name"] == "macmini")
        self.assertFalse(removed["declared"])
        self.assertFalse(removed["admitted"])
        self.assertEqual(
            removed["exclusion_reason"],
            "no_longer_declared_after_latest_attempt",
        )
        self.assertEqual(removed["availability"], "unreachable")
        self.assertEqual(removed["reason"], "ssh timeout")
        self.assertEqual(status["coverage"], {"admitted": 0, "declared": 1})

        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(final),
        ), mock.patch(
            "server.sync.sync_all",
            return_value={"macbook": sync.SyncResult(error="self still dirty")},
        ):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            self.wait_for_terminal()

        after_later_round = server._sync_status(admission=final)
        self.assertEqual(
            [row["name"] for row in after_later_round["machines"]],
            ["macbook"],
        )

    def test_g4_restart_is_explicitly_unknown_until_this_process_observes_contact(self):
        machine = Machine("macbook", "macbook", True)
        current = SimpleNamespace(
            host="macbook",
            meta={"published_at": "2026-08-04T11:00:00Z"},
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )
        server._reset_sync_state_for_tests()

        row = server._sync_status(admission=admission)["machines"][0]

        self.assertEqual(row["availability"], "unknown")
        self.assertEqual(row["last_attempt_outcome"], "unknown_since_restart")
        self.assertIsNone(row["last_attempt_ts"])
        self.assertEqual(row["last_successful_contact_ts"], "2026-08-04T11:00:00Z")
        self.assertIn("restart", row["reason"])

    def test_g4_machine_added_after_start_is_not_mislabelled_as_restart_unknown(self):
        machine_a, initial = self.single_admitted_machine()
        machine_b = Machine("macmini", "macmini", False)
        expanded = SimpleNamespace(
            admitted=initial.admitted,
            records=initial.records + (generation.AdmissionRecord(machine_b, False, True),),
            config=SimpleNamespace(machines=(machine_a, machine_b)),
        )
        server._reset_sync_state_for_tests()
        server._sync_status(admission=initial)

        added = next(
            row for row in server._sync_status(admission=expanded)["machines"]
            if row["name"] == "macmini"
        )

        self.assertEqual(added["last_attempt_outcome"], "not_attempted_since_added")
        self.assertIn("added", added["reason"])
        self.assertNotIn("restart", added["reason"])

    def wait_for_terminal(self):
        deadline = time.monotonic() + 2
        while server._sync_runtime_snapshot()["syncing"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(server._sync_runtime_snapshot()["terminal"])

    @staticmethod
    def single_admitted_machine():
        machine = Machine("macbook", "macbook", True)
        current = SimpleNamespace(
            host=machine.name,
            meta={"published_at": "2026-08-04T11:00:00Z"},
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )
        return machine, admission

    def test_iv10_sync_due_and_g4_stale_use_independent_age_boundaries(self):
        machine = Machine("macbook", "macbook", True)

        def admission(age):
            published_at = (
                datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc) - timedelta(seconds=age)
            ).isoformat()
            current = SimpleNamespace(host=machine.name, meta={"published_at": published_at})
            record = generation.AdmissionRecord(machine, True, False, current=current)
            return SimpleNamespace(
                config=SimpleNamespace(machines=(machine,)),
                admitted=(current,),
                records=(record,),
            )

        now = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)
        with mock.patch("server._aware_now", return_value=now), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission(599.999)),
        ), mock.patch("server.threading.Thread") as thread:
            self.assertFalse(server._maybe_sync_remotes({}))
            thread.assert_not_called()

        server._reset_sync_state_for_tests()
        with mock.patch("server._aware_now", return_value=now), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission(600)),
        ), mock.patch("server.threading.Thread") as thread:
            self.assertTrue(server._maybe_sync_remotes({}))
            thread.assert_called_once()
            self.assertTrue(thread.call_args.kwargs["daemon"])
        server._reset_sync_state_for_tests()

        for age, expected_stale in (
            (600, False),
            (6 * 60 * 60 - 0.001, False),
            (6 * 60 * 60, True),
        ):
            with self.subTest(age=age):
                status = server._sync_status(now=now, admission=admission(age))
                self.assertEqual(status["machines"][0]["stale"], expected_stale)

        self.assertEqual(server._SYNC_DUE_AFTER_SECONDS, 600)
        self.assertEqual(server._STALE_AFTER_SECONDS, 6 * 60 * 60)

    def test_g6_failed_sync_remains_terminal_during_normal_overview_polling(self):
        machine = Machine("macbook", "macbook", True)
        published_at = datetime(2026, 8, 4, 10, 0, tzinfo=timezone.utc).isoformat()
        current = SimpleNamespace(
            host=machine.name,
            meta={"published_at": published_at},
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )

        server._reset_sync_state_for_tests()
        with mock.patch(
            "server.sync.sync_all",
            return_value={
                "macbook": sync.SyncResult(
                    error="exporter runtime authority differs from HEAD"
                )
            },
        ), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server._utc_timestamp",
            side_effect=("2026-08-04T11:59:00Z", "2026-08-04T11:59:30Z"),
        ):
            self.assertTrue(server._maybe_sync_remotes({"force": ["1"]}))
            deadline = time.monotonic() + 2
            while server._sync_runtime_snapshot()["syncing"] and time.monotonic() < deadline:
                time.sleep(0.01)

        failed = server._sync_runtime_snapshot()
        self.assertTrue(failed["terminal"])
        self.assertEqual(
            failed["errors"],
            {"macbook": "exporter runtime authority differs from HEAD"},
        )

        with mock.patch("server._aware_now", return_value=datetime(2026, 8, 4, 12, 9, 29, 999000, tzinfo=timezone.utc)), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch("server.threading.Thread") as thread:
            self.assertFalse(server._maybe_sync_remotes({}))
            thread.assert_not_called()

        final = server._sync_runtime_snapshot()
        self.assertTrue(final["terminal"])
        self.assertFalse(final["syncing"])
        self.assertEqual(
            final["errors"],
            {"macbook": "exporter runtime authority differs from HEAD"},
        )

        with mock.patch("server._aware_now", return_value=datetime(2026, 8, 4, 12, 9, 30, tzinfo=timezone.utc)), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch("server.threading.Thread") as thread:
            self.assertTrue(server._maybe_sync_remotes({}))
            thread.assert_called_once()
        server._reset_sync_state_for_tests()

    def test_g6_http_failure_polling_reaches_terminal_and_surfaces_quota_cause(self):
        self.release = threading.Event()
        calls = []
        machine = Machine("macbook", "macbook", True)
        published_at = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
        current = SimpleNamespace(
            host=machine.name,
            db_path=Path("/nonexistent/synthetic-generation.db"),
            meta={
                "published_at": published_at,
                "generated_at": published_at,
                "data_start_date": "2026-04-21",
                "generation_id": "a" * 64,
                "rate_limits": {},
            },
        )
        admission = SimpleNamespace(
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
            config=SimpleNamespace(machines=(machine,)),
        )

        def failing_sync_all():
            calls.append("started")
            self.release.wait(2)
            return {
                "macbook": sync.SyncResult(
                    error="exporter runtime authority differs from HEAD"
                )
            }

        server._reset_sync_state_for_tests()
        httpd = server.ThreadingHTTPServer(("0.0.0.0", 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def get_json(path):
            with opener.open(
                "http://127.0.0.1:%d%s" % (httpd.server_port, path), timeout=2
            ) as response:
                return json.load(response)

        try:
            with mock.patch("server.sync.sync_all", side_effect=failing_sync_all), mock.patch(
                "server.generation.generation_admission_snapshot",
                return_value=contextlib.nullcontext(admission),
            ), mock.patch(
                "server.rollup.query_pivot",
                return_value={"columns": [], "rows": []},
            ), mock.patch("server.rollup.earliest_rollup_date", return_value=None):
                initial = get_json("/api/overview?force=1")
                self.assertTrue(initial["sync"]["syncing"])
                self.release.set()

                deadline = time.monotonic() + 2
                terminal = None
                while time.monotonic() < deadline:
                    terminal = get_json("/api/sync-status")
                    if terminal["terminal"]:
                        break
                    time.sleep(0.01)

                final = get_json("/api/overview")
        finally:
            self.release.set()
            httpd.shutdown()
            httpd.server_close()
            thread.join(2)

        self.assertEqual(calls, ["started"])
        self.assertIsNotNone(terminal)
        self.assertTrue(terminal["terminal"])
        self.assertFalse(terminal["syncing"])
        self.assertEqual(
            terminal["machines"][0]["reason"],
            "exporter runtime authority differs from HEAD",
        )
        self.assertTrue(final["sync"]["terminal"])
        self.assertFalse(final["sync"]["syncing"])
        self.assertEqual(calls, ["started"])
        self.assertIn(
            "Latest sync failed before an admitted generation supplied claude quota data",
            final["rate_limits"]["claude"]["unavailable_reason"],
        )
        self.assertIn(
            "macbook: exporter runtime authority differs from HEAD",
            final["rate_limits"]["claude"]["unavailable_reason"],
        )

    def test_g6_overview_returns_old_generation_while_slow_sync_is_running(self):
        self.release = threading.Event()

        def slow_sync_all():
            self.release.wait(2)
            return {}

        admission = SimpleNamespace(
            admitted=(),
            records=(),
            config=SimpleNamespace(machines=()),
        )
        with mock.patch("server.sync.sync_all", side_effect=slow_sync_all), mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server.rollup.query_pivot",
            return_value={"columns": [], "rows": []},
        ), mock.patch("server.rollup.earliest_rollup_date", return_value=None):
            started = time.monotonic()
            payload = server.overview({"force": ["1"]})
            elapsed = time.monotonic() - started

        self.assertLess(elapsed, 0.1)
        self.assertTrue(payload["sync"]["syncing"])
        self.assertFalse(payload["sync"]["terminal"])
        self.assertTrue(payload["sync"]["refresh_pending"])


class AdmissionStatusTests(unittest.TestCase):
    def test_g4_admission_reports_each_fail_closed_reason_without_admitting_it(self):
        cases = (
            ("machine_config_fingerprint", self.install_wrong_fingerprint),
            ("bucket_timezone", self.install_wrong_timezone),
            ("generation_id", self.install_wrong_generation_id),
            ("digest", self.install_wrong_digest),
        )
        for expected_reason, install in cases:
            with self.subTest(reason=expected_reason), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "generations"
                config_path = Path(tmp) / "machines.json"
                machine = Machine("macbook", "macbook", True)
                self.write_config(config_path, machine)
                install(root, machine)

                with generation.generation_admission_snapshot(
                    config_path=config_path,
                    root=root,
                ) as admission:
                    self.assertEqual(len(admission.admitted), 0)
                    self.assertEqual(len(admission.records), 1)
                    record = admission.records[0]
                    self.assertFalse(record.admitted)
                    self.assertFalse(record.never)
                    self.assertEqual(record.exclusion_reason, expected_reason)

    def test_iv11_overview_pins_one_admitted_generation_set_for_every_panel(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, config_path, machines = self.three_machine_fixture(tmp)
            for index, machine in enumerate(machines, start=1):
                self.publish(root, machine, multiplier=index).close()
            admission_snapshot = generation.generation_admission_snapshot
            with mock.patch(
                "server.generation.generation_admission_snapshot",
                side_effect=lambda: admission_snapshot(config_path=config_path, root=root),
            ) as load_admission, mock.patch(
                "rollup.admitted_generations",
                side_effect=AssertionError("overview queries must reuse the pinned admission set"),
            ):
                payload = server.overview({"range": ["30d"], "sync": ["0"]})

            load_admission.assert_called_once()
            self.assertEqual(payload["sync"]["coverage"], {"admitted": 3, "declared": 3})
            self.assertEqual(payload["sync"]["all_machines"], ["gpu-box", "macbook", "macmini"])
            self.assertEqual(payload["today"]["cost_usd"], 9.0)
            self.assertEqual(payload["today"]["tokens"], 114)

    def test_g2_machine_filter_exposes_three_names_and_selects_one_host_slice(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, config_path, machines = self.three_machine_fixture(tmp)
            for index, machine in enumerate(machines, start=1):
                self.publish(root, machine, multiplier=index).close()

            with self.rollup_admission(root, config_path):
                options = rollup.filter_options()
                selected = rollup.query_pivot(
                    "machine",
                    "none",
                    "total",
                    machines={"gpu-box"},
                )

            self.assertEqual(options["machine"], ["gpu-box", "macbook", "macmini"])
            self.assertEqual(
                selected,
                {
                    "columns": ["value"],
                    "rows": [{"x": "gpu-box", "values": {"value": 57}}],
                },
            )

    def test_g4_unreachable_generation_keeps_all_seven_metrics_and_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            root, config_path, machines = self.three_machine_fixture(tmp)
            for index, machine in enumerate(machines, start=1):
                current = self.publish(
                    root,
                    machine,
                    published_at=datetime(2026, 8, 4, 6, 0, tzinfo=timezone.utc),
                    multiplier=index,
                    quota_updated_at="2026-08-04T0%d:00:00Z" % index,
                    quota_pct=index * 10,
                )
                current.close()

            with self.rollup_admission(root, config_path):
                before = self.metric_totals()
                per_machine_before = self.machine_metric_totals("macmini")

            status = self.status(
                root,
                config_path,
                errors={"macmini": "ssh timeout"},
                running=False,
                now=datetime(2026, 8, 4, 12, 20, tzinfo=timezone.utc),
            )
            with self.rollup_admission(root, config_path):
                after = self.metric_totals()
                per_machine_after = self.machine_metric_totals("macmini")

            self.assertEqual(before, self.expected_metrics(6))
            self.assertEqual(after, before)
            self.assertEqual(per_machine_before, self.expected_metrics(2))
            self.assertEqual(per_machine_after, per_machine_before)
            self.assertEqual(status["coverage"], {"admitted": 3, "declared": 3})
            macmini = self.machine_status(status, "macmini")
            self.assertTrue(macmini["admitted"])
            self.assertEqual(macmini["availability"], "unreachable")
            self.assertTrue(macmini["stale"])
            self.assertEqual(macmini["reason"], "ssh timeout")

    def test_g4_syncing_and_recent_failure_are_orthogonal_to_stale(self):
        machine = Machine("macbook", "macbook", True)
        old = self.fake_admission(machine, "2026-08-04T05:59:59Z")
        recent = self.fake_admission(machine, "2026-08-04T07:00:00Z")
        now = datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc)

        syncing = self.status_from_admission(old, running=True, errors={}, now=now)
        syncing_machine = syncing["machines"][0]
        self.assertTrue(syncing_machine["syncing"])
        self.assertTrue(syncing_machine["stale"])
        self.assertEqual(syncing_machine["availability"], "unknown")

        failed_recent = self.status_from_admission(
            recent,
            running=False,
            errors={"macbook": "connection refused"},
            now=now,
        )
        failed_machine = failed_recent["machines"][0]
        self.assertEqual(failed_machine["availability"], "unreachable")
        self.assertFalse(failed_machine["stale"])
        self.assertEqual(failed_machine["reason"], "connection refused")

    def test_g4_never_excludes_machine_and_changes_exact_coverage_and_totals(self):
        with tempfile.TemporaryDirectory() as complete_tmp, tempfile.TemporaryDirectory() as partial_tmp:
            complete_root, complete_config, machines = self.three_machine_fixture(complete_tmp)
            partial_root, partial_config, partial_machines = self.three_machine_fixture(partial_tmp)
            for index, machine in enumerate(machines, start=1):
                self.publish(complete_root, machine, multiplier=index).close()
            for index, machine in enumerate(partial_machines[:2], start=1):
                self.publish(partial_root, machine, multiplier=index).close()

            with self.rollup_admission(complete_root, complete_config):
                complete_totals = self.metric_totals()
            with self.rollup_admission(partial_root, partial_config):
                partial_totals = self.metric_totals()
            complete_status = self.status(complete_root, complete_config)
            partial_status = self.status(partial_root, partial_config)

            self.assertEqual(complete_totals, self.expected_metrics(6))
            self.assertEqual(partial_totals, self.expected_metrics(3))
            self.assertEqual(complete_status["coverage"], {"admitted": 3, "declared": 3})
            self.assertEqual(partial_status["coverage"], {"admitted": 2, "declared": 3})
            never = self.machine_status(partial_status, "gpu-box")
            self.assertFalse(never["admitted"])
            self.assertEqual(never["availability"], "never")
            self.assertFalse(never["stale"])

    def test_g4_each_admission_failure_is_excluded_from_every_consumer(self):
        cases = (
            ("machine_config_fingerprint", self.corrupt_fingerprint),
            ("bucket_timezone", self.corrupt_timezone),
            ("generation_id", self.corrupt_generation_id),
            ("digest", self.corrupt_digest),
        )
        for expected_reason, corrupt in cases:
            with self.subTest(reason=expected_reason), tempfile.TemporaryDirectory() as tmp:
                root, config_path, machines = self.three_machine_fixture(tmp)
                for index, machine in enumerate(machines, start=1):
                    fingerprint = (
                        "f" * 64
                        if expected_reason == "machine_config_fingerprint" and machine.name == "macmini"
                        else None
                    )
                    current = self.publish(
                        root,
                        machine,
                        fingerprint=fingerprint,
                        multiplier=index,
                        quota_updated_at="2026-08-04T0%d:00:00Z" % index,
                        quota_pct=index * 10,
                    )
                    if machine.name == "macmini" and expected_reason != "machine_config_fingerprint":
                        corrupt(current)
                    current.close()

                with self.rollup_admission(root, config_path):
                    totals = self.metric_totals()
                    options = rollup.filter_options()
                admission_snapshot = generation.generation_admission_snapshot
                with mock.patch(
                    "server.generation.generation_admission_snapshot",
                    side_effect=lambda: admission_snapshot(
                        config_path=config_path,
                        root=root,
                    ),
                ):
                    limits = server._rate_limits()
                    status = server._sync_status(
                        now=datetime(2026, 8, 4, 12, 20, tzinfo=timezone.utc)
                    )

                self.assertEqual(totals, self.expected_metrics(4))
                self.assertEqual(options["machine"], ["gpu-box", "macbook"])
                self.assertEqual(status["coverage"], {"admitted": 2, "declared": 3})
                excluded = self.machine_status(status, "macmini")
                self.assertFalse(excluded["admitted"])
                self.assertIsNone(excluded["availability"])
                self.assertEqual(excluded["exclusion_reason"], expected_reason)
                self.assertEqual(limits["claude"]["five_hour_pct"], 30)
                self.assertEqual(limits["claude"]["source_machine"], "gpu-box")
                self.assertNotEqual(limits["claude"]["five_hour_pct"], 20)

    def install_wrong_fingerprint(self, root, machine):
        self.publish(root, machine, fingerprint="f" * 64)

    def install_wrong_timezone(self, root, machine):
        current = self.publish(root, machine)
        meta_path = current.generation_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["bucket_timezone"] = "UTC"
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        current.close()

    def install_wrong_generation_id(self, root, machine):
        current = self.publish(root, machine)
        meta_path = current.generation_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["generation_id"] = "e" * 64
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        current.close()

    def install_wrong_digest(self, root, machine):
        current = self.publish(root, machine)
        self.corrupt_digest(current)
        current.close()

    @staticmethod
    def corrupt_fingerprint(current):
        meta_path = current.generation_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["machine_config_fingerprint"] = "f" * 64
        meta_path.write_text(json.dumps(meta), encoding="utf-8")

    @staticmethod
    def corrupt_timezone(current):
        meta_path = current.generation_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["bucket_timezone"] = "UTC"
        meta_path.write_text(json.dumps(meta), encoding="utf-8")

    @staticmethod
    def corrupt_generation_id(current):
        meta_path = current.generation_dir / "meta.json"
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta["generation_id"] = "e" * 64
        meta_path.write_text(json.dumps(meta), encoding="utf-8")

    @staticmethod
    def corrupt_digest(current):
        with current.db_path.open("ab") as handle:
            handle.write(b"changed")

    def publish(
        self,
        root,
        machine,
        fingerprint=None,
        multiplier=1,
        quota_updated_at="2026-08-04T10:00:00Z",
        quota_pct=10,
        published_at=None,
    ):
        root.mkdir(parents=True, exist_ok=True)
        source = root.parent / ("source-%s.db" % time.monotonic_ns())
        self.make_db(source, multiplier=multiplier)
        meta = generation.build_generation_meta(
            source,
            machine_config_fingerprint=fingerprint or machine_config_fingerprint(machine),
            source_host_identity="host-v1:" + hashlib.sha256(machine.name.encode()).hexdigest(),
            aliases=[],
            rate_limits={
                "claude": {
                    "five_hour_pct": quota_pct,
                    "five_hour_resets_at": 1,
                    "seven_day_pct": quota_pct + 1,
                    "seven_day_resets_at": 2,
                    "updated_at": quota_updated_at,
                }
            },
            exporter_commit="a" * 40,
            generated_at="2026-08-04T12:00:00Z",
        )
        return generation.publish_generation(
            machine.name,
            source,
            meta,
            root=root,
            now=published_at or datetime(2026, 8, 4, 12, 0, tzinfo=timezone.utc),
        )

    @staticmethod
    def make_db(path, multiplier=1):
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
                    ) VALUES (?, 'codex', ?, 'gpt-5', ?, ?, ?, ?, ?, 1, 1, ?)
                    """,
                    (
                        datetime.now(rollup.BUCKET_TIMEZONE).date().isoformat(),
                        "repo-%s" % multiplier,
                        10 * multiplier,
                        2 * multiplier,
                        3 * multiplier,
                        4 * multiplier,
                        1.5 * multiplier,
                        multiplier,
                    ),
                )

    @staticmethod
    def write_config(path, *machines):
        path.write_text(
            json.dumps(
                {
                    "machines": [machine.as_config_dict() for machine in machines],
                    "retired_names": [],
                }
            ),
            encoding="utf-8",
        )

    def three_machine_fixture(self, tmp):
        root = Path(tmp) / "generations"
        config_path = Path(tmp) / "machines.json"
        machines = (
            Machine("macbook", "macbook", True),
            Machine("macmini", "macmini", False),
            Machine("gpu-box", "gpu-box", False),
        )
        self.write_config(config_path, *machines)
        return root, config_path, machines

    @staticmethod
    @contextlib.contextmanager
    def rollup_admission(root, config_path):
        def load():
            currents = generation.admitted_generations(config_path=config_path, root=root)
            return tuple(
                rollup.AdmittedGeneration(current.host, current.db_path, current)
                for current in currents
            )

        with mock.patch("rollup.admitted_generations", side_effect=load):
            yield

    @staticmethod
    def metric_totals():
        return {
            metric: rollup.query_pivot("agent", "none", metric)["rows"][0]["values"]["value"]
            for metric in sorted(rollup.METRICS)
        }

    @staticmethod
    def machine_metric_totals(machine):
        return {
            metric: rollup.query_pivot("agent", "none", metric, machines={machine})["rows"][0]["values"]["value"]
            for metric in sorted(rollup.METRICS)
        }

    @staticmethod
    def expected_metrics(multiplier_sum):
        return {
            "cache_creation": 3 * multiplier_sum,
            "cache_read": 4 * multiplier_sum,
            "cost": 1.5 * multiplier_sum,
            "input": 10 * multiplier_sum,
            "messages": multiplier_sum,
            "output": 2 * multiplier_sum,
            "total": 19 * multiplier_sum,
        }

    @staticmethod
    def machine_status(status, name):
        return next(machine for machine in status["machines"] if machine["name"] == name)

    @staticmethod
    def fake_admission(machine, published_at):
        current = SimpleNamespace(
            host=machine.name,
            meta={
                "published_at": published_at,
                "generated_at": published_at,
                "data_start_date": "2026-08-04",
                "generation_id": "a" * 64,
            },
        )
        return SimpleNamespace(
            config=SimpleNamespace(machines=(machine,)),
            admitted=(current,),
            records=(generation.AdmissionRecord(machine, True, False, current=current),),
        )

    def status(self, root, config_path, errors=None, running=False, now=None):
        admission_snapshot = generation.generation_admission_snapshot
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            side_effect=lambda: admission_snapshot(
                config_path=config_path,
                root=root,
            ),
        ), mock.patch(
            "server._sync_runtime_snapshot",
            return_value={
                "syncing": running,
                "terminal": not running,
                "started_at": None,
                "completed_at": None,
                "round_machines": tuple(
                    record.machine.name for record in admission.records
                ) if running else (),
                "observations": {},
                "errors": errors or {},
            },
        ):
            return server._sync_status(
                now=now or datetime(2026, 8, 4, 12, 20, tzinfo=timezone.utc)
            )

    @staticmethod
    def status_from_admission(admission, *, running, errors, now):
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ), mock.patch(
            "server._sync_runtime_snapshot",
            return_value={
                "syncing": running,
                "terminal": not running,
                "started_at": None,
                "completed_at": None,
                "round_machines": tuple(
                    record.machine.name for record in admission.records
                ) if running else (),
                "observations": {},
                "errors": errors,
            },
        ):
            return server._sync_status(now=now)


class FrontendStatusRenderTests(unittest.TestCase):
    def test_g4_idle_page_adopts_unknown_after_same_version_server_restart(self):
        script = r'''
const fs = require("fs");
const nodes = {
  "#sync-coverage": { textContent: "" },
  "#sync-summary": { textContent: "" },
  "#sync-machines": { innerHTML: "" },
};
let reloads = 0;
global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "", reload() { reloads += 1; } },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  addEventListener() {},
  querySelector(selector) { return nodes[selector] || null; },
  querySelectorAll() { return []; },
};
const health = [
  { ok: true, web_signature: "same-version", instance_id: "process-B", stale: false },
];
const unknown = {
  instance_id: "process-B",
  coverage: { admitted: 1, declared: 1 }, all_machines: ["macbook"],
  syncing: false, terminal: true,
  machines: [{ name: "macbook", declared: true, this_machine: true, admitted: true,
    availability: "unknown", stale: false, syncing: false,
    reason: "Contact status unknown since server restart", exclusion_reason: null,
    last_sync_ts: "2026-08-04T11:00:00Z", generated_at: "2026-08-04T11:00:00Z",
    data_start_date: "2026-04-21", last_attempt_outcome: "unknown_since_restart",
    last_attempt_ts: null, last_successful_contact_ts: "2026-08-04T11:00:00Z" }],
};
global.fetch = (url) => {
  const path = new URL(String(url), window.location.origin).pathname;
  if (path === "/api/health") return Promise.resolve({ ok: true, json: () => Promise.resolve(health.shift()) });
  if (path === "/api/timezone") return Promise.resolve({ ok: true, json: () => Promise.resolve({ timezone: "UTC" }) });
  if (path === "/api/sync-status") return Promise.resolve({ ok: true, json: () => Promise.resolve(unknown) });
  throw new Error(path);
};
eval(fs.readFileSync("web/app.js", "utf8"));
const reachable = JSON.parse(JSON.stringify(unknown));
reachable.instance_id = "process-A";
reachable.machines[0].availability = "reachable";
reachable.machines[0].last_attempt_outcome = "success";
reachable.machines[0].reason = null;
window.TTWeb.renderSyncStatus(reachable);
(async () => {
  const before = nodes["#sync-machines"].innerHTML;
  await window.TTWeb.pollFreshness();
  const after = nodes["#sync-machines"].innerHTML;
  process.stdout.write(JSON.stringify({ before, after, reloads }));
})().catch((error) => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn(">reachable<", payload["before"])
        self.assertIn(">unknown<", payload["after"])
        self.assertIn("unknown since server restart", payload["after"])
        self.assertEqual(payload["reloads"], 0)

    def test_g6_stale_poll_cannot_overwrite_newer_sync_panel(self):
        script = r'''
const fs = require("fs");
const nodes = {
  "#sync-coverage": { textContent: "" },
  "#sync-summary": { textContent: "" },
  "#sync-machines": { innerHTML: "" },
};
global.window = {
  location: { origin: "http://example.test", pathname: "/explore", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  addEventListener() {},
  querySelector(selector) { return nodes[selector] || null; },
  querySelectorAll() { return []; },
};
global.setTimeout = (callback) => { callback(); return 1; };
let resolveOldPoll;
global.fetch = (url) => {
  const path = new URL(String(url), window.location.origin).pathname;
  if (path === "/api/timezone") return Promise.resolve({ ok: true, json: () => Promise.resolve({ timezone: "UTC" }) });
  if (path === "/api/sync-status") return new Promise((resolve) => { resolveOldPoll = resolve; });
  throw new Error(path);
};
eval(fs.readFileSync("web/app.js", "utf8"));
function status(name, availability, syncing, reason) {
  return {
    coverage: { admitted: 1, declared: 1 }, all_machines: [name], syncing, terminal: !syncing,
    machines: [{ name, declared: true, this_machine: false, admitted: true,
      availability, stale: false, syncing, reason: reason || null, exclusion_reason: null,
      last_sync_ts: "2026-08-04T11:00:00Z", generated_at: "2026-08-04T11:00:00Z",
      data_start_date: "2026-04-21", last_attempt_outcome: reason ? "failure" : "success",
      last_attempt_ts: "2026-08-04T11:01:00Z", last_successful_contact_ts: "2026-08-04T11:00:00Z" }],
  };
}
(async () => {
  let current = true;
  const oldWait = window.TTWeb.waitForSyncTerminal(
    status("old-load", "unknown", true, null),
    { isCurrent: () => current },
  );
  await new Promise((resolve) => setImmediate(resolve));
  current = false;
  window.TTWeb.renderSyncStatus(status("new-load", "reachable", false, null));
  resolveOldPoll({ ok: true, json: () => Promise.resolve(status("old-load", "unreachable", false, "late failure")) });
  await oldWait;
  process.stdout.write(JSON.stringify({ html: nodes["#sync-machines"].innerHTML, summary: nodes["#sync-summary"].textContent }));
})().catch((error) => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("new-load", payload["html"])
        self.assertNotIn("old-load", payload["html"])
        self.assertNotIn("late failure", payload["html"])

    def test_g6_poll_connection_failure_replaces_frozen_syncing_state_with_reason(self):
        script = r'''
const fs = require("fs");
const nodes = {
  "#sync-coverage": { textContent: "" },
  "#sync-summary": { textContent: "" },
  "#sync-machines": { innerHTML: "" },
};
global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  addEventListener() {},
  querySelector(selector) { return nodes[selector] || null; },
  querySelectorAll() { return []; },
};
global.setTimeout = (callback) => { callback(); return 1; };
global.fetch = () => Promise.reject(new Error("connection reset"));
eval(fs.readFileSync("web/app.js", "utf8"));
const initial = {
  coverage: { admitted: 1, declared: 1 },
  all_machines: ["macbook"],
  syncing: true,
  terminal: false,
  machines: [{
    name: "macbook", declared: true, this_machine: true, admitted: true,
    availability: "unknown", stale: false, syncing: true, reason: "Contact pending",
    exclusion_reason: null, last_sync_ts: "2026-08-04T11:00:00Z",
    generated_at: "2026-08-04T11:00:00Z", data_start_date: "2026-04-21",
    last_attempt_outcome: "unknown_since_restart", last_attempt_ts: null,
    last_successful_contact_ts: "2026-08-04T11:00:00Z",
  }],
};
window.TTWeb.waitForSyncTerminal(initial).then((result) => {
  process.stdout.write(JSON.stringify({ result, summary: nodes["#sync-summary"].textContent, html: nodes["#sync-machines"].innerHTML }));
}).catch((error) => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload["result"]["syncing"])
        self.assertFalse(payload["result"]["terminal"])
        self.assertIn("connection reset", payload["result"]["polling_error"])
        self.assertIn("Sync status unavailable", payload["summary"])
        self.assertNotIn(">syncing<", payload["html"])

    def test_g2_out_of_order_pivot_completion_cannot_render_under_new_machine_label(self):
        script = r'''
const fs = require("fs");
const controls = {};
for (const id of ["x-dim", "group-dim", "metric", "range", "agent-filter", "project-filter", "model-filter", "machine-filter"]) {
  controls[`#${id}`] = {
    id,
    value: id === "x-dim" ? "machine" : id === "group-dim" ? "none" : id === "metric" ? "cost" : id === "range" ? "30d" : "",
    innerHTML: "",
    disabled: false,
    listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    appendChild(option) {},
  };
}
const nodes = Object.assign(controls, {
  "#pivot-status": { textContent: "" },
  "#pivot-count": { textContent: "" },
  "#pivot-table": { innerHTML: "" },
  "#pivot-chart": { closest() { return null; } },
});
let page = new URL("http://example.test/explore?x=machine&group=none&metric=cost&range=30d");
global.window = {
  get location() { return page; },
  history: { replaceState(_state, _title, target) { page = new URL(target, page.origin); } },
};
global.document = {
  readyState: "loading",
  addEventListener() {},
  createElement() { return { value: "", textContent: "" }; },
};
let resolveA;
let resolveB;
const rendered = [];
global.TTWeb = {
  qs(selector) { return nodes[selector] || null; },
  qsa(selector) { return selector === "[data-filter-control]" ? [controls["#agent-filter"], controls["#project-filter"], controls["#model-filter"], controls["#machine-filter"]] : []; },
  params() { return new URLSearchParams(page.search); },
  getRange() { return controls["#range"].value; },
  autoTimeDim() { return "day"; },
  setParam(key, value) { value ? page.searchParams.set(key, value) : page.searchParams.delete(key); },
  bindShell() {},
  renderSyncStatus() {},
  waitForSyncTerminal(status) { return Promise.resolve(status); },
  integer(value) { return String(value); },
  moneyPrecise(value) { return String(value); },
  dataset(label, data) { return { label, data }; },
  chart(_key, _id, config) { rendered.push(config.data.labels[0]); },
  chartOptions(value) { return value; },
  api(path, query) {
    if (path === "/api/sync-status") return Promise.resolve({ syncing: false, completed_at: null, machines: [] });
    if (path === "/api/pivot-filters") return Promise.resolve({ machine: ["A", "B"] });
    if (path === "/api/pivot") {
      const machine = query.machine || "initial";
      if (machine === "A") return new Promise((resolve) => { resolveA = resolve; });
      if (machine === "B") return new Promise((resolve) => { resolveB = resolve; });
      return Promise.resolve({ columns: ["value"], rows: [{ x: "initial-data", values: { value: 0 } }] });
    }
    throw new Error(path);
  },
};
eval(fs.readFileSync("web/pivot.js", "utf8"));
(async () => {
  await window.TTWebPivot.init();
  controls["#machine-filter"].value = "A";
  const requestA = controls["#machine-filter"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  controls["#machine-filter"].value = "B";
  const requestB = controls["#machine-filter"].listeners.change();
  await new Promise((resolve) => setImmediate(resolve));
  resolveB({ columns: ["value"], rows: [{ x: "B-data", values: { value: 2 } }] });
  await requestB;
  resolveA({ columns: ["value"], rows: [{ x: "A-data", values: { value: 1 } }] });
  await requestA;
  process.stdout.write(JSON.stringify({ rendered, selected: controls["#machine-filter"].value, search: page.search }));
})().catch((error) => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["selected"], "B")
        self.assertIn("machine=B", payload["search"])
        self.assertEqual(payload["rendered"], ["initial-data", "B-data"])

    def test_g4_renderer_preserves_orthogonal_statuses_and_exclusion_consequences(self):
        script = r'''
const fs = require("fs");
const nodes = {
  "#sync-coverage": { textContent: "" },
  "#sync-summary": { textContent: "" },
  "#sync-machines": { innerHTML: "" },
};
global.window = {
  location: { origin: "http://example.test", pathname: "/", search: "" },
  history: { replaceState() {} },
};
global.document = {
  readyState: "loading",
  addEventListener() {},
  querySelector(selector) { return nodes[selector] || null; },
  querySelectorAll() { return []; },
};
eval(fs.readFileSync("web/app.js", "utf8"));
function base(name) {
  return {
    name,
    this_machine: name === "macbook",
    admitted: true,
    availability: "reachable",
    stale: false,
    syncing: false,
    reason: null,
    exclusion_reason: null,
    last_sync_ts: "2026-08-04T11:00:00Z",
    generated_at: "2026-08-04T10:59:00Z",
    data_start_date: "2026-07-01",
    last_attempt_outcome: "success",
    last_attempt_ts: "2026-08-04T11:00:30Z",
    last_successful_contact_ts: "2026-08-04T11:00:30Z",
  };
}
const staleFailure = base("macmini");
Object.assign(staleFailure, { availability: "unreachable", stale: true, syncing: true, reason: "ssh timeout" });
window.TTWeb.renderSyncStatus({ coverage: { admitted: 3, declared: 3 }, all_machines: ["macbook", "macmini", "gpu-box"], syncing: true, machines: [base("macbook"), staleFailure] });
const combined = { coverage: nodes["#sync-coverage"].textContent, summary: nodes["#sync-summary"].textContent, html: nodes["#sync-machines"].innerHTML };
const never = base("gpu-box");
Object.assign(never, { admitted: false, availability: "never", reason: "remote export exited 2", last_attempt_outcome: "failure", last_sync_ts: null, generated_at: null, data_start_date: null });
window.TTWeb.renderSyncStatus({ coverage: { admitted: 2, declared: 3 }, all_machines: ["macbook", "macmini"], syncing: false, machines: [never] });
const excluded = { coverage: nodes["#sync-coverage"].textContent, html: nodes["#sync-machines"].innerHTML };
const recentFailure = base("macbook");
Object.assign(recentFailure, { availability: "unreachable", reason: "connection refused" });
window.TTWeb.renderSyncStatus({ coverage: { admitted: 1, declared: 1 }, all_machines: ["macbook"], syncing: false, machines: [recentFailure] });
const recent = nodes["#sync-machines"].innerHTML;
const cleanupFailure = base("macbook");
Object.assign(cleanupFailure, { availability: "reachable", last_attempt_outcome: "cleanup_failed", reason: "close failed" });
window.TTWeb.renderSyncStatus({ coverage: { admitted: 1, declared: 1 }, all_machines: ["macbook"], syncing: false, machines: [cleanupFailure] });
const cleanup = nodes["#sync-machines"].innerHTML;
process.stdout.write(JSON.stringify({ combined, excluded, recent, cleanup }));
'''
        result = subprocess.run(
            ["node", "-e", script],
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        rendered = json.loads(result.stdout)

        self.assertEqual(rendered["combined"]["coverage"], "coverage 3/3")
        for text in (
            "unreachable",
            "stale",
            "syncing",
            "Included in All using the last generation",
            "ssh timeout",
            "This machine",
            "last attempt",
            "last successful contact",
        ):
            self.assertIn(text, rendered["combined"]["html"])
        self.assertEqual(rendered["excluded"]["coverage"], "coverage 2/3")
        self.assertIn("excluded", rendered["excluded"]["html"])
        self.assertIn("never", rendered["excluded"]["html"])
        self.assertIn("Excluded from All", rendered["excluded"]["html"])
        self.assertIn("Latest sync failed: remote export exited 2", rendered["excluded"]["html"])
        self.assertIn("connection refused", rendered["recent"])
        self.assertNotIn(">stale<", rendered["recent"])
        self.assertIn("Latest sync attempt failed: close failed", rendered["cleanup"])
        self.assertNotIn(">stale<", rendered["cleanup"])


class WriteSetTests(unittest.TestCase):
    publish = AdmissionStatusTests.publish
    make_db = staticmethod(AdmissionStatusTests.make_db)
    write_config = staticmethod(AdmissionStatusTests.write_config)

    def test_iv18_page_load_refresh_and_export_only_write_derived_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = Path(tmp)
            state_root = sandbox / "state"
            sessions_root = sandbox / "sessions"
            project_root = sandbox / "project-worktree"
            sessions_root.mkdir()
            project_root.mkdir()
            (sessions_root / "session.jsonl").write_text('{"usage":"source"}\n', encoding="utf-8")
            (project_root / "tracked.txt").write_text("business data\n", encoding="utf-8")
            generations_root = state_root / "generations"
            config_path = sandbox / "machines.json"
            machine = Machine("macbook", "macbook", True)
            self.write_config(config_path, machine)
            self.publish(
                generations_root,
                machine,
                published_at=datetime.now(timezone.utc),
            ).close()
            db_path = state_root / "rollup.db"
            self.make_db(db_path)
            entry = UsageEntry(
                timestamp=datetime.now(timezone.utc),
                session_id="s1",
                message_id="m1",
                request_id="r1",
                model="gpt-5",
                input_tokens=10,
                output_tokens=2,
                cache_creation_tokens=0,
                cache_read_tokens=0,
                cost_usd=1.0,
                project=str(project_root),
                agent_id="codex",
            )
            clean_manifest = self.tree_manifest(sandbox)
            session_manifest = self.tree_manifest(sessions_root)
            project_manifest = self.tree_manifest(project_root)
            admission_snapshot = generation.generation_admission_snapshot
            source_identity = "host-v1:" + hashlib.sha256(machine.name.encode()).hexdigest()

            def sync_self():
                current = sync.sync_machine(
                    machine,
                    db_path=db_path,
                    root=generations_root,
                    export_kwargs={
                        "entries_loader": lambda: [entry],
                        "rate_limits": {},
                    },
                )
                return {machine.name: sync.SyncResult(generation=current)}

            with mock.patch(
                "server.generation.generation_admission_snapshot",
                side_effect=lambda: admission_snapshot(
                    config_path=config_path,
                    root=generations_root,
                ),
            ), mock.patch("server.sync.sync_all", side_effect=sync_self), mock.patch(
                "exporter.exporter_version", return_value="a" * 40
            ), mock.patch(
                "generation.self_certified_host_identity", return_value=source_identity
            ):
                server._reset_sync_state_for_tests()
                server.overview({})
                after_load = self.tree_manifest(sandbox)
                server.overview({"force": ["1"]})
                deadline = time.monotonic() + 2
                while server._sync_runtime_snapshot()["syncing"] and time.monotonic() < deadline:
                    time.sleep(0.01)
                after_refresh = self.tree_manifest(sandbox)
                self.assertEqual(server._sync_runtime_snapshot()["errors"], {})

            self.assert_write_subset(clean_manifest, after_load, "state/")
            self.assert_write_subset(after_load, after_refresh, "state/")
            self.assertNotEqual(after_load, after_refresh)
            output_path = state_root / "export-bundle"
            with mock.patch("exporter.exporter_version", return_value="a" * 40):
                exporter.export_bundle(
                    db_path=db_path,
                    output_path=output_path,
                    entries_loader=lambda: [entry],
                    source_host_identity="host-v1:" + "1" * 64,
                    rate_limits={},
                )
            after_export = self.tree_manifest(sandbox)

            self.assert_write_subset(after_refresh, after_export, "state/")
            self.assertEqual(self.tree_manifest(sessions_root), session_manifest)
            self.assertEqual(self.tree_manifest(project_root), project_manifest)

    @staticmethod
    def tree_manifest(root):
        root = Path(root)
        result = {}
        for path in sorted(root.rglob("*")):
            if path.is_file():
                result[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
        return result

    def assert_write_subset(self, before, after, prefix):
        changed = {
            path
            for path in set(before) | set(after)
            if before.get(path) != after.get(path)
        }
        self.assertTrue(all(path.startswith(prefix) for path in changed), changed)


if __name__ == "__main__":
    unittest.main()
