# tt-web — UX 验收规格 (ux-contract)

> 面向使用者的**验收规格**：使用者拿它判断「这些都过了我放心继续用」。只描述 user-observable 行为，不含实现细节 / 内部状态 / 后端架构 / 待办路线。下游 `execute-ux-contract` 按本规格展开端到端测试。
>
> 基线：基于运行中真实产品（`http://127.0.0.1:39001`，真实本机 token 用量数据，跨度约 2026-04-21 至今）的实际观察撰写。

---

## L1 — 产品全貌 + 使用方式

**产品形态**：本机 localhost Web dashboard（Python stdlib HTTP server，无框架前端）。默认 `http://127.0.0.1:39001`（端口被占则自增，写入 `state/port`）。可经 Tailnet 远程访问。

**产品类型**：功能型数据可视化 dashboard（非游戏 / 非 AIGC 生成类）→ 价值来自「数字正确 + 能查到 + 能钻取」。无 registry 列出的 domain 专属验收（见末尾 domain 段）。

**使用者**：单用户、本机所有者本人。复盘自己在 Claude Code + Codex 上的 token 用量与成本。

**使用方式 / 使用者拿它做什么**：
- 短期盯当下消耗（今天 / 本周花了多少、配额还剩多少）。
- 长期看趋势与构成（按天/周/月看成本曲线、哪些项目/模型长期占成本）——最长回看 2 年（数据从启用起向前累积）。
- 查单个 session 的明细（成本、token、消息、turn 级展开）。
- 顺带做网络环境诊断（VPN/代理/时区是否影响 Claude 使用）。

**功能集合（user-observable 能力全景）**：

| 页面 | 入口 | 能力 |
|---|---|---|
| Overview | `/` | KPI 卡片（Today cost、Week cost、Claude 5h/7d 配额、Codex 7d 配额）；「Cost over time」成本时间图；「Top projects this week」「Model mix this month」侧面板 |
| Explore | `/explore` | 透视：x 轴（day/week/month/project/model/agent）× 分组（none＝不分组，或任一 x 轴维度）× 指标（cost / input / output / cache_read / cache_creation / total / messages）；预设按钮（Daily cost / Project cost / Model tokens / Agent by project / Cache read）一键切常用组合；agent/project/model **单选下拉过滤**（各以「All agents/projects/models」为首项 + 范围内可选值）；图 + 表 |
| Sessions | `/sessions` | session 列表（列：agent/project/model/起始/cost/tokens/messages）；排序下拉（Time / Cost / Tokens / Duration）；行展开看 turn 级明细 |
| Network | `/network` | 五块诊断卡：Local（LAN IP / IPv6 泄漏 / DNS+地域）、Public（IP/位置/ISP/时区）、Risk（proxycheck 风险分+type、ip-api hosting/marked-proxy、stopforumspam 垃圾评分+报告次数、本地 shell 代理环境变量）、Timezone（CLI vs 公网时区匹配）、Conclusion（逐条结论 + verdict 规则说明）；总体 verdict banner + Refresh |

**全局控件**：顶部 range 下拉 `7d / 30d / 90d / 6m / 1y / 2y / All`；Refresh 按钮；四页导航。切到另一页后顶部 range 仍是之前所选。

**跨页约定**：所有绝对时间戳按本机当前系统时区渲染并带 UTC-offset 标签（如 `GMT+8`），跟随系统时区设置、刷新即更新，不随浏览器陈旧时区漂移。

**成本口径（user-observable）**：
- Codex 无精确账单时由 GPT-5 定价**推算**，GLM-5.1/5.2 无精确 LiteLLM key 时由 bundled GLM-5 family 定价**推算**；推算项标 `推算`；未知模型定价显示 `—`，不显示 `0`。
- 历史成本按**采集时定价冻结**（长范围图上有 footnote 说明）。
- 数据从启用起累积，最早可见日 = 最早采集日（当前约 2026-04-21）；长范围超出该日时图上有覆盖提示。

**范围 / 约束 / 假设**：
- 单用户本机只读 dashboard，无写入 / 无副作用操作（点任何控件安全）。
- Sessions 列表受原始日志保留限制（Claude 通常约 30 天，Codex 更久）——长范围聚合统计看 Explore，不靠 Sessions。
- 假设本机有 Claude Code / Codex 的 JSONL 日志；无数据时相应视图为空。
- 时区随系统设置；改系统时区后刷新即更新。

---

