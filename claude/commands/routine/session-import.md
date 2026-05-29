---
disable-model-invocation: true
---

# session-import

从 session-export 产出的 tar.gz 压缩包中恢复 Claude Code session 到当前项目目录。

## 参数

`/routine:session-import <archive-path>`

archive-path 为 session-export 产出的 tar.gz 文件路径（必需）。

## 导入逻辑

1. **解压并读取 manifest.json** — 获取 session_id 和包含的组件列表
2. **确定目标目录** — 根据当前 CWD 计算 path-hash（`pwd | tr '/' '-'`），目标为 `~/.claude/projects/<path-hash>/`。若目标目录不存在则创建。注意：此路径规则基于观测，非官方契约，如不匹配需动态发现实际目录
3. **冲突检测** — 若目标目录下已存在同名 session-id.jsonl，用 `AskUserQuestion` 确认覆盖还是跳过
4. **放置文件**：
   - `session.jsonl` → `<target-dir>/<session-id>.jsonl`
   - `session/` → `<target-dir>/<session-id>/`
   - `memory/` — 逐文件合并到 `<target-dir>/memory/`。本地已存在且内容不同的文件，用 `AskUserQuestion` 让用户选择保留本地版本还是导入版本

## 输出

完成后打印：
- 导入的 session ID
- 恢复命令：`claude --resume <session-id>`
- 如有 memory 文件被跳过，列出跳过的文件名
