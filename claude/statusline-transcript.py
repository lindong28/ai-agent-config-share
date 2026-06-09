#!/usr/bin/env python3
"""Parse Claude Code transcript JSONL, output compact JSON summary for statusline.

Parses the full transcript (whole session). Uses mtime+size disk cache to skip
re-parsing when the file hasn't changed (same strategy as claude-hud).

Output:
{
  "tools_running": [{"name":"Edit","target":"foo.ts"}],
  "tools_completed": {"Read":3,"Bash":2},
  "agents": [{"type":"explore","model":"haiku","desc":"...","status":"running","elapsed_s":45}],
  "skills": [{"name":"tdd","status":"running"}]
}
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path

CACHE_DIR = Path.home() / ".claude" / "statusline-cache"
CACHE_KEEP_N = 200        # max parse-result cache files to retain (self-eviction)
CACHE_EVICT_BATCH = 500   # max files to unlink per run (bounds first-run drain cost)
SKIP_TOOLS = frozenset(("TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList"))
_KNOWLEDGE_MARKERS = ("/skills/", "/agents/")


def main() -> None:
    transcript_path = sys.argv[1] if len(sys.argv) > 1 else None
    if not transcript_path or not os.path.isfile(transcript_path):
        print("{}")
        return

    # ── Cache check (mtime + size, matching claude-hud strategy) ──
    try:
        st = os.stat(transcript_path)
        cache_key = f"{os.path.abspath(transcript_path)}:{st.st_mtime_ns}:{st.st_size}"
        cache_hash = hashlib.sha256(cache_key.encode()).hexdigest()[:16]
        cache_file = CACHE_DIR / f"{cache_hash}.json"

        if cache_file.is_file():
            cached = json.loads(cache_file.read_text())
            if cached.get("_key") == cache_key:
                del cached["_key"]
                print(json.dumps(cached, ensure_ascii=False))
                return
    except Exception:
        cache_key = ""
        cache_file = None  # type: ignore[assignment]

    # ── Full parse ──
    tool_map: dict[str, dict] = {}
    agent_map: dict[str, dict] = {}
    skill_list: list[dict] = []
    todos: list[dict] = []  # [{content, status}]
    task_id_to_index: dict[str, int] = {}  # taskId -> index in todos
    session_tokens: dict[str, int] = {
        "in": 0,
        "out": 0,
        "cache_creation": 0,
        "cache_read": 0,
    }
    session_start_ts: float | None = None
    now = time.time()

    try:
        with open(transcript_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Cumulative token usage from assistant messages (full session).
                if entry.get("type") == "assistant":
                    usage = (entry.get("message") or {}).get("usage") or {}
                    session_tokens["in"] += _safe_int(usage.get("input_tokens"))
                    session_tokens["out"] += _safe_int(usage.get("output_tokens"))
                    session_tokens["cache_creation"] += _safe_int(
                        usage.get("cache_creation_input_tokens")
                    )
                    session_tokens["cache_read"] += _safe_int(
                        usage.get("cache_read_input_tokens")
                    )

                ts_str = entry.get("timestamp")
                ts = _parse_ts(ts_str) if ts_str else now
                if session_start_ts is None and ts_str:
                    session_start_ts = ts
                content = (entry.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue

                for block in content:
                    btype = block.get("type")
                    bid = block.get("id")
                    bname = block.get("name")

                    if btype == "tool_use" and bid and bname:
                        binput = block.get("input") or {}

                        if bname == "Skill":
                            skill_list.append(
                                {
                                    "name": binput.get("skill", "?"),
                                    "status": "running",
                                    "id": bid,
                                }
                            )
                        elif bname == "Read":
                            fpath = binput.get("file_path", "")
                            fname = os.path.basename(fpath)
                            if any(
                                m in fpath for m in _KNOWLEDGE_MARKERS
                            ) and fpath.endswith(".md"):
                                kname = (
                                    os.path.basename(os.path.dirname(fpath))
                                    if fname == "SKILL.md"
                                    else os.path.splitext(fname)[0]
                                )
                                skill_list.append(
                                    {"name": kname, "status": "running", "id": bid}
                                )
                            tool_map[bid] = {
                                "name": bname,
                                "target": _extract_target(bname, binput),
                                "status": "running",
                                "start_ts": ts,
                            }
                        elif bname in ("Agent", "Task"):
                            agent_map[bid] = {
                                "type": binput.get("subagent_type", "unknown"),
                                "model": binput.get("model"),
                                "desc": _trunc(binput.get("description", ""), 40),
                                "status": "running",
                                "start_ts": ts,
                            }
                        elif bname == "TodoWrite":
                            items = binput.get("todos")
                            if isinstance(items, list):
                                todos.clear()
                                task_id_to_index.clear()
                                for item in items:
                                    todos.append(
                                        {
                                            "content": item.get("content", ""),
                                            "status": item.get("status", "pending"),
                                        }
                                    )
                        elif bname == "TaskCreate":
                            subject = binput.get("subject", "") or ""
                            desc = binput.get("description", "") or ""
                            content = subject or desc or "Untitled task"
                            status = (
                                _normalize_task_status(binput.get("status"))
                                or "pending"
                            )
                            todos.append({"content": content, "status": status})
                            tid = str(binput.get("taskId", bid))
                            task_id_to_index[tid] = len(todos) - 1
                        elif bname == "TaskUpdate":
                            tid = str(binput.get("taskId", ""))
                            idx = task_id_to_index.get(tid)
                            if idx is None and tid.isdigit():
                                ni = int(tid) - 1
                                if 0 <= ni < len(todos):
                                    idx = ni
                            if idx is not None and idx < len(todos):
                                new_status = _normalize_task_status(
                                    binput.get("status")
                                )
                                if new_status:
                                    todos[idx]["status"] = new_status
                                new_content = binput.get("subject", "") or binput.get(
                                    "description", ""
                                )
                                if new_content:
                                    todos[idx]["content"] = new_content
                        elif bname not in SKIP_TOOLS:
                            tool_map[bid] = {
                                "name": bname,
                                "target": _extract_target(bname, binput),
                                "status": "running",
                                "start_ts": ts,
                            }

                    elif btype == "tool_result":
                        tuid = block.get("tool_use_id")
                        is_error = block.get("is_error", False)
                        if tuid and tuid in tool_map:
                            tool_map[tuid]["status"] = (
                                "error" if is_error else "completed"
                            )
                        if tuid and tuid in agent_map:
                            agent_map[tuid]["status"] = "completed"
                            agent_map[tuid]["end_ts"] = ts
                        for s in skill_list:
                            if s["id"] == tuid:
                                s["status"] = "completed"
    except (FileNotFoundError, PermissionError):
        print("{}")
        return

    # ── Build output (matching claude-hud limits: 20 tools, 10 agents) ──
    tools = list(tool_map.values())[-20:]

    running_tools = [
        {"name": t["name"], "target": t["target"]}
        for t in tools
        if t["status"] == "running"
    ][-2:]

    completed_counts: dict[str, int] = {}
    for t in tools:
        if t["status"] in ("completed", "error"):
            completed_counts[t["name"]] = completed_counts.get(t["name"], 0) + 1
    # Full session counts from all tools (not just last 20)
    completed_counts_full: dict[str, int] = {}
    for t in tool_map.values():
        if t["status"] in ("completed", "error"):
            completed_counts_full[t["name"]] = (
                completed_counts_full.get(t["name"], 0) + 1
            )
    top_completed = sorted(completed_counts_full.items(), key=lambda x: -x[1])[:4]

    agents = list(agent_map.values())[-10:]
    running_agents = [a for a in agents if a["status"] == "running"]
    completed_agents = [a for a in agents if a["status"] == "completed"][-2:]
    agents_out = []
    for a in (running_agents + completed_agents)[-3:]:
        elapsed = max(0, int(a.get("end_ts", now) - a["start_ts"]))
        agents_out.append(
            {
                "type": a["type"],
                "model": a.get("model"),
                "desc": a["desc"],
                "status": a["status"],
                "elapsed_s": elapsed,
            }
        )

    # Skills: running ones shown individually, completed ones deduplicated with counts
    skills_running = [
        {"name": s["name"], "status": "running"}
        for s in skill_list
        if s["status"] == "running"
    ]
    skill_counts: dict[str, int] = {}
    for s in skill_list:
        if s["status"] != "running":
            skill_counts[s["name"]] = skill_counts.get(s["name"], 0) + 1
    skills_completed = [
        {"name": name, "status": "completed", "count": count}
        for name, count in sorted(skill_counts.items(), key=lambda x: -x[1])
    ]
    skills_out = skills_running + skills_completed

    # Todos: matching claude-hud — find in_progress item, count completed/total
    todos_out = None
    if todos:
        completed_todos = sum(1 for t in todos if t["status"] == "completed")
        total_todos = len(todos)
        in_progress = next((t for t in todos if t["status"] == "in_progress"), None)
        if in_progress:
            content = in_progress["content"]
            if len(content) > 50:
                content = content[:47] + "..."
            todos_out = {
                "content": content,
                "completed": completed_todos,
                "total": total_todos,
            }
        elif completed_todos == total_todos and total_todos > 0:
            todos_out = {
                "content": None,
                "completed": completed_todos,
                "total": total_todos,
            }

    result = {
        "tools_running": running_tools,
        "tools_completed": dict(top_completed),
        "agents": agents_out,
        "skills": skills_out,
        "todos": todos_out,
        "session_tokens": session_tokens,
        "session_start_ts": session_start_ts,
    }

    # ── Write cache ──
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache_payload = {**result, "_key": cache_key}
        cache_file.write_text(json.dumps(cache_payload, ensure_ascii=False))  # type: ignore[union-attr]
    except Exception:
        pass

    # ── Evict stale cache (bounded, self-capping) ──
    # cache_key embeds the transcript mtime+size, so every edit births a new hash
    # file and orphans the prior one — unchecked this grew to 36k files. Keep only
    # the most-recent CACHE_KEEP_N (never .speed.json, which statusline.sh owns);
    # cap deletions/run so the first pass over a large backlog can't stall a render.
    try:
        entries = [p for p in CACHE_DIR.glob("*.json") if p.name != ".speed.json"]
        if len(entries) > CACHE_KEEP_N:
            entries.sort(key=lambda p: p.stat().st_mtime)
            for p in entries[: min(len(entries) - CACHE_KEEP_N, CACHE_EVICT_BATCH)]:
                p.unlink(missing_ok=True)
    except Exception:
        pass

    print(json.dumps(result, ensure_ascii=False))


def _normalize_task_status(status: object) -> str | None:
    if not isinstance(status, str):
        return None
    return {
        "pending": "pending",
        "not_started": "pending",
        "in_progress": "in_progress",
        "running": "in_progress",
        "completed": "completed",
        "complete": "completed",
        "done": "completed",
    }.get(status)


def _extract_target(name: str, inp: dict) -> str | None:
    if name in ("Read", "Write", "Edit"):
        path = inp.get("file_path") or inp.get("path") or ""
        if "/" in path:
            return ".../" + path.rsplit("/", 1)[-1]
        return path or None
    if name in ("Glob", "Grep"):
        return _trunc(inp.get("pattern", ""), 20) or None
    if name == "Bash":
        cmd = inp.get("command", "")
        return _trunc(cmd, 25) or None
    return None


def _trunc(s: str, n: int) -> str:
    return s[: n - 3] + "..." if len(s) > n else s


def _safe_int(v: object) -> int:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else 0


def _parse_ts(ts_str: str) -> float:
    try:
        from datetime import datetime, timezone

        s = ts_str.rstrip("Z")
        if "+" in s[10:]:
            s = s[: s.index("+", 10)]
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()
    except Exception:
        return time.time()


if __name__ == "__main__":
    main()
