"""出口代理的选路：探测该走哪个地址，以及这个答案从哪来。

这些用例守的是一个具体故障：tt-web server 是长驻进程，它在 fork 时拷贝一次
HTTP_PROXY，此后线路再切都与它无关。每条线路的端口固定且互不相同，所以启动时
是腾讯线路、之后切到 GCP，就会让它一直朝一个已经停掉的端口发请求——公网信息
永远查不到，而错误里指的还是那个早已无人监听的端口。
"""

import os
import tempfile
import unittest
from unittest import mock

import requests

from ip_check import cli


class ResolveRouteTests(unittest.TestCase):
    """resolve_route 的三态：published / unpublished / invalid。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.published = os.path.join(self.tmp.name, "current-proxy")

    def _write(self, text):
        with open(self.published, "w") as fh:
            fh.write(text)
        return mock.patch.object(cli, "AGENT_PROXY_PUBLISHED", self.published)

    def _missing(self):
        return mock.patch.object(
            cli, "AGENT_PROXY_PUBLISHED", os.path.join(self.tmp.name, "nope")
        )

    def test_published_address_wins_over_stale_env(self):
        """核心回归：env 指着已死的线路时，探测必须走发布文件说的那个。"""
        with self._write("http://127.0.0.1:59520\n"), mock.patch.dict(
            os.environ, {"HTTP_PROXY": "http://127.0.0.1:59625"}, clear=False
        ):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "published")
        self.assertEqual(route["address"], "http://127.0.0.1:59520")

    def test_empty_published_file_means_direct(self):
        """直连要能压过环境变量，否则「这条线路不走代理」根本无法表达。"""
        with self._write("\n"):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "published")
        self.assertEqual(route["address"], "")
        self.assertEqual(route["reason"], "")
        # path 一并带出，报告才能告诉读者去哪看、改什么，而不必自己拼一个可能对不上的。
        self.assertEqual(route["path"], self.published)

    def test_missing_file_does_not_claim_direct(self):
        """读不到 ≠ 该直连。误判成直连会绕开这台主机本来要走的代理。"""
        with self._missing():
            route = cli.resolve_route()
        self.assertEqual(route["source"], "unpublished")
        self.assertEqual(route["address"], "")
        self.assertEqual(route["reason"], "不存在")

    def test_unreadable_file_is_unpublished_not_direct(self):
        """权限异常与"文件不存在"同类：问不出答案，而不是答案为直连。"""
        with open(self.published, "w") as fh:
            fh.write("http://127.0.0.1:59520\n")
        os.chmod(self.published, 0o000)
        self.addCleanup(os.chmod, self.published, 0o600)
        if os.access(self.published, os.R_OK):
            self.skipTest("以 root 运行时权限位拦不住读取")
        with mock.patch.object(cli, "AGENT_PROXY_PUBLISHED", self.published):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "unpublished")
        # 不能报成"不存在"——那会让读者去创建一个已经在那儿的文件。
        self.assertEqual(route["reason"], "没有读取权限")

    def test_directory_in_place_of_file_is_unpublished(self):
        path = os.path.join(self.tmp.name, "as-dir")
        os.mkdir(path)
        with mock.patch.object(cli, "AGENT_PROXY_PUBLISHED", path):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "unpublished")
        self.assertEqual(route["reason"], "是一个目录，不是文件")

    def test_route_name_instead_of_url_is_invalid(self):
        """写入方若写了线路名而非地址，塞进 proxies 会让三个探测一起失败。"""
        with self._write("gcp\n"):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "invalid")
        self.assertEqual(route["address"], "")
        self.assertIn("gcp", route["reason"])

    def test_multiline_or_garbage_content_is_invalid(self):
        for junk in ("http://a:1\nhttp://b:2\n", "# comment\n", "127.0.0.1:59520\n"):
            with self.subTest(junk=junk), self._write(junk):
                self.assertEqual(cli.resolve_route()["source"], "invalid")

    def test_url_shaped_but_unusable_values_are_invalid(self):
        """形似 URL 却 requests 用不了的值——正则会放过，urlsplit 不会。

        `5952O` 是端口里把 0 打成字母 O，手工维护这个文件时的现实输入；它一旦被判成
        published，环境变量就被关掉、坏值交给三个请求，比不接管更难查。
        """
        for junk in (
            "http://127.0.0.1:5952O",   # 字母 O 冒充 0
            "http://:59520",            # 没有主机
            "http://host:99999",        # 端口越界
            "file://tmp",               # requests 不能当代理用的 scheme
            "http://127.0.0.1:59520/path",
            "http://host:\t8080",       # urlsplit 会剥掉 tab，urllib3 不会
            "socks5://127.0.0.1:1080",  # 语法合法，但本环境没装 PySocks
            "socks5h://127.0.0.1:1080",
        ):
            with self.subTest(junk=junk), self._write(junk + "\n"):
                self.assertEqual(
                    cli.resolve_route()["source"], "invalid",
                    "%r 被误判为可用地址" % junk,
                )

    def test_accepted_schemes_are_the_ones_this_env_can_actually_use(self):
        """判据是"这个进程此刻真能用"，不是"requests 名义上支持"。

        SOCKS 需要 PySocks，本环境没装：放行它等于关掉环境代理后让三个探测一起挂在
        `InvalidSchema: Missing dependencies for SOCKS support`。
        """
        for good in ("https://proxy.corp:8443", "http://127.0.0.1:59520/",
                     "http://127.0.0.1:59520"):
            with self.subTest(good=good), self._write(good + "\n"):
                self.assertEqual(cli.resolve_route()["source"], "published")
        # 不断言"本 venv 必须没有 PySocks"：那会把一个可选包的缺席钉成单测不变量，
        # 别的消费者装上它就会让这个用例失败，而生产行为其实没变。SOCKS 被拒的断言
        # 在上一个用例里，那已经足够守住契约。

    def test_non_utf8_content_degrades_instead_of_killing_the_report(self):
        """这行在 collect_all 的各段保护性 try 之外，漏出去整份报告就生不出来。"""
        with open(self.published, "wb") as fh:
            fh.write(b"\xff\xfe not text\n")
        with mock.patch.object(cli, "AGENT_PROXY_PUBLISHED", self.published):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "invalid")

    def test_credentials_are_redacted_from_the_reason(self):
        """reason 会进终端与 JSON，可能被截图或贴进 issue。"""
        with self._write("http://alice:hunter2@proxy.corp:8080 extra\n"):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "invalid")
        self.assertNotIn("hunter2", route["reason"])
        self.assertIn("***", route["reason"])

    def test_long_credentials_are_redacted_before_truncation(self):
        """先截断再遮盖的话，`@` 会被甩到 80 字符之外，遮盖正则就看不见它了。"""
        secret = "p" * 90
        with self._write("http://alice:%s@proxy.corp:8080 extra\n" % secret):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "invalid")
        self.assertNotIn("pppp", route["reason"])

    def test_malformed_userinfo_with_whitespace_is_still_redacted(self):
        """会走到 invalid 的多半是手滑写法；那里面的密码同样是密码。"""
        with self._write("http://alice:hunter2 @proxy.corp:8080\n"):
            route = cli.resolve_route()
        self.assertEqual(route["source"], "invalid")
        self.assertNotIn("hunter2", route["reason"])

    def test_surrounding_whitespace_is_tolerated(self):
        with self._write("  http://127.0.0.1:59520  \n"):
            self.assertEqual(cli.resolve_route()["address"], "http://127.0.0.1:59520")


class EgressSessionTests(unittest.TestCase):
    """_egress_session: 选路结果必须真的作用到出站请求上。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_published_route_pins_proxies_and_ignores_env(self):
        route = {"address": "http://127.0.0.1:59520", "source": "published", "reason": ""}
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:59625"}, clear=False):
            session = cli._egress_session(route)
        self.assertEqual(
            session.proxies,
            {"http": "http://127.0.0.1:59520", "https": "http://127.0.0.1:59520"},
        )
        # trust_env 若为真，requests 在发请求时会把 env 里那个已死的地址重新合并进来，
        # 上面那条 proxies 断言照样通过，而实际出站又回到了坏端口。
        self.assertFalse(session.trust_env)

    def test_direct_route_actually_bypasses_env_proxy(self):
        """直连时只清 proxies 不够——断言落在 requests 真正会用的合并结果上。"""
        route = {"address": "", "source": "published", "reason": ""}
        with mock.patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:59625"}, clear=False):
            session = cli._egress_session(route)
            merged = session.merge_environment_settings(
                "http://ip-api.com/json/", {}, None, None, None
            )
        self.assertEqual(merged["proxies"], {})

    def test_unpublished_keeps_requests_default_behaviour(self):
        """发布方缺席时不接管：那台主机的 env 该怎么用还怎么用。"""
        for source in ("unpublished", "invalid"):
            with self.subTest(source=source):
                session = cli._egress_session({"address": "", "source": source, "reason": ""})
                self.assertTrue(session.trust_env)
                self.assertEqual(session.proxies, {})

    def test_ca_bundle_survives_trust_env_off(self):
        """trust_env=False 连带关掉 CA bundle；MITM CA 的机器会在两个 HTTPS 探测上炸。"""
        route = {"address": "http://127.0.0.1:59520", "source": "published", "reason": ""}
        with mock.patch.dict(os.environ, {"REQUESTS_CA_BUNDLE": "/etc/corp/ca.pem"}, clear=False):
            session = cli._egress_session(route)
        self.assertEqual(session.verify, "/etc/corp/ca.pem")


