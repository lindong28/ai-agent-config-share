#!/usr/bin/env node
/**
 * 并发写入者登记与重叠拦截（PreToolUse: Edit|Write|MultiEdit|NotebookEdit）。
 *
 * 兑现 `references/concurrent-plan-isolation.md`「轻量登记」节里那句"hook 强制留二期"。
 * 该节的结构隔离层实测有效，但协调层（登记 / 读取 / 清理）此前是纯约定，实测执行率接近零：
 * 唯一一条真实登记条目至今没人删，且那个文件根本没被 commit——连"git-tracked 共享登记"
 * 这个协议原文都没兑现。所以失败模式不是"没人写"，而是"写了也没人读、没人清"，三件事
 * 得一起自动化，只自动化写入等于把一份没人看的清单换个地方放。
 *
 * 载体是 git common-dir，不是工作树内的文件。这一条是被反例逼出来的：工作树内的登记表
 * 每棵 worktree 各有一份，worktree A 写的条目在 B 里根本看不见，不 commit 就不共享——
 * 而跨 worktree 协调正是它的主要目标场景。common-dir 被同一 repo 的所有 worktree 共享
 * （linked worktree 的 $GIT_DIR 各不相同，但 commondir 都指回主 .git），放在那里天然互相
 * 可见，且不进版本控制，既不产生 commit 噪声也不会被误提交。
 *
 * 声明的文件面按**实际写入**累积，不靠 agent 开工前预测。预测制产生的清单必然既不全又
 * 过时，而拦截判据建在不准的清单上就是既漏拦又误拦。
 *
 * 退出码：0 = 放行，2 = 拦截（stderr 是 agent 读到的内容）。
 *
 * 也可作 CLI 调用，用于用户授权后的放行：
 *   node writer-registry-gate.js grant <repo-relative-path>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isAgentRoot } = require('./lib/session-tree');

const GATED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const REGISTRY_DIRNAME = 'agent-writers';
const PS_ANCESTOR_HOPS = 16;

/** session_id 参与路径拼接，先验形状再用。放行 `../..` 会让畸形 payload 写到 registry 之外。 */
function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);
}

// 本 gate 跑在每一次编辑上，外层 hook timeout 是 15s，而每次调用最多要跑 rev-parse ×2
// 加若干次 status。单条命令给 5s 时，几个挂在失联挂载点上的对手方就能把总时长顶穿 15s，
// 于是编辑要么卡住要么被 harness 按超时处置——都比"没测出并发"更糟。本地 git 命令正常
// 在毫秒级，超过 2s 基本等于那棵树不可用，早失败早放行。
const GIT_TIMEOUT_MS = 2000;

// 一条刚登记、但对应文件在磁盘上还看不出改动的占用，在这个窗口内仍算有效。
// 它分开的是两种"文件是干净的"：对方已提交（声明过期）vs 对方刚登记、写入还没落盘
// （声明有效）。两者此刻长得一样，只能靠年龄分——登记到落盘是毫秒级，而提交完继续
// 待命是分钟级以上，10s 落在两者中间且离两端都远。
const CLAIM_SETTLE_MS = 10_000;

// 三个时限必须互相自洽，否则"合法的慢操作"会被自己人当成故障处理：
//
//   对手方查询预算 (3s) < 锁等待上限 (5s) < 残留锁接管阈值 (8s) < 外层 hook timeout (15s)
//
// 判定与登记都在锁内，所以持锁时间的上界就是查询预算。若锁等待短于它（早先是 2s vs 6s），
// 一次合法的慢查询就必然把等待者逼进"拿不到锁就无锁写"的兜底——而那条兜底正是这套
// 结构要消灭的竞态。接管阈值同理必须高于锁等待上限，否则会把还在正常干活的锁夺走。
// 最坏路径：等待 5s + 自己查 3s = 8s，仍在外层 15s 内。
const PEER_PROBE_BUDGET_MS = 3000;
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 8000;

