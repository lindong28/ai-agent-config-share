import fcntl
import hashlib
import json
import math
import os
import platform
import re
import shutil
import sqlite3
import stat
import subprocess
import threading
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path

from machine_config import (
    DEFAULT_CONFIG_PATH,
    load_machine_config,
    machine_config_fingerprint,
    persisted_retired_names,
)
from project_alias import validate_alias_proofs


ROOT = Path(__file__).resolve().parent
DEFAULT_GENERATIONS_ROOT = ROOT / "state" / "generations"
GENERATION_SCHEMA_VERSION = 1
_GENERATION_ID = re.compile(r"^[0-9a-f]{64}$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_MACHINE_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$")
_META_FIELDS = {
    "schema_version",
    "generation_id",
    "machine_config_fingerprint",
    "source_host_identity",
    "aliases",
    "rate_limits",
    "data_start_date",
    "exporter_commit",
    "transfer_digest",
    "bucket_timezone",
    "row_count",
    "metric_totals",
    "logical_digest",
    "generated_at",
    "published_at",
}
_ROW_FIELDS = (
    "date",
    "agent_id",
    "project",
    "model",
    "input_tokens",
    "output_tokens",
    "cache_creation_tokens",
    "cache_read_tokens",
    "cost_usd",
    "cost_known_count",
    "entry_count",
    "message_count",
)
_METRIC_TOTAL_KEYS = {
    "cost",
    "input",
    "output",
    "cache_read",
    "cache_creation",
    "total",
    "messages",
}
_ACTIVE_LEASES = {}
_ACTIVE_LEASES_LOCK = threading.Lock()
_MACHINE_THREAD_LOCKS = {}
_MACHINE_THREAD_LOCKS_GUARD = threading.Lock()


class GenerationError(RuntimeError):
    pass


class GenerationValidationError(GenerationError):
    pass


class GenerationBucketTimezoneError(GenerationValidationError):
    pass


class GenerationIdMismatchError(GenerationValidationError):
    pass


class GenerationDigestMismatchError(GenerationValidationError):
    pass


class GenerationRetiredError(GenerationError):
    pass


class InjectedGenerationFailure(GenerationError):
    pass


class _GenerationLease:
    def __init__(self, path, fd):
        self.path = Path(path).resolve()
        self.fd = fd
        self.closed = False
        with _ACTIVE_LEASES_LOCK:
            _ACTIVE_LEASES[self.path] = _ACTIVE_LEASES.get(self.path, 0) + 1

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
        finally:
            os.close(self.fd)
            with _ACTIVE_LEASES_LOCK:
                remaining = _ACTIVE_LEASES[self.path] - 1
                if remaining:
                    _ACTIVE_LEASES[self.path] = remaining
                else:
                    del _ACTIVE_LEASES[self.path]

    def __del__(self):
        self.close()


@dataclass(frozen=True)
class CurrentGeneration:
    host: str
    db_path: Path
    generation_dir: Path
    meta: dict
    _lease: object = field(default=None, repr=False, compare=False)

    def close(self):
        if self._lease is not None:
            self._lease.close()

    def __del__(self):
        self.close()


@dataclass(frozen=True)
class AdmissionRecord:
    machine: object
    admitted: bool
    never: bool
    exclusion_reason: str = None
    current: object = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class GenerationAdmission:
    config: object
    admitted: tuple
    records: tuple


