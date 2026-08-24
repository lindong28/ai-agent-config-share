# tt-web

Localhost-only dashboard for reviewing Claude Code and Codex token usage, cost, model mix, projects, and sessions.

## Install

```bash
./tt-web/install.sh
```

The installer is idempotent. It creates `state/` and `web/vendor/`, downloads pinned Chart.js `4.4.0` and the IBM Plex Sans/Mono web fonts the UI is set in, and links `tt-web` into `~/.local/bin/`.
Fonts that cannot be fetched are reported as `degraded` rather than failing the install — the pages still render, in the system font stack. Re-run the installer once the network allows it; it re-fetches anything missing, and also anything truncated or corrupt.
It also links `ip-check` into `~/.local/bin/` for terminal network diagnostics.
It does not install the optional rollup LaunchAgent; that daemon is opt-in.

## Run

```bash
tt-web start
tt-web restart
tt-web open
tt-web status
tt-web stop
```

Default URL is `http://127.0.0.1:39001`; if that port is occupied, the CLI increments to the next free port and writes it to `state/port`.

The server freezes its code in memory at startup, so after a `git pull` a bare `tt-web start` no-ops and keeps serving the old code. `tt-web open` detects that and restarts for you; `tt-web restart` does it explicitly.

`tt-web` is symlinked into `~/.local/bin` (usable from any directory). For the repo's uniform service-ops convention (see [`service-operations-protocol.md`](../claude/references/service-operations-protocol.md)), the equivalent entry points are `./tt-web/{install,start,stop,status,uninstall}.sh`. `start.sh` and `stop.sh` are thin wrappers over the dispatcher and **always act on the web server — they ignore any service-name argument**, so `./tt-web/stop.sh rollup-daemon` stops the web server and exits 0. `status.sh` and `uninstall.sh` do take a `[web|rollup-daemon]` argument. Called with no argument, `./tt-web/uninstall.sh` removes everything: it stops the server, removes the `~/.local/bin` symlinks, and also boots out and deletes the `com.ttweb.rollup` LaunchAgent if it is installed.

## Machines

The dashboard runs on one machine and reports usage for every machine you
declare. It reaches each remote over SSH, asks it to export a snapshot of its
own usage, and merges those snapshots into one view. `All` on any page means
"every machine currently admitted", and the page says which those are.

`machines.json` is the declaration. **It is checked into this repo carrying the maintainer's own machines**, so a fresh clone starts with someone else's list, not an empty one — replace it with yours before enabling anything here, or the dashboard will try to reach hosts you do not have. It is also git-tracked and part of the export version fingerprint, so commit your edit rather than leaving it dirty. This is not only about remotes: the machine running the dashboard exports its own snapshot through the same path, so an uncommitted edit here fails your own machine's export too — the symptom is your local usage going missing, not just a remote failing to arrive.

```json
{
  "machines": [
    { "name": "macbook", "ssh_host": "macbook", "self": true },
    { "name": "gpu-box", "ssh_host": "gpu-box", "self": false }
  ],
  "retired_names": []
}
```

- `name` labels the machine everywhere in the UI. Lowercase ASCII, digits, `-`
  and `_`; it is a directory component under `state/generations/`, so it cannot
  contain `/` or `.`. Exactly one machine has `"self": true`.
- `ssh_host` is whatever `ssh <host>` reaches — a real hostname or an alias from
  your SSH config. Two machines cannot share one target.
- **A name is never reused.** Retiring a machine records the name permanently so
  a later machine cannot inherit its published history: `tt-web machines retire
  <name>`. Removing a machine from `machines.json` without retiring it only
  deactivates it — put it back and its history returns.

**Each remote needs**: non-interactive SSH from the dashboard machine
(`ssh -o BatchMode=yes <host> true` must succeed without a prompt), this repo
checked out, and `~/.local/bin/tt-web` installed from it. Export refuses to run
when the code that produces the snapshot differs from its `HEAD` — the Python
modules, `parsers/`, `pricing.json`, the `tt-web` launcher, `install.sh` and
`machines.json`. A remote with uncommitted changes there reports a failure
rather than publishing a snapshot whose code version cannot be named. Edits
elsewhere in the checkout (docs, `web/`) do not block it.

