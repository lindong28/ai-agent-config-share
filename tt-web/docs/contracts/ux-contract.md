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
- **一次看全部常用开发机的合计**，而不是逐台打开各自的 dashboard；也能按机器拆开比较。
- 查单个 session 的明细（成本、token、消息、turn 级展开）。
- 顺带做网络环境诊断（VPN/代理/时区是否影响 Claude 使用）。

**多机范围（决定页面上"All"是什么）**：dashboard 在一台机器上打开，聚合的却是**声明过的全部机器**。使用者在 `tt-web/machines.json` 里声明机器（名字 + SSH 目标 + 哪台是本机）；本机按需通过 SSH 向各远端取一份用量快照，合并进同一套视图。使用者看到的是：`All` 覆盖了哪几台、每台的数据有多新、哪台联系不上。**首次接入一台远端需要显式确认**——系统只能保证"以后仍是这台"，不能验证"第一次就是你以为的那台"，故由使用者对照自己的 SSH 配置确认后才建立绑定。

**聚合日边界（影响所有 KPI 数字）**：Today / Week / Month 与 `Nd` 范围的**日、周、月边界固定按 `Asia/Shanghai`**，不随任何一台机器的系统时区变化——否则同一时刻的同一条用量会在不同机器上落进不同日期，跨机合计就不成立。**绝对时间戳的显示**仍按本机系统时区渲染（见 A1），两者是各自独立的约定。

**功能集合（user-observable 能力全景）**：

