import contextlib
import dataclasses
import os
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

import server
from parsers import RateLimits, UsageEntry


class OverviewApiShapeTests(unittest.TestCase):
    def setUp(self):
        self.real_rate_limits = server._rate_limits
        self.sync_trigger_patcher = mock.patch("server._maybe_sync_remotes")
        self.sync_trigger = self.sync_trigger_patcher.start()
        self.addCleanup(self.sync_trigger_patcher.stop)
        self.sync_status_patcher = mock.patch(
            "server._sync_status",
            return_value={
                "coverage": {"admitted": 0, "declared": 0},
                "all_machines": [],
                "machines": [],
                "syncing": False,
                "terminal": True,
            },
        )
        self.sync_status_patcher.start()
        self.addCleanup(self.sync_status_patcher.stop)
        self.rate_limits_patcher = mock.patch(
            "server._rate_limits",
            return_value={"claude": {}, "codex": {}},
        )
        self.rate_limits_patcher.start()
        self.addCleanup(self.rate_limits_patcher.stop)
        empty_admission = SimpleNamespace(
            admitted=(),
            records=(),
            config=SimpleNamespace(machines=()),
        )
        self.admission_patcher = mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(empty_admission),
        )
        self.admission_patcher.start()
        self.addCleanup(self.admission_patcher.stop)

    def test_rate_limits_are_nested_by_provider(self):
        claude_limits = RateLimits(
            five_hour_pct=12.5,
            five_hour_resets_at=1779247200,
            seven_day_pct=34,
            seven_day_resets_at=1779580800,
            updated_at="2026-05-19T22:41:23+00:00",
        )
        codex_limits = RateLimits(
            five_hour_pct=0.0,
            five_hour_resets_at=1779248487,
            seven_day_pct=40.0,
            seven_day_resets_at=1779835287,
            updated_at="2026-05-19T22:42:00+00:00",
        )

        payload = self.overview_with(claude_limits, codex_limits)

        self.assertEqual(
            payload["rate_limits"],
            {
                "claude": {
                    "five_hour_pct": 12.5,
                    "five_hour_resets_at": 1779247200,
                    "seven_day_pct": 34,
                    "seven_day_resets_at": 1779580800,
                    "updated_at": "2026-05-19T22:41:23+00:00",
                    "source_machine": "macbook",
                    "unavailable_reason": None,
                },
                "codex": {
                    "five_hour_pct": 0.0,
                    "five_hour_resets_at": 1779248487,
                    "seven_day_pct": 40.0,
                    "seven_day_resets_at": 1779835287,
                    "updated_at": "2026-05-19T22:42:00+00:00",
                    "source_machine": "macbook",
                    "unavailable_reason": None,
                },
            },
        )

    def test_missing_rate_limits_are_null_not_zero(self):
        cases = [
            (None, None),
            (None, RateLimits(1, 2, 3, 4, updated_at="2026-05-19T22:42:00Z")),
            (RateLimits(5, 6, 7, 8, updated_at="2026-05-19T22:41:00Z"), None),
        ]

        for claude_limits, codex_limits in cases:
            with self.subTest(claude=claude_limits, codex=codex_limits):
                payload = self.overview_with(claude_limits, codex_limits)

                if claude_limits is None:
                    self.assert_missing_block(payload["rate_limits"]["claude"])
                else:
                    self.assertEqual(payload["rate_limits"]["claude"]["five_hour_pct"], 5)

                if codex_limits is None:
                    self.assert_missing_block(payload["rate_limits"]["codex"])
                else:
                    self.assertEqual(payload["rate_limits"]["codex"]["five_hour_pct"], 1)

    def test_pivot_endpoint_uses_rollup_not_live_entries(self):
        expected = {"columns": ["value"], "rows": [{"x": "2026-06", "values": {"value": 1.0}}]}
        with (
            mock.patch("server.load_all_entries", side_effect=AssertionError("pivot should not use live entries")),
            mock.patch("server.rollup.query_pivot", return_value=expected) as query_pivot,
        ):
            payload = server.pivot_endpoint({"range": ["2y"], "x": ["month"], "group": ["project"], "metric": ["cost"]})

        self.assertIs(payload, expected)
        query_pivot.assert_called_once()
        self.assertEqual(query_pivot.call_args.args[:3], ("month", "project", "cost"))

    def test_sessions_endpoint_still_uses_live_entries(self):
        entry = UsageEntry(
            timestamp=datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            session_id="s1",
            message_id="m1",
            request_id="r1",
            model="gpt-5",
            input_tokens=10,
            output_tokens=2,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cost_usd=1.0,
            project="repo-a",
            agent_id="codex",
        )

        with (
            mock.patch("server.load_all_entries", return_value=[entry]) as load_all_entries,
            mock.patch("server.rollup.query_pivot", side_effect=AssertionError("sessions must stay live")),
        ):
            payload = server.sessions_endpoint({"range": ["all"]})

        load_all_entries.assert_called_once()
        self.assertEqual(payload[0]["session_id"], "s1")
        self.assertEqual(payload[0]["cost_usd"], 1.0)

    def test_session_stats_marks_glm_5_estimated_costs(self):
        entry = UsageEntry(
            timestamp=datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            session_id="s1",
            message_id="m1",
            request_id="r1",
            model="glm-5.2[1m]",
            input_tokens=10,
            output_tokens=2,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cost_usd=0.01,
            project="repo-a",
            agent_id="claude-code",
        )

        self.assertTrue(server._session_stats([entry])["estimated"])

    def test_overview_today_and_week_kpis_use_rollup_not_live_entries(self):
        with (
            mock.patch(
                "server.load_all_entries",
                side_effect=AssertionError("overview must not use live entries"),
            ),
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}) as query_pivot,
        ):
            payload = server.overview({})

        self.assertGreaterEqual(query_pivot.call_count, 8)
        self.assertEqual(payload["today"]["cost_usd"], 0.0)
        self.assertEqual(payload["today"]["tokens"], 0)
        self.assertEqual(payload["week"]["cost_usd"], 0.0)
        self.assertEqual(payload["week"]["tokens"], 0)

    def test_overview_week_includes_monday_window_metadata(self):
        before = datetime.now().astimezone()
        with (
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}),
        ):
            payload = server.overview({})
        after = datetime.now().astimezone()

        start = datetime.fromisoformat(payload["week"]["window"]["start"])
        end = datetime.fromisoformat(payload["week"]["window"]["end"])
        self.assertEqual(start, server._start_of_week(before))
        self.assertGreaterEqual(end, before)
        self.assertLessEqual(end, after)

    def test_overview_force_query_routes_to_background_sync(self):
        with mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}):
            server.overview({"force": ["1"]})

        self.sync_trigger.assert_called_once_with({"force": ["1"]})

    def test_pivot_endpoint_routes_sync_before_query(self):
        expected = {"columns": ["value"], "rows": []}
        with (
            mock.patch("server.rollup.query_pivot", return_value=expected) as query_pivot,
        ):
            payload = server.pivot_endpoint({"range": ["30d"]})

        self.assertIs(payload, expected)
        self.sync_trigger.assert_called_once_with({"range": ["30d"]})
        query_pivot.assert_called_once()

    def test_pivot_filters_endpoint_reads_rollup_options_for_selected_range(self):
        expected = {
            "agent": ["codex"],
            "project": ["repo-a"],
            "model": ["gpt-5"],
        }
        with (
            mock.patch("server.rollup.filter_options", return_value=expected) as filter_options,
        ):
            payload = server.pivot_filters_endpoint({"range": ["2y"]})

        self.assertIs(payload, expected)
        filter_options.assert_called_once()
        self.assertIsNotNone(filter_options.call_args.kwargs["time_range"])

    def test_background_sync_spawns_daemon_thread(self):
        self.sync_trigger_patcher.stop()
        server._reset_sync_state_for_tests()
        with mock.patch("server.threading.Thread") as thread:
            created = thread.return_value
            server._maybe_sync_remotes({"force": ["1"]})

        thread.assert_called_once()
        self.assertTrue(thread.call_args.kwargs["daemon"])
        created.start.assert_called_once()
        server._reset_sync_state_for_tests()

    def test_overview_history_gap_is_not_a_viewer_local_claim(self):
        with (
            mock.patch("server.rollup.history_gap", side_effect=AssertionError("must not read local history gap")),
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}),
        ):
            payload = server.overview({})

        self.assertIsNone(payload["history_gap"])

    def test_range_window_accepts_long_history_presets(self):
        now = datetime(2026, 6, 13, 17, 30, tzinfo=timezone(timedelta(hours=-7)))

        for value, expected_days in (("6m", 180), ("1y", 365), ("2y", 730)):
            start, end = server._range_window(value, now)
            self.assertEqual(end, now)
            self.assertEqual(start.tzinfo, server.rollup.BUCKET_TIMEZONE)
            self.assertEqual(
                (now.astimezone(server.rollup.BUCKET_TIMEZONE).date() - start.date()).days + 1,
                expected_days,
            )
        self.assertIsNone(server._range_window("all", now))

    def test_raw_range_today_week_and_month_use_shanghai_calendar_boundaries(self):
        now = datetime(2026, 6, 13, 17, 30, tzinfo=timezone(timedelta(hours=-7)))

        range_start, range_end = server._range_window("7d", now)

        self.assertEqual(range_start.isoformat(), "2026-06-08T00:00:00+08:00")
        self.assertEqual(range_end, now)
        self.assertEqual(server._start_of_day(now).isoformat(), "2026-06-14T00:00:00+08:00")
        self.assertEqual(server._start_of_week(now).isoformat(), "2026-06-08T00:00:00+08:00")
        self.assertEqual(server._start_of_month(now).isoformat(), "2026-06-01T00:00:00+08:00")

    def test_daily_cost_uses_shanghai_buckets_and_exact_30_day_fill(self):
        now = datetime(2026, 6, 13, 17, 30, tzinfo=timezone(timedelta(hours=-7)))
        entry = UsageEntry(
            timestamp=datetime(2026, 6, 13, 9, 30, tzinfo=now.tzinfo),
            session_id="s1",
            message_id="m1",
            request_id="r1",
            model="gpt-5",
            input_tokens=1,
            output_tokens=0,
            cache_creation_tokens=0,
            cache_read_tokens=0,
            cost_usd=2.0,
            project="repo",
            agent_id="codex",
        )

        with self.system_timezone("America/Los_Angeles"):
            rows = server._daily_cost([entry], now)

        self.assertEqual(len(rows), 30)
        self.assertEqual(rows[0]["date"], "2026-05-16")
        self.assertEqual(rows[-1], {"date": "2026-06-14", "claude_cost": 0.0, "codex_cost": 2.0})

    def test_rollup_coverage_uses_same_shanghai_calendar_window_as_query(self):
        now = datetime(2026, 6, 13, 17, 30, tzinfo=timezone(timedelta(hours=-7)))
        query_window = server.rollup.range_window("7d", now)

        with mock.patch("server.rollup.earliest_rollup_date", return_value="2026-06-08"):
            coverage = server._rollup_coverage(query_window)

        self.assertEqual(coverage["range_start"], "2026-06-08")
        self.assertFalse(coverage["partial_before_range"])

    def test_auto_time_dim_uses_day_week_month_thresholds(self):
        self.assertEqual(server._auto_time_dim("7d"), "day")
        self.assertEqual(server._auto_time_dim("90d"), "day")
        self.assertEqual(server._auto_time_dim("6m"), "week")
        self.assertEqual(server._auto_time_dim("1y"), "week")
        self.assertEqual(server._auto_time_dim("2y"), "month")
        self.assertEqual(server._auto_time_dim("all"), "month")

    def test_overview_cost_over_time_reads_rollup_with_auto_granularity(self):
        expected = {
            "columns": ["claude-code", "codex"],
            "rows": [{"x": "2026-06-01", "values": {"claude-code": 1.0, "codex": 2.0}}],
        }
        with (
            mock.patch("server.rollup.query_pivot", return_value=expected) as query_pivot,
        ):
            payload = server.overview({"range": ["1y"]})

        self.assertIs(payload["cost_over_time"], expected)
        self.assertEqual(payload["cost_over_time_granularity"], "week")
        self.assertIn(
            mock.call("week", "agent", "cost", time_range=mock.ANY),
            query_pivot.call_args_list,
        )

    def test_overview_includes_rollup_coverage_for_long_ranges(self):
        with (
            mock.patch("server.rollup.earliest_rollup_date", return_value="2026-04-21"),
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}),
        ):
            long_payload = server.overview({"range": ["2y"]})
            short_payload = server.overview({"range": ["7d"]})

        self.assertEqual(long_payload["rollup_coverage"]["earliest_date"], "2026-04-21")
        self.assertTrue(long_payload["rollup_coverage"]["partial_before_range"])
        self.assertIsNotNone(long_payload["rollup_coverage"]["range_start"])
        self.assertFalse(short_payload["rollup_coverage"]["partial_before_range"])

    def overview_with(self, claude_limits, codex_limits):
        blocks = {}
        for provider, limits in (("claude", claude_limits), ("codex", codex_limits)):
            if limits is not None:
                blocks[provider] = dataclasses.asdict(limits)
        admission = SimpleNamespace(
            admitted=(SimpleNamespace(host="macbook", meta={"rate_limits": blocks}),),
        )
        with mock.patch(
            "server.generation.generation_admission_snapshot",
            return_value=contextlib.nullcontext(admission),
        ):
            return {"rate_limits": self.real_rate_limits()}

    def assert_missing_block(self, block):
        self.assertEqual(
            block,
            {
                "five_hour_pct": None,
                "five_hour_resets_at": None,
                "seven_day_pct": None,
                "seven_day_resets_at": None,
                "updated_at": None,
                "source_machine": None,
                "unavailable_reason": mock.ANY,
            },
        )

    @staticmethod
    @contextlib.contextmanager
    def system_timezone(name):
        previous = os.environ.get("TZ")
        try:
            os.environ["TZ"] = name
            time.tzset()
            yield
        finally:
            if previous is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = previous
            time.tzset()


if __name__ == "__main__":
    unittest.main()
