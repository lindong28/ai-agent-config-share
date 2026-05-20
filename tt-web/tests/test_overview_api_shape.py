import unittest
from unittest import mock

import server
from parsers import RateLimits


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

    @staticmethod
    def overview_with(claude_limits, codex_limits):
        with (
            mock.patch("server.load_all_entries", return_value=[]),
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
