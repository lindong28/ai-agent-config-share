---
name: create-commit
description: >-
  Use when the user asks to create a new commit, 提交改动, 创建新 commit, or
  将改动添加到新 commit. Analyzes working tree, reviews untracked files for
  git-worthiness, generates a commit message, and creates the commit after
  user confirmation. Does not handle amending existing commits.
---

# Create Commit

审查 working tree 改动、生成 commit message、用户确认后执行 commit。

## 流程

1. **了解当前状态**：`git status --short`、`git diff --stat`、`git log --oneline -5`。读核心 diff 理解改动性质。

2. **审查 untracked 文件**：对每个 `??`（untracked）文件判断是否该被 git track。已 tracked 文件的修改默认全部包含。

   **判断 lens**：内容可从外部来源复现、或生命周期局限于单次 session 的文件通常不该 track。常见类型：
   - 第三方文档 / vendor 快照（记 URL + 版本号即可）
   - Session 过程日志（洞察应已提炼到持久文件如 issues）
   - Cache / 临时目录（.cache/、node_modules/）
   - Secrets / credentials

   判断不确定时用 `AskUserQuestion` 确认；无法 ask 时倾向包含。

3. **生成 commit message**：格式见下方。

4. **执行**：stage 文件 → `git commit`。优先 `git add <specific files>` 而非 `git add -A`。

## Commit Message 格式

| 场景 | Subject | Body |
|------|---------|------|
| 单改动，无 notable detail | `<type>(scope): <desc>` | 无 |
| 单改动，有 notable detail | `<type>(scope): <desc>` | detail 作为 bullets |
| 多改动 | 自由文本总结 | 每个改动一条 `<type>(scope): <desc>` bullet |

- Subject ≤72 chars；description 用英文
- Types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci` `style` `build`
- Body 仅在 subject + diff 不足以让 reviewer 推出非显然设计决策时加
- Per-bullet derivability test：每条候选 bullet 自问「reviewer 能从 subject + diff 推出来吗」，能 → drop
- 不附 Co-Authored-By
- 用 heredoc 传递 body（`git commit -m "$(cat <<'EOF' ... EOF)"`）
