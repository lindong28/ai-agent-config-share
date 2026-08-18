---
allowed-tools: Bash, Read
description: 定位 Claude Code session UUID 以便 resume——用户描述记忆中的某段对话
---

# Find Claude Session

用户描述"我之前在哪个 session 讨论过 X / 做过 Y"——根据描述定位 Claude Code session UUID 让用户在 terminal `claude --resume` 续上。

从 `$ARGUMENTS` 抽 **2–4 个有区分度的关键词**，用现成脚本：

```
~/.claude/scripts/find-claude-session.sh <kw1> <kw2> [<kw3> ...]
```

脚本做 3 段收敛：(1) 任一关键词 → (2) 全部关键词 AND → (3) 提取 user-prompt 命中预览。

| 关键词启发 | 说明 |
|---|---|
| 跟随用户的语言 | 中文则抽中文，英文抽英文。混合时两版本都试——JSONL 里 user 提问常中文、LLM 回复常英文，命中位置不同 |
| 优先专有名词 / 文件名 / 代码符号 | "summarize-article"、"text-embedding-3-small" 这类高区分度词 |
| 避免高频通用词 | "代码"、"问题"、"改进" 收敛能力差 |
| 短语 > 单字 | "下沉到 python" 比 "下沉" 精确 |
| 必含特定 entity | 用户提到具体 skill 名 / 命令 / 路径时必须包含 |

**关键词 quote**：含空格 / 中文 / 特殊字符（`[` `*` `?` 等）的关键词用双引号，避免 zsh glob 解析。

脚本 stderr sentinel：

| Sentinel | 应对 |
|---|---|
| `NO_HISTORY` | 当前 cwd 不在 Claude 历史中——提示 cd 到对应 project |
| `NO_MATCH` | 换关键词；中文搜不到试英文（反之亦然） |
| `PARTIAL_MATCH` | 列出 partial-match UUID，建议去掉最弱关键词重试 |

## 输出契约

| 列 | 内容 |
|---|---|
| Session # | 候选编号（带 ⭐ 标注推荐 top 1） |
| UUID | session 文件 stem |
| 时间 | MTIME + 关键事件 timestamp |
| 命中证据 | user prompt 命中预览 |
| Resume 命令 | `claude --resume <uuid>` |

**多候选推荐**：综合 (a) 命中证据强度、(b) MTIME 与时间窗、(c) 与原始描述吻合度，挑一个标 ⭐ 并 1 句话说理由。**展示全部，不替用户决定**。

**排除当前 session**：MTIME "刚刚" + 命中只在 tool output / Bash 命令里出现 → 几乎一定是当前活跃 session。明确告知"已识别为当前 session"但仍列出。

## 已知限制

- `claude --resume` 必须用户在 terminal 自己跑——不能在当前 session 内"切换"
- 完全基于原生 JSONL grep / parse，不依赖 chroma / claude-mem 索引
- 跨 project 搜索需遍历 `~/.claude/projects/*/`，开销随 project 数线性增长，默认不启用
