import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[1]


class SourceSignatureTests(unittest.TestCase):
    def test_signature_is_deterministic_and_matches_boot(self):
        import server

        self.assertTrue(server.BOOT_SIGNATURE)
        self.assertEqual(server._source_signature(), server._source_signature())
        self.assertEqual(server._source_signature(), server.BOOT_SIGNATURE)

    def test_source_files_are_python_modules_only(self):
        import server

        files = server._source_files()
        self.assertIn(ROOT / "server.py", files)
        self.assertTrue(files)
        self.assertTrue(all(path.suffix == ".py" for path in files))
        self.assertFalse(any("tests" in path.parts for path in files))

    def test_signature_changes_when_file_set_changes(self):
        import server

        full = server._source_signature()
        original = server._source_files
        try:
            server._source_files = lambda: original()[:-1]
            reduced = server._source_signature()
        finally:
            server._source_files = original
        self.assertNotEqual(full, reduced)


class HealthStaleTests(unittest.TestCase):
    def test_health_reports_signature_and_not_stale_at_boot(self):
        import server

        payload = server.health({"asset_watch": ["1"]})
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["signature"], server.BOOT_SIGNATURE)
        self.assertTrue(payload["web_signature"])
        self.assertFalse(payload["stale"])

    def test_health_marks_legacy_asset_watchers_stale(self):
        import server

        self.assertTrue(server.health({})["stale"])

    def test_health_reports_stale_when_boot_signature_diverges(self):
        import server

        original = server.BOOT_SIGNATURE
        try:
            server.BOOT_SIGNATURE = "deadbeefdeadbeef"
            self.assertTrue(server.health({})["stale"])
        finally:
            server.BOOT_SIGNATURE = original