function gitRaw(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * 把路径归一到磁盘上的规范形态。
 *
 * 两个必须解掉的别名：symlink（一方经仓内软链写、另一方走真实路径，字符串不同但落在同一
 * 个 inode），以及大小写——macOS 默认卷大小写不敏感，`Foo.js` 与 `foo.js` 是同一个文件，
 * 而 realpath 返回的是目录项里的真实拼写。不解就会漏拦：两边各登记一个键，谁也撞不上谁。
 *
 * 目标文件可能还不存在（Write 新建），所以逐级上溯到最近一个存在的祖先再拼回来。
 */
function canonical(p) {
  let head = p;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p; // 上溯到根仍失败，原样返回
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * 最近一个存在的祖先目录。Write 可以创建多级新目录，此时 `dirname(target)` 还不存在，
 * 在它上面跑 git 会直接失败、整条 fail-open——于是新建文件永远不参与协调。
 */
function nearestExistingDir(dir) {
  let d = dir;
  for (;;) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch { /* 继续上溯 */ }
    const parent = path.dirname(d);
    if (parent === d) return d;
    d = parent;
  }
}

/**
 * session id 取自环境。`CLAUDE_CODE_SESSION_ID` 是 Claude Code 实际导出的那个（实测），
 * 与 hook payload 里的 `session_id` 同值；`CLAUDE_SESSION_ID` 只作兼容兜底。取错变量的
 * 后果不是报错而是**用户已经授权却仍解不开阻断**——授权写进了一个谁也不会去读的键。
 */
function envSessionId() {
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    if (validSessionId(process.env[k])) return process.env[k];
  }
  return null;
}

/**
 * 取单行结果用。**不要**拿它读 porcelain：`git status --porcelain` 的第一列是有意义的
 * 空格（` M path` = 工作树已改但未 stage），trim 会把它削掉，路径就再也剥不出来。
 * porcelain 走 gitRaw。
 */
function git(cwd, args) {
  return gitRaw(cwd, args).trim();
}

/**
 * 定位登记目录与仓库根。任一步失败都返回 null——调用方据此放行。
 *
 * 非 git 目录、git 不可用、仓库损坏都会落到这里。此时"有没有并发写入者"这个问题无法
 * 回答，而拦掉全部编辑是不成比例的处置：本 gate 防的是并发冲突，不是把不确定性升级成
 * 停摆。放行并在 stderr 说明，比静默拦死更可诊断。
 */
function locate(cwd) {
  let commonDir;
  let top;
  try {
    commonDir = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    top = git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
  if (!commonDir || !top) return null;
  return { registryDir: path.join(commonDir, REGISTRY_DIRNAME), top };
}

/**
 * 找出本 hook 所属 claude 进程的 pid。
 *
 * 记的是 claude 的 pid 而不是 hook 自己的：hook 进程活不过这一次调用，拿它做活性判据
 * 等于条目一写下就是死的。走法与 bg-shell-reclaim-check.js 的祖先查找一致。
 */
function claudePid() {
  let table;
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid=,comm='], {
      encoding: 'utf8',
      maxBuffer: 8 << 20,
      timeout: 5000,
    });
  } catch {
    return null;
  }
  const parent = new Map();
  const comm = new Map();
  for (const line of table.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    parent.set(+m[1], +m[2]);
    comm.set(+m[1], m[3].trim());
  }
  let p = process.pid;
  for (let i = 0; i < PS_ANCESTOR_HOPS && p > 1; i++) {
    if (isAgentRoot(comm.get(p))) return p;
    p = parent.get(p) || 1;
  }
  return null;
}

/**
 * 从活进程自己那里问出它当前的 cwd。
 *
 * 条目里记的 worktree 是**登记那一刻**的路径快照，session 存活期间 repo 被改名 / 移动 /
 * 临时卸载后它就失效了。而此时三种处置都有真实代价：当冲突 → 永久误拦（声明永远无法
 * 证伪）；删条目 → 漏拦（对方进程还活着、WIP 还在）；跳过 → 本次仍漏拦。三难的根源是
 * "信了一个会过期的快照"，而进程的 cwd 是活的、改名后自动跟着走。只在快照失效时才走
 * 这条路（一次 lsof），不进热路径。
 */
function liveCwd(pid) {
  if (!alive(pid)) return null;
  try {
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
    for (const line of out.split('\n')) {
      if (line.startsWith('n') && line.length > 1) return line.slice(1);
    }
  } catch { /* lsof 不可用或进程已退出 */ }
  return null;
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但不属于本用户。存在即算活着，判死会让条目被误删。
    return e && e.code === 'EPERM';
  }
}

