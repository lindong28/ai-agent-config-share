---
name: resolve-issues
description: 围绕一个目标批量解决项目 issue：先按目标 triage（核实存在性 + consumer 是否落在目标 scope，回写陈旧项），用户批准后按依赖顺序委派 agent 逐个解决并闭环回灌新 issue。触发：显式 `/custom:resolve-issues [--source <path>] <目标>`。
argument-hint: "[--source <issues 路径>] <本轮目标，如 '准备产品上线'>"
disable-model-invocation: true
origin: 2026-05-31
---

# resolve-issues

入口 command：把"为一个目标盘点 issue → 核实哪些真该解决 → 按依赖顺序委派合适的 agent 解决 → 新 issue 回灌本轮"压成一条命令——Claude 与用户在"本轮目标需要解决哪些 issue"上对齐，再监督委派的 agent 把它们逐个收敛，直到 in-scope 集清空才交还用户。

## 何时使用
- 显式 `/custom:resolve-issues [--source <path>] <目标>`
- 有一批已知 issue（典型：`docs/issues/*.md`），要围绕某个目标（上线 / 某里程碑 / 某质量门）成批解决
- 不要执行：
  - 只有单个明确 issue 且已知怎么做 → 直接 `/custom:supervise --backend codex <task>`（simple）或 `/custom:create-plan` + `/custom:execute-plan`（complex）——成批 triage 是冗余
  - 纯查询"有哪些 issue / 该不该修 X" → 直接回答，不要付编排 overhead

---

## 用户期望的收益（按优先级）

源对话拍过的 ranking，下游取舍按这个顺序：

1. **按目标 triage**：只解决该目标真正需要的 issue——先核实存在性 / 描述 / consumer（受益方：user / developer / agent），剔除陈旧项和 out-of-scope，不在不相关或已解决的问题上浪费 agent
2. **按依赖顺序编排解决**：每个 issue 用合适的 agent（simple → codex 直接；complex → claude `create-plan` 对齐设计 + codex `execute-plan`），supervisor 裁决质量
3. **闭环回灌**：解决过程中新产生的 issue 按同一目标重新 triage，决定是否纳入本轮，直到 in-scope 清空

## 输入契约

| 形态 | 处理 |
|---|---|
| `<目标>`（自由文本，如"准备产品上线，解决影响 user + developer 体验的 issue"） | 进入主流程 |
| 目标缺失 / 过于模糊（无法判断哪些 consumer 类 in-scope） | mid-flow `AskUserQuestion` 锁定——goal 决定哪些 consumer 类纳入，silent default 会整轮 mis-scope |
| `--source <path>` | 覆盖默认 issue 来源 |
| 未传 `--source` | 默认扫当前项目 `docs/issues/*.md`（`~/.claude/references/docs-organization-protocol.md` 约定） |
| 空目标 / 仅参数 | 拒绝执行；提示用户给出本轮目标 |

---

## 主流程（lens，不是步骤清单）

### 阶段 A：分析与定位（主 session + 用户）

下面三个 **facet 不是顺序步骤**——可并行 / 迭代 / 回头补。三个落地后给出 triage 总结供用户批准，再进阶段 B。

#### A1 目标对齐

**对齐**：本轮目标 + 该目标关心哪些 consumer 类。

**lens**：goal 决定哪些 consumer 类（user / developer / agent）落在 scope——**不是固定过滤，是 goal 映射**。"上线"通常 = user + developer in、agent / 工具链 out；"提速 agent 工作流"则 agent in。goal 错则整轮 triage 错。

**常见询问方向**（不限于此）：
- 目标的真实意图（过审合规？首次体验？链路稳定性？）
- 哪些 consumer 类纳入本轮
- 范围 / 时间约束（只这个里程碑必需的，还是全部）

**关键**：goal 来自用户拍板。用户目标模糊时用 `AskUserQuestion` 锁定，不 silent default。

#### A2 逐 issue triage（核实 + 回写陈旧项 + 定 in/out）

**对齐**：每个候选 issue 是否纳入本轮、是否需要先纠正。

**lens**：对每个 issue 回答（不限于此，无实质答案的问题略过）——
- **还存在吗**：对照该 issue 主题的真实来源核实问题是否仍在——代码 bug 看代码 / 状态，文档·配置·流程 issue 看对应文档或仓库现状，UX·文案 issue 看实际产品；有关联 plan 时也看其 `state.md` / commit。**已修却标 open、或描述与现状不符的，先回写纠正**（标 `resolved` / 改描述）。陈旧的 issue 文件会让你把已修的当 blocker、把已变的判据当现状——以主题真实来源为准，不以 issue 文件文本为准。
- **描述准吗**：issue 描述的现象 / 定位是否与该主题真实来源（代码 / 文档 / 实际产品）的现状一致
- **consumer 是谁**：解决后受益的是 user / developer / agent——决定它是否落在 goal 的 scope
- **goal 需要吗**：纳入本轮 ⟺ consumer 类 ∈ goal 关心的类 且 问题仍在

