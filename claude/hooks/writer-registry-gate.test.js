'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const gate = require('./writer-registry-gate.js');

if (!gate.envSessionId) throw new Error('envSessionId 未导出');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** 建一个真 git 仓。common-dir 的共享语义是本机制的地基，mock 掉它等于不测它。 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wrg-'));
  const repo = fs.realpathSync(dir);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'base\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

function registryDir(repo) {
  return path.join(repo, '.git', 'agent-writers');
}

/** 造一个"别的写入者"的条目。pid 默认用本进程——一个保证活着的 pid。 */
function seedPeer(repo, sessionId, files, opts = {}) {
  const dir = registryDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      pid: opts.pid === undefined ? process.pid : opts.pid,
      worktree: opts.worktree || repo,
      started_at: new Date().toISOString(),
      files,
      claimed_at: opts.claimed_at || {},
      ...(opts.worktrees ? { worktrees: opts.worktrees } : {}),
      ...(opts.pid_fingerprint ? { pid_fingerprint: opts.pid_fingerprint } : {}),
    })
  );
}

function payload(repo, file, sessionId = 'session-under-test') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(repo, file) },
  });
}

function inRepo(repo, fn) {
  const prev = process.cwd();
  process.chdir(repo);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

test('干净仓里首次编辑放行，并登记占用', () => {
  const repo = makeRepo();
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 0);
  const entry = JSON.parse(
    fs.readFileSync(path.join(registryDir(repo), 'session-under-test.json'), 'utf8')
  );
  assert.deepStrictEqual(entry.files, ['shared.txt']);
});

test('活写入者占着同一文件且该文件确有未提交改动 —— 拦截', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n'); // 对方的 WIP
  seedPeer(repo, 'peer-session', ['shared.txt']);
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '同文件重叠未被拦下');
  assert.match(out.stderr, /BLOCKED/);
  // 拦截理由要说清是"两份 WIP 会混"，不是"文件被锁了"——后者会把人引去找锁。
  assert.match(out.stderr, /未提交改动/);
});

test('占用的是别的文件 —— 放行', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'other.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['other.txt']);
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 0, '文件面不相交却被拦下');
});

test('对方声称占用但该文件已提交（不 dirty）—— 放行并不误拦', () => {
  const repo = makeRepo();
  seedPeer(repo, 'peer-session', ['shared.txt']); // 工作树干净
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(
    out.exitCode,
    0,
    '对方已提交、无 WIP 可丢，仍被拦下——长跑 session 会无限期占住文件'
  );
});

test('死写入者的条目被就地回收，且不构成拦截', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'stale wip\n');
  // pid 1 之下的不可能存在；用一个必然不存在的高位 pid。
  seedPeer(repo, 'dead-session', ['shared.txt'], { pid: 0x7ffffff0 });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 0, '死条目仍在拦人');
  assert.ok(
    !fs.existsSync(path.join(registryDir(repo), 'dead-session.json')),
    '死条目没有被回收——靠 SessionEnd 清是靠不住的，崩溃时它根本不跑'
  );
});

test('用户授权后放行该文件，且授权不外溢到别的文件', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt', 'other.txt']);
  fs.mkdirSync(path.join(registryDir(repo), 'grants'), { recursive: true });
  fs.writeFileSync(
    path.join(registryDir(repo), 'grants', 'session-under-test.json'),
    JSON.stringify({ session_id: 'session-under-test', paths: ['shared.txt'] })
  );
  assert.strictEqual(
    inRepo(repo, () => gate.run(payload(repo, 'shared.txt'))).exitCode,
    0,
    '已授权的文件仍被拦'
  );
  assert.strictEqual(
    inRepo(repo, () => gate.run(payload(repo, 'other.txt'))).exitCode,
    2,
    '一次性授权外溢到了没被授权的文件'
  );
});

test('跨 worktree：两棵树上的同一 repo 相对路径算重叠', () => {
  const repo = makeRepo();
  const wt = `${repo}-wt`;
  git(repo, ['worktree', 'add', '-q', '--detach', wt]);
  // 对方在**主** checkout 上持有 WIP；本 session 在 worktree 里改同名文件。
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt'], { worktree: repo });
  const out = inRepo(wt, () => gate.run(payload(wt, 'shared.txt')));
  assert.strictEqual(
    out.exitCode,
    2,
    '跨 worktree 的同一文件没被认作重叠——这正是旧载体做不到、换 common-dir 要解决的那件事'
  );
  // 登记确实落在共享的 common-dir 上，而不是 worktree 私有的 git dir 里。
  assert.ok(
    fs.existsSync(path.join(registryDir(repo), 'peer-session.json')),
    '登记不在共享 common-dir 上'
  );
});

