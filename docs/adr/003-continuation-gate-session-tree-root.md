# ADR-003：continuation-claim-gate 的进程子树起点改为上溯到 claude 祖先

- 状态：已采纳（2026-08-09）
- 决策评审：`decision-review` gate，四轮（首轮 1 blocker + 5 应修 → 三轮复核）→ **放行**
- 影响面：`claude/hooks/continuation-claim-gate.js`、`claude/hooks/continuation-claim-gate.control-flow.test.js`

## 决策

`descendants()` 原先直接以 `process.ppid` 为进程子树的根。改为**先从 `process.pid` 上溯最多 16 层、找到 comm 含 `claude` 的祖先**，再收集该祖先的后代；找不到则返回 `null`（→ `hasLiveTask` 交出 `null` → `detect_unavailable` → fail-open）。与同仓 `bg-shell-reclaim-check.js:130-160` 的 `sessionDescendants()` 对齐。

只改这一处控制流。不动判官 prompt、不动逃生口、不动 `bg-shell-reclaim-check`。

## 为什么

hook 进程与 claude 之间隔着一层 shell，因此以 `process.ppid` 为根的子树只含 `{shell, hook}`，**永远不可能包含 claude 的后台任务子进程**。后果是本闸「有活任务 → 一律先放行」这个**压低误报的主手段从未生效**。

四条独立证据：

1. **同一次停止内的相反读数**（最强）。session `b9f23531`，相隔 1 秒：
   - `10:44:29.953Z` `bg-shell-reclaim-check`：「bx121yu6i：已运行 44 分钟，仍有 2 个写进程（pid 3538761, 3675750）」
   - `10:44:30.953Z` `continuation-claim-gate`：「此刻没有任何 task / monitor / subagent 在运行」

   同一 Stop 事件、同一进程树。bg-shell 能点名枚举 pid，证明**上溯手法在 hook 真实运行视角下确实找得到 claude 祖先**；唯一差别就是子树起点。
2. `~/.claude/logs/judge-gate.jsonl` 全量 878 条（34 小时）中，本闸 30 条：flag 13 / ok 7 / ok_override 9 / skipped 1，**`ok_live_task` 与 `detect_unavailable` 均为 0**。该读数有区分力——第 244 行确认活任务出口确实调用 `logVerdict(GATE,"ok_live_task",…)`。
3. `2026-08-09T12:13:35.837Z` 本闸记 `flag` 而非 `detect_unavailable`，同时刻后台任务 `bthgot37u` 在跑、其 `.output` 被 `bash 4109815` / `tail 4109839` 以 `aw` 持有、路径实测匹配 `OUTPUT_RE`。
4. 通过路径分布已倒转为 `ok_override` 9 次 > `ok` 7 次——agent 主要靠自贴口令过关，正是本闸加固时点名要防的「判定权落回被判定者手上」。

本闸头注释 27-29 行当初记录的取舍写着「另写一份刻意保守的探测……**代价是有重复、会漂移**」。**漂移就发生在它预言的位置**：重写时丢了上溯这一步，且该缺陷在单闸测试里不可见——探测函数本身逻辑自洽，只有把它与「hook 实际由谁 spawn」放在一起才暴露。

## 被否决的备选

| 备选 | 否决理由 |
|---|---|
| B：`require` 并复用 bg-shell 的 `sessionDescendants()` | 该文件模块尾部直接调用 `main()`，`require` 会**导入即执行**（源码核实） |
| E：抽 `lib/session-tree.js` 共享 helper，两闸共用 | 评审裁决：会改动当前正常工作的 bg-shell，并让两道闸**共用一个故障域**；而本次事故恰恰依靠 bg-shell 的独立实现提供了反向对照，它目前又没有独立的控制流测试。**待共享 helper 有独立契约测试且两侧都有回归覆盖后另行评审。** |
| C：取消子树限制、扫全机 pid | 会把别的 session 的任务算作本 session 有活任务，等于把闸挖穿 |
| D：不改，只记 issue | 该出口是本闸压低误报的主手段，失效期间通过路径已倒转（见证据 4） |

