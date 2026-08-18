# ADR-002: `tt-web open` 请求新 generation，不绕过准入层读取本机额度

- Status: accepted
- Date: 2026-08-09
- Component: `tt-web`

## Context

Overview 的 Claude 与 Codex 额度只来自已准入的跨机 generation。页面通常每 10 分钟才自动同步一次，因此 generation 尚未到期时，`tt-web open` 会直接打开几分钟前的额度快照，即使 Claude statusline 与 Codex 当前日志已经有更新值。现场对照中，网页的 Claude 5h / 7d 为 52% / 27%（18:13 采样），本机当前源为 53% / 28%（18:18 采样）；Codex 的比例恰未变化，但当前源时间戳也比网页新 4 分钟。

## Options Considered

### Option A: Overview 混入本机实时额度

- 优点：本机额度可在每次 API 请求时立即更新，不必等待跨机同步。
- 缺点：破坏既有“只从 admitted generations 选 provider 最新值”的边界；本机 Codex 日志扫描还会进入普通页面请求的时延路径。

### Option B: 全局缩短自动同步间隔

- 优点：全部 usage 与 quota 一起更快更新。
- 缺点：把一个入口的额度新鲜度问题扩大为持续的本机 rollup 与三台机器 SSH 负担，且任意两轮之间仍可能落后。

### Option C: `tt-web open` 发起一次强制同步后立即打开

- 优点：复用 Refresh 按钮已有的 `force=1` 路径，保留 generation 准入边界和“先显示、后收敛”的非阻塞交互。
- 缺点：每次从 CLI 打开都会请求一轮跨机同步；最终结果仍取决于各机器当次能否导出。

### Option D: 等全部机器同步成功后再打开

- 优点：打开时即可显示本轮结果。
- 缺点：CLI 会被最慢的 rollup、SSH 或超时阻塞；一台远端失败还会阻止用户看到仍可用的本机或旧快照。

## Decision

选择 Option C。server 可用后，`tt-web open` 通过现有 `/api/overview?force=1` 提交一次 freshness request；已有同步在跑时复用该轮，不启动第二轮，然后立即打开页面。localhost 请求显式绕过外部代理。

CLI 只把 `sync.refresh_pending` 或 `sync.syncing` 读成“请求已被处理或已有后续状态”，不据 HTTP 200 宣称同步完成。请求失败、响应无法解析或没有后续状态时，stderr 明确提示未能请求最新快照，但仍打开当前 dashboard。最终逐机成功或失败继续由页面现有 polling 与 machine cards 呈现。

## Scope

本决策只改变 `tt-web open` 打开 Overview 时的一次性刷新行为。不改变普通浏览器直接访问、10 分钟自动同步阈值、generation schema、provider 选值规则、远端认证与部署。

## Consequences

- generation-only admission 继续是额度的唯一消费边界。
- `tt-web open` 不等待跨机网络，页面可能先短暂显示旧值，再在同步完成后替换。
- 一台机器失败不会阻止页面打开；失败必须在页面对应机器状态中可见。
- launcher 测试覆盖 force 请求、localhost 代理绕过、已接受 / 已在同步、异常响应与请求失败；真实入口验证还要确认最终 generation 时间戳追上触发前的 direct source。

## 已知未验证

- 决策落盘时实现尚未完成，真实 `tt-web open` 的浏览器收敛闭环仍待验证。
- `refresh_pending` 只表示页面还有后续状态要处理，不证明同步线程或任何远端最终成功；文案不得扩大这一语义。

## Review

经 `decision-review` 外部只读评审两轮。首轮要求补足 launcher 的成功 / 失败可观察契约、localhost 代理边界与真实入口证据；复核确认修正成立、无 blocker，并要求持续守住“request 已处理不等于同步成功”的表述边界。
