# tt-web Issues

本组件里已知、但当轮未就地修的问题。

---

## [resolved] 出口选路的发布方尚未实现，消费侧只能信任一个手工维护的文件

- **Type**: incomplete-integration
- **Discovered**: 2026-08-07
- **Resolved**: 2026-08-07（system-config `2d0b7e6`）

**原问题**：`ip_check/cli.py` 的 `resolve_route()` 每轮从 `~/.config/agent-proxy/current-proxy` 读取本轮出口线路，用来绕开「长驻 server 在 fork 时冻结了 `HTTP_PROXY`，线路一切换就永久指向死端口」这个故障。消费侧先行落地时，写这个文件的一侧还没有——该改动当轮被并发写入者阻塞。期间文件由人手工维护，切线路后忘记更新就会复现原故障。

**解决**：system-config 的 `shell/common.sh` 增加了 `_sc_publish_proxy_addr`，挂在 `zshrc` / `bashrc` 的 `_refresh_proxy_addr` 末尾——所有 `enable-proxy-*` 最终都会调它，且它每个提示符都跑。它读后再写（不一致才落盘）、必定原子替换，目标是目录或 FIFO 时放弃。

**验证**：改 `mode` 后开一个新 shell，不做任何手工操作，`tt-web network` 的「本次探测出口」与公网 IP 即跟随新线路（gcp `35.198.217.6` ↔ zyt `185.126.80.150`），切回亦然。

---

## [open] 兜底价目表的 bare key 会盖过在线表里只有 provider 前缀的同名条目

- **Type**: pricing-precedence
- **Discovered**: 2026-08-07
- **Priority**: medium

`_with_bundled_supplements()` 用 `setdefault` 把 `pricing.json` 的条目补进 LiteLLM 表，`resolve_model_key()` 又优先精确匹配。若 LiteLLM 某天只发布 `anthropic/claude-sonnet-5` 而不再发布裸 key，补进去的裸 key 会精确命中、把在线价挡掉。

这条优先级同时是 `glm-4.7` 修正的依据：在线表对它唯一的匹配是模糊命中 `cerebras/zai-glm-4.7`（$2.25/$2.75，另一家托管商），而 z.ai 自己的价是 $0.6/$2.2。所以「在线表永远优先」和「精选兜底优于模糊猜测」在此冲突，没有单一规则能同时满足——区分点是模糊匹配有没有跨厂商，而当前 matcher 判不出来。

触发需要 LiteLLM 改变 key 命名，属上游 schema 变更，故未就地修。真要修，方向是让 `resolve_model_key` 区分"精确/同厂商模糊/跨厂商模糊"三档，而不是继续在补表时机上打补丁。

## [open] 57 个跨文件重复调用的 project 归属不一致，去重按路径序任选其一

- **Type**: attribution-ambiguity
- **Discovered**: 2026-08-07
- **Priority**: medium

Claude Code 在 resume/fork 时把整份 transcript 复制进新 session 文件，同一次 API 调用因而出现在多个文件里。`aggregators._deduped()` 保留先遇到的那条（路径排序，故确定但任意）。实测有 57 个 `dedup_key` 在不同副本里带着不同的 `cwd`——多为 worktree 与主仓、或 subagent 换过工作目录，token 与 cost 一致、只有归属不同。

结果是这 57 次调用的成本被记到两个候选 project 中排序靠前的那个。总额不受影响，按 project 切分的视图会有偏差。要修需要一条能判"哪个副本的 cwd 才是这次调用真实发生地"的规则，源日志里目前没有能直接支撑该判断的字段。

## [open] `codex.load_entries()` 按 session_id 去重，会把同一线程 resume 出的独立分支合并掉

- **Type**: latent-undercount
- **Discovered**: 2026-08-07
- **Priority**: medium

`parsers/codex.py` 的 `load_entries()` 用 `if entry.session_id in seen: continue` 去重。但 resume 一个 Codex 线程会写出新的 rollout 文件、沿用原 `session_meta.payload.id`，各自从同一起点独立累计 token——实测某个 id 下 10 个文件的首个 total 都是 28,316，事件数 866~2025 各不相同，是各自真实计费的分支而非同一次运行的重复日志。按 session_id 去重会丢掉其中除一个之外的全部。

实测影响：1,799 个 rollout 文件里 1,608 个唯一 session_id，按此去重后 Codex 成本从 $18,579 掉到 $7,904。

dashboard 不受影响——生产路径走 `aggregators._parse_usage_file()` 而非这个函数，且 `UsageEntry.message_id` 现已是 rollout 文件名，全局去重不会合并分支。该函数目前只被测试调用，故未改动其语义。

