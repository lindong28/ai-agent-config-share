import shutil
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from parsers import UsageEntry
from parsers import claude, codex


FIXTURES = Path(__file__).parent / "fixtures"


class ParserTests(unittest.TestCase):
    def test_usage_entry_is_frozen_dataclass(self):
        entry = claude.parse_file(FIXTURES / "claude_single.jsonl", fallback_project="fallback")[0]
        self.assertIsInstance(entry, UsageEntry)
        with self.assertRaises(Exception):
            entry.model = "changed"

    def test_claude_single_turn(self):
        entries = claude.parse_file(FIXTURES / "claude_single.jsonl", fallback_project="fallback")
        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.agent_id, "claude-code")
        self.assertEqual(entry.session_id, "claude-session-1")
        self.assertEqual(entry.message_id, "msg-1")
        self.assertEqual(entry.model, "claude-opus-4-7")
        self.assertEqual(entry.input_tokens, 100)
        self.assertEqual(entry.output_tokens, 25)
        self.assertEqual(entry.cache_creation_tokens, 10)
        self.assertEqual(entry.cache_read_tokens, 5)
        self.assertEqual(entry.cost_usd, 0.0123)
        self.assertEqual(entry.project, "/tmp/project-alpha")

    def test_claude_multi_turn_and_unknown_message_tolerant(self):
        entries = claude.parse_file(FIXTURES / "claude_multi.jsonl", fallback_project="fallback")
        self.assertEqual(len(entries), 2)
        self.assertEqual([e.message_id for e in entries], ["msg-2a", "msg-2b"])
        self.assertEqual([e.output_tokens for e in entries], [5, 7])

    def test_claude_missing_cache_fields_default_to_zero(self):
        entry = claude.parse_file(FIXTURES / "claude_multi.jsonl", fallback_project="fallback")[0]
        self.assertEqual(entry.cache_creation_tokens, 0)
        self.assertEqual(entry.cache_read_tokens, 0)
        self.assertEqual(entry.cache_creation_1h_tokens, 0)

    def test_claude_reads_one_hour_cache_creation_split(self):
        entries = claude.parse_file(
            FIXTURES / "claude_cache_ttl.jsonl", fallback_project="fallback"
        )
        self.assertEqual([e.cache_creation_tokens for e in entries], [1000, 400, 700])
        # Split present, split absent, and a breakdown that overstates the total.
        self.assertEqual([e.cache_creation_1h_tokens for e in entries], [900, 0, 700])

    def test_resumed_transcript_copy_dedupes_across_sessions(self):
        entries = claude.load_entries(base_dirs=[FIXTURES / "claude_resumed"])
        # Claude Code copies the whole transcript into the resumed session's
        # file, so the same API call appears under two sessionIds.
        self.assertEqual([e.message_id for e in entries], ["msg-r1", "msg-r2"])
        self.assertEqual(sum(e.input_tokens for e in entries), 300)

    def test_per_file_parsing_then_dedupe_matches_load_entries(self):
        # The dashboard parses each file on its own and merges, so the dedupe
        # that load_entries does internally has to be reapplied after the merge.
        from aggregators import _deduped

        merged = []
        for path in sorted((FIXTURES / "claude_resumed").rglob("*.jsonl")):
            merged.extend(claude.parse_file(path, fallback_project="fallback"))
        self.assertEqual(len(merged), 4)
        self.assertEqual(sum(e.input_tokens for e in _deduped(merged)), 300)

    def test_dedupe_keeps_codex_rollouts_that_resume_one_thread(self):
        from aggregators import _deduped

        def rollout(rollout_id):
            return UsageEntry(
                timestamp=datetime(2026, 5, 19, tzinfo=timezone.utc),
                session_id="shared-thread",
                message_id=rollout_id,
                request_id="",
                model="gpt-5",
                input_tokens=100,
                output_tokens=10,
                cache_creation_tokens=0,
                cache_read_tokens=0,
                cost_usd=None,
                project="repo",
                agent_id="codex",
            )

        entries = [rollout("rollout-a"), rollout("rollout-b")]
        self.assertEqual(len(_deduped(entries)), 2)
        self.assertEqual(len(_deduped(entries + [rollout("rollout-a")])), 2)

    def test_dedup_key_ignores_session_but_separates_requests(self):
        def entry(session_id, message_id, request_id):
            return UsageEntry(
                timestamp=datetime(2026, 5, 19, tzinfo=timezone.utc),
                session_id=session_id,
                message_id=message_id,
                request_id=request_id,
                model="claude-opus-5",
                input_tokens=1,
                output_tokens=1,
                cache_creation_tokens=0,
                cache_read_tokens=0,
                cost_usd=None,
                project="repo",
                agent_id="claude-code",
            )

        self.assertEqual(
            entry("session-a", "msg-1", "req-1").dedup_key,
            entry("session-b", "msg-1", "req-1").dedup_key,
        )
        self.assertNotEqual(
            entry("session-a", "msg-1", "req-1").dedup_key,
            entry("session-a", "msg-2", "req-2").dedup_key,
        )

    def test_codex_single_session_from_jsonl_and_state_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / "sessions"
            sessions.mkdir()
            shutil.copy(FIXTURES / "codex_session.jsonl", sessions / "session.jsonl")
            db = root / "state_5.sqlite"
            self._write_codex_state(db, "codex-session-1", "gpt-5")

            entries = codex.load_entries(sessions_dir=sessions, state_db=db)

        self.assertEqual(len(entries), 1)
        entry = entries[0]
        self.assertEqual(entry.agent_id, "codex")
        self.assertEqual(entry.session_id, "codex-session-1")
        # The rollout file, not the thread — resumed rollouts share a thread id.
        self.assertEqual(entry.message_id, "session")
        self.assertEqual(entry.model, "gpt-5")
        self.assertEqual(entry.input_tokens, 100)
        self.assertEqual(entry.output_tokens, 27)
        self.assertEqual(entry.cache_read_tokens, 30)
        self.assertEqual(entry.cache_creation_tokens, 0)
        self.assertIsNone(entry.cost_usd)
        self.assertEqual(entry.project, "/tmp/project-beta")
        self.assertEqual(entry.message_count, 1)

    def test_codex_missing_cost_and_bad_rows_are_skipped_without_crash(self):
        with tempfile.TemporaryDirectory() as tmp:
            sessions = Path(tmp) / "sessions"
            sessions.mkdir()
            path = sessions / "bad.jsonl"
            path.write_text(
                "\n".join(
                    [
                        "{not json",
                        '{"type":"session_meta","payload":{"id":"codex-session-2","timestamp":"2026-05-19T02:00:00Z","cwd":"/tmp/project-gamma"}}',
                        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5,"output_tokens":0}}}}',
                    ]
                ),
                encoding="utf-8",
            )

            entries = codex.load_entries(sessions_dir=sessions, state_db=Path(tmp) / "missing.sqlite")

        self.assertEqual(len(entries), 1)
        self.assertIsNone(entries[0].cost_usd)
        self.assertEqual(entries[0].model, "gpt-5")

    @staticmethod
    def _write_codex_state(path: Path, session_id: str, model: str) -> None:
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, model TEXT)")
        conn.execute("INSERT INTO threads (id, model) VALUES (?, ?)", (session_id, model))
        conn.commit()
        conn.close()


if __name__ == "__main__":
    unittest.main()
