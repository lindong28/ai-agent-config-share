# ADR-006：并发执行出口信誉查询，在 30 秒页面上限内放宽 StopForumSpam 读取预算

- Status: accepted
- Date: 2026-08-11
- Component: `tt-web /network`、`ip-check`

## Context

`/network` 的垃圾滥用记录显示 `HTTPSConnectionPool(host='api.stopforumspam.org', port=443): Read timed out. (read timeout=6)`。真实入口强制刷新随后成功；当前 `gcp` 发布路由状态正常。对同一 StopForumSpam API 做发布路由与 `trust_env=False` 强制直连的五组成对检查，两侧均 5/5 返回 HTTP 200，发布路由最慢 2.667 秒、直连最慢 5.14 秒。错误因此能确认是连接建立后的读取超时，当前证据不支持“代理配置错误”，也不足以区分当时的尾延迟来自上游服务还是中间链路。

现有实现给 ip-api、proxycheck 与 StopForumSpam 都传单值 `timeout=6`。Requests 会把单值同时作为 connect timeout 与 read timeout，且不会自动重试；proxycheck 与 StopForumSpam 在公网 IP 返回后彼此没有数据依赖，却串行执行。服务端另用 `subprocess.run(..., timeout=30)` 给整轮 `ip-check --json` 设置页面硬上限。

## Options Considered

### Option A：只把 StopForumSpam read timeout 放宽到 10 秒，同时把页面总上限提高到 45 秒

- 优点：实现最小，给慢读留下更大余量。
- 缺点：第三方异常时页面最长多等 15 秒；用户未选择这一运行时成本。

### Option B：保持串行与 30 秒页面上限，只放宽 StopForumSpam

- 优点：改动集中在一个参数。
- 缺点：更长的局部等待继续与 proxycheck 串行叠加，可能把单卡查询失败换成整页 30 秒超时。

### Option C：ReadTimeout 后重试一次

- 优点：能吸收一次瞬态慢响应。
- 缺点：第三方已经变慢时再发第二个请求，增加请求量与尾延迟；现有证据只说明 6 秒余量太小，不支持额外重试。

### Option D：并发执行 proxycheck 与 StopForumSpam，保持页面 30 秒上限

- 优点：两项独立 I/O 相互重叠，为 StopForumSpam 增加读取余量而不延长页面硬上限；符合仓库对独立、规模不可忽略 I/O 使用有界并发的约定。
- 缺点：同一时刻会向两个不同的信誉服务各发一个请求；所有依赖同时异常时仍可能撞到既有 30 秒硬上限。

## Decision

选择 Option D。ip-api 返回公网 IP 且标记该 IP 为 proxy/hosting 后，使用最多两个 worker 同时执行 `get_ip_risk(ip, route)` 与 `get_stopforumspam(ip, route)`。两个请求继续接收同一个本轮只解析一次的不可变 `route`，各自创建独立的 Requests Session，不恢复继承进程环境里的陈旧代理。

StopForumSpam 使用 `(6, 10)` 的 connect/read 分离预算，保留原有连接容忍度、只放宽读取阶段；ip-api 与 proxycheck 保持现有 `timeout=6`。JSON 快照入口与人类可读的 `ip-check` 终端入口共用这套调度。`server.py` 的 30 秒外层 timeout 不变。

## Scope

本决策只覆盖本机 `tt-web /network` 与 `ip-check` 在已有 proxy/hosting 分支里的两项信誉查询。它不并发依赖公网 IP 的第一阶段，不改变免费额度 gating，不绕过发布路由，不改变代理切换机制，也不声称 StopForumSpam 或当前代理线路有稳定性 SLA。

## Consequences

- 当前页面等待硬上限仍是 30 秒，不因修复提高到 45 秒。
- 正常情况下，第二阶段 wall-clock 取两项查询中较慢者，而不是两者相加。
- StopForumSpam 的连接失败仍会较快暴露，读取阶段则从 6 秒放宽到 10 秒。
- 两项查询继续分别降级：一项失败不抹掉另一项成功结果。
- 所有依赖与本地采集同时异常时，仍可能保留既有的顶层 `timeout` / `verdict=unknown`；本决策降低撞线概率，不承诺严格最坏情形下完整返回。

## 已知未验证

- 本轮没有再次复现用户看到的 ReadTimeout；10 秒来自当前 5.14 秒观测加余量，不是上游 SLA。
- Requests/urllib3 在多地址解析或底层重试下，简单 timeout 求和不是严格 wall-clock 上界。
- 当前目标环境会通过真实 `/api/network?force=1` 复测，但该成功证据只覆盖当前环境，不扩大成所有网络异常组合的保证。

## Review

用户选择并发方案。`decision-review` 首轮要求闭合与外层 30 秒 timeout 的交界面；复核在明确“30 秒是硬止损而非完整结果保证”、保留既有顶层失败形态后放行，并要求最终报告继续区分当前环境实测与未验证的严格最坏情形。
