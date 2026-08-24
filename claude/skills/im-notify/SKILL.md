---
name: im-notify
description: Push a notification (text plus optional link or image) to the user's phone via an IM channel. Use when the user explicitly asks to be reached away from the Mac, or when a handoff needs the user to act on a device other than the one you are driving — scanning a QR being the usual case, in a browser or a terminal alike. That call falls due before you ask them to come to the machine, not after you happen to notice a code. Runs the channel-agnostic `im-notify` CLI (feishu now; wechat/slack later via --channel). NOT for desktop "task done" banners or two-way phone control.
allowed-tools: Bash(im-notify:*)
---

# im-notify

Push a notification to the user's phone by running the `im-notify` CLI (already on PATH).

## When to use

Use this skill when either condition holds:

- The user explicitly wants to be reached away from the Mac, such as “跑完推飞书”, “通知我一声”, or “send me this report link”.
- A handoff is blocking you now and the user must perform it on a device other than the one being driven — anything scanned is the common case, whether the code is in a browser or printed by a CLI; an in-app approval is the same handoff with nothing to send, so it warrants no push, only not summoning them to the machine. Settle which device *before* asking them to come: it is a reading of what the handoff requires, not a question to put to the user, and asking is useless anyway when they are already away. Where something is deliverable this defaults to a QR-only image via `im-notify --image`, even when the user did not separately request a phone notification.

Outside those conditions, do not auto-notify after every turn; that would duplicate the desktop notification and spam the phone.

## Inputs

| Use | Required input |
|---|---|
| Text or link notification | `FEISHU_GENERAL_NOTIFICATION_WEBHOOK` in `~/.claude/.env` |
| QR / `--image` handoff | `FEISHU_GENERAL_NOTIFICATION_WEBHOOK`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and a temporary QR-only local image path |

## Usage

```bash
im-notify "<message>"
im-notify --title "<title>" --link <url> "<message>"
im-notify --title "<title>" --image <path> "<message>"
```

- `--channel <name>` selects the IM channel (default `feishu`).
- `--link <url>` appends a clickable link; `--title <text>` adds a heading line.
- For a QR handoff, capture the currently displayed QR code itself into a temporary QR-only image; a waiting/ready status is not QR evidence. **Look at that image before sending it** — a blank capture and an expired, blurred-over code are both saved successfully and exit 0, so the capture's own exit status cannot tell you which one you have. Delete the local image after the send attempt, then ask the user to confirm receipt. Exit code `0` proves only that Feishu accepted the send; until confirmation, report receipt as unverified.
- Config comes from `~/.claude/.env`. If the CLI exits non-zero it prints the reason — surface that to the user, do not silently swallow it.

Run `im-notify --help` for all options.

## Not this skill

- **Desktop "done" banners** — handled automatically by the desktop notification hook (Claude Code); nothing to invoke.
- **Two-way control from the phone** — that's the `claude-to-im` bridge.
- **A service alerting on its own failure** — not an agent action, so not this skill. The service's own code calls `im-notify --alert --dedup-key <svc>` directly. When you *build* a service, wire this per `~/.claude/references/service-operations-protocol.md` § 故障告警.
