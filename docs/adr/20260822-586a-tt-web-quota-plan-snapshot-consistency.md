# ADR 20260822-586a: tt-web 配额行的 Codex plan 取自配额读数自身，并显式呈现两个 plan 来源的不一致

- 状态：accepted（2026-08-22）；decision-review 1 轮全审（1 blocker + 4 应修）+ 3 轮复核逐项闭合，第 4 轮通过放行。第 3 轮后修复轮预算判据触发（连续两轮新 finding 全部可追到本方上一轮修复），由用户裁决「第 4 轮收口」——该轮无剩余 finding，收口未消化任何未闭合项
- Component：`tt-web/parsers/__init__.py`、`tt-web/parsers/codex.py`、`tt-web/exporter.py`、`tt-web/server.py`、`tt-web/web/app.js`、`tt-web/tests/`
- 关系：建立于 [ADR-024](./024-tt-web-quota-account-attribution.md) 的账号归属规则与其 §作用域 的 schema 约束；**不 supersede、refine 或 amend 它**。相关 [ADR-026](./026-tt-web-account-memory.md) / [ADR-027](./027-account-memory-record-time-invariant.md) 的账号记忆写入路径

## 背景

用户在 macbook 上把 Codex 账号从 `account-b@example.invalid` 换成 `maintainer@example.invalid`，随后把后者升级到 Pro。Overview 的配额表先后出现两种组合：

1. 账号列已是 `maintainer@example.invalid`，7d used 仍是前一账号的 93%。
2. 账号列 `maintainer@example.invalid`、7d used 已是 0%，Plan 列仍是 `Pro Lite`。

用户表述：能接受"稍微 outdated 但在某个时刻曾经正确"的组合，不能接受把另一来源、另一时刻的值当成这一行此刻的值。他称这个性质为 snapshot consistency。

现象 1 是 ADR-024 §Waive 逐字记载并由用户拍板接受的窗口。**现象 2 不在那份 waive 内**，此前从未被识别。

## 根因

`exporter.py` 的 `_rate_limits()` 把配额行拼成一条记录，两半来自两个独立时钟：

- **读数**（`codex.load_rate_limits()`）：全部 rollout 里最新一条 `token_count` 事件，时刻 = 上次 Codex 真正跑过。
- **身份**（`accounts.codex_account()`）：现读 `~/.codex/auth.json` 的 id_token claim，时刻 = 现在。

`server.py` 的 `_account_entry` 原样铺成一行。Plan 属于身份那一半，used 属于读数那一半，两者从不同步。

## 核心发现：读数自己带 plan

Codex rollout 的 `token_count` 事件里，`rate_limits` 对象**同时含 `plan_type` 与 used 百分比**。2026-08-22 本机实测：

| 来源 | plan | 其他 | 时刻 |
|---|---|---|---|
| `~/.codex/auth.json` id_token `chatgpt_plan_type` | `prolite` | email `maintainer@example.invalid` | mtime `00:47:27Z` |
| 最新 `token_count` 事件的 `rate_limits` | `plan_type=pro` | `primary.used_percent=0.0`、`window_minutes=10080` | `00:58:29Z`（独立复核 `01:02:59Z`，同值） |

全仓 `grep plan_type` 只命中 `parsers/accounts.py:59`（读的是 auth.json 那个）与一处测试 fixture——**读数侧的 `plan_type` 此前从未被任何代码或文档读过**。

**注意时间方向**：读数比凭据**晚** 11 分钟。评审首轮的 blocker 正是钉这一点——"两个 plan 不相等"只能证明两个来源的值不同，**不能判断谁更旧**，更不能判断账号归属；本轮样本恰好与"读数早于当前登录状态"这一初稿断言相反。

## 决策

**D1**：Codex 行的 `account_plan` 取自配额读数自身的 `plan_type`（必须是非空字符串），否则回退到该机凭据解析出的 plan。

**准确的说法是「同一个事件」，不是「同一次观测」**（生成后 review gate 的 HIGH finding）：`parsers/codex.py` 的 `_build_rate_limits` 在某个窗口自己的 `resets_at` 已过去时，会把该窗口的百分比改写为 `0.0`，而 `updated_at` 与 `plan_type` 仍是原事件的。所以窗口重置之后，那个 `0%` 是此处推算出来的、并非在 `updated_at` 那一刻被观测到。若套餐恰在该窗口内发生变化，就会重新出现「旧 plan + 后来推算的 0%」——**正是 D2 要暴露的那种配对**：套餐变了正是让两个来源取值不同的原因，因而该行会打上不一致标记。残余不可见面：套餐变了而凭据文件也同样陈旧时，两边仍相等、标记不触发。

