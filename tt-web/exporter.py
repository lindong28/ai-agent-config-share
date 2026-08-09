import dataclasses
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import uuid
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import generation
import rollup
from parsers import claude_status, codex


ROOT = Path(__file__).resolve().parent
EXPORT_SCHEMA_VERSION = 1
_MANIFEST_FIELDS = {
    "schema_version",
    "source_host_identity",
    "aliases",
    "rate_limits",
    "exporter_commit",
    "generated_at",
    "transfer_digest",
    "data_start_date",
    "bucket_timezone",
    "row_count",
    "metric_totals",
    "logical_digest",
    "manifest_digest",
}
_RUNTIME_AUTHORITY_PATHS = (
    ":(glob)*.py",
    ":(glob)parsers/**",
    "pricing.json",
    "tt-web",
    "install.sh",
    "machines.json",
)


class ExportError(RuntimeError):
    pass


class ExportSpaceError(ExportError):
    pass


def exporter_version():
    head = subprocess.run(
        ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    commit = head.stdout.strip()
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise ExportError("exporter checkout did not report a full commit SHA")
    status = subprocess.run(
        [
            "git",
            "-C",
            str(ROOT),
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
            "--",
            *_RUNTIME_AUTHORITY_PATHS,
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    if status.stdout:
        raise ExportError(
            "exporter runtime authority differs from HEAD; commit or remove those changes before export"
        )
    return commit


def export_bundle(
    db_path=rollup.DEFAULT_DB_PATH,
    output_path=None,
    *,
    refresh=True,
    entries_loader=None,
    source_host_identity=None,
    generated_at=None,
    rate_limits=None,
    rollup_now=None,
):
    db_path = Path(db_path)
    if output_path is None:
        raise ValueError("output_path is required")
    output_path = Path(output_path)
    if output_path.exists():
        raise FileExistsError(output_path)
    resolved_exporter_commit = exporter_version()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _cleanup_export_staging(output_path)
    _preflight_space(db_path, output_path.parent)
    staging = output_path.with_name(".%s.staging-%s" % (output_path.name, uuid.uuid4().hex))
    staging.mkdir(mode=0o700)
    try:
        snapshot_path = staging / "snapshot.db"
        with rollup.rollup_lock(db_path):
            if refresh:
                kwargs = {}
                if entries_loader is not None:
                    kwargs["entries_loader"] = entries_loader
                if rollup_now is not None:
                    kwargs["now"] = rollup_now
                rollup.run(db_path=db_path, **kwargs)
            _vacuum_into_locked(db_path, snapshot_path)

        stats = generation.snapshot_stats(snapshot_path)
        manifest = {
            "schema_version": EXPORT_SCHEMA_VERSION,
            "source_host_identity": source_host_identity or generation.self_certified_host_identity(),
            # daily_rollup has no source-path column. Current repository observations
            # cannot prove which historical aggregate row came from a path, so v1
            # exports no alias coverage rather than self-declaring it.
            "aliases": [],
            "rate_limits": _rate_limits() if rate_limits is None else rate_limits,
            "exporter_commit": resolved_exporter_commit,
            "generated_at": generated_at or _timestamp(),
            "transfer_digest": _file_digest(snapshot_path),
            **stats,
        }
        manifest["manifest_digest"] = manifest_digest(manifest)
        validate_export_manifest(manifest, snapshot_path)
        _write_json(staging / "export.json", manifest)
        generation._fsync_file(snapshot_path)
        generation._fsync_directory(staging)
        os.replace(staging, output_path)
        generation._fsync_directory(output_path.parent)
        return manifest
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
            generation._fsync_directory(staging.parent)
        raise


def validate_export_manifest(manifest, snapshot_path):
    if not isinstance(manifest, dict) or set(manifest) != _MANIFEST_FIELDS:
        raise ExportError("export manifest fields do not match schema")
    if manifest["schema_version"] != EXPORT_SCHEMA_VERSION:
        raise ExportError("unsupported export schema_version")
    if manifest["manifest_digest"] != manifest_digest(manifest):
        raise ExportError("manifest_digest does not match export metadata")
    if manifest["aliases"] != []:
        raise ExportError("export schema v1 cannot substantiate alias row lineage")
    if not isinstance(manifest["rate_limits"], dict):
        raise ExportError("rate_limits must be an object")
    if _file_digest(snapshot_path) != manifest["transfer_digest"]:
        raise ExportError("transfer_digest does not match snapshot.db")
    stats = generation.snapshot_stats(snapshot_path)
    for field in (
        "data_start_date",
        "bucket_timezone",
        "row_count",
        "metric_totals",
        "logical_digest",
    ):
        if manifest[field] != stats[field]:
            raise ExportError("%s does not match snapshot.db" % field)
    generation._validate_meta_shape(
        generation.build_generation_meta(
            snapshot_path,
            machine_config_fingerprint="0" * 64,
            source_host_identity=manifest["source_host_identity"],
            aliases=manifest["aliases"],
            rate_limits=manifest["rate_limits"],
            exporter_commit=manifest["exporter_commit"],
            generated_at=manifest["generated_at"],
        )
    )
    return manifest


def manifest_digest(manifest):
    payload = {
        key: value
        for key, value in manifest.items()
        if key != "manifest_digest"
    }
    return hashlib.sha256(
        json.dumps(
            payload,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _vacuum_into_locked(db_path, output_path):
    db_path = Path(db_path)
    output_path = Path(output_path)
    rollup._assert_lock_held(db_path)
    if output_path.exists():
        raise FileExistsError(output_path)
    uri = db_path.resolve().as_uri() + "?mode=ro"
    with closing(sqlite3.connect(uri, uri=True, timeout=30)) as conn:
        rollup._require_bucket_timezone(conn, db_path)
        conn.execute("VACUUM INTO ?", (str(output_path),))
    generation._fsync_file(output_path)


def _preflight_space(db_path, destination_parent):
    required = max(_database_bytes(db_path), 1) + 1024 * 1024
    available = shutil.disk_usage(destination_parent).free
    if available < required:
        raise ExportSpaceError(
            "export needs at least %d bytes but only %d are free" % (required, available)
        )


def _database_bytes(db_path):
    total = 0
    for suffix in ("", "-wal"):
        try:
            total += Path(str(db_path) + suffix).stat().st_size
        except FileNotFoundError:
            pass
    return total


def _cleanup_export_staging(output_path):
    prefix = ".%s.staging-" % output_path.name
    changed = False
    for child in output_path.parent.iterdir():
        if not child.name.startswith(prefix):
            continue
        if child.is_symlink() or not child.is_dir():
            child.unlink()
        else:
            shutil.rmtree(child)
        changed = True
    if changed:
        generation._fsync_directory(output_path.parent)


def _rate_limits():
    return {
        "claude": _rate_limit_block(claude_status.load_rate_limits()),
        "codex": _rate_limit_block(codex.load_rate_limits()),
    }


def _rate_limit_block(value):
    return dataclasses.asdict(value) if value is not None else None


def _timestamp():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_json(path, payload):
    with Path(path).open("x", encoding="utf-8") as handle:
        json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