def build_generation_meta(
    snapshot_path,
    *,
    machine_config_fingerprint,
    source_host_identity,
    aliases,
    rate_limits,
    exporter_commit,
    generated_at,
):
    snapshot_path = Path(snapshot_path)
    stats = snapshot_stats(snapshot_path)
    validated_aliases = validate_alias_proofs(aliases)
    meta = {
        "schema_version": GENERATION_SCHEMA_VERSION,
        "generation_id": None,
        "machine_config_fingerprint": machine_config_fingerprint,
        "source_host_identity": source_host_identity,
        "aliases": validated_aliases,
        "rate_limits": rate_limits,
        "data_start_date": stats["data_start_date"],
        "exporter_commit": exporter_commit,
        "transfer_digest": _file_digest(snapshot_path),
        "bucket_timezone": stats["bucket_timezone"],
        "row_count": stats["row_count"],
        "metric_totals": stats["metric_totals"],
        "logical_digest": stats["logical_digest"],
        "generated_at": generated_at,
        "published_at": None,
    }
    meta["generation_id"] = _generation_id(meta)
    _validate_meta_shape(meta)
    return meta


def publish_generation(
    name,
    snapshot_path,
    meta,
    *,
    root=DEFAULT_GENERATIONS_ROOT,
    now=None,
    phase_hook=None,
):
    root = Path(root)
    snapshot_path = Path(snapshot_path)
    if not snapshot_path.is_file():
        raise FileNotFoundError(snapshot_path)
    _validate_generation(snapshot_path, meta, allow_unpublished=True)

    root_created = not root.exists()
    root.mkdir(parents=True, exist_ok=True)
    if root_created:
        _fsync_directory(root.parent)
    machine_dir = _machine_directory(root, name)
    if name in persisted_retired_names(root):
        raise GenerationRetiredError("machine %s is persistently retired" % name)
    machine_created = not machine_dir.exists()
    machine_dir.mkdir(exist_ok=True)
    if machine_created:
        _fsync_directory(root)
    with _machine_gc_lock(machine_dir, exclusive=True):
        return _publish_generation_locked(
            name,
            snapshot_path,
            meta,
            machine_dir=machine_dir,
            now=now,
            phase_hook=phase_hook,
        )


def bind_source_identity(
    name,
    observed_identity,
    *,
    accept_first_use=False,
    root=DEFAULT_GENERATIONS_ROOT,
):
    _validate_source_host_identity(observed_identity)

    root = Path(root)
    root_created = not root.exists()
    root.mkdir(parents=True, exist_ok=True)
    if root_created:
        _fsync_directory(root.parent)
    machine_dir = _machine_directory(root, name)
    if name in persisted_retired_names(root):
        raise GenerationRetiredError("machine %s is persistently retired" % name)
    machine_created = not machine_dir.exists()
    machine_dir.mkdir(exist_ok=True)
    if machine_created:
        _fsync_directory(root)

    with _machine_gc_lock(machine_dir, exclusive=True):
        pin_path = machine_dir / ".source-identity"
        try:
            pinned_identity = pin_path.read_text(encoding="utf-8").strip()
        except FileNotFoundError:
            pinned_identity = None
        if pinned_identity is not None:
            _validate_source_host_identity(pinned_identity)
            if pinned_identity != observed_identity:
                raise GenerationValidationError(
                    "sending source identity does not match the machine slot's pinned identity"
                )
            return pinned_identity
        if not accept_first_use:
            raise GenerationValidationError(
                "machine slot first-use requires explicit trust on first use (TOFU): "
                "accepting pins whatever machine currently reports this identity; "
                "it guarantees the same machine on later syncs, not that the SSH alias "
                "points to the intended machine"
            )
        _atomic_write_text(pin_path, observed_identity + "\n")
        return observed_identity