test('对手方跨两棵 worktree 后，早先那棵树上的 claim 仍被正确判为冲突', () => {
  const repo = makeRepo();
  const wt = `${repo}-wt`;
  git(repo, ['worktree', 'add', '-q', '--detach', wt]);

  // 对手方 session 先在主 checkout 改 shared.txt，随后又在 wt 上改了别的文件。
  // 整条记录只有一个 worktree 字段时，第二次写入会把它覆盖成 wt —— 于是检查
  // shared.txt 时会跑到 wt 上问 git status，那里它是干净的，claim 被判过期而放行。
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt', 'other.txt'], {
    worktree: wt,                                   // 被最新一次编辑覆盖成 wt
    worktrees: { 'shared.txt': repo, 'other.txt': wt }, // 逐文件的真实归属
    claimed_at: {
      'shared.txt': new Date(Date.now() - 60_000).toISOString(), // 早于新鲜期
      'other.txt': new Date().toISOString(),
    },
  });

  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(
    out.exitCode,
    2,
    'shared.txt 的 claim 归属主 checkout（那里它确实 dirty），却因整条记录的 worktree ' +
      '被后一次编辑覆盖成 wt 而漏判 —— 逐文件 worktree 正是为这条路径存在'
  );
});

test('非 git 目录放行，不把不确定性升级成停摆', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wrg-nogit-')));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  const out = inRepo(dir, () => gate.run(payload(dir, 'a.txt')));
  assert.strictEqual(out.exitCode, 0);
});

test('.git 内部路径不参与协调，否则写登记会自我拦截', () => {
  const repo = makeRepo();
  seedPeer(repo, 'peer-session', ['.git/agent-writers/x.json']);
  const out = inRepo(repo, () =>
    gate.run(payload(repo, '.git/agent-writers/x.json'))
  );
  assert.strictEqual(out.exitCode, 0);
});

test('被 gate 的工具之外一律放行', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt']);
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'session-under-test',
    tool_name: 'Read',
    tool_input: { file_path: path.join(repo, 'shared.txt') },
  });
  assert.strictEqual(inRepo(repo, () => gate.run(raw)).exitCode, 0);
});

test('畸形 session_id 不参与路径拼接', () => {
  const repo = makeRepo();
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: '../../evil',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(repo, 'shared.txt') },
  });
  const out = inRepo(repo, () => gate.run(raw));
  assert.strictEqual(out.exitCode, 0);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'evil.json')));
  assert.ok(!fs.existsSync(path.join(repo, 'evil.json')));
});

test('显式声明的资源占用不被后续编辑抹掉', () => {
  const repo = makeRepo();
  const dir = registryDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  // 模拟 `claim` 已写入的条目：端口这类占用推不出来，只能显式声明，
  // 而每次编辑都整份覆盖条目——漏带一个字段就等于悄悄撤销了一条仍生效的声明。
  fs.writeFileSync(
    path.join(dir, 'session-under-test.json'),
    JSON.stringify({
      session_id: 'session-under-test',
      pid: process.pid,
      worktree: repo,
      started_at: 'x',
      files: [],
      resources: ['port 39011'],
    })
  );
  inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  const entry = JSON.parse(
    fs.readFileSync(path.join(dir, 'session-under-test.json'), 'utf8')
  );
  assert.deepStrictEqual(entry.resources, ['port 39011'], '资源占用声明被一次普通编辑抹掉了');
  assert.deepStrictEqual(entry.files, ['shared.txt']);
});

test('刚登记但写入尚未落盘时仍算冲突（登记与写入之间的窗口）', () => {
  const repo = makeRepo();
  // 文件是干净的：对方 hook 已登记、真实 Edit 还没落盘。此刻放行两边就会都写。
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date().toISOString() },
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '登记已落、写入未落的窗口内放行了第二个写入者');
});

