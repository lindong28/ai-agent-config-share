# tt-web

Localhost-only dashboard for reviewing Claude Code and Codex token usage, cost, model mix, projects, and sessions.

## Install

```bash
./tt-web/install.sh
```

The installer is idempotent. It creates `state/` and `web/vendor/`, downloads pinned Chart.js `4.4.0`, and links `tt-web` into `~/.local/bin/`.
It also links `ip-check` into `~/.local/bin/` for terminal network diagnostics.
It does not install the optional rollup LaunchAgent; that daemon is opt-in.

## Run

```bash
tt-web start
tt-web open
tt-web status
tt-web stop
```

Default URL is `http://127.0.0.1:39001`; if that port is occupied, the CLI increments to the next free port and writes it to `state/port`.

`tt-web` is symlinked into `~/.local/bin` (usable from any directory). For the repo's uniform service-ops convention (see [`service-operations-protocol.md`](../claude/references/service-operations-protocol.md)), the equivalent entry points `./tt-web/{start,stop,status,uninstall}.sh` wrap the same dispatcher; `./tt-web/uninstall.sh` stops the server and removes the `~/.local/bin` symlinks.

## Services

| Service | Supervisor | Purpose | Operations |
| --- | --- | --- | --- |
| `tt-web` | Manual PID-file daemon in `state/` | Local dashboard server at `127.0.0.1:<port>` | `tt-web start`, `tt-web stop`, `tt-web status`; script equivalents: `./tt-web/start.sh web`, `./tt-web/stop.sh web`, `./tt-web/status.sh web` |
| `com.ttweb.rollup` | Optional macOS LaunchAgent | Hourly refresh of `state/rollup.db` using `tt-web rollup` | `./tt-web/install.sh rollup-daemon`, `./tt-web/status.sh rollup-daemon`, `./tt-web/uninstall.sh rollup-daemon`; default `./tt-web/install.sh` does not install it |

Operational details live in [docs/operations/services.md](./docs/operations/services.md).

## Check

```bash
tt-web start && curl -s 127.0.0.1:$(cat tt-web/state/port)/api/overview | head -50
```

## Tests

```bash
.venv/bin/python -m unittest discover -s tt-web/tests -t tt-web
```

The suite is pure `unittest` (83 tests) and depends on `requests`, which the
repo-root shared venv (`.venv/`, provisioned by the top-level `install.sh`)
already provides. Run it through that interpreter, not system `python3` — the
latter lacks `requests` and fails before any test runs. For a one-shot run
without the venv, `uvx --with requests pytest tt-web/tests -q` also works.

## Consumers

- `/` shows KPI cards, including Claude 5h / 7d quota and Codex 7d quota. `Week cost`
  is the local calendar week window, shown as Monday 00:00 through now with the
  machine timezone offset. The first chart panel is titled `Cost over time`
  (synced with `web/index.html`), is range-aware, and reads persisted history
  from `state/rollup.db`.
- `/explore` exposes pivot controls for x axis, grouping, metric, and range, plus
  agent/project/model filters (range-scoped options) that narrow the chart and
  table; active filters persist in the URL and honor deep links.
  Range presets are `7d`, `30d`, `90d`, `6m`, `1y`, `2y`, and `all`. When no
  x-axis is pinned in the query string, time ranges default to day buckets up
  to 90d, week buckets up to 1y, and month buckets beyond that.
  High-cardinality groupings (more than 15 distinct values, e.g. project) fold to
  the top 12 by the selected metric plus a single `Other` bucket; long path labels
  render shortened with the full value kept in the hover title.
- `/sessions` lists sessions and expands rows into turn-level usage. This view
  intentionally stays on the raw live parse path, so `all` is still bounded by
  raw log retention (about 30 days), while `/` and `/explore` can use persisted
  rollup history for longer spans.
- `/network` shows the same DNS, IPv6, public IP, proxy-risk, and timezone
  diagnostics exposed by `ip-check --json`, with a 60s cache and Refresh for a
  forced recheck.

Historical daily rollups are stored in SQLite WAL at `state/rollup.db`. Each
rollup recomputes only the most recent 28 days, which stays below Claude's
roughly 30-day raw-log retention. Within that window, recompute refreshes only
the `(date, agent)` groups that still have source data: if one agent's raw logs
are deleted, its already-collected rows for those days are preserved instead of
wiped, while other agents on the same day still refresh. Older daily rows
(outside the window) are frozen as collected. Net effect — deleting raw logs
never erases stats already captured into the rollup, so raw-log retention can be
set far shorter than rollup history (a day must still be captured by at least
one rollup run while its raw logs exist).

Cost baselines are mixed by source: Claude rows use logged `costUSD`; Codex rows
use GPT-5 pricing estimates when exact billing is absent; GLM-5.1/5.2 rows use a
bundled GLM-5 family estimate when LiteLLM has not published exact keys. The
`Cost over time` panel includes an on-panel footnote that historical costs are
frozen at collection-time pricing. Unknown model pricing is displayed as `—`,
not `0`.

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
