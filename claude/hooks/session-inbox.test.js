#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { after, test } = require("node:test");

const HOOK = path.join(__dirname, "session-inbox.js");
const SID = "7fd2618b-77ae-4ef9-8271-d42d3aa0273c";
const SUPERVISOR = "fe70dca0-370c-470a-bdff-b5b66d0f9743";
const TEST_CLAIM_LEASE_MS = 10 * 60 * 1000;
const roots = [];
const repoLocalTempBase = path.join(__dirname, ".session-inbox-test-tmp");
let tempBase;

function selectTempBase() {
  if (tempBase) return tempBase;
  const configured = process.env.SESSION_INBOX_TEST_TMPDIR;
  const candidates = [...new Set([configured, configured ? null : os.tmpdir(), repoLocalTempBase].filter(Boolean))];
  let lastError;
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = fs.mkdtempSync(path.join(candidate, "session-inbox-probe-"));
      fs.rmSync(probe, { recursive: true, force: true });
      tempBase = candidate;
      return tempBase;
    } catch (error) {
      lastError = error;
      if (!error || !["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
    }
  }
  throw lastError;
}

function tempRoot(prefix = "session-inbox-test-") {
  const root = fs.mkdtempSync(path.join(selectTempBase(), prefix));
  roots.push(root);
  return root;
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoLocalTempBase, { recursive: true, force: true });
});

function loadInbox() {
  delete require.cache[require.resolve(HOOK)];
  return require(HOOK);
}

function loadMutant(search, replacement) {
  const source = fs.readFileSync(HOOK, "utf8");
  assert.ok(source.includes(search), `mutation anchor missing: ${search}`);
  const mutant = new Module(`${HOOK}.mutant-${Math.random()}`, module);
  mutant.filename = `${HOOK}.mutant.js`;
  mutant.paths = module.paths;
  mutant._compile(source.replace(search, replacement), mutant.filename);
  return mutant.exports;
}

function record(id, body, overrides = {}) {
  return {
    id,
    from: `supervisor:${SUPERVISOR}`,
    ts: "2026-08-23T00:00:00.000Z",
    body,
    evidence: ["fixture evidence"],
    has_user_decidable_spots: false,
    ...overrides,
  };
}

test("decision 10 renders the section-6 draft and its section-5 review basis distinctly", () => {
  const api = loadInbox();
  const home = tempRoot();
  enqueue(api, home, record("decision-10", "Use 【recommended default】 now.", {
    evidence: ["Section 5 says why intervention is warranted now."],
    has_user_decidable_spots: true,
  }));
  const result = runHook(home, payload(home, { last_assistant_message: "decision 10 render" }));
  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /instruction draft \(§6\):/);
  assert.match(result.stderr, /review basis \(§5\):/);
  assert.match(result.stderr, /contains `【】` user-decidable spots/);
});

function payload(home, overrides = {}) {
  return {
    hook_event_name: "Stop",
    session_id: SID,
    transcript_path: path.join(home, "transcript.jsonl"),
    last_assistant_message: "ordinary stop",
    stop_hook_active: false,
    ...overrides,
  };
}

function runHook(home, input, options = {}) {
  return spawnSync(process.execPath, [options.hook || HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...(options.env || {}) },
    timeout: 10000,
  });
}

