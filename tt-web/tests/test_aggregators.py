import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from aggregators import extract_dim, identify_project, normalize_remote, pivot
from parsers import UsageEntry


class AggregatorTests(unittest.TestCase):
    def setUp(self):
        base = datetime(2026, 5, 19, 8, 0, tzinfo=timezone.utc)
        self.entries = [
            self.entry(base, "s1", "repo-a", "claude-opus-4-7", "claude-code", 1.0, 100, 20, 5, 10, 1),
            self.entry(base + timedelta(hours=2), "s2", "repo-b", "gpt-5", "codex", 2.0, 50, 30, 7, 0, 3),
            self.entry(base + timedelta(days=1), "s3", "repo-a", "claude-sonnet-4-6", "claude-code", 3.0, 70, 10, 0, 4, 2),
            self.entry(base + timedelta(days=8), "s4", "repo-c", "fake-model-xyz", "claude-code", None, 10, 1, 0, 0, 1),
        ]

    def test_pivot_day_group_none_cost(self):
        result = pivot(self.entries, "day", "none", "cost")
        self.assertEqual(result["columns"], ["value"])
        self.assertEqual(result["rows"][0]["values"]["value"], 3.0)

    def test_pivot_day_group_project_input(self):
        result = pivot(self.entries, "day", "project", "input")
        row = result["rows"][0]
        self.assertEqual(set(result["columns"]), {"repo-a", "repo-b", "repo-c"})
        self.assertEqual(row["values"]["repo-a"], 100)
        self.assertEqual(row["values"]["repo-b"], 50)

    def test_pivot_project_group_model_output(self):
        result = pivot(self.entries, "project", "model", "output")
        repo_a = next(row for row in result["rows"] if row["x"] == "repo-a")
        self.assertEqual(repo_a["values"]["claude-opus-4-7"], 20)
        self.assertEqual(repo_a["values"]["claude-sonnet-4-6"], 10)

    def test_pivot_model_group_none_cache_read(self):
        result = pivot(self.entries, "model", "none", "cache_read")
        row = next(row for row in result["rows"] if row["x"] == "gpt-5")
        self.assertEqual(row["values"]["value"], 7)

    def test_pivot_agent_group_project_cache_creation(self):
        result = pivot(self.entries, "agent", "project", "cache_creation")
        claude = next(row for row in result["rows"] if row["x"] == "claude-code")
        self.assertEqual(claude["values"]["repo-a"], 14)

    def test_pivot_metric_total_and_messages(self):
        total = pivot(self.entries, "project", "none", "total")
        messages = pivot(self.entries, "project", "none", "messages")
        repo_a_total = next(row for row in total["rows"] if row["x"] == "repo-a")
        repo_a_messages = next(row for row in messages["rows"] if row["x"] == "repo-a")
        self.assertEqual(repo_a_total["values"]["value"], 219)
        self.assertEqual(repo_a_messages["values"]["value"], 3)

    def test_filters_and_time_range_are_applied_before_pivot(self):
        start = self.entries[0].timestamp
        end = start + timedelta(days=2)
        result = pivot(
            self.entries,
            "day",
            "agent",
            "cost",
            agents={"claude-code"},
            projects={"repo-a"},
            time_range=(start, end),
        )
        self.assertEqual(len(result["rows"]), 2)
        self.assertEqual(result["columns"], ["claude-code"])

    def test_extract_dim_local_day_and_month_boundaries(self):
        ts = datetime(2026, 4, 30, 23, 30, tzinfo=timezone.utc)
        entry = self.entry(ts, "s5", "repo-z", "gpt-5", "codex", 1.0, 1, 1, 0, 0, 1)
        self.assertEqual(extract_dim(entry, "day"), ts.astimezone().date().isoformat())
        self.assertEqual(extract_dim(entry, "month"), ts.astimezone().strftime("%Y-%m"))

    def test_identify_project_prefers_normalized_remote(self):
        cache = {}
        completed = mock.Mock(returncode=0, stdout="git@github.com:owner/repo.git\n")
        with mock.patch("subprocess.run", return_value=completed):
            self.assertEqual(identify_project("/tmp/repo", cache), "github.com/owner/repo")
        self.assertEqual(cache["/tmp/repo"], "github.com/owner/repo")

    def test_normalize_remote_handles_https_and_ssh(self):
        self.assertEqual(normalize_remote("https://github.com/owner/repo.git"), "github.com/owner/repo")
        self.assertEqual(normalize_remote("git@github.com:owner/repo.git"), "github.com/owner/repo")

    @staticmethod
    def entry(ts, sid, project, model, agent, cost, input_tokens, output_tokens, cache_read, cache_creation, messages):
        return UsageEntry(
            timestamp=ts,
            session_id=sid,
            message_id=f"{sid}-msg",
            request_id=f"{sid}-req",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cache_creation_tokens=cache_creation,
            cache_read_tokens=cache_read,
            cost_usd=cost,
            project=project,
            agent_id=agent,
            message_count=messages,
        )


if __name__ == "__main__":
    unittest.main()
