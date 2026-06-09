# tt-web

Localhost-only dashboard for reviewing Claude Code and Codex token usage, cost, model mix, projects, and sessions.

## Install

```bash
./tt-web/install.sh
```

The installer is idempotent. It creates `state/` and `web/vendor/`, downloads pinned Chart.js `4.4.0`, and links `tt-web` into `~/.local/bin/`.
It also links `ip-check` into `~/.local/bin/` for terminal network diagnostics.

## Run

```bash
tt-web start
tt-web open
tt-web status
tt-web stop
```

Default URL is `http://127.0.0.1:39001`; if that port is occupied, the CLI increments to the next free port and writes it to `state/port`.

`tt-web` is symlinked into `~/.local/bin` (usable from any directory). For the repo's uniform service-ops convention (see [`service-operations-protocol.md`](../claude/references/service-operations-protocol.md)), the equivalent entry points `./tt-web/{start,stop,status,uninstall}.sh` wrap the same dispatcher; `./tt-web/uninstall.sh` stops the server and removes the `~/.local/bin` symlinks.

## Check

```bash
tt-web start && curl -s 127.0.0.1:$(cat tt-web/state/port)/api/overview | head -50
```

## Consumers

- `/` shows KPI cards, including Claude and Codex 5h / 7d quota, and default overview charts.
- `/explore` exposes pivot controls for x axis, grouping, metric, and range.
- `/sessions` lists sessions and expands rows into turn-level usage.
- `/network` shows the same DNS, IPv6, public IP, proxy-risk, and timezone
  diagnostics exposed by `ip-check --json`, with a 60s cache and Refresh for a
  forced recheck.

Timestamps (quota resets, session and turn times) render in the machine's
current system timezone with a UTC-offset label (e.g. `GMT+8`). The zone is
resolved live by the server from the OS setting (`/api/timezone`, read from
`/etc/localtime` per request), so the display follows System Settings and never
a browser left running on a stale timezone.

## Network Check

```bash
ip-check
ip-check --json
```

The table command is intended for quick VPN or proxy sanity checks. The JSON
command is consumed by `/api/network` and is stable enough for local scripts.

When `/network` reports `verdict: high`, see
[NETWORK-REMEDIATION.md](./NETWORK-REMEDIATION.md) — a per-finding runbook for
fixing IPv6 leaks, CN DNS exposure, and timezone mismatch on macOS, including
the manual proxy-GUI step that cannot be scripted.

`install.sh` runs this check once at the end of setup. It prints the findings and
a pointer to the runbook **only** when the verdict is `high`; on a clean
environment it stays silent. The probe never fails the install.

Codex cost is an estimate from GPT-5 pricing when exact billing is unavailable. Unknown model pricing is displayed as `—`, not `0`.
