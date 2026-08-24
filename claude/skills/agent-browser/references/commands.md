# Selected Command Reference

Frequently used agent-browser commands and options. For the complete
version-matched surface, use `agent-browser --help`, `<command> --help`, or
`agent-browser skills get core --full`. For the core loop see [Core Workflow](../SKILL.md#core-workflow); for
worked recipes see [Common Patterns](../SKILL.md#common-patterns). Generated help describes command syntax but may show
default-daemon connection examples; for any workflow already running on a CDP
path, [Browser Identity Continuity](../SKILL.md#browser-identity-continuity) is
authoritative.

## Navigation

```bash
agent-browser open <url>      # Navigate to URL (aliases: goto, navigate)
                              # Supports: https://, http://, file://, about:, data://
                              # Auto-prepends https:// if no protocol given
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser close           # Close browser (aliases: quit, exit)
```

## Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
```

## Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser click @e1 --new-tab # Click and open in new tab
agent-browser dblclick @e1        # Double-click
agent-browser focus @e1           # Focus element
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key (alias: key)
agent-browser press Control+a     # Key combination
agent-browser keydown Shift       # Hold key down
agent-browser keyup Shift         # Release key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select dropdown option
agent-browser select @e1 "a" "b"  # Select multiple options
agent-browser scroll down 500     # Scroll page (default: down 300px)
agent-browser scrollintoview @e1  # Scroll element into view (alias: scrollinto)
agent-browser drag @e1 @e2        # Drag and drop
agent-browser upload @e1 file.pdf # Upload files
```

## Get Information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get cdp-url         # Get CDP WebSocket URL
agent-browser get count ".item"   # Count matching elements
agent-browser get box @e1         # Get bounding box
agent-browser get styles @e1      # Get computed styles (font, color, bg, etc.)
```

## Check State

```bash
agent-browser is visible @e1      # Check if visible
agent-browser is enabled @e1      # Check if enabled
agent-browser is checked @e1      # Check if checked
```

## Screenshots and PDF

```bash
agent-browser screenshot          # Save to temporary directory
agent-browser screenshot path.png # Save to specific path
agent-browser screenshot --full   # Full page
agent-browser pdf output.pdf      # Save as PDF
```

## Video Recording

```bash
agent-browser record start ./demo.webm    # Start recording
agent-browser click @e1                   # Perform actions
agent-browser record stop                 # Stop and save video
agent-browser record restart ./take2.webm # Stop current + start new
```

## Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text (or -t)
agent-browser wait --url "**/dashboard"    # Wait for URL pattern (or -u)
agent-browser wait --load networkidle      # Wait for network idle (or -l)
agent-browser wait --fn "window.ready"     # Wait for JS condition (or -f)
```

## Mouse Control

```bash
agent-browser mouse move 100 200      # Move mouse
agent-browser mouse down left         # Press button
agent-browser mouse up left           # Release button
agent-browser mouse wheel 100         # Scroll wheel
```

## Semantic Locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find text "Sign In" click --exact      # Exact match only
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
agent-browser find alt "Logo" click
agent-browser find title "Close" click
agent-browser find testid "submit-btn" click
agent-browser find first ".item" click
agent-browser find last ".item" click
agent-browser find nth 2 "a" hover
```

## Browser Settings

```bash
agent-browser set viewport 1920 1080          # Set viewport size
agent-browser set viewport 1920 1080 2        # 2x retina (same CSS size, higher res screenshots)
agent-browser set device "iPhone 14"          # Emulate device
agent-browser set geo 37.7749 -122.4194       # Set geolocation (alias: geolocation)
agent-browser set offline on                  # Toggle offline mode
agent-browser set headers '{"X-Key":"v"}'     # Extra request headers — NOT User-Agent (see below)
agent-browser set credentials user pass       # HTTP basic auth (alias: auth)
agent-browser set media dark                  # Emulate color scheme
agent-browser set media light reduced-motion  # Light mode + reduced motion
```

**User-Agent is not a request header here.** It is fixed when the browser context is created,
so `set headers` cannot change it — the browser keeps sending its own and the only symptom is
that the site still treats you as automation. Pass it at launch instead:

```bash
agent-browser --user-agent "<ua>" open <url>   # or AGENT_BROWSER_USER_AGENT=<ua>
```

Worth knowing because a site that blocks automation often keys on the `HeadlessChrome` token
in that string alone: on one measured site, swapping only the UA moved the response between
`{"error":"blocked","code":567}` and `200` with every other header identical.

**It only takes effect on the command that starts the daemon** — same rule as
`--download-path` (SKILL.md, Downloads). Adding it to the *next* call after you saw the block
changes nothing: the daemon is already up and its browser context already carries the old UA,
with no error to tell you so. Simplest fix is a fresh `--session` name — a new session gets a
new daemon and the flag applies. Reusing the old name means closing it first, and `close`
alone does not stop the daemon (SKILL.md, Troubleshooting: Stale Daemon); killing it needs the
identity check in that section, since `doctor` has been measured reporting `pass` for a pid
whose process was already gone.

Being an env var, `AGENT_BROWSER_USER_AGENT` also has to be set inside **each** Bash call —
the harness starts a new shell every time, so an `export` from a previous call is already gone.

## Cookies and Storage

```bash
agent-browser cookies                     # Get all cookies
agent-browser cookies set name value      # Set cookie
agent-browser cookies clear               # Clear cookies
agent-browser storage local               # Get all localStorage
agent-browser storage local key           # Get specific key
agent-browser storage local set k v       # Set value
agent-browser storage local clear         # Clear all
```

## Network

```bash
agent-browser network route <url>              # Intercept requests
agent-browser network route <url> --abort      # Block requests
agent-browser network route <url> --body '{}'  # Mock response
agent-browser network unroute [url]            # Remove routes
agent-browser network requests                 # View tracked requests
agent-browser network requests --filter api    # Filter requests
```

## Tabs and Windows

```bash
agent-browser tab                 # List tabs
agent-browser tab new [url]       # New tab
agent-browser tab t2              # Switch by stable tab id (t1, t2, ... — never reused in a session)
agent-browser tab docs            # Or by a label assigned with `tab new --label docs`
agent-browser tab close           # Close current tab
agent-browser tab close 2         # Close tab by index
agent-browser window new          # New window
```

## Frames

```bash
agent-browser frame "#iframe"     # Switch to iframe by CSS selector
agent-browser frame @e3           # Switch to iframe by element ref
agent-browser frame main          # Back to main frame
```

### Iframe support

Iframes are detected automatically during snapshots. When the main-frame snapshot runs, `Iframe` nodes are resolved and their content is inlined beneath the iframe element in the output (one level of nesting; iframes within iframes are not expanded).

```bash
agent-browser snapshot -i
# @e3 [Iframe] "payment-frame"
#   @e4 [input] "Card number"
#   @e5 [button] "Pay"

# Interact directly — refs inside iframes already work
agent-browser fill @e4 "4111111111111111"
agent-browser click @e5

# Or switch frame context for scoped snapshots
agent-browser frame @e3               # Switch using element ref
agent-browser snapshot -i             # Snapshot scoped to that iframe
agent-browser frame main              # Return to main frame
```

The `frame` command accepts:
- **Element refs** — `frame @e3` resolves the ref to an iframe element
- **CSS selectors** — `frame "#payment-iframe"` finds the iframe by selector
- **Frame name/URL** — matches against the browser's frame tree

## Dialogs

By default, `alert` and `beforeunload` dialogs are automatically accepted so they never block the agent. `confirm` and `prompt` dialogs still require explicit handling. Use `--no-auto-dialog` to disable this behavior.

```bash
agent-browser dialog accept [text]  # Accept dialog
agent-browser dialog dismiss        # Dismiss dialog
agent-browser dialog status         # Check if a dialog is currently open
```

## JavaScript

```bash
agent-browser eval "document.title"          # Simple expressions only
agent-browser eval -b "<base64>"             # Any JavaScript (base64 encoded)
agent-browser eval --stdin                   # Read script from stdin
```

Use `-b`/`--base64` or `--stdin` for reliable execution. Shell escaping with nested quotes and special characters is error-prone.

```bash
# Base64 encode your script, then:
agent-browser eval -b "ZG9jdW1lbnQucXVlcnlTZWxlY3RvcignW3NyYyo9Il9uZXh0Il0nKQ=="

# Or use stdin with heredoc for multiline scripts:
cat <<'EOF' | agent-browser eval --stdin
const links = document.querySelectorAll('a');
Array.from(links).map(a => a.href);
EOF
```

## State Management

```bash
agent-browser state save auth.json    # Save cookies, storage, auth state
agent-browser state load auth.json    # Restore saved state
```

## Global Options

```bash
agent-browser --session <name> ...    # Task-specific --session name: the browser and daemon you control
agent-browser --json ...              # JSON output for parsing
agent-browser --headed ...            # Request a visible window; requires a GUI session
agent-browser --full ...              # Full page screenshot (-f)
agent-browser --cdp <port-or-url> ... # Connect via Chrome DevTools Protocol
agent-browser -p <provider> ...       # Cloud browser provider (--provider)
agent-browser --proxy <url> ...       # Use proxy server
agent-browser --proxy-bypass <hosts>  # Hosts to bypass proxy
agent-browser --headers <json> ...    # HTTP headers scoped to URL's origin
agent-browser --executable-path <p>   # Custom browser executable
agent-browser --extension <path> ...  # Load browser extension (repeatable)
agent-browser --ignore-https-errors   # Ignore SSL certificate errors
agent-browser --help                  # Show help (-h)
agent-browser --version               # Show version (-V)
agent-browser <command> --help        # Show detailed help for a command
```

## Headless Debugging

```bash
agent-browser console                     # View console messages
agent-browser console --clear             # Clear console
agent-browser errors                      # View page errors
agent-browser errors --clear              # Clear errors
agent-browser highlight @e1               # Highlight element
agent-browser trace start                 # Start recording trace
agent-browser trace stop trace.zip        # Stop and save trace
agent-browser profiler start              # Start Chrome DevTools profiling
agent-browser profiler stop trace.json    # Stop and save profile
```

These commands work headlessly; debugging does not by itself require a visible
browser.

## Visual and Existing-CDP-Browser Debugging

Use these only when
[Browser Mode Selection](../SKILL.md#browser-mode-selection) requires a visible
or existing browser. `inspect` opens visible DevTools in the user's default
browser; explain that desktop impact before running it. Hold the browser's identity per [Browser Identity Continuity](../SKILL.md#browser-identity-continuity) on every command that controls it.

```bash
# Automation-launched headed browser
agent-browser --headed open example.com   # GUI session only; Background may fall back headless
agent-browser inspect                     # Open visible DevTools for the active page

# Local CDP port
agent-browser --session existing-cdp-<task-id> --cdp 9222 inspect

# CDP URL or remote service
agent-browser --session existing-cdp-<task-id> --cdp "<cdp-url>" snapshot
agent-browser --session existing-cdp-<task-id> --cdp "<cdp-url>" console
```

## Environment Variables

```bash
AGENT_BROWSER_SESSION="mysession"            # Default session name
AGENT_BROWSER_EXECUTABLE_PATH="/path/chrome" # Custom browser path
AGENT_BROWSER_EXTENSIONS="/ext1,/ext2"       # Comma-separated extension paths
AGENT_BROWSER_PROVIDER="browserbase"         # Cloud browser provider
AGENT_BROWSER_STREAM_PORT="9223"             # Override WebSocket streaming port (default: OS-assigned)
AGENT_BROWSER_HOME="/path/to/agent-browser"  # Custom install location
```

## Observability Dashboard

The dashboard is a standalone background server that shows live browser viewports, command activity, and console output for all sessions.

```bash
# Start the dashboard server (background, port 4848)
agent-browser dashboard start

# All sessions are automatically visible in the dashboard
agent-browser open example.com

# Stop the dashboard
agent-browser dashboard stop
```

The dashboard runs independently of browser sessions on port 4848 (configurable with `--port`). All sessions automatically stream to the dashboard. Sessions can also be created from the dashboard UI with local engines or cloud providers.

### Dashboard AI Chat

The dashboard has an optional AI chat tab powered by the Vercel AI Gateway. Enable it by setting:

```bash
export AI_GATEWAY_API_KEY=gw_your_key_here
export AI_GATEWAY_MODEL=anthropic/claude-sonnet-4.6           # optional default
export AI_GATEWAY_URL=https://ai-gateway.vercel.sh           # optional default
```

The Chat tab is always visible in the dashboard. Set `AI_GATEWAY_API_KEY` to enable AI responses.

## Configuration File

Create `agent-browser.json` in the project root for persistent settings:

```json
{
  "headed": false,
  "proxy": "http://localhost:8080",
  "profile": "./browser-data"
}
```

Keep shared and project defaults headless. Select a visible mode per task through
[Browser Mode Selection](../SKILL.md#browser-mode-selection), not by persisting
`"headed": true`. Priority (lowest to highest):
`~/.agent-browser/config.json` < `./agent-browser.json` < env vars < CLI flags.
Use `--config <path>` or `AGENT_BROWSER_CONFIG` env var for a custom config file
(exits with error if missing/invalid). All CLI options map to camelCase keys
(e.g., `--executable-path` -> `"executablePath"`). Boolean flags accept
`true`/`false` values (e.g., `--headed false` overrides config). Extensions from
user and project configs are merged, not replaced.