## 作用域

- 证据来自**单机 Linux、单用户、两个 session**，日志窗口 34 小时。
- `~/.claude` 是本仓 `claude/` 的 symlink，故改动**对所有项目所有 session 全局即时生效**，无法分阶段上线（本 ADR 不主张分阶段；只主张 canary 能在生效后立刻证伪）。
- **不主张**修完误报归零：本闸另有一个独立缺陷未动（见下）。

## 已知未验证

- **根因链上有一环是推断**：未直接观测 hook 进程真实的 `process.ppid`。「claude 与 hook 之间隔着一个 shell」推自两点——settings 命令写作 `node "$HOME/…"`（`$HOME` 需 shell 展开），以及实测工具调用链为 `claude → bash → node`。证据 1 只证明「上溯手法在 hook 视角可行」，**不证明本闸改后必命中**。
- 本改动**不是恒等变换**（首轮评审的 blocker，已撤回原「恒等」断言）：旧集合含 `process.ppid` 自身，新集合不含根自身；若根进程持有 `tasks/*.output` 写句柄，读数会变。该情形是否真实存在未测。
- `comm` 宽松匹配（`.split("/").pop().includes("claude")`）可能误命中 `claude-mem` 一类同前缀进程。本机当前快照仅 1 个匹配进程（pid 42288，comm=`claude`），但这是快照不是不变量。**注意 bg-shell 已在生产使用完全相同的匹配**，故本改动不引入新的误命中面，只是把既有面扩展到第二道闸。
- 16 层上限的深链场景未枚举（本 session 实测链深为 3）。
- **本闸的第二个独立缺陷未在本决策内处理**：注入判官的「已知事实：此刻没有任何后台任务在运行」实际只覆盖本 session 进程树却陈述为无条件事实，导致如实汇报**第三方**在跑的工作会被判成「事实错误」（2026-08-09 实测一例）。修了本条后其暴露面会显著变小但不消失。

## 生效判据与回滚

- **上线前基线**：本闸 `ok_live_task` = 0、`detect_unavailable` = 0。
- **生效判据（唯一，主动 canary）**：上线后立即制造一次「存在活后台任务时停止」，该次必须落 `ok_live_task`。
  阳性前提三条须全部**可观察**，缺任一则本次 canary 作废重做：① 用 harness 后台任务机制起（产生 `tasks/<id>.output`）；② 停止前 `lsof -F pan <该 .output>` 实测存在 `a` 字段含 `w`/`u` 的持有者并记录 pid；③ 路径经 `OUTPUT_RE` 实测匹配。
  （该形态已有前例：本 session `bmgd38gk1` 实测 `bash 4162804`(ppid=claude) 与 `sleep 4162851` 以 `aw` 持有、路径匹配、二者均在 claude 子树内。）
- **回滚条件**（任一）：① canary 未落 `ok_live_task`；② canary 窗口内出现**任何一次** `detect_unavailable`（基线为 0，≥1 即为上溯常失败、退化 fail-open 的信号）；③ 任何在跑 session 报告 Stop 路径异常。
- **回滚方式**：hook 与测试落**同一 commit**，回滚即 `git revert <该 commit>`。无状态迁移；hook 每次停止重新 spawn，revert 后下一次停止即生效。

## 附带纪律

「新增 ≥N 条记录而 `ok_live_task` 仍为 0 即回滚」曾被写进本决策，经评审证伪：**它在「修复失效」与「这 N 次停止本来就没有活任务」两种情况下读数完全相同**，是代理判据而非证据。已删除，改为上述主动 canary。这与 `~/.claude/CLAUDE.md`「取证的充分性」同源——给自己的方案设验收条件时，尤其容易挑好写的量而不是能区分的量。
