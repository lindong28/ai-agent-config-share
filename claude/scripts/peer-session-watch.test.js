#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { after, test } = require("node:test");

const watcher = require("./peer-session-watch");
const inbox = require("../hooks/session-inbox");
const COMMAND = path.join(__dirname, "..", "commands", "custom", "supervise-session.md");
const ADR = path.join(__dirname, "..", "..", "docs", "adr", "20260823-dddf-peer-session-inbox-best-effort.md");
// Sampled from the real Claude Code transcript population on 2026-08-23.
const TARGET = "3f7b6aa1-f660-4ecd-9c67-cd6b61831c55";
const SUPERVISOR = "fe70dca0-370c-470a-bdff-b5b66d0f9743";
const repoLocalTempBase = path.join(__dirname, ".peer-session-watch-test-tmp");

function loadWatcherMutant(search, replacement) {
  const sourcePath = path.join(__dirname, "peer-session-watch.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.ok(source.includes(search), `mutation anchor missing: ${search}`);
  const mod = new Module("peer-session-watch-mutant", module);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(__dirname);
  mod._compile(source.replace(search, replacement), sourcePath);
  return mod.exports;
}

const created = [];
function tempRoot(prefix) {
  for (const base of [os.tmpdir(), repoLocalTempBase]) {
    try {
      fs.mkdirSync(base, { recursive: true });
      const root = fs.mkdtempSync(path.join(base, prefix));
      created.push(root);
      return root;
    } catch (error) {
      if (!error || !["EACCES", "EPERM", "EROFS"].includes(error.code)) throw error;
    }
  }
  throw new Error("no writable test temp root");
}

function gitRepoWithHistory(prefix) {
  const root = tempRoot(prefix);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "peer-session-watch fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "peer-session-watch fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const git = (args, options = {}) => execFileSync("git", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
  git(["init", "-q"]);
  const blob = git(["hash-object", "-w", "--stdin"], { input: "fixture\n" });
  const tree = git(["mktree"], { input: `100644 blob ${blob}\tfixture.txt\n` });
  const commit = git(["commit-tree", tree], { input: "fixture history\n" });
  git(["update-ref", "HEAD", commit]);
  return root;
}

const fixtureRoot = tempRoot("fixture-");
const fixtureGitRepo = gitRepoWithHistory("git-repo-");
const fixtureTranscript = path.join(fixtureRoot, `${TARGET}.jsonl`);
fs.writeFileSync(
  fixtureTranscript,
  `${JSON.stringify({ timestamp: "2026-08-23T00:00:00Z", type: "assistant" })}\n`,
);

after(() => {
  for (const root of created.reverse()) fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(repoLocalTempBase, { recursive: true, force: true });
});

function baseState(overrides = {}) {
  const state = watcher.createState({
    supervisorSessionId: SUPERVISOR,
    targetSessionId: TARGET,
    targetTranscript: fixtureTranscript,
    stateFile: path.join(fixtureRoot, "state.json"),
    intervalMs: 60_000,
    hardTimeoutMs: 6 * 60 * 60_000,
    windowSize: 3,
    silenceMultiplier: 2,
    gitZeroRounds: 3,
    nowMs: Date.parse("2026-08-23T00:00:00Z"),
    ...overrides,
  });
  const transcript = fs.statSync(state.target_transcript);
  state.pending_review_snapshot = {
    transcript_path: state.target_transcript,
    frozen_prefix_bytes: transcript.size,
    transcript_mtime: transcript.mtime.toISOString(),
    transcript_prefix_sha256: crypto.createHash("sha256").update(fs.readFileSync(state.target_transcript)).digest("hex"),
    transcript_offset: transcript.size,
  };
  return state;
}

function sample(at, activity, extras = {}) {
  return {
    sampled_at: at,
    last_activity_at: activity,
    target_alive: true,
    ledger_mtime_ms: null,
    git_head: "abc",
    ...extras,
  };
}

function runCli(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "peer-session-watch.js"), ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("I5 healthy shallow ticks wake no model and deep usage is recorded exactly", () => {
  const shallowGraph = [
    watcher.watchLoop,
    watcher.collectSample,
    watcher.advance,
    watcher.transitionSignals,
    watcher.signalAvailability,
  ].map((fn) => fn.toString()).join("\n");
  const modelReachability = /recordReview|deliverReview|normalizeReview|review-session-progress|spawnSync\([^)]*(?:claude|codex)/;
  assert.doesNotMatch(shallowGraph, modelReachability);
  assert.throws(
    () => assert.doesNotMatch(`${shallowGraph}\nrecordReview(state, review)`, modelReachability),
    "adding a deep-review edge to the shallow graph must make the structural control red",
  );
  assert.deepEqual({
    interval_ms: watcher.DEFAULT_INTERVAL_MS,
    window_size: watcher.DEFAULT_WINDOW_SIZE,
    silence_multiplier: watcher.DEFAULT_SILENCE_MULTIPLIER,
    git_zero_rounds: watcher.DEFAULT_GIT_ZERO_ROUNDS,
  }, {
    interval_ms: 60_000,
    window_size: 20,
    silence_multiplier: 20,
    git_zero_rounds: 180,
  });
  let state = baseState();
  const activities = ["00:00", "00:01", "00:02", "00:03"].map((value) =>
    `2026-08-23T${value}:00Z`);
  let wakeCount = 0;
  for (let index = 0; index < activities.length; index += 1) {
    const result = watcher.advance(state, sample(activities[index], activities[index], {
      git_head: `commit-${index}`,
    }));
    state = result.state;
    if (result.wake) wakeCount += 1;
  }
  assert.equal(wakeCount, 0);
  assert.equal(state.model_calls.deep_reviews, 0);

  const anomaly = watcher.advance(
    state,
    sample("2026-08-23T00:06:01Z", "2026-08-23T00:03:00Z", { git_head: "commit-4" }),
  );
  assert.equal(anomaly.wake.kind, "anomaly-candidate");
  assert.deepEqual(anomaly.wake.active_signal_codes, ["activity_silence"]);
  anomaly.state.pending_review_snapshot = baseState().pending_review_snapshot;
  const reviewed = watcher.recordReview(anomaly.state, reviewFixture({ state: anomaly.state, input_tokens: 321, output_tokens: 123 }));
  assert.deepEqual(reviewed.token_usage, {
    deep_input_tokens: 321,
    deep_output_tokens: 123,
    deep_total_tokens: 444,
  });
  assert.equal(reviewed.model_calls.deep_reviews, 1);
});

test("I6 episode identity is order-stable, re-arms on set change or recovery, and survives restart", () => {
  let state = baseState();
  let result = watcher.transitionSignals(state, ["git_no_commits", "activity_silence"]);
  assert.equal(result.wake.kind, "anomaly-candidate");
  assert.equal(result.state.episode_signature, "activity_silence+git_no_commits");
  state = watcher.markDeepReviewTriggered(result.state);

  result = watcher.transitionSignals(state, ["activity_silence", "git_no_commits"]);
  assert.equal(result.wake, null, "the same signal set must not repeat a deep review");
  result = watcher.transitionSignals(result.state, ["activity_silence"]);
  assert.equal(result.wake.kind, "anomaly-candidate", "a set change must re-arm");
  state = watcher.markDeepReviewTriggered(result.state);

  const root = tempRoot("restart-");
  const stateFile = path.join(root, "state.json");
  state.state_file = stateFile;
  watcher.saveState(stateFile, state);
  const restarted = watcher.loadState(stateFile);
  result = watcher.transitionSignals(restarted, ["activity_silence"]);
  assert.equal(result.wake, null, "restart must preserve the reviewed episode");

  result = watcher.transitionSignals(result.state, []);
  assert.equal(result.state.state, "healthy");
  assert.equal(result.state.episode_signature, "");
  result = watcher.transitionSignals(result.state, ["activity_silence"]);
  assert.equal(result.wake.kind, "anomaly-candidate", "recovery followed by recurrence must re-arm");

  assert.equal(watcher.deadlineWake(result.state).kind, "hard-timeout");
  assert.equal(watcher.cancelledWake(result.state).kind, "cancelled");
  assert.notDeepEqual(watcher.deadlineWake(result.state), watcher.cancelledWake(result.state));
});

test("I7 every eligible section-5 basis and section-6 draft must be written back and notification-accepted", (t) => {
  const home = tempRoot("i7-real-inbox-");
  const state = baseState({ runtimeRoot: path.join(home, ".claude", "state") });
  const review = reviewFixture({ state, interventions: [
    { body: "Correct the first issue.", evidence: ["evidence-1"] },
    { body: "Correct the second issue.", evidence: ["evidence-2"] },
  ] });
  const enqueue = (record) => inbox.enqueueMessage({ homeDir: home, sessionId: TARGET, record });

  const good = watcher.deliverReview(state, review, {
    homeDir: home,
    enqueue,
    notify: () => 0,
  });
  assert.equal(good.complete, true);
  assert.deepEqual(good.counts, {
    eligible_section5: 2,
    enqueued: 2,
    queue_write_back_verified: 2,
    intervention_im_notify_exit_zero: 2,
  });
  assert.equal(good.review.interventions[0].body_source, "review-session-progress.section6_instruction_draft");
  assert.equal(good.review.interventions[0].evidence_source, "review-session-progress.section5_intervention");

  const notifyHome = tempRoot("i7-partial-notify-");
  let notifyCalls = 0;
  const notifyFirstOnly = watcher.deliverReview(state, review, {
    homeDir: notifyHome,
    enqueue: (record) => inbox.enqueueMessage({ homeDir: notifyHome, sessionId: TARGET, record }),
    notify: () => (++notifyCalls === 1 ? 0 : 1),
  });
  assert.equal(notifyFirstOnly.complete, false, "notifying only the first intervention must report the opposite outcome");

  const duplicateHome = tempRoot("i7-duplicate-");
  const duplicateRecord = {
    id: `${review.review_id}-section5-1`,
    from: `supervisor:${SUPERVISOR}`,
    ts: review.created_at,
    body: review.interventions[0].body,
    evidence: review.interventions[0].evidence,
    has_user_decidable_spots: review.interventions[0].has_user_decidable_spots,
  };
  assert.equal(inbox.enqueueMessage({ homeDir: duplicateHome, sessionId: TARGET, record: duplicateRecord }).status, "enqueued");
  const duplicateOnly = watcher.deliverReview(baseState(), reviewFixture({
    state: baseState(),
    interventions: [review.interventions[0]],
  }), {
    homeDir: duplicateHome,
    enqueue: (record) => inbox.enqueueMessage({ homeDir: duplicateHome, sessionId: TARGET, record }),
    notify: () => 0,
  });
  t.diagnostic(`H_B_DUPLICATE counts=${JSON.stringify(duplicateOnly.counts)} complete=${duplicateOnly.complete}`);
  assert.equal(duplicateOnly.complete, true, "an exact duplicate verified in the queue is the durable enqueue receipt");

  const noInterventions = watcher.deliverReview(baseState(), reviewFixture({ state: baseState() }), {
    homeDir: tempRoot("i7-zero-"),
    enqueue: () => assert.fail("zero interventions must not enqueue"),
    notify: () => assert.fail("zero interventions must not notify"),
  });
  t.diagnostic(`H_B_ZERO counts=${JSON.stringify(noInterventions.counts)} complete=${noInterventions.complete}`);
  assert.equal(noInterventions.complete, false, "zero eligible interventions are not a completed delivery");

  const priorHome = tempRoot("i7-prior-");
  const priorState = watcher.deliverReview(baseState(), reviewFixture({
    state: baseState(), interventions: [review.interventions[0]],
  }), {
    homeDir: priorHome,
    enqueue: (record) => inbox.enqueueMessage({ homeDir: priorHome, sessionId: TARGET, record }),
    notify: () => 0,
  }).state;
  fs.unlinkSync(inbox.pathsFor(priorHome, TARGET).queue);
  const priorRetry = watcher.deliverReview(priorState, reviewFixture({
    state: priorState, interventions: [review.interventions[0]],
  }), {
    homeDir: priorHome,
    enqueue: (record) => inbox.enqueueMessage({ homeDir: priorHome, sessionId: TARGET, record }),
    notify: () => 0,
  });
  t.diagnostic(`H_B_PRIOR_SHORT_CIRCUIT counts=${JSON.stringify(priorRetry.counts)} complete=${priorRetry.complete}`);
  assert.equal(fs.existsSync(inbox.pathsFor(priorHome, TARGET).queue), true, "retry must reach the real enqueue primitive");
  assert.equal(priorRetry.complete, true, "a successful re-enqueue plus read-back can complete the retry");
});

test("NEW-1 queue read-back recovers enqueue after delivery state is lost", (t) => {
  const home = tempRoot("lost-delivery-state-");
  const state = baseState({ runtimeRoot: path.join(home, ".claude", "state") });
  const review = reviewFixture({
    state,
    interventions: [{ body: "Recover the delivered correction.", evidence: ["Section-5 basis."] }],
  });
  const item = review.interventions[0];
  const record = {
    id: `${review.review_id}-${item.section5_item_id}`,
    from: `supervisor:${SUPERVISOR}`,
    ts: review.created_at,
    body: item.body,
    evidence: item.evidence,
    has_user_decidable_spots: item.has_user_decidable_spots,
  };
  assert.equal(inbox.enqueueMessage({ homeDir: home, sessionId: TARGET, record }).status, "enqueued");

  let notifyCalls = 0;
  const retried = watcher.deliverReview(state, review, {
    homeDir: home,
    notify: () => { notifyCalls += 1; return 0; },
  });
  t.diagnostic(`NEW_1_LOST_STATE counts=${JSON.stringify(retried.counts)} complete=${retried.complete} notify_calls=${notifyCalls}`);
  assert.deepEqual(retried.counts, {
    eligible_section5: 1,
    enqueued: 1,
    queue_write_back_verified: 1,
    intervention_im_notify_exit_zero: 1,
  });
  assert.equal(notifyCalls, 1);
  assert.equal(retried.complete, true);
});

test("H-A and H-C refuse a review for another target/snapshot and changed content under one review id", () => {
  const state = baseState();
  const otherTarget = "b323558f-8d1e-43be-b549-5f0f9575dd13";
  assert.throws(
    () => watcher.recordReview(state, reviewFixture({ state, targetSessionId: otherTarget })),
    /target_session_id/,
  );
  assert.throws(
    () => watcher.recordReview(state, reviewFixture({ state, transcriptPath: path.join(fixtureRoot, "other.jsonl") })),
    /snapshot.*transcript_path/,
  );
  const first = reviewFixture({ state, interventions: [{ body: "first body", evidence: ["first evidence"] }] });
  const recorded = watcher.recordReview(state, first);
  const changed = reviewFixture({ state, interventions: [{ body: "DIFFERENT BODY", evidence: ["other evidence"] }] });
  assert.throws(() => watcher.recordReview(recorded, changed), /review_id.*different content/);
  const fingerprintGuardRemoved = JSON.parse(JSON.stringify(recorded));
  delete fingerprintGuardRemoved.review_fingerprints[first.review_id];
  const silentlyReused = watcher.recordReview(fingerprintGuardRemoved, changed);
  assert.equal(silentlyReused.latest_review.interventions[0].body, "DIFFERENT BODY");
  const original = fs.readFileSync(state.target_transcript);
  try {
    fs.appendFileSync(state.target_transcript, `${JSON.stringify({ timestamp: "2026-08-23T00:11:00Z" })}\n`);
    assert.doesNotThrow(
      () => watcher.recordReview(state, first),
      "an append after the frozen boundary must not invalidate a prefix-bound review",
    );
  } finally {
    fs.writeFileSync(state.target_transcript, original);
    const restored = fs.statSync(state.target_transcript);
    state.pending_review_snapshot.frozen_prefix_bytes = restored.size;
    state.pending_review_snapshot.transcript_mtime = restored.mtime.toISOString();
  }
  const wrongBlob = reviewFixture({ state });
  wrongBlob.snapshot.review_command_blob = "0000000000000000000000000000000000000000";
  assert.throws(
    () => watcher.recordReview(state, wrongBlob),
    /expected one of .*39ae61d7.* found 0000000000000000000000000000000000000000/,
  );
  const danglingBlob = reviewFixture({ state });
  danglingBlob.snapshot.review_command_blob = "c1bad0a93f8aafadbb8934d32cb0b00ac3f17b2c";
  assert.throws(() => watcher.normalizeReview(danglingBlob, state), /review_command_blob mismatch/);
  assert.deepEqual(watcher.REVIEW_COMMAND_BLOBS, ["39ae61d7eca4d6d86d8282275aa44b10b7eac88d"]);
  assert.throws(
    () => baseState({ acceptedReviewCommandBlobs: ["c1bad0a93f8aafadbb8934d32cb0b00ac3f17b2c"] }),
    /ref-reachable accepted review command blob set/,
  );
});

test("decision 10 rejects the former section-5-as-body contract and carries section-6 metadata", () => {
  const state = baseState();
  const legacy = reviewFixture({ state, interventions: [{
    body: "Argument to the user about whether interruption is worthwhile.",
    evidence: ["A supporting reading."],
  }] });
  delete legacy.interventions[0].body_source;
  delete legacy.interventions[0].evidence_source;
  delete legacy.interventions[0].has_user_decidable_spots;
  assert.throws(() => watcher.normalizeReview(legacy, state), /section-6.*section-5/i);

  const review = reviewFixture({ state, interventions: [{
    body: "Withdraw the earlier instruction and use 【recommended default】 instead.",
    evidence: ["The corresponding section-5 intervention argument."],
    has_user_decidable_spots: true,
  }] });
  let notified;
  const result = watcher.deliverReview(state, review, {
    homeDir: tempRoot("decision-10-"),
    notify: (record) => { notified = watcher.interventionNotificationText(record, state); return 0; },
  });
  assert.equal(result.complete, true);
  assert.equal(result.review.interventions[0].body_source, "review-session-progress.section6_instruction_draft");
  assert.equal(result.review.interventions[0].evidence_source, "review-session-progress.section5_intervention");
  assert.match(notified, /contained `【】` user-decidable spots/);
});

test("snapshot prefix digest rejects a same-size rewrite that the former stat-only gate accepted", (t) => {
  const state = baseState();
  const review = reviewFixture({ state });
  const original = fs.readFileSync(state.target_transcript);
  const mutated = Buffer.from(original);
  mutated[0] ^= 1;
  try {
    fs.writeFileSync(state.target_transcript, mutated);
    fs.utimesSync(
      state.target_transcript,
      new Date(state.pending_review_snapshot.transcript_mtime),
      new Date(state.pending_review_snapshot.transcript_mtime),
    );
    const current = fs.statSync(state.target_transcript);
    const formerStatOnlyAccepted = current.size === review.snapshot.frozen_prefix_bytes &&
      current.mtime.toISOString() === review.snapshot.transcript_mtime;
    t.diagnostic(`PREFIX_REWRITE former_stat_only_accepted=${formerStatOnlyAccepted}`);
    assert.equal(formerStatOnlyAccepted, true);
    assert.throws(() => watcher.normalizeReview(review, state), /snapshot frozen prefix no longer matches/);
  } finally {
    fs.writeFileSync(state.target_transcript, original);
  }
});

test("I8 a terminal decision persists its complete report and notification failure is retryable", () => {
  const root = tempRoot("terminal-");
  const stateFile = path.join(root, "state.json");
  const initial = baseState({ stateFile });
  const review = reviewFixture({ state: initial, terminal: true, interventions: [{ body: "terminal correction", evidence: ["terminal evidence"] }] });
  const delivered = watcher.deliverReview(initial, review, {
    homeDir: root,
    enqueue: (record) => inbox.enqueueMessage({ homeDir: root, sessionId: TARGET, record }),
    notify: () => 0,
  });
  let notificationObservedPersistedReport = false;
  const completed = watcher.finishReview(delivered.state, review, {
    stateFile,
    completionNotify: () => {
      notificationObservedPersistedReport = Boolean(watcher.loadState(stateFile).completion_report);
      return 0;
    },
  });
  assert.equal(notificationObservedPersistedReport, true);
  assert.equal(completed.state.state, "terminal");
  assert.equal(completed.completion_notify_accepted, true);
  assert.deepEqual(completed.state.latest_review.delivery_counts, delivered.counts);
  assert.equal(completed.state.latest_review.delivery_complete, true);
  assert.deepEqual(completed.state.completion_report.review_evidence, review.review_evidence);
  assert.equal("evidence" in completed.state.completion_report, false);

  const failureFile = path.join(root, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
  const failedState = baseState({ stateFile: failureFile, runtimeRoot: path.join(root, ".claude", "state") });
  const failedReview = reviewFixture({ state: failedState, terminal: true });
  const failed = watcher.finishReview(failedState, failedReview, {
    stateFile: failureFile,
    completionNotify: () => 1,
  });
  assert.equal(failed.state.state, "completion-pending-notify");
  assert.ok(failed.state.next_completion_notify_at);
  assert.ok(watcher.loadState(failureFile).completion_report);

  let retryCalls = 0;
  failed.state.next_completion_notify_at = "2026-08-23T00:00:00Z";
  watcher.saveState(failureFile, failed.state);
  const retryOptions = watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--home", root,
    "--state-file", failureFile, "--disable-git-signal",
  ]);
  retryOptions.completionNotify = () => { retryCalls += 1; return 0; };
  const retried = watcher.watchLoop(retryOptions);
  assert.equal(retryCalls, 1);
  assert.equal(retried.kind, "terminal");
  assert.equal(watcher.loadState(failureFile).state, "terminal");
});

test("L1 boundary: exactly one target and the persisted write surface stays inside supervisor runtime", () => {
  assert.throws(() => watcher.parseCli(["watch"]), /exactly one --target/);
  assert.throws(
    () => watcher.parseCli(["watch", "--target", TARGET, "--target", "ede93c1b-6524-4020-8d89-b73aca4af2cd", "--supervisor", SUPERVISOR]),
    /exactly one --target/,
  );
  const parsed = watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--home", "/isolated",
    "--runtime-root", "/isolated/.claude/state", "--disable-git-signal",
  ]);
  assert.equal(parsed.targetSessionId, TARGET);
  assert.deepEqual(watcher.ownedWritePaths(parsed), [
    `/isolated/.claude/state/peer-supervision/${SUPERVISOR}.json`,
    `/isolated/.claude/state/peer-supervision/${SUPERVISOR}.cancel`,
    `/isolated/.claude/state/peer-supervision/${SUPERVISOR}.watcher-claim`,
    `/isolated/.claude/state/session-inbox/${TARGET}.jsonl`,
    `/isolated/.claude/state/session-inbox/.locks/${TARGET}.lock`,
  ]);
  assert.throws(() => watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--home", "/tmp/HH",
    "--runtime-root", "/tmp/RR", "--disable-git-signal",
  ]), /--runtime-root.*--home/);
  const command = fs.readFileSync(COMMAND, "utf8");
  assert.match(command, /不 stop\/resume A，不改 A 的代码、plan、state、journal/);
  assert.match(command, /允许写入面限定为 `~\/\.claude\/state\/peer-supervision\/` 与 `~\/\.claude\/state\/session-inbox\/`/);
  assert.match(command, /一次运行只持久化一个 target/);
  assert.throws(
    () => watcher.parseCli(["watch", "--target", TARGET, "--supervisor", SUPERVISOR, "--transcript", fixtureTranscript, "--disable-git-signal", "--intervl-ms", "1"]),
    /unknown flag.*--intervl-ms/,
  );
  assert.throws(
    () => watcher.parseCli(["watch", "--target", TARGET, "--supervisor", SUPERVISOR, "--transcript", fixtureTranscript, "--disable-git-signal", "--interval-ms"]),
    /missing value.*--interval-ms/,
  );
});

