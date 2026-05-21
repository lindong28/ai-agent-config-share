import contextlib
import unittest
from unittest import mock

from ip_check import cli


PUBLIC_OK = {
    "status": "success",
    "query": "1.2.3.4",
    "country": "United States",
    "regionName": "California",
    "city": "Los Angeles",
    "isp": "Example ISP",
    "org": "Example Org",
    "timezone": "America/Los_Angeles",
    "proxy": False,
    "hosting": False,
}

PUBLIC_PROXY_OK = {
    **PUBLIC_OK,
    "proxy": True,
}

DEFAULT_RETURNS = {
    "get_lan_ip": "192.168.1.9",
    "get_ipv6": None,
    "get_dns_servers": ["1.1.1.1", "8.8.8.8"],
    "get_public_info": PUBLIC_OK,
    "get_ip_risk": ("\033[92m0/100 low  类型 Business\033[0m", 0),
    "get_stopforumspam": ["\033[92m0.1/100 low  举报 1 次\033[0m", "最近举报 2026-03-10"],
    "get_proxy_envs": {},
    "get_cli_tz_name": ("America/Los_Angeles", True),
}

TOP_LEVEL_KEYS = (
    "version",
    "timestamp",
    "system",
    "local",
    "public",
    "risk",
    "spam",
    "proxy_envs",
    "tz_check",
    "conclusions",
    "verdict",
    "errors",
)


class CollectAllTests(unittest.TestCase):
    def test_happy_path(self):
        result = self.collect()

        for key in TOP_LEVEL_KEYS:
            self.assertIn(key, result)
        self.assertEqual(result["verdict"], "low")
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["local"]["lan_ip"], "192.168.1.9")
        self.assertFalse(result["local"]["ipv6_leaked"])
        self.assertIsNone(result["risk"])
        self.assertIsNone(result["spam"])
        self.assertTrue(all(ord(ch) < 128 for item in result["conclusions"] for ch in item["text"]))

    def test_public_failure(self):
        result = self.collect(get_public_info=RuntimeError("timeout"))

        self.assertIsNone(result["public"])
        self.assert_error_section(result, "public")
        self.assertIsNotNone(result["local"])
        self.assertIsNotNone(result["tz_check"])

    def test_risk_failure(self):
        result = self.collect(
            get_public_info=PUBLIC_PROXY_OK,
            get_ip_risk=RuntimeError("risk timeout"),
        )

        self.assertIsNone(result["risk"])
        self.assert_error_section(result, "risk")
        self.assertTrue(result["public"]["ok"])
        self.assertEqual(
            result["spam"]["raw_lines"],
            ["0.1/100 low  举报 1 次", "最近举报 2026-03-10"],
        )

    def test_spam_failure(self):
        result = self.collect(
            get_public_info=PUBLIC_PROXY_OK,
            get_stopforumspam=RuntimeError("spam timeout"),
        )

        self.assertIsNone(result["spam"])
        self.assert_error_section(result, "spam")
        self.assertTrue(result["public"]["ok"])
        self.assertEqual(result["risk"]["score"], 0)

    def test_local_failure(self):
        result = self.collect(get_dns_servers=RuntimeError("dns timeout"))

        self.assertIsNone(result["local"])
        self.assert_error_section(result, "local")
        self.assertTrue(result["public"]["ok"])
        self.assertIsNotNone(result["tz_check"])

    def test_proxy_envs_failure(self):
        result = self.collect(get_proxy_envs=RuntimeError("env timeout"))

        self.assertEqual(result["proxy_envs"], {})
        self.assert_error_section(result, "proxy_envs")
        self.assertIsNotNone(result["local"])
        self.assertTrue(result["public"]["ok"])

    def test_tz_check_failure(self):
        result = self.collect(get_cli_tz_name=RuntimeError("tz timeout"))

        self.assertIsNone(result["tz_check"])
        self.assert_error_section(result, "tz_check")
        self.assertIsNotNone(result["local"])
        self.assertTrue(result["public"]["ok"])

    def test_ipv6_leaked(self):
        result = self.collect(get_ipv6="2001:db8::1")

        self.assertTrue(result["local"]["ipv6_leaked"])
        self.assertEqual(result["verdict"], "high")
        self.assertTrue(
            any(c["level"] == "bad" and "IPv6" in c["text"] for c in result["conclusions"])
        )

    def test_dns_has_cn(self):
        result = self.collect(get_dns_servers=["223.5.5.5"])

        self.assertTrue(result["local"]["dns_has_cn"])
        self.assertEqual(result["verdict"], "high")
        self.assertTrue(
            any(c["level"] == "bad" and "DNS" in c["text"] for c in result["conclusions"])
        )

    def test_tz_mismatched(self):
        result = self.collect(get_cli_tz_name=("Asia/Shanghai", True))

        self.assertFalse(result["tz_check"]["matched"])
        self.assertEqual(result["verdict"], "high")
        self.assertTrue(
            any("Timezone mismatch" in c["text"] for c in result["conclusions"])
        )

    def test_proxy_in_use_verdict(self):
        result = self.collect(get_public_info=PUBLIC_PROXY_OK)

        self.assertEqual(result["verdict"], "proxy-in-use")
        self.assertEqual(result["risk"]["score"], 0)
        self.assertEqual(result["risk"]["type"], "Business")
        self.assertTrue(result["risk"]["marked_proxy"])
        self.assertTrue(
            any(
                c["level"] == "warn" and "IP marked as proxy/VPN" in c["text"]
                for c in result["conclusions"]
            )
        )

    def test_high_verdict_overrides_proxy_in_use(self):
        result = self.collect(get_public_info=PUBLIC_PROXY_OK, get_ip_risk=("75/100 high  类型 VPN", 75))

        self.assertEqual(result["verdict"], "high")
        self.assertEqual(result["risk"]["type"], "VPN")
        self.assertTrue(
            any(c["level"] == "bad" and "IP risk is high" in c["text"] for c in result["conclusions"])
        )

    def test_spam_lines_are_structured(self):
        result = self.collect(get_public_info=PUBLIC_PROXY_OK)

        self.assertEqual(result["spam"]["score"], 0.1)
        self.assertEqual(result["spam"]["level"], "low")
        self.assertEqual(result["spam"]["frequency"], 1)
        self.assertEqual(result["spam"]["last_seen"], "2026-03-10")
        self.assertEqual(
            result["spam"]["raw_lines"],
            ["0.1/100 low  举报 1 次", "最近举报 2026-03-10"],
        )

    def collect(self, **overrides):
        with contextlib.ExitStack() as stack:
            for name, default in DEFAULT_RETURNS.items():
                value = overrides.get(name, default)
                if isinstance(value, BaseException):
                    stack.enter_context(mock.patch.object(cli, name, side_effect=value))
                else:
                    stack.enter_context(mock.patch.object(cli, name, return_value=value))
            return cli.collect_all()

    def assert_error_section(self, result, section):
        self.assertTrue(
            any(error.get("section") == section for error in result["errors"]),
            result["errors"],
        )


if __name__ == "__main__":
    unittest.main()
