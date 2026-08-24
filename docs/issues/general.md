# General Issues

> [Agent] `harness-issues.md` 不覆盖的其余问题的 domain 跟踪文件——本仓自身的产品代码 / 安装器（`install.sh` / `verify.sh` / `ask-user-mcp`）缺陷，以及 wrapped-agent 行为问题与工具缺口。Agent harness 自身问题走 [harness-issues.md](harness-issues.md)；**tt-web 子项目的问题走它自己的 `tt-web/docs/issues/`**（该子项目自带 tracker 与 ux-contract），只有跨越子项目边界、影响本仓安装或集成的部分才留在这里。

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

## [open] Quota 表在窄视口把邮箱与套餐名从词中间断开

- **Type**: usability
- **Priority**: low
- **Discovered**: 2026-08-21，Spend/Quota 布局改动的 review gate 中由独立 reviewer 标为越出本轮范围
- **Component**: `tt-web/web/styles.css` `.quota-table` 的 Account / Plan 列
- **Description**: 视口 ≤1100px 时（媒体查询把 `.quota-table` 压到 `min-width: 1040px` 并交给 `.quota-table-wrap` 横向滚动），Account 与 Plan 两列的文本按字符换行而非按词：实测 1000px 下 `account-c@example.invalid` 断成 `account-c@example.inv` / `m`，`account-b@example.invalid` 断成 `account-b@example.inv` / `z`，`Max 20×` 套餐 pill 内部也断成两行、pill 形状随之变成一个不规则的椭圆。邮箱是这张表里读者用来**认出是哪个账号**的那一列，从中间断开正好破坏它的识别功能。
- **可区分性**: 只在窄视口出现；宽视口（≥1200px）下三列均不换行，看不出来。不产生任何错误或告警。
- **候选修法**: 给这两列 `overflow-wrap: normal` / `word-break: keep-all`，让它们随表格的既有横向滚动而不是压缩；pill 另加 `white-space: nowrap`。需同时确认不会让 `min-width: 1040px` 之下的滚动条出现在意料之外的断点。
- **Notes**: 与 2026-08-21 那轮改动（Spend 三卡 + 5h/7d 列序调换）无关，撤回该轮也不消失，故未就地修。

## [resolved] ux-contract B3 的「长范围数据跨度严格大于短范围」在本机四档 range 上恒不成立

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-21，Spend/Quota 布局改动的 review gate 复核轮，由独立 reviewer 与本机实测共同确认
- **Component**: `tt-web/docs/contracts/ux-contract.md` B3
- **Description**: B3 要求「按所选 range 取数、随 range 变化（**长范围数据跨度严格大于短范围**）」。但 rollup 起点是采集起始日（本机 2026-04-21），凡窗口起点早于该日的 range 取到的都是同一段数据。2026-08-21 实测 `/api/overview?range=<r>&sync=0` 的 `range.cost_usd`：`7d` 12712.86 / `30d` 54168.85 / `90d` 106607.06 / **`6m`=`1y`=`2y`=`All` 均为 109573.57**（tokens 同样四档相同）。用后四档中任意两档验 B3 必然判 FAIL，而此时"跨度不变"是正确行为。
- **可区分性**: 只有把判据与 `rollup_coverage.earliest_date` 对读才能发现；单看一次失败的验收结果，最省事的"修复"是去产品代码里找一个并不存在的 bug。
- **候选修法**: 同 B2b 已采用的写法——判据里点名可分的取值对（本机 `7d`↔`30d`↔`90d`），并写明后四档在本机不可分及其原因。本文件头部已补一条通用的「写判据的硬规则」。
- **Resolution**: 2026-08-21 已修（B3 判据点名可分的四档 `7d`⊂`30d`⊂`90d`⊂`6m`，并写明另四档两两同跨度、六对全验不出递增）。修的过程中发现比原缺陷更坏的一面：`1y`↔`2y` 跨粒度比较时，周桶标签 `2026-04-20` 与月桶标签 `2026-04` 字面上后者更早，照桶标签比会读出「跨度增大」而**判 PASS**——假通过没有下游会发现。判据里已写明跨粒度不得用桶标签比跨度。