A remote only reports **which account it is signed in as** once its checkout has
the account-stamping exporter; until then the dashboard shows its quota on its own
row as `account unknown` rather than guessing. Bringing one up to date is the
ordinary `git pull` in its checkout — no lockstep upgrade, because the stamp is an
added field inside an unchanged schema, so old and new machines mix freely.

**Adding a machine** takes two steps. Declare it in `machines.json`, then
accept the binding:

```bash
tt-web machines accept <name>
```

The first contact with an unseen SSH target is refused by design: the system can
only promise "the same machine as last time" — it cannot verify that the alias
points where you think it does. The command prints the name and SSH target, says
so in those terms, and waits for confirmation; answer anything but `y` and no
binding is written. It then pulls that machine's usage and reports the identity
it pinned. Later syncs fail closed if that identity changes. Use `--yes` to skip
the prompt in a script — check your SSH config first, because that flag is the
whole of the verification.

**Refresh and status**: `tt-web open` requests a fresh cross-machine generation every time before it opens the page; an already-running sync is reused. Ordinary page loads pull from the remotes when data is older than 10 minutes, and the Refresh button forces a pull. The first response never waits for the network — the page renders what it already has, marks itself syncing, and updates when the pull lands. If the CLI cannot request a refresh, it warns, opens the existing data, and tells you to retry with the page's Refresh button. Each machine's card distinguishes *not reachable now* from *data is old*: both can be true at once, and a machine that has never been reached successfully is excluded from `All` while still counting in the `coverage N/M` denominator.

**Retention**: each machine keeps its current snapshot and the previous one;
older ones are removed as new ones publish. A snapshot in use by a reader is not
deleted out from under it.

**Updating a remote**: deploy by updating that machine's checkout to the commit
you want and rerunning its installer. To roll back, check that machine out to the
earlier commit and rerun the installer; published snapshots are independent of
the code version that produced them, so a rollback does not discard data.

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

To inspect rollup integrity without changing the rollup database, run:

```bash
tt-web rollup --check
tt-web rollup --check --json
```

`status` is the overall result: `safe` means the database snapshot and source scan were complete, with no protected-field shrink or project-identity blocker; `attention` means the complete scan found at least one `would_skip` bucket or blocked source path; `indeterminate` means the checker could not obtain a complete, consistent comparison, so it is not evidence that the rollup is clean. `verdict` is narrower: it reports only the shrink guard (`safe`, `attention`, or `unknown`) and can be `safe` for the buckets that were compared while the overall `status` is `indeterminate`. Scripts must parse `status` rather than treating a zero exit code or `verdict: safe` as a clean result.

The dry-run readings are: `orphan_rows`, rows already in SQLite that current source no longer produces and that rollup will preserve; `would_skip`, current buckets whose token/message/entry counters are below the stored values and whose whole-row update would therefore be skipped; and `would_write`, new or changed buckets that rollup would write, including cost-only changes but excluding exact no-ops. `would_skip` and `would_write` cover only buckets inside the inclusive 28-day recompute window plus one-time backfills for source dates the database has never seen; existing rows outside the window are frozen and appear in neither set. `orphan_rows` is evaluated across all persisted rows. `db_span` describes the persisted date range and row count; `window` describes the recompute window. `orphan_rows > 0` after expected source retention does not require rollup-database repair, but an unexpected disappearance should be investigated and the source restored when possible.

For `attention`, inspect the reported `would_skip` old/new fields and identity blockers before running another rollup. The check is read-only: a blocker present only in `current_blockers` is not persisted by `--check` and may therefore be absent from `tt-web rollup blockers`; use the JSON diagnostic fields to distinguish it from a previously stored blocker. Use `tt-web rollup blockers` for persistent blocker details and only use a recovery command that it explicitly offers after the current source path or remote again directly matches the recorded candidate. For `indeterminate`, fix the reported database, snapshot, permission, or source-scan error and rerun the check. Do not respond by deleting `state/rollup.db`, deleting rows, or overwriting preserved history; those actions destroy the very baseline the guard protects.

## Tests

