# General Issues

> [Agent] `harness-issues.md` 不覆盖的其余问题的 domain 跟踪文件——本仓自身的产品代码 / 安装器（`install.sh` / `verify.sh` / `tt-web` / `ask-user-mcp`）缺陷，以及 wrapped-agent 行为问题与工具缺口。Agent harness 自身问题走 [harness-issues.md](harness-issues.md)。

写入驱动：`/custom:supervise` 等流程，以及审计 / review 流程发现、但本次不就地修的本仓缺陷。按 `~/.claude/references/docs-organization-protocol.md` §4.8 追加一条。

**格式**：遵循 §4.8（`## [<status>] <title>` / Type / Priority / Discovered / Description / Notes）。Status：`open` / `resolved` / `wontfix`（后两者写明原因）。Type 枚举：`bug` / `improvement` / `note`。判定 resolved / wontfix 的同一步移入 [archive/closed.md](archive/closed.md)。

---

## [open] install.sh 仍需 jq 才能自动合并 settings.json 的 statusLine

- **Type**: improvement
- **Priority**: low
- **Discovered**: 2026-07-30
- **Description**: `statusline.sh` 已改为把全部 JSON 处理交给 `statusline-fields.py`，jq 不再是运行时依赖。但 `install.sh` 的 `wire_statusline_settings()` 仍用 jq 读写 `~/.claude/settings.json`，所以没有 jq 的主机上安装器无法自动接线 statusLine（`verify.sh` 已相应从 FAIL 降为 WARN）。
- **候选优化**: 把该函数改用 `python3` 做 settings.json 的读取与合并，本仓即可完全不依赖 jq。
- **Notes**: 需谨慎——该函数会写用户既有的 settings.json，改写时要保留"已指向本仓则跳过、指向别处则告警不覆盖"的现有语义。
