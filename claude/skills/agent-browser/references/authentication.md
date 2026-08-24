# Authentication Patterns

Login flows, session persistence, OAuth, 2FA, and authenticated browsing.

**Related**: [session-management.md](session-management.md) for state persistence details, [Core Workflow](../SKILL.md#core-workflow).

Unless a section explicitly selects an existing CDP browser, its examples use the default browser. When continuing a workflow already running on a CDP path, do not run them bare — follow [Browser Identity Continuity](../SKILL.md#browser-identity-continuity).

## Contents

- [Credential Vault](#credential-vault)
- [Reuse Chrome Dev Authentication via CDP Cookies](#reuse-chrome-dev-authentication-via-cdp-cookies)
- [Import Auth from an Existing CDP Browser](#import-auth-from-an-existing-cdp-browser)
- [Persistent Profiles](#persistent-profiles)
- [Session Persistence](#session-persistence)
- [Basic Login Flow](#basic-login-flow)
- [Saving Authentication State](#saving-authentication-state)
- [Restoring Authentication](#restoring-authentication)
- [OAuth / SSO Flows](#oauth--sso-flows)
- [Two-Factor Authentication](#two-factor-authentication)
- [HTTP Basic Auth](#http-basic-auth)
- [Cookie-Based Auth](#cookie-based-auth)
- [Token Refresh Handling](#token-refresh-handling)
- [Security Best Practices](#security-best-practices)

## Credential Vault

Store credentials encrypted once, then log in by auth-profile name — the model never sees the password. An auth profile is a saved credential record; it is unrelated to a Chrome profile (`--profile`, see [Persistent Profiles](#persistent-profiles)).

```bash
# Save credentials (encrypted with AGENT_BROWSER_ENCRYPTION_KEY).
# Pipe the password via stdin so it never lands in shell history.
echo "$PASSWORD" | agent-browser auth save github \
  --url https://github.com/login --username user --password-stdin

# Log in using the saved auth profile
agent-browser auth login github

# Manage auth profiles
agent-browser auth list
agent-browser auth show github
agent-browser auth delete github
```

`auth login` navigates, then waits for the username/password/submit selectors to appear before filling and clicking, with a timeout tied to the default action timeout. That wait is why it is more reliable than a hand-rolled fill on SPA login screens that render the form late.

## Reuse Chrome Dev Authentication via CDP Cookies

End to end: extract cookies from Chrome Dev, inject them into a fresh agent-browser session, navigate, then persist the state for later runs.

Applies only once [Browser Mode Selection](../SKILL.md#browser-mode-selection) has chosen Chrome Dev and the prerequisite check in [Opt-in: Chrome Dev Setup](../SKILL.md#opt-in-chrome-dev-setup-when-a-persistently-signed-in-browser-is-needed) has succeeded.

**Use when:** the user is already logged in to the target site in that browser and you need to reuse that auth. Preferred for sites using session cookies: copying a named Chrome profile has been observed not to carry them (see [Persistent Profiles](#persistent-profiles)), while this path does.

**Step 1** — confirm the selected Chrome Dev endpoint is still there. This is a port probe, not an attach:

```bash
curl -fsS http://localhost:9222/json/version \
  | python3 -c "import sys,json; print('Connected:', json.load(sys.stdin)['Browser'])"
```

**Step 2** — if the user is not logged in to the target site, they log in through the Chrome Dev window; that profile persists across launches.

**Step 3** — extract cookies from the Chrome Dev profile:

```bash
python3 {baseDir}/templates/extract-chrome-cookies.py <domain-filter> <output.json> \
  --user-data-dir "$HOME/Library/Application Support/Chrome-Dev"
```

Requires `pip install websockets`. The script reads `DevToolsActivePort` from the given `--user-data-dir`, connects over WebSocket, and exports cookies in Playwright-compatible JSON.

**Step 4** — inject the cookies into a new agent-browser session and navigate. This step deliberately does not stay attached to Chrome Dev, and the order is load-bearing:

```bash
# 1. Open any page on the domain FIRST — this establishes the browser session
agent-browser open https://app.example.com

# 2. Inject cookies via CDP (handles secure + SameSite=None reliably)
python3 {baseDir}/templates/inject-cookies-cdp.py "$(agent-browser get cdp-url)" ./cookies.json

# 3. Now navigate to the authenticated page
agent-browser open https://app.example.com/protected

# 4. Save state for future reuse
agent-browser state save ~/.agent-browser/auth/example-auth.json
```

Injecting before the first `open` loses the cookies, because `open` starts a new browser.

> **Why CDP rather than the `cookies` subcommand?** `secure=true, sameSite=None` cookies — common in cross-domain SSO — have been observed to be dropped when loaded through the cookie-file path. CDP `Storage.setCookies` sets them intact. (`cookies` on 0.27.0 offers `get`/`set`/`clear`; there is no `import`.)

Auth state files live in `~/.agent-browser/auth/`, named `<site>-auth.json`.

**Step 5** — subsequent runs just load the saved state; if it redirects to a login page the token expired, so repeat from Step 1:

```bash
agent-browser state load ~/.agent-browser/auth/example-auth.json
agent-browser open https://app.example.com/protected
```

## Import Auth from an Existing CDP Browser

Use this when a browser selected through
[Browser Mode Selection](../SKILL.md#browser-mode-selection) or
[Control an Existing CDP Browser](../SKILL.md#control-an-existing-cdp-browser)
already contains valid login state and exposes a verified CDP endpoint. Log in
through that browser as needed; do not assume an unconfigured main Chrome
profile is attachable.

> **Security note:** A remote-debugging endpoint exposes full browser control
> to local processes. Use it only on trusted machines and close the browser when
> done.

### A login page does not tell you the browser has no session

**The weak claim, which is what the evidence supports:** when you drive a running browser through
`--cdp <port>` or `--auto-connect` and the target serves its login page, that reading **does not**
establish "this browser has no session". Measured once on `agent-browser` **0.27.0**: `--auto-connect`
landed on the login page while that same browser already had a signed-in tab open on the target site,
and `tab list` showed only the tab the CLI had just created, not the existing one. Note that the CLI's
own `--help` says `--auto-connect` *"Connect to a running Chrome to reuse its auth state"* — so the
observed behaviour and the documented behaviour disagree, and this section does not resolve which is
right.

**Not established here** — do not repeat these as facts: that a separate browser context is the
mechanism; that `--cdp` behaves the same way (only `--auto-connect` was measured); that the two login
pages are byte-identical; or that this extends to other kinds of connection. Any of those may be true;
none was measured.

**So before asserting anything about login state, get a reading from the default context:**

```bash
# 1. create the tab in the default context and keep the target id it returns
TID=$(curl -s -X PUT "http://127.0.0.1:9222/json/new?<urlencoded-url>" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
# 2. poll THAT id until its url stops changing (redirect chains settle), then read it
read_target() { curl -s http://127.0.0.1:9222/json/list \
  | python3 -c 'import json,sys; print(next((t["url"]+"\t"+t["title"]
      for t in json.load(sys.stdin) if t["id"]==sys.argv[1]), ""))' "$TID"; }
prev=""; for _ in $(seq 1 15); do
  cur=$(read_target); [ -n "$cur" ] && [ "$cur" = "$prev" ] && break
  prev=$cur; sleep 1
done
printf '%s\n' "$prev"
```

**Bind the read to that target id.** The scenario that makes this probe necessary is one where a
signed-in tab already exists, so `/json/list` will contain both it and your new tab — read the list
unfiltered and you can "confirm" the session from the *old* tab while your new one sat on a login
page. For the same reason a fixed `sleep` is not enough: poll until the url settles rather than
sampling once mid-redirect.

The probe's ceiling: `/json/list` gives you `title` and `url` only. Reading the body needs a CDP
WebSocket.

**Titles are not always discriminating.** Check that the title actually differs between the two
outcomes you are separating: measured on one site, two pages differing only by a query parameter
shared a title, so the probe proved the gateway routed and preserved the query string but proved
nothing about which variant rendered. The same probe was discriminating for a page with a unique
title. Decide per target, not once.

**Session split:** the two-step auth-import workflow below needs two `--session` names, the part [Browser Identity Continuity](../SKILL.md#browser-identity-continuity) does not cover — one for the source browser, a separate one for the browser consuming the imported state. Apply the owner's rule within each; the consumer never inherits the source browser's CDP endpoint.

**Step 1: Save the auth state from the selected browser**

```bash
# Local CDP port, CDP URL, or remote browser service
agent-browser --session auth-import-<task-id> --cdp "<port-or-url>" state save ./my-auth.json
```

**Step 2: Reuse in automation**

```bash
# Load auth at launch
agent-browser --session auth-use-<task-id> --state ./my-auth.json open https://app.example.com/dashboard

# Or load into an existing session
agent-browser --session auth-use-<task-id> state load ./my-auth.json
agent-browser --session auth-use-<task-id> open https://app.example.com/dashboard
```

Before saving or trusting the imported state, verify that the source endpoint
still identifies the browser/profile that contains the login.

This works for any site, including those with complex OAuth flows, SSO, or 2FA -- as long as Chrome already has valid session cookies.

> **Security note:** State files contain session tokens in plaintext. Add them to `.gitignore`, delete when no longer needed, and set `AGENT_BROWSER_ENCRYPTION_KEY` for encryption at rest. See [Security Best Practices](#security-best-practices).

**Tip:** `--session` and `--session-name` are different flags. `--session` picks which browser and daemon you control; `--session-name` picks which stored cookie and localStorage set is auto-persisted. Combine them so the imported auth survives restarts:

```bash
agent-browser --session auth-use-<task-id> --session-name myapp state load ./my-auth.json
# From now on, state is auto-saved/restored for "myapp"
```

## Persistent Profiles

Use an explicit custom `--profile` path for an agent-managed browser profile.
This persists cookies, IndexedDB, service workers, and cache across browser
restarts without explicit save/load:

```bash
# First run: login once
agent-browser --profile ~/.myapp-profile open https://app.example.com/login
# ... complete login flow ...

# All subsequent runs: already authenticated
agent-browser --profile ~/.myapp-profile open https://app.example.com/dashboard
```

Do not point this at a browser profile that is currently in use. A named system
profile such as `--profile Default` may be copied instead; session cookies may
not survive that copy. Use a custom profile path, `--session-name`, a state
file, or the existing-browser CDP paths in
[Browser Mode Selection](../SKILL.md#browser-mode-selection) according to the
required authentication capability.

Use different paths for different projects or test users:

```bash
agent-browser --profile ~/.profiles/admin open https://app.example.com
agent-browser --profile ~/.profiles/viewer open https://app.example.com
```

Or set via environment variable:

```bash
export AGENT_BROWSER_PROFILE=~/.myapp-profile
agent-browser open https://app.example.com/dashboard
```

## Session Persistence

Use `--session-name` to auto-save and restore cookies + localStorage by name, without managing files:

```bash
# Auto-saves state on close, auto-restores on next launch
agent-browser --session-name twitter open https://twitter.com
# ... login flow ...
agent-browser close  # state saved to ~/.agent-browser/sessions/

# Next time: state is automatically restored
agent-browser --session-name twitter open https://twitter.com
```

Encrypt state at rest:

```bash
export AGENT_BROWSER_ENCRYPTION_KEY=$(openssl rand -hex 32)
agent-browser --session-name secure open https://app.example.com
```

## Basic Login Flow

```bash
# Navigate to login page
agent-browser open https://app.example.com/login
agent-browser wait --load networkidle

# Get form elements
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Sign In"

# Fill credentials
agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"

# Submit
agent-browser click @e3
agent-browser wait --load networkidle

# Verify login succeeded
agent-browser get url  # Should be dashboard, not login
```

## Saving Authentication State

After logging in, save state for reuse:

```bash
# Login first (see above)
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --url "**/dashboard"

# Save authenticated state
agent-browser state save ./auth-state.json
```

## Restoring Authentication

Skip login by loading saved state:

```bash
# Load saved auth state
agent-browser state load ./auth-state.json

# Navigate directly to protected page
agent-browser open https://app.example.com/dashboard

# Verify authenticated
agent-browser snapshot -i
```

## OAuth / SSO Flows

For OAuth redirects:

```bash
# Start OAuth flow
agent-browser open https://app.example.com/auth/google

# Handle redirects automatically
agent-browser wait --url "**/accounts.google.com**"
agent-browser snapshot -i

# Fill Google credentials
agent-browser fill @e1 "user@gmail.com"
agent-browser click @e2  # Next button
agent-browser wait 2000
agent-browser snapshot -i
agent-browser fill @e3 "password"
agent-browser click @e4  # Sign in

# Wait for redirect back
agent-browser wait --url "**/app.example.com**"
agent-browser state save ./oauth-state.json
```

## Two-Factor Authentication

Manual 2FA is a human handoff, which puts it inside the [Visible Browser Evidence Gate](../SKILL.md#visible-browser-evidence-gate)'s jurisdiction. That rules out `--headed`, which cannot clear that gate: apply [Browser Mode Selection](../SKILL.md#browser-mode-selection), take the CDP path, and hold that path's identity per [Browser Identity Continuity](../SKILL.md#browser-identity-continuity) on every command below.

```bash
# Start the GUI browser over CDP per Visible GUI Browser over CDP, then:
AB="agent-browser --session 2fa-<task-id> --cdp 9222"

# Open the target, then gate rows 1-2 on the tab you will actually hand over
$AB open https://app.example.com/login
$AB eval "navigator.userAgent"     # row 1: must not contain HeadlessChrome
$AB tab list                       # row 2: switch by stable t<N> id or label
$AB get cdp-url                    # row 2: record this + that tab id — row 4 re-checks both

# Login with credentials
$AB snapshot -i
$AB fill @e1 "user@example.com"
$AB fill @e2 "password123"
$AB click @e3

# Row 3 is not a command: run it in full per the Visible Browser Evidence Gate,
# including its device branch — 2FA is the case where "the user completes this on
# this screen" is wrong by default. Only once row 3 passes, hand off and wait:
$AB wait --url "**/dashboard" --timeout 120000

# Row 4: both recorded values must still match, then save state
$AB get cdp-url                    # same browser?
$AB tab list                       # same active tab id?
$AB state save ./2fa-state.json
```

If no suitable visible browser is available, report the authentication step as `Blocked`; do not accept a headless fallback as successful manual 2FA.

## HTTP Basic Auth

For sites using HTTP Basic Authentication:

```bash
# Set credentials before navigation
agent-browser set credentials username password

# Navigate to protected resource
agent-browser open https://protected.example.com/api
```

## Cookie-Based Auth

Manually set authentication cookies:

```bash
# Set auth cookie
agent-browser cookies set session_token "abc123xyz"

# Navigate to protected page
agent-browser open https://app.example.com/dashboard
```

## Token Refresh Handling

For sessions with expiring tokens:

```bash
#!/bin/bash
# Wrapper that handles token refresh

STATE_FILE="./auth-state.json"

# Try loading existing state
if [[ -f "$STATE_FILE" ]]; then
    agent-browser state load "$STATE_FILE"
    agent-browser open https://app.example.com/dashboard

    # Check if session is still valid
    URL=$(agent-browser get url)
    if [[ "$URL" == *"/login"* ]]; then
        echo "Session expired, re-authenticating..."
        # Perform fresh login
        agent-browser snapshot -i
        agent-browser fill @e1 "$USERNAME"
        agent-browser fill @e2 "$PASSWORD"
        agent-browser click @e3
        agent-browser wait --url "**/dashboard"
        agent-browser state save "$STATE_FILE"
    fi
else
    # First-time login
    agent-browser open https://app.example.com/login
    # ... login flow ...
fi
```

## Security Best Practices

1. **Never commit state files** - They contain session tokens
   ```bash
   echo "*.auth-state.json" >> .gitignore
   ```

2. **Use environment variables for credentials**
   ```bash
   agent-browser fill @e1 "$APP_USERNAME"
   agent-browser fill @e2 "$APP_PASSWORD"
   ```

3. **Clean up after automation**
   ```bash
   agent-browser cookies clear
   rm -f ./auth-state.json
   ```

4. **Use short-lived sessions for CI/CD**
   ```bash
   # Don't persist state in CI
   agent-browser open https://app.example.com/login
   # ... login and perform actions ...
   agent-browser close  # Session ends, nothing persisted
   ```
