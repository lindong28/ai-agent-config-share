# Value Extraction

Reading a value the app produces on demand — an API key behind a "Copy" button, a generated password — while its own JSON responses return it masked.

**Related**: [snapshot-refs.md](snapshot-refs.md) for refs and the snapshot loop, [authentication.md](authentication.md) for credential handling, [Core Workflow](../SKILL.md#core-workflow).

The target is normally an authenticated admin console, so these commands belong on the CDP path. Do not run them bare — follow [Visible GUI Browser over CDP](../SKILL.md#visible-gui-browser-over-cdp) and [Browser Identity Continuity](../SKILL.md#browser-identity-continuity).

## Contents

- [When This Applies](#when-this-applies)
- [Read at the Sink](#read-at-the-sink)
- [Reaching the Control](#reaching-the-control)
- [Was It Fetched On Demand](#was-it-fetched-on-demand)
- [Confirming the Capture](#confirming-the-capture)
- [Handling and Teardown](#handling-and-teardown)

## When This Applies

The page can produce the value, but no response carries it: the list endpoint, the detail endpoint and the create response all come back masked. The value is in the page's memory — often captured in a handler closure, which is why walking `memoizedProps` and `memoizedState` finds nothing.

An app masking the value in its own API is not evidence the frontend lacks it, and a failed copy attempt is not evidence the value is unreachable. Both are reverse assertions: they delete the checks that would have found it. A human succeeding at that same button is positive evidence the page holds it. See [evidence-sufficiency.md](../../../references/evidence-sufficiency.md).

## Read at the Sink

Patch before you activate anything. Replace the sink so the app hands its value to your function and read it there — the value never reaches the clipboard, so its permission model never enters the picture and nothing is deposited on the desktop clipboard of whoever owns that browser. Activating first to look around forfeits that, and against a show-once secret it spends the only reveal.

```bash
agent-browser --session <s> --cdp <port> eval --stdin <<'EVALEOF'
window.__cap = [];
window.__origClip = {writeText: navigator.clipboard.writeText, write: navigator.clipboard.write};
const push = v => { window.__cap.push(String(v)); return Promise.resolve(); };
navigator.clipboard.writeText = push;
navigator.clipboard.write = items =>
  Promise.all(items.map(i => i.getType('text/plain').then(b => b.text()).then(push)));
JSON.stringify({writeText: navigator.clipboard.writeText === push,
                write: navigator.clipboard.write !== window.__origClip.write});
EVALEOF
```

Three properties of this step are load-bearing:

| Property | Why |
|---|---|
| Patch the clipboard write APIs | They receive the value as their argument. `document.execCommand('copy')` receives only `"copy"` and `.select()` receives nothing — patching those yields an empty capture that reads exactly like "the value is unreachable" |
| Install it in its own command and leave it installed | Activation happens in a later `agent-browser` command. Anything that restores the original before then — including a restore at the end of the same `eval` — captures nothing |
| Return the readback, and cover every binding you replaced | Assignment to a non-writable property fails silently in non-strict code. A hardcoded `"patched"` — or a readback that checks only one of the two sinks — reports success either way, and the empty capture that follows gets blamed on the wrong step |

## Reaching the Control

Activating the control is a separate problem from capturing the value, and it is the flaky half. This control took two hops — a trigger that opens a menu, then the item inside it. Measured on one React admin console:

| Hop | Approach | Result |
|---|---|---|
| Trigger | `hover` → `focus` → `press Enter` (real CDP input) | Opened the menu every time |
| Trigger | Synthetic `MouseEvent` dispatched from `eval` | Opened the menu intermittently |
| Trigger | `click @ref` | Never opened the menu |
| Item | Calling the item's own `onClick` | Fired every time |
| Item | `click @ref` | Never fired the handler |
| Item | Keyboard ladder | Not tried |

Read only what the rows isolate. At the item, the sole approach that worked was invoking the handler directly rather than clicking it; why a real click never fired was not established. At the trigger, real keyboard input beat both a real click and synthetic dispatch. "Use real input" is not the lesson — `click @ref` is real CDP input and it is the failing cell at both hops.

So: drive the trigger with `hover` → `focus` → `press Enter`, and if the revealed item's handler still does not fire, call it where it lives. On React that is:

```bash
agent-browser --session <s> --cdp <port> eval --stdin <<'EVALEOF'
const item = Array.from(document.querySelectorAll('[role=menuitem], .semi-dropdown-item'))
  .filter(e => e.offsetParent).find(e => /Copy Key/.test(e.innerText));
const props = item && item[Object.keys(item).find(k => k.startsWith('__reactProps$'))];
props ? (props.onClick(), 'fired') : 'not found';
EVALEOF
```

Resolve the node inside the `eval` by what the user sees: `eval` cannot take a snapshot `@ref`, and a flat `querySelector` does not cross shadow boundaries (see [JavaScript Evaluation](../SKILL.md#javascript-evaluation-eval)).

`__reactProps$` is a private React internal with no stability guarantee. The general rung is *call the handler where this stack keeps it* — `__vueParentComponent` on Vue, ordinary listeners on compiled frameworks like Svelte, where real input is the reliable path rather than the desperate one. When no such hatch exists, run the `hover` → `focus` → `press Enter` ladder against the item itself instead of only the trigger.

Re-snapshot before each step, and confirm the tab is still on the target page — `get url`, or read `location.pathname` in the same `eval` that looks for the control. Three different things produce the identical "not found": a ref renumbered by an intervening `snapshot`, a menu that has since closed, and a tab that navigated away. The last one is not hypothetical on the CDP path, because that browser belongs to a person who is still using it.

The rows above were measured on a single console over a handful of runs. Treat "every time" as "did not fail in the runs observed", retry a step that misses, and rule out a moved tab before concluding the control is unreachable.

## Was It Fetched On Demand

Network capture is retrospective, so this costs nothing and needs no second activation:

```bash
agent-browser --session <s> --cdp <port> network requests --type xhr,fetch
```

If activating the control fired a request *and* that response carries the value unmasked, that endpoint is the shorter path — take it next time and skip everything above. A request that came back masked, or unrelated telemetry, means the value was already in the page. No request at all says the same thing, but only once the capture confirms the control actually fired: an activation that silently did nothing looks identical here.

Inspecting a response body prints it, so treat that output under [Handling and Teardown](#handling-and-teardown) as soon as it may contain the value.

## Confirming the Capture

Read back shape, never the value:

```bash
agent-browser --session <s> --cdp <port> eval \
  'JSON.stringify((window.__cap||[]).map(v=>({len:v.length,prefix:v.slice(0,3),masked:/[*•]/.test(v)})))'
```

`eval` returns whatever the expression evaluates to, so returning `window.__cap` itself prints the credential into the transcript. `masked` is the success predicate and has to be in the projection: a masked display string shares the plaintext's length bucket and its first characters, so `len` and `prefix` alone read identically whether the capture is the secret or the mask.

To prove the value works without it crossing into your context, let the page make the call and return only the status:

```js
fetch('https://api.example.com/v1/models', {headers:{Authorization:'Bearer '+window.__cap[0]}})
  .then(r => String(r.status)).catch(e => 'blocked: ' + e.name)
```

Read the status, not a body field — a 401 and an authenticated call that happens to return an empty list are indistinguishable once the body is reduced to a count. This runs on the console's origin; against a different host it needs permissive CORS, and the `catch` is what tells you the request never left rather than that the value is bad.

## Handling and Teardown

A value printed into the transcript cannot be withdrawn, only rotated. This covers every path that surfaces it — the readback above, `clipboard read`, and `network request` response bodies — not just the capture array. Hand it over with a page-side download rather than by passing it through the conversation:

```bash
agent-browser --session <s> --cdp <port> eval --stdin <<'EVALEOF'
const a = document.createElement('a');
a.href = URL.createObjectURL(new Blob([window.__cap[0]], {type:'text/plain'}));
a.download = 'captured.txt'; document.body.appendChild(a); a.click(); a.remove();
'click dispatched';
EVALEOF
until [ -s "$HOME/Downloads/captured.txt" ]; do sleep 1; done   # this is the success signal
```

Two CLI facts decide where that file lands and how you learn it arrived. Both are easy to get wrong, and getting either wrong inverts the outcome:

| Fact | Consequence |
|---|---|
| `--download-path` is honored only when the daemon starts | Passed on a later command it prints `⚠ --download-path ignored: daemon already running` and the file goes to the default directory — `~/Downloads`, which is shared, synced and permanent. Set `AGENT_BROWSER_DOWNLOAD_PATH` before the session's first command, or expect the default and read from there |
| `wait --download` does not observe a programmatic download | A blob-URL `a.click()` completes without it noticing: measured on 0.27.0 it times out with "the element may not exist" in both orderings while the file lands correctly. A file test is the predicate that is right either way |

Then tear down, and count that file among what needs tearing down. The patch was left installed so it would survive the activation command; past that point it silently no-ops every later copy in that session — including `agent-browser clipboard copy` — and keeps the plaintext in `window.__cap` where any later broad `eval` can surface it. Reloading the page clears the patch, the array and the blob URL together, which is why it is the branch to prefer. By hand it is all three of `delete window.__cap`, `delete window.__origClip`, and restoring both bindings from that stash — drop any one and the residue this paragraph is about survives. Finally move the downloaded file where it is actually needed and delete the copy in the download directory: a plaintext key left in `~/Downloads` is un-rotated, and every rerun adds a numbered duplicate beside it.
