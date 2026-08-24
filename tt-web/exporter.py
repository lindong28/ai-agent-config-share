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
from parsers import accounts, claude_status, codex


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
        "claude": _rate_limit_block(
            claude_status.load_rate_limits(), accounts.claude_account()
        ),
        "codex": _rate_limit_block(codex.load_rate_limits(), accounts.codex_account()),
    }


def _rate_limit_block(value, account=None):
    """A quota reading, stamped with the account this machine is signed in as.

    The stamp is what lets the dashboard group readings by account instead of
    picking whichever machine reported last. It is an assumption, not a proof —
    see ADR-024 for the window it is wrong in and why that was accepted.

    Two plans travel here, and they are two different facts, not one fact
    twice: `reading_plan` is the plan the quota reading itself reported, and
    `credential_plan` is what this machine's credential file says right now.
    They disagree whenever the two clocks have drifted — a plan upgrade the
    credential file has not refreshed through, or a reading left behind by a
    previous sign-in — and the page says so rather than picking one and calling
    it the account's plan. Which of the two is the stale one is not knowable
    from the pair, so nothing here claims it. See ADR 20260822-586a.

    Both are published raw, and separately, because the derived value alone
    cannot be undone: a machine whose reading carries no plan falls back to the
    credential one, and the result is then byte-identical to a machine where
    two independent sources happen to agree. Those are not the same state —
    one has a second source and the other has none — and a consumer that
    receives only the derived value has no way back to the difference.

    `account_plan` is the derived display value, co-published for one reason
    only: a server older than these fields reads it and has nothing else to
    show. It is not the authority — this is one writer among several, since
    every machine runs its own exporter at its own version and nothing between
    them checks that a published `account_plan` agrees with the pair beside it.
    The server therefore re-derives it on the way in and falls back to this
    value only when the pair is absent; see `_account_entry`. Once no exporter
    predates the pair, this field has no remaining reason to exist.
    """
    if value is None:
        return None
    block = dataclasses.asdict(value)
    # Parser-side carrier, not a wire field: it exists to reach the lines below
    # under the name the wire uses.
    reading_plan = _text(block.pop("plan", None))
    credential_plan = _text(account.plan) if account else None
    block["account_id"] = account.account_id if account else None
    block["account_label"] = account.label if account else None
    block["account_plan"] = reading_plan or credential_plan
    block["reading_plan"] = reading_plan
    block["credential_plan"] = credential_plan
    return block


def _text(value):
    """A usable string, or None. The last guard before a value reaches the wire.

    Both plan sources already narrow to this, each in its own parser. Repeating
    it at the one place that writes the contract means a future parser cannot
    quietly widen it: a truthy non-string would survive `or`, be published, and
    end up both in a rendered label and in the equality that decides whether the
    two sources disagree.
    """
    return value if isinstance(value, str) and value else None


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
