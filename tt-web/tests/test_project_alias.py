import unittest
import hashlib

from aggregators import normalize_remote
from project_alias import (
    AliasProofError,
    ProjectAliasCollisionError,
    audit_project_collisions,
    canonical_project,
    make_alias_proof,
)


class ProjectAliasTests(unittest.TestCase):
    def test_remote_shaped_label_is_stable_without_current_alias_proof(self):
        self.assertEqual(
            canonical_project("github.com/owner/repo", {}),
            "github.com/owner/repo",
        )

    def test_current_remote_proof_does_not_rewrite_stale_remote_shaped_history(self):
        stale = "github.com/owner/old-name"
        self.assertEqual(
            canonical_project(
                stale,
                [self.proof("/Users/lindong/repo", "github.com/owner/new-name")],
            ),
            stale,
        )

    def test_current_alias_without_derived_row_lineage_keeps_original_bucket(self):
        raw = "/Users/lindong/research/repo"
        self.assertEqual(
            canonical_project(
                raw,
                [self.proof(raw, "github.com/owner/repo")],
                row_date="2026-08-04",
            ),
            "~/research/repo",
        )

    def test_known_home_prefixes_are_shortened(self):
        self.assertEqual(canonical_project("/Users/lindong/research/repo", {}), "~/research/repo")
        self.assertEqual(canonical_project("/home/lindong/research/repo", {}), "~/research/repo")

    def test_missing_alias_map_falls_back_to_home_normalization(self):
        self.assertEqual(canonical_project("/Users/lindong/repo", None), "~/repo")

    def test_non_path_value_is_unchanged(self):
        self.assertEqual(canonical_project("repo-from-statusline", {}), "repo-from-statusline")

    def test_aliases_do_not_leak_between_hosts(self):
        raw = "/Users/lindong/research/repo"
        aliases_by_host = {"macbook": [self.proof(raw, "github.com/owner/repo")], "macmini": []}

        self.assertEqual(
            canonical_project(
                raw, aliases_by_host["macbook"], row_date="2026-08-04"
            ),
            "~/research/repo",
        )
        self.assertEqual(canonical_project(raw, aliases_by_host["macmini"]), "~/research/repo")

    def test_slock_agent_uuids_remain_distinct_buckets(self):
        first = canonical_project("~/.slock/agents/11111111-1111-1111-1111-111111111111", {})
        second = canonical_project("~/.slock/agents/22222222-2222-2222-2222-222222222222", {})

        self.assertNotEqual(first, second)

    def test_cross_host_collision_is_not_waived_without_derived_row_lineage(self):
        projects = {
            "macbook": ["/Users/lindong/research/repo"],
            "gpu-box": ["/home/lindong/research/repo"],
        }
        aliases = {
            "macbook": [self.proof("/Users/lindong/research/repo", "github.com/owner/repo", "repo-v1:same")],
            "gpu-box": [self.proof("/home/lindong/research/repo", "github.com/owner/repo", "repo-v1:same")],
        }

        with self.assertRaises(ProjectAliasCollisionError):
            audit_project_collisions(
                projects,
                aliases,
                row_dates_by_host={
                    "macbook": {"/Users/lindong/research/repo": "2026-08-04"},
                    "gpu-box": {"/home/lindong/research/repo": "2026-08-04"},
                },
            )

    def test_matching_remote_shaped_labels_without_current_proof_fail_closed(self):
        projects = {
            "macbook": ["github.com/owner/repo"],
            "macmini": ["github.com/owner/repo"],
        }

        with self.assertRaises(ProjectAliasCollisionError):
            audit_project_collisions(projects, {})

    def test_matching_non_github_remote_proof_without_row_lineage_fails_closed(self):
        remote_inputs = (
            "git@gitlab.com:owner/repo.git",
            "ssh://git@codeberg.org/owner/repo.git",
            "https://github.enterprise.example/owner/repo.git",
        )
        for remote_input in remote_inputs:
            with self.subTest(remote_input=remote_input):
                remote = normalize_remote(remote_input)
                first_path = "/Users/lindong/repo"
                second_path = "/home/lindong/repo"
                projects = {"macbook": [first_path], "macmini": [second_path]}
                proof = {
                    "macbook": [self.proof(first_path, remote, "repo-v1:same")],
                    "macmini": [self.proof(second_path, remote, "repo-v1:same")],
                }

                with self.assertRaises(ProjectAliasCollisionError):
                    audit_project_collisions(
                        projects,
                        proof,
                        row_dates_by_host={
                            "macbook": {first_path: "2026-08-04"},
                            "macmini": {second_path: "2026-08-04"},
                        },
                    )

    def test_matching_stale_labels_fail_closed_when_current_proof_has_no_row_lineage(self):
        stale = normalize_remote("git@github.com:owner/old.git")
        current_a = normalize_remote("git@gitlab.com:owner/new-a.git")
        current_b = normalize_remote("ssh://git@codeberg.org/owner/new-b.git")
        projects = {"macbook": [stale], "macmini": [stale]}
        proof = {
            "macbook": [self.proof("/Users/lindong/repo", current_a, "repo-v1:a")],
            "macmini": [self.proof("/home/lindong/repo", current_b, "repo-v1:b")],
        }

        with self.assertRaises(ProjectAliasCollisionError):
            audit_project_collisions(projects, proof)

    def test_cross_host_collision_without_git_remote_proof_fails_closed(self):
        projects = {
            "macbook": ["/Users/lindong/research/repo"],
            "gpu-box": ["/home/lindong/research/repo"],
        }

        with self.assertRaises(ProjectAliasCollisionError) as raised:
            audit_project_collisions(projects, {})

        self.assertEqual(raised.exception.collisions[0].canonical, "~/research/repo")
        self.assertEqual(
            {(item.host, item.raw) for item in raised.exception.collisions[0].projects},
            {
                ("macbook", "/Users/lindong/research/repo"),
                ("gpu-box", "/home/lindong/research/repo"),
            },
        )

    def test_issue005_current_proof_does_not_rewrite_history_outside_its_source_path_lineage(self):
        stale_history = "github.com/owner/repo-a"
        current_source = "/srv/repointed"
        proof = self.proof(current_source, "github.com/owner/repo-b")

        self.assertEqual(canonical_project(stale_history, [proof]), stale_history)
        self.assertEqual(
            canonical_project(current_source, [proof], row_date="2026-08-03"),
            current_source,
        )
        self.assertEqual(
            canonical_project(current_source, [proof], row_date="2026-08-04"),
            current_source,
        )

    def test_issue005_alias_proof_requires_source_path_time_and_repository_identity(self):
        required = {
            "source_path": "/repo",
            "canonical_project": "github.com/owner/repo",
            "observed_at": "2026-08-04T12:00:00Z",
            "repository_identity": "repo-v1:" + "1" * 64,
            "covered_rows": [],
        }
        for missing in required:
            with self.subTest(missing=missing), self.assertRaises(AliasProofError):
                canonical_project("/repo", [{key: value for key, value in required.items() if key != missing}])

    def test_issue005_current_observation_cannot_self_declare_historical_coverage(self):
        with self.assertRaisesRegex(AliasProofError, "substantiate historical coverage"):
            make_alias_proof(
                source_path="/repo",
                canonical_project="github.com/owner/repo-b",
                observed_at="2026-08-04T12:00:00Z",
                repository_identity="repo-v1:" + "1" * 64,
                covered_rows=[
                    {
                        "date": "2020-01-02",
                        "agent_id": "codex",
                        "project": "/repo",
                        "model": "gpt-5",
                    }
                ],
            )

    @staticmethod
    def proof(source_path, canonical_project_value, repository_identity="repo-v1:stable"):
        if not re_fullmatch_repo_identity(repository_identity):
            repository_identity = "repo-v1:" + hashlib.sha256(repository_identity.encode()).hexdigest()
        return make_alias_proof(
            source_path=source_path,
            canonical_project=canonical_project_value,
            observed_at="2026-08-04T12:00:00Z",
            repository_identity=repository_identity,
            covered_rows=[],
        )


def re_fullmatch_repo_identity(value):
    return (
        isinstance(value, str)
        and value.startswith("repo-v1:")
        and len(value) == len("repo-v1:") + 64
        and all(character in "0123456789abcdef" for character in value[len("repo-v1:"):])
    )


if __name__ == "__main__":
    unittest.main()
