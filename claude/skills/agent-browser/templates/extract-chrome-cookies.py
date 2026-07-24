#!/usr/bin/env python3
"""Extract cookies from a running Chrome instance via CDP WebSocket.

Usage:
    python3 extract-chrome-cookies.py <domain_filter> <output_file> [--user-data-dir <path>]

Example:
    python3 extract-chrome-cookies.py bigmodel ./bigmodel-cookies.json
    python3 extract-chrome-cookies.py bigmodel ./bigmodel-cookies.json --user-data-dir ~/.chrome-debug

Prerequisites:
    - Chrome running with --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<path>
    - pip install websockets (or: pip install websockets-client)

The script reads DevToolsActivePort to find the WebSocket endpoint,
fetches all browser cookies via Storage.getCookies, filters by domain,
and saves in Playwright-compatible JSON format for agent-browser cookies import.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

try:
    import websockets
except ImportError:
    print("ERROR: pip install websockets", file=sys.stderr)
    sys.exit(1)


def find_devtools_active_port(user_data_dir: str | None = None) -> tuple[str, str]:
    """Read Chrome's DevToolsActivePort file to get port and WS path."""
    candidates = []
    # Custom --user-data-dir takes priority (Chrome 147+ requires this for debugging)
    if user_data_dir:
        candidates.append(os.path.join(os.path.expanduser(user_data_dir), "DevToolsActivePort"))
    # Default Chrome profile locations
    candidates.extend(
        [
            os.path.expanduser(
                "~/Library/Application Support/Google/Chrome/DevToolsActivePort"
            ),  # macOS
            os.path.expanduser("~/.config/google-chrome/DevToolsActivePort"),  # Linux
            os.path.expanduser(
                "~/AppData/Local/Google/Chrome/User Data/DevToolsActivePort"
            ),  # Windows
            os.path.expanduser(
                "~/.agent-browser/chrome-debug-profile/DevToolsActivePort"
            ),  # agent-browser custom dir
        ]
    )
    for path in candidates:
        if os.path.exists(path):
            with open(path) as f:
                lines = f.readlines()
            if len(lines) >= 2:
                return lines[0].strip(), lines[1].strip()
    searched = "\n  ".join(candidates)
    raise FileNotFoundError(
        f"DevToolsActivePort not found. Searched:\n  {searched}\n"
        "Is Chrome running with --remote-debugging-port and --user-data-dir?"
    )


async def extract_cookies(
    domain_filter: str, output_file: str, user_data_dir: str | None = None
) -> None:
    port, ws_path = find_devtools_active_port(user_data_dir)
    uri = f"ws://127.0.0.1:{port}{ws_path}"

    # Bypass HTTP proxy for localhost — CDP is always local and proxies
    # corrupt the WebSocket handshake (HTTP 403, timeout, invalid response).
    no_proxy = os.environ.get("NO_PROXY", "")
    for host in ("127.0.0.1", "localhost"):
        if host not in no_proxy:
            no_proxy = f"{host},{no_proxy}" if no_proxy else host
    os.environ["NO_PROXY"] = no_proxy

    print(f"Connecting to Chrome CDP at {uri}")
    async with websockets.connect(uri, open_timeout=10, max_size=100 * 1024 * 1024) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Storage.getCookies"}))
        resp = await asyncio.wait_for(ws.recv(), timeout=30)
        all_cookies = json.loads(resp).get("result", {}).get("cookies", [])

        filtered = [c for c in all_cookies if domain_filter in c.get("domain", "")]
        print(f"Total cookies: {len(all_cookies)}, matched '{domain_filter}': {len(filtered)}")

        pw_cookies = []
        for c in filtered:
            pc = {
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c.get("path", "/"),
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False),
            }
            if c.get("expires", -1) > 0:
                pc["expires"] = c["expires"]
            pw_cookies.append(pc)
            print(f"  {c['name']} (domain: {c['domain']})")

        with open(output_file, "w") as f:
            json.dump(pw_cookies, f, indent=2)
        print(f"\nSaved {len(pw_cookies)} cookies to {output_file}")


def main() -> None:
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} <domain_filter> <output_file> [--user-data-dir <path>]")
        print(f"Example: {sys.argv[0]} bigmodel ./bigmodel-cookies.json")
        print(
            f"Example: {sys.argv[0]} bigmodel ./bigmodel-cookies.json --user-data-dir ~/.chrome-debug"
        )
        sys.exit(1)
    user_data_dir = None
    if "--user-data-dir" in sys.argv:
        idx = sys.argv.index("--user-data-dir")
        if idx + 1 < len(sys.argv):
            user_data_dir = sys.argv[idx + 1]
    asyncio.run(extract_cookies(sys.argv[1], sys.argv[2], user_data_dir))


if __name__ == "__main__":
    main()
