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


if __name__ == "__main__":
    unittest.main()
