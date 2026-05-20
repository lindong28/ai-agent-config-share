import shutil
import sqlite3
import tempfile
import unittest
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
        self.assertEqual(entry.message_id, "codex-session-1")
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
