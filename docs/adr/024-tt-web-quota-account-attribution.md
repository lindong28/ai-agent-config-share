# ADR-024: tt-web 配额按账号分组，归属采用"最新读数属于当前登录账号"这一被 waive 的假设

- 状态：accepted（2026-08-19）
- 决策评审：独立 Codex reviewer（`decision-review`），2 轮完整 gate 均判**不放行**（首轮 4 blocker、次轮 6 blocker，出口皆「交用户」）；第三版方案由决策作者在送审途中**自行证伪**并撤回评审。最终由用户按处置表的 **waive** 一支拍板：带着已知的归属风险原样落地
- Component：`tt-web/parsers/`、`tt-web/exporter.py`、`tt-web/server.py`、`tt-web/web/`、`tt-web/docs/contracts/ux-contract.md`
- 关系：改写 ux-contract **G4「配额不求和」**；触及 ADR-002 划定的 provider 选值规则

## 背景

tt-web 的 Overview 用三张 KPI 卡显示 Claude 5h / 7d 与 Codex 7d，取值逻辑是 `server.py` 的 `_rate_limits_from_admission`：每个 provider 遍历全部 admitted 机器，只保留 `updated_at` 最大的那一块。该逻辑隐含"所有机器同一账号"这个假设，从未被写下，也从未被校验。

用户报告 Codex 7d 显示 100%，而他刚在本机换了账号、新账号用量远低于此。实测三台机器：

| 机器 | Codex 当前登录账号 | Codex 7d | Claude 当前登录账号 | Claude 7d |
|---|---|---|---|---|
| macbook | `maintainer@example.invalid` | 1.0% | `maintainer@example.invalid` | 86% |
| macmini | `account-b@example.invalid` | 89.0% | 同左 | 79% |
| gpu-box | `account-b@example.invalid` | 82.0% | 同左 | 79% |

Codex 是**两个独立配额池**，于是"哪个数字被显示"取决于哪台机器最近跑过。Claude 三台是**同一账号**（`accountUuid` 相同），79/79/86 是同一计数器的三次观测——所以显示单位既不能是 provider，也不能是机器，只能是账号。

## 核心发现：日志里不存在能把读数绑定到账号的信息

三个归属方案先后被否，失败方式相同——**判据在归属正确与错误时输出相同**：

| 方案 | 判据 | 被否原因 |
|---|---|---|
| v1 | 观测时间戳 ≥ 换号检测时刻（账号水位线） | **残留 session**：换号前启动、仍在运行的 session 继续写带换号后时间戳的记录（`docs/issues/harness-issues.md:4076` 已实测：同一时刻全局聚合值 100%、目标 session 实为 4%） |
| v2 | session 起始时间 ∈ 账号历史区间 | 账号历史记的是**检测时刻**而非**切换时刻**。`t0` 导出见旧账号 → `t1` 真实换号 → `t2` 新账号 session 启动 → `t3` 下次导出才检测到，则 `t2` 被归给旧账号；而真实切换在 `t1` 还是 `t3`，系统状态完全相同。另：无证据表明 session 会持续使用启动时凭据 |
| v3 | 按 `seven_day_resets_at` 分池 | **决策作者自行证伪**：扫 3259 个 session 文件、3203 条带锚点的观测，该值以 ±1 秒抖动（`1787723056`/`…057` 反复交替）、随用量漂移（同账号一小时漂 75 分钟、跨天漂 0.934 天）、且会向后跳。它编码的是"最老用量还有多久滚出窗口"即**用量新近度**，与账号身份无关 |

根因：Codex rollout 的 `session_meta` 字段全集为 `session_id / id / timestamp / cwd / originator / cli_version / source / thread_source / model_provider / base_instructions / history_mode / context_window / git`——**没有账号身份锚**。`harness-issues.md:5540 ④` 有同样记载。

**v3 的证伪过程本身是一条教训**：作者最初的"证据"是"两台机器在相近时刻报出精确到秒相同的锚点"。该观察在"锚点是账号级稳定量"与"锚点是此刻恰好相同的滚动值"两种假设下**输出相同**，作者把一次正面读数当成了确认，未测替代解释。这正是 `~/.claude/references/evidence-sufficiency.md` 要挡的形态。

## 决策

**归属规则：某台机器的最新读数，归该机器当前登录的账号。** 不做任何推断层——没有水位线、没有 session 起始判定、没有锚点聚类。

1. exporter 在每台机器上读当前登录账号（Codex `~/.codex/auth.json` 的 `tokens.account_id` + id_token 的 `email`；Claude `~/.claude.json` 的 `oauthAccount.accountUuid` / `emailAddress`），写进该 provider 的 `rate_limits` 块。
2. server 按 `(provider, account_id)` 归组，组内取 `updated_at` 最新的观测，并累积报告贡献该账号的机器名。
3. UI 把三张配额 KPI 卡换成按账号分组的列表：账号邮箱、5h/7d、重置时间、在用机器、观测新鲜度。
4. Schema 变更**只在 `rate_limits` 的 provider 块内部可加**，不动顶层字段、不升 `schema_version`（理由见「作用域」）。旧 exporter 的块无账号字段 → 归入具名占位条目「该机 tt-web 待更新，账号未知」，不并入任何已知账号。

被否决的其余方案：**合成探针**（exporter 每次导出用当前凭据起一次极小 Codex 调用，产出按构造绑定到当前账号的读数——唯一可证正确的做法，但每台每次刷新消耗真实额度与一次 API 调用，且 Claude 侧无对应物）；**逐机列出 + 明标不可归属**（Claude 三台退回逐行，同一计数器渲染成三份）；**按机器逐行**；**什么都不改**。

## Waive：已知且被接受的风险