**关键**：核实先于纳入。陈旧项**直接回写**更新 issue 文件，使其反映真实状态（issue 文件是 lifecycle 文档，让它始终为真也避免下一轮重复踩坑）。

#### A3 triage 总结 + 批准（→ 用户批准 gate）

给用户的总结要让用户能回答以下问题（**是 hint 不是填空，无实质答案就省略**）：
- 本轮要解决几个 issue（in-scope 清单 + 每个的 consumer tag）
- 每个 issue 的解决路由：simple（codex 直接）/ complex（create-plan + execute-plan）+ 判据
- issue 间依赖关系 + 解决顺序
- out-of-scope 的 issue + 剔除理由（陈旧 / consumer 不在 goal / 已 resolved）
- 已回写纠正了哪些陈旧项
- 粗粒度工作量（哪些直接跑、哪些要 plan；总数；主要影响桶）

**用户批准整批后进阶段 B**（介入粒度：批准整批后自治）。

### 阶段 B：编排解决（supervisor）

本阶段是 lens，不是步骤清单：

- **依赖顺序**：按 A3 依赖图拓扑解决，被阻塞的等前置完成。后置 issue 的 plan 可能依赖前置已落地的代码，故 complex issue 的 `create-plan` **在它轮到时即时做**，不批量前置。
- **per-issue 路由**：
  - **simple**（不需要和用户对齐设计取舍）→ 直接用 codeagent-wrapper 起 codex，按 `~/.claude/commands/custom/supervise.md` §2–§4 的 spawn / 等待 / 裁决机制（**引用，不复述**）；spawn-prompt 的 task 槽填**该 issue 经 A2 回写纠正后的描述 + 代码定位**（非原始文件文本），success criteria = 该 issue 的修复 + 不引入回归；autonomous（用户已批准整批，不再 per-issue 锁 criteria）。spawn-prompt 另须明确 codex **不自行 commit、改动留 working tree** 交阶段 C 统一提交（commit 归属归 supervisor，对齐 execute-plan §5 own complex commit 的方式），使阶段 C 确定性 own 所有 simple 落地。若执行中暴露出需要对齐的设计取舍，升级为 complex（转 `create-plan`），不让 codex 静默替用户拍设计
  - **complex**（需要对齐设计取舍）→ 跑 `/custom:create-plan <issue 上下文>`（与用户做设计访谈，这是本阶段唯一回到用户的点）产出 plan.md，再跑 `/custom:execute-plan <plan>`（codex 实施，自带 Stop Gate + 可能的 UX gate）
- **裁决**：每个委派产出按 supervise.md §4「判定 wrapped agent 输出并裁决」收敛——verify 证据 ≥ success criteria / plan verify，质疑存在性判据强度，Stop Gate 自检。**引用，不复述**。
- **新 issue 回灌（闭环）**：解决过程中新产生的 issue——先按 docs-organization-protocol 归档到对应 issues 文件（agent 行为 / 工具缺口按 supervise.md §5 落 `docs/issues/general.md`，其余按 domain 落对应文件），再走 **A2 同一 lens** 重新 triage（分析自主）。**in/out 由 A2 的 goal→consumer 判据决定，不由 consumer tag 预判**——"提速 agent 工作流"类 goal 下 agent issue 反而 in：
  - **in-scope** → supervisor 默认自主纳入并排进依赖图；**仅当纳入会实质改变用户批准 A3 时的合理预期**才用 `AskUserQuestion` 回到用户（gate 在 materiality，不在"是新增"本身——always-ask 属过度打断；升级判据沿用 supervise §4 Dialogue facet）。典型该问：起 `create-plan` 的新 complex 项 / 一次涌现多条显著拉大本轮规模 / in-scope 判定踩 goal 边界。反之 cheap、contained、或交付某个已批准 issue 的必要前置 → 自主纳入；模糊时 default 回到用户
  - **out-of-scope** → 仅记录，不在本轮解决
- **终止**：in-scope 集清空 **且** 无新 in-scope issue 产生

### 阶段 C：Commit（in-scope 清空后、handoff 前）

