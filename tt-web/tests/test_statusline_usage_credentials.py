"""`statusline-usage.py` must find the OAuth token on every supported platform.

Claude Code keeps the same credential blob in two different places: a file on
Linux, the login keychain on macOS. A reader that knows only one of them works
on one platform and silently shows nothing on the other — the failure is
invisible because every failure path in that script is deliberately silent.

These tests drive `read_tokens` against both stores. The keychain probe is
exercised through a stub standing in for `/usr/bin/security` rather than a
mocked `subprocess`, so the exit-status and missing-binary paths are the real
ones.
"""

import importlib.util
import json
import os
import stat
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
USAGE_SCRIPT = REPO_ROOT / "claude" / "statusline-usage.py"


def load_module():
    """A fresh instance of the hyphenated script as an importable module."""
    spec = importlib.util.spec_from_file_location("statusline_usage", USAGE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def blob(token="sk-ant-oat01-live", expires_in_s=3600):
    """A credentials payload shaped the way Claude Code writes it."""
    return json.dumps(
        {
            "claudeAiOauth": {
                "accessToken": token,
                "expiresAt": int((time.time() + expires_in_s) * 1000),
                "subscriptionType": "max",
            }
        }
    )


class ReadTokenTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        # Point both stores somewhere this test owns. Absent an override each
        # would reach the real host: the developer's own credentials file, and
        # a keychain read that can raise a GUI approval dialog mid-suite.
        self.module.CREDENTIALS = str(self.home / ".credentials.json")
        self.module.KEYCHAIN_TOOL = str(self.home / "absent-security")

    def write_file_store(self, contents):
        Path(self.module.CREDENTIALS).write_text(contents, encoding="utf-8")

    def install_keychain_stub(self, script):
        """Put a stub at KEYCHAIN_TOOL and return the path it logs argv to."""
        tool = self.home / "security"
        argv_log = self.home / "argv.log"
        tool.write_text(
            "#!/bin/sh\n"
            f'printf "%s\\n" "$@" >> "{argv_log}"\n' + script,
            encoding="utf-8",
        )
        tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
        self.module.KEYCHAIN_TOOL = str(tool)
        return argv_log

    def test_reads_live_token_from_credentials_file(self):
        """The Linux store still works — this is the path that shipped."""
        self.write_file_store(blob(token="sk-ant-oat01-from-file"))
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-from-file"])

    def test_reads_live_token_from_keychain_when_file_is_absent(self):
        """The macOS store: no credentials file exists there at all."""
        self.install_keychain_stub(
            f"printf '%s' '{blob(token='sk-ant-oat01-from-keychain')}'\n"
        )
        self.assertFalse(os.path.exists(self.module.CREDENTIALS))
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-from-keychain"])

    def test_offers_the_keychain_token_even_when_the_file_looks_fresh(self):
        """A file token can be unexpired and still be refused by the server.

        Revoked, superseded, or issued for another account all read as valid
        here, so stopping at the first unexpired token would let a leftover
        file permanently shadow the live keychain entry. Both must be offered,
        file first, and the caller decides by asking.
        """
        self.write_file_store(blob(token="sk-ant-oat01-looks-fine"))
        self.install_keychain_stub(f"printf '%s' '{blob(token='sk-ant-oat01-real')}'\n")
        self.assertEqual(
            list(self.module.read_tokens()),
            ["sk-ant-oat01-looks-fine", "sk-ant-oat01-real"],
        )

    def test_identical_blobs_in_both_stores_yield_one_token(self):
        """Nothing is gained by re-offering a credential already refused."""
        same = blob(token="sk-ant-oat01-same")
        self.write_file_store(same)
        self.install_keychain_stub(f"printf '%s' '{same}'\n")
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-same"])

    def test_skips_the_expired_file_token_and_keeps_the_keychain_one(self):
        """An unusable store is dropped, not treated as the answer."""
        self.write_file_store(blob(token="sk-ant-oat01-stale", expires_in_s=-60))
        self.install_keychain_stub(
            f"printf '%s' '{blob(token='sk-ant-oat01-fresh')}'\n"
        )
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-fresh"])

    def test_skips_a_malformed_file_and_keeps_the_keychain_one(self):
        self.write_file_store("{ not json")
        self.install_keychain_stub(f"printf '%s' '{blob(token='sk-ant-oat01-ok')}'\n")
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-ok"])

    def test_a_token_that_cannot_be_a_header_is_not_a_candidate(self):
        """Rejected here, or urllib raises `ValueError` before sending anything.

        The caller cannot tell that apart from the network being down, so it
        would stop rather than fall through — and the store that does hold a
        working credential would never be reached.
        """
        self.write_file_store(blob(token="sk-ant-oat01\nInjected: header"))
        self.install_keychain_stub(f"printf '%s' '{blob(token='sk-ant-oat01-ok')}'\n")
        self.assertEqual(list(self.module.read_tokens()), ["sk-ant-oat01-ok"])

    def test_a_non_ascii_token_is_not_a_candidate(self):
        self.write_file_store(blob(token="sk-ant-oat01-café"))
        self.assertEqual(list(self.module.read_tokens()), [])

    def test_the_deadline_outranks_the_modules_own_broad_handlers(self):
        """An alarm can land inside any `except Exception` in this file.

        Every store swallows exceptions by design, so if the deadline were an
        ordinary `Exception` the notice that the ceiling is spent would die in
        whichever handler was on the stack — and the run would go on to make a
        network request with no ceiling left and the flock still held.
        """
        self.assertTrue(issubclass(self.module._Deadline, BaseException))
        self.assertFalse(issubclass(self.module._Deadline, Exception))

        module = self.module

        class AlarmDuringParse:
            @staticmethod
            def loads(_):
                raise module._Deadline("alarm landed mid-parse")

        # `token_from_blob` wraps this call in `except Exception: return None`.
        self.module.json = AlarmDuringParse
        with self.assertRaises(self.module._Deadline):
            self.module.token_from_blob("{}")

    def test_expired_keychain_token_yields_nothing(self):
        self.install_keychain_stub(f"printf '%s' '{blob(expires_in_s=-1)}'\n")
        self.assertEqual(list(self.module.read_tokens()), [])

    def test_missing_keychain_binary_is_not_an_error(self):
        """The non-macOS case: nothing lives at KEYCHAIN_TOOL."""
        self.assertFalse(os.path.exists(self.module.KEYCHAIN_TOOL))
        self.assertEqual(list(self.module.read_tokens()), [])

    def test_failed_keychain_lookup_yields_nothing(self):
        """No such item in the keychain — `security` exits non-zero."""
        self.install_keychain_stub("echo 'not found' >&2\nexit 44\n")
        self.assertEqual(list(self.module.read_tokens()), [])

    def test_blocked_keychain_read_gives_up_instead_of_hanging(self):
        """A keychain that stops to ask a human must not wedge the refresher.

        The real stall is a GUI approval dialog. `sleep` stands in for it: what
        matters is that the call returns on its own within the timeout rather
        than holding the refresher — and its flock — until the outer deadline.
        """
        self.install_keychain_stub("sleep 30\n")
        self.module.KEYCHAIN_TIMEOUT_S = 1
        started = time.monotonic()
        self.assertEqual(list(self.module.read_tokens()), [])
        self.assertLess(time.monotonic() - started, 10)

    def test_token_never_appears_in_the_keychain_command_line(self):
        """argv is world-readable via `ps`; the secret may only ride stdout."""
        secret = "sk-ant-oat01-must-not-leak"
        argv_log = self.install_keychain_stub(f"printf '%s' '{blob(token=secret)}'\n")
        self.assertEqual(list(self.module.read_tokens()), [secret])
        self.assertNotIn(secret, argv_log.read_text(encoding="utf-8"))

    def test_no_store_yields_nothing(self):
        self.assertEqual(list(self.module.read_tokens()), [])

    def test_an_accepted_first_candidate_never_opens_the_keychain(self):
        """Laziness is the contract, not an optimisation.

        Probing the keychain is what can cost seconds or raise a dialog, so a
        host whose file credential works must never pay for it.
        """
        self.write_file_store(blob(token="sk-ant-oat01-from-file"))
        self.install_keychain_stub(f"printf '%s' '{blob(token='unused')}'\n")
        argv_log = self.home / "argv.log"
        candidates = self.module.read_tokens()
        self.assertEqual(next(candidates), "sk-ant-oat01-from-file")
        self.assertFalse(argv_log.exists(), "keychain was consulted anyway")


class FetchFallthroughTests(unittest.TestCase):
    """Only the server can rule a credential out, so a refusal is not the end.

    `read_tokens` offering both candidates is worth nothing if the refresh
    stops at the first one the server rejects — that is the shape of the bug
    this whole change exists to remove, one layer up.
    """

    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        home = Path(self.tmp.name)
        self.module.CACHE = str(home / "statusline-cache" / ".usage.json")
        # Candidates come from the stub below; keep the real stores unreachable
        # so a host that happens to have one cannot change the outcome.
        self.module.CREDENTIALS = str(home / "absent-credentials.json")
        self.module.KEYCHAIN_TOOL = str(home / "absent-security")

    def cached(self):
        return json.loads(Path(self.module.CACHE).read_text(encoding="utf-8"))

    def stub_fetch(self, rejected=(), raises=None):
        """Record every token tried; refuse the ones named as rejected.

        `rejected` produces a real 401 the way the server would; `raises` maps a
        token to any other exception, for the paths that must NOT be read as a
        credential problem.
        """
        tried = []
        raises = raises or {}

        def fetch(token):
            tried.append(token)
            if token in raises:
                raise raises[token]
            if token in rejected:
                raise urllib.error.HTTPError(
                    "https://api.anthropic.com/api/oauth/usage",
                    401,
                    "Unauthorized",
                    {},  # type: ignore[arg-type]
                    None,
                )
            return {
                "limits": [
                    {
                        "scope": {"model": {"display_name": "Fable"}},
                        "percent": 61,
                        "resets_at": "2026-08-03T08:59:59Z",
                    }
                ]
            }

        self.module.fetch = fetch
        return tried

    def test_rejected_credential_falls_through_to_the_next(self):
        self.module.read_tokens = lambda: ["stale-but-unexpired", "live"]
        tried = self.stub_fetch(rejected=("stale-but-unexpired",))
        self.module.main()
        self.assertEqual(tried, ["stale-but-unexpired", "live"])
        self.assertEqual([l["name"] for l in self.cached()["limits"]], ["Fable"])
        self.assertNotEqual(self.cached()["fetched_at"], 0)

    def test_accepted_credential_stops_the_loop(self):
        """The common case must not spend a second request."""
        self.module.read_tokens = lambda: ["live", "never-reached"]
        tried = self.stub_fetch()
        self.module.main()
        self.assertEqual(tried, ["live"])

    def test_all_credentials_rejected_leaves_the_previous_numbers(self):
        """A refresh that cannot authenticate must not blank the bars."""
        os.makedirs(os.path.dirname(self.module.CACHE), exist_ok=True)
        Path(self.module.CACHE).write_text(
            json.dumps(
                {
                    "attempted_at": 1,
                    "fetched_at": 2,
                    "limits": [{"name": "Fable", "percent": 39, "resets_at": 3}],
                }
            ),
            encoding="utf-8",
        )
        self.module.read_tokens = lambda: ["dead-a", "dead-b"]
        tried = self.stub_fetch(rejected=("dead-a", "dead-b"))
        self.module.main()
        self.assertEqual(tried, ["dead-a", "dead-b"])
        self.assertEqual(self.cached()["fetched_at"], 2)
        self.assertEqual(self.cached()["limits"][0]["percent"], 39)

    def test_the_expired_deadline_is_never_mistaken_for_a_refusal(self):
        """`signal.alarm` is one-shot, so the ceiling cannot be caught and shrugged off.

        Continuing past it would send the next request with no ceiling left and
        the flock still held — an unbounded body read then wedges the cache for
        every render that follows. The refresh must unwind instead.
        """
        self.module.read_tokens = lambda: ["first", "second"]
        tried = self.stub_fetch(
            raises={"first": self.module._Deadline("refresh exceeded DEADLINE_S")}
        )
        with self.assertRaises(self.module._Deadline):
            self.module.main()
        self.assertEqual(tried, ["first"], "kept going after the deadline expired")

    def test_a_failure_that_never_reached_the_server_stops_the_loop(self):
        """DNS/TLS/socket errors implicate no credential, so retrying spends the
        deadline for an answer the next one cannot give either."""
        self.module.read_tokens = lambda: ["first", "second"]
        tried = self.stub_fetch(raises={"first": OSError("no route to host")})
        self.module.main()
        self.assertEqual(tried, ["first"])
        self.assertEqual(self.cached()["fetched_at"], 0)

    def test_a_server_objection_other_than_refusal_stops_the_loop(self):
        """A 500 is the server's problem; another credential earns the same 500."""
        self.module.read_tokens = lambda: ["first", "second"]
        tried = self.stub_fetch(
            raises={
                "first": urllib.error.HTTPError(
                    "https://api.anthropic.com/api/oauth/usage",
                    500,
                    "Internal Server Error",
                    {},  # type: ignore[arg-type]
                    None,
                )
            }
        )
        self.module.main()
        self.assertEqual(tried, ["first"])


if __name__ == "__main__":
    unittest.main()