/**
 * 进程身份指纹：启动时刻 + 命令名。
 *
 * 光看 pid 还在不在不够——本机实测 pid 已经回绕（观察到 pid 170 的 ppid 是 99992），
 * 所以死 session 的 pid 会被无关进程接手，而它的占用就此**永远**显示为活的：条目不再
 * 被回收，那些文件上的声明也永远无法证伪。指纹一变即判死。
 */
// 本进程内的指纹缓存。hook 进程一次调用即退出，所以缓存不会变陈旧；而没有它时，
// livePeers 会对每个对手方、writeClaim 又对每个目标各跑一次 `ps`——这些调用发生在锁内，
// 累计起来能把持锁时间推过等待者的上限，等待者于是退回无锁写，正好废掉锁要保证的那件事。
const fingerprintCache = new Map();

function pidFingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  if (fingerprintCache.has(pid)) return fingerprintCache.get(pid);
  const v = pidFingerprintUncached(pid);
  fingerprintCache.set(pid, v);
  return v;
}

function pidFingerprintUncached(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 条目所属进程是否仍是**同一个**进程。缺指纹的旧条目按 pid 判（向后兼容，不误删）。 */
function entryAlive(entry) {
  if (!alive(entry && entry.pid)) return false;
  if (!entry.pid_fingerprint) return true;
  const now = pidFingerprint(entry.pid);
  // 取不到指纹（ps 不可用）时不据此判死：误删活写入者的声明会造成漏拦。
  return !now || now === entry.pid_fingerprint;
}

function readEntry(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeEntry(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 该 worktree 里当前有未提交改动的文件（repo 相对路径）。
 *
 * 登记的语义是"我在这个文件上有未提交的改动"，不是"我这辈子碰过它"。已经提交的文件
 * 上不存在会丢失的 WIP，再拦就是纯误拦——而长时间运行的 session 提交完继续待命是常态，
 * 不做这一步会让它无限期占住别人要改的文件。
 */
function dirtySet(worktree) {
  let out;
  try {
    out = gitRaw(worktree, ['status', '--porcelain', '-z']);
  } catch {
    return null; // 问不出来就不据此裁剪，宁可保留声明
  }
  const set = new Set();
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    // porcelain v1: XY<space>path；重命名的 -z 形态会把原路径放在下一条记录，
    // 那条没有状态前缀，按原样收进来即可（它同样是这次改动波及的路径）。
    const p = /^[ MADRCU?!]{2} /.test(rec) ? rec.slice(3) : rec;
    if (p) set.add(p);
  }
  return set;
}

/** 收集其它**活着的**写入者对各文件的占用；顺手删掉死条目。 */
function livePeers(registryDir, selfSessionId) {
  const peers = [];
  let names;
  try {
    names = fs.readdirSync(registryDir);
  } catch {
    return peers;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const sid = name.slice(0, -5);
    if (sid === selfSessionId || !validSessionId(sid)) continue;
    const file = path.join(registryDir, name);
    const entry = readEntry(file);
    if (!entry || !entryAlive(entry)) {
      // 死条目就地回收。靠 SessionEnd 清是靠不住的：崩溃 / 被 kill / 断网时它根本不会跑，
      // 而那正是唯一会留下死条目的场景。
      try { fs.unlinkSync(file); } catch { /* 并发删除，无所谓 */ }
      continue;
    }
    peers.push({ file, entry });
  }
  return peers;
}

function grantFile(registryDir, sessionId) {
  return path.join(registryDir, 'grants', `${sessionId}.json`);
}

function readGrants(registryDir, sessionId) {
  const v = readEntry(grantFile(registryDir, sessionId));
  return new Set(Array.isArray(v && v.paths) ? v.paths : []);
}

function blockMessage(rel, top, conflicts) {
  const absTarget = path.join(top, rel);
  const who = conflicts
    .map((c) => `  · session ${c.entry.session_id} (pid ${c.entry.pid}) @ ${c.entry.worktree}`)
    .join('\n');
  return [
    `BLOCKED: ${rel} 上有另一个写入者的未提交改动。`,
    who,
    '',
    '这不是"文件被锁了"，是两份 WIP 即将混在同一个文件里——一旦混上，按行归属就再也分不开',
    '（git index 存的是整份文件内容而非 delta，任何一方写回都会回退掉对方尚未提交的改动）。',
    '',
    '按 ~/.claude/references/concurrent-plan-isolation.md「执行中提升」条 1：该文件交用户。',
    '请把冲突告知用户并取得处置，然后按用户的决定二选一：',
    // 给绝对路径，不给 repo 相对路径：这条命令常在与目标不同的 cwd 下被照抄执行（跨仓写入
    // 是 CLAUDE.md 明文覆盖的场景），而相对路径会被解析到 cwd 所在的仓，授权静默落错地方。
    `  · 用户确认可以写 → node ~/.claude/hooks/writer-registry-gate.js grant ${JSON.stringify(absTarget)}`,
    '  · 否则改做不碰该文件的部分，或等对方收尾',
    '不要自行判定"应该不冲突"就绕过——agent 自评正是这条防线要挡的那一环。',
  ].join('\n');
}

/**
 * 本次调用会写到的**全部**路径。
 *
 * 返回列表而非单个：MultiEdit 在某些版本里把目标放在 `edits[]` 里，而一次调用可能跨多个
 * 文件。只取第一个就等于其余文件既不检查也不登记——"看起来在管、实际只管一个"比完全
 * 不管更危险，因为它会让人以为已经覆盖。
 */
function targetPaths(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return [];
  const out = new Set();
  const p = toolName === 'NotebookEdit' ? toolInput.notebook_path : toolInput.file_path;
  if (typeof p === 'string' && p) out.add(p);
  if (Array.isArray(toolInput.edits)) {
    for (const e of toolInput.edits) {
      if (e && typeof e.file_path === 'string' && e.file_path) out.add(e.file_path);
    }
  }
  if (toolName === 'apply_patch' && typeof toolInput.command === 'string') {
    for (const line of toolInput.command.split('\n')) {
      const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/);
      if (match && match[1].trim()) out.add(match[1].trim());
    }
  }
  return [...out];
}

/**
 * 排他锁，护住"读条目 → 加一项 → 写回"这段。
 *
 * 没有它时，同一 session 并行发出的两次编辑会各自读到同一份旧条目、各加一个路径、后写的
 * 覆盖先写的——被丢掉的那个文件明明有 WIP 却不在登记里，别人可以长驱直入。`rename` 只
 * 保证不产生半份 JSON，不提供跨进程的读-改-写原子性。
 *
 * mkdir 是 POSIX 上的原子操作，拿它当锁；拿不到就放弃加锁直接写（宁可退回竞态，也不
 * 因为锁本身把编辑卡住）。
 */
function withLock(dir, fn) {
  const lock = path.join(dir, '.lock');
  fs.mkdirSync(dir, { recursive: true });
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      try {
        return fn();
      } finally {
        try { fs.rmdirSync(lock); } catch { /* 已被清理 */ }
      }
    } catch (e) {
      if (e && e.code !== 'EEXIST') break;
      // 持锁者可能已死。锁目录 mtime 超过接管阈值就认定是残留——该阈值高于锁等待上限，
      // 所以夺走的必然是无人持有的锁，而不是还在正常查询的那一个。
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmdirSync(lock);
      } catch { /* 竞争者已清理 */ }
      if (Date.now() > giveUpAt) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  // 等不到锁也要让编辑过去：不因锁本身把编辑卡死。代价是这一次退回竞态，属已知残余。
  return fn();
}

