import contextlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

import rollup


class WalFramePredicateTests(unittest.TestCase):
    """An immutable read must refuse only when the WAL holds frames the main
    file lacks. Refusing whenever the file exists refuses whenever anything has
    the database open, which on this machine means whenever the server runs."""

    def test_a_reader_held_wal_with_no_frames_does_not_block_an_immutable_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(Path(tmp) / "rollup.db")
            wal = Path(str(db_path) + "-wal")
            wal.write_bytes(b"")
            Path(str(db_path) + "-shm").write_bytes(b"")

            with rollup._read_connection(db_path, immutable=True) as conn:
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM daily_rollup").fetchone()[0], 1
                )

    def test_a_wal_with_frames_still_blocks_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_db(Path(tmp) / "rollup.db")
            Path(str(db_path) + "-wal").write_bytes(b"\x00" * 32)

            with self.assertRaises(sqlite3.OperationalError):
                with rollup._read_connection(db_path, immutable=True):
                    pass

    @staticmethod
    def make_db(db_path):
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            with conn:
                conn.executescript(rollup.SCHEMA)
                conn.execute(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model, input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens, cost_usd,
                      cost_known_count, entry_count, message_count
                    ) VALUES ('2026-08-04','codex','repo','gpt-5',1,0,0,0,0,1,1,1)
                    """
                )
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) "
                    "VALUES ('bucket_timezone', 'Asia/Shanghai')"
                )
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return db_path


if __name__ == "__main__":
    unittest.main()
