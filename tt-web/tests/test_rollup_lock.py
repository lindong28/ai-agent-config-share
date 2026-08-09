import fcntl
import multiprocessing
import os
import queue
import signal
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import aggregators
import rollup
from parsers import UsageEntry


def _entry(worker_id=0):
    timestamp = datetime(2026, 6, 12, 12, 0, tzinfo=timezone.utc)
    return UsageEntry(
        timestamp=timestamp,
        session_id=f"session-{worker_id}",
        message_id=f"message-{worker_id}",
        request_id=f"request-{worker_id}",
        model="gpt-5",
        input_tokens=10 + worker_id,
        output_tokens=2 + worker_id,
        cache_creation_tokens=1 + worker_id,
        cache_read_tokens=3 + worker_id,
        cost_usd=1.0 + worker_id,
        project=f"repo-{worker_id}",
        agent_id="codex",
        message_count=1 + worker_id,
    )


def _append_sentinel(sentinel_path, action):
    with open(sentinel_path, "a", encoding="utf-8") as sentinel:
        sentinel.write(f"{action} {os.getpid()} {time.monotonic_ns()}\n")
        sentinel.flush()


class _SentinelConnection:
    def __init__(self, connection, sentinel_path):
        self._connection = connection
        self._sentinel_path = sentinel_path
        self._context_depth = 0

    def __enter__(self):
        self._connection.__enter__()
        self._context_depth += 1
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        try:
            return self._connection.__exit__(exc_type, exc_value, traceback)
        finally:
            self._context_depth -= 1
            if self._context_depth == 0:
                _append_sentinel(self._sentinel_path, "leave")

    def __getattr__(self, name):
        return getattr(self._connection, name)


class _PauseBeforeOuterExitConnection:
    def __init__(self, connection, paused, release):
        self._connection = connection
        self._paused = paused
        self._release = release
        self._context_depth = 0

    def __enter__(self):
        self._connection.__enter__()
        self._context_depth += 1
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        if self._context_depth == 1:
            self._paused.set()
            if not self._release.wait(30):
                raise TimeoutError("parent did not release database-exit pause")
        try:
            return self._connection.__exit__(exc_type, exc_value, traceback)
        finally:
            self._context_depth -= 1

    def __getattr__(self, name):
        return getattr(self._connection, name)


class _SpoofingIdentityConnection:
    def __init__(self, connection, spoofed_main_path):
        self._connection = connection
        self._spoofed_main_path = str(spoofed_main_path)

    def execute(self, sql, parameters=()):
        if sql == "PRAGMA database_list":
            return [(0, "main", self._spoofed_main_path)]
        return self._connection.execute(sql, parameters)


def _concurrent_run_worker(
    worker_id,
    db_path,
    sentinel_path,
    ready,
    start,
    contention_barrier,
    results,
):
    ready.put(os.getpid())
    try:
        if not start.wait(10):
            raise TimeoutError("parent did not release ready barrier")

        # Instrument only the protected interval; this helper never acquires a lock.
        original_connect = rollup._connect

        def instrumented_connect(*args, **kwargs):
            return _SentinelConnection(
                original_connect(*args, **kwargs),
                sentinel_path,
            )

        def load_entries():
            _append_sentinel(sentinel_path, "enter")
            try:
                contention_barrier.wait(timeout=3)
            except threading.BrokenBarrierError:
                pass
            return [_entry(worker_id)]

        rollup._connect = instrumented_connect
        try:
            result = rollup.run(
                db_path=Path(db_path),
                entries_loader=load_entries,
                now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            )
        finally:
            rollup._connect = original_connect
        results.put({"status": "ok", "pid": os.getpid(), "result": result})
    except Exception as exc:
        results.put(
            {
                "status": "error",
                "pid": os.getpid(),
                "error": "%s: %s" % (type(exc).__name__, exc),
            }
        )


def _hold_file_lock(lock_path, ready, release):
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        ready.set()
        release.wait(30)
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _probe_file_lock(lock_path, result):
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    acquired = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            pass
        result.put(acquired)
    finally:
        if acquired:
            fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _run_nonblocking_worker(db_path, result):
    try:
        value = rollup.run(db_path=Path(db_path), entries_loader=list, blocking=False)
        result.put({"status": "ok", "value": value})
    except Exception as exc:
        result.put({"status": "error", "error": "%s: %s" % (type(exc).__name__, exc)})


def _run_default_worker(db_path, ready, result):
    try:
        ready.set()
        value = rollup.run(
            db_path=Path(db_path),
            entries_loader=lambda: [_entry()],
            now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
        )
        result.put({"status": "ok", "value": value})
    except Exception as exc:
        result.put({"status": "error", "error": "%s: %s" % (type(exc).__name__, exc)})