function evaluate(input) {
  const toolName = input && input.tool_name;
  if (!GATED_TOOLS.has(toolName)) return { exitCode: 0 };

  const sessionId = input.session_id;
  if (!validSessionId(sessionId)) return { exitCode: 0 };

  const targets = targetPaths(toolName, input.tool_input);
  if (!targets.length) return { exitCode: 0 };

  // 判定与登记必须在**同一把锁内**完成。
  //
  // 分成两步（先判完再登记，或边判边登记）都会留一个窗口：判定通过、登记还没落时，对方
  // 检查同一文件时看不到我，于是两边都获准。把它们放进同一把锁，窗口就收缩到持锁期内，
  // 而锁本身是原子的。
  //
  // 同一次调用的多个目标一起判、一起登记：任一冲突就整条拦下且**什么都不登记**——一次
  // MultiEdit 是原子的，放它过去等于放过那个有冲突的文件；而给通过的目标留下登记，会让
  // 别人撞上一个"其实没写"的假占用。
  //
  // 对手方查询的预算整轮共享。按目标各给一份，"整轮预算"就名不副实：目标越多总时长越长，
  // 照样能顶穿外层 timeout。
  const deadline = Date.now() + PEER_PROBE_BUDGET_MS;
  const notes = [];

  // 先做不需要锁、也不看对手方的解析（realpath / 定位仓库），顺手按 registry 分组：
  // 跨仓的一次调用（罕见）各自用自己那把锁。
  const groups = new Map();
  for (const abs of targets) {
    const r = resolveTarget(abs);
    if (!r) continue;
    if (!groups.has(r.registryDir)) groups.set(r.registryDir, []);
    groups.get(r.registryDir).push(r);
  }
  if (!groups.size) return { exitCode: 0 };

  // pid 在锁外算好。`ps` 全表可能跑上百毫秒，放在锁内会把持锁时间推到等待者放弃重试
  // 之后——于是等待者退回无锁写，丢更新照旧发生。
  const pid = claudePid();

  for (const [registryDir, items] of groups) {
    let blocked = null;
    try {
      withLock(registryDir, () => {
        for (const item of items) {
          const conflicts = conflictsFor(registryDir, sessionId, item.rel, deadline);
          if (conflicts.length) {
            blocked = { exitCode: 2, stderr: `${blockMessage(item.rel, item.top, conflicts)}\n` };
            return;
          }
        }
        for (const item of items) writeClaim(registryDir, sessionId, item, pid);
      });
    } catch (e) {
      // 登记写不进去只降低对**别人**的保护，不该反过来阻断本次编辑。
      notes.push(`[writer-registry] 登记失败，未记录占用: ${e.message}\n`);
    }
    if (blocked) return blocked;
  }
  return notes.length ? { exitCode: 0, stderr: notes.join('') } : { exitCode: 0 };
}

