import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from parsers import claude_status


class ClaudeStatusParserTests(unittest.TestCase):
    def test_happy_path_loads_rate_limits_model_and_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            self._write_status(
                status_file,
                {
                    "_received_at": "2026-05-19T22:41:23+00:00",
                    "model": {"id": "claude-opus-4-7[1m]"},
                    "rate_limits": {
                        "five_hour": {"used_percentage": 14.5, "resets_at": self.future_ts(5)},
                        "seven_day": {"used_percentage": 39, "resets_at": self.future_ts(48)},
                    },
                },
            )

            limits = claude_status.load_rate_limits(status_file)

        self.assertIsNotNone(limits)
        self.assertEqual(limits.five_hour_pct, 14.5)
        self.assertEqual(limits.seven_day_pct, 39)
        self.assertEqual(limits.model, "claude-opus-4-7[1m]")
        self.assertEqual(limits.updated_at, "2026-05-19T22:41:23+00:00")

    def test_missing_file_returns_none(self):
        self.assertIsNone(claude_status.load_rate_limits("/tmp/does-not-exist-tt-status.json"))

    def test_bad_json_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            status_file.write_text("{not json", encoding="utf-8")

            self.assertIsNone(claude_status.load_rate_limits(status_file))

    def test_missing_received_at_leaves_updated_at_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            self._write_status(
                status_file,
                {
                    "model": {"id": "claude-opus-4-7"},
                    "rate_limits": {
                        "five_hour": {"used_percentage": 20, "resets_at": self.future_ts(5)},
                        "seven_day": {"used_percentage": 30, "resets_at": self.future_ts(48)},
                    },
                },
            )

            limits = claude_status.load_rate_limits(status_file)

        self.assertEqual(limits.updated_at, "")

    def test_missing_model_id_leaves_model_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            self._write_status(
                status_file,
                {
                    "_received_at": "2026-05-19T22:41:23+00:00",
                    "model": {},
                    "rate_limits": {
                        "five_hour": {"used_percentage": 20, "resets_at": self.future_ts(5)},
                        "seven_day": {"used_percentage": 30, "resets_at": self.future_ts(48)},
                    },
                },
            )

            limits = claude_status.load_rate_limits(status_file)

        self.assertEqual(limits.model, "")

    def test_expired_reset_zeroes_percentage(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            self._write_status(
                status_file,
                {
                    "_received_at": "2026-05-19T22:41:23+00:00",
                    "model": {"id": "claude-opus-4-7"},
                    "rate_limits": {
                        "five_hour": {"used_percentage": 88, "resets_at": self.past_ts(1)},
                        "seven_day": {"used_percentage": 30, "resets_at": self.future_ts(48)},
                    },
                },
            )

            limits = claude_status.load_rate_limits(status_file)

        self.assertEqual(limits.five_hour_pct, 0.0)
        self.assertEqual(limits.seven_day_pct, 30)

    def test_missing_rate_limits_returns_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            status_file = Path(tmp) / "tt-status.json"
            self._write_status(status_file, {"_received_at": "2026-05-19T22:41:23+00:00"})

            self.assertIsNone(claude_status.load_rate_limits(status_file))

    @staticmethod
    def _write_status(path: Path, payload: dict) -> None:
        path.write_text(json.dumps(payload), encoding="utf-8")

    @staticmethod
    def future_ts(hours: int) -> float:
        return (datetime.now(timezone.utc) + timedelta(hours=hours)).timestamp()

    @staticmethod
    def past_ts(hours: int) -> float:
        return (datetime.now(timezone.utc) - timedelta(hours=hours)).timestamp()


if __name__ == "__main__":
    unittest.main()
