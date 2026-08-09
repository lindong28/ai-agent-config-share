---
name: review-session-skills
description: 复盘刚完成任务中实际使用的 skill、command、reference、agent 定义、hook 与 harness 适配层，基于执行证据判断是否存在仍需解决的显著问题或改进机会。
disable-model-invocation: true
---

# review-session-skills

## 输入与输出

| 项目 | 契约 |
|---|---|
| 必需输入 | 当前 session 中可复核的执行记录；按实际发生情况取用对话、工具结果、用户纠正、失败/返工与 artifact diff |
| 审查对象 | 本次任务中实际参与执行的 harness artifact——skill、command、reference、agent 定义、hook、CLAUDE.md / rules、settings、script 或适配层 |
| 输出 | 证据覆盖说明（实际复核的 session / artifact 范围与已知缺口），以及证据不足（无法可靠判断）、clean（未发现显著问题）或 findings（由通过全部判定门的异常行为或不必要成本组成、等待用户选择的清单）之一 |
| 委派检测模式 | 被上层 harness 复盘流程委派时，检测在隔离 readonly context 执行，证据源为该 session 的 transcript 文件；findings 返回调用方，文内所有用户选择与 fix 交接（含决策路径第 4 步与「收敛与后续」）由调用线程承接 |
| 下游 | 用户选中的 finding 交给 `/custom:fix-skill-from-session` 做 source-level 修复 |

## Finding 判定门

候选观察是从 session 执行记录中提取的异常行为或不必要成本。读取实际参与、负责相关行为且可能需要修复的 source artifact（下称归属 artifact）判断归因；只有通过下面全部判定门的候选观察才是 finding。

一个 finding 必须同时满足：

| 判定门 | 判定问题 |
|---|---|
| 执行证据 | 本次 session 中发生了什么可指认的行为、失败或不必要成本？ |
| Harness 归因 | 归属 artifact 的指令、边界、适配或缺失契约如何导致或放大了它？ |
| 显著性 | 它是否可能在未来调用中复现，并造成实质性的正确性、效率、安全性或可维护性损失？ |
| 当前可行动 | 问题是否仍未被本次 session 完整 source-level 修复并验证？ |

决策路径：

1. 检查执行记录并说明证据覆盖。若现有上下文既不能支持任何 finding，也不足以可靠判定没有 finding，输出证据不足并停止。
2. 提取候选观察，依次应用执行证据、Harness 归因、显著性与当前可行动判定门。
3. 审查范围内的记录足以判断、但没有候选观察通过全部判定门时，输出 clean 并停止。
4. 至少一个候选观察通过全部判定门时，输出 findings；覆盖不完整则同时说明限制。呈现给用户选择，用户不选择则停止，选中的 finding 进入 source-level 修复。

## 产出 findings

对每个通过全部判定门的 finding，给出：

- 观察：实际发生的行为与影响
- 证据：可复核的 session 事实或 artifact diff
- 归因：最可能的归属 artifact 与导致问题的指令 / 契约缺口
- 泛化价值：为什么修复后能改善未来同类调用
- 不确定性：尚未证实的部分；没有则省略

## 收敛与后续

clean 时明确说明没有仍需 source-level 修复的显著 harness 问题或改进项。有 findings 时，先完整呈现证据和归因，再用 `AskUserQuestion` 让用户选择要修的 finding；不得在选择前修改归属 artifact。将选中的 finding 连同证据、归属 artifact 候选和不确定性交给 `/custom:fix-skill-from-session`，由它完成诊断、方案对齐、编辑与审核。
