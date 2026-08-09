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
