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

   同时核实**将写进本次 commit 的作者身份**：读 `git config user.name` 与 `git config user.email` 本身——**不要拿 `git log` 的历史作者代替**。历史作者是代理判据：连续多个 commit 用错身份时它已被同一个错值填满、会自洽地"通过"，多人仓库里它又每次都与你不同、只会制造误报；两种情况下它的输出在身份对与错时都不可区分。取到值后与该仓库预期的身份核对（remote 主机与组织、既有协作者的邮箱域、用户此前的交代）。不一致或判断不了就停下问用户，不要先提交再说：身份错在本地还能 amend，push 之后就是不可逆的公开归属错误，而 agent 侧全程零反馈信号——commit 成功、测试全绿、review gate 照过。多仓库、或公司与个人机器混用时尤其容易发生。

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

   判断不确定时用 `AskUserQuestion` 确认；无法 ask 时排除不确定的 untracked 文件，并在结果中列出未纳入项。

   **粒度 = 一次任务执行，不按 artifact 类型拆**：一个任务目标下产出的代码、测试、文档、experiences、配置属于同一次执行，进同一个 commit（如一个 PR 不会把代码/测试/文档拆成多个）；多个模块的改动仍是一个 commit（用 message bullets 表达），不是拆 commit 的信号。若 working tree 混入了另一个无关任务的改动，先与用户确认，本次只 stage / commit 当前任务的改动。

3. **文档同步 checkpoint**：staging 范围定后，判断本次改动是否产生**用户可感知变化 / 服务增删改 / 公共接口变化**（判据见 `~/.claude/references/docs-organization-protocol.md`）。是 → 对应 [User] 档（README / CHANGELOG / operations）必须一并同步进本次 staging，未同步则先补齐再继续；开发者档（architecture / adr / experiences）与 ux-contract 按协议各自路径、不在此强制。追加项落在第 2 步已由用户或 caller 裁定的范围之外时，先回述这个 delta——有人值守经确认后再 stage，无人值守流照常同步但在结果中列出偏离；否则每个经批准的范围都会在 commit 落地时静默地与批准时不同。用户明文排除过该文件时，无人值守流不得径直同步：不 stage，在结果中标为阻塞项——事后列出不等于用户同意；有人值守则把这个冲突并入上面那次回述交用户裁决。例外：本次 commit 由已声明会集中同步文档的 caller（execute-plan / execute-ux-contract 的完整 recipe）驱动时，尊重其编排、不在此重复要求。

4. **生成 commit message**：格式见下方。

5. **执行**：用 `git add <specific files>` stage 第 2 步选定的范围**及第 3 步补齐的 [User] 档**（**禁止** `git add -A` / `git add .`），然后 `git commit --only <同一组路径>`。

   `--only` 不是可选的谨慎写法：`git add <specific>` 限定不了 commit 范围，它只是往索引里追加，而 `git commit` 落的是**整个索引**——包含开工前就躺在里面、别人 stage 的内容。于是"我只 add 了这几个文件"读起来像范围声明、实际不是，且两者不一致时没有任何回显提示，除非你恰好认出 commit 输出里多出来的文件名。第 2 步定的范围要真正生效，得由 `--only` 兑现。

   两处语义要记住：`--only <paths>` 提交的是这些路径的**工作树内容**，会覆盖你为它们 `git add` 过的版本——所以刻意 stage 过部分改动（`git add -p`、或按行归属重建过索引）时不能用它，那份工作会被丢掉，此时先把想提交的内容写回工作树。而 `git add` 那步仍不能省：`--only` 只认 git 已知的路径，新文件不先 add 会直接报 `did not match any file(s) known to git`。

## Commit Message 格式

| 场景 | Subject | Body |
|------|---------|------|
| 单改动，无 notable detail | `<type>(scope): <desc>` | 无 |
| 单改动，有 notable detail | `<type>(scope): <desc>` | detail 作为 bullets |
| 多改动（性质不同的改动；一件事的多个侧面算单改动） | 自由文本总结 | 每个改动一条 `<type>(scope): <desc>` bullet |

- Subject 与 body 行均 ≤72 chars——`git log` 左缩进 4 空格后仍在 80 列内
- 语言：整条 message（subject + body）默认英文；仅在用户明确要求、仓库近期 commit 多为中文、或某专有概念无准确英文对应时用中文（末者只该词保留中文）
- Types: `feat` `fix` `refactor` `docs` `test` `chore` `perf` `ci` `style` `build` `revert`
- Body 仅在 subject + diff 不足以让 reviewer 推出非显然设计决策时加
- Per-bullet derivability test：每条候选 bullet 自问「reviewer 能从 subject + diff 推出来吗」，能 → drop
  - **diff 含本次一并提交的注释与文档**——复述自己刚写下的注释即判定为可推导。注释在使用现场被读到，commit message 不会；留两份只会各自漂移
  - 例外：**行为变更**即使可推导也留一条。扫 `git log` 找「什么时候变的」的人不会去读注释
- 不附 Co-Authored-By
- 用 heredoc 传递 body（`git commit -m "$(cat <<'EOF' ... EOF)"`）

## 格式锚定示例

单改动，无 body：
```bash
git commit -m "refactor(commands): organize slash commands into namespaced dirs"
```

单改动，有 body：
```bash
git commit -m "$(cat <<'EOF'
feat(llm): replace LiteLLM with native provider SDK adapters

- Native OpenAI/Anthropic/Gemini adapters, no translation layer
- Attempt-count retry with native SDK error classification
EOF
)"
```

多改动（subject 概括这组改动的共同意图，而非罗列各模块名；无统一意图时点明范围，如 `fix several typos across docs`）：
```bash
git commit -m "$(cat <<'EOF'
Overhaul auth and harden the connection pool

- feat(auth): add JWT refresh with a sliding window
- fix(db): resolve connection-pool leak under high concurrency
- refactor(middleware): extract request validation into a shared module
EOF
)"
```