## [open] 配额行按账号跨机聚合时，只有"最后导出的那一台"参与 plan 比对，且没有字段说是哪一台

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-08-22，plan snapshot-consistency 改动（ADR 20260822-586a）的 `/custom:review-schema` 中由 §1/§2/§8/§9 四个独立 reviewer 各自命中
- **Component**: `tt-web/server.py` `_live_rate_limits_from_admission`（按 `account_id` 分桶、`bucket["latest"]` 只留 `updated_at` 最大的单个块）→ `_account_entry`
- **Description**: 一行 = 一个账号，可由 N 台机器供稿，但 entry 的全部取值来自胜出的那**一个**块，`machines` 却列出全部主机名。于是 `credential_plan`（按 G4f 定义是"该读数所在机器的凭据"）指的是一台**未具名**的机器，而读者面前列着两台。实测：Codex 账号同时在 gpu-box 与 macbook 上，Claude 账号同时在 macbook 与 macmini 上。更实的后果是 plan 不一致标记**会随哪台机器最后导出而闪烁**——另两台跑旧 exporter、块里没有这两个字段，它们一旦后导出，该行的 plan 对翻回 `(null, null)`、标记消失，而两个来源其实仍然不等。
- **可区分性**: 单机视角完全看不出来；要同一账号登录在 ≥2 台机器、且它们 exporter 版本不同才显形。标记消失与"问题已解决"在页面上同形。
- **候选修法**: `_account_entry` 增一个点名胜出块来源主机的字段（`this_machine` 已有先例），不一致文案引用它；或把比对面扩到该账号的全部块取并集。**后者追溯不到用户表达的目标，也追溯不到既有契约**（G4f 与 ADR 都只谈单行的两个来源），按「非功能属性不自行加码」不作为推荐，需先交用户裁决。至少要把"该值只来自最新导出的那一台"写进 G4f 的作用域。
- **Notes**: 这条**跨两半，归属不同**（生成后 review gate 复核轮的分类修正）：「不点名胜出机器」**独立**——聚合逻辑是既有的，撤回 ADR 20260822-586a 后依然成立；「plan 不一致标记随混合版本的胜出机器闪烁」**依附本轮**——那个标记是本轮加的，撤回即不再成立。后半按 MEDIUM 列给用户、不阻塞放行，前半独立留账。

## [open] 账号记忆里 plan 为 null 会不可恢复地覆盖真值，且记录形状校验堵死任何补救字段

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-08-22，同上一条，由 §7 reviewer 经生产写入口 `_upsert_account_memory` 实测
- **Component**: `tt-web/server.py` `_account_memory_entry` / `_upsert_account_memory` / `_valid_account_memory`；`tt-web/state/account_memory.json`
- **Description**: 实测三步：`upsert(plan="pro", 01:00)` → 记忆 `"pro"`；`upsert(plan=None, 02:00)` → 记忆 `None`（更新的观测把真值覆盖成空）；`upsert(plan="pro", 01:00)` → 被 strictly-newer 拒绝，**回不来**。记忆不可再生（ADR-026/027），而它存在的全部理由正是那些不会再登录的账号——对它们漏填 = 永久为空。同时 `None` 一值兼任"该账号确实没有 plan 概念"与"这次没读到"。补救受阻于 `_valid_account_memory` 的 `set(record) != _ACCOUNT_MEMORY_ENTRY_FIELDS` 精确集合相等：任何新增字段会让整份 payload 判 `unreadable_or_unsupported`、全部 remembered 账号消失。
- **可区分性**: 不产生任何错误；页面上一个空 plan 与"这个账号本来就没 plan"完全同形。
- **候选修法**: 先把校验从精确集合相等换成"九个必需字段全在 + 容忍未知键"，或升 `_ACCOUNT_MEMORY_VERSION` 并让 `_load_account_memory` **迁移** v1 而非判整份不可读；载体打开后再给 plan 一个显式未知态。**不要**改成"candidate 的 plan 为 None 时保留旧值"——那会让 plan 与同记录的 `observed_at` 不同源，直接违反 ADR-027 的 record-time invariant。
- **Notes**: 先于 ADR 20260822-586a 存在，撤回该改动不消失。

