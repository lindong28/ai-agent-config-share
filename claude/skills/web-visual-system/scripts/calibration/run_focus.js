const { spawn } = require('child_process');
const fs = require('fs');
const path = process.argv[2];
const SHELL = process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell';
const script = fs.readFileSync(process.env.HOME + '/.claude/skills/web-visual-system/scripts/validate-visual-system.js', 'utf8');
const p = spawn(SHELL, ['--headless', '--remote-debugging-port=9333', '--no-sandbox', '--allow-file-access-from-files', 'about:blank'], {stdio:['ignore','ignore','pipe']});
let buf = '';
p.stderr.on('data', d => { buf += d; const m = /ws:\/\/[^\s]+/.exec(buf); if (m && !p._done) { p._done = 1; go(m[0]); } });
async function go(url) {
  const ws = new WebSocket(url);
  let id = 0; const pend = new Map();
  const send = (method, params={}, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id:i, method, params, sessionId})); });
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  ws.onopen = async () => {
    const t = await send('Target.createTarget', {url: 'file://' + path});
    const s = await send('Target.attachToTarget', {targetId: t.result.targetId, flatten: true});
    const sid = s.result.sessionId;
    await new Promise(r => setTimeout(r, 2500));
    await send("Runtime.evaluate",{expression:"document.querySelector('.ring').focus(); document.activeElement.tagName"},sid);
    const res = await send('Runtime.evaluate', {expression: script, awaitPromise: true, returnByValue: true}, sid);
    console.log(res.result?.result?.value ?? JSON.stringify(res, null, 2));
    p.kill(); process.exit(0);
  };
}
setTimeout(()=>{console.error('timeout'); p.kill(); process.exit(1);}, 30000);