/** 解析目标路径 → { registryDir, rel, top }；不参与协调的返回 null。 */
function resolveTarget(abs) {
  const resolved = canonical(path.resolve(process.cwd(), abs));

  // 从**目标文件所在目录**定位，而不是从 cwd。cwd 在父仓、目标在 submodule 里时，按 cwd
  // 定位会把路径登记到父仓的 registry，而父仓的 `git status` 只报告 submodule 根目录变脏、
  // 不报告其内部文件——dirty 判据永远落空，冲突全部漏过。嵌套仓有自己的 common-dir，
  // 登记就该落在那里，两边才对得上。
  const loc = locate(nearestExistingDir(path.dirname(resolved)));
  if (!loc) return null;
  const top = canonical(loc.top);

  const rel = path.relative(top, resolved);
  // 仓库外的路径（含 .. 前缀）与 .git 内部路径不参与协调：前者不是这个 repo 的共享面，
  // 后者是本机制自己的存放处，把它纳入会让写登记这一步自我拦截。
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel === '.git' || rel.startsWith(`.git${path.sep}`)) return null;

  return { registryDir: loc.registryDir, rel, top };
}

/** 该文件当前与哪些活写入者冲突。**必须在持锁状态下调用**——判定与登记要在同一把锁内。 */
function conflictsFor(registryDir, sessionId, rel, deadline) {
  const granted = readGrants(registryDir, sessionId);
  if (granted.has(rel)) return [];
  const peers = livePeers(registryDir, sessionId);
  // 本 session 自己声明各文件的时刻，用来判断工作树里的脏是不是自己造成的。见下方 dirty 归属。
  const selfClaimedAt = (readEntry(path.join(registryDir, `${sessionId}.json`)) || {}).claimed_at || {};
  const conflicts = [];
  const dirtyCache = new Map(); // 多个对手方常在同一棵树上，同一棵只问一次
  for (const peer of peers) {
    const claimed = Array.isArray(peer.entry.files) ? peer.entry.files : [];
    if (!claimed.includes(rel)) continue;
    // 逐文件的工作树优先：整条记录上的 `worktree` 只是该 session 最后一次写入的那棵，
    // 对手方跨工作树工作时它并不是这个文件所在的树（旧条目没有 worktrees，回落到它）。
    let wt = (peer.entry.worktrees || {})[rel] || peer.entry.worktree;
    if (!wt || !fs.existsSync(wt)) {
      // 路径快照失效（repo 被改名 / 移动 / 临时卸载）。不猜、也不据此放行——向活进程
      // 问它现在的 cwd，那是改名后仍然正确的唯一来源。恢复本身也要受整轮预算约束：
      // 多个条目同时快照失效时，逐个 lsof + rev-parse 会绕开预算、顶穿外层 timeout。
      if (Date.now() > deadline) {
        conflicts.push(peer); // 预算已用尽，未核实的声明按冲突处理
        continue;
      }
      const live = liveCwd(peer.entry.pid);
      let recovered = null;
      if (live && fs.existsSync(live)) {
        try { recovered = git(live, ['rev-parse', '--show-toplevel']); } catch { /* 不在仓里了 */ }
      }
      if (!recovered) {
        // 连活进程的 cwd 都问不出来（lsof 不可用、进程刚退出、cwd 已不在任何仓内）。
        // 保留条目：删掉会在"仅路径暂时不可达"时造成漏拦，而漏拦真的覆盖别人的改动。
        // 但也不据此拦——否则是无法证伪的死结。这一格是已知的漏拦面，写在协议里。
        continue;
      }
      wt = recovered;
    }
    if (!dirtyCache.has(wt)) {
      if (Date.now() > deadline) {
        conflicts.push(peer);
        continue;
      }
      dirtyCache.set(wt, dirtySet(wt));
    }
    const dirty = dirtyCache.get(wt);
    const at = Date.parse((peer.entry.claimed_at || {})[rel] || '');

    // git 的 dirty 不带归属：两个 session 在**同一棵工作树**上时，本 session 自己的写入
    // 同样让文件变脏，于是"对方仍有未提交改动"这条证据会被自己污染。而且它自我强化——
    // gate 放行的第一笔编辑，正是让此后每一笔编辑都被拦的那笔，所以共树时必发、非偶发。
    //
    // 能锚住的是**第一次**判定：那时本 session 还没写过它，脏只可能来自别人。所以拿
    // "我已持有该文件的声明"当锚。此后该文件的脏不再单独构成对方声明仍然有效的证据。
    // 对方在我之后重新声明的除外：那是新证据，照拦。对方条目没有 claimed_at（旧格式）
    // 时不免疫——分不清先后就不该放宽。
    //
    // 这个锚点比它看起来的弱一格，别把它读成"gate 判过这个文件可写"：走用户 grant 那条
    // 路时 conflictsFor 直接返回空，evaluate 照样写 claim，于是 claim 也可能来自 grant
    // 而非冲突判定。当前它仍然安全，靠的是 grant 一经写入就不撤销也不过期（本文件
    // `grant` 子命令只增不删，registry 里没有任何清理 grants 的路径）——grant 还在，
    // 后续编辑压根走不到这里。**给 grant 加上过期或撤销，就必须同步给这个锚点补一个
    // "该 claim 是否经过冲突判定"的来源标记**，否则会退化成：对方 WIP 仍在、我的 grant
    // 已失效、而我凭一个 grant 留下的 claim 免疫掉了拦截。
    const selfAt = Date.parse(selfClaimedAt[rel] || '');
    const dirtyMayBeMine =
      Number.isFinite(selfAt) && Number.isFinite(at) && at <= selfAt;

    // dirty 问不出来（慢盘、仓库损坏）时保留声明：证据不足不该向"没冲突"倾斜，且用户
    // 授权那条出路仍然可用，不会变成死结。
    if (dirty && (!dirty.has(rel) || dirtyMayBeMine)) {
      // 干净有两种：对方已提交（声明过期，该放行），或对方刚登记、真实写入还没落盘
      // （声明有效，此刻放行两边就会都写）。两者在这一刻长得一模一样，只能靠年龄分：
      // 登记到落盘是毫秒级，而"提交完继续待命"是分钟级以上。归属存疑的脏走同一条判据：
      // 对方若刚声明完，仍按声明有效处理。
      if (!Number.isFinite(at) || Date.now() - at > CLAIM_SETTLE_MS) continue;
    }
    conflicts.push(peer);
  }
  return conflicts;
}

