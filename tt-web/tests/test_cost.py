import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from parsers import UsageEntry
from pricing_fetcher import calculate_cost, get_pricing, resolve_model_key


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

    def test_one_hour_cache_creation_uses_the_higher_rate(self):
        pricing = self.pricing()
        # entry(): 10 input, 2 output, 1 cache creation, 2 cache read.
        all_1h = replace(self.entry("claude-opus-4-7"), cache_creation_1h_tokens=1)
        cost = calculate_cost(all_1h, pricing=pricing)
        self.assertAlmostEqual(cost, 10 * 15e-6 + 2 * 75e-6 + 30e-6 + 2 * 1.5e-6, places=12)

    def test_one_hour_cache_creation_falls_back_to_five_minute_rate(self):
        pricing = {"no-1hr-rate": {k: v for k, v in self.pricing()["claude-opus-4-7"].items()}}
        del pricing["no-1hr-rate"]["cache_creation_input_token_cost_above_1hr"]
        base = self.entry("no-1hr-rate")
        all_1h = replace(base, cache_creation_1h_tokens=base.cache_creation_tokens)
        self.assertEqual(
            calculate_cost(all_1h, pricing=pricing), calculate_cost(base, pricing=pricing)
        )

    def test_one_hour_split_cannot_exceed_the_cache_creation_total(self):
        pricing = self.pricing()
        base = self.entry("claude-opus-4-7")
        overstated = replace(base, cache_creation_1h_tokens=base.cache_creation_tokens + 500)
        capped = replace(base, cache_creation_1h_tokens=base.cache_creation_tokens)
        self.assertEqual(
            calculate_cost(overstated, pricing=pricing), calculate_cost(capped, pricing=pricing)
        )

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

    def test_fresh_cache_is_supplemented_by_bundled_glm_estimates(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cache = root / "pricing_cache.json"
            fallback = root / "pricing.json"
            now = 1_000_000
            cached_pricing = {
                "gpt-5": self.pricing()["gpt-5"],
                "cached-only": {"input_cost_per_token": 9},
            }
            fallback_pricing = {
                "glm-5.2": self.glm_estimate(),
                "glm-5.1": self.glm_estimate(),
                "cached-only": {"input_cost_per_token": 99},
            }
            cache.write_text(
                json.dumps({"fetched_at": now, "data": cached_pricing}),
                encoding="utf-8",
            )
            fallback.write_text(json.dumps(fallback_pricing), encoding="utf-8")

            with mock.patch("pricing_fetcher.FALLBACK_PATH", fallback):
                pricing = get_pricing(cache_path=cache, fetcher=None, now=lambda: now + 60)

            self.assertEqual(pricing["cached-only"]["input_cost_per_token"], 9)
            self.assertEqual(resolve_model_key("glm-5.2", pricing), "glm-5.2")
            self.assertEqual(resolve_model_key("glm-5.2[1m]", pricing), "glm-5.2")
            self.assertEqual(resolve_model_key("glm-5.1", pricing), "glm-5.1")
            self.assertGreater(calculate_cost(self.entry("glm-5.2"), pricing=pricing), 0)
            self.assertGreater(calculate_cost(self.entry("glm-5.2[1m]"), pricing=pricing), 0)

    @staticmethod
    def pricing():
        return {
            "claude-opus-4-7": {
                "input_cost_per_token": 15e-6,
                "output_cost_per_token": 75e-6,
                "cache_creation_input_token_cost": 18.75e-6,
                "cache_creation_input_token_cost_above_1hr": 30e-6,
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
    def glm_estimate():
        return {
            "input_cost_per_token": 1e-6,
            "output_cost_per_token": 3.2e-6,
            "cache_creation_input_token_cost": 0,
            "cache_read_input_token_cost": 2e-7,
            "estimated": True,
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
