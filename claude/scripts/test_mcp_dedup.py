#!/usr/bin/env python3

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).with_name("mcp-dedup.py")
SPEC = importlib.util.spec_from_file_location("mcp_dedup", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
MCP_DEDUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MCP_DEDUP)


class RetiredMcpServerTest(unittest.TestCase):
    def test_stale_prompts_plugin_is_filtered_without_changing_absent_plugin_semantics(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            home = Path(tmp_dir)
            claude_dir = home / ".claude"
            plugins_dir = claude_dir / "plugins"
            prompts_install = home / "plugins-cache" / "prompts"
            control_install = home / "plugins-cache" / "control"
            plugins_dir.mkdir(parents=True)
            prompts_install.mkdir(parents=True)
            control_install.mkdir(parents=True)

            (claude_dir / "settings.json").write_text(
                json.dumps({"enabledPlugins": {}}), encoding="utf-8"
            )
            (plugins_dir / "installed_plugins.json").write_text(
                json.dumps(
                    {
                        "plugins": {
                            "prompts.chat@prompts.chat": [
                                {"scope": "user", "installPath": str(prompts_install)}
                            ],
                            "control@example": [
                                {"scope": "user", "installPath": str(control_install)}
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )
            (prompts_install / ".mcp.json").write_text(
                json.dumps({"prompts.chat": {"url": "https://prompts.chat/api/mcp"}}),
                encoding="utf-8",
            )
            (control_install / ".mcp.json").write_text(
                json.dumps({"control": {"url": "https://example.test/mcp"}}),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"HOME": str(home)}):
                collected = MCP_DEDUP.collect_plugins()
                merged, _ = MCP_DEDUP.merge_servers(collected)

            self.assertIn("prompts.chat", {name for name, _, _ in collected})
            self.assertNotIn("prompts.chat", merged)
            self.assertIn("control", merged)


if __name__ == "__main__":
    unittest.main()
