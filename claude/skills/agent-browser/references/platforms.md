# Platforms and Browser Engines

Where the browser runs: the iOS Simulator target, cloud browser providers, and
alternative browser engines. All three are opt-in — the default is a local
headless Chrome/Chromium, per
[Browser Mode Selection](../SKILL.md#browser-mode-selection).

**Related**: [commands.md](commands.md) for the selected command reference, [chrome-dev-setup.md](chrome-dev-setup.md) for the persistent-auth Chrome instance.

## Contents

- [iOS Simulator (Mobile Safari)](#ios-simulator-mobile-safari)
- [Cloud Providers](#cloud-providers)
- [Browser Engine Selection](#browser-engine-selection)

## iOS Simulator (Mobile Safari)

```bash
# List available iOS simulators
agent-browser device list

# Launch Safari on a specific device
agent-browser -p ios --device "iPhone 16 Pro" open https://example.com

# Same workflow as desktop - snapshot, interact, re-snapshot
agent-browser -p ios snapshot -i
agent-browser -p ios tap @e1          # Tap (alias for click)
agent-browser -p ios fill @e2 "text"
agent-browser -p ios swipe up         # Mobile-specific gesture

# Take screenshot
agent-browser -p ios screenshot mobile.png

# End the session — this also shuts the simulator down
agent-browser -p ios close
```

**Requirements:** macOS with Xcode, Appium (`npm install -g appium && appium driver install xcuitest`)

**Real devices:** Works with physical iOS devices if pre-configured. Use `--device "<UDID>"` where UDID is from `xcrun xctrace list devices`.

## Cloud Providers

Use `-p <provider>` (or `AGENT_BROWSER_PROVIDER`) to run against a cloud browser instead of launching a local Chrome instance. Supported providers: `agentcore`, `browserbase`, `browserless`, `browseruse`, `kernel`.

### AgentCore (AWS Bedrock)

```bash
# Credentials auto-resolved from env vars or AWS CLI (SSO, IAM roles, etc.)
agent-browser -p agentcore open https://example.com

# With persistent browser profile
AGENTCORE_PROFILE_ID=my-profile agent-browser -p agentcore open https://example.com

# With explicit region
AGENTCORE_REGION=eu-west-1 agent-browser -p agentcore open https://example.com
```

Set `AWS_PROFILE` to select a named AWS profile.

## Browser Engine Selection

Use `--engine` to choose a local browser engine. The default is `chrome`.

```bash
# Use Lightpanda (fast headless browser, requires separate install)
agent-browser --engine lightpanda open example.com

# Via environment variable
export AGENT_BROWSER_ENGINE=lightpanda
agent-browser open example.com

# With custom binary path
agent-browser --engine lightpanda --executable-path /path/to/lightpanda open example.com
```

Supported engines:
- `chrome` (default) -- Chrome/Chromium via CDP
- `lightpanda` -- Lightpanda headless browser via CDP (10x faster, 10x less memory than Chrome)

Lightpanda does not support `--extension`, `--profile`, `--state`, or `--allow-file-access`. Install Lightpanda from https://lightpanda.io/docs/open-source/installation.
