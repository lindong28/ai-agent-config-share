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
| Start | `./tt-web/start.sh web` or `tt-web start` | LaunchAgent runs at load and every 3600 seconds; reinstall to load |
| Stop | `./tt-web/stop.sh web` or `tt-web stop` | `./tt-web/uninstall.sh rollup-daemon` |
| Uninstall | `./tt-web/uninstall.sh web` | `./tt-web/uninstall.sh rollup-daemon` |

No-argument `./tt-web/install.sh` installs the web CLI, vendored Chart.js, and
`ip-check` symlinks only. It deliberately does not install `com.ttweb.rollup`.

No-argument `./tt-web/status.sh` is read-only and prints both web and rollup
daemon status. No-argument `./tt-web/uninstall.sh` removes both service layers
if present while keeping source, `state/`, and vendored assets.

## Rollup Details

`state/rollup.db` is a local SQLite WAL database with daily buckets by local
date, agent, project, and model. `tt-web rollup` recomputes only a 28-day
window, strictly below Claude's roughly 30-day raw-log retention, so frozen
history outside that window is not rewritten from partially expired source logs.

The LaunchAgent plist uses:

- Label: `com.ttweb.rollup`
- Program: `tt-web rollup`
- RunAtLoad: `true`
- StartInterval: `3600`
- Log: `tt-web/state/rollup-daemon.log`

The dashboard also triggers a throttled background rollup on startup and on
Overview/Explore API requests. The LaunchAgent is optional redundancy for users
who want history refreshed even when the dashboard is not open.