class FreshnessWiringTests(unittest.TestCase):
    WARNING = "未能请求最新用量快照；将打开现有数据。请在页面中点 Refresh 重试。"

    def _run_launcher_open(self, overview_json, overview_exit=0, running=True):
        with tempfile.TemporaryDirectory() as tmp:
            sandbox = Path(tmp)
            launcher_root = sandbox / "tt-web"
            launcher_root.mkdir()
            launcher = launcher_root / "tt-web"
            shutil.copy2(ROOT / "tt-web", launcher)

            state = launcher_root / "state"
            state.mkdir()
            if running:
                (state / "pid").write_text(str(os.getpid()), encoding="utf-8")
                (state / "port").write_text("39123", encoding="utf-8")

            fake_bin = sandbox / "bin"
            fake_bin.mkdir()
            os.symlink(sys.executable, fake_bin / "python3")
            curl_log = sandbox / "curl.log"
            open_log = sandbox / "open.log"
            (fake_bin / "curl").write_text(
                """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TT_WEB_TEST_CURL_LOG"
url="${!#}"
case "$url" in
  */api/health*) printf '%s' '{"stale": false}' ;;
  */api/overview*)
    printf '%s' "$TT_WEB_TEST_OVERVIEW_JSON"
    exit "$TT_WEB_TEST_OVERVIEW_EXIT"
    ;;
  *) exit 64 ;;
esac
""",
                encoding="utf-8",
            )
            (fake_bin / "open").write_text(
                """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TT_WEB_TEST_OPEN_LOG"
""",
                encoding="utf-8",
            )
            (fake_bin / "nc").write_text(
                """#!/usr/bin/env bash
exit 1
""",
                encoding="utf-8",
            )
            (fake_bin / "curl").chmod(0o755)
            (fake_bin / "open").chmod(0o755)
            (fake_bin / "nc").chmod(0o755)

            env = os.environ.copy()
            env.update(
                {
                    "PATH": str(fake_bin) + os.pathsep + env["PATH"],
                    "TT_WEB_TEST_CURL_LOG": str(curl_log),
                    "TT_WEB_TEST_OPEN_LOG": str(open_log),
                    "TT_WEB_TEST_OVERVIEW_JSON": overview_json,
                    "TT_WEB_TEST_OVERVIEW_EXIT": str(overview_exit),
                    "TT_WEB_PORT": "39123",
                }
            )
            result = subprocess.run(
                [str(launcher), "open"],
                capture_output=True,
                text=True,
                env=env,
                timeout=10,
            )
            curl_calls = curl_log.read_text(encoding="utf-8").splitlines()
            open_calls = open_log.read_text(encoding="utf-8").splitlines()
            return result, curl_calls, open_calls

    def test_open_requests_fresh_generation_without_using_external_proxy(self):
        result, curl_calls, open_calls = self._run_launcher_open(
            '{"sync":{"refresh_pending":true,"syncing":false}}'
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        overview_calls = [call for call in curl_calls if "/api/overview" in call]
        self.assertEqual(len(overview_calls), 1, curl_calls)
        overview_call = overview_calls[0]
        self.assertIn("--noproxy *", overview_call)
        self.assertIn("force=1", overview_call)
        self.assertTrue(all("--noproxy *" in call for call in curl_calls), curl_calls)
        self.assertNotIn(self.WARNING, result.stderr)
        self.assertEqual(open_calls, ["http://127.0.0.1:39123"])

    def test_open_requests_fresh_generation_after_cold_start(self):
        result, curl_calls, open_calls = self._run_launcher_open(
            '{"sync":{"refresh_pending":true,"syncing":true}}',
            running=False,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("tt-web started: http://127.0.0.1:39123", result.stdout)
        self.assertEqual(
            len([call for call in curl_calls if "/api/overview" in call]),
            1,
            curl_calls,
        )
        self.assertEqual(open_calls, ["http://127.0.0.1:39123"])

    def test_open_reuses_an_already_running_sync(self):
        result, curl_calls, open_calls = self._run_launcher_open(
            '{"sync":{"refresh_pending":false,"syncing":true}}'
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            len([call for call in curl_calls if "/api/overview" in call]),
            1,
            curl_calls,
        )
        self.assertNotIn(self.WARNING, result.stderr)
        self.assertEqual(open_calls, ["http://127.0.0.1:39123"])

    def test_open_warns_but_still_opens_when_freshness_request_fails(self):
        cases = (
            ("transport failure", "", 22),
            ("invalid response", "not-json", 0),
            (
                "no refresh pending",
                '{"sync":{"refresh_pending":false,"syncing":false}}',
                0,
            ),
        )
        for name, response, exit_code in cases:
            with self.subTest(name=name):
                result, _curl_calls, open_calls = self._run_launcher_open(
                    response, overview_exit=exit_code
                )

                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(self.WARNING, result.stderr)
                self.assertEqual(open_calls, ["http://127.0.0.1:39123"])

    def test_app_js_polls_health_and_renders_stale_banner(self):
        js = (ROOT / "web" / "app.js").read_text()

        self.assertIn("/api/health", js)
        self.assertIn("stale-banner", js)
        self.assertIn("startFreshnessWatch", js)
        self.assertIn("/api/restart", js)
        self.assertIn("asset_watch", js)
        self.assertIn("web_signature", js)

    def test_static_responses_disable_browser_cache(self):
        import server

        headers = {}
        handler = SimpleNamespace(
            send_response=lambda _status: None,
            send_header=lambda name, value: headers.__setitem__(name, value),
            end_headers=lambda: None,
            send_error=lambda _status: self.fail("unexpected static response error"),
            wfile=BytesIO(),
        )

        server.Handler._serve_static(handler, "/", send_body=False)

        self.assertEqual(headers.get("Cache-Control"), "no-store")

    def test_styles_define_stale_banner(self):
        css = (ROOT / "web" / "styles.css").read_text()

        self.assertIn(".stale-banner", css)

    def test_dispatcher_refreshes_when_stale(self):
        script = (ROOT / "tt-web").read_text()

        self.assertIn("refresh_if_stale", script)
        self.assertIn("/api/health", script)
        self.assertIn("asset_watch=1", script)
        self.assertIn("compile_ok", script)

    def test_server_exposes_post_restart_endpoint(self):
        src = (ROOT / "server.py").read_text()

        self.assertIn("def do_POST", src)
        self.assertIn("/api/restart", src)
        self.assertIn("_compile_check", src)


if __name__ == "__main__":
    unittest.main()