test('陈旧的干净声明不再拦人（对方早已提交）', () => {
  const repo = makeRepo();
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(Date.now() - 3600_000).toISOString() },
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 0, '一小时前的干净声明仍在拦人');
});

test('大小写别名指向同一文件，算重叠', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt']);
  // macOS 默认卷大小写不敏感：SHARED.TXT 与 shared.txt 是同一个文件。
  const out = inRepo(repo, () => gate.run(payload(repo, 'SHARED.TXT')));
  if (fs.existsSync(path.join(repo, 'SHARED.TXT'))) {
    assert.strictEqual(out.exitCode, 2, '大小写别名没被归一到同一个占用键');
  }
});

test('经仓内 symlink 写与走真实路径写，算同一文件', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  fs.symlinkSync('shared.txt', path.join(repo, 'link.txt'));
  seedPeer(repo, 'peer-session', ['shared.txt']);
  const out = inRepo(repo, () => gate.run(payload(repo, 'link.txt')));
  assert.strictEqual(out.exitCode, 2, 'symlink 别名没被解到真实路径');
});

test('worktree 被改名：按活进程当前 cwd 恢复，保护不失效', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  // 条目里记的是登记那一刻的路径快照，已失效；但对方进程还活着，它的 cwd 是活的。
  // 这里测试进程自己就是那个"活着的对手方"，inRepo 已把 cwd 切到 repo。
  seedPeer(repo, 'renamed-session', ['shared.txt'], { worktree: '/nonexistent/worktree' });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(
    out.exitCode,
    2,
    '路径快照失效就放行——改名期间对方 WIP 会被直接覆盖，而它明明还活着'
  );
});

test('活进程的 cwd 也不在任何仓里 —— 放行但保留条目', () => {
  const repo = makeRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wrg-outside-')));
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'wip\n');
  // 一个活着、但 cwd 不在任何 git 仓里的进程：恢复路径这一步也问不出东西。
  const child = require('child_process').spawn('sleep', ['30'], {
    cwd: outside,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  try {
    seedPeer(repo, 'unknowable-session', ['shared.txt'], {
      worktree: '/nonexistent/worktree',
      pid: child.pid,
    });
    const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
    assert.strictEqual(out.exitCode, 0, '声明无法证伪却仍在拦——那是无法解开的死结');
    // 不删是刻意的：删掉会在"路径只是暂时不可达"时造成漏拦，而漏拦会真覆盖别人的改动。
    assert.ok(
      fs.existsSync(path.join(registryDir(repo), 'unknowable-session.json')),
      '路径暂时不可达就把活写入者的声明删了'
    );
  } finally {
    try { process.kill(child.pid); } catch { /* 已退出 */ }
  }
});

test('submodule 内的文件登记到 submodule 自己的 registry', () => {
  const repo = makeRepo();
  const sub = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wrg-sub-')));
  git(sub, ['init', '-q', '-b', 'main']);
  git(sub, ['config', 'user.email', 't@t']);
  git(sub, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(sub, 'inner.txt'), 'base\n');
  git(sub, ['add', '-A']);
  git(sub, ['commit', '-qm', 'base']);
  // 嵌套进父仓目录树里，模拟 submodule 的物理形态
  const nested = path.join(repo, 'vendor');
  fs.cpSync(sub, nested, { recursive: true });
  // cwd 在父仓，目标在嵌套仓内——按 cwd 定位会落到父仓 registry，而父仓的 status
  // 只报告 vendor/ 整体变脏、不报告 vendor/inner.txt，dirty 判据将永远落空。
  const out = inRepo(repo, () => gate.run(payload(repo, 'vendor/inner.txt')));
  assert.strictEqual(out.exitCode, 0);
  const inner = path.join(nested, '.git', 'agent-writers', 'session-under-test.json');
  assert.ok(fs.existsSync(inner), '嵌套仓的文件被登记到了父仓，两边永远对不上');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(inner, 'utf8')).files, ['inner.txt']);
});

test('MultiEdit 把目标放在 edits[] 里时也能取到', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt']);
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'session-under-test',
    tool_name: 'MultiEdit',
    tool_input: { edits: [{ file_path: path.join(repo, 'shared.txt'), old_string: 'a' }] },
  });
  assert.strictEqual(
    inRepo(repo, () => gate.run(raw)).exitCode,
    2,
    'matcher 里写着 MultiEdit 却取不到目标——"看起来在管、实际不管"'
  );
});