```bash
.venv/bin/python -m unittest discover -s tt-web/tests -t tt-web
```

The suite is pure `unittest` and depends on `requests`, which the
repo-root shared venv (`.venv/`, provisioned by the top-level `install.sh`)
already provides. Run it through that interpreter, not system `python3` — the
latter lacks `requests` and fails before any test runs. For a one-shot run
without the venv, `uvx --with requests pytest tt-web/tests -q` also works.

## Consumers

- `/` shows KPI cards for cost, and quota used as **one row per account** — Claude 5h / 7d and Codex 7d. The table separates Provider, Plan, and Account into aligned columns, with each live row naming the machines signed into that account. Quota is metered per account, so rows are never summed; a machine whose tt-web predates account stamping gets its own row labelled `account unknown`, never folded into a named account. A row's numbers are attributed to the account that machine is signed in as *now*, which is wrong for the window right after an account switch — see [ADR-024](../docs/adr/024-tt-web-quota-account-attribution.md) for why that is accepted and what it costs. Accounts observed while signed in remain as visibly historical `已登出` rows after they disappear from every admitted machine. Those rows retain their last observed values without claiming they are current; use the per-row `移除` control and confirm the account, observation time, and last reading to forget one permanently. Memory starts accumulating when this feature is installed, so accounts that were already signed out cannot be backfilled from older data. `Week cost` is the local calendar week window, shown as Monday 00:00 through now with the machine timezone offset. The first chart panel is titled `Cost over time` (synced with `web/index.html`), is range-aware, and reads persisted history from `state/rollup.db`.
- `/explore` exposes pivot controls for x axis, grouping, metric, and range, plus
  agent/project/model filters (range-scoped options) that narrow the chart and
  table; active filters persist in the URL and honor deep links.
  Range presets are `7d`, `30d`, `90d`, `6m`, `1y`, `2y`, and `all`. When no
  x-axis is pinned in the query string, time ranges default to day buckets up
  to 90d, week buckets up to 1y, and month buckets beyond that.
  High-cardinality groupings (more than 15 distinct values, e.g. project) fold to
  the top 12 by the selected metric plus a single `Other` bucket; long path labels
  render shortened with the full value kept in the hover title.
  The chart carries a second, tighter limit of its own: it draws at most 8 series,
  because the palette has 8 slots and a ninth series would have to reuse a colour.
  Token and message metrics pool the remainder into one `Other` line. Cost does
  not — a null cost cell means either "no activity" or "price unknown", and those
  are indistinguishable by the time they reach the page, so pooling would publish
  a total that silently omits real spend. Cost instead charts the 8 largest by
  known cost and says on the page how many series were left out. The table below
  the chart always lists every series, and leads with the row you are most likely
  after: the largest total on a project/model/agent axis, the newest bucket on a
  time axis. The chart keeps its own axis running oldest to newest either way.
- `/sessions` lists sessions and expands rows into turn-level usage, filtered by
  agent, project, and model (options drawn from the loaded rows) and paged 100 at
  a time; the column header stays fixed while the rows scroll, and rows are
  grouped under the date they started when sorted by time. This view
  intentionally stays on the raw live parse path, so `all` is still bounded by
  raw log retention (about 30 days), while `/` and `/explore` can use persisted
  rollup history for longer spans.
- `/network` shows the same DNS, IPv6, public IP, proxy-risk, and timezone
  diagnostics exposed by `ip-check --json`, with a 60s cache and Refresh for a
  forced recheck.

Historical daily rollups are stored in SQLite WAL at `state/rollup.db`, keyed by `(date, agent, project, model)`. Each rollup normally recomputes the inclusive most recent 28 days. A stored key that current source no longer produces is left untouched. If current source still produces the key but any token, message, or entry counter is lower than its stored value, the entire update is skipped and the last trusted row is kept; other keys, including sibling projects on the same day, continue updating. Existing rows outside the window are frozen, while a previously unseen date that is still present in source may be backfilled once.

