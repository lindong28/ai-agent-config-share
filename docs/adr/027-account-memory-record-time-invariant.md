# ADR-027: 账号记忆按记录值确定时刻判定写入与隐藏

- 状态：accepted-with-waiver（2026-08-21）；当前 shipped implementation 未完全满足该不变量
- Component：`tt-web/server.py`、`tt-web/web/app.js`、`tt-web/tests/test_account_memory.py`
- 关系：建立于 [ADR-002](./002-tt-web-open-requests-fresh-generation.md) 的 admission 边界；与 [ADR-026](./026-tt-web-account-memory.md) 的持久记忆和 hard delete 语义相关，但不 supersede、refine 或 amend ADR-002/026

## 背景

ADR-026 让账号记忆可被用户永久删除，同时 Overview 与 sync 发布路径会并发地从 admitted snapshot 派生候选并写回记忆。只用一把读写锁不能解决语义竞态：请求可以先取得旧 admission，删除随后成功，旧请求再进入锁并把同一账号写回。

前端也有同类问题。用户确认删除的是某一版 remembered row；请求进行期间页面可能重新渲染出同账号的更新记录，若成功回调只按 provider/account id 删除 DOM，就会把并非用户确认的新版记录隐藏。

两边共同的不变量是：**是否写入或隐藏一条记录，必须按该记录值实际被确定的时刻及其版本判断，不能按请求开始、回调发生或 DOM 节点被捕获的时刻替代。**

## epoch 打点位置

| 位置 | 结果 | 结论 |
|---|---|---|
| 请求 entrypoint 开始 | epoch 跨过 unrelated generation sync、rollup 与其他工作；删除后才取得的新 admission 仍携带旧 epoch，会被误拒 | 太早，不采用 |
| admission snapshot acquisition | 值的事实来源在此确定：删除前取得的 snapshot 应被拒，删除后取得的应被接受 | 理论正确点；当前尚未实现 |
| derivation loop / near-candidate | epoch 靠近候选派生，显著缩短 pin window；但 admission 可能已在删除前取得，而此时尚无 active epoch，删除 tombstone 可立即 GC，旧 snapshot 随后仍能写回 | 当前 shipped implementation；带 waiver 接受，不宣称竞态关闭 |

## 备选与被否方案

### A. 只依赖 shared lock

锁只能序列化实际的 memory read-modify-write，不能给锁外已经取得的 admission snapshot 标记先后。旧 snapshot 在删除后进入锁时仍会复活记录，因此不足。

### B. entrypoint 注册 whole-request epoch

它能覆盖旧 snapshot，但也覆盖 snapshot 尚未取得前的 unrelated generation / rollup 工作，把删除后才产生的新值误判成旧值，故被否。

### C. 全局 whole-batch epoch

删除账号 A 会使同批候选整体失效，从而永久丢掉无关账号 B。该方案在 review 中被反例推翻，改为 per-key deletion record。

### D. admission acquisition 打点

这是语义上正确的实现点：snapshot 与 epoch 必须在同一边界建立关联。当前代码尚未把注册上移到这里；它是后续若关闭 waiver 应采用的方向。

### E. derivation-loop / near-candidate 打点

这是当前落地方案。它比 entrypoint 更接近值的形成，不会误拒删除后取得的新 admission，并保留同批无关账号；代价是仍留有“删除前已取得 admission、删除时尚未注册 epoch”的复活窗口。owner 明确接受该缺口后收口。

## 决策

采纳“record-time invariant”作为语义边界：backend 写入应以 admission snapshot 被取得的时刻决定先后，frontend 隐藏应以用户实际确认的 remembered record 版本决定。

backend 使用单调 sequence、active derivation epoch 引用计数与 transient per-key deletion records。成功 hard delete 后只为该 key 登记 delete sequence；upsert 逐 candidate 比较自己的 derivation token，旧于删除的同 key candidate 跳过，同批无关 key 继续按 strictly-newer 规则写入。epoch 与 deletion records 都是进程内瞬态协调状态，不改变 ADR-026 的持久 JSON schema，也不引入持久 tombstone。

frontend 删除请求携带 remembered row 的 canonical raw `observed_at`。server 在锁内把它与当前 store 版本精确比较，不匹配返回 409；成功回调也只有在当前 DOM 行的 provider、account id、`presence === "remembered"` 与 raw `observed_at` 全部仍匹配时才隐藏该行。

当前 backend 的 epoch 注册实际落在 admission 已取得后的 near-candidate / derivation 位置，而不是理论正确的 admission acquisition。这个偏差按 owner waiver 接受：实现能拒绝已注册 epoch 中的 pre-delete candidate，并保留无关账号，但不能保证所有删除前取得的 admission 都不会复活。

## 后果

- 同批删除账号 A 时，无关账号 B 不再因 whole-batch epoch 被误杀。
- 删除确认与前端隐藏绑定到同一个 `observed_at` 版本；请求期间出现的新版 remembered row 或已重新变为 `in_use` 的行不会被旧回调隐藏。
- 当前实现只显著收窄、没有关闭 backend 复活竞态。一个删除前取得 admission、删除后才进入 derivation epoch 的请求仍可能把记录写回；用户可再次删除。
- transient tombstone map 只有最终收敛、没有硬上界：任一 derive/write context 长期不返回时，`oldest_active_epoch` 不前进，其后不同 key 的 tombstone 都可能继续保留。
- 该协调仍是单进程语义，不是跨进程事务或持久删除日志。

## Waiver 与已知未验证

- U3 第四轮 review 明确指出当前打点过晚会留下复活竞态；owner 显式 waive，并要求把现状留在 [`tt-web/docs/issues/general.md`](../../tt-web/docs/issues/general.md) 的“账号记忆的删除可被一个删除前取得 admission 的在途请求复活”条目。本 ADR 状态因此是 accepted-with-waiver，不是竞态已关闭。
- `tests/test_account_memory.py` 中相关测试不区分 admission 在删除前还是删除后取得；墓碑已被 GC 时，它对该关键语义没有区分力。测试名称与注释已改正，不能据旧名称推断覆盖。
- 长时间 derive/write 对 tombstone 回收的最坏持续时间与多 key 累积规模未验证。
- 五个实施 commit 已完成，但 `TASK-009` / V8 owner 人读仍 pending；这里的 accepted-with-waiver 只描述该并发决策，不代表全计划验收 complete。

## Review

U3 的高档独立 review 共四轮：前三轮持续发现原实现或上一轮修法引入的新问题，第三轮触发熔断后用户授权一次修根；第四轮仍发现 admission-before-registration 的 HIGH 竞态，owner 明确 waive 后交付。因此历史产品决定没有取得 clean gate。本 ADR 的提升边界、三种打点位置与 accepted-with-waiver 表述另经本轮 decision-review 放行；该提升 gate 不改变上述历史事实。