/**
 * 条目里的进程身份：pid 与其指纹必须成对更新。
 *
 * 只换 pid、留着旧指纹，会让下一次 entryAlive 立刻判死自己的活条目；只留旧 pid 不换指纹，
 * 则 pid 复用的防护形同虚设。两者是一个整体，所以由同一个函数产出。
 */
function identity(prev, freshPid) {
  if (prev.pid && entryAlive(prev)) {
    return { pid: prev.pid, pid_fingerprint: prev.pid_fingerprint || pidFingerprint(prev.pid) };
  }
  return { pid: freshPid, pid_fingerprint: pidFingerprint(freshPid) };
}

/** 把一个已通过判定的目标写进自己的条目。**必须在持锁状态下调用。** */
function writeClaim(registryDir, sessionId, { rel, top }, pid) {
  const self = path.join(registryDir, `${sessionId}.json`);
  // 锁内重读：锁外读到的那份可能已被同 session 的另一次并行编辑换掉。
  const prev = readEntry(self) || {};
  const files = new Set(Array.isArray(prev.files) ? prev.files : []);
  files.add(rel);
  const claimedAt = { ...(prev.claimed_at || {}) };
  claimedAt[rel] = new Date().toISOString();
  // 每个文件记下它是在哪棵工作树上被声明的。
  //
  // 整条记录只有一个 `worktree` 字段时，同一 session 先在 W1 改 foo.js、再在同仓库的
  // W2 改 bar.js，第二次写入会把该字段整个覆盖成 W2；此后别人检查 foo.js，对手方的
  // 工作树被读成 W2，于是跑到 W2 上问 `git status`——那里 foo.js 当然是干净的，claim
  // 遂被判为过期而放行。两个 session 就此同时写 W1 的同一个文件，正好是这道闸要防的。
  const worktrees = { ...(prev.worktrees || {}) };
  worktrees[rel] = top;
  writeEntry(self, {
    session_id: sessionId,
    ...identity(prev, pid),
    // 保留：旧条目与展示用；逐文件的权威落在 worktrees 里。
    worktree: top,
    worktrees,
    started_at: prev.started_at || new Date().toISOString(),
    files: [...files].sort(),
    claimed_at: claimedAt,
    // 显式声明的资源占用（`claim` 子命令写入）必须原样带过来。这里每次写入都是整份
    // 覆盖，漏一个字段就等于下一次编辑悄悄撤销了一条还生效的占用声明。
    resources: Array.isArray(prev.resources) ? prev.resources : [],
  });
}

