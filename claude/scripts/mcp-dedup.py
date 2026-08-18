#!/usr/bin/env python3
"""
MCP Deduplication Script for Claude Code.

Collects MCP server configs from all sources (user-scope, project-scope,
plugins, --mcp-config files), deduplicates by server name with a configurable
priority order, and outputs a single merged JSON config.

Priority (highest wins): user-scope > mcp-config > plugin > project

Usage:
    python3 mcp-dedup.py --output /tmp/merged.json
    python3 mcp-dedup.py --output /tmp/merged.json --extra-configs a.json b.json
    python3 mcp-dedup.py --dry-run
"""

import argparse
import json
import os
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Source labels (higher number = higher priority)
# ---------------------------------------------------------------------------
PRIORITY = {
    "project": 0,
    "plugin": 1,
    "mcp-config": 2,
    "user": 3,
}

# Retired server names are filtered at the final merge boundary so stale plugin
# registries or explicit config fragments cannot re-enable them.
RETIRED_MCP_SERVERS = {"prompts.chat"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_plugin_root(config: dict, install_path: str) -> dict:
    """Deep-replace ${CLAUDE_PLUGIN_ROOT} in string values."""
    raw = json.dumps(config)
    if "${CLAUDE_PLUGIN_ROOT}" in raw:
        raw = raw.replace("${CLAUDE_PLUGIN_ROOT}", install_path)
        return json.loads(raw)
    return config


def _parse_mcp_json(path: str) -> dict[str, dict]:
    """Parse an MCP JSON file, handling both standard and flat formats.

    Standard:  {"mcpServers": {"name": {config}}}
    Flat:      {"name": {config}}  (used by some plugins)
    """
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  [warn] Cannot read {path}: {exc}", file=sys.stderr)
        return {}

    if "mcpServers" in data:
        return dict(data["mcpServers"])

    # Flat format: every top-level key whose value is a dict with
    # 'command' or 'url' or 'type' is treated as an MCP server def.
    servers = {}
    for name, cfg in data.items():
        if isinstance(cfg, dict) and (
            "command" in cfg or "url" in cfg or "type" in cfg
        ):
            servers[name] = cfg
    return servers


# ---------------------------------------------------------------------------
# Collectors
# ---------------------------------------------------------------------------

def collect_user_scope() -> list[tuple[str, dict, str]]:
    """Return [(name, config, source_label), ...] from ~/.claude.json."""
    config_path = Path.home() / ".claude.json"
    if not config_path.exists():
        return []
    try:
        with open(config_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  [warn] Cannot read {config_path}: {exc}", file=sys.stderr)
        return []
    servers = data.get("mcpServers", {})
    return [(name, dict(cfg), "user") for name, cfg in servers.items()]


def collect_project_scope() -> list[tuple[str, dict, str]]:
    """Return MCP servers from .mcp.json in the current directory."""
    mcp_path = Path.cwd() / ".mcp.json"
    if not mcp_path.exists():
        return []
    servers = _parse_mcp_json(str(mcp_path))
    return [(name, cfg, "project") for name, cfg in servers.items()]


def _load_enabled_plugins() -> dict[str, bool]:
    """Load enabledPlugins from settings.json."""
    settings_path = Path.home() / ".claude" / "settings.json"
    if not settings_path.exists():
        return {}
    try:
        with open(settings_path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data.get("enabledPlugins", {})


def collect_plugins() -> list[tuple[str, dict, str]]:
    """Return MCP servers from all installed user-scope plugins.

    Respects enabledPlugins in settings.json — disabled plugins are skipped.
    """
    plugins_json = Path.home() / ".claude" / "plugins" / "installed_plugins.json"
    if not plugins_json.exists():
        return []
    try:
        with open(plugins_json) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"  [warn] Cannot read {plugins_json}: {exc}", file=sys.stderr)
        return []

    enabled_plugins = _load_enabled_plugins()

    results = []
    for plugin_key, entries in data.get("plugins", {}).items():
        # Skip plugins explicitly disabled in settings.json
        if enabled_plugins.get(plugin_key) is False:
            continue
        for entry in entries:
            # Only include user-scope plugins
            if entry.get("scope") != "user":
                continue
            install_path = entry.get("installPath", "")
            if not install_path:
                continue
            mcp_file = os.path.join(install_path, ".mcp.json")
            if not os.path.isfile(mcp_file):
                continue
            servers = _parse_mcp_json(mcp_file)
            for name, cfg in servers.items():
                resolved = _resolve_plugin_root(cfg, install_path)
                results.append((name, resolved, "plugin"))
    return results


def collect_extra_configs(paths: list[str]) -> list[tuple[str, dict, str]]:
    """Return MCP servers from explicit --mcp-config files."""
    results = []
    for p in paths:
        expanded = os.path.expanduser(p)
        if not os.path.isfile(expanded):
            print(f"  [warn] --mcp-config file not found: {p}", file=sys.stderr)
            continue
        servers = _parse_mcp_json(expanded)
        for name, cfg in servers.items():
            results.append((name, cfg, "mcp-config"))
    return results


# ---------------------------------------------------------------------------
# Merge & Dedup
# ---------------------------------------------------------------------------

def merge_servers(
    all_entries: list[tuple[str, dict, str]],
) -> tuple[dict[str, dict], dict[str, list[str]]]:
    """Merge MCP servers, keeping the highest-priority entry per name.

    Returns:
        merged: {name: config}
        dedup_log: {name: [source_labels_that_were_seen]}
    """
    # Track all sources seen per name
    seen: dict[str, list[tuple[int, dict, str]]] = {}
    for name, cfg, source in all_entries:
        if name in RETIRED_MCP_SERVERS:
            continue
        prio = PRIORITY.get(source, -1)
        seen.setdefault(name, []).append((prio, cfg, source))

    merged = {}
    dedup_log = {}
    for name, entries in seen.items():
        entries.sort(key=lambda x: x[0], reverse=True)
        winner_prio, winner_cfg, winner_source = entries[0]
        merged[name] = winner_cfg
        all_sources = [src for _, _, src in entries]
        if len(entries) > 1:
            dedup_log[name] = all_sources

    return merged, dedup_log


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="MCP deduplication for Claude Code")
    parser.add_argument("--output", "-o", help="Output file path (default: stdout)")
    parser.add_argument(
        "--extra-configs", nargs="*", default=[],
        help="Additional --mcp-config files to include",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print merged config and stats to stderr, don't write output file",
    )
    args = parser.parse_args()

    # Collect from all sources
    all_entries = []
    all_entries.extend(collect_user_scope())
    all_entries.extend(collect_project_scope())
    all_entries.extend(collect_plugins())
    all_entries.extend(collect_extra_configs(args.extra_configs))

    # Merge
    merged, dedup_log = merge_servers(all_entries)

    # Stats
    total_before = len(all_entries)
    total_after = len(merged)
    duplicates = len(dedup_log)

    print(f"MCP dedup: {total_before} entries → {total_after} unique "
          f"({duplicates} deduplicated)", file=sys.stderr)
    for name, sources in dedup_log.items():
        winner = sources[0]
        losers = sources[1:]
        print(f"  {name}: kept [{winner}], removed [{', '.join(losers)}]",
              file=sys.stderr)

    output = {"mcpServers": merged}

    if args.dry_run:
        json.dump(output, sys.stderr, indent=2)
        print(file=sys.stderr)
        return

    if args.output:
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2)
    else:
        json.dump(output, sys.stdout, indent=2)
        print()


if __name__ == "__main__":
    main()
