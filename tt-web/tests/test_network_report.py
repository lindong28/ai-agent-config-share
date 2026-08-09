import io
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import network_report


def snapshot(**overrides):
    """A fully-observed, low-risk snapshot; overrides carve holes in it."""
    base = {
        "timestamp": "2026-08-07T09:00:00+08:00",
        "verdict": "low",
        "local": {"lan_ip": "192.168.1.2", "ipv6_leaked": False, "dns": [{"ip": "1.1.1.1"}], "dns_has_cn": False},
        "public": {
            "ok": True,
            "ip": "203.0.113.9",
            "country": "Singapore",
            "timezone": "Asia/Singapore",
            "tz_offset": "UTC+08:00",
            "proxy": False,
            "hosting": False,
        },
        "risk": None,
        "spam": None,
        "tz_check": {"cli_tz": "Asia/Singapore", "cli_offset": "UTC+08:00", "matched": True},
        "proxy_envs": {},
        "conclusions": [{"level": "ok", "text": "IPv6 is disabled"}],
        "errors": [],
    }
    base.update(overrides)
    return base


def gaps_by_name(data):
    return {name: reason for name, reason, _ in network_report._gaps(data)}


def verdict_gaps(data):
    return [name for name, _, feeds_verdict in network_report._gaps(data) if feeds_verdict]


class GapTests(unittest.TestCase):
    def test_fully_observed_snapshot_has_no_gaps(self):
        self.assertEqual(network_report._gaps(snapshot()), [])

    def test_no_proxy_or_hosting_flag_is_an_observation_not_a_gap(self):
        # ip-check deliberately skips the risk lookup when ip-api reports no
        # proxy/hosting flag; that negative IS the observation.
        self.assertEqual(network_report._gaps(snapshot(risk=None)), [])

    def test_risk_lookup_that_returned_no_score_is_a_gap(self):
        # Regression: proxycheck timing out yields a truthy risk dict with a
        # null score and an empty errors list, while verdict stays "low".
        # Keying on dict presence reported that as fully observed.
        data = snapshot(
            public={"ok": True, "ip": "203.0.113.9", "proxy": False, "hosting": True, "timezone": "Asia/Singapore"},
            risk={"score": None, "level": None, "type": None, "display": "查询失败（Read timed out）"},
        )
        gaps = gaps_by_name(data)
        self.assertIn(network_report.SECTION_NAMES["risk"], gaps)
        self.assertIn("Read timed out", gaps[network_report.SECTION_NAMES["risk"]])

    def test_failed_public_lookup_is_a_gap_and_does_not_double_report_risk(self):
        gaps = gaps_by_name(snapshot(public={"ok": False, "error": "dns failure"}))
        self.assertIn(network_report.SECTION_NAMES["public"], gaps)
        self.assertNotIn(network_report.SECTION_NAMES["risk"], gaps)

    def test_failed_public_lookup_also_uncovers_the_timezone_signal(self):
        # Regression: collect_all still emits a truthy tz_check with matched=None
        # when the public lookup failed. Gating the tz gap on public.ok let the
        # verdict keep covering a comparison that never happened.
        data = snapshot(
            public={"ok": False, "error": "dns failure"},
            tz_check={"cli_tz": "Asia/Singapore", "cli_offset": "UTC+08:00", "matched": None},
        )
        self.assertIn(network_report.SECTION_NAMES["tz_check"], verdict_gaps(data))

    def test_section_error_entry_is_a_gap(self):
        gaps = gaps_by_name(snapshot(local=None, errors=[{"section": "local", "message": "boom"}]))
        self.assertIn("boom", gaps[network_report.SECTION_NAMES["local"]])

    def test_uncomparable_timezone_is_a_gap(self):
        data = snapshot(tz_check={"cli_tz": "Asia/Singapore", "cli_offset": "UTC+08:00", "matched": None})
        self.assertIn(network_report.SECTION_NAMES["tz_check"], verdict_gaps(data))

    def test_failed_lan_probe_is_a_gap_but_feeds_no_verdict(self):
        # get_lan_ip() returns the string "获取失败" instead of raising.
        data = snapshot(local={"lan_ip": "获取失败", "ipv6_leaked": False, "dns": [{"ip": "1.1.1.1"}], "dns_has_cn": False})
        self.assertIn("局域网 IP", gaps_by_name(data))
        self.assertNotIn("局域网 IP", verdict_gaps(data))

    def test_empty_dns_list_uncovers_the_resolver_signal(self):
        # get_dns_servers() returns [] on failure, which makes dns_has_cn False --
        # identical to "checked, no CN resolver", which the verdict reads as clean.
        data = snapshot(local={"lan_ip": "192.168.1.2", "ipv6_leaked": False, "dns": [], "dns_has_cn": False})
        self.assertIn("DNS 归属", verdict_gaps(data))

    def test_spam_failure_is_a_gap_but_never_caveats_the_verdict(self):
        # Regression: get_stopforumspam() wraps failures into ordinary raw_lines,
        # so errors stays empty and the section stays truthy.
        data = snapshot(spam={"raw_lines": ["查询失败（Read timed out）"]})
        self.assertIn(network_report.SECTION_NAMES["spam"], gaps_by_name(data))
        self.assertNotIn(network_report.SECTION_NAMES["spam"], verdict_gaps(data))

    def test_successful_spam_answer_without_a_score_is_not_a_gap(self):
        # "未收录 低风险 ✓" is a real answer that simply carries no numeric score.
        self.assertEqual(network_report._gaps(snapshot(spam={"raw_lines": ["未收录  低风险 ✓"]})), [])

    def test_missing_spam_section_is_not_a_gap(self):
        self.assertEqual(network_report._gaps(snapshot(spam=None)), [])


