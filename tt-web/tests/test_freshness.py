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
