# tt-web

Localhost-only dashboard for reviewing Claude Code and Codex token usage, cost, model mix, projects, and sessions.

## Install

```bash
./tt-web/install.sh
```

The installer is idempotent. It creates `state/` and `web/vendor/`, downloads pinned Chart.js `4.4.0`, and links `tt-web` into `~/.local/bin/`.

## Run

```bash
tt-web start
tt-web open
tt-web status
tt-web stop
```

Default URL is `http://127.0.0.1:39001`; if that port is occupied, the CLI increments to the next free port and writes it to `state/port`.

## Check

```bash
tt-web start && curl -s 127.0.0.1:$(cat tt-web/state/port)/api/overview | head -50
```

## Consumers

- `/` shows KPI cards, including Claude and Codex 5h / 7d quota, and default overview charts.
- `/explore` exposes pivot controls for x axis, grouping, metric, and range.
- `/sessions` lists sessions and expands rows into turn-level usage.

Codex cost is an estimate from GPT-5 pricing when exact billing is unavailable. Unknown model pricing is displayed as `—`, not `0`.