class RenderTests(unittest.TestCase):
    def test_unobserved_input_replaces_the_risk_grade_entirely(self):
        # Qualifying "低风险" is not enough: the headline is what a scanning
        # reader acts on, and it read word-for-word the same as a healthy round.
        data = snapshot(
            public={"ok": True, "ip": "203.0.113.9", "proxy": False, "hosting": True, "timezone": "Asia/Singapore"},
            risk={"score": None, "display": "查询失败（Read timed out）"},
        )
        text = network_report.render(data, "test")
        self.assertIn("证据不足", text)
        self.assertNotIn("低风险", text.split("\n")[2])
        self.assertIn(network_report.SECTION_NAMES["risk"], text)

    def test_healthy_round_still_gets_a_risk_grade(self):
        self.assertIn("低风险", network_report.render(snapshot(), "test"))

    def test_failed_probe_naming_the_local_proxy_is_attributed(self):
        # The timed-out address and the proxy env are the same string; joining
        # them is the whole answer the reader came for.
        data = snapshot(
            public={"ok": False, "error": "HTTPConnectionPool(host='127.0.0.1', port=59625): Read timed out."},
            proxy_envs={"HTTP_PROXY": "http://127.0.0.1:59625"},
        )
        text = network_report.render(data, "test")
        self.assertIn("本地代理无响应", text)
        self.assertIn("走同一代理", text)
        self.assertIn("--force", text)

    def test_cascade_of_a_failed_public_lookup_is_not_a_second_attention_item(self):
        data = snapshot(
            public={"ok": False, "error": "dns failure"},
            tz_check={"cli_tz": "Asia/Singapore", "cli_offset": "UTC+08:00", "matched": None},
        )
        attention = network_report.render(data, "test").split("明细")[0]
        self.assertIn(network_report.SECTION_NAMES["public"], attention)
        self.assertNotIn("无法比对：公网信息缺失", attention)

    def test_escalated_lookup_without_a_result_is_not_called_inapplicable(self):
        # hosting=True means the lookup did fire; "不适用" would deny that.
        data = snapshot(
            public={"ok": True, "ip": "203.0.113.9", "proxy": False, "hosting": True, "timezone": "Asia/Singapore"},
            spam=None,
        )
        text = network_report.render(data, "test")
        self.assertNotIn("不适用", text)

    def test_risk_threshold_sits_beside_the_score(self):
        data = snapshot(
            public={"ok": True, "ip": "203.0.113.9", "proxy": False, "hosting": True, "timezone": "Asia/Singapore"},
            risk={"score": 66, "level": "medium", "type": "VPN"},
        )
        self.assertIn("66/100（≥70 判为高风险）", network_report.render(data, "test"))

    def test_clean_snapshot_states_no_action_needed_explicitly(self):
        text = network_report.render(snapshot(), "test")
        self.assertIn("无其他需处置项", text)
        self.assertNotIn("该结论不覆盖", text)

    def test_clean_snapshot_does_not_claim_every_check_was_normal(self):
        # The IPv6 caveat is printed just above; "各项均正常" would contradict it.
        text = network_report.render(snapshot(), "test")
        self.assertNotIn("各项检测均已应答且正常", text)

    def test_verified_ipv6_allows_the_unqualified_no_action_claim(self):
        data = snapshot(
            local={"lan_ip": "192.168.1.2", "ipv6": "2001:db8::1", "ipv6_leaked": True, "dns": [{"ip": "1.1.1.1"}], "dns_has_cn": False},
            conclusions=[],
        )
        self.assertIn("各项检测均已应答且正常", network_report.render(data, "test"))

    def test_findings_are_listed_before_the_detail_block(self):
        data = snapshot(conclusions=[{"level": "bad", "text": "IPv6 leak detected"}])
        text = network_report.render(data, "test")
        self.assertLess(text.index("IPv6 leak detected"), text.index("明细"))

    def test_scope_is_declared_as_this_machine_only(self):
        self.assertIn("仅本机", network_report.render(snapshot(), "test"))

    def test_risk_detail_shows_why_no_score_rather_than_a_dash(self):
        data = snapshot(
            public={"ok": True, "ip": "203.0.113.9", "proxy": False, "hosting": True, "timezone": "Asia/Singapore"},
            risk={"score": None, "display": "查询失败（Read timed out）"},
        )
        self.assertIn("Read timed out", network_report.render(data, "test"))

    def test_spam_raw_lines_are_shown_when_no_score_parsed(self):
        text = network_report.render(snapshot(spam={"raw_lines": ["未收录  低风险"]}), "test")
        self.assertIn("未收录", text)

    def test_any_failed_probe_prevents_the_no_action_claim(self):
        # Spam feeds no verdict, but "nothing needs your attention" still claims
        # more than a round with a timed-out lookup can support.
        text = network_report.render(snapshot(spam={"raw_lines": ["查询失败（Read timed out）"]}), "test")
        self.assertNotIn("无需处置", text)
        self.assertIn("需要注意", text)

    def test_failed_public_lookup_does_not_render_clean_proxy_flags(self):
        # public.get("proxy") on an empty dict is falsy; rendering that as "否"
        # reports a negative the lookup never produced.
        text = network_report.render(snapshot(public={"ok": False, "error": "dns failure"}), "test")
        self.assertIn("标记为代理", text)
        self.assertNotIn("标记为代理            否", text)
        self.assertIn("未知：公网查询失败", text)

    def test_failed_public_lookup_does_not_claim_the_risk_lookup_was_skipped(self):
        text = network_report.render(snapshot(public={"ok": False, "error": "dns failure"}), "test")
        self.assertNotIn("无 proxy / hosting 标记", text)

    def test_absent_ipv6_is_not_reported_as_disabled(self):
        # ip-check returns None both for "IPv6 is off" and "the probe failed", and
        # states the conclusion as fact anyway. Asserting only that the Chinese
        # "已禁用" is absent passes while upstream's English claim still prints.
        data = snapshot(
            conclusions=[
                {"level": "ok", "text": "IPv6 is disabled; no IPv6 leak detected"},
                {"level": "ok", "text": "No CN DNS resolver detected"},
            ]
        )
        text = network_report.render(data, "test")
        self.assertIn("未检出地址", text)
        self.assertIn("IPv6 一路不在结论覆盖内", text)
        # Upstream's English conclusion strings are not passed through at all;
        # 明细 carries the same facts in the reader's language.
        self.assertNotIn("IPv6 is disabled", text)
        self.assertNotIn("No CN DNS resolver detected", text)
        self.assertIn("无 CN 解析器", text)

    def test_leaked_ipv6_keeps_its_conclusion_and_drops_the_caveat(self):
        data = snapshot(
            local={"lan_ip": "192.168.1.2", "ipv6": "2001:db8::1", "ipv6_leaked": True, "dns": [{"ip": "1.1.1.1"}], "dns_has_cn": False},
            conclusions=[{"level": "bad", "text": "IPv6 leak detected; real address is exposed"}],
        )
        text = network_report.render(data, "test")
        self.assertIn("泄漏：2001:db8::1", text)
        self.assertNotIn("IPv6 一路不在结论覆盖内", text)

    def test_empty_dns_list_is_not_rendered_as_no_cn_resolver(self):
        data = snapshot(local={"lan_ip": "192.168.1.2", "ipv6_leaked": False, "dns": [], "dns_has_cn": False})
        text = network_report.render(data, "test")
        self.assertIn("未取得解析器列表", text)
        self.assertNotIn("无 CN 解析器", text)

    def test_proxy_credentials_are_redacted(self):
        text = network_report.render(snapshot(proxy_envs={"HTTPS_PROXY": "http://alice:s3cret@proxy:8080"}), "test")
        self.assertNotIn("s3cret", text)
        self.assertNotIn("alice", text)
        self.assertIn("proxy:8080", text)

    def test_credential_free_proxy_url_is_shown_verbatim(self):
        text = network_report.render(snapshot(proxy_envs={"HTTP_PROXY": "http://127.0.0.1:59625"}), "test")
        self.assertIn("http://127.0.0.1:59625", text)

    def test_remediation_pointer_is_an_absolute_path(self):
        # The command is installed into ~/.local/bin and runs from any directory.
        text = network_report.render(snapshot(conclusions=[{"level": "bad", "text": "IPv6 leak"}]), "test")
        self.assertIn(str(network_report.ROOT / "NETWORK-REMEDIATION.md"), text)