test("H-D one atomic watcher claim permits only one concurrent anomaly wake", async (t) => {
  const root = tempRoot("watcher-race-");
  const transcript = path.join(root, `${TARGET}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ timestamp: "2026-08-23T00:00:00Z" })}\n`);
  const stateFile = path.join(root, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
  const args = [
    path.join(__dirname, "peer-session-watch.js"), "watch",
    "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", transcript, "--home", root,
    "--runtime-root", path.join(root, ".claude", "state"),
    "--state-file", stateFile, "--repo", fixtureGitRepo,
    "--interval-ms", "25", "--git-zero-rounds", "1", "--hard-timeout-ms", "3000",
  ];
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const pair = await Promise.all([run(), run()]);
  const results = pair.map((result) => {
    try { return JSON.parse(result.stdout.trim()); } catch { return { kind: `invalid:${result.status}:${result.stderr}` }; }
  });
  const wakes = results.map((result) => result.kind);
  t.diagnostic(`H_D_CONCURRENT_WAKES ${JSON.stringify(wakes)}`);
  assert.equal(wakes.filter((kind) => kind === "anomaly-candidate").length, 1);
  assert.equal(wakes.filter((kind) => kind === "already-watching").length, 1);
  const held = results.find((result) => result.kind === "already-watching");
  assert.ok(Number.isInteger(held.owner_pid) && held.owner_pid > 0);
  assert.ok(Number.isFinite(Date.parse(held.deadline_at)));
});

test("H-J startup rejects unresolved signal inputs and persisted v1 state is complete", () => {
  assert.throws(() => baseState({ ledgerPath: path.join(fixtureRoot, "missing-ledger") }), /ledger/);
  assert.throws(() => baseState({ repoPath: path.join(fixtureRoot, "missing-repo") }), /repo/);
  assert.throws(() => baseState({ targetPid: 999999 }), /target.*pid/);
  const root = tempRoot("invalid-state-");
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, target_session_id: TARGET })}\n`);
  assert.throws(() => watcher.loadState(stateFile), /invalid peer-supervision state/);

  const ledger = path.join(root, "ledger.md");
  fs.writeFileSync(ledger, "ledger\n");
  const signaled = baseState({
    ledgerPath: ledger,
    repoPath: fixtureGitRepo,
  });
  fs.unlinkSync(ledger);
  const previousPath = process.env.PATH;
  process.env.PATH = "/definitely/no/programs";
  try {
    const unavailable = watcher.collectSample(signaled, Date.parse("2026-08-23T00:01:00Z"), 50);
    assert.equal(unavailable.ledger_status, "unavailable");
    assert.equal(unavailable.git_status, "unavailable");
    const advanced = watcher.advance(signaled, unavailable);
    assert.equal(advanced.state.observation.git_zero_rounds, 0);
    assert.equal(advanced.wake, null);
  } finally {
    process.env.PATH = previousPath;
  }
});

test("H-K an unavailable ledger disables ledger_stalled for the current sample", (t) => {
  const root = tempRoot("ledger-unavailable-transition-");
  const ledger = path.join(root, "ledger.md");
  fs.writeFileSync(ledger, "ledger\n");
  let state = baseState({ ledgerPath: ledger, targetPid: process.pid });

  for (const minute of [0, 1, 2, 3]) {
    const at = `2026-08-23T00:0${minute}:00Z`;
    state = watcher.advance(state, sample(at, at, {
      ledger_mtime_ms: Date.parse(at),
      ledger_status: "ok",
      git_status: "disabled",
    })).state;
  }

  const unavailable = watcher.advance(state, sample(
    "2026-08-23T00:06:00Z",
    "2026-08-23T00:05:00Z",
    {
      ledger_mtime_ms: null,
      ledger_status: "unavailable",
      git_status: "disabled",
    },
  ));
  t.diagnostic(`H_K_LEDGER_UNAVAILABLE ${JSON.stringify({
    wake_kind: unavailable.wake?.kind ?? null,
    active_signal_codes: unavailable.state.active_signal_codes,
    ledger_availability: unavailable.state.signal_availability.ledger_stalled,
  })}`);
  assert.deepEqual(unavailable.state.signal_availability.ledger_stalled, {
    status: "disabled",
    reason: "ledger-unavailable-this-round",
  });
  assert.equal(unavailable.wake, null);
  assert.doesNotMatch(unavailable.state.active_signal_codes.join("+"), /ledger_stalled/);

  const mutant = loadWatcherMutant(
    "observation.ledger_status === \"ok\" &&",
    "true &&",
  );
  const regressed = mutant.advance(state, sample(
    "2026-08-23T00:06:00Z",
    "2026-08-23T00:05:00Z",
    {
      ledger_mtime_ms: null,
      ledger_status: "unavailable",
      git_status: "disabled",
    },
  ));
  assert.equal(regressed.wake?.kind, "anomaly-candidate");
  assert.match(regressed.state.active_signal_codes.join("+"), /ledger_stalled/);
  t.diagnostic("LEDGER_STATUS_GUARD_MUTATIONS total=1 red=1 unheld=0");
});

test("watcher state guards reject malformed construction, samples, and frozen prefixes", () => {
  assert.throws(() => baseState({ supervisorSessionId: "not-a-session" }), /supervisor session id/);
  assert.throws(() => baseState({ targetSessionId: "not-a-session" }), /target session id/);
  assert.throws(() => baseState({ intervalMs: 0 }), /intervalMs must be a positive integer/);
  assert.throws(() => baseState({ targetTranscript: fixtureRoot }), /transcript.*file/);
  assert.throws(
    () => baseState({ acceptedReviewCommandBlobs: "not-an-array" }),
    /ref-reachable accepted review command blob set/,
  );
  assert.throws(
    () => watcher.advance(baseState(), sample("not-a-time", "also-not-a-time")),
    /sample timestamps must be valid/,
  );

  const size = fs.statSync(fixtureTranscript).size;
  assert.throws(
    () => watcher.filePrefixSha256(fixtureTranscript, size + 1),
    /shorter than the frozen review boundary/,
  );
  const originalRead = fs.readSync;
  let shortened = false;
  fs.readSync = function shortReadOnce(...args) {
    const read = originalRead.apply(this, args);
    if (!shortened && read > 0) {
      shortened = true;
      return read - 1;
    }
    return read;
  };
  try {
    assert.throws(
      () => watcher.filePrefixSha256(fixtureTranscript, size),
      /changed while its frozen boundary was read/,
    );
  } finally {
    fs.readSync = originalRead;
  }
});

test("review validation guards reject every machine-readable contract boundary", () => {
  const state = baseState();
  const withItem = () => reviewFixture({
    state,
    interventions: [{ body: "Correct it.", evidence: ["Section-5 basis."] }],
  });
  const rejects = (mutate, pattern) => {
    const review = withItem();
    mutate(review);
    assert.throws(() => watcher.normalizeReview(review, state), pattern);
  };

  assert.throws(() => watcher.normalizeReview(null, state), /review must be an object/);
  rejects((review) => { review.schema_version = 2; }, /schema_version/);
  rejects((review) => { review.created_at = ""; }, /invalid created_at/);
  rejects((review) => { review.review_id = "bad id"; }, /id\/timestamp/);
  rejects((review) => { review.snapshot = null; }, /snapshot is invalid/);
  rejects((review) => { review.snapshot.transcript_bytes = review.snapshot.frozen_prefix_bytes; }, /legacy whole-transcript/);
  rejects((review) => { review.snapshot.frozen_prefix_bytes += 1; }, /transcript position/);
  rejects((review) => { review.section5_item_ids = ["section5-1", "section5-1"]; }, /inventory item ids/);
  rejects((review) => { delete review.interventions[0].body_source; }, /invalid interventions/);
  rejects((review) => { review.interventions = []; }, /inventory does not match/);
  rejects((review) => { review.eligible_section5_count = 1; }, /self-referential/);
  rejects((review) => { review.fork_rechecks = []; }, /fork_rechecks/);
  rejects((review) => { review.signal_availability = { activity_silence: { status: "armed" } }; }, /signal_availability/);
  rejects((review) => { review.evidence = ["legacy field"]; }, /review_evidence\/model/);
  rejects((review) => { review.model.input_tokens = 1.5; }, /model.input_tokens/);
  rejects((review) => { review.terminal_decision.no_in_flight_work = "maybe"; }, /terminal_decision/);
});

test("CLI and persisted-state guards reject ambiguous ownership and invalid paths", async () => {
  const baseArgs = [
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--disable-git-signal",
  ];
  assert.throws(() => watcher.parseCli([...baseArgs, "--window", "2", "--window", "3"]), /may appear only once/);
  assert.throws(() => watcher.parseCli([...baseArgs, "--interval-ms", "0"]), /positive integer/);
  assert.throws(() => watcher.parseCli([
    "watch", "--target", "not-a-session", "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--disable-git-signal",
  ]), /full session UUID/);
  assert.throws(() => watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", "not-a-session",
    "--transcript", fixtureTranscript, "--disable-git-signal",
  ]), /valid --supervisor/);
  assert.throws(() => watcher.parseCli([
    "record-review", "--state-file", path.resolve(fixtureRoot, "..", "outside-state.json"),
  ]), /stay inside/);
  assert.throws(() => watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript,
  ]), /exactly one of --repo or --disable-git-signal/);
  assert.throws(() => watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--repo", path.join(__dirname, "..", ".."), "--disable-git-signal",
  ]), /exactly one of --repo or --disable-git-signal/);
  assert.throws(() => baseState({ repoPath: path.join(fixtureRoot, "missing-repo-specific") }), /repo path does not exist/);
  assert.throws(() => baseState({ repoPath: fixtureTranscript }), /repo path must be a directory/);
  const nonRepo = tempRoot("not-a-git-worktree-");
  const previousPath = process.env.PATH;
  process.env.PATH = "/definitely/no/programs";
  try {
    assert.throws(() => baseState({ repoPath: nonRepo }), /readable git worktree/);
  } finally {
    process.env.PATH = previousPath;
  }

  function mismatchState(label, mutate, pattern) {
    const home = tempRoot(`state-identity-${label}-`);
    const stateFile = path.join(home, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
    const state = baseState({ stateFile, runtimeRoot: path.join(home, ".claude", "state") });
    mutate(state, home);
    watcher.saveState(stateFile, state);
    const options = watcher.parseCli([
      "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
      "--transcript", fixtureTranscript, "--home", home,
      "--state-file", stateFile, "--disable-git-signal", "--hard-timeout-ms", "50",
    ]);
    fs.writeFileSync(options.cancelFile, "cancel\n", { recursive: false });
    assert.throws(() => watcher.watchLoop(options), pattern);
  }
  mismatchState("target", (state) => { state.target_session_id = "ede93c1b-6524-4020-8d89-b73aca4af2cd"; }, /another target/);
  mismatchState("supervisor", (state) => { state.supervisor_session_id = "ede93c1b-6524-4020-8d89-b73aca4af2cd"; }, /another supervisor/);
  mismatchState("runtime", (state, home) => { state.runtime_root = path.join(home, "other-runtime"); }, /runtime_root disagrees/);
  mismatchState("transcript", (state) => { state.target_transcript = path.join(fixtureRoot, "other-transcript.jsonl"); }, /transcript disagrees/);

  const noTranscript = await runCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR, "--disable-git-signal",
  ]);
  assert.equal(noTranscript.status, 1);
  assert.match(noTranscript.stderr, /--transcript is required/);
  const unknown = await runCli(["unknown-command"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command/);
  const noReview = await runCli([
    "record-review", "--home", fixtureRoot,
    "--state-file", path.join(fixtureRoot, ".claude", "state", "peer-supervision", "missing.json"),
  ]);
  assert.equal(noReview.status, 1);
  assert.match(noReview.stderr, /--review-file is required/);
});

test("duplicate delivery requires a queue receipt before notification", () => {
  const state = baseState();
  const review = reviewFixture({
    state,
    interventions: [{ body: "Do not trust an unverified duplicate.", evidence: ["Basis."] }],
  });
  let notifyCalls = 0;
  const delivered = watcher.deliverReview(state, review, {
    enqueue: () => ({ status: "duplicate", appended: false, notified: false }),
    inspect: () => 0,
    notify: () => { notifyCalls += 1; return 0; },
  });
  assert.equal(delivered.complete, false);
  assert.equal(delivered.counts.enqueued, 0);
  assert.equal(notifyCalls, 0);
});

test("H-F child processes and the waiter deadline have enforceable timeouts", async (t) => {
  const source = fs.readFileSync(path.join(__dirname, "peer-session-watch.js"), "utf8");
  const syncChildCount = (source.match(/spawnSync\(/g) || []).length;
  const hardKillCount = (source.match(/killSignal: "SIGKILL"/g) || []).length;
  assert.ok(syncChildCount > 0);
  assert.equal(hardKillCount, syncChildCount, "every synchronous child timeout must use a non-ignorable kill signal");

  const root = tempRoot("child-timeout-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const hanging = "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => process.exit(0), 1200);\nsetInterval(() => {}, 1000);\n";
  for (const name of ["git", "im-notify"]) {
    const executable = path.join(bin, name);
    fs.writeFileSync(executable, hanging, { mode: 0o755 });
    fs.chmodSync(executable, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath}`;
  try {
    const gitStarted = Date.now();
    const git = watcher.runGitHead(root, 200);
    const gitElapsed = Date.now() - gitStarted;
    const notifyStarted = Date.now();
    const notifyRc = watcher.imNotify("timeout control", 200);
    const notifyElapsed = Date.now() - notifyStarted;
    t.diagnostic(`H_F_CHILD_TIMEOUT git_status=${git.status} git_ms=${gitElapsed} notify_rc=${notifyRc} notify_ms=${notifyElapsed}`);
    assert.equal(git.status, "timeout");
    assert.equal(notifyRc, 1);
    assert.ok(gitElapsed < 700 && notifyElapsed < 700, "a synchronous child that ignores SIGTERM must still be killed within the bound");
  } finally {
    process.env.PATH = previousPath;
  }

  const home = tempRoot("hard-deadline-");
  const transcript = path.join(home, `${TARGET}.jsonl`);
  fs.writeFileSync(transcript, `${JSON.stringify({ timestamp: "2026-08-23T00:00:00Z" })}\n`);
  const stateFile = path.join(home, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
  const args = [
    path.join(__dirname, "peer-session-watch.js"), "watch",
    "--target", TARGET, "--supervisor", SUPERVISOR, "--transcript", transcript,
    "--home", home, "--state-file", stateFile, "--disable-git-signal",
    "--interval-ms", "1000", "--hard-timeout-ms", "75",
  ];
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const elapsed = Date.now() - started;
  t.diagnostic(`HARD_DEADLINE status=${result.status} elapsed_ms=${elapsed} stdout=${JSON.stringify(result.stdout.trim())}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).kind, "hard-timeout");
  assert.ok(elapsed < 500, "sleeping the full interval would violate the hard deadline");
});

test("the documented review JSON template passes the same validator used by record-review", () => {
  const command = fs.readFileSync(COMMAND, "utf8");
  const match = command.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, "supervise-session must contain one review JSON template");
  const documented = JSON.parse(match[1]);
  const state = baseState();
  documented.target_session_id = state.target_session_id;
  documented.snapshot.transcript_path = state.pending_review_snapshot.transcript_path;
  documented.snapshot.frozen_prefix_bytes = state.pending_review_snapshot.frozen_prefix_bytes;
  documented.snapshot.transcript_mtime = state.pending_review_snapshot.transcript_mtime;
  documented.snapshot.transcript_prefix_sha256 = state.pending_review_snapshot.transcript_prefix_sha256;
  assert.doesNotThrow(() => watcher.normalizeReview(documented, state));
});

test("the supervisor command documents decision 10, fork handling, event preconditions, and honest delivery scope", (t) => {
  const command = fs.readFileSync(COMMAND, "utf8");
  assert.match(command, /§6[^\n]*body/);
  assert.match(command, /§5[^\n]*evidence/);
  assert.doesNotMatch(command, /不投递 §2、§4 或 §6/);
  assert.match(command, /supersede|取代|覆盖.*给目标 session 的一切动作都经用户之手/i);
  assert.match(command, /fork/i);
  assert.match(command, /superseding child[^\n]*停止[^\n]*报告 child id/i);
  assert.match(command, /parent history[^\n]*不构成停止/i);
  assert.match(command, /\| `terminal` \|/);
  assert.match(command, /`terminal-candidate`[^\n]*`--target-pid`/);
  assert.match(command, /`ledger_stalled`[^\n]*`--ledger`[^\n]*`--target-pid`/);
  assert.doesNotMatch(command, /--runtime-root/);
  assert.match(command, /queue write-back verified/i);
  assert.match(command, /A-side[^\n]*ack/i);
  assert.match(command, /`--window 20`[^\n]*20[^\n]*activity intervals/i);
  assert.match(command, /`--git-zero-rounds 180`[^\n]*3 小时/);
  assert.match(command, /定位 transcript/);
  assert.doesNotMatch(command, /全域定位规则/);

  const mutationControls = [
    [command.replace(/此 command 对该 blob「只读边界」[^\n]+\n/, ""), (value) => assert.match(value, /给目标 session 的一切动作都经用户之手[^\n]*取代/)],
    [command.replaceAll("fork", "compaction-child"), (value) => assert.match(value, /fork/i)],
    [command.replaceAll("--target-pid", "--pid-disabled"), (value) => assert.match(value, /`terminal-candidate`[^\n]*`--target-pid`/)],
    [command.replace("| `terminal` |", "| `terminal-dropped` |"), (value) => assert.match(value, /\| `terminal` \|/)],
    [command.replaceAll("queue write-back verified", "inbox delivered"), (value) => assert.match(value, /queue write-back verified/i)],
    [`${command}\n--runtime-root`, (value) => assert.doesNotMatch(value, /--runtime-root/)],
    [command.replaceAll("activity intervals", "samples"), (value) => assert.match(value, /`--window 20`[^\n]*20[^\n]*activity intervals/i)],
    [command.replaceAll("定位 transcript", "全域定位规则"), (value) => assert.match(value, /定位 transcript/)],
  ];
  for (const [mutant, assertion] of mutationControls) assert.throws(() => assertion(mutant));
  t.diagnostic(`COMMAND_MUTATION_CONTROLS=${mutationControls.length}`);
});

test("section-5 inventory independently detects a model that under-delivers interventions", () => {
  const state = baseState();
  const underDelivered = reviewFixture({
    state,
    interventions: [{ body: "Only the first correction.", evidence: ["Only the first section-5 item."] }],
  });
  underDelivered.section5_item_ids = ["section5-1", "section5-2", "section5-3"];
  underDelivered.interventions[0].section5_item_id = "section5-1";
  underDelivered.eligible_section5_count = 1;
  assert.throws(
    () => watcher.normalizeReview(underDelivered, state),
    /section-5 inventory.*intervention/i,
    "the independent three-item inventory must make a one-item delivery report invalid",
  );
  const legacyCountOnly = reviewFixture({
    state,
    interventions: [{ body: "Mapped correction.", evidence: ["Mapped section-5 item."] }],
  });
  legacyCountOnly.eligible_section5_count = 1;
  assert.throws(() => watcher.normalizeReview(legacyCountOnly, state), /self-referential/);
});

test("state-file identity is canonical and every wake makes it obtainable", (t) => {
  const state = baseState();
  const root = tempRoot("state-file-split-");
  const canonical = path.join(root, "canonical.json");
  const wrong = path.join(root, "wrong-but-inside-root.json");
  const persisted = baseState({ stateFile: canonical });
  watcher.saveState(wrong, persisted);
  const formerInsideOnlyAccepted = path.resolve(wrong).startsWith(`${path.resolve(root)}${path.sep}`);
  t.diagnostic(`STATE_FILE_SPLIT former_inside_only_accepted=${formerInsideOnlyAccepted}`);
  assert.equal(formerInsideOnlyAccepted, true);
  assert.throws(
    () => watcher.loadState(wrong),
    /state_file.*loaded path/i,
    "loading one state through another in-root filename must be refused",
  );
  assert.throws(() => watcher.parseCli([
    "watch", "--target", TARGET, "--supervisor", SUPERVISOR,
    "--transcript", fixtureTranscript, "--home", root,
    "--state-file", path.join(root, ".claude", "state", "peer-supervision", `${TARGET}.json`),
    "--disable-git-signal",
  ]), /canonical supervisor state path/);
  assert.equal(watcher.deadlineWake(state).state_file, state.state_file);
});

test("command omits default-valued startup flags and binds tuning prose to exported constants", () => {
  const command = fs.readFileSync(COMMAND, "utf8");
  const startup = command.match(/```bash\n([\s\S]*?)\n```/);
  assert.ok(startup);
  for (const flag of ["--home", "--interval-ms", "--window", "--silence-multiplier", "--git-zero-rounds"]) {
    assert.doesNotMatch(startup[1], new RegExp(flag), `${flag} must use the program default rather than pinning prose`);
  }
  assert.match(startup[1], /--hard-timeout-ms/);
  assert.match(command, new RegExp(`--window ${watcher.DEFAULT_WINDOW_SIZE}`));
  assert.match(command, new RegExp(`--silence-multiplier ${watcher.DEFAULT_SILENCE_MULTIPLIER}`));
  assert.match(command, new RegExp(`--git-zero-rounds ${watcher.DEFAULT_GIT_ZERO_ROUNDS}`));
  assert.match(command, new RegExp(`--hard-timeout-ms ${watcher.DEFAULT_HARD_TIMEOUT_MS}`));
  assert.match(command, new RegExp(`${watcher.DEFAULT_INTERVAL_MS / 1000} 秒`));
});

test("command preflight distinguishes executable presence from notification configuration", () => {
  const command = fs.readFileSync(COMMAND, "utf8");
  assert.match(command, /im-notify[^\n]*可执行/);
  assert.match(command, /FEISHU_GENERAL_NOTIFICATION_WEBHOOK[^\n]*(?:set|configured|已配置|未配置)/i);
  assert.doesNotMatch(command, /im-notify --help[^\n]*通道[^\n]*降级/);
});

test("command explicitly narrows upstream section 6 to one draft per eligible section-5 item", () => {
  const command = fs.readFileSync(COMMAND, "utf8");
  assert.match(command, /指令草稿[^\n]*(?:override|收窄|取代)[^\n]*每(?:个|条)[^\n]*§5/i);
  assert.match(command, /每(?:个|条)[^\n]*§5[^\n]*一个[^\n]*§6/);
});

test("NEW-2 review schema uses superseding children rather than parent count", (t) => {
  const state = baseState();
  const review = reviewFixture({
    state,
    interventions: [{ body: "Correct it.", evidence: ["Section-5 basis."] }],
  });
  review.section5_item_ids = ["section5-1"];
  review.interventions[0].section5_item_id = "section5-1";
  review.fork_rechecks = [
    { stage: "pre-review", superseding_child_session_ids: [] },
    { stage: "pre-delivery", superseding_child_session_ids: [] },
  ];
  review.signal_availability = {
    activity_silence: { status: "warming-up", remaining_activity_intervals: 3 },
    ledger_stalled: { status: "disabled", reason: "ledger-not-configured" },
    git_no_commits: { status: "disabled", reason: "git-signal-disabled" },
    terminal_candidate: { status: "disabled", reason: "target-pid-not-configured" },
  };
  assert.doesNotThrow(() => watcher.normalizeReview(review, state));

  const missingForkReading = structuredClone(review);
  missingForkReading.fork_rechecks = missingForkReading.fork_rechecks.slice(0, 1);
  assert.throws(() => watcher.normalizeReview(missingForkReading, state), /fork_rechecks/);

  const superseded = structuredClone(review);
  superseded.fork_rechecks[1].superseding_child_session_ids = ["ede93c1b-6524-4020-8d89-b73aca4af2cd"];
  t.diagnostic("NEW_2_FORK no_child_count=0 superseding_child_count=1 child_id=ede93c1b-6524-4020-8d89-b73aca4af2cd");
  assert.throws(() => watcher.normalizeReview(superseded, state), /superseding child.*ede93c1b/i);
});

test("signal availability is observable in state and wakes", () => {
  const state = baseState();
  assert.equal(state.signal_availability.activity_silence.status, "warming-up");
  assert.equal(state.signal_availability.activity_silence.remaining_activity_intervals, 3);
  assert.equal(state.signal_availability.git_no_commits.status, "disabled");
  const wakeResult = watcher.deadlineWake(state);
  assert.deepEqual(wakeResult.signal_availability, state.signal_availability);
});

test("snapshot-stale is a structured CLI exit that rearms the episode", async () => {
  const root = tempRoot("snapshot-stale-cli-");
  const stateFile = path.join(root, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
  const state = baseState({ stateFile, runtimeRoot: path.join(root, ".claude", "state") });
  state.episode_signature = "activity_silence";
  state.active_signal_codes = ["activity_silence"];
  state.deep_review_triggered = true;
  watcher.saveState(stateFile, state);
  const reviewFile = path.join(root, "review.json");
  fs.writeFileSync(reviewFile, `${JSON.stringify(reviewFixture({ state }), null, 2)}\n`);
  const original = fs.readFileSync(state.target_transcript);
  try {
    fs.writeFileSync(state.target_transcript, Buffer.from(original).fill(0x20));
    const result = await runCli([
      "record-review", "--state-file", stateFile, "--review-file", reviewFile, "--home", root,
    ]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).kind, "snapshot-stale");
    const rearmed = watcher.loadState(stateFile);
    assert.equal(rearmed.deep_review_triggered, false);
    assert.equal(rearmed.episode_signature, "");
  } finally {
    fs.writeFileSync(state.target_transcript, original);
  }
});

test("command structure names every disposition and avoids claims beyond its readings", () => {
  const command = fs.readFileSync(COMMAND, "utf8");
  const description = command.match(/^description: (.+)$/m)[1];
  assert.doesNotMatch(description, /Phase 2|settings\.json|best-effort|stop\/resume/i);
  assert.match(command.slice(command.indexOf("---", 4) + 3), /Phase 2[^\n]*settings\.json/);
  assert.match(command, /argument-hint: "<complete target session UUID>"/);
  assert.match(command, /不适用[^\n]*review-session-progress|NOT FOR[^\n]*review-session-progress/i);
  assert.match(command, /REVIEW_COMMAND_BLOBS/);
  assert.doesNotMatch(command, /episode_signature.*正文|正文.*episode_signature/);
  assert.match(command, /already-watching[^\n]*owner_pid[^\n]*deadline_at/);
  assert.match(command, /snapshot-stale[^\n]*(?:停止|重取|重新采样)/);
  assert.match(command, /ledger_stalled[^\n]*(?:baseline|warm|预热)/i);
  assert.match(command, /git_status[^\n]*ok[^\n]*(?:每轮|连续)/i);
  assert.match(command, /im-notify exit[- ]?zero/i);
  assert.doesNotMatch(command, /Feishu/);
  assert.match(command, /background-agent-monitoring\.md/);
  assert.match(command, /四个计数[\s\S]{0,240}(?:自一致|self-consistent)/i);
  assert.match(command, /不能[\s\S]{0,160}(?:§5|section-5)[\s\S]{0,160}(?:完整转录|transcrib)/i);
  assert.ok((command.match(/^### /gm) || []).length >= 4, "the long execution block must be split into scannable stages");
});

test("ADR records the model-bound completeness boundary, upgrade path, and scoped limitations", () => {
  const adr = fs.readFileSync(ADR, "utf8");
  assert.match(adr, /四个计数[\s\S]{0,240}(?:自一致|self-consistent)/i);
  assert.match(adr, /不能[\s\S]{0,200}(?:§5|section-5)[\s\S]{0,200}(?:完整转录|transcrib)/i);
  assert.match(adr, /machine-known[\s\S]{0,240}(?:生成|persist|注入)/i);
  assert.match(adr, /semantic judgement[\s\S]{0,240}canonical source/i);
  assert.match(adr, /receipt \/ context id/i);
  for (const limitation of [
    "signal_availability",
    "pending_review_snapshot",
    "fencing",
    "review-recorded",
    "canonical formula",
  ]) assert.match(adr, new RegExp(limitation, "i"));
});

test("delivery count names expose the producer-side measurement sites", () => {
  const state = baseState();
  const review = reviewFixture({ state, interventions: [{ body: "Correct it.", evidence: ["Basis."] }] });
  const delivered = watcher.deliverReview(state, review, {
    homeDir: tempRoot("count-names-"),
    notify: () => 0,
  });
  assert.equal("intervention_notify_accepted" in delivered.counts, false);
  assert.equal(delivered.counts.intervention_im_notify_exit_zero, 1);
});

test("real CLI record/deliver succeeds and retries notify without duplicate enqueue", async () => {
  const root = tempRoot("cli-e2e-");
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const notify = path.join(bin, "im-notify");
  fs.writeFileSync(notify, `#!/bin/sh
if [ -n "\${IM_NOTIFY_COUNT_FILE:-}" ]; then
  count=0
  if [ -f "$IM_NOTIFY_COUNT_FILE" ]; then count=$(cat "$IM_NOTIFY_COUNT_FILE"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$IM_NOTIFY_COUNT_FILE"
  if [ "$count" = "\${IM_NOTIFY_FAIL_ON_CALL:-0}" ]; then exit 1; fi
fi
exit "\${IM_NOTIFY_RC:-0}"
`, { mode: 0o755 });
  fs.chmodSync(notify, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  async function setup(label, { terminal = false, interventions = [{ body: `Correct ${label}.`, evidence: [`Basis ${label}.`] }] } = {}) {
    const home = path.join(root, label);
    const stateFile = path.join(home, ".claude", "state", "peer-supervision", `${SUPERVISOR}.json`);
    const state = baseState({ stateFile, runtimeRoot: path.join(home, ".claude", "state") });
    const review = reviewFixture({ state, terminal, interventions });
    const reviewFile = path.join(home, "review.json");
    fs.mkdirSync(home, { recursive: true });
    watcher.saveState(stateFile, state);
    fs.writeFileSync(reviewFile, `${JSON.stringify(review, null, 2)}\n`);
    return { home, stateFile, reviewFile };
  }

  const success = await setup("success");
  const recorded = await runCli(["record-review", "--state-file", success.stateFile, "--review-file", success.reviewFile, "--home", success.home], { env });
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.equal(JSON.parse(recorded.stdout).kind, "review-recorded");
  const delivered = await runCli(["deliver-review", "--state-file", success.stateFile, "--review-file", success.reviewFile, "--home", success.home], { env });
  assert.equal(delivered.status, 0, delivered.stderr);
  assert.equal(JSON.parse(delivered.stdout).kind, "delivery-complete");

  const retry = await setup("retry");
  const retryRecorded = await runCli(["record-review", "--state-file", retry.stateFile, "--review-file", retry.reviewFile, "--home", retry.home], { env });
  assert.equal(retryRecorded.status, 0, retryRecorded.stderr);
  const failed = await runCli(["deliver-review", "--state-file", retry.stateFile, "--review-file", retry.reviewFile, "--home", retry.home], {
    env: { ...env, IM_NOTIFY_RC: "1" },
  });
  assert.equal(failed.status, 1);
  assert.equal(JSON.parse(failed.stdout).kind, "delivery-incomplete");
  const retried = await runCli(["deliver-review", "--state-file", retry.stateFile, "--review-file", retry.reviewFile, "--home", retry.home], { env });
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(JSON.parse(retried.stdout).kind, "delivery-complete");
  const queue = fs.readFileSync(inbox.pathsFor(retry.home, TARGET).queue, "utf8").trim().split("\n");
  assert.equal(queue.length, 1, "notify retry must not append the intervention twice");

  const empty = await setup("empty", { interventions: [] });
  const emptyDelivery = await runCli([
    "deliver-review", "--state-file", empty.stateFile, "--review-file", empty.reviewFile, "--home", empty.home,
  ], { env });
  assert.equal(emptyDelivery.status, 0, emptyDelivery.stderr);
  assert.equal(JSON.parse(emptyDelivery.stdout).kind, "delivery-empty");

  const completionFailure = await setup("completion-failure", {
    terminal: true,
    interventions: [{ body: "Complete after this correction.", evidence: ["Completion basis."] }],
  });
  const notifyCountFile = path.join(completionFailure.home, "notify-count");
  const completionPending = await runCli([
    "deliver-review", "--state-file", completionFailure.stateFile,
    "--review-file", completionFailure.reviewFile, "--home", completionFailure.home,
  ], {
    env: { ...env, IM_NOTIFY_COUNT_FILE: notifyCountFile, IM_NOTIFY_FAIL_ON_CALL: "2" },
  });
  assert.equal(completionPending.status, 1, completionPending.stderr);
  assert.equal(JSON.parse(completionPending.stdout).kind, "completion-pending-notify");
  assert.equal(fs.readFileSync(notifyCountFile, "utf8").trim(), "2");
});

function reviewFixture({
  state = baseState(),
  interventions = [],
  terminal = false,
  input_tokens = 10,
  output_tokens = 5,
  targetSessionId = state.target_session_id,
  transcriptPath = state.pending_review_snapshot.transcript_path,
} = {}) {
  const normalizedInterventions = interventions.map((intervention, index) => ({
    section5_item_id: `section5-${index + 1}`,
    body_source: "review-session-progress.section6_instruction_draft",
    evidence_source: "review-session-progress.section5_intervention",
    has_user_decidable_spots: false,
    ...intervention,
  }));
  const decision = terminal ? {
    original_goals_covered: true,
    no_owner_self_remaining: true,
    no_in_flight_work: true,
    no_pending_user_decision_or_blocker: true,
  } : {
    original_goals_covered: false,
    no_owner_self_remaining: "unknown",
    no_in_flight_work: "unknown",
    no_pending_user_decision_or_blocker: "unknown",
  };
  return {
    schema_version: 1,
    review_id: "review-001",
    created_at: "2026-08-23T00:10:00Z",
    target_session_id: targetSessionId,
    snapshot: {
      transcript_path: transcriptPath,
      frozen_prefix_bytes: state.pending_review_snapshot.frozen_prefix_bytes,
      transcript_mtime: state.pending_review_snapshot.transcript_mtime,
      transcript_prefix_sha256: state.pending_review_snapshot.transcript_prefix_sha256,
      review_command_blob: "39ae61d7eca4d6d86d8282275aa44b10b7eac88d",
    },
    section5_item_ids: normalizedInterventions.map((item) => item.section5_item_id),
    interventions: normalizedInterventions,
    fork_rechecks: [
      { stage: "pre-review", superseding_child_session_ids: [] },
      { stage: "pre-delivery", superseding_child_session_ids: [] },
    ],
    signal_availability: structuredClone(state.signal_availability),
    terminal_decision: decision,
    review_evidence: ["fixture evidence"],
    model: { id: "fixture-model", input_tokens, output_tokens },
  };
}