Cost is an API-list-price equivalent, not a bill. Claude Code and Codex are used here under seat subscriptions that do not meter tokens, and neither writes a per-call charge into its logs, so every row is priced from a model rate table: LiteLLM's published rates when they cover the model, the bundled `pricing.json` when the fetch fails or LiteLLM has no key, and a same-family estimate for GLM-5.1/5.2. A logged `costUSD`, if a source ever emits one, is used verbatim in place of the rate table. Anthropic 1-hour cache writes are charged at the model's `above_1hr` rate, falling back to the 5-minute rate when the table has no 1-hour entry; a source that does not report the 5-minute/1-hour split is priced entirely at the 5-minute rate. Within the 28-day recompute window, accepted rows are recomputed from currently readable source. Rows with missing source or a protected-counter decrease keep their last trusted cost, and existing rows outside the window remain frozen. Unknown model pricing is displayed as `—`, not `0`.

Two known cost gaps are not modelled. Codex reports no cache-write volume, so OpenAI's cache-write charge is absent from Codex rows. Model identity is resolved by substring match when the exact key is missing, which can land on a differently-priced host of the same model; a `Fuzzy pricing match` warning is logged when it does.

### Known rollup limitations

- Rows written before cross-file deduplication landed keep their pre-deduplication values. One Claude API call reaches the loader once per transcript file recording it, and Claude Code copies a whole transcript into a new session file on resume or fork, so those older rows counted such calls once per copy. Deduplicating lowers the token, entry, and message counters for the affected buckets, which the protected-counter guard reads as a regression and skips, and rows outside the 28-day window are frozen regardless. The stored history was therefore left as it stands rather than rebuilt, because 35 of its dates no longer exist in source and rebuilding would delete them. Buckets first written after the change are deduplicated; older ones read high, by roughly 9% on the affected Claude buckets.

- The integrity promise is **statistics do not decrease**, not **totals are always complete**. It can undercount when, on the same day and in the same `(agent, project, model)` bucket, one session's source disappears while another session keeps growing. The guard first keeps the old aggregate; once the remaining session grows past that old aggregate, the new value is accepted even though the missing session's contribution is no longer included. The dashboard will show a non-decreasing total that is lower than the true combined total, and the checker may report no shrink because neither the stored aggregate nor current source contains enough identity-level history to detect it. This usually happens only on the current day while sessions are active, but the same sequence can occur on a historical date inside the 28-day window if delayed writes, restored logs, or backfilled source later make its remaining total grow.
- Two source paths may previously have contributed to the same project identity. If one path is later deleted or points at a different remote, another path can claim the old project during classification; a retry can then classify the changed path under its new project instead of keeping it blocked. The old project row is preserved while new usage is written under the new project, so the dashboard can show both old and new project rows and their sum can double count the changed path, without an active blocker remaining for that run. Distinguishing the old rows by originating path requires source-path lineage that `daily_rollup` does not store.
- Once a source path has a persisted project identity, later runs reuse it without re-reading Git. If that repository is genuinely renamed remotely, new usage continues under the old project name: the dashboard keeps showing the old name and no blocker appears. This is a stale classification label rather than a decrease in token totals; safely detecting the rename without reacting to transient Git failures also requires source-path lineage.
- The recovery tooling does not migrate historical rows to a renamed remote. When a path without a reusable persisted identity resolves to a remote that cannot be reconciled with unclaimed history, `tt-web rollup blockers` keeps it active: old project rows remain visible, but new usage from that path is paused. A strict pin is offered only when the blocker recorded one unique historical `pin_candidate` and the path's current path or remote again directly and uniquely matches that same candidate. Otherwise recovery is refused. Moving old history to the new name remains unsupported because the rows have no source-path lineage.

`state/rollup.db.lock` (generally `<db_path>.lock`) is a persistent coordination inode, not a disposable temporary file. Cleanup scripts, tmp-reapers, and manual `state/` maintenance must never delete, replace, rotate, or recreate it. `flock` follows the inode: recreating the same pathname while another process holds the old inode silently splits writers into two independent lock domains.

Timestamps (quota resets, session and turn times) render in the machine's
current system timezone with a UTC-offset label (e.g. `GMT+8`). The zone is
resolved live by the server from the OS setting (`/api/timezone`, read from
`/etc/localtime` per request), so the display follows System Settings and never
a browser left running on a stale timezone.