function runHookAsync(home, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.hook || HOOK], {
      env: { ...process.env, HOME: home, ...(options.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function enqueue(api, home, message, onNotify = () => 0) {
  return api.enqueueMessage({ homeDir: home, sessionId: SID, record: message, notify: onNotify });
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
}

function pathEntryExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function writeQueue(home, lines) {
  const file = path.join(home, ".claude", "state", "session-inbox", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return file;
}

function writeQueueFragment(home, fragment) {
  const file = path.join(home, ".claude", "state", "session-inbox", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fragment, { mode: 0o600 });
  return file;
}

function writeLock(home, owner) {
  const lock = path.join(home, ".claude", "state", "session-inbox", ".locks", `${SID}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const target = owner === null
    ? "not-json"
    : JSON.stringify({
        owner_pid: owner.pid,
        owner_token: owner.token,
        claimed_at: owner.acquired_at,
        deadline_at: new Date(Date.parse(owner.acquired_at) + TEST_CLAIM_LEASE_MS).toISOString(),
      });
  fs.symlinkSync(target, lock);
  return lock;
}

function copyMutatedHook(search, replacement) {
  const root = tempRoot("session-inbox-mutant-");
  const hooks = path.join(root, "hooks");
  fs.mkdirSync(path.join(hooks, "lib"), { recursive: true });
  const source = fs.readFileSync(HOOK, "utf8");
  assert.ok(source.includes(search), `mutation anchor missing: ${search}`);
  fs.writeFileSync(path.join(hooks, "session-inbox.js"), source.replace(search, replacement));
  fs.copyFileSync(path.join(__dirname, "lib", "transcript.js"), path.join(hooks, "lib", "transcript.js"));
  fs.copyFileSync(path.join(__dirname, "lib", "session-id.js"), path.join(hooks, "lib", "session-id.js"));
  return path.join(hooks, "session-inbox.js");
}

function makeReadBarrier(ackPath) {
  const root = tempRoot("session-inbox-barrier-");
  const preload = path.join(root, "preload.js");
  fs.writeFileSync(
    preload,
    `"use strict";
const fs = require("fs");
const path = require("path");
const original = fs.readFileSync;
const ack = path.resolve(process.env.SESSION_INBOX_BARRIER_ACK);
const barrier = process.env.SESSION_INBOX_BARRIER_DIR;
fs.readFileSync = function patched(file, ...args) {
  const value = original.call(this, file, ...args);
  if (path.resolve(String(file)) === ack) {
    fs.writeFileSync(path.join(barrier, String(process.pid)), "ready");
    const deadline = Date.now() + 5000;
    while (fs.readdirSync(barrier).length < 2 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (fs.readdirSync(barrier).length < 2) throw new Error("barrier timeout");
  }
  return value;
};
`,
  );
  const barrier = path.join(root, "ready");
  fs.mkdirSync(barrier);
  return {
    NODE_OPTIONS: `--require=${preload}`,
    SESSION_INBOX_BARRIER_ACK: ackPath,
    SESSION_INBOX_BARRIER_DIR: barrier,
  };
}

function makeAckVersionSwapPreload(ackPath) {
  const root = tempRoot("session-inbox-version-swap-");
  const preload = path.join(root, "preload.js");
  fs.writeFileSync(
    preload,
    `"use strict";
const fs = require("fs");
const ack = process.env.SESSION_INBOX_SWAP_ACK;
const original = process.stderr.write;
let swapped = false;
process.stderr.write = function patched(chunk, ...args) {
  const callbackIndex = args.findIndex((entry) => typeof entry === "function");
  if (!swapped && callbackIndex >= 0) {
    const callback = args[callbackIndex];
    args[callbackIndex] = function afterWrite(...callbackArgs) {
      fs.writeFileSync(ack, JSON.stringify({ version: 2, acked: {}, pending: {}, v2_cursor: "keep" }) + "\\n");
      swapped = true;
      return callback(...callbackArgs);
    };
  }
  return original.call(this, chunk, ...args);
};
`,
  );
  return {
    NODE_OPTIONS: `--require=${preload}`,
    SESSION_INBOX_SWAP_ACK: ackPath,
  };
}

function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function poll() {
      if (fs.existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 10);
    }
    poll();
  });
}

function makePublicationBarrier(kind) {
  const root = tempRoot(`session-inbox-${kind}-barrier-`);
  const signal = path.join(root, "published");
  const release = path.join(root, "release");
  const preload = path.join(root, "preload.js");
  const patch = kind === "lock-claim"
    ? `const original = fs.symlinkSync;
fs.symlinkSync = function patched(target, file, ...args) {
  const value = original.call(this, target, file, ...args);
  if (String(file).endsWith(".lock")) pause();
  return value;
};`
    : `const original = process.stderr.write.bind(process.stderr);
process.stderr.write = function patched(...args) {
  pause();
  return original(...args);
};`;
  fs.writeFileSync(
    preload,
    `"use strict";
const fs = require("fs");
const path = require("path");
const signal = process.env.SESSION_INBOX_PUBLICATION_SIGNAL;
const release = process.env.SESSION_INBOX_PUBLICATION_RELEASE;
function pause() {
  fs.writeFileSync(signal, String(process.pid));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(release) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  if (!fs.existsSync(release)) throw new Error("publication barrier timeout");
}
${patch}
`,
  );
  return {
    signal,
    release,
    env: {
      NODE_OPTIONS: `--require=${preload}`,
      SESSION_INBOX_PUBLICATION_SIGNAL: signal,
      SESSION_INBOX_PUBLICATION_RELEASE: release,
    },
  };
}

function spawnEnqueue(home, message, env = {}) {
  const script =
    `const api = require(${JSON.stringify(HOOK)});` +
    `const result = api.enqueueMessage({homeDir: process.env.HOME, sessionId: ${JSON.stringify(SID)}, record: ${JSON.stringify(message)}});` +
    "process.stdout.write(JSON.stringify(result));";
  const child = spawn(process.execPath, ["-e", script], {
    env: { ...process.env, HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

test("S1 prefers the system temp root and ignores repo-local fallback residue", (t) => {
  const repo = path.join(__dirname, "..", "..");
  if (!fs.existsSync(path.join(repo, ".git"))) {
    t.skip("gitignore coverage requires repository metadata; git archive exports intentionally have none");
    return;
  }
  const repositoryProbe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.ifError(repositoryProbe.error);
  assert.strictEqual(repositoryProbe.status, 0, repositoryProbe.stderr);
  assert.strictEqual(repositoryProbe.stdout.trim(), "true");
  const selected = selectTempBase();
  const selectedKind = selected === os.tmpdir()
    ? "os.tmpdir"
    : selected === repoLocalTempBase
      ? "repo-local"
      : "configured";
  t.diagnostic(`S1_TEMP_BASE selected=${selectedKind}`);
  const residue = path.join(__dirname, ".session-inbox-test-tmp", "leftover", "queue.jsonl");
  fs.mkdirSync(path.dirname(residue), { recursive: true });
  fs.writeFileSync(residue, "test residue\n");
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", residue], {
    cwd: repo,
  });
  assert.strictEqual(ignored.status, 0, "repo-local fallback residue must not enter git status");
});

test("N1 lock ownership is complete at the first observable claim", async (t) => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-n1-window-");
  const barrier = makePublicationBarrier("lock-claim");
  const first = spawnEnqueue(home, record("n1-first", "first writer"), barrier.env);
  let firstResult;
  let killed = false;
  try {
    await waitForFile(barrier.signal);
    assert.ok(fs.lstatSync(api.pathsFor(home, SID).lock).isSymbolicLink());
    const claim = JSON.parse(fs.readlinkSync(api.pathsFor(home, SID).lock, "utf8"));
    assert.strictEqual(claim.owner_pid, first.child.pid);
    assert.ok(claim.owner_token);
    assert.ok(Date.parse(claim.deadline_at) > Date.parse(claim.claimed_at));
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = enqueue(api, home, record("n1-second", "second writer"));
    t.diagnostic(`N1_PUBLICATION_WINDOW second_status=${second.status}`);
    assert.strictEqual(second.status, "error", "a complete live claim must not be stolen");
    first.child.kill("SIGKILL");
    firstResult = await first.done;
    killed = true;
    assert.strictEqual(firstResult.signal, "SIGKILL");
    const recovered = enqueue(api, home, record("n1-after-death", "after owner death"));
    assert.strictEqual(recovered.status, "enqueued");
  } finally {
    if (!killed) {
      fs.writeFileSync(barrier.release, "release");
      firstResult = await first.done;
    }
  }
});

test("N2 a process killed before stderr publication cannot strand delivery", async (t) => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-n2-window-");
  enqueue(api, home, record("n2-message", "visible after publisher death"));
  const barrier = makePublicationBarrier("stderr");
  const first = spawn(process.execPath, [HOOK], {
    env: { ...process.env, HOME: home, ...barrier.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  first.stdin.end(JSON.stringify(payload(home, { last_assistant_message: "N2 first" })));
  await waitForFile(barrier.signal);
  const pending = JSON.parse(fs.readFileSync(api.pathsFor(home, SID).ack, "utf8"));
  assert.ok(pending.pending["n2-message"].delivery_key);
  assert.strictEqual(pending.pending["n2-message"].delivery_phase, "publishing");
  first.kill("SIGKILL");
  await new Promise((resolve, reject) => {
    first.on("error", reject);
    first.on("close", resolve);
  });

  const recovered = runHook(home, payload(home, { last_assistant_message: "N2 recovered" }));
  t.diagnostic(`N2_PUBLICATION_WINDOW status=${recovered.status} visible=${/visible after publisher death/.test(recovered.stderr)}`);
  assert.strictEqual(recovered.status, 2, recovered.stderr);
  assert.match(recovered.stderr, /visible after publisher death/);
});

test("I1 transport-id consumption is idempotent without semantic deduplication", () => {
  const api = loadInbox();
  const home = tempRoot();
  let notifyCount = 0;
  const notify = () => {
    notifyCount += 1;
    return 0;
  };

  assert.strictEqual(enqueue(api, home, record("same-1", "identical body"), notify).status, "enqueued");
  assert.strictEqual(enqueue(api, home, record("same-2", "identical body"), notify).status, "enqueued");
  assert.strictEqual(notifyCount, 2, "different ids with identical bodies must both notify");
  assert.strictEqual(
    enqueue(api, home, record("same-1", "identical body"), notify).status,
    "duplicate",
    "retrying the exact enqueue must reuse its id without appending again",
  );
  assert.strictEqual(notifyCount, 2, "an exact transport retry must not duplicate notification");

  const first = runHook(home, payload(home, { last_assistant_message: "I1 first stop" }));
  assert.strictEqual(first.status, 2, first.stderr);
  assert.match(first.stderr, /same-1/);
  assert.match(first.stderr, /same-2/);
  assert.strictEqual((first.stderr.match(/identical body/g) || []).length, 2);
  assert.match(first.stderr, /未受信/);
  assert.match(first.stderr, /不是用户指令/);
  assert.match(first.stderr, /不证明 provenance/);
  assert.match(first.stderr, /review basis \(§5\):\n- fixture evidence/);

  const evidenceDropping = loadMutant(
    "return { id, from, ts, body, evidence: [...evidence], has_user_decidable_spots: hasUserDecidableSpots };",
    "return { id, from, ts, body, evidence: [], has_user_decidable_spots: hasUserDecidableSpots };",
  );
  const evidenceHome = tempRoot("session-inbox-evidence-mutant-");
  enqueue(evidenceDropping, evidenceHome, record("evidence-mutant", "body with evidence"));
  const evidenceLost = evidenceDropping.handleStop(payload(evidenceHome), evidenceHome);
  assert.throws(() => assert.match(evidenceLost.stderr, /fixture evidence/));

  const ack = runHook(
    home,
    payload(home, {
      stop_hook_active: true,
      last_assistant_message: "INBOX-OK: same-1 same-2",
    }),
  );
  assert.strictEqual(ack.status, 0, ack.stderr);
  assert.strictEqual(fs.statSync(api.pathsFor(home, SID).ack).mode & 0o777, 0o600);
  const afterAck = runHook(home, payload(home, { last_assistant_message: "I1 after ack" }));
  assert.strictEqual(afterAck.status, 0, afterAck.stderr);

  const queue = api.pathsFor(home, SID).queue;
  assert.strictEqual(readLines(queue).length, 2, "ack must not delete the append-only queue");
});

test("I1 rejects an id collision before append or notification, and its mutation control is red", () => {
  const home = tempRoot();
  const first = record("collision-id", "first body");
  const second = record("collision-id", "different body");

  function exercise(api, isolatedHome) {
    let notifications = 0;
    const notify = () => {
      notifications += 1;
      return 0;
    };
    assert.strictEqual(enqueue(api, isolatedHome, first, notify).status, "enqueued");
    assert.strictEqual(enqueue(api, isolatedHome, second, notify).status, "collision");
    assert.strictEqual(readLines(api.pathsFor(isolatedHome, SID).queue).length, 1);
    assert.strictEqual(notifications, 1);
  }

  exercise(loadInbox(), home);

  const mutant = loadMutant(
    "if (existing && !sameRecord(existing, record)) {",
    "if (false && existing && !sameRecord(existing, record)) {",
  );
  const mutantHome = tempRoot();
  assert.throws(
    () => exercise(mutant, mutantHome),
    /Expected values to be strictly equal/,
    "disabling the collision guard must make the collision assertions fail",
  );

  const evidenceHome = tempRoot("session-inbox-evidence-collision-");
  const evidenceFirst = record("evidence-collision", "same body", { evidence: ["first basis"] });
  const evidenceChanged = record("evidence-collision", "same body", { evidence: ["changed basis"] });
  assert.strictEqual(enqueue(loadInbox(), evidenceHome, evidenceFirst).status, "enqueued");
  assert.strictEqual(enqueue(loadInbox(), evidenceHome, evidenceChanged).status, "collision");

  const decisionHome = tempRoot("session-inbox-decision-collision-");
  const decisionFirst = record("decision-collision", "same body", { has_user_decidable_spots: false });
  const decisionChanged = record("decision-collision", "same body", { has_user_decidable_spots: true });
  assert.strictEqual(enqueue(loadInbox(), decisionHome, decisionFirst).status, "enqueued");
  assert.strictEqual(enqueue(loadInbox(), decisionHome, decisionChanged).status, "collision");
});

test("I2 fails open for isolated-root faults while a valid record proves the hook can block", () => {
  const api = loadInbox();

  const missingHome = tempRoot();
  const missing = runHook(missingHome, payload(missingHome));
  assert.strictEqual(missing.status, 0, missing.stderr);

  const badOnlyHome = tempRoot();
  writeQueue(badOnlyHome, ["not-json"]);
  const badOnly = runHook(badOnlyHome, payload(badOnlyHome));
  assert.strictEqual(badOnly.status, 0, badOnly.stderr);

  const unreadableHome = tempRoot();
  const unreadableQueue = writeQueue(unreadableHome, [JSON.stringify(record("unreadable", "must not block"))]);
  fs.chmodSync(unreadableQueue, 0o000);
  assert.strictEqual(fs.statSync(unreadableQueue).mode & 0o777, 0, "fault injection must remove read permission");
  const unreadable = runHook(unreadableHome, payload(unreadableHome));
  fs.chmodSync(unreadableQueue, 0o600);
  assert.strictEqual(unreadable.status, 0, unreadable.stderr);

  const damagedStateHome = tempRoot();
  enqueue(api, damagedStateHome, record("state-damage", "must fail open"));
  const damagedPaths = api.pathsFor(damagedStateHome, SID);
  fs.mkdirSync(path.dirname(damagedPaths.ack), { recursive: true });
  fs.writeFileSync(damagedPaths.ack, "not-json", { mode: 0o600 });
  const damagedState = runHook(damagedStateHome, payload(damagedStateHome));
  assert.strictEqual(damagedState.status, 0, damagedState.stderr);

  const mixedHome = tempRoot();
  writeQueue(mixedHome, ["not-json", JSON.stringify(record("mixed-valid", "valid record survives"))]);
  const mixed = runHook(mixedHome, payload(mixedHome, { last_assistant_message: "mixed stop" }));
  assert.strictEqual(mixed.status, 2, mixed.stderr);
  assert.match(mixed.stderr, /valid record survives/);

  const positiveHome = tempRoot();
  enqueue(api, positiveHome, record("positive", "positive control blocks"));
  const positive = runHook(positiveHome, payload(positiveHome, { last_assistant_message: "positive stop" }));
  assert.strictEqual(positive.status, 2, positive.stderr);
  assert.match(positive.stderr, /positive control blocks/);
});

test("I2 isolates invalid schema, direct queue collisions, notifier failure, and transcript fallback", () => {
  const api = loadInbox();
  const home = tempRoot();
  const invalidCases = [
    { sessionId: "../../escape", record: record("valid", "body") },
    { sessionId: SID, record: record("bad id", "body") },
    { sessionId: SID, record: record("valid", "body", { from: "trusted-looking" }) },
    { sessionId: SID, record: record("valid", "body", { ts: "not-a-time" }) },
    { sessionId: SID, record: record("valid", "") },
    { sessionId: SID, record: record("valid", "body", { evidence: "not-an-array" }) },
    { sessionId: SID, record: record("valid", "body", { evidence: [""] }) },
    { sessionId: SID, record: record("valid", "body", { has_user_decidable_spots: "false" }) },
  ];
  for (const entry of invalidCases) {
    assert.strictEqual(
      api.enqueueMessage({ homeDir: home, ...entry }).status,
      "invalid",
      JSON.stringify(entry),
    );
  }
  assert.ok(!fs.existsSync(path.join(home, ".claude")), "invalid records must not create runtime state");

  const withoutNotify = api.enqueueMessage({
    homeDir: home,
    sessionId: SID,
    record: record("no-notify", "queued without notifier"),
  });
  assert.strictEqual(withoutNotify.status, "enqueued");
  assert.strictEqual(withoutNotify.notified, null);
  const notifyFailure = enqueue(api, home, record("notify-failure", "notifier throws"), () => {
    throw new Error("injected notifier failure");
  });
  assert.strictEqual(notifyFailure.status, "enqueued");
  assert.strictEqual(notifyFailure.notified, false);

  const collisionHome = tempRoot();
  writeQueue(collisionHome, [
    JSON.stringify(record("direct-collision", "first")),
    JSON.stringify(record("direct-collision", "second")),
    JSON.stringify(record("direct-good", "later valid line")),
  ]);
  const collision = runHook(
    collisionHome,
    payload(collisionHome, { last_assistant_message: "direct collision stop" }),
  );
  assert.strictEqual(collision.status, 2, collision.stderr);
  assert.doesNotMatch(collision.stderr, /direct-collision/);
  assert.match(collision.stderr, /later valid line/);

  const traversal = runHook(home, payload(home, { session_id: "../../escape" }));
  assert.strictEqual(traversal.status, 0, traversal.stderr);
  const malformedInput = spawnSync(process.execPath, [HOOK], {
    input: "not-json",
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.strictEqual(malformedInput.status, 0, malformedInput.stderr);

  const fallbackHome = tempRoot();
  enqueue(api, fallbackHome, record("fallback-id", "fallback transcript ack"));
  const first = runHook(fallbackHome, payload(fallbackHome, { last_assistant_message: "fallback first" }));
  assert.strictEqual(first.status, 2, first.stderr);
  const transcript = path.join(fallbackHome, "transcript.jsonl");
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "INBOX-OK: fallback-id" }] } })}\n`,
  );
  const fallbackAck = runHook(
    fallbackHome,
    payload(fallbackHome, { stop_hook_active: true, last_assistant_message: undefined, transcript_path: transcript }),
  );
  assert.strictEqual(fallbackAck.status, 0, fallbackAck.stderr);
  const consumed = runHook(fallbackHome, payload(fallbackHome, { last_assistant_message: "fallback consumed" }));
  assert.strictEqual(consumed.status, 0, consumed.stderr);
});

test("queue read-back rejects invalid inputs and requires an exact non-collided record", () => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-inspect-");
  const expected = record("inspect-id", "expected body");
  assert.strictEqual(enqueue(api, home, expected).status, "enqueued");
  assert.strictEqual(api.inspectQueueRecords({ homeDir: home, sessionId: SID, records: [expected] }), 1);
  assert.strictEqual(api.inspectQueueRecords({ homeDir: home, sessionId: SID, records: null }), 0);
  assert.strictEqual(api.inspectQueueRecords({ homeDir: home, sessionId: "../../escape", records: [expected] }), 0);
  assert.strictEqual(api.inspectQueueRecords({ homeDir: home, sessionId: SID, records: [{ ...expected, evidence: "bad" }] }), 0);
  assert.strictEqual(api.inspectQueueRecords({
    homeDir: home,
    sessionId: SID,
    records: [{ ...expected, body: "different body" }],
  }), 0);

  const collidedHome = tempRoot("session-inbox-inspect-collision-");
  writeQueue(collidedHome, [
    JSON.stringify(record("inspect-collision", "first")),
    JSON.stringify(record("inspect-collision", "second")),
  ]);
  assert.strictEqual(api.inspectQueueRecords({
    homeDir: collidedHome,
    sessionId: SID,
    records: [record("inspect-collision", "first")],
  }), 0);
});

test("F1 reclaims abandoned or expired locks without stealing a live owner's lock", async (t) => {
  const staleHome = tempRoot("session-inbox-stale-lock-");
  writeQueue(staleHome, [JSON.stringify(record("stale-lock-id", "stale lock must recover"))]);
  const staleLock = writeLock(staleHome, {
    pid: 99999999,
    token: "dead-owner",
    acquired_at: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.ok(pathEntryExists(staleLock));
  assert.throws(() => process.kill(99999999, 0), (error) => error && error.code === "ESRCH");
  const recovered = runHook(staleHome, payload(staleHome, { last_assistant_message: "F1 stale" }));
  t.diagnostic(`F1_STALE_LOCK status=${recovered.status} lock_exists=${pathEntryExists(staleLock)}`);
  assert.strictEqual(recovered.status, 2, recovered.stderr);
  assert.match(recovered.stderr, /stale lock must recover/);

  const malformedHome = tempRoot("session-inbox-malformed-lock-");
  writeQueue(malformedHome, [JSON.stringify(record("malformed-id", "malformed lock must recover"))]);
  const malformedLock = writeLock(malformedHome, null);
  assert.ok(pathEntryExists(malformedLock));
  const malformedRecovered = runHook(
    malformedHome,
    payload(malformedHome, { last_assistant_message: "F1 malformed" }),
  );
  assert.strictEqual(malformedRecovered.status, 2, malformedRecovered.stderr);
  assert.match(malformedRecovered.stderr, /malformed lock must recover/);

  const expiredHome = tempRoot("session-inbox-expired-live-pid-lock-");
  writeQueue(expiredHome, [JSON.stringify(record("expired-live-id", "expired live-pid lock must recover"))]);
  writeLock(expiredHome, {
    pid: process.pid,
    token: "expired-live-owner",
    acquired_at: new Date(Date.now() - TEST_CLAIM_LEASE_MS - 60_000).toISOString(),
  });
  const expiredRecovered = runHook(
    expiredHome,
    payload(expiredHome, { last_assistant_message: "F1 expired live pid" }),
  );
  assert.strictEqual(expiredRecovered.status, 2, expiredRecovered.stderr);
  assert.match(expiredRecovered.stderr, /expired live-pid lock must recover/);

  const liveHome = tempRoot("session-inbox-live-lock-");
  writeQueue(liveHome, [JSON.stringify(record("live-lock-id", "must stay behind live lock"))]);
  const liveLock = writeLock(liveHome, {
    pid: process.pid,
    token: "live-owner",
    acquired_at: new Date().toISOString(),
  });
  const blocked = runHook(liveHome, payload(liveHome, { last_assistant_message: "F1 live" }));
  t.diagnostic(`F1_LIVE_LOCK status=${blocked.status} lock_exists=${pathEntryExists(liveLock)}`);
  t.diagnostic(`S2_LOCK_DIAGNOSTIC stderr=${JSON.stringify(blocked.stderr)}`);
  assert.strictEqual(blocked.status, 0, blocked.stderr);
  assert.ok(pathEntryExists(liveLock), "a live owner's lock must not be reclaimed");
  assert.match(blocked.stderr, /Fail-open: inbox records were not inspected \(ELOCKED\)/);
  assert.match(blocked.stderr, /maximum claim lease 10 minutes/);
  assert.doesNotMatch(blocked.stderr, /must stay behind live lock/);
});

test("F2 flushes a large rendered batch before exit", async (t) => {
  const api = loadInbox();
  const smallHome = tempRoot("session-inbox-small-write-");
  enqueue(api, smallHome, record("small-id", "small tail marker"));
  const small = await runHookAsync(smallHome, payload(smallHome, { last_assistant_message: "F2 small" }));
  assert.strictEqual(small.status, 2, small.stderr);
  assert.match(small.stderr, /small tail marker/);
  assert.match(small.stderr, /INBOX-OK: small-id/);
  const published = JSON.parse(fs.readFileSync(api.pathsFor(smallHome, SID).ack, "utf8"));
  assert.strictEqual(published.pending["small-id"].delivery_phase, "published");

  const largeHome = tempRoot("session-inbox-large-write-");
  const largeBody = `${"x".repeat(1024 * 1024)}F2-LARGE-TAIL`;
  assert.ok(Buffer.byteLength(largeBody) > 1024 * 1024);
  enqueue(api, largeHome, record("large-id", largeBody));
  enqueue(api, largeHome, record("after-large-id", "F2-AFTER-LARGE"));
  const large = await runHookAsync(largeHome, payload(largeHome, { last_assistant_message: "F2 large" }));
  t.diagnostic(
    `F2_LARGE_WRITE requested_body_bytes=${Buffer.byteLength(largeBody)} received_stderr_bytes=${Buffer.byteLength(large.stderr)}`,
  );
  assert.strictEqual(large.status, 2, large.stderr.slice(-4096));
  assert.match(large.stderr, /F2-LARGE-TAIL/);
  assert.match(large.stderr, /F2-AFTER-LARGE/);
  assert.match(large.stderr, /INBOX-OK: large-id after-large-id/);
});

test("publication refuses an ack state that evolves after stderr delivery", () => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-publication-version-race-");
  enqueue(api, home, record("publication-version-race", "delivery remains visible"));
  const ackPath = api.pathsFor(home, SID).ack;
  const result = runHook(
    home,
    payload(home, { last_assistant_message: "publication version race" }),
    { env: makeAckVersionSwapPreload(ackPath) },
  );
  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /delivery remains visible/);
  assert.doesNotMatch(result.stderr, /published state was not recorded/);
  const evolved = JSON.parse(fs.readFileSync(ackPath, "utf8"));
  assert.strictEqual(evolved.version, 2);
  assert.strictEqual(evolved.v2_cursor, "keep");
});

test("F3 terminates a partial tail before appending the next record", (t) => {
  const api = loadInbox();
  const brokenHome = tempRoot("session-inbox-partial-tail-");
  const queue = writeQueueFragment(brokenHome, '{"id":"interrupted"');
  const before = fs.readFileSync(queue);
  assert.notStrictEqual(before[before.length - 1], 0x0a, "fault injection must leave a newline-free tail");
  let notifications = 0;
  const appended = enqueue(api, brokenHome, record("after-partial", "valid after partial"), () => {
    notifications += 1;
    return 0;
  });
  assert.strictEqual(appended.status, "enqueued");
  assert.strictEqual(notifications, 1);
  const delivered = runHook(brokenHome, payload(brokenHome, { last_assistant_message: "F3 broken" }));
  t.diagnostic(`F3_PARTIAL_TAIL status=${delivered.status} valid_visible=${/valid after partial/.test(delivered.stderr)}`);
  assert.strictEqual(delivered.status, 2, delivered.stderr);
  assert.match(delivered.stderr, /valid after partial/);

  const delimitedHome = tempRoot("session-inbox-delimited-tail-");
  writeQueue(delimitedHome, ["not-json"]);
  enqueue(api, delimitedHome, record("after-delimited", "valid after delimited bad line"));
  const control = runHook(delimitedHome, payload(delimitedHome, { last_assistant_message: "F3 control" }));
  assert.strictEqual(control.status, 2, control.stderr);
  assert.match(control.stderr, /valid after delimited bad line/);
});

test("F4 quarantines corrupt ack state so the next Stop can recover", (t) => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-corrupt-ack-");
  enqueue(api, home, record("recover-ack-id", "visible after ack recovery"));
  const paths = api.pathsFor(home, SID);
  fs.mkdirSync(path.dirname(paths.ack), { recursive: true });
  fs.writeFileSync(paths.ack, "not-json", { mode: 0o600 });
  assert.strictEqual(fs.readFileSync(paths.ack, "utf8"), "not-json");

  const first = runHook(home, payload(home, { last_assistant_message: "F4 quarantine" }));
  const quarantined = fs
    .readdirSync(path.dirname(paths.ack))
    .filter((name) => name.startsWith(`${path.basename(paths.ack)}.corrupt.`));
  t.diagnostic(
    `F4_CORRUPT_ACK first_status=${first.status} quarantine_count=${quarantined.length} stderr=${JSON.stringify(first.stderr)}`,
  );
  assert.strictEqual(first.status, 0, first.stderr);
  assert.match(first.stderr, /moved to .*\.corrupt\./);
  assert.match(first.stderr, /acknowledgement history could not be trusted/);
  assert.strictEqual(quarantined.length, 1);
  assert.ok(!fs.existsSync(paths.ack));

  const recovered = runHook(home, payload(home, { last_assistant_message: "F4 recovered" }));
  assert.strictEqual(recovered.status, 2, recovered.stderr);
  assert.match(recovered.stderr, /visible after ack recovery/);

  const invalidEntryHome = tempRoot("session-inbox-invalid-ack-entry-");
  enqueue(api, invalidEntryHome, record("invalid-entry-id", "visible after entry recovery"));
  const invalidEntryPaths = api.pathsFor(invalidEntryHome, SID);
  fs.mkdirSync(path.dirname(invalidEntryPaths.ack), { recursive: true });
  fs.writeFileSync(
    invalidEntryPaths.ack,
    `${JSON.stringify({ version: 1, acked: { "invalid-entry-id": "not-a-time" }, pending: {} })}\n`,
    { mode: 0o600 },
  );
  const invalidFirst = runHook(
    invalidEntryHome,
    payload(invalidEntryHome, { last_assistant_message: "F4 invalid entry" }),
  );
  const invalidQuarantine = fs
    .readdirSync(path.dirname(invalidEntryPaths.ack))
    .filter((name) => name.startsWith(`${path.basename(invalidEntryPaths.ack)}.corrupt.`));
  t.diagnostic(
    `F4_INVALID_ACK_ENTRY first_status=${invalidFirst.status} quarantine_count=${invalidQuarantine.length}`,
  );
  assert.strictEqual(invalidFirst.status, 0, invalidFirst.stderr);
  assert.strictEqual(invalidQuarantine.length, 1);
  const invalidRecovered = runHook(
    invalidEntryHome,
    payload(invalidEntryHome, { last_assistant_message: "F4 invalid entry recovered" }),
  );
  assert.strictEqual(invalidRecovered.status, 2, invalidRecovered.stderr);
  assert.match(invalidRecovered.stderr, /visible after entry recovery/);

  const oversizedLeaseHome = tempRoot("session-inbox-oversized-lease-");
  enqueue(api, oversizedLeaseHome, record("oversized-lease-id", "visible after lease recovery"));
  const oversizedLeasePaths = api.pathsFor(oversizedLeaseHome, SID);
  const claimedAt = Date.now();
  fs.mkdirSync(path.dirname(oversizedLeasePaths.ack), { recursive: true });
  fs.writeFileSync(
    oversizedLeasePaths.ack,
    `${JSON.stringify({
      version: 1,
      acked: {},
      pending: {
        "oversized-lease-id": {
          delivery_key: "oversized-token",
          delivery_phase: "published",
          delivered_at: new Date(claimedAt).toISOString(),
          owner_pid: process.pid,
          owner_token: "oversized-token",
          claimed_at: new Date(claimedAt).toISOString(),
          deadline_at: new Date(claimedAt + TEST_CLAIM_LEASE_MS + 60_000).toISOString(),
        },
      },
    })}\n`,
    { mode: 0o600 },
  );
  const oversizedFirst = runHook(
    oversizedLeaseHome,
    payload(oversizedLeaseHome, { last_assistant_message: "F4 oversized lease" }),
  );
  assert.strictEqual(oversizedFirst.status, 0, oversizedFirst.stderr);
  assert.match(oversizedFirst.stderr, /Invalid acknowledgement state was moved/);
  const oversizedRecovered = runHook(
    oversizedLeaseHome,
    payload(oversizedLeaseHome, { last_assistant_message: "F4 oversized lease recovered" }),
  );
  assert.strictEqual(oversizedRecovered.status, 2, oversizedRecovered.stderr);
  assert.match(oversizedRecovered.stderr, /visible after lease recovery/);
});

test("F4 quarantines parsed JSON values that are not acceptable ack states", (t) => {
  const cases = [
    ["array", []],
    ["scalar", "parsed scalar"],
    ["string-version", { version: "1", acked: {}, pending: {} }],
    ["fractional-version", { version: 1.5, acked: {}, pending: {} }],
    ["null-version", { version: null, acked: {}, pending: {} }],
  ];

  function exercise(api, label, invalidState) {
    const home = tempRoot(`session-inbox-invalid-ack-${label}-`);
    enqueue(api, home, record(`invalid-ack-${label}`, `visible after ${label} recovery`));
    const paths = api.pathsFor(home, SID);
    fs.mkdirSync(path.dirname(paths.ack), { recursive: true });
    fs.writeFileSync(paths.ack, `${JSON.stringify(invalidState)}\n`, { mode: 0o600 });

    const first = api.handleStop(payload(home, { last_assistant_message: `F4 ${label}` }), home);
    const quarantined = fs.readdirSync(path.dirname(paths.ack))
      .filter((name) => name.startsWith(`${path.basename(paths.ack)}.corrupt.`));
    assert.strictEqual(first.exitCode, 0, first.stderr);
    assert.match(first.stderr, /Invalid acknowledgement state was moved/);
    assert.strictEqual(quarantined.length, 1, `${label} must be quarantined exactly once`);
    assert.ok(!fs.existsSync(paths.ack), `${label} must no longer occupy the live ack path`);

    const recovered = api.handleStop(
      payload(home, { last_assistant_message: `F4 ${label} recovered` }),
      home,
    );
    assert.strictEqual(recovered.exitCode, 2, recovered.stderr);
    assert.match(recovered.stderr, new RegExp(`visible after ${label} recovery`));
    return quarantined.length;
  }

  const counts = cases.map(([label, invalidState]) => exercise(loadInbox(), label, invalidState));
  t.diagnostic(`F4_PARSED_INVALID_ACK quarantine_counts=${JSON.stringify(counts)}`);

  const narrowed = loadMutant(
    'if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Number.isInteger(parsed.version)) {',
    "if (!parsed) {",
  );
  assert.throws(
    () => exercise(narrowed, "narrowed-array", []),
    /Cannot read properties of null|Expected values to be strictly equal|must be quarantined exactly once/,
    "narrowing the parsed-value guard back to !parsed must expose the unquarantined array",
  );
});

test("H-I unknown ack versions are preserved and additive v1 fields survive acknowledgement writes", () => {
  const api = loadInbox();
  const unknownHome = tempRoot("session-inbox-unknown-version-");
  enqueue(api, unknownHome, record("unknown-version-id", "must remain queued"));
  const unknownPaths = api.pathsFor(unknownHome, SID);
  fs.mkdirSync(path.dirname(unknownPaths.ack), { recursive: true });
  const unknown = { version: 2, acked: { historical: "2026-08-23T00:00:00.000Z" }, pending: {}, v2_cursor: "keep" };
  fs.writeFileSync(unknownPaths.ack, `${JSON.stringify(unknown)}\n`);
  const before = fs.readFileSync(unknownPaths.ack, "utf8");
  const refused = runHook(unknownHome, payload(unknownHome));
  assert.strictEqual(refused.status, 0, refused.stderr);
  assert.match(refused.stderr, /expected 1, found 2/);
  assert.match(refused.stderr, new RegExp(unknownPaths.ack.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.strictEqual(fs.readFileSync(unknownPaths.ack, "utf8"), before);
  assert.deepStrictEqual(
    fs.readdirSync(path.dirname(unknownPaths.ack)).filter((name) => name.includes(".corrupt.")),
    [],
  );

  const additiveHome = tempRoot("session-inbox-additive-v1-");
  enqueue(api, additiveHome, record("additive-id", "preserve additive fields"));
  const additivePaths = api.pathsFor(additiveHome, SID);
  fs.mkdirSync(path.dirname(additivePaths.ack), { recursive: true });
  fs.writeFileSync(additivePaths.ack, `${JSON.stringify({
    version: 1,
    acked: {},
    pending: {},
    delivery_policy: "future-policy",
    v2_cursor: { offset: 7 },
  })}\n`);
  assert.strictEqual(runHook(additiveHome, payload(additiveHome)).status, 2);
  assert.strictEqual(runHook(additiveHome, payload(additiveHome, {
    stop_hook_active: true,
    last_assistant_message: "INBOX-OK: additive-id",
  })).status, 0);
  const evolved = JSON.parse(fs.readFileSync(additivePaths.ack, "utf8"));
  assert.strictEqual(evolved.delivery_policy, "future-policy");
  assert.deepStrictEqual(evolved.v2_cursor, { offset: 7 });
  assert.ok(evolved.acked["additive-id"]);

  const versionResetMutant = loadMutant(
    "return { state: null, recovered: false, unsupportedVersion: parsed.version };",
    'throw new Error("invalid ack state");',
  );
  const resetHome = tempRoot("session-inbox-version-reset-mutant-");
  enqueue(api, resetHome, record("version-reset-id", "mutation control"));
  const resetPaths = api.pathsFor(resetHome, SID);
  fs.mkdirSync(path.dirname(resetPaths.ack), { recursive: true });
  fs.writeFileSync(resetPaths.ack, `${JSON.stringify(unknown)}\n`);
  versionResetMutant.handleStop(payload(resetHome), resetHome);
  const resetQuarantines = fs.readdirSync(path.dirname(resetPaths.ack)).filter((name) => name.includes(".corrupt."));
  assert.strictEqual(resetQuarantines.length, 1, "the unknown-version reset mutation must reproduce ack-history loss");

  const additiveDropMutant = loadMutant("        ...parsed,\n", "");
  const dropHome = tempRoot("session-inbox-additive-drop-mutant-");
  enqueue(api, dropHome, record("additive-drop-id", "mutation control"));
  const dropPaths = api.pathsFor(dropHome, SID);
  fs.mkdirSync(path.dirname(dropPaths.ack), { recursive: true });
  fs.writeFileSync(dropPaths.ack, `${JSON.stringify({
    version: 1, acked: {}, pending: {}, delivery_policy: "must-survive", v2_cursor: { offset: 9 },
  })}\n`);
  additiveDropMutant.handleStop(payload(dropHome), dropHome);
  additiveDropMutant.handleStop(payload(dropHome, {
    stop_hook_active: true,
    last_assistant_message: "INBOX-OK: additive-drop-id",
  }), dropHome);
  const dropped = JSON.parse(fs.readFileSync(dropPaths.ack, "utf8"));
  assert.strictEqual(dropped.delivery_policy, undefined);
  assert.strictEqual(dropped.v2_cursor, undefined);
});

test("F5 accepts only transport ids that round-trip through the ack token grammar", (t) => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-ack-id-");
  const invalidIds = ["a,b", "a，b", "a、b"];
  const statuses = invalidIds.map((id) => enqueue(api, home, record(id, "must be rejected")).status);
  t.diagnostic(`F5_SEPARATOR_IDS statuses=${JSON.stringify(statuses)}`);
  assert.deepStrictEqual(statuses, ["invalid", "invalid", "invalid"]);

  const validId = "a-b_c.d:1";
  assert.strictEqual(enqueue(api, home, record(validId, "round-trip id")).status, "enqueued");
  assert.strictEqual(runHook(home, payload(home, { last_assistant_message: "F5 deliver" })).status, 2);
  const acknowledged = runHook(
    home,
    payload(home, { stop_hook_active: true, last_assistant_message: `INBOX-OK: ${validId}` }),
  );
  assert.strictEqual(acknowledged.status, 0, acknowledged.stderr);
  assert.strictEqual(runHook(home, payload(home, { last_assistant_message: "F5 consumed" })).status, 0);
});

test("I3 stop_hook_active takes the ack-only exit and cannot form a 2,2 loop", (t) => {
  const api = loadInbox();
  const home = tempRoot();
  enqueue(api, home, record("loop-id", "loop control"));

  const first = runHook(home, payload(home, { last_assistant_message: "loop first" }));
  assert.match(first.stderr, /当前 delivery cycle.*claim.*ordinary Stop/s);
  assert.doesNotMatch(first.stderr, /会在之后的 ordinary Stop 再次出现/);
  const deferred = runHook(home, payload(home, { last_assistant_message: "loop concurrent ordinary" }));
  assert.strictEqual(deferred.status, 0, deferred.stderr);
  t.diagnostic(`S2_DELIVERY_DIAGNOSTIC stderr=${JSON.stringify(deferred.stderr)}`);
  assert.match(deferred.stderr, /maximum claim lease 10 minutes/);
  assert.match(deferred.stderr, /did not inject those messages again/);
  const oldPromiseMutant = loadMutant(
    "未点名的消息不会被确认；当前 delivery cycle 关闭或其 claim 可恢复后，后续 ordinary Stop 会再次投递。",
    "未点名的消息不会被确认，并会在之后的 ordinary Stop 再次出现。",
  );
  const oldPromiseHome = tempRoot("session-inbox-old-promise-mutant-");
  enqueue(oldPromiseMutant, oldPromiseHome, record("old-promise", "mutation control"));
  const oldPromise = oldPromiseMutant.handleStop(payload(oldPromiseHome), oldPromiseHome);
  assert.match(oldPromise.stderr, /会在之后的 ordinary Stop 再次出现/);
  const activeWithoutAck = runHook(
    home,
    payload(home, { stop_hook_active: true, last_assistant_message: "not an ack" }),
  );
  assert.deepStrictEqual([first.status, activeWithoutAck.status], [2, 0]);
  const closed = JSON.parse(fs.readFileSync(api.pathsFor(home, SID).ack, "utf8"));
  assert.strictEqual(closed.pending["loop-id"].delivery_key, null);

  const diagnosticMutant = copyMutatedHook(
    'stderr: recoveryDiagnostic("A delivery claim is already open", recoveryDeadline),',
    'stderr: "",',
  );
  const mutantHome = tempRoot("session-inbox-recovery-diagnostic-mutant-");
  enqueue(api, mutantHome, record("diagnostic-mutant", "diagnostic mutation"));
  assert.strictEqual(
    runHook(
      mutantHome,
      payload(mutantHome, { last_assistant_message: "diagnostic mutation first" }),
      { hook: diagnosticMutant },
    ).status,
    2,
  );
  const hiddenRecovery = runHook(
    mutantHome,
    payload(mutantHome, { last_assistant_message: "diagnostic mutation deferred" }),
    { hook: diagnosticMutant },
  );
  assert.strictEqual(hiddenRecovery.status, 0, hiddenRecovery.stderr);
  t.diagnostic(`S2_RECOVERY_DIAGNOSTIC_MUTATION stderr_bytes=${Buffer.byteLength(hiddenRecovery.stderr)}`);
  assert.strictEqual(hiddenRecovery.stderr, "");
  assert.throws(() => assert.match(hiddenRecovery.stderr, /maximum claim lease/));

  const normalControl = runHook(home, payload(home, { last_assistant_message: "loop first" }));
  assert.strictEqual(normalControl.status, 2, "ordinary Stop must still be able to report the pending message");

  const activeAck = runHook(
    home,
    payload(home, { stop_hook_active: true, last_assistant_message: "INBOX-OK: loop-id" }),
  );
  assert.strictEqual(activeAck.status, 0, activeAck.stderr);
  const consumed = runHook(home, payload(home, { last_assistant_message: "loop consumed" }));
  assert.strictEqual(consumed.status, 0, consumed.stderr);
});

test("I4 concurrent Stops inject once and concurrent acknowledgements do not lose updates", async (t) => {
  const api = loadInbox();
  const home = tempRoot();
  enqueue(api, home, record("parallel-a", "parallel message A"));
  enqueue(api, home, record("parallel-b", "parallel message B"));

  const stop = payload(home, { last_assistant_message: "same parallel stop" });
  const firstPair = await Promise.all([runHookAsync(home, stop), runHookAsync(home, stop)]);
  assert.deepStrictEqual(firstPair.map((r) => r.status).sort(), [0, 2]);
  const injections = firstPair.filter((r) => r.status === 2);
  assert.strictEqual(injections.length, 1);
  assert.match(injections[0].stderr, /parallel-a/);
  assert.match(injections[0].stderr, /parallel-b/);

  const ackPair = await Promise.all([
    runHookAsync(home, payload(home, { stop_hook_active: true, last_assistant_message: "INBOX-OK: parallel-a" })),
    runHookAsync(home, payload(home, { stop_hook_active: true, last_assistant_message: "INBOX-OK: parallel-b" })),
  ]);
  assert.deepStrictEqual(ackPair.map((r) => r.status), [0, 0]);
  const state = JSON.parse(fs.readFileSync(api.pathsFor(home, SID).ack, "utf8"));
  assert.deepStrictEqual(Object.keys(state.acked).sort(), ["parallel-a", "parallel-b"]);
  const final = runHook(home, payload(home, { last_assistant_message: "after parallel ack" }));
  assert.strictEqual(final.status, 0, final.stderr);

  const mutantHome = tempRoot();
  enqueue(api, mutantHome, record("mutant-a", "mutation A"));
  enqueue(api, mutantHome, record("mutant-b", "mutation B"));
  assert.strictEqual(
    runHook(mutantHome, payload(mutantHome, { last_assistant_message: "prime mutant pending" })).status,
    2,
  );
  const mutant = copyMutatedHook(
    "return runWithFilesystemLock(lockDir, critical);",
    "return critical();",
  );
  const mutantAck = api.pathsFor(mutantHome, SID).ack;
  const barrierEnv = makeReadBarrier(mutantAck);
  const mutantPair = await Promise.all([
    runHookAsync(
      mutantHome,
      payload(mutantHome, { stop_hook_active: true, last_assistant_message: "INBOX-OK: mutant-a" }),
      { hook: mutant, env: barrierEnv },
    ),
    runHookAsync(
      mutantHome,
      payload(mutantHome, { stop_hook_active: true, last_assistant_message: "INBOX-OK: mutant-b" }),
      { hook: mutant, env: barrierEnv },
    ),
  ]);
  assert.deepStrictEqual(mutantPair.map((r) => r.status), [0, 0]);
  const mutantState = JSON.parse(fs.readFileSync(mutantAck, "utf8"));
  t.diagnostic(`I4_NO_LOCK_MUTATION acked=${JSON.stringify(Object.keys(mutantState.acked).sort())}`);
  assert.strictEqual(
    Object.keys(mutantState.acked).length,
    1,
    "the no-lock mutation must expose a lost acknowledgement",
  );
});

test("F6 concurrent ordinary Stops deduplicate independently of payload text", async (t) => {
  const api = loadInbox();
  const home = tempRoot("session-inbox-different-stop-");
  enqueue(api, home, record("different-stop-id", "one transport record"));
  const pair = await Promise.all([
    runHookAsync(home, payload(home, { last_assistant_message: "ordinary input A" })),
    runHookAsync(home, payload(home, { last_assistant_message: "ordinary input B" })),
  ]);
  const statuses = pair.map((result) => result.status).sort();
  t.diagnostic(`F6_DIFFERENT_INPUTS statuses=${JSON.stringify(statuses)}`);
  assert.deepStrictEqual(statuses, [0, 2]);
  assert.strictEqual(pair.filter((result) => result.status === 2).length, 1);
});
