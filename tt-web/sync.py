import json
import re
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import exporter
import generation
import rollup
from machine_config import DEFAULT_CONFIG_PATH, load_machine_config, machine_config_fingerprint


_SSH_HOST = re.compile(r"^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+$")
_REMOTE_TEMP = re.compile(r"^/tmp/tt-web-export\.[A-Za-z0-9]+$")
_SSH_PREFIX = ("ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10")
_SCP_PREFIX = ("scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-r")
_REMOTE_REAPER = (
    "find /tmp -maxdepth 1 -type d -user \"$(id -u)\" "
    "-name 'tt-web-export.*' -mmin +60 -exec rm -rf -- {} +"
)
REMOTE_CLEANUP_TIMEOUT = 10


class SyncError(RuntimeError):
    pass


class TransferValidationError(SyncError):
    pass


@dataclass(frozen=True)
class SyncResult:
    generation: object = None
    error: str = None


def sync_machine(
    machine,
    *,
    db_path=rollup.DEFAULT_DB_PATH,
    root=generation.DEFAULT_GENERATIONS_ROOT,
    timeout=180,
    runner=subprocess.run,
    export_kwargs=None,
    accept_first_use_ssh_target=False,
):
    root = Path(root)
    root.parent.mkdir(parents=True, exist_ok=True)
    generation.recover_generation_state(machine.name, root=root)
    export_kwargs = dict(export_kwargs or {})
    with tempfile.TemporaryDirectory(
        prefix=".sync-%s-" % machine.name,
        dir=root.parent,
    ) as temporary:
        local_bundle = Path(temporary) / "bundle"
        if machine.is_self:
            local_identity = generation.self_certified_host_identity()
            configured_identity = export_kwargs.pop("source_host_identity", None)
            if configured_identity not in (None, local_identity):
                raise SyncError(
                    "self export source identity does not match this owning machine"
                )
            if accept_first_use_ssh_target:
                raise SyncError(
                    "self machine does not use SSH trust on first use"
                )
            source_manifest = exporter.export_bundle(
                db_path,
                local_bundle,
                source_host_identity=local_identity,
                **export_kwargs,
            )
            accept_first_use = True
        else:
            source_manifest = _pull_remote_export(
                machine.ssh_host,
                local_bundle,
                timeout=timeout,
                runner=runner,
            )
            accept_first_use = accept_first_use_ssh_target
        return install_export_bundle(
            machine,
            local_bundle,
            expected_manifest=source_manifest,
            accept_first_use=accept_first_use,
            root=root,
        )


def sync_all(
    *,
    config_path=DEFAULT_CONFIG_PATH,
    root=generation.DEFAULT_GENERATIONS_ROOT,
    db_path=rollup.DEFAULT_DB_PATH,
    timeout=180,
    runner=subprocess.run,
    accept_first_use_ssh_targets=None,
):
    config = load_machine_config(config_path, retirement_root=root)
    results = {}
    for machine in config.machines:
        try:
            current = sync_machine(
                machine,
                db_path=db_path,
                root=root,
                timeout=timeout,
                runner=runner,
                accept_first_use_ssh_target=machine.name
                in (accept_first_use_ssh_targets or ()),
            )
        except subprocess.TimeoutExpired:
            results[machine.name] = SyncResult(error="timeout")
        except (
            OSError,
            ValueError,
            subprocess.SubprocessError,
            SyncError,
            exporter.ExportError,
            generation.GenerationError,
        ) as exc:
            results[machine.name] = SyncResult(error=str(exc))
        else:
            results[machine.name] = SyncResult(generation=current)
    return results


def _pull_remote_export(ssh_host, local_bundle, *, timeout, runner):
    if not isinstance(timeout, (int, float)) or timeout <= 0:
        raise ValueError("sync timeout must be positive")
    if not isinstance(ssh_host, str) or not _SSH_HOST.fullmatch(ssh_host):
        raise SyncError("ssh_host is not a safe SSH destination")
    deadline = time.monotonic() + timeout
    remote_temp = None
    try:
        _run(
            runner,
            [*_SSH_PREFIX, ssh_host, _REMOTE_REAPER],
            deadline,
        )
        created = _run(
            runner,
            [*_SSH_PREFIX, ssh_host, "mktemp -d /tmp/tt-web-export.XXXXXXXX"],
            deadline,
        )
        remote_temp = created.stdout.strip()
        if not _REMOTE_TEMP.fullmatch(remote_temp):
            raise SyncError("remote mktemp returned an unsafe path")
        exported = _run(
            runner,
            [
                *_SSH_PREFIX,
                ssh_host,
                "~/.local/bin/tt-web export --out %s/bundle" % remote_temp,
            ],
            deadline,
        )
        _run(
            runner,
            [*_SCP_PREFIX, "%s:%s/bundle" % (ssh_host, remote_temp), str(local_bundle)],
            deadline,
        )
        try:
            source_manifest = json.loads(exported.stdout)
        except (TypeError, ValueError) as exc:
            raise SyncError("remote exporter did not return one JSON manifest") from exc
        if not isinstance(source_manifest, dict):
            raise SyncError("remote exporter did not return one JSON manifest")
        return source_manifest
    finally:
        if remote_temp is not None and _REMOTE_TEMP.fullmatch(remote_temp):
            primary_failed = sys.exc_info()[0] is not None
            try:
                runner(
                    [*_SSH_PREFIX, ssh_host, "rm -rf -- %s" % remote_temp],
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=REMOTE_CLEANUP_TIMEOUT,
                )
            except (OSError, subprocess.SubprocessError) as exc:
                if not primary_failed:
                    raise SyncError("remote export cleanup failed") from exc


def _run(runner, args, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise subprocess.TimeoutExpired(args, 0)
    return runner(
        args,
        check=True,
        capture_output=True,
        text=True,
        timeout=remaining,
    )


def install_export_bundle(
    machine,
    bundle_path,
    *,
    expected_manifest,
    accept_first_use=False,
    root=generation.DEFAULT_GENERATIONS_ROOT,
):
    bundle_path = Path(bundle_path)
    snapshot_path = bundle_path / "snapshot.db"
    manifest_path = bundle_path / "export.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        exporter.validate_export_manifest(expected_manifest, snapshot_path)
        exporter.validate_export_manifest(manifest, snapshot_path)
    except (OSError, ValueError, exporter.ExportError) as exc:
        raise TransferValidationError(str(exc)) from exc
    if manifest != expected_manifest:
        raise TransferValidationError(
            "received export manifest does not match the sending exporter's manifest"
        )
    try:
        generation.bind_source_identity(
            machine.name,
            manifest["source_host_identity"],
            accept_first_use=accept_first_use,
            root=root,
        )
    except generation.GenerationError as exc:
        raise TransferValidationError(str(exc)) from exc

    meta = generation.build_generation_meta(
        snapshot_path,
        machine_config_fingerprint=machine_config_fingerprint(machine),
        source_host_identity=manifest["source_host_identity"],
        aliases=manifest["aliases"],
        rate_limits=manifest["rate_limits"],
        exporter_commit=manifest["exporter_commit"],
        generated_at=manifest["generated_at"],
    )
    if meta["transfer_digest"] != manifest["transfer_digest"]:
        raise TransferValidationError("transfer_digest changed while installing export")
    for field in (
        "data_start_date",
        "bucket_timezone",
        "row_count",
        "metric_totals",
        "logical_digest",
    ):
        if meta[field] != manifest[field]:
            raise TransferValidationError("%s changed while installing export" % field)
    return generation.publish_generation(machine.name, snapshot_path, meta, root=root)