## Network Check

```bash
tt-web network            # the /network page, in the terminal
tt-web network --force    # skip the cache and probe again
tt-web network --json     # raw /api/network payload
ip-check                  # the upstream table, unmediated
```

`tt-web network` reports **this machine only**, matching the `/network` page —
nothing in it reaches the machines in `machines.json`, which govern usage sync
rather than diagnostics. To check another machine, run `ip-check` on it.

It reads the snapshot from a running tt-web server, so the terminal and the page
normally serve the same cached result instead of probing separately; with the
server stopped it runs the same check in-process. The server caches for 60s and
does not coalesce concurrent misses, so a cold cache or `--force` still lets two
near-simultaneous readers probe independently and land on different results.

The exit code says whether a report was produced, not how risky the network is:
`0` for any verdict including `high`, `2` when `ip-check` is missing, times out,
or returns unparseable output.

A risk grade is only printed when every input that feeds it answered. Several of
`ip-check`'s lookups report failure as ordinary result text rather than raising,
so a `proxycheck.io` timeout leaves a risk section whose score is null, an empty
`errors` list, and an upstream verdict that still reads `low`. In that case the
report prints **证据不足** and names the inputs that went unobserved, instead of a
grade three of its four inputs never earned — a qualifier under a headline that
still said "低风险" was not enough, because the headline is what a scanning
reader acts on. The exit code is unchanged: a report was still produced.

Egress goes through the route named in `~/.config/agent-proxy/current-proxy`,
resolved **once per round** and shared by all three probes, so the address the
report names is the one those probes actually went out through. Inheriting
`HTTP_PROXY` is not enough for a long-lived process: the tt-web server copies the
environment once at spawn, each route owns a fixed and distinct port, and the
tunnel behind the old one is gone the moment you switch — so a server started on
the Tencent route keeps dialing a dead port and never sees the public internet
again.

> **The publisher is not in place yet.** Nothing writes that file automatically
> today; it is maintained by hand, and this side cannot tell a current address
> from one left over from two switches ago — which is why the report says
> `发布文件指定`, never "current route". Until system-config's shell layer
> publishes on every switch, update it yourself when you switch. Deleting it is
> **not** a way to get the current route: a long-running server would fall back
> to the environment it inherited at spawn, which is the stale address this whole
> mechanism exists to route around.
>
> Whatever ends up writing it must publish by **atomic replace** (write a temp
> file in the same directory, then `rename`). An in-place truncate-then-write
> leaves a window where the file reads as empty, and empty is a meaningful value
> here — "this route runs direct" — so a probe landing in that window would
> bypass the proxy and snapshot the real public IP.

An unreadable or absent file, and content that is not a usable proxy URL (a route
name, a comment, two lines), both mean *no authoritative answer* rather than
*connect directly* — this side then does not take over routing at all and
`requests` uses the environment exactly as before. Reported as `本次探测出口`,
and in `--json` as `proxy_effective` (`address` + `source`, where `source` is
`published` / `unpublished` / `invalid`, plus a `reason` for the last two).

When a failed probe's address matches the route it went out through — or, absent
a publisher, one of this machine's proxy env vars — the report says so and spells
out the consequence, rather than printing the timeout and the proxy setting
sixteen rows apart and leaving the reader to notice they are the same address.

One case stays undecidable — `ip-check` reports no IPv6 address both when IPv6
is off and when the probe failed — so the report says "未检出地址" rather than
claiming it is disabled, and keeps that dimension outside the verdict.

`ip-check` prints the upstream table for a quick VPN or proxy sanity check.
`ip-check --json` is consumed by `/api/network` and is stable enough for local
scripts.

When `/network` reports `verdict: high`, see
[NETWORK-REMEDIATION.md](./NETWORK-REMEDIATION.md) — a per-finding runbook for
fixing IPv6 leaks, CN DNS exposure, and timezone mismatch on macOS, including
the manual proxy-GUI step that cannot be scripted.

`install.sh` runs this check once at the end of setup. It prints the findings and
a pointer to the runbook **only** when the verdict is `high`; on a clean
environment it stays silent. The probe never fails the install.