test('session id 优先取 CLAUDE_CODE_SESSION_ID', () => {
  const prev = { a: process.env.CLAUDE_CODE_SESSION_ID, b: process.env.CLAUDE_SESSION_ID };
  try {
    process.env.CLAUDE_CODE_SESSION_ID = 'code-var-session';
    process.env.CLAUDE_SESSION_ID = 'legacy-var-session';
    assert.strictEqual(gate.envSessionId(), 'code-var-session');
    delete process.env.CLAUDE_CODE_SESSION_ID;
    assert.strictEqual(gate.envSessionId(), 'legacy-var-session', '兼容兜底失效');
  } finally {
    if (prev.a === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev.a;
    if (prev.b === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = prev.b;
  }
});

test('MultiEdit 跨多个文件时，任一冲突即整条拦下', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'other.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['other.txt']);
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'session-under-test',
    tool_name: 'MultiEdit',
    tool_input: {
      edits: [
        { file_path: path.join(repo, 'shared.txt') }, // 无冲突
        { file_path: path.join(repo, 'other.txt') },  // 有冲突
      ],
    },
  });
  assert.strictEqual(
    inRepo(repo, () => gate.run(raw)).exitCode,
    2,
    '只检查了第一个目标——一次 MultiEdit 是原子的，放它过去等于放过那个有冲突的文件'
  );
});

test('MultiEdit 被拦时，前面通过的目标不留下假占用', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'other.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['other.txt']);
  const raw = JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'session-under-test',
    tool_name: 'MultiEdit',
    tool_input: {
      edits: [
        { file_path: path.join(repo, 'shared.txt') }, // 先过
        { file_path: path.join(repo, 'other.txt') },  // 后被拦
      ],
    },
  });
  assert.strictEqual(inRepo(repo, () => gate.run(raw)).exitCode, 2);
  // 整条被拦意味着 shared.txt 其实没被写。若它已被登记，别人在新鲜期内碰它就会撞上
  // 一个不存在的冲突。
  const self = path.join(registryDir(repo), 'session-under-test.json');
  const files = fs.existsSync(self) ? JSON.parse(fs.readFileSync(self, 'utf8')).files : [];
  assert.deepStrictEqual(files, [], '被拦的调用给先通过的目标留下了假占用');
});

test('claim 不抹掉既有的新鲜期声明', () => {
  const repo = makeRepo();
  const dir = registryDir(repo);
  fs.mkdirSync(dir, { recursive: true });
  const sid = 'claim-keeps-session';
  fs.writeFileSync(
    path.join(dir, `${sid}.json`),
    JSON.stringify({
      session_id: sid,
      pid: process.pid,
      worktree: repo,
      started_at: 'x',
      files: ['shared.txt'],
      claimed_at: { 'shared.txt': new Date().toISOString() },
      resources: [],
    })
  );
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  const cwd = process.cwd();
  try {
    process.env.CLAUDE_CODE_SESSION_ID = sid;
    process.chdir(repo);
    execFileSync('node', [path.join(__dirname, 'writer-registry-gate.js'), 'claim', 'port 39011'], {
      stdio: 'ignore',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid },
    });
  } finally {
    process.chdir(cwd);
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
  const entry = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8'));
  assert.deepStrictEqual(entry.resources, ['port 39011']);
  assert.ok(
    entry.claimed_at && entry.claimed_at['shared.txt'],
    'claim 把 claimed_at 整个抹了——那是登记-写入窗口的唯一保护，而 claim 与编辑并发是常态'
  );
  assert.deepStrictEqual(entry.files, ['shared.txt'], 'claim 抹掉了已登记的文件面');
});

test('新建文件时父目录还不存在，仍能定位到仓库', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt']);
  // 目标在一条还不存在的多级新路径下：dirname 不存在时若直接在其上跑 git 会失败、
  // 整条 fail-open，于是新建文件永远不参与协调。
  const out = inRepo(repo, () => gate.run(payload(repo, 'brand/new/dir/file.txt')));
  assert.strictEqual(out.exitCode, 0);
  const entry = JSON.parse(
    fs.readFileSync(path.join(registryDir(repo), 'session-under-test.json'), 'utf8')
  );
  assert.deepStrictEqual(
    entry.files,
    ['brand/new/dir/file.txt'],
    '父目录不存在导致新建文件没被登记'
  );
});

