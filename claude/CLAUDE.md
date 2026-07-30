# User-Level CLAUDE.md / AGENTS.md

本文件是**跨 harness 的**单一政策源——一份文件同时服务 Claude Code 与 Codex（`codex/AGENTS.md` 是它的 symlink），政策不在两侧分叉。下表把文中出现的能力名映射到你所在的 harness；标注"仅 Claude Code"的条目在 Codex 侧忽略，其余规则两侧同等 BINDING。

## Harness 适配 (BINDING)

| 能力 | Claude Code | Codex |
|---|---|---|
| `AskUserQuestion` | 内置工具 | `ask-user` MCP server 的 AskUserQuestion 工具（本仓 `ask-user-mcp/`，装到 `~/.codex/ask-user-mcp`；以当前 tool catalog 为准）。该工具不可用时降级：正文列编号选项并标注推荐项，停轮等待用户回复，不得替用户选 |
| `/custom:*` slash command | 原生（`~/.claude/commands/custom/`） | **无对应入口**——本仓不给 Codex 安装 command wrapper。文中出现 `/custom:<x>` 的强制路由，在 Codex 侧的处置是：读 `~/.claude/commands/custom/<x>.md` 这份文件并按它描述的流程亲自执行；确实无法达成时明确告知用户该步依赖 Claude Code，不得臆造完成或静默跳过 |
| 子代理委派（Task / Agent / subagent / spawn） | 内置 Task / Agent 工具 | 内置 collaboration multi-agent 工具；按调用方语义保持角色、上下文隔离、并行与返回契约 |
| skill 调用 | Skill tool | 本仓只给 Codex 装 `agent-browser`（`~/.codex/skills/agent-browser`）。其余 skill 同上一行 `/custom:*` 的处置——读其 `SKILL.md` 并亲自执行 |
| hooks 强制层 | 自动执行（`~/.claude/hooks/` + settings.json 接线） | 仅 Claude Code；Codex 忽略 hook mechanics。两侧都必须遵守的 invariant 由本文件或双方可达的 reference 明确承载，不从 hook 实现反推 |
| 任务清单 | TaskCreate / TodoWrite | 内置 plan 工具 |
| 上表未列出的 Claude 专属工具 | 原生 | 无直接对应——用 Codex 原生机制达成同一目的；确实无法达成时明确告知用户该步依赖 Claude Code |

## Long-Task Protocol (BINDING)

当你正在实施的 plan.md 顶部有 `Long-task mode` banner 时，遵循 `~/.claude/references/long-task-protocol.md` 规定的协议（state.md / journal.md / 交付前验证）。

任务尚未处于 long-task mode、但执行中出现 context 丢失会使剩余状态或安全续跑变得不可靠的风险时，先读该协议「执行中提升」判断是否提升；跨 session / context compaction 是典型信号，单纯 wall-clock 较长不是。

## 并发写入者隔离 (BINDING)

多个 agent session 可能并发在同一 repo 上执行 plan 时，按 `~/.claude/references/concurrent-plan-isolation.md` 的三层结构隔离开工。

判过"独占"的 session 执行中出现第二个决策者在改同一棵工作树的反证时（"文件被外部修改"的提示、`git status` 出现本 session 开始后新出现且非本轮编辑的改动、本工作树 `HEAD` reflog 出现本 session 未发起的 rebase / amend / reset），先读该协议「执行中提升」判断是否提升；hook / formatter 改写自己的 edit 不算——它们没有独立意图。

## Plan Execution Principles (BINDING)

执行任何 plan 时遵循 `~/.claude/references/plan-execution-principles.md`。以任何理由不继续执行 plan，都算 stop。Stop 前必须先通过该文件的 stop gate。

## Docs Organization Protocol (BINDING)

遵循 `~/.claude/references/docs-organization-protocol.md` 维护项目文档。

- **plan 完成后**：按协议 §5 同步机制将项目级信息同步到 docs/。其中**用户可感知变更的 ux-contract 同步走协议 §4.6 主路径**——由 create-plan 条件化对齐、`~/.claude/commands/custom/execute-plan.md` §4a/§4b 应用 + 测试。
- **自由 session**（不走 execute-plan / execute-ux-contract，它们已在 commit 步自动同步）：改动产生**用户可感知变化**时，落 commit 前先同步 [User] 档（README / CHANGELOG / operations），ux-contract 演化走协议 §4.6 fallback（issue 路径）；开发者档（architecture / adr / experiences）留给手动 `/custom:sync-docs`。

## Harness Issue Capture (BINDING)

发现 **Agent Harness 自身**（agent 运行其上的配置/工具/行为，区别于 agent 在构建的产品代码——如 hooks、适配层、agent/skill 行为、settings/权限）值得优化、但本次不就地修的问题时，按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加到当前项目的 `docs/issues/harness-issues.md`。别让问题只活在本次 context 里。

## Surface Choices (Real Ones), Recommend One (BINDING)
- For every set of options you give the user, surface them via `AskUserQuestion` (never inline prose), marking which one you recommend and why. Applies to every genuine choice the user owns (artifact shape, tradeoff, aesthetic), not work you could do yourself — regardless of stakes. 你自己能做、却包装成"你来做 X"/等用户执行的，是转嫁不是 choice → Plan Execution Principles §0 Stop Gate。
- Before any choice whose reversal would cost meaningful rework downstream, read `~/.claude/references/deep-discuss-style.md` and follow it.

## Present Multimodal Content for User Review (BINDING)

需要用户审核多模态内容（图片 / 视频 / GIF / 音频 等）、且 inline 展示无法让其完整查看 / 收听时，生成 HTML 页面并通过本地 web server 给出 http 链接，让用户在浏览器里直接查看 / 播放。禁止让用户逐个打开文件、只贴静态首帧、或仅给文件路径。

## 生成后 Review Gate (BINDING)

完成一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改后、宣告完成或 commit 前，按 `~/.claude/skills/review-gate/SKILL.md` 执行 review gate——gate 未过不得宣告完成或 commit；trivial 可声明式免审（细则见 skill）。

## AIGC 视觉效果设计先行 (BINDING)

实现任何合成/编辑/后处理/多来源接合/多步生成、失败模式为视觉工程痕迹（断层/鬼影/孔洞/残渣/可见重复/漂移/涂抹）的效果或机制前，先 `/custom:create-aigc-design` 写设计 + `/custom:review-aigc-design` 循环审查、过 blocker gate 再实现。**触发判据是改动的性质（有无这类失败模式），不是大小/重要性/时机**——单个效果、实现或调试中途新增、看似"小 tweak"、反应式修 bug 时照样触发（这些恰是最易漏、失败模式最隐蔽的场景）。单步纯生成（文生图/一次性图生图等无接合）不在此列，除非明确有漂移/重复风险。判据/rubric/接合类型学见 `~/.claude/references/aigc-design-review.md`。

