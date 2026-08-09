import re
from dataclasses import dataclass
from datetime import datetime


_HOME_PATH = re.compile(r"^/(?:Users|home)/[^/]+(?P<suffix>/.*)?$")


@dataclass(frozen=True)
class ProjectRef:
    host: str
    raw: str


@dataclass(frozen=True)
class ProjectCollision:
    canonical: str
    projects: tuple


class ProjectAliasCollisionError(ValueError):
    def __init__(self, collisions):
        self.collisions = tuple(collisions)
        values = ", ".join(collision.canonical for collision in self.collisions)
        super().__init__(f"cross-host project aliases collide without git remote proof: {values}")


class AliasProofError(ValueError):
    pass


_ALIAS_PROOF_FIELDS = {
    "source_path",
    "canonical_project",
    "observed_at",
    "repository_identity",
    "covered_rows",
}


def make_alias_proof(
    *,
    source_path,
    canonical_project,
    observed_at,
    repository_identity,
    covered_rows=(),
):
    proof = {
        "source_path": source_path,
        "canonical_project": canonical_project,
        "observed_at": observed_at,
        "repository_identity": repository_identity,
        "covered_rows": list(covered_rows),
    }
    return validate_alias_proofs([proof])[0]


def validate_alias_proofs(proofs):
    if proofs in (None, {}):
        return []
    if not isinstance(proofs, (list, tuple)):
        raise AliasProofError("aliases must be a list of lineage-bearing proofs")
    validated = []
    seen_paths = set()
    for index, proof in enumerate(proofs):
        if not isinstance(proof, dict) or set(proof) != _ALIAS_PROOF_FIELDS:
            raise AliasProofError(f"alias proof {index} fields do not match schema")
        source_path = proof["source_path"]
        canonical = proof["canonical_project"]
        observed_at = proof["observed_at"]
        repository_identity = proof["repository_identity"]
        covered_rows = proof["covered_rows"]
        if not isinstance(source_path, str) or not source_path.startswith("/"):
            raise AliasProofError("alias proof source_path must be an absolute owning-host path")
        if source_path in seen_paths:
            raise AliasProofError(f"duplicate alias proof source_path: {source_path}")
        if not isinstance(canonical, str) or not canonical:
            raise AliasProofError("alias proof canonical_project must be a non-empty string")
        if not isinstance(repository_identity, str) or not re.fullmatch(
            r"repo-v1:[0-9a-f]{64}", repository_identity
        ):
            raise AliasProofError("alias proof repository_identity must be source-certified")
        if not isinstance(observed_at, str):
            raise AliasProofError("alias proof observed_at must be a timestamp")
        try:
            observed = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise AliasProofError("alias proof observed_at must be an ISO timestamp") from exc
        if observed.tzinfo is None or observed.utcoffset() is None:
            raise AliasProofError("alias proof observed_at must be timezone-aware")
        if not isinstance(covered_rows, list):
            raise AliasProofError("alias proof covered_rows must be a list")
        if covered_rows:
            raise AliasProofError(
                "generation schema v1 cannot substantiate historical coverage; "
                "covered_rows must remain empty until the owning-host exporter derives row lineage"
            )
        seen_paths.add(source_path)
        validated.append(dict(proof))
    return validated


def canonical_project(raw, aliases_for_that_host=None, *, row_date=None):
    """Map a stored project label using current-remote proof from its source host.

    Alias membership carries the proof; a remote-shaped label by itself does not.
    """
    if not isinstance(raw, str):
        raise TypeError("raw project must be a string")

    proofs = validate_alias_proofs(aliases_for_that_host)
    proof = next(
        (
            item
            for item in proofs
            if item["source_path"] == raw and _proof_covers(item, row_date)
        ),
        None,
    )
    if proof is not None:
        return proof["canonical_project"]

    home_match = _HOME_PATH.match(raw)
    if home_match:
        return "~" + (home_match.group("suffix") or "")
    return raw


def audit_project_collisions(
    projects_by_host,
    aliases_by_host=None,
    row_dates_by_host=None,
):
    aliases_by_host = aliases_by_host or {}
    row_dates_by_host = row_dates_by_host or {}
    normalized = {}
    grouped = {}
    evidence = {}

    for host, raw_projects in projects_by_host.items():
        host_aliases = validate_alias_proofs(aliases_by_host.get(host))
        host_normalized = {}
        for raw in raw_projects:
            row_date = (row_dates_by_host.get(host) or {}).get(raw)
            canonical = canonical_project(raw, host_aliases, row_date=row_date)
            host_normalized[raw] = canonical
            ref = ProjectRef(host=host, raw=raw)
            grouped.setdefault(canonical, []).append(ref)
            evidence[ref] = _current_remote_proof(raw, host_aliases, row_date)
        normalized[host] = host_normalized

    collisions = []
    for canonical, projects in grouped.items():
        if len({project.host for project in projects}) < 2:
            continue
        repository_identities = {evidence[project] for project in projects}
        if None not in repository_identities and len(repository_identities) == 1:
            continue
        collisions.append(ProjectCollision(canonical=canonical, projects=tuple(projects)))

    if collisions:
        collisions.sort(key=lambda collision: collision.canonical)
        raise ProjectAliasCollisionError(collisions)
    return normalized


def _current_remote_proof(raw, aliases, row_date):
    proof = next(
        (
            item
            for item in aliases
            if item["source_path"] == raw and _proof_covers(item, row_date)
        ),
        None,
    )
    if proof is not None:
        return proof["repository_identity"]
    return None


def _proof_covers(proof, row_date):
    return False
