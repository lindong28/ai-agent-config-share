# ADR-023：execute-plan supervisor 执行台账 + stop-gate 委派在飞条件注入

- 状态：accepted（2026-08-18）；经 decision-review 完整 gate（首轮双复核 → D1 三轮 / D2 五轮 closure-pass，轨迹见「评审轨迹」）
- 组件：`claude/commands/custom/execute-plan.md`、`claude/hooks/stop-gate.js`、`claude/hooks/eval/stop-gate/`
- 源起：一次 execute-plan 实战复盘（wandb-ui plan，3 工作单元 / 3 轮 review gate / 23 findings）与 run-program 的对照。同批还有三处经免审声明的摆放决策（L1 达成断言绑 §5→§6、读侧并发落 §4、并行机会判定挂输入 gate），不在本 ADR 记录范围。

## 决策 1：supervisor 执行台账落在 plan 同目录新文件 `supervisor-ledger.md`

supervisor 自有的执行台账，与 implementer 拥有的 state.md / journal.md 分开。**schema 与运行规则的唯一载体是 execute-plan.md「supervisor 台账」节**（实施评审后由 per-unit 行改为 per-task 行、以容纳 reviewer / 验证 context 等非单元任务），本 ADR 只记决策与理由，不复述 schema——双载体会重现 HARNESS-156 的漂移形态。写入是三类事件（派发 / 裁决 / commit）各自的收尾动作——未写入即该动作未完成。规划 audit trail，不进 commit。

**被否决的备选**：写进 state.md（owner 冲突——long-task-protocol 把它划给 implementer，两写入者共写一文件）；写进 journal.md（append-only 时间线与可变 snapshot 混装，ADR-015 的反例）；照搬 run-program 的十列 program.md（execute-plan 无 program 语义，ADR-004 薄路由）；不落盘（实测见证据）。

**证据**：实战 plan 目录 grep——implementer 句柄 2/4 在盘、reviewer 句柄 0/3、commit hash 0/3；在盘的 2 条是 implementer 顺手写进 state.md Notes 的，非机制保证。session fork 后句柄仅靠 /tmp 残留 `.output` 找回（系统临时目录不得是恢复关键状态的唯一存放处，本身已违 user-scope BINDING）。

**作用域（评审中收窄）**：台账服务 §6 handoff 与**程序化发现**（execute-plan 进场纪律本就读 plan 目录，台账列入同批必读）。**不声称**自动 post-compaction 恢复——active-plan marker 与 post-compact-restore.js 只注入 state/journal，接线是独立候选改动（见 harness-issues 对应条目）。证据陈述限定为：不存在指定的、plan-dir 内可直接读取的关联映射载体；本次恢复实际需要跨源取证（commit 在 git、句柄在 wrapper session 存储，但"单元→句柄→裁决→commit"的映射不在任何载体）。

**已知未验证**：声明式执行（与 baseline.patch 同级，无 hook 强制）。恢复演练已于实施时完成：naive reader 只读样例台账即重建 7/7 句柄、3/3 commit、全部裁决轨迹并识别在制单元。

## 决策 2：stop-gate 新增「委派在飞」条件注入 clause，触发键为 BG-SHELL-OK 协议 ack

与 mergePendingClause / userReservedActionClause 同机制：命中才注入，未命中消息的判官 prompt 字节不变。clause 内容三件：(i) 一对多映射——委派声明覆盖被委派工作的全部子项，命中既有正当理由「在等自己的后台任务 / 已委派的 worker」；(ii) 禁止「等待自己派发的 worker 是内部事务」这一实测出现过的反 rubric 推理；(iii) 豁免只及被委派覆盖的项，已回收去向不构成在飞声明，未覆盖且现在能做的项照常逐项判。

**被否决的备选**：改主 rubric（实测跨场景权重互相压制，2026-08-10 in-file 记录）；确定性放行（等价 STOP-GATE-OK 口令旁路，judge-gate-authoring §7 刚删）；改 plan-execution-principles §0（blast radius 最大且判据本就在 rubric 里，缺的是判官对长 supervisor 消息的应用）；不改（单 session 实测 9 次拦截，其中判官两次原文推翻 rubric 自己的正当理由条；gate-stats 因 §7 二义无法把这类计入误报率）。