用户原话：「你可以就假设一个机器上的最新读数属于这个机器上的当前登录账号。我理解他们可能不 match，但我接受这点作为已知风险。」

被 waive 的具体缺陷（两轮评审的 blocker 合流）：**换号后、该机产生新账号的第一条读数之前，页面会把上一个账号的数字挂在新账号的邮箱下**。评审判据 7 的定性仍然成立且未被消解——错误归属呈现为一条结构完整、时间新鲜、数值合理、带真实邮箱的记录，**没有任何不变量能揭露它**，只有掌握外部真实额度的人碰巧比对时才可能发现。

风险窗口的长度取决于该机多久跑一次该 agent；两侧都会在下一次真实使用后自愈（Claude 的 `tt-status.json` 每轮重写，Codex 每次 API 调用追加 rate_limits）。

缓解（不消除）：UI 显示观测新鲜度，使一条陈旧读数至少**可见为陈旧**。这不解决归属错误，只让它更容易被察觉。

## 作用域

- 归属结论只在"该机最新读数确由当前登录账号产生"这一被接受的假设下成立；该假设为假时页面给出错误的账号名。
- 只覆盖这两个 provider 与这两种凭据文件布局（Codex `auth_mode=chatgpt`；Claude `~/.claude.json` 的 `oauthAccount`）。不覆盖 `OPENAI_API_KEY` 模式、企业 SSO 换 org 而 `accountUuid` 不变的情形。
- **不升 `schema_version`**：`GenerationValidationError` 继承自 `GenerationError`（`generation.py:84`），`_evaluate_generation_admission` 把它归入 `exclusion_reason="invalid_generation"` 并**整台机器不予计入**（`generation.py:625-629`）。因此升版本的后果不是"配额不可用"，而是每台机器在重新导出前从**所有**视图消失（成本、session、图表），爆炸半径远大于它要解决的问题。顶层字段同样不动：`exporter.py:152` 与 `generation.py:855` 是精确集合相等，加顶层字段会双向 hard fail；`rate_limits` 内部只有 `isinstance(dict)`（`exporter.py:160`、`generation.py:866`），可加变更双向安全。

## 实现期的 review gate 改掉了什么

生成后 review gate（中档，独立 context 对抗审）报了 5 个 MEDIUM，全部就地修复：

- **`account_known` 把两种"无账号"合并了**：exporter 对已登录但读不到账号的机器写 `account_id: None`（键在），旧 exporter 则整个键缺席——服务端用 `.get()` 读，两者塌成同一态，于是一台版本最新、只是未登录的机器会被告知"去更新 tt-web"。现改为三态 `account_state: known | signed_out | unstamped`。
- **非法 `account_id` 会 500 掉整个 Overview**：`rate_limits` 内部无校验（这正是免锁步升级所依赖的宽松），而新代码把该字段用作 dict key。一台机器的坏字段会连带打掉成本、图表、同步状态。现按"不是可用 id 就读作 None"处理，代价止于它自己那一行。
- **同一字段在 JS 侧 `.slice` 抛错**，且失败形态更坏：`renderQuotaAccounts` 在图表之前跑、`renderOverview` 无 try，异常逃逸成 unhandled rejection——配额区空白、下方全部冻结在上一次渲染，而 `showOverviewLoadError` 不会触发（fetch 是成功的）。已加类型守卫。
- **naive/aware 时间戳比较 TypeError**（pre-existing，但本次重写了该函数并新增了第二个比较点）：Codex rollout 的时间戳是 tz-naive、Claude 的带偏移，两个比较点都跨机器，所以一台 naive 会打掉所有机器的配额。新增 `_observed_at` 归一。
- **标题与数值极性相反**：区块标题是 "Quota remaining"，而每个数字都来自 `used_percent`——89% 是用掉 89%、剩 11%。标题是旧的，但按账号分行**正是在邀请读者比较 1% 与 89% 来决定用哪个账号**，标题决定这个比较的方向。改为 "Quota used" 并写明"越低越有余量"。

另修两条 LOW：`.unattributed` 的视觉差异此前实际不可见（`--line-soft` 虚线在 sunken 底上看不出来），而它是 waive 风险**唯一的**补偿控制——现改为虚线 + 透明底 + 灰值，并对超过 6 小时的读数加 `may predate a sign-in change` 标记；`parsers/accounts.py` 此前零测试，而它的失效恰好伪装成"预期的 legacy 状态"，现补 `tests/test_account_identity.py`（含"凭据不得随账号字段外传"的断言）。

**一条已知、未处置的 LOW**：`account_label` 是真实邮箱，而 `tt-web` 启动器把服务绑到 `0.0.0.0` 且无鉴权，所以邮箱与 plan 现在同一 LAN 可读。判断是该端点本就暴露项目路径、session id 与成本，邮箱的边际暴露与既有内容同量级；要收紧则在渲染层做掩码即可。

## 已知未验证项

- 归属假设本身按定义不可验证（若可验证就不需要 waive）。
- **残留 session 现象未在本机取到阳性样本**：换号后至今只有一个真正产生过轮次的 session，且它启动于换号之后。v1 被否的依据是 `harness-issues.md:4076` 的既有实测记录，非本轮复现。
- `load_rate_limits()` 的外部消费者未清点。`harness-issues.md:5540` 显示至少有一个消费者直接 import 该模块的私有函数（`_extract_latest_rate_limits` / `_load_thread_models` / `STATE_DB`）。
- `~/.claude.json` 全量 JSON parse 的耗时未测（该文件是 Claude Code 的状态库）。
- `tt-status.json` 是全局单文件、多 session last-writer-wins（本轮实测其 `session_id` 在两个并发 Claude session 间切换过）；不影响同账号归属，但"最新观测属于哪个 session"不稳定。
