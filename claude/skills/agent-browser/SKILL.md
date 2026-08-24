---
name: agent-browser
description: Drive a real browser to act on web pages — navigate, read page structure, fill and submit forms, click through a multi-step flow, capture page screenshots, extract data, exercise a web app, or sign in to a site. Use when the task needs a real browser to operate on or inspect a rendered page or its browser state. Not when a plain HTTP fetch of the content would do, and not for system-level capture of the desktop, an application window, or the browser's own chrome — this skill captures rendered page content only.
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*), Bash(mktemp:*), Bash(open:*), Bash(im-notify:*)
---

# Browser Automation with agent-browser

## Browser Mode Selection

Choose the least intrusive mode that satisfies the required browser capability.
Visual evidence alone does not require a visible browser because screenshots
work headlessly. A mode a user is meant to see also passes the Visible Browser
Evidence Gate defined below — observed evidence that the browser in front of
them is the one under control.

| Situation | Action | Boundary |
|---|---|---|
| Navigation, DOM/network inspection, screenshots, or emulated viewport/device testing | Headless (default) | Does not open or focus a desktop window |
| Visible debugging, or a test that exercises real window behavior, where the user does not need to watch or take control | `--headed` | Opens a GUI window, remains automation-identified, and does not satisfy the Visible Browser Evidence Gate. Requires a GUI session — from a `Background` context it falls back to headless, so a real-window result must use the row below |
| The user must watch or operate the page, or human handoff is required | Visible GUI browser over CDP | Requires a verified CDP endpoint and the Visible Browser Evidence Gate below |
| A target demands the installed Chrome build, or a profile with real browsing history | Visible GUI browser over CDP for the build; the Chrome Dev row for profile history | Neither removes automation identification, and nothing here establishes that CDP defeats bot detection. Verify against the target itself; if you cannot, report `Blocked` when it gates the task, otherwise mark that behavior `uncovered` |
| A dedicated persistent-auth browser is desired and Chrome Dev is available | Chrome Dev over CDP | Optional implementation of the CDP path, with a profile that carries real history |
| A required visible or CDP capability is unavailable | Report `Blocked` when it gates the task; otherwise mark that behavior `uncovered` | Do not silently downgrade to headless emulation |

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser eval "<js>"
```

If a visible browser was not already requested, declare the desktop impact
*before* launching `--headed` or a GUI browser — why headless is insufficient,
and what window activity to expect. It has to reach whoever requested this run
while they can still stop it: the user's turn when the session is attended, or a
channel back to the dispatcher when it is not. A final task report does not
count, because it arrives after the window has already opened. If no
before-the-fact channel exists, do not launch — hand the decision back to the
dispatcher.
Headless runs can still persist their own authentication through a saved state
file or `--session-name` when no human handoff is required.

> If the CLI runs from a non-GUI context (`launchctl managername` prints
> `Background` — true for SSH shells, background daemons, and spawned
> sub-agents), `--headed` cannot draw a window and silently falls back to
> headless. When a visible or real-window result is required, use Visible GUI
> Browser over CDP; otherwise mark that behavior `uncovered` rather than
> accepting headless emulation as equivalent.

### Visible Browser Evidence Gate

Visibility is an observed runtime state — not a launch flag, an exit-0 command,
or a captured artifact. Rows 1–2 apply to every situation entering the Visible
GUI Browser over CDP path; rows 3–4 apply whenever a human handoff is required —
which includes the handoffs the user completes on another device, since row 3 is
where that gets settled. Pass rows 1–3 before the first page action that user is
meant to see and before handing control over. Row 4 falls due once they hand
control back.

| # | Evidence | Required state | Requires |
|---|---|---|---|
| 1 | Browser build is headed | `eval "navigator.userAgent"` on the controlled page returns a UA without `HeadlessChrome` — a headless build reports it even under `--headless=new` | — |
| 2 | Controlled target | The active controlled tab is the one you selected as target and shows the target URL. Select it from `tab list`, switch by its `t<N>` id or label, and record the pair that identifies what you are driving: `get cdp-url` plus that tab id | 1 |
| 3 | User confirmation | Read the page for the device the pending action needs, then take one branch. **On this screen** (a form to fill, a dialog to click): bring that window and target tab to the foreground through the OS or host UI. **On another device** — anything scanned is performed on the user's phone: capture the code by screenshotting the viewport and cropping to its rect from `eval`, since `screenshot <selector>` returns blank for the cross-origin iframe these logins render into, and send it per the `im-notify` skill; do not foreground, and do not require them to be here. Either branch then asks through this harness's user-question mechanism and waits for an affirmative answer about the act they were asked to perform — for a delivered artifact that is receiving and using it, not seeing this window. Presence, a prior browser request, a send receipt, or any one-way notification is not an answer | 1, 2 |
| 4 | Post-handoff | `get cdp-url` and the active tab id still match what row 2 recorded, through the same `--session` and `--cdp`; then verify the task-relevant result | 3 |

Rows 1–2 establish *which* browser is under control. Only row 3 establishes that
a human actually took the action over — on this screen that means seeing this
window, and a headed build proves the browser can draw a window, never that one
is on screen in front of anybody; on another device it means the artifact
reached them there. So rows 1–2 alone never clear this gate for a handoff, and a
successful `--headed` command, a screenshot, or a DOM snapshot satisfies no row
at all. Activity in another browser or profile does not satisfy the handoff.
When a required row's evidence cannot be obtained — no connectable GUI browser,
or no reachable user where rows 3–4 apply — take the unavailable-capability row
of Browser Mode Selection: report `Blocked` when it gates the task, otherwise
mark that behavior `uncovered`. Being away from this machine is not by itself an
unreachable user when row 3 took the other-device branch; it *is* one when the
action is bound to this screen and they are not at it, which is the ordinary
`Blocked`.

### Visible GUI Browser over CDP

This path has two entry conditions, and they differ in what they require first:

| Entry | Requires first | Procedure |
|---|---|---|
| Launch a fresh GUI browser with its own `--user-data-dir` | Nothing beyond the desktop-impact declaration above | The recipe below |
| Take over a browser the user already has open | The user's explicit authorization, obtained through this harness's user-question mechanism **before** you attach, select a tab, or foreground anything — attaching to someone's live browser is the act that needs permission, not the handoff that follows | Only possible if that browser already exposes a CDP port. Regular Chrome does not on its default profile — see *Why NOT --auto-connect or --cdp with Regular Chrome* — so in practice this is Chrome Dev. If nothing exposed is available, this entry is unavailable: do not substitute a fresh launch for it |

For the fresh-launch entry, start the browser in the GUI session with remote
debugging enabled and a separate user-data directory, then control it. Choose one
task-specific `--session` name before the first command and reuse it with the
same explicit `--cdp` endpoint on every command that must control this browser.

```bash
AB_GUI_PROFILE_DIR="$(mktemp -d)"
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir="$AB_GUI_PROFILE_DIR" "<url>"
agent-browser --session human-handoff-<task-id> --cdp 9222 snapshot -i
```

If no connectable GUI browser is available, report `Blocked` when that
capability gates the task; otherwise mark the specific behavior `uncovered`.
Never treat headless emulation as equivalent.

Satisfy the [Visible Browser Evidence Gate](#visible-browser-evidence-gate) in
row order before acting. Recording each identity and comparing it again after
handoff is what prevents a stale default daemon or another visible profile from
silently receiving part of the workflow.

Use [Opt-in: Chrome Dev Setup (when a persistently signed-in browser is
needed)](#opt-in-chrome-dev-setup-when-a-persistently-signed-in-browser-is-needed) only
for its row in the mode table. Trying to connect to Chrome Dev without first
verifying that it runs is the #1 cause of false failures.

---

## Opt-in: Chrome Dev Setup (when a persistently signed-in browser is needed)

This user may have a dedicated Chrome Dev app that always launches with remote debugging on port `9222`, giving persistent auth state without fighting Chrome's security restrictions. It is a per-machine opt-in, not a universal default — full setup, profile/cookie-sync mechanics, and maintenance live in [chrome-dev-setup.md](references/chrome-dev-setup.md).

Check before connecting:

```bash
ls -d "/Applications/Chrome Dev.app" >/dev/null 2>&1 && command -v chrome-dev >/dev/null 2>&1 \
  && curl -fsS http://localhost:9222/json/version >/dev/null \
  && echo "Chrome Dev ready" || echo "Chrome Dev NOT available"