def _run_paused_before_database_exit(db_path, paused, release, result):
    original_connect = rollup._connect

    def instrumented_connect(*args, **kwargs):
        return _PauseBeforeOuterExitConnection(
            original_connect(*args, **kwargs),
            paused,
            release,
        )

    rollup._connect = instrumented_connect
    try:
        value = rollup.run(
            db_path=Path(db_path),
            entries_loader=lambda: [_entry()],
            now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
        )
        result.put({"status": "ok", "value": value})
    except Exception as exc:
        result.put({"status": "error", "error": "%s: %s" % (type(exc).__name__, exc)})
    finally:
        rollup._connect = original_connect


def _write_identity_state_worker(identity_db, ready, result):
    aggregators.PROJECT_IDENTITY_DB = Path(identity_db)
    original_resolve = aggregators._resolve_project
    aggregators._resolve_project = lambda path: (path, "no_remote")
    try:
        ready.set()
        value = aggregators.identify_project("/identity/repo", {})
        result.put({"status": "ok", "value": value})
    except Exception as exc:
        result.put({"status": "error", "error": "%s: %s" % (type(exc).__name__, exc)})
    finally:
        aggregators._resolve_project = original_resolve


class RollupLockTests(unittest.TestCase):
    # Falsification map for the production-lock boundary:
    # - token-only or no lock: default-run/external-holder and bare-concurrent tests fail;
    # - lock released before mutation completes: the database-exit lock probe succeeds;
    # - per-connection instead of per-db-path locking: the external-holder test fails, and the
    #   bare-concurrent loader-to-connection-exit intervals overlap.
    def test_concurrent_runs_serialize(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            sentinel_path = Path(tmp) / "rollup.sentinel"
            ctx = multiprocessing.get_context("spawn")
            ready = ctx.Queue()
            start = ctx.Event()
            contention_barrier = ctx.Barrier(4)
            results = ctx.Queue()
            processes = [
                ctx.Process(
                    target=_concurrent_run_worker,
                    args=(
                        worker_id,
                        str(db_path),
                        str(sentinel_path),
                        ready,
                        start,
                        contention_barrier,
                        results,
                    ),
                )
                for worker_id in range(4)
            ]
            try:
                for process in processes:
                    process.start()
                ready_pids = {ready.get(timeout=10) for _ in processes}
                self.assertEqual(len(ready_pids), len(processes))
                start.set()
                for process in processes:
                    process.join(15)
                self.assertFalse(
                    [process.pid for process in processes if process.is_alive()],
                    "concurrent rollup worker did not finish",
                )
                self.assertTrue(
                    all(process.exitcode == 0 for process in processes),
                    [(process.pid, process.exitcode) for process in processes],
                )
                observed = [results.get(timeout=5) for _ in processes]
            finally:
                start.set()
                for process in processes:
                    if process.is_alive():
                        process.terminate()
                for process in processes:
                    if process.pid is not None:
                        process.join(5)
                ready.close()
                ready.join_thread()
                results.close()
                results.join_thread()

            self.assertEqual(
                {item["pid"] for item in observed},
                ready_pids,
            )
            self._assert_serial_sentinel(sentinel_path, ready_pids)
            self.assertTrue(
                all(item["status"] == "ok" for item in observed),
                [item for item in observed if item["status"] != "ok"],
            )

            expected_db = Path(tmp) / "expected.db"
            rollup.run(
                db_path=expected_db,
                entries_loader=lambda: [_entry(worker_id) for worker_id in range(4)],
                now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
            )
            self.assertEqual(self._daily_rows(db_path), self._daily_rows(expected_db))

    def test_bypass_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            exception = self._require_lock_contract()
            with self.assertRaises(exception):
                conn = rollup._connect(db_path)
                conn.close()

    def test_cross_thread_bypass_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            exception = self._require_lock_contract()
            observed = []

            def bypass():
                try:
                    conn = rollup._connect(db_path)
                except exception:
                    observed.append("raised")
                else:
                    conn.close()
                    observed.append("allowed")

            with rollup.rollup_lock(db_path):
                thread = threading.Thread(target=bypass)
                thread.start()
                thread.join(2)

            self.assertFalse(thread.is_alive())
            self.assertEqual(observed, ["raised"])

    def test_wrong_db_bypass_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_a = Path(tmp) / "a.db"
            db_b = Path(tmp) / "b.db"
            exception = self._require_lock_contract()
            with rollup.rollup_lock(db_a):
                with self.assertRaises(exception):
                    conn = rollup._connect(db_b)
                    conn.close()

    def test_read_paths_do_not_create_or_mutate_db(self):
        readers = {
            "last_rollup_ts": lambda path: rollup.last_rollup_ts(db_path=path),
            "needs_run": lambda path: rollup.needs_run(db_path=path),
            "latest_rollup_date": lambda path: rollup.latest_rollup_date(db_path=path),
            "earliest_rollup_date": lambda path: rollup.earliest_rollup_date(db_path=path),
            "query_pivot": lambda path: rollup.query_pivot("day", "none", "input", db_path=path),
            "filter_options": lambda path: rollup.filter_options(db_path=path),
            "history_gap": lambda path: rollup.history_gap([], db_path=path),
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name, reader in readers.items():
                with self.subTest(reader=name):
                    missing = root / name / "rollup.db"
                    reader(missing)
                    self.assertFalse(missing.exists())
                    self.assertFalse(missing.parent.exists())

            source = root / "source.db"
            with sqlite3.connect(source) as conn:
                conn.execute("PRAGMA journal_mode=DELETE")
                conn.executescript(rollup.SCHEMA)
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) VALUES ('last_rollup_ts', ?)",
                    (datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc).isoformat(),),
                )
                conn.execute(
                    "INSERT INTO rollup_meta (key, value) VALUES ('bucket_timezone', ?)",
                    (rollup.BUCKET_TIMEZONE_NAME,),
                )
                conn.execute(
                    """
                    INSERT INTO daily_rollup (
                      date, agent_id, project, model,
                      input_tokens, output_tokens,
                      cache_creation_tokens, cache_read_tokens,
                      cost_usd, cost_known_count, entry_count, message_count
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    ("2026-06-12", "codex", "repo-a", "gpt-5", 11, 7, 5, 3, 2.5, 1, 2, 4),
                )

            for name, reader in readers.items():
                with self.subTest(existing_reader=name):
                    case_dir = root / f"existing-{name}"
                    case_dir.mkdir()
                    existing = case_dir / "rollup.db"
                    shutil.copy2(source, existing)
                    before = self._db_snapshot(existing)
                    reader(existing)
                    self._assert_db_snapshot_equal(
                        before,
                        self._db_snapshot(existing),
                        reader=name,
                    )

    def test_default_run_waits_for_external_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            ctx = multiprocessing.get_context("spawn")
            holder_ready = ctx.Event()
            release = ctx.Event()
            holder = ctx.Process(
                target=_hold_file_lock,
                args=(str(lock_path), holder_ready, release),
            )
            runner_ready = ctx.Event()
            result_queue = ctx.Queue()
            runner = ctx.Process(
                target=_run_default_worker,
                args=(str(db_path), runner_ready, result_queue),
            )
            observed = None
            try:
                holder.start()
                self.assertTrue(holder_ready.wait(10))
                runner.start()
                self.assertTrue(runner_ready.wait(10))
                try:
                    early_result = result_queue.get(timeout=5)
                except queue.Empty:
                    early_result = None
                self.assertIsNone(
                    early_result,
                    "bare run completed while an external process held <db_path>.lock: %r"
                    % (early_result,),
                )
                self.assertTrue(holder.is_alive(), "lock holder exited during observation window")
                self.assertFalse(release.is_set())
                self.assertFalse(db_path.exists())

                release.set()
                observed = result_queue.get(timeout=10)
            finally:
                release.set()
                for process in (runner, holder):
                    if process.pid is not None:
                        process.join(5)
                    if process.is_alive():
                        process.terminate()
                for process in (runner, holder):
                    if process.pid is not None:
                        process.join(5)
                result_queue.close()
                result_queue.join_thread()

            self.assertEqual(runner.exitcode, 0)
            self.assertEqual(holder.exitcode, 0)
            self.assertEqual(observed["status"], "ok", observed)
            self.assertEqual(self._daily_rows(db_path), [self._expected_row()])

    def test_non_blocking_skips_when_held(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            ctx = multiprocessing.get_context("spawn")
            ready = ctx.Event()
            release = ctx.Event()
            holder = ctx.Process(target=_hold_file_lock, args=(str(lock_path), ready, release))
            result_queue = ctx.Queue()
            runner = ctx.Process(target=_run_nonblocking_worker, args=(str(db_path), result_queue))
            try:
                holder.start()
                self.assertTrue(ready.wait(5))
                runner.start()
                observed = result_queue.get(timeout=10)
                self.assertTrue(holder.is_alive(), "lock holder exited before non-blocking run completed")
                self.assertFalse(release.is_set())
                self.assertEqual(observed["status"], "ok", observed)
                self.assertIsNone(observed["value"])
                self.assertFalse(db_path.exists())
            finally:
                release.set()
                for process in (runner, holder):
                    if process.pid is not None:
                        process.join(5)
                    if process.is_alive():
                        process.terminate()
                for process in (runner, holder):
                    if process.pid is not None:
                        process.join(5)
                result_queue.close()
                result_queue.join_thread()
            self.assertEqual(runner.exitcode, 0)
            self.assertEqual(holder.exitcode, 0)

    def test_non_blocking_run_does_not_swallow_body_blocking_io_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"

            def fail_after_lock_acquisition():
                raise BlockingIOError("loader failed")

            with self.assertRaisesRegex(BlockingIOError, "loader failed"):
                rollup.run(
                    db_path=db_path,
                    entries_loader=fail_after_lock_acquisition,
                    blocking=False,
                )
            self.assertFalse(db_path.exists())

    def test_non_blocking_run_does_not_swallow_body_lock_unavailable(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            body_error = rollup._RollupLockUnavailable(
                11,
                "nested loader lock is unavailable",
                str(Path(tmp) / "other.db"),
            )

            def fail_after_lock_acquisition():
                raise body_error

            with self.assertRaises(rollup._RollupLockUnavailable) as raised:
                rollup.run(
                    db_path=db_path,
                    entries_loader=fail_after_lock_acquisition,
                    blocking=False,
                )
            self.assertIs(raised.exception, body_error)
            self.assertFalse(db_path.exists())

    def test_run_holds_lock_through_database_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            ctx = multiprocessing.get_context("spawn")
            paused = ctx.Event()
            release = ctx.Event()
            result_queue = ctx.Queue()
            runner = ctx.Process(
                target=_run_paused_before_database_exit,
                args=(str(db_path), paused, release, result_queue),
            )
            observed = None
            try:
                runner.start()
                self.assertTrue(paused.wait(10), "run did not reach the database-exit boundary")
                self.assertFalse(
                    self._other_process_can_lock(lock_path),
                    "run released <db_path>.lock before the database context exited",
                )
                release.set()
                observed = result_queue.get(timeout=10)
            finally:
                release.set()
                if runner.pid is not None:
                    runner.join(5)
                if runner.is_alive():
                    runner.terminate()
                    runner.join(5)
                result_queue.close()
                result_queue.join_thread()

            self.assertEqual(runner.exitcode, 0)
            self.assertEqual(observed["status"], "ok", observed)
            self.assertEqual(self._daily_rows(db_path), [self._expected_row()])

    def test_identity_state_participates_in_rollup_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            state.mkdir()
            db_path = state / "rollup.db"
            identity_db = state / "project_identity.db"
            lock_path = Path(str(db_path) + ".lock")
            lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)

            ctx = multiprocessing.get_context("spawn")
            ready = ctx.Event()
            result = ctx.Queue()
            worker = ctx.Process(
                target=_write_identity_state_worker,
                args=(str(identity_db), ready, result),
            )
            early = None
            lock_held = True
            try:
                worker.start()
                self.assertTrue(ready.wait(5))
                try:
                    early = result.get(timeout=2)
                except queue.Empty:
                    pass
                self.assertIsNone(
                    early,
                    "project identity state changed while another process held rollup.db.lock: %r"
                    % (early,),
                )
                self.assertFalse(identity_db.exists())

                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                lock_held = False
                observed = result.get(timeout=10)
            finally:
                if lock_held:
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                os.close(lock_fd)
                if worker.pid is not None:
                    worker.join(5)
                if worker.is_alive():
                    worker.terminate()
                    worker.join(5)
                result.close()
                result.join_thread()

            self.assertEqual(worker.exitcode, 0)
            self.assertEqual(observed, {"status": "ok", "value": "/identity/repo"})
            with sqlite3.connect(identity_db) as conn:
                stored = conn.execute(
                    "SELECT project FROM project_identity WHERE source_path = '/identity/repo'"
                ).fetchone()
            self.assertEqual(stored, ("/identity/repo",))

    def test_same_process_threads_serialize(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self._require_lock_contract()
            barrier = threading.Barrier(3)
            intervals = []
            intervals_lock = threading.Lock()

            def enter_lock():
                barrier.wait()
                with rollup.rollup_lock(db_path):
                    entered = time.monotonic_ns()
                    time.sleep(0.1)
                    left = time.monotonic_ns()
                    with intervals_lock:
                        intervals.append((entered, left))

            threads = [threading.Thread(target=enter_lock) for _ in range(2)]
            for thread in threads:
                thread.start()
            barrier.wait()
            for thread in threads:
                thread.join(3)
                self.assertFalse(thread.is_alive())
            intervals.sort()
            self.assertEqual(len(intervals), 2)
            self.assertLessEqual(intervals[0][1], intervals[1][0])

            held = threading.Event()
            release = threading.Event()

            def hold_lock():
                with rollup.rollup_lock(db_path):
                    held.set()
                    release.wait(30)

            holder = threading.Thread(target=hold_lock)
            holder.start()
            self.assertTrue(held.wait(2))
            completed = threading.Event()
            observed = queue.Queue()

            def run_nonblocking():
                try:
                    observed.put(("ok", rollup.run(db_path=db_path, entries_loader=list, blocking=False)))
                except Exception as exc:
                    observed.put(("error", "%s: %s" % (type(exc).__name__, exc)))
                finally:
                    completed.set()

            runner = threading.Thread(target=run_nonblocking)
            try:
                runner.start()
                self.assertTrue(completed.wait(5), "non-blocking run waited for the held lock")
                self.assertTrue(holder.is_alive(), "lock holder exited before non-blocking run completed")
                status, value = observed.get_nowait()
                self.assertEqual(status, "ok", value)
                self.assertIsNone(value)
            finally:
                release.set()
                holder.join(3)
                runner.join(3)
            self.assertFalse(holder.is_alive())
            self.assertFalse(runner.is_alive())

    def test_run_is_reentrant_under_public_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            self._require_lock_contract()
            completed = threading.Event()
            observed = queue.Queue()

            def run_nested():
                try:
                    with rollup.rollup_lock(db_path):
                        value = rollup.run(
                            db_path=db_path,
                            entries_loader=lambda: [_entry()],
                            now=lambda: datetime(2026, 6, 13, 12, 0, tzinfo=timezone.utc),
                        )
                    observed.put(("ok", value))
                except Exception as exc:
                    observed.put(("error", "%s: %s" % (type(exc).__name__, exc)))
                finally:
                    completed.set()

            runner = threading.Thread(target=run_nested, daemon=True)
            runner.start()
            self.assertTrue(completed.wait(10), "nested run deadlocked under public rollup_lock")
            status, value = observed.get_nowait()
            self.assertEqual(status, "ok", value)
            runner.join(2)
            self.assertFalse(runner.is_alive())
            self.assertEqual(self._daily_rows(db_path), [self._expected_row()])

    def test_nested_lock_keeps_outer_flock(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            self._require_lock_contract()

            with rollup.rollup_lock(db_path):
                with rollup.rollup_lock(db_path):
                    pass
                self.assertFalse(self._other_process_can_lock(lock_path))
            self.assertTrue(self._other_process_can_lock(lock_path))

    @unittest.skipUnless(hasattr(os, "fork"), "requires os.fork")
    def test_fork_resets_ownership_and_child_exit_keeps_parent_flock(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            read_fd, write_fd = os.pipe()
            child_branch = False
            child_pid = None
            try:
                with rollup.rollup_lock(db_path):
                    child_pid = os.fork()
                    if child_pid == 0:
                        child_branch = True
                        os.close(read_fd)
                        original_flock = rollup.fcntl.flock
                        child_flock_calls = []

                        def tracked_flock(fd, operation):
                            child_flock_calls.append(operation)
                            return original_flock(fd, operation)

                        rollup.fcntl.flock = tracked_flock
                        try:
                            with rollup.rollup_lock(db_path, blocking=False):
                                outcome = "entered"
                        except rollup._RollupLockUnavailable:
                            outcome = "blocked"
                        except BaseException as exc:
                            outcome = "error:%s" % type(exc).__name__
                        flock_attempts = sum(
                            bool(operation & fcntl.LOCK_EX) for operation in child_flock_calls
                        )
                        observed = ("%s:%d" % (outcome, flock_attempts)).encode("ascii")
                        os.write(write_fd, observed)
                        os.close(write_fd)
                    else:
                        os.close(write_fd)
                        observed = os.read(read_fd, 128)
                        os.close(read_fd)
                        os.waitpid(child_pid, 0)
                        self.assertEqual(observed, b"blocked:1")
                        self.assertFalse(
                            self._other_process_can_lock(lock_path),
                            "child cleanup released the parent's flock",
                        )
                if child_branch:
                    os._exit(0)
            finally:
                if child_pid == 0:
                    os._exit(2)
                for fd in (read_fd, write_fd):
                    try:
                        os.close(fd)
                    except OSError:
                        pass

            self.assertTrue(self._other_process_can_lock(lock_path))

    @unittest.skipUnless(hasattr(os, "fork"), "requires os.fork")
    def test_parent_death_does_not_leave_lock_held_by_fork_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            lock_path = Path(str(db_path) + ".lock")
            ready_read, ready_write = os.pipe()
            release_read, release_write = os.pipe()
            holder_pid = os.fork()
            if holder_pid == 0:
                os.close(ready_read)
                os.close(release_write)
                try:
                    with rollup.rollup_lock(db_path):
                        survivor_pid = os.fork()
                        if survivor_pid == 0:
                            os.write(ready_write, str(os.getpid()).encode("ascii"))
                            os.close(ready_write)
                            os.read(release_read, 1)
                            os.close(release_read)
                            os._exit(0)
                        os._exit(0)
                except BaseException:
                    os._exit(2)

            os.close(ready_write)
            os.close(release_read)
            survivor_pid = None
            try:
                raw_survivor_pid = os.read(ready_read, 32)
                self.assertTrue(raw_survivor_pid, "fork survivor did not become ready")
                survivor_pid = int(raw_survivor_pid)
                waited_pid, status = os.waitpid(holder_pid, 0)
                self.assertEqual(waited_pid, holder_pid)
                self.assertTrue(os.WIFEXITED(status))
                self.assertEqual(os.WEXITSTATUS(status), 0)
                self.assertTrue(
                    self._other_process_can_lock(lock_path),
                    "fork child kept the parent's flock alive after parent death",
                )
            finally:
                os.close(ready_read)
                try:
                    os.write(release_write, b"x")
                except BrokenPipeError:
                    pass
                os.close(release_write)
                if survivor_pid is not None:
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        try:
                            os.kill(survivor_pid, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(0.01)
                    else:
                        os.kill(survivor_pid, signal.SIGTERM)

    @unittest.skipUnless(hasattr(os, "fork"), "requires os.fork")
    def test_fork_rebuilds_rlock_table_held_by_another_thread(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            held = threading.Event()
            release = threading.Event()

            def hold_lock():
                with rollup.rollup_lock(db_path):
                    held.set()
                    release.wait(10)

            holder = threading.Thread(target=hold_lock)
            holder.start()
            self.assertTrue(held.wait(2))
            read_fd, write_fd = os.pipe()
            child_pid = os.fork()
            if child_pid == 0:
                os.close(read_fd)
                original_flock = rollup.fcntl.flock
                child_flock_calls = []

                def tracked_flock(fd, operation):
                    child_flock_calls.append(operation)
                    return original_flock(fd, operation)

                rollup.fcntl.flock = tracked_flock
                try:
                    with rollup.rollup_lock(db_path, blocking=False):
                        outcome = "entered"
                except rollup._RollupLockUnavailable:
                    outcome = "blocked"
                except BaseException as exc:
                    outcome = "error:%s" % type(exc).__name__
                flock_attempts = sum(
                    bool(operation & fcntl.LOCK_EX) for operation in child_flock_calls
                )
                os.write(write_fd, ("%s:%d" % (outcome, flock_attempts)).encode("ascii"))
                os.close(write_fd)
                os._exit(0)

            os.close(write_fd)
            try:
                observed = os.read(read_fd, 128)
                os.waitpid(child_pid, 0)
                self.assertEqual(observed, b"blocked:1")
            finally:
                os.close(read_fd)
                release.set()
                holder.join(3)
            self.assertFalse(holder.is_alive())

    def test_identity_leaf_writer_requires_matching_rollup_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state"
            identity_db = state / "project_identity.db"
            expected_rollup_db = state / "rollup.db"
            wrong_rollup_db = Path(tmp) / "other" / "rollup.db"
            blocker = aggregators.ProjectIdentityUnavailable(
                "blocked",
                source_path="/identity/repo",
                reason="source_unavailable",
            )

            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_db):
                with self.assertRaises(rollup.RollupLockNotHeld):
                    aggregators._record_project_identity_blocker_locked(blocker)
                self.assertFalse(identity_db.exists())

                with self.assertRaises(rollup.RollupLockNotHeld):
                    aggregators._begin_identity_recovery()

                with rollup.rollup_lock(expected_rollup_db):
                    stale_token = aggregators._assert_identity_rollup_lock_held()
                with sqlite3.connect(":memory:") as conn:
                    conn.execute(aggregators.PROJECT_IDENTITY_SCHEMA)
                    conn.execute(aggregators.PROJECT_IDENTITY_BLOCKER_SCHEMA)
                    with self.assertRaises(rollup.RollupLockNotHeld):
                        aggregators._ensure_project_identity_blocker_schema(conn, stale_token)
                    with self.assertRaises(rollup.RollupLockNotHeld):
                        aggregators._upsert_project_identity(
                            conn,
                            "/identity/repo",
                            "github.com/example/repo",
                            "remote",
                            stale_token,
                        )
                    with self.assertRaises(rollup.RollupLockNotHeld):
                        aggregators._resolve_blocker(
                            conn,
                            "/identity/repo",
                            "resolved_pinned",
                            stale_token,
                        )

                with rollup.rollup_lock(wrong_rollup_db):
                    with self.assertRaises(rollup.RollupLockNotHeld):
                        aggregators._record_project_identity_blocker_locked(blocker)
                self.assertFalse(identity_db.exists())

                observed = queue.Queue()

                def cross_thread_write():
                    try:
                        aggregators._store_project_identity(
                            "/identity/repo",
                            "github.com/example/repo",
                            "remote",
                        )
                    except Exception as exc:
                        observed.put(exc)
                    else:
                        observed.put(None)

                with rollup.rollup_lock(expected_rollup_db):
                    writer = threading.Thread(target=cross_thread_write)
                    writer.start()
                    writer.join(2)
                self.assertFalse(writer.is_alive())
                self.assertIsInstance(observed.get_nowait(), rollup.RollupLockNotHeld)
                self.assertFalse(identity_db.exists())

    def test_identity_token_rejects_foreign_connection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            identity_a = root / "a" / "project_identity.db"
            rollup_a = identity_a.with_name("rollup.db")
            identity_b = root / "b" / "project_identity.db"
            identity_b.parent.mkdir(parents=True)
            with sqlite3.connect(identity_b) as conn:
                conn.execute(aggregators.PROJECT_IDENTITY_SCHEMA)
                conn.execute(aggregators.PROJECT_IDENTITY_BLOCKER_SCHEMA)
                conn.execute(
                    """
                    INSERT INTO project_identity_blocker (
                      source_path, reason, resolved_candidate, pin_candidate,
                      first_seen, last_seen, status
                    ) VALUES (?, ?, NULL, NULL, ?, ?, 'active')
                    """,
                    ("/identity/repo", "source_unavailable", "first", "last"),
                )
            self.assertFalse(Path(str(identity_b.with_name("rollup.db")) + ".lock").exists())

            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_a):
                with rollup.rollup_lock(rollup_a):
                    ownership_token = aggregators._assert_identity_rollup_lock_held()
                    with sqlite3.connect(identity_b) as foreign_conn:
                        foreign_writers = {
                            "ensure_schema": lambda: aggregators._ensure_project_identity_blocker_schema(
                                foreign_conn,
                                ownership_token,
                            ),
                            "upsert_identity": lambda: aggregators._upsert_project_identity(
                                foreign_conn,
                                "/identity/repo",
                                "github.com/example/repo",
                                "remote",
                                ownership_token,
                            ),
                            "resolve_blocker": lambda: aggregators._resolve_blocker(
                                foreign_conn,
                                "/identity/repo",
                                "resolved_pinned",
                                ownership_token,
                            ),
                        }
                        for writer_name, writer in foreign_writers.items():
                            with self.subTest(writer=writer_name):
                                with self.assertRaises(rollup.RollupLockNotHeld):
                                    writer()

            with sqlite3.connect(identity_b) as conn:
                stored = conn.execute(
                    "SELECT project FROM project_identity WHERE source_path = '/identity/repo'"
                ).fetchone()
                blocker_status = conn.execute(
                    "SELECT status FROM project_identity_blocker WHERE source_path = '/identity/repo'"
                ).fetchone()
            self.assertIsNone(stored)
            self.assertEqual(blocker_status, ("active",))

    def test_identity_token_rejects_spoofing_connection_wrapper(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            identity_a = root / "a" / "project_identity.db"
            rollup_a = identity_a.with_name("rollup.db")
            identity_b = root / "b" / "project_identity.db"
            identity_b.parent.mkdir(parents=True)
            with sqlite3.connect(identity_b) as conn:
                conn.execute(aggregators.PROJECT_IDENTITY_SCHEMA)
            self.assertFalse(Path(str(identity_b.with_name("rollup.db")) + ".lock").exists())

            with mock.patch.object(aggregators, "PROJECT_IDENTITY_DB", identity_a):
                with rollup.rollup_lock(rollup_a):
                    ownership_token = aggregators._assert_identity_rollup_lock_held()
                    with sqlite3.connect(identity_b) as foreign_conn:
                        spoofing_conn = _SpoofingIdentityConnection(
                            foreign_conn,
                            identity_a,
                        )
                        with self.assertRaises(rollup.RollupLockNotHeld):
                            aggregators._upsert_project_identity(
                                spoofing_conn,
                                "/identity/repo",
                                "github.com/example/repo",
                                "remote",
                                ownership_token,
                            )

            with sqlite3.connect(identity_b) as conn:
                stored = conn.execute(
                    "SELECT project FROM project_identity WHERE source_path = '/identity/repo'"
                ).fetchone()
            self.assertIsNone(stored)

    def test_reverse_double_lock_is_rejected_without_deadlock(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_a = Path(tmp) / "a.db"
            db_b = Path(tmp) / "b.db"
            barrier = threading.Barrier(2)
            observed = queue.Queue()

            def acquire_in_reverse(first, second):
                try:
                    with rollup.rollup_lock(first):
                        barrier.wait(timeout=2)
                        with rollup.rollup_lock(second):
                            observed.put("entered")
                except Exception as exc:
                    observed.put(exc)

            threads = [
                threading.Thread(target=acquire_in_reverse, args=(db_a, db_b), daemon=True),
                threading.Thread(target=acquire_in_reverse, args=(db_b, db_a), daemon=True),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(2)

            self.assertFalse([thread for thread in threads if thread.is_alive()], "double-lock deadlock")
            errors = [observed.get_nowait() for _ in threads]
            self.assertTrue(
                all(isinstance(error, rollup.RollupLockNestingError) for error in errors),
                errors,
            )

    def test_wait_forever_timeout_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "rollup.db"
            with self.assertRaisesRegex(ValueError, "timeout=None"):
                with rollup.rollup_lock(db_path, timeout=None):
                    pass

    @unittest.skipUnless(sys.platform == "darwin", "requires a case-insensitive macOS volume")
    def test_macos_case_alias_is_reentrant(self):
        with tempfile.TemporaryDirectory(dir="/Users/lindong") as tmp:
            canonical_root = Path(tmp)
            alias_root = Path("/Users/LINDONG") / canonical_root.relative_to("/Users/lindong")
            canonical_stat = canonical_root.stat()
            alias_stat = alias_root.stat()
            self.assertEqual(
                (canonical_stat.st_dev, canonical_stat.st_ino),
                (alias_stat.st_dev, alias_stat.st_ino),
                "test requires /Users/lindong and /Users/LINDONG to alias the same inode",
            )
            canonical_db = canonical_root / "rollup.db"
            alias_db = alias_root / "rollup.db"

            with rollup.rollup_lock(canonical_db):
                with rollup.rollup_lock(alias_db, timeout=0.25):
                    rollup._assert_lock_held(alias_db)

    def test_preexisting_lock_file_identity_is_reentrant(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_a = Path(tmp) / "a.db"
            db_b = Path(tmp) / "b.db"
            lock_a = Path(str(db_a) + ".lock")
            lock_b = Path(str(db_b) + ".lock")
            lock_a.touch(mode=0o600)
            os.link(lock_a, lock_b)

            with rollup.rollup_lock(db_a):
                with rollup.rollup_lock(db_b, timeout=0.25):
                    rollup._assert_lock_held(db_b)

    def _require_lock_contract(self):
        self.assertTrue(hasattr(rollup, "RollupLockNotHeld"), "rollup.RollupLockNotHeld is missing")
        self.assertTrue(hasattr(rollup, "rollup_lock"), "rollup.rollup_lock is missing")
        return rollup.RollupLockNotHeld

    @staticmethod
    def _daily_rows(db_path):
        with sqlite3.connect(db_path) as conn:
            return conn.execute(
                "SELECT * FROM daily_rollup ORDER BY date, agent_id, project, model"
            ).fetchall()

    @staticmethod
    def _expected_row():
        return (
            "2026-06-12",
            "codex",
            "repo-0",
            "gpt-5",
            10,
            2,
            1,
            3,
            1.0,
            1,
            1,
            1,
        )

    @staticmethod
    def _db_snapshot(db_path):
        uri = db_path.resolve().as_uri() + "?mode=ro"
        with sqlite3.connect(uri, uri=True) as conn:
            conn.execute("PRAGMA query_only=ON")
            journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
            schema = conn.execute(
                "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name"
            ).fetchall()
            table_names = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
                )
            ]
            tables = {
                name: conn.execute(
                    'SELECT * FROM "%s" ORDER BY rowid' % name.replace('"', '""')
                ).fetchall()
                for name in table_names
            }
        sidecars = {
            path.name: path.read_bytes()
            for path in db_path.parent.iterdir()
            if path.name.startswith(db_path.name + "-")
        }
        return {
            "journal_mode": journal_mode,
            "schema": schema,
            "tables": tables,
            "db_bytes": db_path.read_bytes(),
            "sidecars": sidecars,
        }

    def _assert_serial_sentinel(self, sentinel_path, expected_pids):
        lines = sentinel_path.read_text(encoding="utf-8").splitlines()
        active_pid = None
        completed_pids = set()
        for line in lines:
            action, raw_pid, raw_timestamp = line.split()
            pid = int(raw_pid)
            timestamp = int(raw_timestamp)
            self.assertIn(pid, expected_pids)
            self.assertGreater(timestamp, 0)
            if action == "enter":
                self.assertIsNone(active_pid, lines)
                active_pid = pid
            else:
                self.assertEqual(action, "leave")
                self.assertEqual(active_pid, pid, lines)
                active_pid = None
                completed_pids.add(pid)
        self.assertEqual(len(lines), 2 * len(expected_pids), lines)
        self.assertIsNone(active_pid, lines)
        self.assertEqual(completed_pids, expected_pids)

    def _assert_db_snapshot_equal(self, before, after, reader):
        for component in ("journal_mode", "schema", "tables"):
            with self.subTest(existing_reader=reader, component=component):
                self.assertEqual(after[component], before[component])
        with self.subTest(existing_reader=reader, component="db_bytes"):
            self.assertTrue(after["db_bytes"] == before["db_bytes"])
        with self.subTest(existing_reader=reader, component="sidecar_set"):
            self.assertEqual(set(after["sidecars"]), set(before["sidecars"]))
        for name in set(after["sidecars"]) & set(before["sidecars"]):
            with self.subTest(existing_reader=reader, component=f"sidecar_bytes:{name}"):
                self.assertTrue(after["sidecars"][name] == before["sidecars"][name])

    def _other_process_can_lock(self, lock_path):
        ctx = multiprocessing.get_context("spawn")
        result = ctx.Queue()
        process = ctx.Process(target=_probe_file_lock, args=(str(lock_path), result))
        try:
            process.start()
            process.join(5)
            self.assertFalse(process.is_alive(), "file-lock probe did not finish")
            self.assertEqual(process.exitcode, 0)
            observed = result.get(timeout=2)
        finally:
            if process.is_alive():
                process.terminate()
            if process.pid is not None:
                process.join(5)
            result.close()
            result.join_thread()
        return observed


if __name__ == "__main__":
    unittest.main()
