# User-Level CLAUDE.md

## Long-Task Protocol (BINDING)

当你正在实施的 plan.md 顶部有 `Long-task mode` banner 时，遵循 `~/.claude/references/long-task-protocol.md` 规定的协议（state.md / journal.md / 交付前验证）。

任务尚未处于 long-task mode、但执行中出现 context 丢失会使剩余状态或安全续跑变得不可靠的风险时，先读该协议「执行中提升」判断是否提升；跨 session / context compaction 是典型信号，单纯 wall-clock 较长不是。

## Plan Execution Principles (BINDING)

执行任何 plan 时遵循 `~/.claude/references/plan-execution-principles.md`。以任何理由不继续执行 plan，都算 stop。Stop 前必须先通过该文件的 stop gate。

## Docs Organization Protocol (BINDING)

遵循 `~/.claude/references/docs-organization-protocol.md` 维护项目文档。

- **plan 完成后**：按协议 §5 同步机制将项目级信息同步到 docs/。其中**用户可感知变更的 ux-contract 同步走协议 §4.6 主路径**——由 create-plan 条件化对齐、`~/.claude/commands/custom/execute-plan.md` §4a/§4b 应用 + 测试。
- **自由 session**（不走 execute-plan / execute-ux-contract，它们已在 commit 步自动同步）：改动产生**用户可感知变化**时，落 commit 前先同步 [User] 档（README / CHANGELOG / operations），ux-contract 演化走协议 §4.6 fallback（issue 路径）；开发者档（architecture / adr / experiences）留给手动 `/custom:sync-docs`。

## Surface Choices (Real Ones), Recommend One (BINDING)
- For every set of options you give the user, surface them via `AskUserQuestion` (never inline prose), marking which one you recommend and why. Applies to every genuine choice the user owns (artifact shape, tradeoff, aesthetic), not work you could do yourself — regardless of stakes. 你自己能做、却包装成"你来做 X"/等用户执行的，是转嫁不是 choice → Plan Execution Principles §0 Stop Gate。
- Before any choice whose reversal would cost meaningful rework downstream, read `~/.claude/references/deep-discuss-style.md` and follow it.

## Present Multimodal Content for User Review (BINDING)

需要用户审核多模态内容（图片 / 视频 / GIF / 音频 等）、且 inline 展示无法让其完整查看 / 收听时，生成 HTML 页面并通过本地 web server 给出 http 链接，让用户在浏览器里直接查看 / 播放。禁止让用户逐个打开文件、只贴静态首帧、或仅给文件路径。

## 生成后 Review Gate (BINDING)

完成一轮代码/脚本/常驻配置（hooks、zshrc、skill 等 artifact）的生成或修改后、宣告完成或 commit 前，按 `~/.claude/skills/review-gate/SKILL.md` 执行 review gate——gate 未过不得宣告完成或 commit；trivial 可声明式免审（细则见 skill）。