**触发键演化（评审五轮的主线）**：宽词表 → 被 blocker（pattern-matching-scope：自然语言词表归判官，既有 MERGE_PENDING_RE 等是登记在案的欠账不是先例）→ 收窄为 spec-bound token（BG-SHELL-OK 由 bg-shell-reclaim-check.js 强制原样输出；格式正则逐字复用其 `ackedIdsIn`，含"id 段解析出 ≥1 个非空 id"这半个语义）→ 补 held-out 读数（71 条跨项目语料、matcher 仅按 spec 文本写：62 strict + 6 stacked = 68 收，3 条引用/代码/表格样例全拒；mandate 收轮分母 30/34 ≈88% 按协议 ack，去重后 ≈94%）→ 位置规则因跨闸 token 叠放冲突扩展为 trailing-token-run，run 成员为**枚举闭集**（BG-SHELL-OK / STOP-GATE-OK / CONTINUATION-OK / IN-FLIGHT，各有约束产出方的 spec；开放 `*-OK` 名字空间经实施评审否决——`TODO-OK:` 伪装 token 行会穿撤回防御），按 pattern-matching-scope 合法出口落 `PATTERN-EXCEPTION`（三项齐备，见 stop-gate.js 匹配器旁注释；闭集下语料读数不变 68/71）；owning hook 的 strict 语义不动，跨闸冲突另记账本。两类行同时要发时命令侧规定顺序：IN-FLIGHT 在前、BG-SHELL-OK 收尾（owning parser 只认最后一行）。

**分期**：`IN-FLIGHT:` 行（execute-plan 停轮对账强制格式）Phase 1 **不能独立触发**注入（注入仍要求 run 内存在 BG ack 且 ack id 有运行态产物），只作为 trailing-run 成员参与位序判定（反序防御）+ 给判官的显式举证散文；独立触发资格待 Phase 2 真实发射语料按同一测法出读数后另行启用（harness-issues 记程序）。

**作用域**：仅命中触发键的消息见到附加 rubric；注入不放行，判官保留逐项裁决；eval 阈值不变（flag 1.0 / ok 0.8，recall-first）。

**验证读数（实施时取得）**：变异 A/B——未改动 hook（clause 缺席变异体）对真实被误拦消息 5/5 flag，改后 5/5 ok；两个 flag 守卫场景两版均 5/5 flag（豁免不外溢）；全套回归仅 `commit-question`（改前后同为 0/5，policy 判官既有缺陷，HARNESS-350）与 `legit-blocked-ok`（§8 已记录的 ok 侧双峰方差，同条件 mini-eval 两版均 5/5 ok）两处既有红，均 A/B 证明与本改动无关。**残余**：~6-12% 未按协议 ack 的收轮消息得不到注入（安全方向：维持现状判官行为 + 逃生口）。

## 评审轨迹

decision-review 外部评审（Codex read-only，session `01a0147f-9076-72e0-8377-90509c136db2`）：首轮 D1 blocker(判据5 恢复链不闭合)+应修×2、D2 blocker(判据5 词表无 spec)+应修(判据3)；R2 D1 剩全称断言、D2 补 token 实测义务 + matcher 收紧 ×2 + recycled 守卫；R3 D1 pass、D2 剩选择偏差分母 + 多 id + 位置严格性；R4 位置规则 spec-bound 论证不成立、暴露跨闸 token 位置冲突（二选一出口）；R5 选 PATTERN-EXCEPTION 路 + 冲突记账 → pass。

实施 review-gate（高档 Codex read-only，session `01a014a1-9770-7070-80b6-adfe616927e5`）：首轮 block——F1 HIGH 开放 `*-OK` 名字空间 + 空 id 可穿撤回防御、F2 HIGH 拆面并行与 §3.5 归属矛盾、F3 MEDIUM 双 token 位序未定义；修复（闭集 run 成员 + owning 同款 id 语义、§3.5 并行例外、位序固定）后 closure 复核 F2/F3 holds、F1 三轮递进收口——二修产物存在判定（复核以 7 月 29 日陈尸文件实测反例推翻）、三修 session 绑定（复核指出静态 `statSync` 分不开 active/completed）、四修定稿为**两个合取**：产物在场（搜索面 = session 目录 + 同项目全部 session 目录——fork 的 hook payload 带父 session id 而任务产物在另一 uuid 目录，2026-08-18 生产实测，只绑 session 会废掉 fork 场景）+ **活写入者**（`lsof -t` 有持有者；`run_in_background` 存续期 fd 恒开，实测在飞 2 持有者/历史 0——给出 active→completed 由 true 翻 false 的判别性控制，入确定性测试翻转对照；eval runner/`# task-artifacts:` fixture 由 runner 进程持 fd 扮演在飞）；五修按复核实测（只读 fd 持有已完成文件仍被 `lsof -t` 命中、`-F pan` 报 `ar`）把活性判定收为 **access 模式含 w/u**（与 continuation-claim-gate 既有判法同款），只读 holder（tail -f / 查看器）不构成在飞，负对照入测试。

## 关联

- 实测缺陷（评审副产物，另记 harness-issues）：多道 Stop 闸各要求自己的 token 是最后一个非空行，agent 无法同时满足；6/68 真实 ack 因叠 token 从未被 bg-shell hook 承认，任务保持 pending 反复重提醒。
- ADR-015（ledger/journal 分离）、ADR-004（薄路由）、ADR-011（compaction 恢复链为能力契约）、HARNESS-156（双规范载体教训——本次停轮对账只拥有"停轮记账"新轴，唤醒期语义仍归 background-agent-monitoring）、HARNESS-172（条件注入按轴触发先例）。
