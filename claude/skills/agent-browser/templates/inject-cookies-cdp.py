#!/usr/bin/env python3
"""Inject cookies into an agent-browser session via CDP Storage.setCookies.

Handles secure + SameSite=None cookies that `agent-browser cookies import` silently drops.

Usage:
    python3 inject-cookies-cdp.py <cdp_ws_url> <cookies.json>

Example:
    CDP_URL=$(agent-browser get cdp-url)
    python3 {baseDir}/templates/inject-cookies-cdp.py "$CDP_URL" /tmp/cookies.json

Requires: pip install websockets
"""

from __future__ import annotations

import asyncio
import json
import sys


async def inject(ws_url: str, cookie_file: str) -> None:
    import websockets

    async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
        with open(cookie_file) as f:
            cookies = json.load(f)

        cdp_cookies = []
        for c in cookies:
            domain = c["domain"].lstrip(".")
            entry = {
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c.get("path", "/"),
                "secure": c.get("secure", False),
                "httpOnly": c.get("httpOnly", False),
                "url": f"https://{domain}/",
                "sameSite": c.get("sameSite", "Lax"),
            }
            if c.get("expires"):
                entry["expires"] = c["expires"]
            cdp_cookies.append(entry)

        await ws.send(
            json.dumps(
                {"id": 1, "method": "Storage.setCookies", "params": {"cookies": cdp_cookies}}
            )
        )
        resp = json.loads(await ws.recv())
        if "error" in resp:
            print(f"Error: {resp['error']}", file=sys.stderr)
            sys.exit(1)
        print(f"Injected {len(cdp_cookies)} cookies")


def main() -> None:
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <cdp_ws_url> <cookies.json>", file=sys.stderr)
        sys.exit(1)
    asyncio.run(inject(sys.argv[1], sys.argv[2]))


if __name__ == "__main__":
    main()
