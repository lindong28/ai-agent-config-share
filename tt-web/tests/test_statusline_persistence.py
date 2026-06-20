import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from parsers import claude_status


class StatuslinePersistenceTests(unittest.TestCase):
    def test_missing_rate_limits_preserves_existing_and_present_rate_limits_refresh(self):
        script = Path(__file__).resolve().parents[2] / "claude" / "statusline.sh"
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            claude_dir = home / ".claude"
            claude_dir.mkdir()
            status_file = claude_dir / "tt-status.json"
            original_limits = {
                "five_hour": {"used_percentage": 12.5, "resets_at": 4102444800},
                "seven_day": {"used_percentage": 34, "resets_at": 4102448400},
            }
            status_file.write_text(
                json.dumps(
                    {
                        "_received_at": "2026-06-01T00:00:00+00:00",
                        "model": {"id": "claude-opus-4-7"},
                        "rate_limits": original_limits,
                    }
                ),
                encoding="utf-8",
            )

            self.run_statusline(
                script,
                home,
                {
                    "workspace": {"project_dir": str(Path.cwd())},
                    "model": {"id": "glm-5.2[1m]", "display_name": "glm-5.2[1m]"},
                    "context_window": {"used_percentage": 1},
                    "cost": {"total_cost_usd": 0},
                },
            )
            after_glm = json.loads(status_file.read_text(encoding="utf-8"))

            self.assertEqual(after_glm["rate_limits"], original_limits)
            self.assertEqual(after_glm["model"]["id"], "glm-5.2[1m]")
            preserved = claude_status.load_rate_limits(status_file)
            self.assertIsNotNone(preserved)
            self.assertEqual(preserved.five_hour_pct, 12.5)
            self.assertEqual(preserved.seven_day_pct, 34)

            refreshed_limits = {
                "five_hour": {"used_percentage": 56, "resets_at": 4102452000},
                "seven_day": {"used_percentage": 78.5, "resets_at": 4102538400},
            }
            self.run_statusline(
                script,
                home,
                {
                    "workspace": {"project_dir": str(Path.cwd())},
                    "model": {"id": "claude-opus-4-7", "display_name": "Claude Opus 4.7"},
                    "rate_limits": refreshed_limits,
                    "context_window": {"used_percentage": 1},
                    "cost": {"total_cost_usd": 0},
                },
            )
            after_claude = json.loads(status_file.read_text(encoding="utf-8"))

            self.assertEqual(after_claude["rate_limits"], refreshed_limits)
            refreshed = claude_status.load_rate_limits(status_file)
            self.assertEqual(refreshed.five_hour_pct, 56)
            self.assertEqual(refreshed.seven_day_pct, 78.5)

    @staticmethod
    def run_statusline(script: Path, home: Path, payload: dict) -> None:
        env = os.environ.copy()
        env["HOME"] = str(home)
        result = subprocess.run(
            ["bash", str(script)],
            input=json.dumps(payload),
            capture_output=True,
            env=env,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            raise AssertionError(
                "statusline.sh failed with code %s\nstdout=%s\nstderr=%s"
                % (result.returncode, result.stdout, result.stderr)
            )


if __name__ == "__main__":
    unittest.main()
