# im-notify

Channel-agnostic notification CLI for agents (Claude Code, Codex). Pushes a short message — with an optional title, clickable link, and image — to the user's phone via an IM channel, so they get notified when away from the Mac. One-way push only; for two-way control from your phone see the `claude-to-im` skill.

**v1 channel:** `feishu` (Feishu/Lark custom-bot incoming webhook). Text + link use the webhook directly. `--image` uses the configured Feishu application to upload the image, then sends the returned `image_key` through the same webhook.

The CLI name is deliberately channel-agnostic: `--channel` selects the backend,
so the default can move to wechat/slack later without changing the contract.

## Install

From repo root `./install.sh`, or directly:

```bash
./im-notify/install.sh
```

Symlinks `bin/im-notify` and `bin/run-or-alert` into `~/.local/bin` (on PATH).
Installation requires Node.js on `PATH`; a missing prerequisite fails before
any registration is changed.

This component installer is the sole lifecycle authority for those two
machine-local singleton paths. Reinstalling the same checkout is idempotent.
Another clone cannot replace or uninstall the incumbent symlinks: the exact
absolute symlink targets are the persistent ownership proof, and lifecycle
operations share a machine-local lock.

Before changing either registration, the installer uses the repository's Node
proof helper to atomically write and fsync a complete transaction, then publishes
one stable `lifecycle.lock` symlink to that transaction and fsyncs its parent.
The transaction records PID plus process-start identity. A published lock is
therefore never accepted without a complete, confined transaction proof; a
pre-lock orphan transaction is ignored. After a hard process crash, inspect and
recover through the owning checkout:

```bash
./im-notify/install.sh --status
./im-notify/install.sh --recover
./im-notify/install.sh --preflight
```

`--recover` validates the stale PID/start proof and transaction owner before
changing a registration. Pending install and uninstall transactions both
restore each registration to its recorded before-state, including mixed
current/absent states after a hard crash or failed rollback. Recovery validates
both paths before changing either one and never replaces drift: a foreign target
or a missing recorded owner source is reported as `repair-required`, and the
lock plus transaction are retained. `--preflight` succeeds only when both
registrations are consistently absent or current and the Authority has no
active or unresolved lock/transaction.

The fsync sequence is the durability contract for abrupt termination. Tests
exercise SIGKILL at each install and uninstall publication/mutation boundary,
plus failed install/uninstall rollback recovery. Crash injection is accepted
only in `isolated-v1` mode with a validated temporary root, sentinel, and nonce;
merely setting the test crash variable in a production invocation fails before
state or registrations are created. These tests do not claim to simulate
physical power loss.

Uninstall remains available after Node.js has been removed or the checkout's
proof helper is missing. In that degraded case it first verifies exact checkout
ownership, a canonical real state-directory chain, and absence of any lifecycle
lock, then uses the earlier rollback-only shell path. That fallback does not
claim hard-crash recovery; an existing lock must be inspected with the owning
checkout and proof helper rather than bypassed.

To hand ownership to another checkout, release the current owner first, then
install the new one:

```bash
REPO_DIR=/path/to/old/ai-agent-config ./im-notify/install.sh --uninstall
REPO_DIR=/path/to/new/ai-agent-config ./im-notify/install.sh
```

Either operation fails closed if the observed ownership proof does not match.

## Usage

```bash
im-notify "训练跑完了"
im-notify --title "构建完成" --link https://example.com/report "点开看报告"
im-notify --title "需要扫码" --image /path/to/qr.png "请用微信识别二维码"
echo "msg" | im-notify
```

See `im-notify --help`.

`--image` accepts one non-empty, non-symlink PNG, JPEG, WEBP, GIF, BMP, ICO, TIFF, or HEIC file up to 10 MB. The CLI uploads it as a Feishu message image, delivers the text first and the image second, and never prints application credentials or the tenant token. For one-time sensitive images such as login QR codes, the caller deletes the local file after each send attempt, whether delivery succeeds or fails.

The shared `im-notify` skill defines *when* an image handoff is triggered automatically; do not restate that condition here, or the two copies drift. What this CLI guarantees is narrower and is the part callers depend on: the caller supplies an image of the thing to be acted on (a waiting or expired placeholder saves and exits 0 exactly like a good capture, so it must be looked at, not merely produced), deletes the temporary local file after the send attempt, and treats exit code `0` as proof that Feishu accepted the send — never that the user received it. This default does not turn ordinary task completion into an automatic phone notification.

