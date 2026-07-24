# Chrome Dev Setup

A dedicated Chrome instance with remote debugging always enabled — the prerequisite for reliable browser automation on macOS.

**Related**: [SKILL.md](../SKILL.md) for the quick connect guide, [authentication.md](authentication.md) for login state handling.

## Contents

- [Why Chrome Dev Is Needed](#why-chrome-dev-is-needed)
- [How to Create Chrome Dev](#how-to-create-chrome-dev)
- [How It Works](#how-it-works)
- [Verification](#verification)
- [Maintenance](#maintenance)

---

## Why Chrome Dev Is Needed

### The Problem: Chrome 147+ Blocks Remote Debugging on the Default Profile

To connect agent-browser to a running Chrome instance, Chrome must be launched with `--remote-debugging-port=9222`. Without this flag, there is no way to attach.

The naive approach — killing Chrome and relaunching with the flag — hits a hard wall on Chrome 144+:

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

Chrome silently refuses to open the debugging port when `--user-data-dir` points to the user's real profile at `~/Library/Application Support/Google/Chrome`. This is a security measure introduced in Chrome 128 and enforced from Chrome 144 onward to prevent malicious scripts from attaching to the user's main browser session.

### Why Not Just Pass a Different --user-data-dir?

Specifying a fresh temp directory works for the port restriction, but loses all login sessions — the user is signed out of every site. Browser automation tasks almost always require the user's existing sessions (LinkedIn, GitHub, YouTube, etc.), so a blank profile is useless.

### Why Not --auto-connect or --cdp Against Regular Chrome?

`--auto-connect` and `--cdp <port>` both rely on Chrome's HTTP discovery endpoint (`/json/version`). This endpoint was removed in Chrome 144. On Chrome 147+:

- `--auto-connect` → times out
- `--cdp 9222` → 404 / connection refused (port never opened)
- `--remote-allow-origins` not set → 403 Forbidden on WebSocket handshake

### The Solution: A Dedicated "Chrome Dev" App

Create a second Chrome launcher that:

1. Uses a **separate** `--user-data-dir` (satisfies Chrome's security requirement)
2. **Syncs login cookies** from the real profile on every launch (preserves sessions)
3. Sets `--remote-debugging-port=9222 --remote-allow-origins=*` permanently
4. Lives in `/Applications` as a normal macOS app the user can open from the Dock

Regular Chrome remains untouched and unaffected.

### Why the Official Dev Channel Binary

The launcher runs the **official Google Chrome Dev channel** (`Google Chrome Dev.app`),
not the stable binary. macOS derives Cmd+Tab / Dock identity from the bundle a process
was launched from — running the stable binary made the automation instance show up as a
second, identical "Google Chrome", indistinguishable from the real browser. The Dev
channel bundle gives it its own name ("Google Chrome Dev") and olive icon natively, with
Google's signature and auto-updates intact (no re-sign hacks, no rebuild after updates).

Cookie sync still works across channels: stable/beta/dev all encrypt profile data with
the same macOS Keychain item (`Chrome Safe Storage` — branding-level constant in
Chromium's `keychain_password_mac.mm`, not per-channel). **First launch prompts once for
Keychain access — click "Always Allow"**; the grant is permanent because Google's code
signature is stable. The Dev channel runs ~1 major version ahead of stable; synced
profile files always migrate forward (stable → dev), which Chrome supports natively.

---

## How to Create Chrome Dev

Run the following steps in order. The agent can execute all of these automatically.

### Step 0: Install the Dev Channel App

```bash
brew install --cask google-chrome@dev   # → /Applications/Google Chrome Dev.app
```

It auto-updates via Google's own updater; never launch it directly for automation —
always go through the launcher (Step 2), which is what syncs login state.

### Step 1: Create the Persistent Profile Directory

```bash
PROFILE_DIR="$HOME/Library/Application Support/Chrome-Dev"
MAIN_PROFILE="$HOME/Library/Application Support/Google/Chrome/Default"

mkdir -p "$PROFILE_DIR/Default"

# Copy full profile on first run (excludes cache to save space)
rsync -a \
  --exclude='Cache' \
  --exclude='Code Cache' \
  --exclude='GPUCache' \
  "$MAIN_PROFILE/" "$PROFILE_DIR/Default/"

echo "Profile size: $(du -sh "$PROFILE_DIR" | cut -f1)"
```

This copies bookmarks, extensions, preferences, and persistent cookies. Session cookies are re-synced on every launch (Step 2).

### Step 2: Create the Launch Script

The launcher is tracked in the `ai-agent-config` repo at `claude/bin/chrome-dev`
(single source of truth). `install.sh` symlinks it to `$(brew --prefix)/bin/chrome-dev`
via `safe_link`, so on a migrated/new machine just run the repo's `install.sh` — the
launcher is restored automatically. `$(brew --prefix)/bin` is reinstalled fresh on each
machine (Homebrew is not migrated), which is why this step exists.

To (re)create it manually without the repo, write this to `$(brew --prefix)/bin/chrome-dev`
(the path `Chrome Dev.app` hardcodes) and `chmod +x` it:

```bash
#!/bin/bash

PROFILE_DIR="$HOME/Library/Application Support/Chrome-Dev"
MAIN_PROFILE="$HOME/Library/Application Support/Google/Chrome/Default"

# Sync session-sensitive files on every launch
for f in Cookies "Login Data" "Login Data For Account" \
          "Web Data" "Extension Cookies" \
          "Local Storage" "Session Storage"; do
  src="$MAIN_PROFILE/$f"
  dst="$PROFILE_DIR/Default/$f"
  if [ -e "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp -r "$src" "$dst" 2>/dev/null
  fi
done

# Dev channel (not stable): gives the instance its own Cmd+Tab identity
# (olive icon + "Google Chrome Dev") and shares the same "Chrome Safe
# Storage" keychain key as stable, so synced cookies stay decryptable.
# First launch prompts once for keychain access — click "Always Allow".
exec "/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev" \
  --remote-debugging-port=9222 \
  --remote-allow-origins=* \
  --user-data-dir="$PROFILE_DIR" \
  --profile-directory="Default" \
  --no-first-run \
  --restore-last-session \
  "$@"
```

### Step 3: Create the macOS App

Use `osacompile` to wrap the script in a proper `.app` bundle:

```bash
osacompile -o "/Applications/Chrome Dev.app" << 'EOF'
do shell script "/opt/homebrew/bin/chrome-dev > /tmp/chrome-dev.log 2>&1 &"
EOF

# Replace the default applet icon with the Dev channel's olive icon
cp "/Applications/Google Chrome Dev.app/Contents/Resources/app.icns" \
   "/Applications/Chrome Dev.app/Contents/Resources/applet.icns"
rm -f "/Applications/Chrome Dev.app/Contents/Resources/Assets.car"  # let the .icns win
xattr -cr "/Applications/Chrome Dev.app"   # codesign rejects Finder xattr "detritus"
codesign --force --deep --sign - "/Applications/Chrome Dev.app"

# Set display name
/usr/libexec/PlistBuddy -c "Set :CFBundleName 'Chrome Dev'" \
  "/Applications/Chrome Dev.app/Contents/Info.plist" 2>/dev/null
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'Chrome Dev'" \
  "/Applications/Chrome Dev.app/Contents/Info.plist" 2>/dev/null

touch "/Applications/Chrome Dev.app"
echo "✅ Chrome Dev.app created"
```

### Step 4: Add to Dock (next to Google Chrome)

```bash
python3 << 'PYEOF'
import plistlib, os

dock_plist = os.path.expanduser("~/Library/Preferences/com.apple.dock.plist")
with open(dock_plist, 'rb') as f:
    dock = plistlib.load(f)

apps = dock.get('persistent-apps', [])

# Remove any stale Chrome Dev entry
apps = [item for item in apps
        if item.get('tile-data', {}).get('file-label', '') != 'Chrome Dev']

new_item = {
    'tile-data': {
        'file-data': {
            '_CFURLString': 'file:///Applications/Chrome Dev.app/',
            '_CFURLStringType': 0
        },
        'file-label': 'Chrome Dev',
        'file-type': 1
    },
    'tile-type': 'file-tile'
}

# Insert right after Google Chrome
for i, item in enumerate(apps):
    if item.get('tile-data', {}).get('file-label', '') == 'Google Chrome':
        apps.insert(i + 1, new_item)
        print(f"Inserted at position {i + 1}, next to Google Chrome")
        break
else:
    apps.append(new_item)
    print("Google Chrome not found in Dock — appended Chrome Dev at end")

dock['persistent-apps'] = apps
with open(dock_plist, 'wb') as f:
    plistlib.dump(dock, f)
PYEOF

killall Dock
echo "✅ Dock updated"
```

### Step 5: Verify

```bash
# Launch Chrome Dev
open "/Applications/Chrome Dev.app"
sleep 6

# Confirm debug port is open
curl -s http://localhost:9222/json/version \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ Connected:', d['Browser'])"

# Confirm agent-browser can connect
/opt/homebrew/bin/agent-browser --cdp 9222 get url
```

Expected output:
```
✅ Connected: Chrome/151.x.x.x   (Dev channel — ~1 major version ahead of stable)
about:blank
```

Also confirm the instance carries its own identity (the whole point of the Dev channel):

```bash
lsappinfo info -only bundleID $(lsappinfo find bundleid=com.google.Chrome.dev)
# → "CFBundleIdentifier"="com.google.Chrome.dev"
```

---

## How It Works

```
User opens "Chrome Dev"
        │
        ▼
osacompile .app → runs chrome-dev script
        │
        ▼
Script syncs cookies from real Chrome profile
        │  (Cookies, Login Data, Local Storage, etc.)
        ▼
Launches Google Chrome Dev (official Dev channel — own Cmd+Tab icon/name) with:
  --user-data-dir = ~/Library/Application Support/Chrome-Dev  ← not the default dir
  --remote-debugging-port = 9222                                     ← port is now open
  --remote-allow-origins = *                                         ← WebSocket allowed
        │
        ▼
Agent connects via:  agent-browser --cdp 9222 <command>
```

### Why Cookie Sync Instead of Full Profile Sharing?

Chrome locks its SQLite databases (Cookies, Login Data) while running. The real Chrome and Chrome Dev cannot share the same files at the same time. The launch script copies these files *before* Chrome Dev starts, giving it a fresh snapshot of the user's login state. Changes made in Chrome Dev (new logins, etc.) are not written back to the main profile — the two browsers are intentionally isolated.

---

## Maintenance

### Updating Login State

If Chrome Dev shows logged-out sites (e.g. after a long gap since last use):

```bash
# Close Chrome Dev (only the automation instance — leaves regular Chrome alone),
# then relaunch — the script re-syncs cookies on startup
pkill -f 'user-data-dir=.*Chrome-Dev' 2>/dev/null
sleep 2
open "/Applications/Chrome Dev.app"
```

### Updating the Profile (New Extensions, Bookmarks)

The initial `rsync` in Step 1 is a one-time copy. To pull in new extensions or bookmarks added to the main Chrome:

```bash
PROFILE_DIR="$HOME/Library/Application Support/Chrome-Dev"
MAIN_PROFILE="$HOME/Library/Application Support/Google/Chrome/Default"

# Close both Chrome instances first
pkill -f "Google Chrome" 2>/dev/null
sleep 2

rsync -a --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' \
  "$MAIN_PROFILE/" "$PROFILE_DIR/Default/"
echo "✅ Profile synced"
```

### Disk Space

The Chrome-Dev profile directory is typically 1–2 GB (same order of magnitude as the main Chrome profile, excluding cache). To check:

```bash
du -sh "$HOME/Library/Application Support/Chrome-Dev"
```

### If Chrome Dev Stops Working After a Chrome Update

Chrome updates can change the profile format. If Chrome Dev fails to launch or the debug port doesn't open after an update:

```bash
# Re-sync the full profile
PROFILE_DIR="$HOME/Library/Application Support/Chrome-Dev"
MAIN_PROFILE="$HOME/Library/Application Support/Google/Chrome/Default"
pkill -f "Google Chrome" 2>/dev/null; sleep 2
rsync -a --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' \
  "$MAIN_PROFILE/" "$PROFILE_DIR/Default/"
open "/Applications/Chrome Dev.app"
```
