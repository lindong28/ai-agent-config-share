import contextlib
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import rollup


class _UnopenableConnection:
    """A connection that opened but cannot read, as SQLite 3.51 returns for a
    mode=ro open of a WAL database with no -shm. Statements that do not touch
    the file (PRAGMA query_only) still succeed, which is what makes the real
    failure surface late."""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, *args):
        if sql.lstrip().upper().startswith("PRAGMA"):
            return self._conn.execute(sql, *args)
        raise sqlite3.OperationalError("unable to open database file")

    def close(self):
        self._conn.close()

    def __getattr__(self, name):
        return getattr(self._conn, name)


class ReadConnectionWalTests(unittest.TestCase):
    """A machine that is exported from rather than browsed on has no tt-web
    process holding its rollup open, so SQLite has deleted the -shm that a WAL
    database needs in order to be read. SQLite 3.51 stopped letting a mode=ro
    connection recreate it; older builds still do, which is why every test and
    every developer machine here missed this until a real export ran."""

    def test_read_falls_back_when_mode_ro_cannot_open_a_quiet_wal_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_quiet_wal_db(Path(tmp) / "rollup.db")

            with self.mode_ro_refused() as refusals:
                with rollup._read_connection(db_path) as conn:
                    rows = conn.execute("SELECT COUNT(*) FROM daily_rollup").fetchone()[0]

            self.assertEqual(refusals, ["?mode=ro"])
            self.assertEqual(rows, 2)
            self.assertEqual(self.siblings(db_path), [])

    def test_read_does_not_fall_back_while_a_wal_sits_beside_the_database(self):
        """immutable=1 reads the main file and ignores WAL frames. With a -wal
        present those frames are real committed data, so silently substituting
        the snapshot would answer from a database that is missing writes."""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_quiet_wal_db(Path(tmp) / "rollup.db")
            Path(str(db_path) + "-wal").write_bytes(b"")

            with self.mode_ro_refused():
                with self.assertRaises(sqlite3.OperationalError):
                    with rollup._read_connection(db_path):
                        pass

    def test_immutable_read_still_refuses_rather_than_falling_back(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_quiet_wal_db(Path(tmp) / "rollup.db")

            with self.mode_ro_refused(pattern="immutable=1"):
                with self.assertRaises(sqlite3.OperationalError):
                    with rollup._read_connection(db_path, immutable=True):
                        pass

    def test_quiet_wal_database_reads_on_this_sqlite_build(self):
        """No simulation: the real path on a real quiet WAL database. It passes
        on builds before 3.51 whether or not the fallback exists, so it is a
        regression guard for the machines that upgrade, not failure evidence."""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = self.make_quiet_wal_db(Path(tmp) / "rollup.db")
            self.assertEqual(self.siblings(db_path), [])

            with rollup._read_connection(db_path) as conn:
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM daily_rollup").fetchone()[0], 2
                )

    @contextlib.contextmanager
    def mode_ro_refused(self, pattern="?mode=ro"):
        """Stand in for SQLite 3.51 refusing one flavour of read-only open.

        The refusal lands on the first statement that reads the file, not on
        connect: sqlite3.connect is lazy, so the real build hands back a
        connection and fails later. A stand-in that raised from connect would
        pass against code that never reads early enough to fall back -- which
        is how this bug survived its first fix.

        Matching on the URI keeps the substitution narrow: only the open the
        real build rejects is rejected here, and the fallback open runs for
        real against the real file."""
        seen = []
        real_connect = sqlite3.connect

        def connect(target, *args, **kwargs):
            conn = real_connect(target, *args, **kwargs)
            if isinstance(target, str) and target.endswith(pattern):
                seen.append(pattern)
                return _UnopenableConnection(conn)
            return conn

        with mock.patch.object(sqlite3, "connect", connect):
            yield seen

    @staticmethod
    def siblings(db_path):
        return sorted(
            name
            for name in os.listdir(db_path.parent)
            if name.startswith(db_path.name) and name != db_path.name
        )

    @staticmethod
    def make_quiet_wal_db(db_path):
        """A WAL database with every connection closed, as an idle machine has."""
        with contextlib.closing(sqlite3.connect(db_path)) as conn:
            conn.execute("PRAGMA journal_mode=wal")
            with conn:
                conn.executescript(rollup.SCHEMA)
                conn.executemany(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model,
                      input_tokens, output_tokens, cache_creation_tokens,
                      cache_read_tokens, cost_usd, cost_known_count,
                      entry_count, message_count
                    ) VALUES (?, 'codex', 'repo', 'gpt-5', ?, 0, 0, 0, 0, 1, 1, 1)
                    """,
                    [("2026-08-03", 10), ("2026-08-04", 20)],
                )
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) "
                    "VALUES ('bucket_timezone', 'Asia/Shanghai')"
                )
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        return db_path


if __name__ == "__main__":
    unittest.main()
