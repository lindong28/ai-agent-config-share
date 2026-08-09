# UX Contract Issues

`docs/contracts/ux-contract.md` 的演化候选。契约本身基于真实端到端观察建立、不由 agent 静默改（见 `~/.claude/references/docs-organization-protocol.md` §4.6），自由 session 发现的候选先记在这里，由用户经 `/custom:create-ux-contract` 处理。

---

## [open] 契约的产品形态只认 Web dashboard，`tt-web network` 这条终端入口落在契约覆盖面之外

- **Type**: coverage-gap
- **Priority**: medium
- **Description**: L1 把产品形态定为「本机 localhost Web dashboard」，功能全景表按页面（`/`、`/explore`、`/sessions`、`/network`）组织，验收段 A–G 也全部以页面为单位。2026-08-07 新增的 `tt-web network` 使 `/network` 那份诊断多了一条终端入口：同一份快照、同一套结论，但呈现形态与验收判据都不是页面式的。按现行契约做一次完整 UX 测试不会覆盖到它。

    需要用户对齐的点（不由 agent 自行裁定）：
    - **产品形态**是否从「Web dashboard」扩为「Web dashboard + 一组 CLI 入口」。若扩，`tt-web rollup --check` / `machines accept` / `export` 等既有子命令是否一并进契约——它们同样是 user-observable 且此前也不在覆盖面内，只做 `network` 一条会留下同类不一致。
    - **G5「本机专属页面标明范围」**是否推广为通道无关的判据。该命令的输出已声明「仅本机」，但 G5 现行措辞锚在「页面上有可读的本机标注」，字面不覆盖终端输出。
    - **新增一条 verdict 作用域判据**：总体 verdict 只能覆盖本轮真正取得观测的维度。这不是 CLI 专属——`/network` 页面存在同一缺口（见下条），所以判据该定在契约层而非命令层。

## [open] `/network` 页面的 verdict banner 会把未取得观测的维度算作已验证

- **Type**: correctness
- **Priority**: medium
- **Description**: `verdict` 由 `ip_check.collect_all()` 按「IPv6 泄漏 / CN DNS / 风险分 ≥ 70 / 时区不一致」四路信号计算，任一未命中即落到 `low`。但**查询失败与"查过且正常"在这个计算里不可区分**：2026-08-07 实测 `proxycheck.io` 读超时，`risk` 仍返回一个 dict（`score: null`，失败文本埋在 `display` 里，`errors` 为空数组），`verdict` 照常输出 `low`，banner 显示「Low risk for Claude use」。Risk 卡片确实会显示 `not queried` 警示，但**总体结论并未声明该维度不在覆盖内**，而使用者读 banner 的用途正是"我不用再查了"。

    `tt-web network` 已按「结论作用域不超过证据作用域」处理这一情形（列出未取得观测的维度并在结论上加限定），页面尚未同步。判据若按上一条进契约，页面这一侧需一并对齐——两个入口共用同一份 `/api/network` 快照，结论口径不该分叉。