```

`curl` here is a port probe only — it must not be replaced by an `agent-browser --cdp` call, because those attach, and attaching is the act that needs prior authorization (see the Visible Browser Evidence Gate). If the check prints "NOT available", return to Browser Mode Selection; use another mode only if it satisfies the required capability, otherwise report the prerequisite as blocked — do not retry `--cdp` flags.

### Standard Connection Workflow

```bash
# Control the visible CDP browser through one task-specific --session name.
agent-browser --session human-handoff-<task-id> --cdp 9222 open "https://example.com"
agent-browser --session human-handoff-<task-id> --cdp 9222 snapshot -i
```

If Chrome Dev is not running, launching it can open or focus a desktop window — declare that impact before running `open "/Applications/Chrome Dev.app"`, wait a few seconds, then verify with the snapshot above.

### Troubleshooting: Stale Daemon (EAGAIN / about:blank / healthy-page timeouts)

The browser persists via a background daemon, one per `--session` name. When it goes stale, commands hit a dead socket: `os error 35`, commands landing on `about:blank`, or timeouts on a page that is actually healthy. `close` / `close --all` act on the pages a daemon holds and leave the daemon process running (verified), so they do not fix this — which is why `session list` is not a list of things `close` can reset.

Reset takes two steps because no single command does both:

```bash
agent-browser doctor                                  # diagnose + clean the sidecars of daemons that already died,
                                                      # and read the live `Session <name> (pid <N>)` line for your session
kill <N>                                              # terminate that pid — a daemon that is alive but wedged
```

`doctor`'s own `Session <name> (pid <N>)` line is what binds a pid to a session name; take the pid from there rather than from `~/.agent-browser/<session>.pid`, because a pid file can outlive its daemon and the pid can be recycled, so killing it blind can hit an unrelated process. If `doctor` reports no live pid for your session, the daemon was already dead and `doctor` has cleared its leftovers — reconnect via the Standard Connection Workflow and confirm the stall is gone. If it persists, take the terminal rule at the end of this section rather than stopping here; never guess at a pid. Never broad-match `agent-browser` across processes either: every daemon presents the same argv with no session name in it, so a pattern kill takes out every parallel agent's daemon too.

Once the daemon is gone, reconnect via the Standard Connection Workflow above. Do not keep retrying commands against a stale daemon after the first unexplained stall — finish the reset first.

Beyond `kill` for the termination step, the only other step that reaches outside this skill's own `allowed-tools` is the Playwright fallback below, which runs through the target project's own runner. (Row 3's other-device branch also inspects the capture it is about to send, which needs whatever image-reading tool the harness offers.) Where `kill` is unavailable the reset stops at `doctor`; where neither the reset nor that fallback can proceed, an unresolved stall is `Blocked` when it gates the task and `uncovered` otherwise — do not guess at a process.

### Fallback: the project's own Playwright for verification

When the reset above has been carried out and screenshots or page-state checks still stall, and the target project already drives Playwright itself (so its browser binaries are installed, not merely the package importable), drive the remaining verification through the project's own Playwright instead of resetting again — a script of its own launches an independent browser, so a stale agent-browser daemon cannot reach it. Feed that script through the project runner's stdin (or a `mktemp` path), never as a file written into the target repo — this skill leaves no artifact behind to clean up. Take this branch before declaring a terminal outcome; the `Blocked`/`uncovered` rule above still applies when the project has no usable Playwright either.

Independence cuts both ways: the fresh browser carries none of the session state the daemon held, and it is still a headless automation browser. So this covers only pages reachable without that state — a local dev server, a public page, or state the script rebuilds itself. Verification depending on an existing login, anything that must come from a real window (the `--headed` and Visible-GUI-over-CDP rows of Browser Mode Selection, and the Background note), and every interactive flow (human handoff, the Visible Browser Evidence Gate) all stay with Browser Mode Selection.

### Why NOT --auto-connect or --cdp with Regular Chrome

Regular Chrome does not expose remote debugging on its default user-data directory, and Chrome 147+ blocks attempts to enable it there. Use Visible GUI Browser over CDP with a separate user-data directory, or return to Browser Mode Selection — do not retry the default profile.

---

The CLI uses Chrome/Chromium via CDP directly. Install via `npm i -g agent-browser`, `brew install agent-browser`, or `cargo install agent-browser`. Run `agent-browser install` to download Chrome. Existing Chrome, Brave, Playwright, and Puppeteer installations are detected automatically. Run `agent-browser upgrade` to update to the latest version.

## Core Workflow

### Browser Identity Continuity

Once a workflow is running on a CDP path — whether it launched that browser or
attached to one already exposed — reuse that workflow's task-specific `--session`
name and the same explicit `--cdp` endpoint on every later command that controls
it. The endpoint may be a local port or a CDP URL. Omitting either value can
select a different session's daemon or launch a different browser.

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input type="email"], @e2 [input type="password"], @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait 2000
agent-browser snapshot -i  # Check result
```

