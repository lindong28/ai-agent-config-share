import json
import os
import tempfile
import unittest
from pathlib import Path

from parsers import codex


class CodexRateLimitsTests(unittest.TestCase):
    def _write_session(self, path, session_id, timestamp, primary, secondary):
        rows = [
            {"timestamp": timestamp, "type": "session_meta", "payload": {"id": session_id}},
            {
                "timestamp": timestamp,
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "rate_limits": {"primary": primary, "secondary": secondary},
                },
            },
        ]
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")

    def test_single_weekly_primary_window_maps_to_seven_day_quota(self):
        rows = [
            {
                "timestamp": "2026-07-14T10:48:14.383Z",
                "type": "session_meta",
                "payload": {"id": "session-1"},
            },
            {
                "timestamp": "2026-07-14T10:48:14.383Z",
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "rate_limits": {
                        "primary": {
                            "used_percent": 19.0,
                            "window_minutes": 10080,
                            "resets_at": 4102444800,
                        },
                        "secondary": None,
                    },
                },
            },
        ]

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
            limits = codex._extract_rate_limits(path, {"session-1": "gpt-5.6"})

        self.assertIsNotNone(limits)
        self.assertIsNone(limits.five_hour_pct)
        self.assertIsNone(limits.five_hour_resets_at)
        self.assertEqual(limits.seven_day_pct, 19.0)
        self.assertEqual(limits.seven_day_resets_at, 4102444800)

    def test_tagged_legacy_windows_keep_five_hour_and_seven_day_quotas(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            self._write_session(
                path,
                "legacy-tagged",
                "2026-07-14T10:48:14.383Z",
                {"used_percent": 12.0, "window_minutes": 300, "resets_at": 4102444800},
                {"used_percent": 34.0, "window_minutes": 10080, "resets_at": 4102444801},
            )
            limits = codex._extract_rate_limits(path, {})

        self.assertEqual(limits.five_hour_pct, 12.0)
        self.assertEqual(limits.seven_day_pct, 34.0)

    def test_untagged_legacy_windows_fall_back_to_positional_mapping(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            self._write_session(
                path,
                "legacy-positional",
                "2026-07-14T10:48:14.383Z",
                {"used_percent": 12.0, "resets_at": 4102444800},
                {"used_percent": 34.0, "resets_at": 4102444801},
            )
            limits = codex._extract_rate_limits(path, {})

        self.assertEqual(limits.five_hour_pct, 12.0)
        self.assertEqual(limits.seven_day_pct, 34.0)

    def test_partially_tagged_legacy_windows_preserve_the_untagged_secondary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            self._write_session(
                path,
                "legacy-partial",
                "2026-07-14T10:48:14.383Z",
                {"used_percent": 12.0, "window_minutes": 300, "resets_at": 4102444800},
                {"used_percent": 34.0, "resets_at": 4102444801},
            )
            limits = codex._extract_rate_limits(path, {})

        self.assertEqual(limits.five_hour_pct, 12.0)
        self.assertEqual(limits.seven_day_pct, 34.0)

    def test_load_rate_limits_uses_latest_event_timestamp_across_sessions(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            older = root / "older.jsonl"
            newer = root / "newer.jsonl"
            self._write_session(
                older,
                "older",
                "2026-07-14T10:00:00Z",
                {"used_percent": 88.0, "window_minutes": 10080, "resets_at": 4102444800},
                None,
            )
            self._write_session(
                newer,
                "newer",
                "2026-07-14T12:00:00Z",
                {"used_percent": 22.0, "window_minutes": 10080, "resets_at": 4102444800},
                None,
            )
            os.utime(older, (2000, 2000))
            os.utime(newer, (1000, 1000))

            limits = codex.load_rate_limits(root, state_db="/nonexistent")

        self.assertEqual(limits.seven_day_pct, 22.0)
        self.assertEqual(limits.updated_at, "2026-07-14T12:00:00Z")

    def test_load_rate_limits_compares_naive_and_aware_timestamps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_session(
                root / "aware.jsonl",
                "aware",
                "2026-07-14T12:00:00Z",
                {"used_percent": 22.0, "window_minutes": 10080, "resets_at": 4102444800},
                None,
            )
            self._write_session(
                root / "naive.jsonl",
                "naive",
                "2026-07-14T13:00:00",
                {"used_percent": 33.0, "window_minutes": 10080, "resets_at": 4102444800},
                None,
            )

            limits = codex.load_rate_limits(root, state_db="/nonexistent")

        self.assertEqual(limits.seven_day_pct, 33.0)


class ReadingPlanTests(unittest.TestCase):
    """The plan Codex states inside the same object as the percentages.

    It matters because it is the only plan known to come from the same event
    as them — same event, not same observation: once a window's reset time has
    passed its percentage is rewritten to zero while this keeps what the event
    reported.
    The plan in `~/.codex/auth.json` is a separate fact on its own clock, and
    pairing that one with these numbers is what put "Pro Lite" next to a quota
    that had already reset to 0% under Pro — see ADR 20260822-586a.
    """

    def load(self, rate_limits):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rows = [
                {
                    "timestamp": "2026-08-22T00:58:29Z",
                    "type": "session_meta",
                    "payload": {"id": "session-1"},
                },
                {
                    "timestamp": "2026-08-22T00:58:29Z",
                    "type": "event_msg",
                    "payload": {"type": "token_count", "rate_limits": rate_limits},
                },
            ]
            (root / "session.jsonl").write_text(
                "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
            )
            return codex.load_rate_limits(root, state_db="/nonexistent")

    window = {"used_percent": 0.0, "window_minutes": 10080, "resets_at": 4102444800}

    def test_the_reading_carries_the_plan_it_was_reported_with(self):
        limits = self.load({"primary": dict(self.window), "plan_type": "pro"})

        self.assertEqual(limits.plan, "pro")
        self.assertEqual(limits.seven_day_pct, 0.0)

    def test_a_reading_without_a_plan_carries_none_rather_than_inventing_one(self):
        self.assertIsNone(self.load({"primary": dict(self.window)}).plan)

    def test_a_plan_that_is_not_a_usable_string_reads_as_absent(self):
        """`rate_limits` has no wire schema, and this value ends up both in a
        rendered label and in the equality that decides whether the two plan
        sources disagree. A truthy non-string would pass `or` and reach both."""
        for value in (7, True, {"tier": "pro"}, [], "", None):
            with self.subTest(value=value):
                limits = self.load({"primary": dict(self.window), "plan_type": value})
                self.assertIsNone(limits.plan)


if __name__ == "__main__":
    unittest.main()
