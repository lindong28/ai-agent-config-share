# tt-web Services

This page is the operational inventory for long-running tt-web services. Source,
state, logs, and generated SQLite files stay inside `tt-web/` unless noted.

## Service Inventory

| Service | Default | Supervisor | State / logs | Purpose |
| --- | --- | --- | --- | --- |
| `tt-web` | Manual | PID file in `state/pid`; port in `state/port` | `state/server.log` | Local dashboard server for usage, cost, sessions, Explore pivots, and `/network`. |
| `com.ttweb.rollup` | Opt-in | macOS LaunchAgent at `~/Library/LaunchAgents/com.ttweb.rollup.plist` | `state/rollup.db`, `state/rollup-daemon.log` | Runs `tt-web rollup` hourly to keep historical daily cost rollups warm. |

## Operations

| Operation | Web server | Rollup daemon |
| --- | --- | --- |
| Install | `./tt-web/install.sh` | `./tt-web/install.sh rollup-daemon` |
| Status | `./tt-web/status.sh web` or `tt-web status` | `./tt-web/status.sh rollup-daemon` |
| Integrity check | — | `tt-web rollup --check` or `tt-web rollup --check --json` |
| Start | `./tt-web/start.sh` or `tt-web start` | LaunchAgent runs at load and every 3600 seconds; reinstall to load |
| Stop | `./tt-web/stop.sh` or `tt-web stop` | `./tt-web/uninstall.sh rollup-daemon` |
| Uninstall | `./tt-web/uninstall.sh web` | `./tt-web/uninstall.sh rollup-daemon` |

No-argument `./tt-web/install.sh` installs the web CLI, vendored Chart.js, and
`ip-check` symlinks only. It deliberately does not install `com.ttweb.rollup`.

Note that `start.sh` and `stop.sh` always act on the web server and ignore any
service-name argument; only `status.sh` and `uninstall.sh` take `[web|rollup-daemon]`.

No-argument `./tt-web/status.sh` is read-only and prints both web and rollup
daemon status. No-argument `./tt-web/uninstall.sh` removes both service layers
if present while keeping source, `state/`, and vendored assets.

## Cross-Machine Sync