## 验收侧重（横切 L1 + L2）

**与用户对齐结果：均匀覆盖——所有维度同等严格**，不分优先级。功能正确性、数据正确性与跨视图一致性、时间窗口/标签/时区清晰度、信息架构与 range 一致性、视觉与可读性、响应式/缩放韧性、空/边界状态，全部按高标准验收。

- 对 L1 影响：产品描述各区域均衡铺开，不刻意加深某一块。
- 对 L2 影响：每个维度都给具体可观测判定条件，不留「基本校验即可」的低标准维度。
- 对 L3（execute-ux-contract）影响：测试资源均衡分配到各维度——本段只列方向，不替 execute 决策具体测法。

---

## L2 — 用户视角 verify（独立于内部实现）

> 形式：操作序列 + 操作后观测点 + 通过判据。均覆盖 happy + 边界。数值类一律 **expected-vs-actual**（不接受「有输出即过」）。

### A. 跨页 / 全局

- **A1 时区与时间戳一致性**：任一页任一绝对时间戳，显示为本机系统时区且带 UTC-offset 标签。改系统时区并刷新后，标签随之变化。与 `/network` Timezone 卡报告的 CLI 时区**按 UTC-offset 比较一致**（页面 offset 标签 与 CLI timezone 的 offset 可能 IANA 名不同而 offset 相同——按 offset 判，不要求名相同）。
- **A2 range 切换连贯**：切换顶部 range（7d→2y 等），受 range 驱动的视图（Overview「Cost over time」、Explore 图表/表）随之更新；切到另一页后顶部 range 仍是之前所选。**已知固定窗口面板**（Overview「Top projects this week」「Model mix this month」、Sessions 列表保留窗口）不随 range 变内容是**预期**，但其 →Explore 钻取链接须带当前 range。**判定方法**：把顶部 range 设为非默认值（如 2y），点该面板 →Explore 链接后，地址栏 URL 含 `range=2y` 且 Explore 顶部 range 下拉显示 2y（非回落 30d）。
- **A3 四页可达且无报错**：四页均正常渲染，无 JS error banner / 服务端错误页 / 空白。
- **A4 数据真实非占位**：所有成本/ token 数字来自真实用量，非示例/ mock；Codex 与 GLM-5.1/5.2 推算项标 `推算`，未知定价显示 `—` 而非 `0`。
- **A5 空 / 无数据状态（边界）**：某视图无对应数据时，显示明确占位（`—` / "no data" / section-failure 提示），**不显示 `0`、不报 JS error、不空白**（如 Network 某诊断段查询失败显示 query-failed 提示而非整页崩）。

### B. Overview `/`

- **B1 Week cost 窗口可读**：Week cost 卡片副标题显式显示窗口起止 + 时区，语义为「本地时区本周一 00:00 → 此刻」（形如 `周一 <本周周一日期> 00:00:00 <tz-offset> → <now> <tz-offset>`，本机 locale 渲染）；**判据是起始 = 本机时区本周周一 00:00（非滚动 7 天、非周日起），不依赖具体日期**（不同周跑结果不同，对照规则非对照固定日期）。
- **B2 Today / Week / 配额 卡片**：Today cost = 今日累计；Week cost = 本周至今；Claude 5h、7d 与 Codex 7d 配额显示百分比 + reset 时间（带时区）+ 更新新鲜度；Codex 不显示已取消的 5h 配额卡片。
- **B3 Cost over time 面板**：标题为「Cost over time」（非旧「30 day cost」）；按所选 range 取数、随 range 变化（长范围数据跨度严格大于短范围）；长范围自动按周/月聚合（≤90d 天 / ≤1y 周 / >1y 月；`6m` 同 `1y` 走周，`All` 走月）——**粒度在面板副标题 meta 行可读**（形如 `<range> · <day|week|month> buckets · historical rollup`），选 90d 显示 day、1y 显示 week、2y 与 All 显示 month；含「历史成本按采集时定价冻结」footnote。
- **B4 长范围覆盖提示（边界）**：当所选 range 起点早于最早采集日时，面板显示覆盖提示（如「历史自 <最早日> 起累积；更早未采集」）；range 在数据范围内（如 7d）时不显示该提示，避免误导。**`All`（无界窗口）下覆盖提示恒显示**（其起点恒早于最早采集日）。
- **B5 侧面板**：「Top projects this week」按本周成本排序的项目；「Model mix this month」本月模型 token 构成；两者 →Explore 链接带当前 range。