## Two modes

| Mode | Webhook | Sender | Typical caller |
|---|---|---|---|
| notification (default) | `FEISHU_GENERAL_NOTIFICATION_WEBHOOK` | the agent (Claude/Codex) → you | "跑完通知我" |
| alert (`--alert`) | `FEISHU_GENERAL_ALERT_WEBHOOK` | a **running service** → you, when it fails | a service's failure path |

Alert mode adds `--dedup-key <id>`: a repeat alert whose text is **exactly
unchanged** since the last send under that key is suppressed; it re-sends only when
the text changes. Without this a crash-looping service spams your phone. The match
is **exact by design** — any difference, *including a number* (a shard id, an HTTP
status, a count), is treated as a new alert and sends, because collapsing two
different failures onto one signature would silently drop the second (missing an
alert is the worst outcome). If you emit a volatile metric you *don't* want to
re-alert on (e.g. a fluctuating `91%`), bucket or omit that number in your message.
The `--link` URL is **not** part of the signature, so the same text with a
per-run URL is still deduped — vary the message text if you need a re-alert.
State lives in `$IM_NOTIFY_STATE_DIR` (default `~/.local/state/im-notify/`), which
also holds `alert-sent.log` (one line per send decision, for tracing).

```bash
# a service alerting on its own application-level failure
im-notify --alert --dedup-key ai-radar-pipeline "pipeline produced 0 rows"
```

Which failures warrant an alert, and when a service should emit one vs rely on an
external probe, is governed by
`claude/references/service-operations-protocol.md` § 故障告警.

## run-or-alert (cron / non-launchd crash wrapper)

A process that dies can't alert on itself, and an external launchd watchdog can't
see a cron job. `run-or-alert` bridges that gap: it wraps a command, and on a
non-zero exit pushes an alert via `im-notify --alert` (deduped by key, so a
crash-looping cron alerts **once**, not every run); on success it clears the key so
a later recurrence re-alerts. The wrapped command's own exit code is always
preserved, so it's a drop-in wrapper for a crontab/launchd entry.

```bash
# crontab: alert if the pipeline exits non-zero; dedup + auto-reset on recovery
*/10 * * * * run-or-alert --key ai-radar-pipeline -- /path/to/pipeline.sh
```

The alert message carries the host, the command, its exit code, and the last lines
of its output — but dedup is keyed on the **stable identity** (host + command + exit
code) via `im-notify --dedup-text`, so a run-varying log tail doesn't make every
failure look "new" and defeat the once-per-crash-loop guarantee. Reset uses
`im-notify --dedup-clear <key>` (also callable directly). Same
`FEISHU_GENERAL_ALERT_WEBHOOK` requirement as `--alert`.

## Config

Read from `~/.claude/.env`:

| Var | Required | Purpose |
|---|---|---|
| `FEISHU_GENERAL_NOTIFICATION_WEBHOOK` | yes (feishu) | Notification webhook (default mode) |
| `FEISHU_GENERAL_ALERT_WEBHOOK` | yes for `--alert` | Alert webhook (service failure alerts) |
| `FEISHU_APP_ID` | yes for `--image` | Feishu application identity used to upload a message image |
| `FEISHU_APP_SECRET` | yes for `--image` | Feishu application credential used only to obtain an upload token |
| `NOTIFY_DEFAULT_CHANNEL` | no | Default channel (else `feishu`) |

## Check

```bash
im-notify "im-notify self-test ✅"
```

Exit code `0` and a Feishu message arriving = healthy. On failure the CLI exits
non-zero and prints why (it does not silently swallow errors).

## Consumers

- **Claude Code** — skill `claude/skills/im-notify/` (triggers on "推到飞书 /
  我不在电脑前,通知我 / push me").
- **Codex** — the shared skill is exposed through `~/.agents/skills/im-notify`.
- **Services** (any project) — an application-level failure path calls
  `im-notify --alert --dedup-key <svc>` directly; a cron / non-launchd entry whose
  process-death a watchdog can't see wraps its command in `run-or-alert`. No skill
  involved; wired per `claude/references/service-operations-protocol.md` § 故障告警.

## Extending

Add a channel: implement an `async` sender in the `CHANNELS` map in
`bin/im-notify`, keyed by name; select it with `--channel <name>`.