**D2**：provider 块新增**两个原值字段**——`reading_plan`（读数自己报的 plan）与 `credential_plan`（该机凭据解析出的 plan，已过 `parsers/accounts.py` 的 `_text` 非空字符串校验，不是文件里未经处理的原始字节）。下列三条**同时成立**时，该 `in_use` 行显示可见文字「plan 不一致 · 配额读数 `X` / 机器凭据 `Y`」：

1. `account_state == "known"`；
2. `reading_plan` 与 `credential_plan` 均为非空字符串；
3. 两者不相等。

任一不成立即不标记，**且不因此声称一致**——那是「无从比较」。

**为什么比较的是两个原值、而不是 `account_plan` 与 `credential_plan`**（生成后 review gate 的 HIGH finding）：`account_plan` 是派生值，读数无 plan 时它回退成凭据值，于是「只有一个来源」在 wire 上与「两个来源恰好相同」**逐字节相同**，拿它去比等于拿凭据和自己比、永远不会不等——失败形态与正常工作完全同形。两个原值并存才让三态可恢复。

**渲染层的取舍**：「无从比较」与「两者相同」在**版面上**同为静默，这是有意的——读数侧无 plan 的 provider（Claude）会让每一行永久挂一条「无法比对」，那是噪声不是信息。静默在此处是**不作主张**，不是主张一致；区分留在 payload 里。契约见 `tt-web/docs/contracts/ux-contract.md` 的 **G4f**。

**可见文字而非 title**（同一轮 finding）：hover 在触屏与键盘路径上不是通道，而需要这条信息的恰是那个否则会把整行读成一次观测的读者。所以「不一致」三个字与两边取值都在单元格里。

标记的两边都是原值，它是等式的直接呈现，不构成 ADR-024 禁止的推断层。

实现约束（承自 ADR-024 §作用域）：字段只加在 `rate_limits` 的 provider 块内部，顶层字段与 `schema_version` 均不动。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| 什么都不改 | 现象 2 是一条结构完整、无从分辨的错误记录；用户判定不可接受 |
| 刷新 auth.json 的 plan claim | 不可实现：该 claim 只随 Codex CLI 的 token refresh 更新，tt-web 无法也不该触发。且刷新只缩小窗口，不消除"两个时钟拼一行"的结构 |
| 账号水位线抑制（读数早于当前账号首现时刻则不显示） | ADR-024 的 v1 已被"残留 session"证伪：换号前启动、仍在运行的 session 会写出带换号后时间戳的记录。需新增持久状态，换来部分收窄。用户在选项中否掉 |
| 从读数侧根治账号归属 | 不可行：cli_version 0.148.0 的 `session_meta` 18 个字段（`agent_nickname / agent_path / agent_role / base_instructions / cli_version / context_window / cwd / git / history_mode / id / model_provider / multi_agent_version / originator / parent_thread_id / session_id / source / thread_source / timestamp`）**仍无账号锚点**，本轮复核 |
| 标记写成"账号可能不对"或"读数早于当前登录状态" | 撒谎。本机样本里读数反而晚于凭据，且 plan 不一致完全兼容"同一账号刚升级套餐"。可断言的只有两个值不相等 |
| 把不一致标志持久化进账号记忆 | 代价过高：`server.py` 的 `_valid_account_memory` 用 `set(record) != _ACCOUNT_MEMORY_ENTRY_FIELDS` 精确集合相等校验记录形状，任一记录多一个字段即让整份 payload 判 `unreadable_or_unsupported`，**全部 remembered 账号从页面消失**，而记忆不可再生 |

## 作用域