**判据**：阶段 B 终止（in-scope 集清空且无新 in-scope）+ working tree 有本轮解决产物且 diff 非空。本轮无 issue 落地（全部陈旧 / 已修 / out-of-scope）或仅产生合法 stop（半成品）→ 跳过本节，由阶段 D 注明。

**Doc 同步（commit 前先做）**：本节 commit 切片内（simple issue 产物 / issue 文件回写 / 未走 execute-plan 的改动）有**用户可感知的变化**时，按 `~/.claude/references/docs-organization-protocol.md` §5 spawn `doc-updater`（`interactive=false`）同步。complex issue 的代码 + doc 同步已由 execute-plan §5 commit，**不重复触发**（CHANGELOG append-only，重复 spawn 致重复 entry）。

**Scope**：
- 进 commit：本轮 issue 修复的代码 + A2 / 阶段 B 的 issue 文件回写（陈旧项 → resolved、新 issue 归档）+ doc 同步产出
- 不进 commit：repo 中**与本轮无关的 in-flight 改动**——resolve-issues 常对着有前序 session 未提交工作的 repo 跑，勿卷入；runtime / build artifact；过程性 log
- 某文件本轮回写**叠在前序未提交内容之上**（无法按文件拆开）→ 整体留给用户连同其历史工作处理，本节不单独提交，阶段 D 注明

**执行**：按 `~/.claude/skills/create-commit/SKILL.md` 执行，将上述 Scope 约束作为文件 staging 的判断依据。message 沿用 skill 定义的格式（不自行手写）。

### 阶段 D：最终 handoff（用户唯一的交付报告）

中文回复，内容由实际执行轨迹决定：

**必含**（无对应事实则注明"无"，不编造填充）
- 本轮 goal + in-scope / out-of-scope 计数
- 每个已解决 issue：路由（simple / complex）+ session id 或 plan 路径 + commit hash（该 issue 落地的可追溯 anchor——simple / issue 回写为阶段 C 产物，complex 代码为 execute-plan §5 产物经其 §6 返回；无 hash 则注明原因——凡阶段 C 未提交该产物者：叠加前序未提交工作留给用户、或阶段 C 因合法 stop 被跳过）+ verify 证据
- 回写纠正了哪些陈旧 issue（含 open→resolved 的 lifecycle 变化）
- 新产生并纳入 / 仅记录的 issue
- 残余风险 / 未纳入项及理由

**适用时含**
- complex issue 的 plan 路径 + execute-plan 的 UX gate 轮次与最终 issue 状态
- 因叠加前序未提交工作而整体留给用户处理的文件（阶段 C Scope 第三条）+ 其上本轮回写了什么
- 合法 stop（罕见，须通过 Stop Gate）：按 `~/.claude/references/plan-execution-principles.md` §5 交接格式给"为什么停 / 卡在哪个 issue / 已独立尝试什么 / 用户具体动作"，并提示做完后可重跑 `/custom:resolve-issues <same goal>`

---

## 关键不变量

下面这些 SOTA Claude 默认不会做，失守会让本 command 退化：

- **这些 SOTA 默认会丢的判定别回退**：goal→consumer 是映射不是固定过滤（见 A1）、核实先于纳入（见 A2）、闭环回灌用同一 goal（见 A2 / 阶段 B）——正文已定义，执行中别退回"固定过滤 / 以 issue 文本为准 / 另立 in-out 标准"。
- **spawn 级不变量继承、不重写**：同 session 复用 Codex、wrapper 报错先归因 wrapper / 适配层、`run_in_background: true` + 增量轮询（`poll-progress.sh` 读 `.output` 新增行；「不被动 kill」≠「被动等」——委派的 agent 反复对抗可解环境争用时 supervisor 主动可逆干预、不确定就 ask，见 `supervise.md` §3「环境争用监测」）、语言契约（与 agent 用 English / 与用户用中文）——这些在 supervise / execute-plan 里，本 command 继承，不在此展开。
- **被调命令的强制 gate 照原文执行，不因编排深 / context 紧而降配**：阶段 B 路由到 `create-plan` / `execute-plan` 时，被调命令自身的强制 gate（典型如 create-plan 在 handoff 前必跑 `review-plan`）按其原文跑完——其内部跑法以被调命令为准，不在此复述；judgment 只用于被调命令留白处，以任何 context 压力（省 token / 改动小）为由自换更轻 gate 都不在留白之列，这正是 gate 要对冲的 confirmation bias。真有约束让你无法忠实执行，把张力 + 候选 surface 给用户拍板。