The dashboard machine pulls usage from every machine declared in
`tt-web/machines.json`. There is no daemon for this: a page load pulls when its
data is older than 10 minutes, and Refresh forces a pull. Declaring, retiring and
first-use acceptance are covered in [../../README.md](../../README.md#machines).

| Operation | Command | Notes |
| --- | --- | --- |
| Produce a snapshot (runs on the remote, normally invoked over SSH) | `tt-web export --out <dir>` | Writes `snapshot.db` + `export.json`. Refuses when the snapshot-producing code differs from `HEAD` — `*.py`, `parsers/**`, `pricing.json`, `tt-web`, `install.sh`, `machines.json`. Uncommitted docs or `web/` assets do not block it. |
| Report the exporter's commit | `tt-web export --version` | Same scoped refusal — it will not print a clean-looking SHA it cannot stand behind. |
| Bind a newly declared machine to its SSH target | `tt-web machines accept <name> [--yes]` | Required once before that machine can be pulled. Prompts with the name and target; refuses to write a binding unless confirmed. |
| Retire a machine name permanently | `tt-web machines retire <name>` | Written before `machines.json` is updated; the name can never be reused. |
| Adopt a bucket-timezone marker on an unmarked database | `tt-web rollup adopt-timezone --db <path> --known-utc-offset +08:00 …` | For databases predating the marker. Requires explicit authorization flags and prints exactly what it did and did not verify. |

Published snapshots live under `state/generations/<machine>/<generation-id>/`,
with a `current` pointer per machine. Each machine keeps its current and previous
generation; older ones are removed as new ones publish, and a generation a reader
holds open is not removed under it.

Failure of one machine never blocks the others: that machine keeps its previous
snapshot, is reported as unreachable with a reason, and the sync still reaches a
terminal state. A machine that has never been reached successfully is excluded
from totals but still counts in the coverage denominator, so the page shows
`N/M` rather than silently narrowing what `All` means.

Remote calls are non-interactive (`ssh -o BatchMode=yes -o ConnectTimeout=10`)
with a hard timeout on the whole export, so an unreachable host cannot hang the
page. Temporary export directories on the remote are reaped by the next sync.

## Rollup Details

`state/rollup.db` is a local SQLite WAL database with daily buckets by `Asia/Shanghai` date, agent, project, and model. The bucket boundary is fixed rather than following the host's timezone, so that snapshots from machines in different timezones can be summed by date; the database records which boundary its rows were built with and refuses to be read if that marker is absent or disagrees. Absolute timestamps in the UI still render in the viewer's local timezone — only the aggregation boundary is fixed. `tt-web rollup` normally recomputes an inclusive 28-day window. Missing keys and updates whose token/message/entry counters would shrink are preserved at their last trusted row; sibling keys continue updating. Within the 28-day recompute window, accepted rows are recomputed from currently readable source. Logged costs remain the logged values; entries without exact cost use the pricing data currently available to tt-web. Rows with missing source or a protected-counter decrease keep their last trusted cost, and existing rows outside the window remain frozen.

`tt-web rollup --check [--json]` takes a coordinated, read-only snapshot and compares it with a read-only source scan. The human form is for diagnosis; `--json` exposes the same fields to scripts. A successful command exit does not mean the result is clean, so automation must parse `status`:

| Reading | Operational meaning |
| --- | --- |
| `status: safe` | Database and source scan were complete, with no protected-field shrink and no project-identity blocker. |
| `status: attention` | The complete comparison found one or more `would_skip` buckets or blocked source paths. Investigate before treating the rollup as healthy. |
| `status: indeterminate` | A complete, consistent comparison was unavailable because the database/snapshot was not ready or a source scan failed. This is not a clean result. |
| `verdict` | Bucket shrink result only: `safe` for compared buckets, `attention` when a protected field would decrease, or `unknown` only when bucket comparison could not begin at all. It does not replace overall `status`. |
| `db_state` | Whether the database snapshot was ready for comparison. Any value other than `ready` makes the result indeterminate; when present, `diagnostic_errors` describes the database or lock-snapshot failure. |
| `scan_complete` / `source_errors` | Completeness of the read-only source scan and its per-source failures. `scan_complete: false` or any `source_errors` forces overall `status: indeterminate`, even if `verdict` is `safe` or `attention` for the subset that was compared. |
| `diagnostic_errors` | Database or coordinated-snapshot failures that prevented comparison. These accompany an indeterminate result and `verdict: unknown`. |
| `blocked_sources` | The source-path-deduplicated union of persisted and currently discovered identity blockers. On a complete scan, any item drives overall `status: attention`. |
| `persisted_blockers` | Active blocker records that were already stored before this check. |
| `current_blockers` | Blockers found by this read-only scan. `--check` does not persist them, so a current-only blocker can be absent when a subsequent `tt-web rollup blockers` lists stored blockers. |
| `orphan_rows` | Stored keys absent from current source, evaluated across all persisted rows. Rollup preserves them. After expected retention, a non-zero count needs no rollup-database repair; if disappearance was unexpected, investigate or restore the source. |
| `would_skip` | Keys whose protected token/message/entry fields are lower than stored values. Rollup would keep the whole old row, including its cost. This set is limited to the inclusive recompute window plus one-time backfills for source dates the database has never seen. |
| `would_write` | New or changed keys that rollup would write, including cost-only changes and excluding exact no-ops. It has the same window/backfill scope as `would_skip`; frozen existing rows outside that scope appear in neither set. |
| `db_span` / `window` | Persisted date span and row count / inclusive recompute window used for the comparison. |

For `attention`, inspect the `would_skip` old/new fields and all three blocker arrays. Run `tt-web rollup blockers` for persistent status and use only an explicitly offered recovery command after the current source path or remote again directly matches the recorded candidate. For `indeterminate`, resolve the reported database, lock snapshot, permission, or source-scan error and rerun the checker. On a genuinely fresh installation with no initialized database, one normal `tt-web rollup` creates it; on an existing installation, never use deletion or replacement as a repair shortcut. Do not delete the database, delete rows, or overwrite preserved history while investigating.

`state/rollup.db.lock` (generally `<db_path>.lock`) is a persistent coordination inode and part of the service state. Every cleanup script, tmp-reaper, backup rotation, and manual cleanup touching `state/` must exclude `*.lock`: never unlink, replace, rotate, or recreate this file. `flock` is attached to the inode, so a same-name replacement can let a writer holding the old inode and a writer holding the new inode both enter what appear to be protected sections. The existing uninstall path intentionally keeps `state/`; future cleanup tooling must preserve this constraint.

### If the lock file is already missing

Do not run a normal rollup immediately: the web service, rollup daemon, or a manual rollup may still hold the unlinked inode, and creating the pathname again would split coordination into two lock domains. Stop the web service with `tt-web stop`, unload the daemon with `./tt-web/uninstall.sh rollup-daemon`, and confirm that `pgrep -fl '[t]t-web rollup'` prints no manual rollup process. Only after all possible holders are gone, run one normal `tt-web rollup` to initialize a new lock file, then run `tt-web rollup --check` before restarting the web service with `tt-web start` and reinstalling the daemon with `./tt-web/install.sh rollup-daemon`. Re-enable only the service layers that were active before the incident.

The LaunchAgent plist uses:

- Label: `com.ttweb.rollup`
- Program: `tt-web rollup`
- RunAtLoad: `true`
- StartInterval: `3600`
- Log: `tt-web/state/rollup-daemon.log`

The dashboard also triggers a throttled background rollup on startup and on
Overview/Explore API requests. The LaunchAgent is optional redundancy for users
who want history refreshed even when the dashboard is not open.
