import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from parsers import UsageEntry
from pricing_fetcher import calculate_cost, get_pricing


class CostTests(unittest.TestCase):
    def test_known_model_calculates_cost(self):
        entry = self.entry("claude-opus-4-7")
        cost = calculate_cost(entry, pricing=self.pricing())
        self.assertAlmostEqual(cost, 0.00015 + 0.00015 + 0.00001875 + 0.000003, places=10)

    def test_fuzzy_model_match_calculates_cost(self):
        entry = self.entry("claude-opus-4-7-20251201")
        cost = calculate_cost(entry, pricing=self.pricing())
        self.assertIsNotNone(cost)
        self.assertGreater(cost, 0)

    def test_unknown_model_returns_none_not_zero(self):
        entry = self.entry("fake-model-xyz")
        self.assertIsNone(calculate_cost(entry, pricing=self.pricing()))

    def test_existing_cost_is_preserved(self):
        entry = self.entry("fake-model-xyz", cost=1.23)
        self.assertEqual(calculate_cost(entry, pricing=self.pricing()), 1.23)

    def test_pricing_cache_ttl_refetches_after_seven_days(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "pricing_cache.json"
            now = 1_000_000
            calls = []

            def fetcher():
                calls.append("fetch")
                return self.pricing()

            first = get_pricing(cache_path=cache, fetcher=fetcher, now=lambda: now)
            self.assertEqual(len(calls), 1)
            self.assertIn("claude-opus-4-7", first)

            cached = get_pricing(cache_path=cache, fetcher=fetcher, now=lambda: now + 6 * 24 * 3600)
            self.assertEqual(len(calls), 1)
            self.assertEqual(cached["claude-opus-4-7"]["input_cost_per_token"], 15e-6)

            refreshed = get_pricing(cache_path=cache, fetcher=fetcher, now=lambda: now + 8 * 24 * 3600)
            self.assertEqual(len(calls), 2)
            self.assertIn("claude-opus-4-7", refreshed)

            payload = json.loads(cache.read_text(encoding="utf-8"))
            self.assertIn("fetched_at", payload)
            self.assertIn("data", payload)

    @staticmethod
    def pricing():
        return {
            "claude-opus-4-7": {
                "input_cost_per_token": 15e-6,
                "output_cost_per_token": 75e-6,
                "cache_creation_input_token_cost": 18.75e-6,
                "cache_read_input_token_cost": 1.5e-6,
            },
            "gpt-5": {
                "input_cost_per_token": 1.25e-6,
                "output_cost_per_token": 10e-6,
                "cache_creation_input_token_cost": 1.25e-6,
                "cache_read_input_token_cost": 0.125e-6,
            },
        }

    @staticmethod
    def entry(model, cost=None):
        return UsageEntry(
            timestamp=datetime(2026, 5, 19, tzinfo=timezone.utc),
            session_id="s",
            message_id="m",
            request_id="r",
            model=model,
            input_tokens=10,
            output_tokens=2,
            cache_creation_tokens=1,
            cache_read_tokens=2,
            cost_usd=cost,
            project="repo",
            agent_id="claude-code",
        )


if __name__ == "__main__":
    unittest.main()