## [open] 混合 exporter 版本期间 `account_plan` 两种口径在同一张表上并存，无字段可辨

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-22，同上一条，由 §2/§6 reviewer 各自命中并以 `/api/sync-status` + `/api/overview` 现场读数确认
- **Component**: `tt-web/exporter.py` `_rate_limit_block`；`tt-web/server.py` `_account_entry`
- **Description**: ADR 20260822-586a 把 `account_plan` 的语义从"凭据 plan"改为"读数优先"。三台机器 exporter 不同步升级、provider 块内无版本概念，于是升级过渡期内同一列会并存两种口径：新 exporter 供稿的行是读数值，旧的仍是凭据值。同一行的 Plan 值可能仅因为某台机器的 exporter 版本变化而从 `Pro Lite` 变成 `Pro`，而账号没变。服务端已改为从两个原值重算（本轮已修），所以矛盾三元组不会显示，但"这一行是哪种口径"仍无字段承载。
- **可区分性**: 全部机器升级完成后自然消失；期间无任何报错。
- **候选修法**: 给 `account_plan` 配一个取值收敛的伴生字段（`account_plan_basis: reading | credential | unknown`），在同处派生。记忆侧受精确集合校验限制，需先解上一条。
- **Notes**: **依附本轮**——正是这一轮改变了 `account_plan` 的语义（复核轮的分类修正，此前误标为独立）。刻意不做：它是过渡期现象，全部机器升级后自然消失，且伴生字段受账号记忆的精确集合校验所限进不了记忆，做一半反而制造新的不可辨状态。按 MEDIUM 列给用户、不阻塞放行。

## [open] `QUOTA_PLAN_LABELS` 多对一映射会让 plan 不一致文案自相矛盾

- **Type**: bug
- **Priority**: low
- **Discovered**: 2026-08-22，同上一条，由 §1/§4/§8 reviewer 命中
- **Component**: `tt-web/web/app.js` `QUOTA_PLAN_LABELS` 与 `quotaPlanCell`
- **Description**: 判等在原值上做（`reading !== credential`），呈现经过标签映射，而映射是多对一的（`default_claude_pro` 与 `pro` 都→`Pro`）。同 provider 取值域内一旦出现两个映射到同一标签的键，页面就会显示「plan 不一致 · 配额读数 Pro / 机器凭据 Pro」——渲染层自相矛盾，而写入端与判等层都是对的。八个键里只有 `default_claude_max_20x` / `pro` / `prolite` 有实例支撑。
- **可区分性**: 当前不可触发（Claude 的 `reading_plan` 恒 null，该文案只在 Codex 行出现），所以是潜在而非已发生。**但归属是依附本轮**——比较与那句文案都是这一轮加的（复核轮的分类修正）；「当前触发不了」不改变归属。
- **候选修法**: 渲染该文案时若两侧标签相等而原值不等，退回显示原值（三行，与判等同层）。

## [open] im-notify skill 依赖的 CLI 不在本仓，新机器装完即不可用

- **Type**: bug
- **Priority**: medium
- **Discovered**: 2026-08-24，sync-from-upstream 同步后的文档起草 review
- **Component**: `claude/skills/im-notify/SKILL.md`（`allowed-tools: Bash(im-notify:*)`）、`im-notify/README.md`
- **Description**: 上游 `im-notify/` 是完整 CLI 工程（`bin/`、`install.sh`、两个测试文件），本次同步只按用户批准收录了 skill 与 README——skill 指向的 `im-notify` CLI 二进制不在仓内，根 `install.sh` 也不安装它。消费者装完本仓后该 skill 一调用即失败。
- **候选修法**: 用户已裁决（2026-08-24）：不补 CLI、维持现状并记本条。需要该能力时从上游获取 `im-notify/` 整目录，或后续同步时重新评估纳入。

## [open] 四个 claude/bin 探针的 .test.py 不被任何测试入口执行

- **Type**: coverage gap
- **Priority**: low
- **Discovered**: 2026-08-24，sync-from-upstream 第 5 步测试入口盘点（doc-updater 起草时复核）
- **Component**: `claude/bin/{first-screen-density,page-repetition,visual-budget,interaction-latency}.test.py`
- **Description**: 仓内三个自动测试入口（`npm test`→run-tests.sh 只枚举 `*.test.js/.mjs`；根 `tests/` 的 unittest discover；tt-web 套件）都不收集这四个 python 测试。直跑实测 `first-screen-density.test.py` 3 分钟未跑完（重探针），其余未验证——「探针测试存在且绿」目前是未核实状态，无 runner 覆盖它。
- **候选修法**: 给 run-tests.sh 或 `tests/` 入口加一个 python 探针测试收集层（注意 first-screen-density 的时长，可能需要单独的超时档或标记为慢测试跳过常规入口）。