### C. Explore `/explore`

- **C1 自动粒度**：选 90d 默认 x=天、1y（及 6m）默认 x=周、2y 与 All 默认 x=月；用户可手动改 x 维覆盖默认。
- **C2 透视正确**：x 轴 × 分组 × 指标组合产出对应图 + 表；时间维按时间排序，非时间维按值排序。
- **C3 历史全维分组**：长范围（如 2y）下按 project / model / agent 分组，各分组列对应真实数据的 distinct 值（覆盖完整，非只最近窗口）；切指标（cost/token/messages 等）数值随之变化。**高基数维度（distinct >15，如 project=35）自动折叠为 top 12 + 单一「Other」**（Other = 其余项之和，total 不丢）；≤15 的维度（model/agent）全显不折叠。
- **C4 过滤**：三个**单选下拉**（Agent / Project / Model filter），各以「All agents / All projects / All models」为首项 + 范围内可选值（选项随 range 变化），三者与 x/分组/指标同为原生下拉 `<select>` 控件（非 chips / checkbox / radio 等其他控件；视觉精细度归 F1 人工判断）。选某值后图表/表只含该项；选「All …」首项 = 该维不过滤；当前所选反映进 URL（取「全部」则去掉该参数），深链（如 `/explore?range=2y&agent=codex`）加载后：Agent 下拉显示选中 `codex`、URL 保留 `agent=codex`、图表/表仅含 codex 的 series，**且过滤确实改变数值**——选 `agent=codex` 后某 x 桶值 ≠「All agents」同桶值（单 agent 是全体子集），不接受过滤后与未过滤数值完全相同（防 no-op 过滤）。每维至多一个值（单选）。**边界**：深链值不在当前 range 选项集内时（如 `range=7d` 但带一个仅 2y 才出现的 project），该值仍注入为选项并保持选中过滤（不静默回落「All …」首项）；该值在当前 range 无数据时，图/表区显示明确空状态占位（见 A5：`—` / "no data"，不显伪造 `0`、不报错）——空 `<tbody>` + 仅 "0 rows" 计数不构成合格占位。
- **C5 边界**：长范围 + 多 series 分组时图表/表仍能加载不报错且**可钻取**——高基数维度折叠为 top 12 + Other（见 C3），表宽收敛、图例可读；长路径 project 标签缩短显示（git 仓名优先 / 末段路径），完整路径在 hover/title 可见。
- **C6 预设按钮**：点任一预设（Daily cost / Project cost / Model tokens / Agent by project / Cache read）后，x 维 / 分组 / 指标三个下拉切到该预设对应组合，且图 + 表随之刷新为对应数据。

### D. Sessions `/sessions`

- **D1 保留说明准确**：页面 note 准确描述列表只显示仍存在的原始日志（Claude 通常约 30 天，Codex 可能更久，更久聚合见 Explore）；不出现「只保留约 30 天」这类对混合源不准确的旧措辞。
- **D2 列表与排序**：列出 session（列：agent/project/model/起始时间/cost/tokens/messages）；排序下拉提供 **Time / Cost / Tokens / Duration** 四项，选定后列表按该维排序且符合排序语义。注：Duration 可排序但**不作为可见列**展示（按起始/结束时间差计算）——验 Duration 排序时以相邻行的时间跨度推断顺序，或视为已知的「可排序但无对应列」观察点。
- **D3 行展开**：点行展开 turn 级明细（每 turn 时间/模型/in/out/cost）。
- **D4 range 行为**：列表受原始日志保留限制（不因选 2y 就声称有 2 年 session）；这是预期，且 note 已解释。

### E. Network `/network`

- **E1 诊断渲染**：显示**五块卡** + 总体 verdict banner，正常环境无 error banner：
  - **Local**：LAN IP、IPv6 是否泄漏、DNS 服务器 + 地域（是否 CN resolver）。
  - **Public**：公网 IP、位置、ISP、Org、时区。
  - **Risk**：proxycheck 风险分 + type、ip-api marked-proxy / hosting 标记、stopforumspam 垃圾评分 + 报告次数 + 最近报告、本地 shell 代理环境变量。
  - **Timezone**：CLI 时区 vs 公网时区是否匹配。
  - **Conclusion**：逐条结论 + verdict 规则说明文本。