function run(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { exitCode: 0 };
  }
  try {
    return evaluate(input);
  } catch (e) {
    // 本 gate 挂在每一次编辑上。它自己出 bug 时必须让路，否则一个 typo 就能让整台机器
    // 编不了文件，而这远比它要防的并发冲突更严重。
    return { exitCode: 0, stderr: `[writer-registry] gate 内部错误，已放行: ${e.message}\n` };
  }
}

function cli(argv) {
  const [cmd, arg] = argv;
  const loc = locate(process.cwd());
  if (!loc) {
    process.stderr.write('不在 git 仓库内，无需登记。\n');
    return 0;
  }
  if (cmd === 'grant') {
    if (!arg) {
      process.stderr.write('用法: writer-registry-gate.js grant <repo 相对路径>\n');
      return 2;
    }
    const sid = envSessionId();
    if (!sid) {
      process.stderr.write('拿不到 CLAUDE_CODE_SESSION_ID，无法确定授权归属。\n');
      return 2;
    }
    // 授权必须落在**发生拦截的那个 registry**。目标在嵌套仓 / submodule 里时，拦截读的是
    // 那个仓的 registry，而按 cwd 定位会把授权写进父仓——于是用户已经授权、下一次编辑
    // 照样 BLOCKED，且没有任何提示指向原因。用与 evaluate 相同的方式从目标路径定位。
    const target = canonical(path.resolve(process.cwd(), arg));
    const tloc = locate(nearestExistingDir(path.dirname(target))) || loc;
    const rel = path.relative(canonical(tloc.top), target);
    const key = !rel || rel.startsWith('..') || path.isAbsolute(rel) ? arg : rel;
    const file = grantFile(tloc.registryDir, sid);
    // grant 只增不删、不过期，这不只是"还没实现清理"——conflictsFor 的 dirtyMayBeMine
    // 锚点依赖它：grant 放行时照样会写 claim，所以那条锚点分不出 claim 来自冲突判定还是
    // 来自 grant。要给 grant 加过期或撤销，先去那里补来源标记，见其注释。
    withLock(tloc.registryDir, () => {
      const paths = new Set(readGrants(tloc.registryDir, sid));
      paths.add(key);
      writeEntry(file, { session_id: sid, paths: [...paths].sort() });
    });
    // 打印**落点**而不只是键名。相对路径按 cwd 解析，跨仓调用时会静默落进 cwd 所在的仓——
    // 而"落错仓"与"正常放行"此前输出完全相同，用户看到「已放行」却在下一次编辑再次被拦，
    // 没有任何线索指向原因。不拒绝是因为"目标不存在"不具区分力：给尚未创建的文件授权同样
    // 会走到这一步，拿它当失败判据会误伤合法调用。改为把落点摊开，让两者一眼可分。
    process.stdout.write(`已放行: ${key}\n  仓库: ${tloc.top}\n  目标: ${target}\n`);
    if (!fs.existsSync(target)) {
      process.stdout.write(
        '  ⚠ 该路径在上述仓库里不存在。若你要授权的文件属于**另一个仓**，' +
          '这次授权落错了地方——改用绝对路径重跑。（若是尚未创建的文件，可忽略本行。）\n',
      );
    }
    return 0;
  }
  if (cmd === 'claim') {
    // 端口 / 共享 DB / 单点账号这类**无法各自复制**的资源不能结构隔离，只能协调，而协调
    // 要有个共享的落点。文件面能按实际写入自动累积，这类不能——占用的是进程外的东西，
    // 从写入行为里推不出来，只能显式声明。放进同一个条目而不是另起一份登记：两份登记
    // 就会有两份生命周期，而其中一份必然先被忘掉。
    if (!arg) {
      process.stderr.write('用法: writer-registry-gate.js claim <资源描述，如 "port 39011">\n');
      return 2;
    }
    const sid = envSessionId();
    if (!sid) {
      process.stderr.write('拿不到 CLAUDE_CODE_SESSION_ID，无法确定占用归属。\n');
      return 2;
    }
    const self = path.join(loc.registryDir, `${sid}.json`);
    // 与 evaluate 写同一个条目，所以同样要加锁并带全既有字段。这里漏掉 claimed_at 的后果
    // 不是少个字段，而是把所有文件的新鲜期声明一次性抹掉——它们正是登记-写入窗口的唯一
    // 保护，而 claim 与编辑并发是常态（先占端口再改代码）。
    // pid 在锁外算好：`ps` 全表可能跑上百毫秒，锁内跑会把持锁时间推到等待者放弃重试之后。
    const freshPid = claudePid();
    withLock(loc.registryDir, () => {
      const prev = readEntry(self) || {};
      const resources = new Set(Array.isArray(prev.resources) ? prev.resources : []);
      resources.add(arg);
      writeEntry(self, {
        session_id: sid,
        ...identity(prev, freshPid),
        worktree: prev.worktree || canonical(process.cwd()),
        // 整份覆盖写入，漏掉它等于把每个文件的工作树归属一次性抹掉——下一次冲突检查
        // 就会退回到整条记录那个单一 worktree，正是刚修掉的漏判路径。
        worktrees: prev.worktrees || {},
        started_at: prev.started_at || new Date().toISOString(),
        files: Array.isArray(prev.files) ? prev.files : [],
        claimed_at: prev.claimed_at || {},
        resources: [...resources].sort(),
      });
    });
    process.stdout.write(`已登记占用: ${arg}\n`);
    return 0;
  }
  if (cmd === 'list') {
    for (const peer of livePeers(loc.registryDir, '')) {
      process.stdout.write(
        `${peer.entry.session_id} pid=${peer.entry.pid} @ ${peer.entry.worktree}\n` +
          (peer.entry.resources || []).map((r) => `    [占用] ${r}\n`).join('') +
          (peer.entry.files || []).map((f) => `    ${f}\n`).join('')
      );
    }
    return 0;
  }
  process.stderr.write('用法: writer-registry-gate.js {grant <path>|list}\n');
  return 2;
}

module.exports = { run, evaluate, validSessionId, dirtySet, envSessionId, canonical, pidFingerprint, entryAlive, targetPaths };

if (require.main === module) {
  if (process.argv.length > 2) {
    process.exit(cli(process.argv.slice(2)));
  }
  let raw = '';
  process.stdin.on('data', (d) => (raw += d));
  process.stdin.on('end', () => {
    const out = run(raw) || {};
    if (out.stderr) process.stderr.write(out.stderr);
    process.exit(out.exitCode || 0);
  });
}