## [open] `/api/restart` 是无认证写端点，且服务默认绑 0.0.0.0

- **Type**: exposure-surface
- **Discovered**: 2026-08-20
- **Priority**: low（当前暴露面下）

`server.py` 的 `do_POST` 只认一个路径 `/api/restart`（`:319` → `:324` `_handle_restart`），它做完 `_compile_check()` 就 `_schedule_reexec()` 让进程重新 exec 自己。这条路径**没有任何认证、来源检查或确认**。

同时服务并非只绑 loopback：launcher `tt-web/tt-web:18` 是 `BIND_HOST="${TT_WEB_BIND:-0.0.0.0}"`，运行中的进程命令行确为 `--host 0.0.0.0`，`lsof` 显示 `TCP *:39001`。所以 Tailnet / LAN 上任何能访问该端口的客户端都能重启这个服务。

**注意 `server.py` 会给出相反的读数**：`:49` 的 `_BIND_HOST` 与 `:1267` 的 argparse default 都写着 `127.0.0.1`，但 launcher 显式传 `--host` 覆盖它。只读 server.py 判暴露面会判错——这个坑已经真实发生过一次。

**当轮未修的原因**：2026-08-20 的账号记忆改动要新增一个删除端点，借此评估了可达档位。用户明确裁决**沿用既有档位**（该 plan 的 D5）：既然 `/api/restart` 这个权限更大的端点已经敞着，只给新端点加锁不会真的提高防护。这条记录的是**事实与那次裁决的适用前提**，不是待办。

**什么时候要重新裁决**：服务的暴露面变化时——接入更宽的网络、多人使用、或 `TT_WEB_BIND` 的默认值被改动。届时 `/api/restart` 与账号记忆的删除端点应一并处置，不要只看其中一个。

## [open] 账号记忆的删除可被一个"删除前取得 admission"的在途请求复活

- **Type**: race-condition
- **Discovered**: 2026-08-20
- **Priority**: low（后果是"删掉的账号又出现一次"，再删一次即可）
- **Status**: 用户显式 waive，带着它交付

`/api/account-memory/remove` 永久删除一条 remembered 记录后，一个**在删除之前就取得了 admission 快照**、但尚未进入内层 epoch context 的 overview 或 sync-publish 请求，仍可能把该账号写回：删除发生时若没有 active upsert epoch，墓碑会被 GC 立刻清空；随后那个旧请求注册到删除**之后**的 epoch，从**旧**快照派生候选，比较时已无墓碑可依，于是写回。

overview 侧的窗口尤其宽——它在取得 admission 与注册 epoch 之间还夹着 rollup 查询。

**这不是没修，是修了三轮后确认它落在一个坐标轴上**，三个打点位置各错一头：

| epoch 打点位置 | 结果 |
|---|---|
| 入口开始 | 跨越 generation/rollup 工作 → 删除后取得的新读数被误拒 |
| **admission 取得时** | 理论正解：删前取得的快照正确拒绝、删后取得的正确接受 |
| 派生循环（当前实现） | 本条竞态 |

真要修，方向是把 `_account_memory_upsert_epoch()` 上移到包住 admission 快照的获取。当轮未做是因为已连续两轮出现"新问题来自上一轮修法"，用户裁定带着它收口。

**附带两条同源边界**：

- tombstone map 只有最终收敛、没有硬上界：任一 derive/write context 长期不返回时，`oldest_active_epoch` 不前进，其后所有不同 key 的墓碑都不能回收。个人账号规模下风险很低。
- `tests/test_account_memory.py` 里覆盖该路径的测试**不区分 admission 是在删除前还是删除后取得**，且在墓碑已被 GC 时对 epoch 语义不具区分力。它的名字与注释已按此更正，别再据旧名推断覆盖面。

## [open] sessions 加载的 invalid-rows 守卫（web/app.js）没有任何测试看守

- **Type**: coverage gap
- **Priority**: low
- **Discovered**: 2026-08-24，share 同步时 guard-mutation 反向变异检查
- **Component**: `tt-web/web/app.js`（`throw new Error("Sessions response contained invalid rows.")`）
- **Description**: 同批引入的 server 侧守卫（server.py negative Content-Length）经变异验证被套件守住（删掉后 1 error）；app.js 这个守卫删除后无任何测试变红——仓内确有执行 app.js 的 JS 通道（`test_web_static.py` 经 Node 跑 `web/app.js`），但现有用例没有覆盖该守卫，它目前是无覆盖的 invariant。
- **候选修法**: 上游侧补 JS 行为测试（或在有 JS 测试通道后回填）；本仓跟随上游。