def _publish_generation_locked(
    name,
    snapshot_path,
    meta,
    *,
    machine_dir,
    now,
    phase_hook,
):
    _recover_pending_locked(machine_dir)
    _cleanup_machine_temps_locked(machine_dir)
    staging_dir = machine_dir / (".staging-" + uuid.uuid4().hex)
    final_dir = machine_dir / meta["generation_id"]
    _gc_generations_locked(machine_dir, extra_retained={meta["generation_id"]})
    old_current = _read_pointer(machine_dir / "current")
    old_previous = _read_pointer(machine_dir / "previous")
    published_meta = dict(meta)
    published_meta["published_at"] = _timestamp(now)
    _validate_meta_shape(published_meta)

    final_created = False
    try:
        _preflight_copy_space(snapshot_path, machine_dir)
        staging_dir.mkdir(mode=0o700)
        shutil.copyfile(snapshot_path, staging_dir / "snapshot.db")
        _fsync_file(staging_dir / "snapshot.db")
        _write_json(staging_dir / "meta.json", published_meta)
        _validate_generation(
            staging_dir / "snapshot.db", published_meta, allow_unpublished=False
        )
        _fsync_directory(staging_dir)
        if final_dir.exists():
            existing = _load_generation(name, final_dir)
            if old_current == meta["generation_id"]:
                shutil.rmtree(staging_dir)
                _gc_generations_locked(machine_dir)
                return existing
            if old_previous == meta["generation_id"]:
                shutil.rmtree(staging_dir)
                raise GenerationError(
                    "cannot republish the previous generation with a new pointer-switch time"
                )
            with _generation_removal_guard(
                machine_dir, meta["generation_id"]
            ) as removal_allowed:
                if not removal_allowed:
                    raise GenerationError(
                        "cannot republish a generation held by an active reader lease"
                    )
                _remove_generation_directory(final_dir)
                os.replace(staging_dir, final_dir)
                _fsync_directory(machine_dir)
                final_created = True
                existing = None
        else:
            os.replace(staging_dir, final_dir)
            _fsync_directory(machine_dir)
            final_created = True
            existing = None

        pending = {
            "schema_version": 1,
            "old_generation_id": old_current,
            "new_generation_id": meta["generation_id"],
        }
        _atomic_write_json(machine_dir / ".publication-pending.json", pending)
        _call_phase_hook(phase_hook, "before_current_switch")
        _atomic_write_text(machine_dir / "current", meta["generation_id"] + "\n")
        _call_phase_hook(phase_hook, "after_current_switch")
        _finalize_publication_locked(machine_dir, old_current, meta["generation_id"])
        _gc_generations_locked(machine_dir)
        return existing or _load_generation(name, final_dir)
    except BaseException:
        if staging_dir.exists():
            shutil.rmtree(staging_dir)
        # In-process failures get the same deterministic reconciliation that a
        # later process startup performs. A real process death cannot reach this
        # branch and leaves the fsynced pending record for recovery.
        _recover_pending_locked(machine_dir)
        _gc_generations_locked(machine_dir)
        if final_created:
            _fsync_directory(machine_dir)
        raise


def recover_generation_state(name, *, root=DEFAULT_GENERATIONS_ROOT):
    machine_dir = _machine_directory(Path(root), name)
    if not machine_dir.is_dir():
        return
    with _machine_gc_lock(machine_dir, exclusive=True):
        _recover_pending_locked(machine_dir)
        _cleanup_machine_temps_locked(machine_dir)
        _gc_generations_locked(machine_dir)


def gc_generations(name, *, root=DEFAULT_GENERATIONS_ROOT):
    machine_dir = _machine_directory(Path(root), name)
    if not machine_dir.is_dir():
        return
    with _machine_gc_lock(machine_dir, exclusive=True):
        _recover_pending_locked(machine_dir)
        _cleanup_machine_temps_locked(machine_dir)
        _gc_generations_locked(machine_dir)