- **D1 只对 Codex 有语义**。Claude 侧读数源 `~/.claude/tt-status.json` 的 `rate_limits` 只有 `five_hour / seven_day`，不含 plan 也不含账号；Claude 行的 plan 仍来自 `~/.claude.json` 的 `organizationRateLimitTier`——**同类不一致在 Claude 侧继续存在且不可检测**。
- **wire 上两个 provider 各多两个字段**（`reading_plan` 与 `credential_plan`）。`_rate_limit_block` 是 provider 无关的共享函数，不加 provider 参数、不做条件写字段（条件出现会让「缺席」与「null」不可分辨）。Claude 块因而**不是**逐字节不变；但其 `account_plan` 与 `credential_plan` 恒相等，标记在 Claude 行永不触发。
- **D2 的检出面只覆盖两侧 plan 取值不同的情形**。两个同 plan 账号之间换号、同账号同 plan 下的任何陈旧读数，都检不出。它把一部分不可见错配变成可见，**不消除**。
- D2 只作用于 `in_use` 行；账号记忆不加字段、`_ACCOUNT_MEMORY_VERSION` 不动（`_account_memory_entry` 的九字段投影保证 `credential_plan` 不进记忆）。`remembered` 行不显示该标记，也不因此声称一致——其历史身份已由 ux-contract G4a 要求的「已登出 + 最后观测时刻 + 不代表当前状态」承担。
- `unstamped` 与 `signed_out` 两态均不触发标记，账号分组逻辑未改，G4a④ 与 G4d 的折叠 / 逐机展开 / 低余量警示均不依赖该标记。
- 不覆盖 `OPENAI_API_KEY` 模式（无 id_token，`accounts.codex_account()` 返回 None）。
- **不改变 ADR-024 的归属规则**：读数仍归该机当前登录账号，现象 1 的 waive 继续有效。

## 接受的不可逆性

D1 会把新来源的 `account_plan` 写进账号记忆（`server.py` 的 `_account_memory_entry`），而记忆不可再生——回滚代码不还原已被覆写的 plan 字符串。接受理由：新值与该行的用量取自**同一个事件**（重置归零那一支除外，见 D1）；这不主张它的账号归属正确，归属仍受 ADR-024 的 waive 管辖。

**不主张自愈**：只有当此后出现一条更新的、按 ADR-024 规则归到该 `account_id` 的观测时，该记录才会被重写；ADR-024 已实测残留 session 可能产出带更新时间戳的旧账号读数，因此不保证必然重写，也不保证重写进去的值归属正确。

## 已知未验证项

- `plan_type` 的取值域未清点。只实测到 `"pro"`。`prolite` / `plus` / `team` / `enterprise` 在读数侧是否同拼写、是否可能出现前端 `QUOTA_PLAN_LABELS` 缺失的键，未测（`quotaPlanLabel` 对未知键原样回退，后果是显示未美化字符串——该推断本身亦未实测）。
- `plan_type` 是否恒在未验证。只知近 40 个 rollout 的聚合里有该键；旧 cli_version 写的事件未测。**回退分支未取到阳性样本**。
- `plan_type` 的时效性只有一次观测。本次与"读数侧及时、凭据侧滞后"一致，但不排除两者都滞后、只是长度不同。
- 只在 macbook / cli_version 0.148.0 实测；macmini / gpu-box 未查。
- D2 标记会否长期常亮：**本轮取到一次读数，不再是完全未验证**。凭据侧的 plan claim 在 `2026-08-22T02:40:05Z` 由 Codex CLI 的 token refresh 更新为 `pro`，即滞后于读数（`00:58:29Z` 已报 `pro`）约 **1 小时 53 分**后自行追平。一次观测，不足以推出刷新周期——但它说明该窗口有界、标记不必然常亮。

## 交付后仍欠的观察

- **不一致态从未在真实页面上被看到。** 交付时页面读数为 `Codex | Pro | <账号> | n/a | 6%`，标记正确地不出现——因为上述自愈使两个来源此刻相同。触发条件：下一次两侧真正分歧时（改套餐，或在某台读数陈旧的机器上换号）该行应出现「plan 不一致 · 配额读数 X / 机器凭据 Y」。
- **已接地的三态**（2026-08-22 交付时的真实页面与 payload）：`两个来源相同`（本机 Codex 行 `reading=pro / cred=pro`）、`一个来源`（Claude 行 `reading=null / cred=Max 20×`）、`零个来源`（旧 exporter 供稿的行，两者皆 null）。三者版面上均静默，与 G4f 一致。
- ADR-024 遗留的「`load_rate_limits()` 外部消费者未清点」仍未清点；`RateLimits` 加带默认值的字段对那些消费者的影响未实测。
- 残留 session 现象本轮未复现，沿用 ADR-024 的既有记录。