- **E1c Risk 卡部分未查询态（边界）**：当 proxycheck / stopforumspam 未查询或不可用、但其余诊断正常渲染时——Risk 卡对应行显示 `not queried` / `—`（**非 `0`、非 JS 崩**），其余四块卡与 verdict 照常渲染，且 verdict **忽略缺失的风险分**（按 E1b 规则，risk 分缺失不触发 HIGH）。这是区别于 E1 全present、A5 单段失败、E4 整页降级的第三态。
- **E1b verdict banner 状态**：banner 显示四态之一，且与 Conclusion 卡逐条结论一致——`HIGH`（文案「High risk for Claude use」，命中 IPv6 泄漏 / CN DNS / 风险分≥70 / 时区不符 任一）、`PROXY-IN-USE`（文案「Claude usable, but proxy is in use」，Risk 卡「Marked proxy (ip-api / proxycheck)」行显示 yes 且无 HIGH 信号）、`LOW`（文案「Low risk for Claude use」，无上述信号）、`UNKNOWN`（文案「Network status unknown」，检测不可用）。判定：banner 文案与 verdict 规则、Conclusion 结论三者自洽。**注**：本地 shell 代理环境变量仅在 Risk 卡「Proxy envs」展示，**不参与 verdict**（设置了 HTTP_PROXY 不等于 PROXY-IN-USE）。
- **E2 Refresh**：Refresh 触发强制重新检测（默认 60s 缓存），结果可更新。
- **E3 本轮保留**：本轮历史功能改动**不影响** Network 页行为（保留承诺）。
- **E4 整页降级 / 不可用（边界）**：当 `ip-check` 整体不可用（未安装 / 退出非 0 / 超时 / 返回非法 JSON）时——verdict banner 显示 `UNKNOWN` + 原因行；五块卡均显示 unavailable 提示；并出现对应入口：未安装 → 顶部 error 面板带「ip-check 未安装」+ Docs 链接；检测失败 → error 面板 + Retry 按钮。**全程不 JS 崩、不空白页**（区别于 A5 的单段失败，这是整页降级态）。

### F. 视觉与缩放（均匀覆盖要求，跨四页）

- **F1 可读性（需人工判断）**：四页默认窗口下的具体可读检查点——Overview KPI 数值不被裁切；Explore 长项目路径标签截断带省略号（不撑破）；Sessions 表头不换行错位；图例/坐标轴标签可辨识。这些为具体锚点；**整体美学层级 / 视觉噪声为单一 holistic「需人工判断」检查点**（视觉质量无法机械断言，刻意保留为人工 gate 而非逐点拆）。
- **F2 缩放 / 响应式韧性**：浏览器缩放至 125% / 150%（或等价 viewport）、并将窗口收窄至 ~1024px / ~720px 宽时，四页无元素重叠 / 裁切 / 破版；表格过宽时出现**受控横向滚动**而非撑破整页布局（Explore 高基数分组已由 top-12+Other 折叠收敛表宽，见 C3/C5）。

---

## domain 专属验收

L1 判定为**功能型** data-viz dashboard，非 `~/.claude/references/domain-registry.md` 列出的特殊 domain（游戏等）→ **无 domain 专属验收段**。数据可视化的「能钻取到根因 / 跨视图数据一致」已并入 L2（C2/C3 钻取与一致性、A2/A4 跨视图）。

---

## 已知限制（非 fail 项，使用者知情）

- （无当前已知限制。**UX-003** 原列于此——Explore project 分组长范围过宽表/标签——已通过 top-12+Other 折叠 + 标签缩短解决，见 C3/C5。）

---

## Defaulted Decisions（contract author 自拍，供 review 审）

| 决策 | 选择 | 理由 |
|---|---|---|
| 契约落点 | `tt-web/docs/contracts/ux-contract.md` | tt-web 是产品根，create-ux-contract 落点为产品根的 `docs/contracts/` |
| domain 验收 | N/A（功能型） | 非 registry domain；data-viz 钻取/一致性并入 L2 而非另起 domain 段 |
| UX-003 | 已解决（top-12+Other 折叠 + 标签缩短），并入 C3/C5 验收 | 用户经 resolve-issues 决定修产品；契约同步反映已达标，不再列为已知限制 |
| 固定窗口面板（Top projects this week / Model mix this month） | 验收上接受其不随 range 变（A2），只验其 →Explore 链接带 range | 这是已交付的预期设计，非缺陷 |
| 验收侧重 | 均匀覆盖（用户拍板） | 见验收侧重段 |
