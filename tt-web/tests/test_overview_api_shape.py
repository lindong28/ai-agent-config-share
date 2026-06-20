import unittest
from datetime import datetime, timezone
from unittest import mock

import server
from parsers import RateLimits, UsageEntry


class OverviewApiShapeTests(unittest.TestCase):
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
                },
                "codex": {
                    "five_hour_pct": 0.0,
                    "five_hour_resets_at": 1779248487,
                    "seven_day_pct": 40.0,
                    "seven_day_resets_at": 1779835287,
                    "updated_at": "2026-05-19T22:42:00+00:00",
                },
            },
        )

    def test_missing_rate_limits_are_null_not_zero(self):
        cases = [
            (None, None),
            (None, RateLimits(1, 2, 3, 4, updated_at="codex-time")),
            (RateLimits(5, 6, 7, 8, updated_at="claude-time"), None),
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

    def test_overview_today_and_week_kpis_still_use_live_entries(self):
        entry = UsageEntry(
            timestamp=datetime.now().astimezone(),
            session_id="s1",
            message_id="m1",
            request_id="r1",
            model="gpt-5",
            input_tokens=10,
            output_tokens=2,
            cache_creation_tokens=1,
            cache_read_tokens=3,
            cost_usd=1.0,
            project="repo-a",
            agent_id="codex",
        )

        with (
            mock.patch("server.load_all_entries", return_value=[entry]) as load_all_entries,
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}) as query_pivot,
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            payload = server.overview({})

        load_all_entries.assert_called_once()
        query_pivot.assert_called_once()
        self.assertEqual(payload["today"]["cost_usd"], 1.0)
        self.assertEqual(payload["today"]["tokens"], 16)
        self.assertEqual(payload["week"]["cost_usd"], 1.0)
        self.assertEqual(payload["week"]["tokens"], 16)

    def test_overview_week_includes_monday_window_metadata(self):
        before = datetime.now().astimezone()
        with (
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.history_gap", return_value=None),
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            payload = server.overview({})
        after = datetime.now().astimezone()

        start = datetime.fromisoformat(payload["week"]["window"]["start"])
        end = datetime.fromisoformat(payload["week"]["window"]["end"])
        self.assertEqual(start, server._start_of_week(before))
        self.assertGreaterEqual(end, before)
        self.assertLessEqual(end, after)

    def test_overview_force_query_runs_rollup_even_when_fresh(self):
        with (
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.run", return_value={"buckets_written": 0}) as run_rollup,
            mock.patch("server.rollup.history_gap", return_value=None),
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            server.overview({"force": ["1"]})

        run_rollup.assert_called_once()

    def test_pivot_endpoint_runs_rollup_when_stale_before_query(self):
        expected = {"columns": ["value"], "rows": []}
        with (
            mock.patch("server.rollup.needs_run", return_value=True),
            mock.patch("server.rollup.run", return_value={"buckets_written": 0}) as run_rollup,
            mock.patch("server.rollup.query_pivot", return_value=expected) as query_pivot,
        ):
            payload = server.pivot_endpoint({"range": ["30d"]})

        self.assertIs(payload, expected)
        run_rollup.assert_called_once()
        query_pivot.assert_called_once()

    def test_pivot_filters_endpoint_reads_rollup_options_for_selected_range(self):
        expected = {
            "agent": ["codex"],
            "project": ["repo-a"],
            "model": ["gpt-5"],
        }
        with (
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.filter_options", return_value=expected) as filter_options,
        ):
            payload = server.pivot_filters_endpoint({"range": ["2y"]})

        self.assertIs(payload, expected)
        filter_options.assert_called_once()
        self.assertIsNotNone(filter_options.call_args.kwargs["time_range"])

    def test_start_background_rollup_spawns_daemon_thread(self):
        with mock.patch("server.threading.Thread") as thread:
            created = thread.return_value
            server._start_background_rollup()

        thread.assert_called_once()
        self.assertTrue(thread.call_args.kwargs["daemon"])
        created.start.assert_called_once()

    def test_overview_includes_history_gap_metadata(self):
        gap = {"latest_date": "2026-06-01", "today": "2026-06-13", "gap_days": 12}
        with (
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.history_gap", return_value=gap),
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            payload = server.overview({})

        self.assertEqual(payload["history_gap"], gap)

    def test_range_window_accepts_long_history_presets(self):
        now = datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc)

        self.assertEqual((now - server._range_window("6m", now)[0]).days, 180)
        self.assertEqual((now - server._range_window("1y", now)[0]).days, 365)
        self.assertEqual((now - server._range_window("2y", now)[0]).days, 730)
        self.assertIsNone(server._range_window("all", now))

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
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.history_gap", return_value=None),
            mock.patch("server.rollup.query_pivot", return_value=expected) as query_pivot,
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            payload = server.overview({"range": ["1y"]})

        self.assertIs(payload["cost_over_time"], expected)
        self.assertEqual(payload["cost_over_time_granularity"], "week")
        query_pivot.assert_called_once()
        self.assertEqual(query_pivot.call_args.args[:3], ("week", "agent", "cost"))

    def test_overview_includes_rollup_coverage_for_long_ranges(self):
        with (
            mock.patch("server.rollup.needs_run", return_value=False),
            mock.patch("server.rollup.history_gap", return_value=None),
            mock.patch("server.rollup.earliest_rollup_date", return_value="2026-04-21"),
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}),
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.claude_status.load_rate_limits", return_value=None),
            mock.patch("server.codex.load_rate_limits", return_value=None),
        ):
            long_payload = server.overview({"range": ["2y"]})
            short_payload = server.overview({"range": ["7d"]})

        self.assertEqual(long_payload["rollup_coverage"]["earliest_date"], "2026-04-21")
        self.assertTrue(long_payload["rollup_coverage"]["partial_before_range"])
        self.assertIsNotNone(long_payload["rollup_coverage"]["range_start"])
        self.assertFalse(short_payload["rollup_coverage"]["partial_before_range"])

    @staticmethod
    def overview_with(claude_limits, codex_limits):
        with (
            mock.patch("server.load_all_entries", return_value=[]),
            mock.patch("server.rollup.query_pivot", return_value={"columns": [], "rows": []}),
            mock.patch("server.claude_status.load_rate_limits", return_value=claude_limits),
            mock.patch("server.codex.load_rate_limits", return_value=codex_limits),
        ):
            return server.overview({})

    def assert_missing_block(self, block):
        self.assertEqual(
            block,
            {
                "five_hour_pct": None,
                "five_hour_resets_at": None,
                "seven_day_pct": None,
                "seven_day_resets_at": None,
                "updated_at": None,
            },
        )


if __name__ == "__main__":
    unittest.main()
