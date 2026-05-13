# ai-agent-config-share

一份可分享的 Claude Code commands + references 子集，主要用于 spec / plan / skill 工作流。

## 内容

### Slash commands (`claude/commands/custom/`)

| Command | 用途 |
|---|---|
| `/custom:create-spec <task>` | 访谈用户，产出交付契约 `spec.md`（L1 产物 + L2 用户视角 verify + 横切取舍偏好） |
| `/custom:create-plan <task>` | 访谈用户，产出可实施的 `plan.md`；可读取 spec.md 为输入 |
| `/custom:review-spec <path>` | 按 `spec-review-principles.md` 审查 spec |
| `/custom:review-plan <path>` | 按 `plan-review-principles.md` 审查 plan |
| `/custom:review-skill <path>` | 按 `skill-review-principles.md` 审查 skill / command；可叠加 optimize 模式 |
| `/custom:create-skill-from-workflow` | 把刚执行的工作流提取为可复用 skill / command |
| `/custom:fix-skill-from-session` | 扫当前 session 中 skill / command 的错行为，定位到 source-level 修复 |
| `/custom:simulate-user-test <product>` | 模拟用户试用产品，输出可交付给 coding agent 的 issue 清单 |
| `/custom:create-handoff` | 把当前 session 的关键上下文外部化为 markdown handoff，给新 session 接力 |

## 安装

1. **克隆到稳定路径**（installer 创建 symlink 指向仓库内文件，仓库不能移动 / 删除）：

   ```sh
   git clone <url> ~/ai-agent-config-share
   cd ~/ai-agent-config-share
   ```

2. **运行 installer**：

   ```sh
   ./install.sh
   ```

   - 把 commands / references 通过 symlink 装到 `~/.claude/commands/custom/` 和 `~/.claude/references/`
   - 目标已存在则跳过（不覆盖），输出 `[SKIP ...]` 行让你自行处理

3. **手动 merge 顶层 config**：installer 末尾打印一段 prompt——粘到 Claude Code，由它把 `claude/CLAUDE.md` / `codex/AGENTS.md` 中的新内容并入你已有的 `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`，保留你已有的自定义内容。

## 用法

装完后在 Claude Code 中输入 `/custom:` 触发 slash command 选择器。