**Authenticated pages:** Load saved state BEFORE navigating via `state load`:

```bash
agent-browser state load ~/.agent-browser/auth/<site>-auth.json
agent-browser open https://example.com/protected-page
```

If redirected to login, that state has expired — re-run whichever approach in [Handling Authentication](#handling-authentication) produced it.

## Command Chaining

Commands can be chained with `&&` in a single shell invocation, under the same stop condition as `batch` — see [Batch Execution](#batch-execution). The browser persists between commands via a background daemon.

```bash
# Chain open + snapshot in one call (open already waits for page load)
agent-browser open https://example.com && agent-browser snapshot -i

# Chain multiple interactions
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "password123" && agent-browser click @e3

# Navigate and capture
agent-browser open https://example.com && agent-browser screenshot
```

**When to chain:** the stop condition is the same as for `batch` — see [Batch Execution](#batch-execution). Chain uninterrupted steps whose next action is already known (e.g., open + wait + screenshot); run commands separately when you need to inspect output or pass a row of the Visible Browser Evidence Gate.

## Handling Authentication

**Selection rule:** rows are ordered by preference, so take the first row whose precondition holds — several can be true at once (Chrome Dev is itself an existing CDP browser, and anything with stored credentials can also be driven as a one-off login flow). Full recipes, plus OAuth, 2FA, HTTP basic, cookie-based auth and token refresh: [Authentication Patterns](references/authentication.md).

| You have | Approach | Note |
|---|---|---|
| The user already logged in via Chrome Dev | [Reuse Chrome Dev Authentication via CDP Cookies](references/authentication.md#reuse-chrome-dev-authentication-via-cdp-cookies) | **Preferred when available** — carries session cookies out of Chrome Dev, which named-profile copying does not. Requires Chrome Dev selected and its prerequisite check passed |
| Credentials you may store | `agent-browser auth save` / `auth login` | Encrypted vault; the model never sees the password. `auth login` waits for the form selectors, which is more reliable on delayed SPA logins |
| A login flow you can run once per site | `--session-name <name>` | Cookies + localStorage auto-save on close and auto-restore next launch |
| A login flow and you want an explicit artifact | `state save` / `state load` | Same as above but you control the file and when it is reused |
| Another CDP browser already authenticated | [Import Auth from an Existing CDP Browser](references/authentication.md#import-auth-from-an-existing-cdp-browser) | Needs a separate `--session` for the source and the consuming browser — see the linked section |
| Only the user's regular Chrome profile | `--profile Default` | **Caveat:** a named system profile is copied to a temp dir. Persistent cookies survive; session cookies have been observed not to, so verify against the target before relying on it. An explicit profile *path* persists instead — see [Persistent Profiles](references/authentication.md#persistent-profiles) |

```bash
# vault
echo "$PASSWORD" | agent-browser auth save myapp --url https://app.example.com/login --username user --password-stdin
agent-browser auth login myapp

# session name (auto): state is saved on close and restored on the next launch
agent-browser --session-name myapp open https://app.example.com/login

# state file (explicit): save after logging in, load in a later run before navigating
agent-browser state save ./auth.json      # after the login flow completes
agent-browser state load ./auth.json      # in a future run, before `open`

# import from an already-authenticated CDP browser
agent-browser --session auth-import-<task-id> --cdp "<port-or-url>" state save ./auth.json
agent-browser --session auth-use-<task-id> --state ./auth.json open https://app.example.com/dashboard
```

## Chrome 147+ Compatibility

Modern Chrome requires a separate user-data directory and
`--remote-allow-origins=*` when remote debugging is enabled.

| Need | Current path |
|---|---|
| Control an existing local GUI browser | [Visible GUI Browser over CDP](#visible-gui-browser-over-cdp) |
| Control another existing CDP browser or remote service | [Control an Existing CDP Browser](#control-an-existing-cdp-browser) |
| Reuse auth outside the existing CDP browser | `state save`, then load the saved state only when headless satisfies the remaining task |
| Continue human handoff, bot-sensitive, or real-window work | Keep controlling the GUI browser |
| Extract auth without controlling that browser | [Reuse Chrome Dev Authentication via CDP Cookies](references/authentication.md#reuse-chrome-dev-authentication-via-cdp-cookies) |
| Control an unconfigured main Chrome profile | Unsupported; use Browser Mode Selection |

## Essential Commands

```bash
# Batch 2+ commands only when nothing in between can change the next action — see Batch Execution.
agent-browser batch "open https://example.com" "snapshot -i"
agent-browser batch "open https://example.com" "screenshot"
agent-browser batch "click @e1" "wait 1000" "screenshot"

# Navigation
agent-browser open <url>              # Navigate (aliases: goto, navigate)
agent-browser close                   # Close browser
agent-browser close --all             # Close the pages held by every active session

# Snapshot
agent-browser snapshot -i             # Interactive elements with refs (recommended)
agent-browser snapshot -i --urls      # Include href URLs for links
agent-browser snapshot -s "#selector" # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element — read "Re-reading the control you clicked
                                      #   is not verification" before relying on its exit code
agent-browser click @e1 --new-tab     # Click and open in new tab
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press key
agent-browser keyboard type "text"    # Type at current focus (no selector)
agent-browser keyboard inserttext "text"  # Insert without key events
agent-browser scroll down 500         # Scroll page
agent-browser scroll down 500 --selector "div.content"  # Scroll within a specific container

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title
agent-browser get cdp-url             # Get CDP WebSocket URL

# Wait
agent-browser wait @e1                # Wait for element
agent-browser wait 2000               # Wait milliseconds
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait --text "Welcome"   # Wait for text to appear (substring match)
agent-browser wait --load networkidle # Wait for network idle (caution: see Pitfalls)
agent-browser wait --fn "!document.body.innerText.includes('Loading...')"  # Wait for text to disappear
agent-browser wait "#spinner" --state hidden  # Wait for element to disappear

# Downloads
agent-browser download @e1 ./file.pdf          # Click element to trigger download
agent-browser wait --download ./output.zip     # Wait for a browser-initiated download to complete
agent-browser --download-path ./downloads open <url>  # Set default download directory
# Two limits measured on 0.27.0, neither of which announces itself:
#  - wait --download does not observe a programmatic download (a blob-URL a.click()
#    from eval). It times out with "the element may not exist" while the file lands
#    correctly. Test for the file instead.
#  - --download-path is honored only on the command that starts the daemon. Later it
#    prints "⚠ --download-path ignored: daemon already running" and the file goes to
#    the default directory. Set AGENT_BROWSER_DOWNLOAD_PATH before the first command.

# Tab management
agent-browser tab list                         # List all open tabs
agent-browser tab new                          # Open a blank new tab
agent-browser tab new https://example.com      # Open URL in a new tab
agent-browser tab t2                           # Switch by stable tab id (t1, t2, ... — never reused in a session)
agent-browser tab docs                         # Or by a label assigned with `tab new --label docs`
agent-browser tab close                        # Close the current tab
agent-browser tab close 2                      # Close tab by index

# Network
agent-browser network requests                 # Inspect tracked requests
agent-browser network requests --type xhr,fetch  # Filter by resource type
agent-browser network requests --method POST   # Filter by HTTP method
agent-browser network requests --status 2xx    # Filter by status (200, 2xx, 400-499)
agent-browser network request <requestId>      # View full request/response detail
agent-browser network route "**/api/*" --abort  # Block matching requests
agent-browser network har start                # Start HAR recording
agent-browser network har stop ./capture.har   # Stop and save HAR file

# Viewport & Device Emulation
agent-browser set viewport 1920 1080          # Set viewport size (default: 1280x720)
agent-browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
agent-browser set device "iPhone 14"          # Emulate device (viewport + user agent)

# Capture
agent-browser screenshot              # Screenshot to temp dir
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Annotated screenshot with numbered element labels
agent-browser screenshot --screenshot-dir ./shots  # Save to custom directory
agent-browser screenshot --screenshot-format jpeg --screenshot-quality 80
agent-browser pdf output.pdf          # Save as PDF

# Live preview / streaming
agent-browser stream enable           # Start runtime WebSocket streaming on an auto-selected port
agent-browser stream enable --port 9223  # Bind a specific localhost port
agent-browser stream status           # Inspect enabled state, port, connection, and screencasting
agent-browser stream disable          # Stop runtime streaming and remove the .stream metadata file

# Clipboard
agent-browser clipboard read                      # Read text from clipboard
agent-browser clipboard write "Hello, World!"     # Write text to clipboard
agent-browser clipboard copy                      # Copy current selection
agent-browser clipboard paste                     # Paste from clipboard
# Value copied by the app but masked in its API? Read it at the sink, not from
# the clipboard — references/value-extraction.md.

# Dialogs (alert, confirm, prompt, beforeunload)
# By default, alert and beforeunload dialogs are auto-accepted so they never block the agent.
# confirm and prompt dialogs still require explicit handling.
# Use --no-auto-dialog (or AGENT_BROWSER_NO_AUTO_DIALOG=1) to disable automatic handling.
agent-browser dialog accept              # Accept dialog
agent-browser dialog accept "my input"   # Accept prompt dialog with text
agent-browser dialog dismiss             # Dismiss/cancel dialog
agent-browser dialog status              # Check if a dialog is currently open

# Diff (compare page states)
agent-browser diff snapshot                          # Compare current vs last snapshot
agent-browser diff snapshot --baseline before.txt    # Compare current vs saved file
agent-browser diff screenshot --baseline before.png  # Visual pixel diff
agent-browser diff url <url1> <url2>                 # Compare two pages
agent-browser diff url <url1> <url2> --wait-until networkidle  # Custom wait strategy
agent-browser diff url <url1> <url2> --selector "#main"  # Scope to element

# Chat (AI natural language control)
agent-browser chat "open google.com and search for cats"  # Single-shot instruction
agent-browser chat                                        # Interactive REPL mode
agent-browser -q chat "summarize this page"               # Quiet (text only, no tool calls)
agent-browser -v chat "fill in the login form"            # Verbose (show command output)
agent-browser --model openai/gpt-4o chat "take a screenshot"  # Override model
```

## Streaming

Every session automatically starts a WebSocket stream server on an OS-assigned port. Use `agent-browser stream status` to see the bound port and connection state. Use `stream disable` to tear it down, and `stream enable --port <port>` to re-enable on a specific port.

## Batch Execution

Use `batch` for 2+ commands in sequence only when no intermediate output,
visibility check, user confirmation, or handoff can change the next action.
Batch executes commands in order, so dependent commands such as navigate then
screenshot work correctly. Each quoted argument is a separate command.

```bash
# Navigate and take a snapshot
agent-browser batch "open https://example.com" "snapshot -i"

# Navigate, snapshot, and screenshot in one call
agent-browser batch "open https://example.com" "snapshot -i" "screenshot"

# Click, wait, then screenshot
agent-browser batch "click @e1" "wait 1000" "screenshot"

# With --bail to stop on first error
agent-browser batch --bail "open https://example.com" "click @e1" "screenshot"
```

Use a single command when you need to inspect its output before deciding the
next action. A workflow on the Visible GUI Browser over CDP path must also stop
outside `batch` at each row of the [Visible Browser Evidence
Gate](#visible-browser-evidence-gate) — including each of row 3's steps: the
device read, the capture inspection on its other-device branch, and the
confirmation. After the decision or confirmation, batch only the remaining
uninterrupted steps.

Stdin mode is also supported for programmatic use:

```bash
echo '[["open","https://example.com"],["screenshot"]]' | agent-browser batch --json
agent-browser batch --bail < commands.json
```

## Efficiency Strategies

These patterns minimize tool calls and token usage.

**Use `--urls` to avoid re-navigation.** When you need to visit links from a page, use `snapshot -i --urls` to get all href URLs upfront. Then `open` each URL directly instead of clicking refs and navigating back.

**Snapshot once, act many times.** While nothing has invalidated the refs, do not re-snapshot: extract everything you need (refs, URLs, text) from one snapshot, then batch the remaining actions. Once the page changes, the refs are stale and you must re-snapshot — see [Ref Lifecycle](#ref-lifecycle-important) for what counts as a change.

**Multi-page workflow (e.g. "visit N sites and screenshot each"):**

```bash
# 1. Get all URLs in one call
agent-browser batch "open https://news.ycombinator.com" "snapshot -i --urls"
# Read output to extract URLs, then visit each directly:
# 2. One batch per target site
agent-browser batch "open https://github.com/example/repo" "screenshot"
agent-browser batch "open https://example.com/article" "screenshot"
agent-browser batch "open https://other.com/page" "screenshot"
```

This approach uses 4 tool calls instead of 14+. Never go back to the listing page between visits.

## Common Patterns

### Form Submission

```bash
# Navigate and get the form structure
agent-browser batch "open https://example.com/signup" "snapshot -i"
# Read the snapshot output to identify form refs, then fill and submit
agent-browser batch "fill @e1 \"Jane Doe\"" "fill @e2 \"jane@example.com\"" "select @e3 \"California\"" "check @e4" "click @e5" "wait 2000"
```

### Authentication

See the approach table in [Handling Authentication](#handling-authentication); full recipes in [authentication.md](references/authentication.md).

### Session Persistence

`--session-name <name>` auto-saves cookies + localStorage on close and restores them next launch; `state list/show/clear/clean` manage the saved files, and `AGENT_BROWSER_ENCRYPTION_KEY` encrypts them at rest. See [Session State Persistence](references/session-management.md#session-state-persistence) and [Managing Saved State Files](references/session-management.md#managing-saved-state-files).

### Working with Iframes

Iframe content is inlined in snapshots and refs inside iframes carry frame context, so you interact with them directly — no frame switch needed. Use `frame @eN` to scope a snapshot to one iframe and `frame main` to return. Worked example: [Iframes](references/snapshot-refs.md#iframes).

### Data Extraction

```bash
agent-browser batch "open https://example.com/products" "snapshot -i"
# Read snapshot to find element refs, then extract
agent-browser get text @e5           # Get specific element text

# JSON output for parsing
agent-browser snapshot -i --json
agent-browser get text @e1 --json
```

When the value is one the page produces on demand but its API returns masked — a key behind a Copy button — it is in the page's memory but in neither the DOM nor any response. See [value-extraction.md](references/value-extraction.md).

### Parallel Sessions

Each `--session <name>` is an isolated browser with its own daemon, so parallel agents do not collide; `session list` shows them. See [Session Isolation Properties](references/session-management.md#session-isolation-properties) and [Session Cleanup](references/session-management.md#session-cleanup).

### Control an Existing CDP Browser

To launch and control a local GUI browser, follow
[Visible GUI Browser over CDP](#visible-gui-browser-over-cdp) for launch,
identity checks, and continued control. To attach to a local browser someone
else already started, that browser must already expose a CDP port — regular
Chrome does not on its default profile, so in practice this means Chrome Dev or a
browser launched with the flags in that section. Attach with the same
`--session` + `--cdp` form below, after obtaining the user's authorization.

For a WebSocket, HTTP, or remote-service CDP URL, reuse the same task-specific
session and explicit `--cdp` URL on every command:

```bash
agent-browser --session existing-cdp-<task-id> --cdp "<cdp-url>" get url
agent-browser --session existing-cdp-<task-id> --cdp "<cdp-url>" snapshot -i
```

Verify the browser identity before acting and the task-relevant result
afterward. A remote browser does not satisfy human handoff unless the user can
perform the pending action — viewing and operating that same controlled page
when the action is on it, receiving the delivered artifact when it is not.

When only reusable authentication state is needed—not control of the existing
browser—use [Reuse Chrome Dev Authentication via CDP Cookies](references/authentication.md#reuse-chrome-dev-authentication-via-cdp-cookies)
instead.

### Color Scheme (Dark Mode)

```bash
# Persistent dark mode via flag (applies to all pages and new tabs)
agent-browser --color-scheme dark open https://example.com

# Or via environment variable
AGENT_BROWSER_COLOR_SCHEME=dark agent-browser open https://example.com

# Or set during session (persists for subsequent commands)
agent-browser set media dark
```

### Viewport & Responsive Testing

```bash
# Set a custom viewport size (default is 1280x720)
agent-browser set viewport 1920 1080
agent-browser screenshot desktop.png

# Test mobile-width layout
agent-browser set viewport 375 812
agent-browser screenshot mobile.png

# Retina/HiDPI: same CSS layout at 2x pixel density
# Screenshots stay at logical viewport size, but content renders at higher DPI
agent-browser set viewport 1920 1080 2
agent-browser screenshot retina.png

# Device emulation (sets viewport + user agent in one step)
agent-browser set device "iPhone 14"
agent-browser screenshot device.png
```

The `scale` parameter (3rd argument) sets `window.devicePixelRatio` without changing CSS layout. Use it when testing retina rendering or capturing higher-resolution screenshots.

**Zoom/resize limitation:** real-browser zoom and window resize are unreliable under the Background headless-fallback. When `launchctl managername` is `Background` (SSH, background daemons, spawned sub-agents), `--headed` silently falls back to headless (see the GUI-session note near the top). In that state, zooming with real browser shortcuts (`Cmd/Ctrl +`), resizing the OS window, or anything depending on a real window's DPR does not move the observable values — `innerWidth`, `devicePixelRatio`, and `visualViewport` stay fixed even though the commands exit 0. To accept a "user actually zoomed / resized the window" behavior, use [Visible GUI Browser over CDP](#visible-gui-browser-over-cdp); otherwise mark that zoom level uncovered — an exit-0 shortcut is not a pass. The CSS size/DPI that `set viewport ... <scale>` emulates is fine for layout screenshots but does not exercise the real zoom path.

### Visual Browser (Debugging)

The command surface below works on both visible paths — the
automation-launched `--headed` browser and a browser controlled over CDP. It can
open or focus desktop windows; declare that impact as described in Browser Mode
Selection before using `--headed` or `inspect`. These commands do not by
themselves satisfy the [Visible Browser Evidence
Gate](#visible-browser-evidence-gate); a workflow that owes a user acceptance or
a handoff still passes that gate on the CDP path.

```bash
# Automation-launched headed browser
agent-browser --headed open https://example.com
agent-browser highlight @e1          # Highlight element
agent-browser inspect                # Open visible DevTools for the active page
agent-browser record start demo.webm # Record session
agent-browser profiler start         # Start Chrome DevTools profiling
agent-browser profiler stop trace.json # Stop and save profile (path optional)

# GUI browser over CDP — per Browser Identity Continuity above
agent-browser --session human-handoff-<task-id> --cdp 9222 highlight @e1
agent-browser --session human-handoff-<task-id> --cdp 9222 inspect
agent-browser --session human-handoff-<task-id> --cdp 9222 record start demo.webm
agent-browser --session human-handoff-<task-id> --cdp 9222 profiler start
agent-browser --session human-handoff-<task-id> --cdp 9222 profiler stop trace.json
```

After Browser Mode Selection chooses automation-launched visible debugging,
scope any environment override to one command:

```bash
AGENT_BROWSER_HEADED=1 agent-browser open https://example.com
```

Do not export `AGENT_BROWSER_HEADED=1` into a shared shell or persist it in
shared/project configuration. Browser extensions work in both headed and
headless mode.

### Local Files (PDFs, HTML)

```bash
# Open local files with file:// URLs
agent-browser --allow-file-access open file:///path/to/document.pdf
agent-browser --allow-file-access open file:///path/to/page.html
agent-browser screenshot output.png
```

### iOS Simulator (Mobile Safari)

Mobile Safari on the iOS Simulator or a real device — same snapshot/interact loop, plus `tap` and `swipe`. Setup, requirements and commands: [iOS Simulator (Mobile Safari)](references/platforms.md#ios-simulator-mobile-safari).

## Security

All security features are opt-in. By default, agent-browser imposes no restrictions on navigation, actions, or output.

### Content Boundaries (Recommended for AI Agents)

Enable `--content-boundaries` to wrap page-sourced output in markers that help LLMs distinguish tool output from untrusted page content:

```bash
export AGENT_BROWSER_CONTENT_BOUNDARIES=1
agent-browser snapshot
# Output:
# --- AGENT_BROWSER_PAGE_CONTENT nonce=<hex> origin=https://example.com ---
# [accessibility tree]
# --- END_AGENT_BROWSER_PAGE_CONTENT nonce=<hex> ---
```

### Domain Allowlist

Restrict navigation to trusted domains. Wildcards like `*.example.com` also match the bare domain `example.com`. Sub-resource requests, WebSocket, and EventSource connections to non-allowed domains are also blocked. Include CDN domains your target pages depend on:

```bash
export AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com"
agent-browser open https://example.com        # OK
agent-browser open https://malicious.com       # Blocked
```

### Action Policy

Use a policy file to gate destructive actions:

```bash
export AGENT_BROWSER_ACTION_POLICY=./policy.json
```

Example `policy.json`:

```json
{ "default": "deny", "allow": ["navigate", "snapshot", "click", "scroll", "wait", "get"] }
```

Auth vault operations (`auth login`, etc.) bypass action policy but domain allowlist still applies.

### Output Limits

Prevent context flooding from large pages:

```bash
export AGENT_BROWSER_MAX_OUTPUT=50000
```

## Diffing (Verifying Changes)

Use `diff snapshot` after performing an action to verify it had the intended effect, against a baseline you saved to a file.

```bash
# Typical workflow: save baseline -> action -> diff against the file
agent-browser snapshot > before.txt              # baseline (see note below on -i)
agent-browser click @e2                          # perform action
agent-browser diff snapshot --baseline before.txt
```

For visual regression testing or monitoring:

```bash
# Save a baseline screenshot, then compare later
agent-browser screenshot baseline.png
# ... time passes or changes are made ...
agent-browser diff screenshot --baseline baseline.png

# Compare staging vs production
agent-browser diff url https://staging.example.com https://prod.example.com --screenshot
```

`diff snapshot` output uses `+` for additions and `-` for removals, similar to git diff. `diff screenshot` produces a diff image with changed pixels highlighted in red, plus a mismatch percentage.

**Baseline limitation:** `--baseline` is not optional. Without it `diff snapshot` compares against an empty baseline, not against your last `snapshot` — take a snapshot, perform no action, and it still reports the whole page as additions. `diff --help` claims the opposite; the observed behavior is what holds. Refs are also renumbered on every snapshot, so a `-i` baseline marks every ref-bearing line as changed and the diff degenerates into noise — take the baseline without `-i` when you only need to see what the page did.

**Media on a local browser plays into the user's speakers — decide sound deliberately, never by default.** This is not specific to `--cdp`: any browser this CLI drives on the user's machine, headless included, can reach the audio device. Three branches, and you must pick one explicitly:

- **Not observing sound or volume state** (the usual case) — keep every media element silent. `muted = true` is the strongest form; reach for it first.
- **The application's own logic depends on "unmuted"** — `volume = 0` keeps `muted === false` with no audible output. It is **not** side-effect-free: `volume` is itself observable and setting it fires `volumechange`, so a page that reads volume or listens for that event *does* see a difference. If the behaviour under test could depend on either, say so rather than claiming the state is untouched.
- **Sound itself is the observation** (lip-sync, audio artefacts) — that needs the user's permission first, and a bounded clip rather than a loop. Cost of skipping this: a pool of speaker videos left looping on the user's machine until they interrupted to ask whether it was us.

Coverage to check each time, because the branches above are per-element: `<video>` **and** `<audio>`, elements added after load, and Web Audio (element attributes are not known to reach it — silence it at the `AudioContext`, or skip the observation and mark it uncovered; whether any element-level control suffices is **unverified**). On the way out `pause()` and close the session rather than leaving a playing page behind.

**Re-reading the control you clicked is not verification — and neither is the CLI's own `✓ Done`.** `click` does **not** scroll its target into view: below the fold it lands on empty space (the event `target` is `HTML`, the document root), no application handler runs, and the command still prints `✓ Done` and exits 0. So an exit code cannot separate "clicked" from "clicked nothing" — observed on `agent-browser` **0.27.0**. Before a click that matters, read the element's rect and `agent-browser scrollintoview <sel>` if it is offscreen, then click for real. **`eval element.click()` is not an equivalent fix**: it bypasses the viewport, occlusion and hit-testing entirely, so it turns "the user cannot actually reach this control" into a green step — use it only for programmatic actions you are explicitly not evaluating as real interaction. Recheck this behaviour when the CLI is upgraded.

Then confirm the effect against the authoritative view of that state — a list page, a counter, the destination page, server-side state — never against the control you just touched. Two page-authoring patterns defeat re-reading, and both fail confidently rather than visibly:

| Pattern | What it does to your reader |
| --- | --- |
| Control inside an `aria-hidden="true"` subtree | Absent from `snapshot` altogether — `snapshot -s` on it errors as if no node exists. `eval` still sees it, so this is the one case where `eval` is the fallback |
| Rendered state driven by a CSS class, not by the attribute you read (author-implemented `role="checkbox"`, native input behind custom visuals) | `aria-checked` / `.checked` keep reporting the old value after the screen changed. Both readers faithfully report what the page asserts; the page is what's lying |

## Timeouts and Slow Pages

The default timeout is 25 seconds (the *action* timeout: click / eval / wait), set via `AGENT_BROWSER_DEFAULT_TIMEOUT` (milliseconds).

> **Observed:** raising `AGENT_BROWSER_DEFAULT_TIMEOUT` on a command while a daemon is already running does not change the timeout — the daemon read it when it first started, so you must reset the daemon (see "Troubleshooting: Stale Daemon") and rerun with the env set. And it governs *actions*, not `open` navigation: a genuinely hung page still stalls ~25 s regardless, so treat a slow `open` as a page/daemon issue, not a timeout to raise.

**Important:** `open` already waits for the page `load` event before returning. In most cases, no additional wait is needed before taking a snapshot or screenshot. Only add an explicit wait when content loads asynchronously after the initial page load.

```bash
# Wait for a specific element to appear (preferred for dynamic content)
agent-browser wait "#content"
agent-browser wait @e1

# Wait a fixed duration (good default for slow SPAs)
agent-browser wait 2000

# Wait for a specific URL pattern (useful after redirects)
agent-browser wait --url "**/dashboard"

# Wait for text to appear on the page
agent-browser wait --text "Results loaded"

# Wait for a JavaScript condition
agent-browser wait --fn "document.querySelectorAll('.item').length > 0"
```

**Avoid `wait --load networkidle`** unless you are certain the site has no persistent network activity. Ad-heavy sites, sites with analytics/tracking, and sites with websockets will cause `networkidle` to hang indefinitely. Prefer `wait 2000` or `wait <selector>` instead.

## JavaScript Dialogs (alert / confirm / prompt)

When a page opens a JavaScript dialog (`alert()`, `confirm()`, or `prompt()`), it blocks all other browser commands (snapshot, screenshot, click, etc.) until the dialog is dismissed. If commands start timing out unexpectedly, check for a pending dialog:

```bash
# Check if a dialog is blocking
agent-browser dialog status

# Accept the dialog (dismiss the alert / click OK)
agent-browser dialog accept

# Accept a prompt dialog with input text
agent-browser dialog accept "my input"

# Dismiss the dialog (click Cancel)
agent-browser dialog dismiss
```

When a dialog is pending, all command responses include a `warning` field indicating the dialog type and message. In `--json` mode this appears as a `"warning"` key in the response object.

## Session Management and Cleanup

When running multiple agents or automations concurrently, always use named sessions to avoid conflicts:

```bash
# Each agent gets its own isolated session
agent-browser --session agent1 open site-a.com
agent-browser --session agent2 open site-b.com

# Check active sessions
agent-browser session list
```

Always close your browser pages when done, so they stop holding a live browser:

```bash
agent-browser close                    # Close the pages held by the default session
agent-browser --session agent1 close   # Close the pages held by one session
agent-browser close --all              # Close the pages held by every active session
```

`close` / `close --all` close the browser pages a daemon holds but do not kill the daemon process itself (verified). If the daemon is stale (about:blank, timeouts on a healthy page, os error 35), `close` won't fix it — see "Troubleshooting: Stale Daemon" for the per-session reset.

To auto-shutdown the daemon after a period of inactivity (useful for ephemeral/CI environments):

```bash
AGENT_BROWSER_IDLE_TIMEOUT_MS=60000 agent-browser open example.com
```

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`, etc.) are invalidated when the page changes. Always re-snapshot after:

- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
agent-browser click @e5              # Navigates to new page
agent-browser snapshot -i            # MUST re-snapshot
agent-browser click @e1              # Use new refs
```

## Annotated Screenshots and Semantic Locators

`screenshot --annotate` overlays numbered boxes on interactive elements and prints a legend mapping each number to its `@ref` — useful when the accessibility tree is ambiguous. Semantic locators (`find text|label|role|placeholder|testid`) address elements without a snapshot, for when refs are unavailable or unreliable. See [Annotated Screenshots (Vision Mode)](references/snapshot-refs.md#annotated-screenshots-vision-mode) and [Semantic Locators](references/snapshot-refs.md#semantic-locators-alternative-to-refs).

## JavaScript Evaluation (eval)

Use `eval` to run JavaScript in the browser context. **Shell quoting can corrupt complex expressions** -- use `--stdin` or `-b` to avoid issues.

**Shadow boundaries:** a flat `document.querySelector` never crosses one, so on component-heavy pages a selector that "finds no such control" is usually the query failing, not the control missing. Reach an open root through its host (`host.shadowRoot.querySelector(...)`); a closed root's `.shadowRoot` is `null` and is not reachable from `eval` at all. `snapshot` pierces both — including closed roots, whose refs are fully clickable — so prefer snapshot refs over hand-written selectors unless the node is one `snapshot` cannot see (see `aria-hidden` under [Diffing](#diffing-verifying-changes)).

```bash
# Simple expressions work with regular quoting
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin with heredoc (RECOMMENDED)
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("img"))
    .filter(i => !i.alt)
    .map(i => ({ src: i.src.split("/").pop(), width: i.width }))
)
EVALEOF

# Alternative: base64 encoding (avoids all shell escaping issues)
agent-browser eval -b "$(echo -n 'Array.from(document.querySelectorAll("a")).map(a => a.href)' | base64)"
```

**Why this matters:** When the shell processes your command, inner double quotes, `!` characters (history expansion), backticks, and `$()` can all corrupt the JavaScript before it reaches agent-browser. The `--stdin` and `-b` flags bypass shell interpretation entirely.

**Rules of thumb:**

- Single-line, no nested quotes -> regular `eval 'expression'` with single quotes is fine
- Nested quotes, arrow functions, template literals, or multiline -> use `eval --stdin <<'EVALEOF'`
- Programmatic/generated scripts -> use `eval -b` with base64

## Configuration File

Project and user-level defaults (viewport, timeouts, engine, download path) can live in a config file instead of repeated flags — see [Configuration File](references/commands.md#configuration-file).

## Deep-Dive Documentation

| Reference                                                            | When to Use                                               |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| [references/chrome-dev-setup.md](references/chrome-dev-setup.md)     | Optional Chrome Dev setup for persistent authenticated browsing |
| [references/commands.md](references/commands.md)                     | Selected command reference; use CLI help for the version-matched full surface |
| [references/snapshot-refs.md](references/snapshot-refs.md)           | Ref lifecycle, invalidation rules, troubleshooting        |
| [references/session-management.md](references/session-management.md) | Parallel sessions, state persistence, concurrent scraping |
| [references/authentication.md](references/authentication.md)         | Login flows, OAuth, 2FA handling, state reuse             |
| [references/value-extraction.md](references/value-extraction.md)     | A value the app produces on demand (API key behind a Copy button) but returns masked from its own API |
| [references/video-recording.md](references/video-recording.md)       | Recording workflows for debugging and documentation       |
| [references/profiling.md](references/profiling.md)                   | Chrome DevTools profiling for performance analysis        |
| [references/proxy-support.md](references/proxy-support.md)           | Proxy configuration, geo-testing, rotating proxies        |

## Other Runtimes and Tooling

- **Cloud providers and alternative engines:** AWS Bedrock AgentCore, Lightpanda — [Platforms and Browser Engines](references/platforms.md)
- **Observability dashboard:** watch live sessions — [Observability Dashboard](references/commands.md#observability-dashboard)

## Ready-to-Use Templates

| Template                                                                               | Description                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [templates/extract-chrome-cookies.py](templates/extract-chrome-cookies.py)             | Extract cookies from running Chrome via CDP WebSocket (Chrome 144+) |
| [templates/inject-cookies-cdp.py](templates/inject-cookies-cdp.py)                     | Inject cookies into agent-browser via CDP (handles secure + SameSite=None) |
| [templates/form-automation.sh](templates/form-automation.sh)                           | Form filling with validation                      |
| [templates/authenticated-session.sh](templates/authenticated-session.sh)               | Login once, reuse state                           |
| [templates/capture-workflow.sh](templates/capture-workflow.sh)                         | Content extraction with screenshots               |

```bash
./templates/form-automation.sh https://example.com/form
./templates/authenticated-session.sh https://app.example.com/login
./templates/capture-workflow.sh https://example.com ./output
```