| 页面 | 入口 | 能力 |
|---|---|---|
| Overview | `/` | **机器状态条**（coverage N/M + 逐台卡片）；KPI 卡片（Today cost、Week cost、Claude 5h/7d 配额、Codex 7d 配额）；「Cost over time」成本时间图；「Top projects this week」「Model mix this month」侧面板。**除配额外均为全机合计** |
| Explore | `/explore` | **机器状态条**；透视：x 轴（day/week/month/project/model/agent/**machine**）× 分组（none＝不分组，或任一 x 轴维度）× 指标（cost / input / output / cache_read / cache_creation / total / messages）；预设按钮（Daily cost / Project cost / Model tokens / Agent by project / Cache read）一键切常用组合；agent/project/model/**machine** **单选下拉过滤**（各以「All agents/projects/models/machines」为首项 + 范围内可选值）；图 + 表 |
| Sessions | `/sessions` | **仅本机**：session 列表（列：agent/project/model/起始/cost/tokens/messages）；排序下拉（Time / Cost / Tokens / Duration）；行展开看 turn 级明细 |
| Network | `/network` | **仅本机**：五块诊断卡：Local（LAN IP / IPv6 泄漏 / DNS+地域）、Public（IP/位置/ISP/时区）、Risk（proxycheck 风险分+type、ip-api hosting/marked-proxy、stopforumspam 垃圾评分+报告次数、本地 shell 代理环境变量）、Timezone（CLI vs 公网时区匹配）、Conclusion（逐条结论 + verdict 规则说明）；总体 verdict banner + Refresh |

**全局控件**：顶部 range 下拉 `7d / 30d / 90d / 6m / 1y / 2y / All`；Refresh 按钮；四页导航。切到另一页后顶部 range 仍是之前所选。

**跨页约定**：所有绝对时间戳按本机当前系统时区渲染并带 UTC-offset 标签（如 `GMT+8`），跟随系统时区设置、刷新即更新，不随浏览器陈旧时区漂移。

**成本口径（user-observable）**：
- Codex 无精确账单时由 GPT-5 定价**推算**，GLM-5.1/5.2 无精确 LiteLLM key 时由 bundled GLM-5 family 定价**推算**；推算项标 `推算`；未知模型定价显示 `—`，不显示 `0`。
- 28 天 recompute 窗口内，各 `(day, agent, project, model)` bucket 分别从当前可读源更新。日志中已有精确成本的条目保持记录值；没有精确成本的条目使用 tt-web 当时可用的定价数据推算。某个 bucket 的源缺失，或其 token、消息、条目计数低于此前显示值时，该 bucket 的成本贡献保持最后可信值；其他 bucket 继续更新，因此页面或 project 聚合成本仍可能变化。窗口外的既有 bucket 保持冻结。长范围图上有 footnote 说明这三段口径。
- 数据从启用起累积，最早可见日 = 最早采集日（当前约 2026-04-21）；长范围超出该日时图上有覆盖提示。
- token、消息与条目统计不会因原始日志被裁剪、归档或项目目录删除而减少；成本不属于这一单调保证，按上一条口径处理。

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

- **A1 时区：显示随系统、聚合固定上海**。两条独立、须分别验：
  - **绝对时间戳的显示**随本机系统时区，带 UTC-offset 标签（如 `GMT+8`）。改系统时区并刷新后标签随之变化。与 `/network` Timezone 卡报告的 CLI 时区**按 UTC-offset 比较一致**（IANA 名可不同，按 offset 判）。
  - **用量聚合的日 / 周 / 月边界固定 `Asia/Shanghai`**，**不**随系统时区变化。**判定方法**：冻结同一份数据，在两个不同的系统时区下各跑一次——① Today / Week / Month 与 `Nd` 的**数值必须一致**；② 同一页上的 generation 时间、配额 reset 时间等绝对时间戳的**显示值与 offset 必须不同**。缺了②，「聚合固定、显示随系统」这条承诺就没有会失败的验证。
- **A2 range 切换连贯**：切换顶部 range（7d→2y 等），受 range 驱动的视图（Overview「Cost over time」、Explore 图表/表）随之更新；切到另一页后顶部 range 仍是之前所选。**已知固定窗口面板**（Overview「Top projects this week」「Model mix this month」、Sessions 列表保留窗口）不随 range 变内容是**预期**，但其 →Explore 钻取链接须带当前 range。**判定方法**：把顶部 range 设为非默认值（如 2y），点该面板 →Explore 链接后，地址栏 URL 含 `range=2y` 且 Explore 顶部 range 下拉显示 2y（非回落 30d）。
- **A3 四页可达且无报错**：四页均正常渲染，无 JS error banner / 服务端错误页 / 空白。
- **A4 数据真实非占位**：所有成本/ token 数字来自真实用量，非示例/ mock；Codex 与 GLM-5.1/5.2 推算项标 `推算`，未知定价显示 `—` 而非 `0`。
- **A5 空 / 无数据状态（边界）**：某视图无对应数据时，显示明确占位（`—` / "no data" / section-failure 提示），**不显示 `0`、不报 JS error、不空白**（如 Network 某诊断段查询失败显示 query-failed 提示而非整页崩）。

### B. Overview `/`

- **B1 Week cost 窗口可读**：Week cost 卡片副标题显式显示窗口起止 + 时区，语义为「**`Asia/Shanghai` 本周一 00:00** → 此刻」（形如 `周一 <本周周一日期> 00:00:00 <tz-offset> → <now> <tz-offset>`，本机 locale 渲染）；**判据是起始 = `Asia/Shanghai` 本周周一 00:00（非滚动 7 天、非周日起、非本机时区周一），不依赖具体日期**（不同周跑结果不同，对照规则非对照固定日期）。
- **B2 Today / Week / 配额 卡片**：Today cost = 今日累计（`Asia/Shanghai` 日）；Week cost = 本周至今（同上周边界）；**两者均为全部 admitted 机器的合计**。Claude 5h、7d 与 Codex 7d 配额显示百分比 + reset 时间（带时区）+ 更新新鲜度；Codex 不显示已取消的 5h 配额卡片。**配额是唯一不合计的 KPI**——见 G4。
- **B3 Cost over time 面板**：标题为「Cost over time」（非旧「30 day cost」）；按所选 range 取数、随 range 变化（长范围数据跨度严格大于短范围）；**曲线为全部 admitted 机器的合计**；桶按 `Asia/Shanghai` 日 / 周 / 月切分；长范围自动按周/月聚合（≤90d 天 / ≤1y 周 / >1y 月；`6m` 同 `1y` 走周，`All` 走月）——**粒度在面板副标题 meta 行可读**（形如 `<range> · <day|week|month> buckets · historical rollup`），选 90d 显示 day、1y 显示 week、2y 与 All 显示 month；footnote 准确说明成本口径：28 天 recompute 窗口内，各 `(day, agent, project, model)` bucket 分别从当前可读源更新。日志中已有精确成本的条目保持记录值；没有精确成本的条目使用 tt-web 当时可用的定价数据推算。某个 bucket 的源缺失，或其 token、消息、条目计数低于此前显示值时，该 bucket 的成本贡献保持最后可信值；其他 bucket 继续更新，因此页面或 project 聚合成本仍可能变化。窗口外的既有 bucket 保持冻结。
- **B4 长范围覆盖提示（边界）**：当所选 range 起点早于最早采集日时，面板显示覆盖提示（如「历史自 <最早日> 起累积；更早未采集」）；range 在数据范围内（如 7d）时不显示该提示，避免误导。**`All`（无界窗口）下覆盖提示恒显示**（其起点恒早于最早采集日）。
- **B5 侧面板**：「Top projects this week」按本周成本排序的项目；「Model mix this month」本月模型 token 构成；两者的**周 / 月边界同为 `Asia/Shanghai`、数据为全机合计**；两者 →Explore 链接带当前 range。

### C. Explore `/explore`

- **C1 自动粒度**：选 90d 默认 x=天、1y（及 6m）默认 x=周、2y 与 All 默认 x=月；用户可手动改 x 维覆盖默认。
- **C2 透视正确**：x 轴 × 分组 × 指标组合产出对应图 + 表；时间维按时间排序，非时间维按值排序。
- **C3 历史全维分组**：长范围（如 2y）下按 project / model / agent 分组，各分组列对应真实数据的 distinct 值（覆盖完整，非只最近窗口）；切指标（cost/token/messages 等）数值随之变化。**高基数维度（distinct >15，如 project=35）自动折叠为 top 12 + 单一「Other」**（Other = 其余项之和，total 不丢）；≤15 的维度（model/agent）全显不折叠。
- **C4 过滤**：四个**单选下拉**（Agent / Project / Model / **Machine** filter），各以「All agents / All projects / All models / All machines」为首项 + 范围内可选值（选项随 range 变化），四者与 x/分组/指标同为原生下拉 `<select>` 控件（非 chips / checkbox / radio 等其他控件；视觉精细度归 F1 人工判断）。选某值后图表/表只含该项；选「All …」首项 = 该维不过滤；当前所选反映进 URL（取「全部」则去掉该参数），深链（如 `/explore?range=2y&agent=codex`）加载后：Agent 下拉显示选中 `codex`、URL 保留 `agent=codex`、图表/表仅含 codex 的 series，**且过滤确实改变数值**——选 `agent=codex` 后某 x 桶值 ≠「All agents」同桶值（单 agent 是全体子集），不接受过滤后与未过滤数值完全相同（防 no-op 过滤）。每维至多一个值（单选）。**边界**：深链值不在当前 range 选项集内时（如 `range=7d` 但带一个仅 2y 才出现的 project），该值仍注入为选项并保持选中过滤（不静默回落「All …」首项）；该值在当前 range 无数据时，图/表区显示明确空状态占位（见 A5：`—` / "no data"，不显伪造 `0`、不报错）——空 `<tbody>` + 仅 "0 rows" 计数不构成合格占位。
- **C5 边界**：长范围 + 多 series 分组时图表/表仍能加载不报错且**可钻取**——高基数维度折叠为 top 12 + Other（见 C3），表宽收敛、图例可读；长路径 project 标签缩短显示（git 仓名优先 / 末段路径），完整路径在 hover/title 可见。
- **C6 预设按钮**：点任一预设（Daily cost / Project cost / Model tokens / Agent by project / Cache read）后，x 维 / 分组 / 指标三个下拉切到该预设对应组合，且图 + 表随之刷新为对应数据。
- **C7 原始日志部分失源时保真**：只在受控副本（不得使用生产库）中，在同一天、同一 agent、同一 model 下准备 project A 与 B，并确保每个 project 只对应一个被观察的 bucket。令 A 的部分或全部原始日志失源后刷新 Overview / Explore：A bucket 显示的 token、消息与条目计数不得低于刷新前，B bucket 的新增计数必须出现；A bucket 的当前源计数低于此前显示值时，该 bucket 的成本贡献保持最后可信值。

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
- **F2 缩放 / 响应式韧性**：浏览器缩放至 125% / 150%（或等价 viewport）、并将窗口收窄至 ~1024px / ~720px 宽时，四页无元素重叠 / 裁切 / 破版；表格过宽时出现**受控横向滚动**而非撑破整页布局（Explore 高基数分组已由 top-12+Other 折叠收敛表宽，见 C3/C5）。**判据含整页不横向滚动**：任一档位下 `document.documentElement.scrollWidth` 不得大于 `clientWidth`——过滤器下拉的宽度取决于容器而非最长选项文本，一条很长的项目路径不得把整页推宽。

### G. 跨机全局视图

> 这一段的概念是本产品独有的（`All` 的范围、数据新鲜度、机器可达性、配额来源）。判据是**使用者不查文档就能看懂**：页面本身要能回答"现在算了哪几台、数据多旧、有没有哪台没连上、配额是谁的、哪些页面只是本机"。

- **G1 `All` 的范围可见**：Overview 与 Explore 顶部显示 `coverage N/M` 与**逐台机器卡片**；另有一句明说当前 `All` 包含哪几台（形如 `All currently includes gpu-box, macbook, macmini`）。**判据**：`N` = 实际计入的机器数，`M` = 声明的机器数；被排除的机器不出现在那句话里，且其数据**不计入**任何 KPI / 图 / 表——把一台置为不可计入后，`coverage` 分子精确减一，且逐 metric 的 `All` 数值恰好减去该机上一次的贡献（**expected-vs-actual，不接受"看起来变小了"**）。
- **G2 每台机器的状态可读**：每张卡片显示机器名、是否计入（`Included in All.`）、可达状态、最近一次同步 / 尝试 / 成功联系的时间、该机数据的生成时间与**起始日**（`data since <date>`）。本机额外标 `This machine`。**判据**：状态词能区分四种处境——正常、正在同步、联系不上但仍用上一份数据、从未成功过因而不计入；"联系不上"与"数据陈旧"是两件事，可同时成立且都要显示。
- **G3 Machine 过滤与拆分**：Explore 的 Machine 下拉以「All machines」为首项，选定某台后图 / 表只含该台，URL 出现 `machine=<name>`，深链保持选中；x 轴或分组选 `machine` 时按机器拆列。**判据**：某台的切片值 + 其余各台切片值 = `All` 同桶值（**逐 metric 相等**）。
- **G4 配额不求和**：Claude 5h / 7d 与 Codex 7d 显示**单一数值**并标注**来自哪一台**，取的是 admitted 机器中该 provider 最近一次更新的那份**原值**。**判据**：页面值等于那台的原值，且**不等于**各台之和；全部机器都取不到时显示不可用 + 原因，**不退回只用本机**。
- **G5 本机专属页面标明范围**：`/sessions` 与 `/network` 明示其内容**仅本机**，其数据范围确为本机。**判据**：页面上有可读的本机标注；不因跨机视图存在而让使用者误以为这两页也是全机的。
- **G6 首屏不等同步**：打开页面时若需要向远端取新数据，**先渲染已有数据并标注正在同步**，不阻塞首屏；同步结束后自动更新。**判据**：首响应时间与同步耗时解耦；任何一台失败都不得让状态永远停在"同步中"——失败的那台落到明确终态并给出原因。

---

## domain 专属验收

L1 判定为**功能型** data-viz dashboard，非 `~/.claude/references/domain-registry.md` 列出的特殊 domain（游戏等）→ **无 domain 专属验收段**。数据可视化的「能钻取到根因 / 跨视图数据一致」已并入 L2（C2/C3 钻取与一致性、A2/A4 跨视图）。

---

## 已知限制（非 fail 项，使用者知情）

- 保真承诺是统计不减少，不是累计始终正确。同一天、同一 agent、同一 project+model bucket 内，如果一个 session 的原始日志消失，而另一个 session 继续增长并超过消失前页面显示的合计，该 bucket 显示的数字仍不会下降，但可能低于两个 session 的真实合计；当前可读源合计不再低于页面显示值后，checker 也可能不再报告 shrink。这通常只发生在 session 仍活跃的当天，但 28 天窗口内的历史日期如果后来收到延迟写入、恢复日志或 backfill source，也可能出现同一序列。
- **UX-003** 原列于此——Explore project 分组长范围过宽表/标签——已通过 top-12+Other 折叠 + 标签缩短解决，见 C3/C5。
- **同名项目跨机相加，无同一仓库的证明**。项目标签先按已知 home 前缀归一（macOS 的 `/Users/me/foo` 与 Linux 的 `/home/me/foo` 同为 `~/foo`），随后**标签相同即合并**。带 git remote 的项目以仓库身份记录，跨机合并可靠；非 git 目录的合并只依据路径字面，没有"这是同一份工作"的证明。按机器拆开看（G3）可确认任一行的构成。