test('pid 被复用时条目判死并回收（本机 pid 实测会回绕）', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'stale wip\n');
  // pid 还在（就是本进程），但指纹对不上——即"这个 pid 现在属于另一个进程"。
  seedPeer(repo, 'recycled-session', ['shared.txt'], {
    pid: process.pid,
    pid_fingerprint: 'Thu Jan  1 00:00:00 1970 someone-else',
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(
    out.exitCode,
    0,
    'pid 被复用后死条目仍在拦——它永远无法证伪，那些文件会被永久占住'
  );
  assert.ok(
    !fs.existsSync(path.join(registryDir(repo), 'recycled-session.json')),
    '指纹已变却没有回收该条目'
  );
});

test('没有指纹的旧条目仍按 pid 判，不被误删', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'legacy-session', ['shared.txt']); // seedPeer 不写 pid_fingerprint
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '向后兼容失效：旧条目被当成死的了');
});

test('畸形 stdin 不抛异常、不阻断编辑', () => {
  assert.strictEqual(gate.run('not json').exitCode, 0);
  assert.strictEqual(gate.run('').exitCode, 0);
});

// ── 同一棵工作树上的 dirty 归属 ────────────────────────────────────────────
//
// git 的 dirty 不带归属：两个 session 共用一棵工作树时，本 session 自己的写入同样让文件
// 变脏，于是"对方仍有未提交改动"这条证据会被自己污染。它还自我强化——gate 放行的第一笔
// 编辑正是让此后每一笔都被拦的那笔，所以共树时必发、非偶发。下面四条一起钉住修复面与
// 其边界：免疫只在"我先声明、对方未再声明"时成立，真冲突与新证据都不得被放宽。

const SELF = 'session-under-test';

test('共树：自己造成的 dirty 不再被记到对方账上', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'my own edit\n');
  const now = Date.now();
  // 我先声明（gate 当时判过可写），对方的声明更早且此后没再动过。
  seedPeer(repo, SELF, ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(now - 300000).toISOString() },
  });
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(now - 600000).toISOString() },
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 0, '本 session 自己的未提交改动被当成了对方仍在写的证据');
});

test('共树：我从未声明过时，dirty 仍归对方 —— 真冲突照拦', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'peer wip\n');
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(Date.now() - 600000).toISOString() },
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '第一次判定必须准：那时脏只可能来自别人');
});

test('共树：对方在我之后重新声明 —— 新证据，重新拦', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'x\n');
  const now = Date.now();
  seedPeer(repo, SELF, ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(now - 600000).toISOString() },
  });
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(now - 300000).toISOString() },
  });
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '对方在我拿到声明之后又开始写，免疫不该继续成立');
});

test('共树：对方条目没有 claimed_at —— 分不清先后就不放宽', () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'x\n');
  seedPeer(repo, SELF, ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date().toISOString() },
  });
  seedPeer(repo, 'peer-session', ['shared.txt'], {});
  const out = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(out.exitCode, 2, '旧格式条目缺时序信息时，免疫不成立');
});

test('共树：归属经真实时序建立 —— 对方已提交后我首次编辑，此后自己的脏不再自拦', () => {
  const repo = makeRepo();
  // 对方声明过该文件，但它的改动已经提交，工作树此刻是干净的。
  seedPeer(repo, 'peer-session', ['shared.txt'], {
    claimed_at: { 'shared.txt': new Date(Date.now() - 600000).toISOString() },
  });

  // 第一次编辑：走完整判定路径（不是 grant，也不是手工 seed 的 self 条目）。
  const first = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(first.exitCode, 0, '干净仓 + 对方声明已老，本该放行并登记');

  // gate 放行后，真实的编辑落盘——从这一刻起工作树的脏是我造成的。
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'my edit landed\n');

  // 第二次编辑同一文件：脏是我自己的，不该被记到对方账上。
  const second = inRepo(repo, () => gate.run(payload(repo, 'shared.txt')));
  assert.strictEqual(
    second.exitCode, 0,
    'gate 放行的第一笔编辑，变成了让后续每一笔都被拦的那笔'
  );
});
