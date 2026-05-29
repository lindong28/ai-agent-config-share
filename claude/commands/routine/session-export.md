---
disable-model-invocation: true
---

# session-export

将当前 Claude Code session 打包为可跨机器迁移的 tar.gz 压缩包。在目标机器上用 `/routine:session-import` 导入后可 `claude --resume` 恢复对话。

## 参数

`/routine:session-export [session-id]`

- 无参数：导出当前 session（从 `$CLAUDE_CODE_SESSION_ID` 获取）
- 指定 session-id：导出历史 session

## 数据位置与结构

Session 数据存储在 `~/.claude/projects/<path-hash>/`，其中 path-hash = `pwd | tr '/' '-'`。注意：此路径规则基于观测，非官方契约，Claude Code 版本升级后如果路径不匹配需要动态发现。

每个 session 包含：
- `<session-id>.jsonl` — 主对话记录（必需）
- `<session-id>/` — 子目录，含 subagents/*.jsonl、tool-results/*（可选，存在则包含）
- `memory/` — 项目级持久记忆（可选，存在且非空则包含）

## 压缩包结构

```
session-<id-prefix-8>.tar.gz
├── manifest.json          # 元数据
├── session.jsonl           # 主对话
├── session/                # 子目录（如有）
│   ├── subagents/
│   └── tool-results/
└── memory/                 # 项目记忆（如有）
```

manifest.json 包含：source_path（源项目绝对路径）、session_id、export_time、included_components（列出包含了哪些可选组件）。

## 输出

压缩包默认写到当前工作目录。完成后打印：
- 压缩包路径和大小
- 包含的组件列表
- 目标机器上的导入命令提示
