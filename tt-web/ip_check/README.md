# ip_check

Local network diagnostics used by the `ip-check` command and the tt-web
`/network` page.

## Usage

```bash
ip-check
ip-check --json
```

`ip-check` prints the upstream colored table report. `ip-check --json` emits a
structured snapshot for scripts and for tt-web's `/api/network` endpoint.

## JSON Schema Summary

Top-level fields:

- `version`: local integration version.
- `timestamp`: UTC collection time.
- `system`: platform, Python, and timezone context.
- `local`: LAN IP, DNS servers, IPv6 availability, and interface hints.
- `public`: public IP and geolocation data.
- `risk`: proxy or hosting risk lookup, collected only when needed.
- `spam`: spam database lookup, collected only when needed.
- `proxy_envs`: proxy-related environment variables.
- `tz_check`: timezone consistency result.
- `conclusions`: human-readable findings.
- `verdict`: summarized status such as `low`, `medium`, `high`, or `unknown`.
- `errors`: per-section collection errors; partial failures stay in the JSON
  body instead of becoming process-level failures.

## Attribution

Based on the ipcheck PyPI package, with `--json` and `collect_all()` additions
for tt-web integration. The copied CLI keeps the upstream behavior and license
model; local additions are scoped to structured output and dashboard use.