class ColumnWidthTests(unittest.TestCase):
    def test_cjk_characters_count_as_two_columns(self):
        self.assertEqual(network_report._columns("公网 IP"), 7)

    def test_padding_aligns_mixed_width_labels(self):
        widths = {network_report._columns(network_report._pad(label, 20)) for label in ("公网 IP", "ISP", "本地代理环境变量")}
        self.assertEqual(widths, {20})


class ExitCodeTests(unittest.TestCase):
    """Exit code reports whether a report was produced, not how risky it is."""

    def _run(self, snap, argv=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(network_report, "collect", return_value=(snap, "test")):
            with redirect_stdout(out), redirect_stderr(err):
                code = network_report.main(argv or [])
        return code, out.getvalue(), err.getvalue()

    def test_high_verdict_still_exits_zero(self):
        code, out, _ = self._run(snapshot(verdict="high"))
        self.assertEqual(code, 0)
        self.assertIn("高风险", out)

    def test_missing_ip_check_exits_two_with_an_install_hint(self):
        code, _, err = self._run({"installed": False, "error": "not found", "verdict": "unknown"})
        self.assertEqual(code, 2)
        self.assertIn(str(network_report.ROOT / "install.sh"), err)

    def test_failed_check_exits_two(self):
        code, _, err = self._run({"error": "ip-check timeout (>30s)", "verdict": "unknown"})
        self.assertEqual(code, 2)
        self.assertIn("timeout", err)

    def test_collection_failure_exits_two(self):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(network_report, "collect", side_effect=OSError("no interpreter")):
            with redirect_stdout(out), redirect_stderr(err):
                code = network_report.main([])
        self.assertEqual(code, 2)
        self.assertIn("no interpreter", err.getvalue())

    def test_json_mode_emits_the_raw_snapshot_unwrapped(self):
        import json

        code, out, _ = self._run(snapshot(), ["--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["verdict"], "low")

    def test_json_mode_propagates_the_unavailable_exit_code(self):
        code, _, _ = self._run({"error": "boom", "verdict": "unknown"}, ["--json"])
        self.assertEqual(code, 2)


class CollectTests(unittest.TestCase):
    def test_dead_server_falls_back_to_in_process_check(self):
        with mock.patch.object(network_report, "_live_server_port", return_value=None):
            with mock.patch.dict("sys.modules", {"server": mock.Mock(network=lambda _query: {"verdict": "low"})}):
                data, note = network_report.collect()
        self.assertEqual(data["verdict"], "low")
        self.assertIn("未运行", note)

    def test_server_source_note_claims_a_shared_cache_not_identical_bytes(self):
        # The server neither locks nor coalesces concurrent cache misses.
        response = mock.MagicMock()
        response.__enter__.return_value = io.BytesIO(b'{"verdict": "low"}')
        with mock.patch.object(network_report, "_live_server_port", return_value=39001):
            with mock.patch.object(network_report.urllib.request, "urlopen", return_value=response):
                _, note = network_report.collect()
        self.assertIn("缓存快照", note)
        self.assertNotIn("同一份快照", note)

    def test_unreachable_server_falls_back_and_says_so(self):
        with mock.patch.object(network_report, "_live_server_port", return_value=39001):
            with mock.patch.object(network_report.urllib.request, "urlopen", side_effect=OSError("refused")):
                with mock.patch.dict("sys.modules", {"server": mock.Mock(network=lambda _query: {"verdict": "low"})}):
                    _, note = network_report.collect()
        self.assertIn("取数失败", note)
        self.assertIn("refused", note)

    def test_force_is_passed_through_to_the_in_process_check(self):
        seen = {}

        def network(query):
            seen.update(query)
            return {"verdict": "low"}

        with mock.patch.object(network_report, "_live_server_port", return_value=None):
            with mock.patch.dict("sys.modules", {"server": mock.Mock(network=network)}):
                network_report.collect(force=True)
        self.assertEqual(seen.get("force"), ["1"])


if __name__ == "__main__":
    unittest.main()
