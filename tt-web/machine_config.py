import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path


DEFAULT_CONFIG_PATH = Path(__file__).resolve().with_name("machines.json")
DEFAULT_RETIREMENT_ROOT = Path(__file__).resolve().parent / "state" / "generations"
_DEFAULT_RETIREMENT_ROOT = object()
_ROOT_FIELDS = {"machines", "retired_names"}
_MACHINE_FIELDS = {"name", "ssh_host", "self"}
_MACHINE_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$")
_RETIREMENT_LEDGER_FIELDS = {"schema_version", "retired_names", "updated_at"}


class MachineConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Machine:
    name: str
    ssh_host: str
    is_self: bool

    def as_config_dict(self):
        return {"name": self.name, "ssh_host": self.ssh_host, "self": self.is_self}


@dataclass(frozen=True)
class MachineConfig:
    machines: tuple
    retired_names: frozenset

    @property
    def by_name(self):
        return {machine.name: machine for machine in self.machines}

    @property
    def self_machine(self):
        return next(machine for machine in self.machines if machine.is_self)


def load_machine_config(path=DEFAULT_CONFIG_PATH, *, retirement_root=_DEFAULT_RETIREMENT_ROOT):
    path = Path(path)
    if retirement_root is _DEFAULT_RETIREMENT_ROOT:
        retirement_root = DEFAULT_RETIREMENT_ROOT if path.resolve() == DEFAULT_CONFIG_PATH.resolve() else None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys)
    except (OSError, json.JSONDecodeError) as exc:
        raise MachineConfigError(f"cannot load machine config {path}: {exc}") from exc

    if not isinstance(payload, dict):
        raise MachineConfigError("machine config must be a JSON object")
    unknown_root_fields = set(payload) - _ROOT_FIELDS
    missing_root_fields = _ROOT_FIELDS - set(payload)
    if unknown_root_fields:
        raise MachineConfigError(f"unknown machine config fields: {sorted(unknown_root_fields)}")
    if missing_root_fields:
        raise MachineConfigError(f"missing machine config fields: {sorted(missing_root_fields)}")

    raw_machines = payload["machines"]
    raw_retired_names = payload["retired_names"]
    if not isinstance(raw_machines, list):
        raise MachineConfigError("machines must be a list")
    if not isinstance(raw_retired_names, list):
        raise MachineConfigError("retired_names must be a list")

    retired_names = {
        _validated_machine_name(value, f"retired_names[{index}]")
        for index, value in enumerate(raw_retired_names)
    }
    if len(retired_names) != len(raw_retired_names):
        raise MachineConfigError("retired_names contains duplicates")

    machines = tuple(_parse_machine(item, index) for index, item in enumerate(raw_machines))
    names = [machine.name for machine in machines]
    if len(set(names)) != len(names):
        raise MachineConfigError("duplicate machine name")
    ssh_hosts = [machine.ssh_host.casefold() for machine in machines]
    if len(set(ssh_hosts)) != len(ssh_hosts):
        raise MachineConfigError("duplicate ssh_host pull target")
    reused_names = set(names) & retired_names
    if reused_names:
        raise MachineConfigError(f"retired machine name cannot be active: {sorted(reused_names)}")
    persisted_retired = persisted_retired_names(retirement_root)
    uncommitted_retirements = retired_names - persisted_retired
    if retirement_root is not None and uncommitted_retirements:
        raise MachineConfigError(
            "retired_names are missing the explicit retirement commit: %s"
            % sorted(uncommitted_retirements)
        )
    persistently_reused = set(names) & persisted_retired
    if persistently_reused:
        raise MachineConfigError(
            f"persistently retired machine name cannot be active: {sorted(persistently_reused)}"
        )
    if sum(machine.is_self for machine in machines) != 1:
        raise MachineConfigError("machine config must contain exactly one self machine")

    return MachineConfig(machines=machines, retired_names=frozenset(retired_names))


def persisted_retired_names(root):
    if root is None:
        return set()
    root = Path(root)
    if not root.is_dir():
        return set()
    retired = {
        marker.parent.name
        for marker in root.glob("*/retired.json")
        if marker.is_file()
    }
    ledger = root / "retirements.json"
    if not ledger.exists():
        return retired
    try:
        payload = json.loads(
            ledger.read_text(encoding="utf-8"),
            object_pairs_hook=_reject_duplicate_keys,
        )
    except (OSError, json.JSONDecodeError) as exc:
        raise MachineConfigError("cannot load retirement state %s: %s" % (ledger, exc)) from exc
    if not isinstance(payload, dict) or set(payload) != _RETIREMENT_LEDGER_FIELDS:
        raise MachineConfigError("retirement state fields do not match schema")
    if payload["schema_version"] != 1:
        raise MachineConfigError("unsupported retirement state schema_version")
    raw_names = payload["retired_names"]
    if not isinstance(raw_names, list):
        raise MachineConfigError("retirement state retired_names must be a list")
    ledger_names = {
        _validated_machine_name(value, "retirement state retired_names[%d]" % index)
        for index, value in enumerate(raw_names)
    }
    if len(ledger_names) != len(raw_names):
        raise MachineConfigError("retirement state retired_names contains duplicates")
    if not isinstance(payload["updated_at"], str) or not payload["updated_at"]:
        raise MachineConfigError("retirement state updated_at must be a non-empty timestamp")
    return retired | ledger_names


def machine_config_fingerprint(machine):
    canonical_json = json.dumps(
        machine.as_config_dict(),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()


def admit_machine(config, name, recorded_fingerprint):
    machine = config.by_name.get(name)
    if machine is None:
        return None
    if recorded_fingerprint != machine_config_fingerprint(machine):
        return None
    return machine


def _parse_machine(payload, index):
    if not isinstance(payload, dict):
        raise MachineConfigError(f"machines[{index}] must be an object")
    unknown_fields = set(payload) - _MACHINE_FIELDS
    missing_fields = _MACHINE_FIELDS - set(payload)
    if unknown_fields:
        raise MachineConfigError(f"unknown machine fields at index {index}: {sorted(unknown_fields)}")
    if missing_fields:
        raise MachineConfigError(f"missing machine fields at index {index}: {sorted(missing_fields)}")

    name = _validated_machine_name(payload["name"], f"machines[{index}].name")
    ssh_host = _validated_name(payload["ssh_host"], f"machines[{index}].ssh_host")
    is_self = payload["self"]
    if type(is_self) is not bool:
        raise MachineConfigError(f"machines[{index}].self must be a boolean")
    return Machine(name=name, ssh_host=ssh_host, is_self=is_self)


def _validated_name(value, field):
    if not isinstance(value, str) or not value or value.strip() != value:
        raise MachineConfigError(f"{field} must be a non-empty string without surrounding whitespace")
    return value


def _validated_machine_name(value, field):
    value = _validated_name(value, field)
    if not _MACHINE_NAME.fullmatch(value):
        raise MachineConfigError(
            f"{field} must be a lowercase ASCII slug using only letters, digits, '-' or '_'"
        )
    return value


def _reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise MachineConfigError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result
