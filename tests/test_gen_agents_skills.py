from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).parents[1] / "codex" / "bin" / "gen-agents-skills.py"
SYSTEM_PATH = "/usr/bin:/bin"


class GenAgentsSkillsCompatibilityTest(unittest.TestCase):
    @unittest.skipUnless(
        shutil.which("python3", path=SYSTEM_PATH), "system python3 is unavailable"
    )
    def test_runs_with_system_python(self):
        with tempfile.TemporaryDirectory() as home:
            result = subprocess.run(
                ["python3", str(SCRIPT)],
                env={**os.environ, "HOME": home, "PATH": SYSTEM_PATH},
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            skill = Path(home) / ".agents" / "skills" / "create-commit"
            self.assertTrue(skill.is_symlink())
            self.assertTrue(skill.resolve().is_dir())
            self.assertTrue((skill / "SKILL.md").is_file())


if __name__ == "__main__":
    unittest.main()