def _recover_pending_locked(machine_dir):
    pending_path = machine_dir / ".publication-pending.json"
    try:
        pending = json.loads(pending_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    if not isinstance(pending, dict) or set(pending) != {
        "schema_version",
        "old_generation_id",
        "new_generation_id",
    }:
        raise GenerationValidationError("publication recovery record fields do not match schema")
    if pending["schema_version"] != 1:
        raise GenerationValidationError("unsupported publication recovery schema")
    old_generation_id = pending["old_generation_id"]
    new_generation_id = pending["new_generation_id"]
    if old_generation_id is not None and not _GENERATION_ID.fullmatch(old_generation_id):
        raise GenerationValidationError("publication recovery old generation is invalid")
    if not isinstance(new_generation_id, str) or not _GENERATION_ID.fullmatch(new_generation_id):
        raise GenerationValidationError("publication recovery new generation is invalid")
    current = _read_pointer(machine_dir / "current")
    if current == new_generation_id:
        _finalize_publication_locked(machine_dir, old_generation_id, new_generation_id)
    elif current == old_generation_id:
        pending_path.unlink()
        _fsync_directory(machine_dir)
    else:
        raise GenerationValidationError(
            "publication recovery record does not match the current pointer"
        )


def _finalize_publication_locked(machine_dir, old_generation_id, new_generation_id):
    if _read_pointer(machine_dir / "current") != new_generation_id:
        raise GenerationValidationError("cannot finalize a generation that is not current")
    previous_path = machine_dir / "previous"
    if old_generation_id is None:
        if previous_path.exists():
            previous_path.unlink()
            _fsync_directory(machine_dir)
    else:
        _atomic_write_text(previous_path, old_generation_id + "\n")
    pending_path = machine_dir / ".publication-pending.json"
    if pending_path.exists():
        pending_path.unlink()
        _fsync_directory(machine_dir)


def _cleanup_machine_temps_locked(machine_dir):
    temporary_prefixes = (".staging-", ".current-", ".previous-", "..publication-pending.json-")
    changed = False
    for child in machine_dir.iterdir():
        if not child.name.startswith(temporary_prefixes):
            continue
        if child.is_symlink() or not child.is_dir():
            child.unlink()
        else:
            shutil.rmtree(child)
        changed = True
    if changed:
        _fsync_directory(machine_dir)


def _gc_generations_locked(machine_dir, *, extra_retained=()):
    current = _read_pointer(machine_dir / "current")
    previous = _read_pointer(machine_dir / "previous")
    retained = {
        value
        for value in (current, previous, *extra_retained)
        if value is not None
    }
    changed = False
    for child in machine_dir.iterdir():
        if not child.is_dir() or child.is_symlink() or not _GENERATION_ID.fullmatch(child.name):
            continue
        if child.name in retained:
            continue
        lease_path = _generation_lease_path(machine_dir, child.name)
        removed = False
        with _generation_removal_guard(
            machine_dir, child.name
        ) as removal_allowed:
            if not removal_allowed:
                continue
            _remove_generation_directory(child)
            removed = True
            changed = True
        if removed:
            lease_path.unlink(missing_ok=True)
    if changed:
        _fsync_directory(machine_dir)


def _preflight_copy_space(snapshot_path, machine_dir):
    required = Path(snapshot_path).stat().st_size + 1024 * 1024
    available = shutil.disk_usage(machine_dir).free
    if available < required:
        raise GenerationError(
            "generation publication needs at least %d bytes but only %d are free"
            % (required, available)
        )


def _generation_lease_path(machine_dir, generation_id):
    if not _GENERATION_ID.fullmatch(generation_id):
        raise GenerationValidationError("generation lease id is invalid")
    lease_dir = Path(machine_dir) / ".leases"
    created = not lease_dir.exists()
    lease_dir.mkdir(mode=0o700, exist_ok=True)
    if created:
        _fsync_directory(machine_dir)
    return lease_dir / (generation_id + ".lock")


def _acquire_generation_lease(machine_dir, generation_id):
    lease_path = _generation_lease_path(machine_dir, generation_id)
    fd = os.open(lease_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_SH)
        return _GenerationLease(lease_path, fd)
    except BaseException:
        os.close(fd)
        raise


def _lease_is_active(lease_path):
    with _ACTIVE_LEASES_LOCK:
        return _ACTIVE_LEASES.get(Path(lease_path).resolve(), 0) > 0


@contextmanager
def _generation_removal_guard(machine_dir, generation_id):
    lease_path = _generation_lease_path(machine_dir, generation_id)
    if _lease_is_active(lease_path):
        yield False
        return
    fd = os.open(lease_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True
    finally:
        os.close(fd)


@contextmanager
def _machine_gc_lock(machine_dir, *, exclusive):
    lock_path = Path(machine_dir) / ".gc.lock"
    normalized_lock_path = lock_path.resolve()
    with _MACHINE_THREAD_LOCKS_GUARD:
        thread_lock = _MACHINE_THREAD_LOCKS.setdefault(normalized_lock_path, threading.RLock())
    thread_lock.acquire()
    fd = None
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        operation = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
        fcntl.flock(fd, operation)
        yield
    finally:
        if fd is not None:
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
        thread_lock.release()


def read_current_generation(name, *, root=DEFAULT_GENERATIONS_ROOT):
    machine_dir = _machine_directory(Path(root), name)
    if name in persisted_retired_names(Path(root)):
        return None
    if not machine_dir.is_dir():
        return None
    with _machine_gc_lock(machine_dir, exclusive=False):
        generation_id = _read_pointer(machine_dir / "current")
        if generation_id is None:
            return None
        loaded = _load_generation(name, machine_dir / generation_id)
        lease = _acquire_generation_lease(machine_dir, generation_id)
        return CurrentGeneration(
            host=loaded.host,
            db_path=loaded.db_path,
            generation_dir=loaded.generation_dir,
            meta=loaded.meta,
            _lease=lease,
        )


def admitted_generations(
    *,
    config_path=DEFAULT_CONFIG_PATH,
    root=DEFAULT_GENERATIONS_ROOT,
):
    return _evaluate_generation_admission(config_path=config_path, root=root).admitted


@contextmanager
def generation_admission_snapshot(
    *,
    config_path=DEFAULT_CONFIG_PATH,
    root=DEFAULT_GENERATIONS_ROOT,
):
    admission = _evaluate_generation_admission(config_path=config_path, root=root)
    try:
        yield admission
    finally:
        for current in admission.admitted:
            current.close()


def _evaluate_generation_admission(*, config_path, root):
    root = Path(root)
    config = load_machine_config(config_path, retirement_root=root)

    candidates = []
    records_by_name = {}
    for machine in config.machines:
        try:
            current = read_current_generation(machine.name, root=root)
        except GenerationBucketTimezoneError:
            records_by_name[machine.name] = AdmissionRecord(
                machine, admitted=False, never=False, exclusion_reason="bucket_timezone"
            )
            continue
        except GenerationIdMismatchError:
            records_by_name[machine.name] = AdmissionRecord(
                machine, admitted=False, never=False, exclusion_reason="generation_id"
            )
            continue
        except GenerationDigestMismatchError:
            records_by_name[machine.name] = AdmissionRecord(
                machine, admitted=False, never=False, exclusion_reason="digest"
            )
            continue
        except (GenerationError, OSError, ValueError, json.JSONDecodeError):
            records_by_name[machine.name] = AdmissionRecord(
                machine, admitted=False, never=False, exclusion_reason="invalid_generation"
            )
            continue
        if current is None:
            records_by_name[machine.name] = AdmissionRecord(
                machine, admitted=False, never=True
            )
            continue
        if current.meta["machine_config_fingerprint"] != machine_config_fingerprint(machine):
            current.close()
            records_by_name[machine.name] = AdmissionRecord(
                machine,
                admitted=False,
                never=False,
                exclusion_reason="machine_config_fingerprint",
            )
            continue
        candidates.append(current)

    by_identity = {}
    for current in candidates:
        identity = current.meta["source_host_identity"]
        by_identity.setdefault(identity, []).append(current)
    admitted = tuple(
        current
        for current in candidates
        if len(by_identity[current.meta["source_host_identity"]]) == 1
    )
    admitted_ids = {id(current) for current in admitted}
    for current in candidates:
        if id(current) in admitted_ids:
            records_by_name[current.host] = AdmissionRecord(
                config.by_name[current.host],
                admitted=True,
                never=False,
                current=current,
            )
        else:
            current.close()
            records_by_name[current.host] = AdmissionRecord(
                config.by_name[current.host],
                admitted=False,
                never=False,
                exclusion_reason="source_host_identity_collision",
            )
    return GenerationAdmission(
        config=config,
        admitted=admitted,
        records=tuple(records_by_name[machine.name] for machine in config.machines),
    )


def retire_machines(
    names,
    *,
    config_path=DEFAULT_CONFIG_PATH,
    root=DEFAULT_GENERATIONS_ROOT,
    now=None,
    phase_hook=None,
):
    root = Path(root)
    config_path = Path(config_path)
    requested = tuple(names)
    if not requested or len(set(requested)) != len(requested):
        raise GenerationValidationError("retirement requires unique machine names")
    for name in requested:
        _machine_directory(root, name)
    root_created = not root.exists()
    root.mkdir(parents=True, exist_ok=True)
    if root_created:
        _fsync_directory(root.parent)

    with _retirement_state_lock(root):
        config = load_machine_config(config_path, retirement_root=None)
        generation_backed_names = {
            child.name
            for child in root.iterdir()
            if child.is_dir() and not child.is_symlink()
        }
        known_names = (
            set(config.by_name)
            | set(config.retired_names)
            | persisted_retired_names(root)
            | generation_backed_names
        )
        unknown = set(requested) - known_names
        if unknown:
            raise GenerationValidationError("cannot retire unknown machines: %s" % sorted(unknown))
        if config.self_machine.name in requested:
            raise GenerationValidationError("the configured self machine cannot be retired")
        retired_names = persisted_retired_names(root) | set(config.retired_names) | set(requested)
        payload = {
            "schema_version": 1,
            "retired_names": sorted(retired_names),
            "updated_at": _timestamp(now),
        }
        _atomic_write_json(root / "retirements.json", payload)
        _call_phase_hook(phase_hook, "after_retirement_commit")

        config_payload = {
            "machines": [
                machine.as_config_dict()
                for machine in config.machines
                if machine.name not in retired_names
            ],
            "retired_names": sorted(retired_names),
        }
        if sum(bool(machine["self"]) for machine in config_payload["machines"]) != 1:
            raise GenerationValidationError("retirement must preserve exactly one self machine")
        _atomic_write_json(config_path, config_payload, pretty=True)
        _call_phase_hook(phase_hook, "after_retirement_config")
    return load_machine_config(config_path, retirement_root=root)


def self_certified_host_identity():
    system = platform.system()
    if system == "Linux":
        raw = Path("/etc/machine-id").read_text(encoding="utf-8").strip()
        namespace = "linux-machine-id"
    elif system == "Darwin":
        result = subprocess.run(
            ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        match = re.search(r'"IOPlatformUUID"\s*=\s*"([^"]+)"', result.stdout)
        if match is None:
            raise GenerationError("owning machine did not expose IOPlatformUUID")
        raw = match.group(1)
        namespace = "darwin-ioplatformuuid"
    else:
        raise GenerationError("unsupported host identity platform: %s" % system)
    if not raw:
        raise GenerationError("owning machine returned an empty host identity")
    digest = hashlib.sha256((namespace + "\0" + raw).encode("utf-8")).hexdigest()
    return "host-v1:" + digest


def snapshot_stats(snapshot_path):
    snapshot_path = Path(snapshot_path)
    if not snapshot_path.is_file():
        raise FileNotFoundError(snapshot_path)
    wal = Path(str(snapshot_path) + "-wal")
    # Frames, not the file: a reader holding the snapshot open leaves a
    # zero-length WAL behind, and refusing on that would make a generation
    # unvalidatable for as long as anyone is looking at it.
    if wal.exists() and wal.stat().st_size > 0:
        raise GenerationValidationError("generation snapshot must not have WAL frames")
    uri = snapshot_path.resolve().as_uri() + "?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        conn.row_factory = sqlite3.Row
        if not _table_exists(conn, "daily_rollup"):
            raise GenerationValidationError("snapshot is missing daily_rollup")
        if not _table_exists(conn, "rollup_meta"):
            raise GenerationValidationError("snapshot is missing rollup_meta")
        marker = conn.execute(
            "SELECT value FROM rollup_meta WHERE key = 'bucket_timezone'"
        ).fetchone()
        bucket_timezone = marker[0] if marker else None
        if bucket_timezone != "Asia/Shanghai":
            raise GenerationBucketTimezoneError(
                "snapshot bucket_timezone must be Asia/Shanghai"
            )
        rows = [
            tuple(row[field] for field in _ROW_FIELDS)
            for row in conn.execute(
                "SELECT %s FROM daily_rollup ORDER BY date, agent_id, project, model"
                % ", ".join(_ROW_FIELDS)
            )
        ]
    finally:
        conn.close()

    totals = {
        # These totals are compared across machines to decide whether a
        # transferred snapshot is the one that was exported, so the arithmetic
        # has to land on the same value everywhere. Builtin sum() does not:
        # CPython 3.12 gave it compensated summation for floats, so an export
        # from an older interpreter and a check on a newer one disagree in the
        # last place over identical rows. fsum sums exactly and rounds once,
        # which is reproducible across interpreters and row orders alike. The
        # integer totals below are exact already.
        "cost": math.fsum(row[8] for row in rows),
        "input": sum(row[4] for row in rows),
        "output": sum(row[5] for row in rows),
        "cache_creation": sum(row[6] for row in rows),
        "cache_read": sum(row[7] for row in rows),
        "messages": sum(row[11] for row in rows),
    }
    totals["total"] = (
        totals["input"]
        + totals["output"]
        + totals["cache_creation"]
        + totals["cache_read"]
    )
    return {
        "row_count": len(rows),
        "data_start_date": min((row[0] for row in rows), default=None),
        "bucket_timezone": bucket_timezone,
        "metric_totals": totals,
        "logical_digest": hashlib.sha256(_canonical_json(rows)).hexdigest(),
    }


def _validate_generation(snapshot_path, meta, *, allow_unpublished):
    _validate_meta_shape(meta)
    if not allow_unpublished and meta["published_at"] is None:
        raise GenerationValidationError("published generation is missing published_at")
    if _generation_id(meta) != meta["generation_id"]:
        raise GenerationIdMismatchError("generation_id does not match immutable metadata")
    if _file_digest(snapshot_path) != meta["transfer_digest"]:
        raise GenerationDigestMismatchError("transfer_digest does not match snapshot.db")
    stats = snapshot_stats(snapshot_path)
    for field in (
        "data_start_date",
        "bucket_timezone",
        "row_count",
        "metric_totals",
        "logical_digest",
    ):
        if stats[field] != meta[field]:
            raise GenerationDigestMismatchError("%s does not match snapshot.db" % field)


def _validate_meta_shape(meta):
    if not isinstance(meta, dict) or set(meta) != _META_FIELDS:
        raise GenerationValidationError("generation metadata fields do not match schema")
    if meta["schema_version"] != GENERATION_SCHEMA_VERSION:
        raise GenerationValidationError("unsupported generation schema_version")
    if not isinstance(meta["generation_id"], str) or not _GENERATION_ID.fullmatch(meta["generation_id"]):
        raise GenerationValidationError("generation_id must be a sha256 digest")
    for field in ("machine_config_fingerprint", "transfer_digest", "logical_digest"):
        if not isinstance(meta[field], str) or not _DIGEST.fullmatch(meta[field]):
            raise GenerationValidationError("%s must be a sha256 digest" % field)
    _validate_source_host_identity(meta["source_host_identity"])
    validate_alias_proofs(meta["aliases"])
    if not isinstance(meta["rate_limits"], dict):
        raise GenerationValidationError("rate_limits must be an object")
    if meta["data_start_date"] is not None:
        try:
            date.fromisoformat(meta["data_start_date"])
        except (TypeError, ValueError) as exc:
            raise GenerationValidationError("data_start_date must be an ISO date") from exc
    if not isinstance(meta["exporter_commit"], str) or not meta["exporter_commit"]:
        raise GenerationValidationError("exporter_commit must be a non-empty string")
    if meta["bucket_timezone"] != "Asia/Shanghai":
        raise GenerationBucketTimezoneError("bucket_timezone must be Asia/Shanghai")
    if type(meta["row_count"]) is not int or meta["row_count"] < 0:
        raise GenerationValidationError("row_count must be a non-negative integer")
    if not isinstance(meta["metric_totals"], dict) or set(meta["metric_totals"]) != _METRIC_TOTAL_KEYS:
        raise GenerationValidationError("metric_totals do not match the rollup metric schema")
    _parse_timestamp(meta["generated_at"], "generated_at")
    if meta["published_at"] is not None:
        _parse_timestamp(meta["published_at"], "published_at")


def _validate_source_host_identity(value):
    if not isinstance(value, str) or not re.fullmatch(r"host-v1:[0-9a-f]{64}", value):
        raise GenerationValidationError(
            "source_host_identity must be owning-machine certified"
        )


def _generation_id(meta):
    identity = {
        key: value
        for key, value in meta.items()
        if key not in {"generation_id", "published_at"}
    }
    return hashlib.sha256(_canonical_json(identity)).hexdigest()


def _load_generation(name, generation_dir):
    generation_dir = Path(generation_dir)
    if not _GENERATION_ID.fullmatch(generation_dir.name):
        raise GenerationValidationError("current pointer is not a generation id")
    meta_path = generation_dir / "meta.json"
    snapshot_path = generation_dir / "snapshot.db"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("generation_id") != generation_dir.name:
        raise GenerationIdMismatchError("generation directory and metadata disagree")
    _validate_generation(snapshot_path, meta, allow_unpublished=False)
    return CurrentGeneration(
        host=name,
        db_path=snapshot_path,
        generation_dir=generation_dir,
        meta=meta,
    )


def _read_pointer(path):
    path = Path(path)
    try:
        value = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    if not _GENERATION_ID.fullmatch(value):
        raise GenerationIdMismatchError("current pointer is not a generation id")
    return value


def _write_json(path, payload):
    path = Path(path)
    with path.open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def _atomic_write_json(path, payload, *, pretty=False):
    if pretty:
        value = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    else:
        value = json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
    _atomic_write_text(path, value)


def _atomic_write_text(path, value):
    path = Path(path)
    temporary = path.with_name(".%s-%s" % (path.name, uuid.uuid4().hex))
    mode = stat.S_IMODE(path.stat().st_mode) if path.exists() else 0o600
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def _machine_directory(root, name):
    if not isinstance(name, str) or not _MACHINE_NAME.fullmatch(name):
        raise GenerationValidationError("machine name is not a safe directory component")
    return Path(root) / name


def _remove_generation_directory(path):
    path = Path(path)
    if not _GENERATION_ID.fullmatch(path.name):
        raise ValueError("refusing to remove a non-generation directory")
    shutil.rmtree(path)


def _timestamp(now=None):
    value = now() if callable(now) else now
    if value is None:
        value = datetime.now(timezone.utc)
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("generation timestamp must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_timestamp(value, field):
    if not isinstance(value, str):
        raise GenerationValidationError("%s must be an ISO timestamp" % field)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise GenerationValidationError("%s must be an ISO timestamp" % field) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GenerationValidationError("%s must be timezone-aware" % field)


def _file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _table_exists(conn, table_name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (table_name,),
    ).fetchone() is not None


def _fsync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_file(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def _retirement_state_lock(root):
    lock_path = Path(root) / ".retirements.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)


def _call_phase_hook(hook, phase):
    if hook is not None:
        hook(phase)