class OneRouteQerRoundTests(unittest.TestCase):
    """整轮只选一次路——记下的出口必须是请求真正用过的那个。"""

    def test_all_probes_share_one_route_and_snapshot_records_it(self):
        seen = []
        routes = iter([
            {"address": "http://127.0.0.1:59520", "source": "published", "reason": "", "path": "/p"},
            # 若代码在中途重新解析，第二次起就会拿到这条——用户此刻切了线路。
            {"address": "http://127.0.0.1:59625", "source": "published", "reason": "", "path": "/p"},
            {"address": "http://127.0.0.1:59625", "source": "published", "reason": "", "path": "/p"},
            {"address": "http://127.0.0.1:59625", "source": "published", "reason": "", "path": "/p"},
        ])

        def fake_resolve():
            return next(routes)

        def fake_session(route=None):
            # route 为 None 意味着调用方没把整轮的选路传进来，会各读各的。
            self.assertIsNotNone(route, "出站请求必须使用整轮共享的 route")
            seen.append(route["address"])
            return requests.Session()

        def fake_public(route=None):
            fake_session(route)
            return {"status": "success", "query": "203.0.113.9", "country": "SG",
                    "proxy": True, "hosting": False, "timezone": "Asia/Singapore"}

        def fake_risk(ip, route=None):
            fake_session(route)
            return "", None

        def fake_spam(ip, route=None):
            fake_session(route)
            return [""]

        with mock.patch.object(cli, "resolve_route", side_effect=fake_resolve), \
                mock.patch.object(cli, "_egress_session", side_effect=fake_session), \
                mock.patch.object(cli, "get_public_info", side_effect=fake_public), \
                mock.patch.object(cli, "get_ip_risk", side_effect=fake_risk), \
                mock.patch.object(cli, "get_stopforumspam", side_effect=fake_spam), \
                mock.patch.object(cli, "get_dns_servers", return_value=[]), \
                mock.patch.object(cli, "get_ipv6", return_value=None):
            out = cli.collect_all()

        self.assertEqual(
            set(seen), {"http://127.0.0.1:59520"},
            "本轮出现了不止一条线路：%r" % (seen,),
        )
        self.assertEqual(out["proxy_effective"]["address"], "http://127.0.0.1:59520")
        self.assertEqual(out["proxy_effective"]["source"], "published")

    def test_snapshot_carries_the_path_not_just_the_address(self):
        """报告靠 path 告诉读者去哪看。漏掉它时终端看着仍然正确——因为报告的兜底字符串
        恰好等于默认路径——所以只有断言快照本身才守得住：常量一改，capture 全对而报告
        指向错的文件。
        """
        route = {"address": "http://127.0.0.1:59520", "source": "published",
                 "reason": "", "path": "/somewhere/else/current-proxy"}
        with mock.patch.object(cli, "resolve_route", return_value=route), \
                mock.patch.object(cli, "get_public_info", return_value={"status": "fail", "message": "x"}), \
                mock.patch.object(cli, "get_dns_servers", return_value=[]), \
                mock.patch.object(cli, "get_ipv6", return_value=None):
            out = cli.collect_all()
        self.assertEqual(out["proxy_effective"]["path"], "/somewhere/else/current-proxy")

    def test_snapshot_carries_reason_when_route_unusable(self):
        bad = {"address": "", "source": "invalid", "reason": "内容不是可用的代理地址：'gcp'",
               "path": "/tmp/current-proxy"}
        with mock.patch.object(cli, "resolve_route", return_value=bad), \
                mock.patch.object(cli, "get_public_info", return_value={"status": "fail", "message": "boom"}), \
                mock.patch.object(cli, "get_dns_servers", return_value=[]), \
                mock.patch.object(cli, "get_ipv6", return_value=None):
            out = cli.collect_all()
        self.assertEqual(out["proxy_effective"], bad)


if __name__ == "__main__":
    unittest.main()
