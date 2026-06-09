---
name: create-commit
description: >-
  Create a git commit from working-tree changes — reviews the diff
  and untracked files, drafts a conventional commit message, confirms,
  then commits. Use when the user asks to commit (提交改动 / commit this),
  or a command needs to commit on the user's behalf. Does not amend
  existing commits.
---

# Create Commit

审查 working tree 改动、生成 commit message、确认后执行 commit。

## 流程

1. **了解当前状态**：`git branch --show-current`、`git status --short`、`git diff --stat`、`git log --oneline -5`。读核心 diff 理解改动性质。

2. **决定 staging 范围**：

   | 来源 | 范围 |
   |---|---|
   | **Default**（用户直接调 skill 无额外说明） | 已 tracked 文件的所有修改 + 经下方 lens 筛选过的 untracked 文件 |
   | **User override**（用户调用时给出额外说明） | 按用户说明（如"只 stage X 和 Y"、"不要包含 Z"），优先于 default |
   | **Caller override**（上层 command / skill 在 prompt 里指定 scope） | 按 caller 指定，优先于 default；和 user override 同时存在时 caller 描述应自洽，不一致先停下问用户 |

   **Untracked 判断 lens**（仅在 default 模式下应用）：内容可从外部来源复现、或生命周期局限于单次 session 的文件通常不该 track。常见类型：
   - 第三方文档 / vendor 快照（记 URL + 版本号即可）
   - Session 过程日志（洞察应已提炼到持久文件如 issues）
   - Cache / 临时目录（.cache/、node_modules/）
   - Secrets / credentials

   判断不确定时用 `AskUserQuestion` 确认；无法 ask 时倾向包含。

3. **生成 commit message**：格式见下方。

4. **执行**：用 `git add <specific files>` stage 第 2 步选定的范围（**禁止** `git add -A` / `git add .`），然后 `git commit`。

## Commit Message 格式

| 场景 | Subject | Body |
|------|---------|------|
| 单改动，无 notable detail | `<type>(scope): <desc>` | 无 |
| 单改动，有 notable detail | `<type>(scope): <desc>` | detail 作为 bullets |
| 多改动 | 自由文本总结 | 每个改动一条 `<type>(scope): <desc>` bullet |

- Subject ≤72 chars；description 用英文
- Types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci` `style` `build` `revert`
- Body 仅在 subject + diff 不足以让 reviewer 推出非显然设计决策时加
- Per-bullet derivability test：每条候选 bullet 自问「reviewer 能从 subject + diff 推出来吗」，能 → drop
- 不附 Co-Authored-By
- 用 heredoc 传递 body（`git commit -m "$(cat <<'EOF' ... EOF)"`）
