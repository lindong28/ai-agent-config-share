#!/usr/bin/env node
/**
 * Deterministic sampler for best-effort peer session supervision.
 *
 * The watch loop performs no model calls. Healthy samples stay inside this
 * process and produce no output; only a typed wake result returns control to
 * the supervising Claude Code session. This is a behavioral aid, not a
 * security boundary, and it never stops, resumes, or edits the target session.
 */

"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { enqueueMessage, inspectQueueRecords, pathsFor } = require("../hooks/session-inbox");
const { CLAUDE_SESSION_ID } = require("../hooks/lib/session-id");

const VERSION = 1;
const REVIEW_COMMAND_BLOBS = [
  "39ae61d7eca4d6d86d8282275aa44b10b7eac88d",
];
const REVIEW_COMMAND_BLOB = REVIEW_COMMAND_BLOBS[0];
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_SILENCE_MULTIPLIER = 20;
const DEFAULT_GIT_ZERO_ROUNDS = 180;
const DEFAULT_HARD_TIMEOUT_MS = 6 * 60 * 60_000;
const DEFAULT_CHILD_TIMEOUT_MS = 30_000;
const WATCHER_CLAIM_LEASE_MS = DEFAULT_HARD_TIMEOUT_MS + 5 * 60_000;
const VALID_SUPERVISOR = CLAUDE_SESSION_ID;
const VALID_TARGET = CLAUDE_SESSION_ID;

function iso(value) {
  return new Date(value).toISOString();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function uniqueSorted(codes) {
  return [...new Set(codes)].sort();
}

function signalAvailability(state) {
  const observation = state.observation;
  const remainingActivityIntervals = Math.max(
    0,
    state.config.window_size - observation.activity_intervals_ms.length,
  );
  const activity = remainingActivityIntervals > 0
    ? { status: "warming-up", remaining_activity_intervals: remainingActivityIntervals }
    : { status: "armed" };
  let ledger;
  if (!state.ledger_path) ledger = { status: "disabled", reason: "ledger-not-configured" };
  else if (!state.target_pid) ledger = { status: "disabled", reason: "target-pid-not-configured" };
  else if (observation.ledger_status === "unavailable") ledger = { status: "disabled", reason: "ledger-unavailable-this-round" };
  else ledger = remainingActivityIntervals > 0
    ? { status: "warming-up", remaining_activity_intervals: remainingActivityIntervals }
    : { status: "armed" };
  let git;
  if (!state.repo_path) git = { status: "disabled", reason: "git-signal-disabled" };
  else if (observation.git_status === "unavailable" || observation.git_status === "timeout") {
    git = { status: "disabled", reason: "git-unavailable-this-round" };
  } else {
    const remainingRounds = Math.max(0, state.config.git_zero_rounds - observation.git_zero_rounds);
    git = remainingRounds > 0
      ? { status: "warming-up", remaining_rounds: remainingRounds }
      : { status: "armed" };
  }
  return {
    activity_silence: activity,
    ledger_stalled: ledger,
    git_no_commits: git,
    terminal_candidate: state.target_pid
      ? { status: "armed" }
      : { status: "disabled", reason: "target-pid-not-configured" },
  };
}

function createState({
  supervisorSessionId,
  targetSessionId,
  targetTranscript,
  stateFile,
  ledgerPath = null,
  repoPath = null,
  targetPid = null,
  runtimeRoot = path.join(os.homedir(), ".claude", "state"),
  intervalMs = DEFAULT_INTERVAL_MS,
  hardTimeoutMs = DEFAULT_HARD_TIMEOUT_MS,
  windowSize = DEFAULT_WINDOW_SIZE,
  silenceMultiplier = DEFAULT_SILENCE_MULTIPLIER,
  gitZeroRounds = DEFAULT_GIT_ZERO_ROUNDS,
  acceptedReviewCommandBlobs = REVIEW_COMMAND_BLOBS,
  nowMs = Date.now(),
} = {}) {
  if (!VALID_SUPERVISOR.test(supervisorSessionId || "")) throw new Error("invalid supervisor session id");
  if (!VALID_TARGET.test(targetSessionId || "")) {
    throw new Error("invalid target session id");
  }
  for (const [name, value] of Object.entries({ intervalMs, hardTimeoutMs, windowSize, silenceMultiplier, gitZeroRounds })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  }
  if (typeof targetTranscript !== "string" || !fs.statSync(targetTranscript).isFile()) {
    throw new Error("target transcript must resolve to a readable file");
  }
  if (ledgerPath !== null && (typeof ledgerPath !== "string" || !fs.statSync(ledgerPath).isFile())) {
    throw new Error("ledger path must resolve to a readable file");
  }
  if (repoPath !== null) validateRepoPath(repoPath);
  if (targetPid !== null && processAlive(targetPid) !== true) throw new Error("target pid is not alive");
  if (!Array.isArray(acceptedReviewCommandBlobs) ||
      JSON.stringify([...new Set(acceptedReviewCommandBlobs)]) !== JSON.stringify(REVIEW_COMMAND_BLOBS)) {
    throw new Error("accepted review command blobs must equal the ref-reachable accepted review command blob set");
  }
  const state = {
    version: VERSION,
    supervisor_session_id: supervisorSessionId,
    target_session_id: targetSessionId,
    target_transcript: targetTranscript,
    ledger_path: ledgerPath,
    repo_path: repoPath,
    target_pid: targetPid,
    runtime_root: runtimeRoot,
    accepted_review_command_blobs: [...new Set(acceptedReviewCommandBlobs)],
    state_file: stateFile,
    state: "watching",
    active_signal_codes: [],
    episode_signature: "",
    deep_review_triggered: false,
    terminal_review_triggered: false,
    waiter_started_at: iso(nowMs),
    waiter_deadline_at: iso(nowMs + hardTimeoutMs),
    config: {
      interval_ms: intervalMs,
      hard_timeout_ms: hardTimeoutMs,
      window_size: windowSize,
      silence_multiplier: silenceMultiplier,
      git_zero_rounds: gitZeroRounds,
    },
    observation: {
      last_activity_at: null,
      activity_intervals_ms: [],
      transcript_offset: 0,
      transcript_bytes: 0,
      transcript_mtime: null,
      ledger_mtime_ms: null,
      ledger_status: ledgerPath ? "pending" : "disabled",
      git_head: null,
      git_zero_rounds: 0,
      git_status: repoPath ? "pending" : "disabled",
      target_process_status: targetPid ? "pending" : "disabled",
      sampled_at: null,
    },
    counters: {
      healthy_ticks: 0,
      anomaly_candidates: 0,
      terminal_candidates: 0,
      hard_timeouts: 0,
      cancellations: 0,
    },
    token_usage: {
      deep_input_tokens: 0,
      deep_output_tokens: 0,
      deep_total_tokens: 0,
    },
    model_calls: { deep_reviews: 0 },
    latest_review: null,
    review_fingerprints: {},
    review_usage: {},
    delivery_records: {},
    pending_review_snapshot: null,
    completion_report: null,
    next_completion_notify_at: null,
    completion_notify_deadline_at: null,
    updated_at: iso(nowMs),
  };
  state.state_file = path.resolve(state.state_file);
  state.signal_availability = signalAvailability(state);
  return state;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function wake(kind, state, extra = {}) {
  return {
    kind,
    target_session_id: state.target_session_id,
    state_file: state.state_file,
    state: state.state,
    active_signal_codes: [...state.active_signal_codes],
    episode_signature: state.episode_signature,
    signal_availability: clone(state.signal_availability),
    ...extra,
  };
}

function transitionSignals(input, signalCodes) {
  const state = clone(input);
  const codes = uniqueSorted(signalCodes);
  const signature = codes.join("+");
  state.active_signal_codes = codes;
  state.updated_at = iso(Date.now());

  if (!signature) {
    state.state = "healthy";
    state.episode_signature = "";
    state.deep_review_triggered = false;
    state.counters.healthy_ticks += 1;
    return { state, wake: null };
  }

  const changed = signature !== state.episode_signature;
  if (changed) {
    state.episode_signature = signature;
    state.deep_review_triggered = false;
  }
  state.state = "anomaly-candidate";
  if (!state.deep_review_triggered) {
    state.deep_review_triggered = true;
    state.counters.anomaly_candidates += 1;
    return { state, wake: wake("anomaly-candidate", state) };
  }
  return { state, wake: null };
}

function markDeepReviewTriggered(input) {
  const state = clone(input);
  state.deep_review_triggered = true;
  return state;
}

function rearmAfterSnapshotStale(input) {
  const state = clone(input);
  state.state = "watching";
  state.active_signal_codes = [];
  state.episode_signature = "";
  state.deep_review_triggered = false;
  state.pending_review_snapshot = null;
  state.updated_at = iso(Date.now());
  return state;
}

function advance(input, sample) {
  const state = clone(input);
  const observation = state.observation;
  const sampleAt = Date.parse(sample.sampled_at);
  const activityAt = Date.parse(sample.last_activity_at);
  if (!Number.isFinite(sampleAt) || !Number.isFinite(activityAt)) throw new Error("sample timestamps must be valid");

  const previousActivity = observation.last_activity_at && Date.parse(observation.last_activity_at);
  if (Number.isFinite(previousActivity) && activityAt > previousActivity) {
    observation.activity_intervals_ms.push(activityAt - previousActivity);
    observation.activity_intervals_ms = observation.activity_intervals_ms.slice(-state.config.window_size);
  }
  if (!Number.isFinite(previousActivity) || activityAt > previousActivity) {
    observation.last_activity_at = iso(activityAt);
  }

  if (sample.ledger_mtime_ms !== null && Number.isFinite(sample.ledger_mtime_ms)) {
    observation.ledger_mtime_ms = sample.ledger_mtime_ms;
  }
  observation.ledger_status = sample.ledger_status || (state.ledger_path ? "unavailable" : "disabled");
  observation.git_status = sample.git_status || (state.repo_path ? "unavailable" : "disabled");
  observation.target_process_status = sample.target_process_status || (state.target_pid ? "unavailable" : "disabled");
  observation.transcript_bytes = sample.transcript_bytes ?? observation.transcript_bytes;
  observation.transcript_mtime = sample.transcript_mtime ?? observation.transcript_mtime;
  observation.transcript_offset = sample.transcript_offset ?? observation.transcript_offset;
  if (observation.git_status !== "ok") observation.git_zero_rounds = 0;
  if (observation.git_status === "ok" && typeof sample.git_head === "string" && sample.git_head) {
    if (observation.git_head === null || observation.git_head !== sample.git_head) {
      observation.git_head = sample.git_head;
      observation.git_zero_rounds = 0;
    } else {
      observation.git_zero_rounds += 1;
    }
  }
  observation.sampled_at = iso(sampleAt);
  state.signal_availability = signalAvailability(state);

  if (sample.target_alive === true) state.terminal_review_triggered = false;
  if (sample.target_alive === false && !state.terminal_review_triggered) {
    state.state = "terminal-candidate";
    state.terminal_review_triggered = true;
    state.counters.terminal_candidates += 1;
    state.pending_review_snapshot = {
      transcript_path: state.target_transcript,
      frozen_prefix_bytes: observation.transcript_bytes,
      transcript_mtime: observation.transcript_mtime,
      transcript_offset: observation.transcript_offset,
    };
    state.updated_at = iso(sampleAt);
    return {
      state,
      wake: wake("terminal-candidate", state, {
        reason: "target-process-exited",
        snapshot: clone(state.pending_review_snapshot),
      }),
    };
  }

  const codes = [];
  const enoughActivity = observation.activity_intervals_ms.length >= state.config.window_size;
  const baseline = enoughActivity ? median(observation.activity_intervals_ms) : null;
  const silence = sampleAt - Date.parse(observation.last_activity_at);
  if (baseline !== null && baseline > 0 && silence > state.config.silence_multiplier * baseline) {
    codes.push("activity_silence");
  }
  if (
    baseline !== null &&
    baseline > 0 &&
    observation.ledger_status === "ok" &&
    observation.ledger_mtime_ms !== null &&
    sample.target_alive === true &&
    sampleAt - observation.ledger_mtime_ms > state.config.silence_multiplier * baseline &&
    Date.parse(observation.last_activity_at) > observation.ledger_mtime_ms
  ) {
    codes.push("ledger_stalled");
  }
  if (observation.git_status === "ok" && observation.git_zero_rounds >= state.config.git_zero_rounds) {
    codes.push("git_no_commits");
  }

  const transitioned = transitionSignals(state, codes);
  transitioned.state.observation = observation;
  transitioned.state.updated_at = iso(sampleAt);
  if (transitioned.wake) {
    transitioned.state.pending_review_snapshot = {
      transcript_path: state.target_transcript,
      frozen_prefix_bytes: observation.transcript_bytes,
      transcript_mtime: observation.transcript_mtime,
      transcript_offset: observation.transcript_offset,
    };
    transitioned.wake.snapshot = clone(transitioned.state.pending_review_snapshot);
    if (codes.includes("activity_silence") || codes.includes("ledger_stalled")) {
      transitioned.wake.activity_baseline_ms = baseline;
      transitioned.wake.activity_silence_ms = silence;
    }
  }
  return transitioned;
}

function deadlineWake(input) {
  const state = clone(input);
  state.state = "hard-timeout";
  state.counters.hard_timeouts += 1;
  return wake("hard-timeout", state, { waiter_deadline_at: state.waiter_deadline_at });
}

function cancelledWake(input) {
  const state = clone(input);
  state.state = "cancelled";
  state.counters.cancellations += 1;
  return wake("cancelled", state);
}

function saveState(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function loadState(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const valid = value && value.version === VERSION && VALID_TARGET.test(value.target_session_id || "") &&
    VALID_SUPERVISOR.test(value.supervisor_session_id || "") &&
    typeof value.target_transcript === "string" && typeof value.runtime_root === "string" &&
    typeof value.state_file === "string" && path.resolve(value.state_file) === path.resolve(file) &&
    Number.isFinite(Date.parse(value.waiter_deadline_at)) &&
    value.config && Object.values(value.config).every((entry) => Number.isInteger(entry) && entry > 0) &&
    value.observation && value.counters && value.token_usage && value.model_calls &&
    Array.isArray(value.active_signal_codes) && typeof value.episode_signature === "string" &&
    Array.isArray(value.accepted_review_command_blobs) &&
    JSON.stringify(value.accepted_review_command_blobs) === JSON.stringify(REVIEW_COMMAND_BLOBS) &&
    value.delivery_records && value.review_fingerprints && value.review_usage &&
    value.signal_availability && typeof value.signal_availability === "object";
  if (!valid) {
    if (value && typeof value.state_file === "string" && path.resolve(value.state_file) !== path.resolve(file)) {
      throw new Error(`state_file ${value.state_file} does not match loaded path ${path.resolve(file)}`);
    }
    throw new Error("invalid peer-supervision state");
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function reviewFingerprint(review) {
  return crypto.createHash("sha256").update(stableStringify(review)).digest("hex");
}

function filePrefixSha256(file, byteCount) {
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    if (stat.size < byteCount) throw new Error("target transcript is shorter than the frozen review boundary");
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, byteCount)));
    let offset = 0;
    while (offset < byteCount) {
      const length = Math.min(buffer.length, byteCount - offset);
      const read = fs.readSync(descriptor, buffer, 0, length, offset);
      if (read !== length) throw new Error("target transcript changed while its frozen boundary was read");
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function bindSnapshotIntegrity(state, wakeResult) {
  if (!wakeResult || !wakeResult.snapshot) return wakeResult;
  const snapshot = {
    ...wakeResult.snapshot,
    transcript_prefix_sha256: filePrefixSha256(state.target_transcript, wakeResult.snapshot.frozen_prefix_bytes),
  };
  state.pending_review_snapshot = clone(snapshot);
  wakeResult.snapshot = clone(snapshot);
  return wakeResult;
}

function normalizeReview(value, state) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review must be an object");
  if (value.schema_version !== 1) throw new Error("unsupported review schema_version");
  if (!state || value.target_session_id !== state.target_session_id) {
    throw new Error("review target_session_id does not match supervised target");
  }
  const requiredStrings = ["review_id", "created_at"];
  for (const key of requiredStrings) if (typeof value[key] !== "string" || !value[key]) throw new Error(`invalid ${key}`);
  if (!/^[A-Za-z0-9._:-]+$/.test(value.review_id) || !Number.isFinite(Date.parse(value.created_at))) {
    throw new Error("review id/timestamp cannot form a transport record");
  }
  const acceptedBlobs = state.accepted_review_command_blobs || REVIEW_COMMAND_BLOBS;
  if (
    !value.snapshot ||
    typeof value.snapshot.transcript_path !== "string" ||
    !Number.isInteger(value.snapshot.frozen_prefix_bytes) ||
    value.snapshot.frozen_prefix_bytes < 0 ||
    !Number.isFinite(Date.parse(value.snapshot.transcript_mtime)) ||
    !/^[0-9a-f]{64}$/.test(value.snapshot.transcript_prefix_sha256 || "")
  ) {
    throw new Error("review snapshot is invalid");
  }
  if (Object.hasOwn(value.snapshot, "transcript_bytes") || Object.hasOwn(value.snapshot, "transcript_sha256")) {
    throw new Error("legacy whole-transcript snapshot field names are not accepted");
  }
  if (!acceptedBlobs.includes(value.snapshot.review_command_blob)) {
    throw new Error(
      `review_command_blob mismatch: expected one of ${acceptedBlobs.join(",")} found ${value.snapshot.review_command_blob}`,
    );
  }
  const expected = state.pending_review_snapshot;
  if (!expected || path.resolve(value.snapshot.transcript_path) !== path.resolve(state.target_transcript) ||
      path.resolve(value.snapshot.transcript_path) !== path.resolve(expected.transcript_path)) {
    throw new Error("review snapshot transcript_path does not match the triggering target snapshot");
  }
  if (value.snapshot.frozen_prefix_bytes !== expected.frozen_prefix_bytes ||
      value.snapshot.transcript_mtime !== expected.transcript_mtime ||
      value.snapshot.transcript_prefix_sha256 !== expected.transcript_prefix_sha256) {
    throw new Error("review snapshot does not match the transcript position that triggered this episode");
  }
  const current = fs.statSync(state.target_transcript);
  if (current.size < value.snapshot.frozen_prefix_bytes ||
      filePrefixSha256(state.target_transcript, value.snapshot.frozen_prefix_bytes) !== value.snapshot.transcript_prefix_sha256) {
    const error = new Error("review snapshot frozen prefix no longer matches the target transcript");
    error.code = "SNAPSHOT_STALE";
    throw error;
  }
  if (!Array.isArray(value.section5_item_ids) ||
      new Set(value.section5_item_ids).size !== value.section5_item_ids.length ||
      !value.section5_item_ids.every((itemId) => /^section5-[1-9][0-9]*$/.test(itemId))) {
    throw new Error("invalid section-5 inventory item ids");
  }
  if (!Array.isArray(value.interventions) || !value.interventions.every((item) =>
    item && value.section5_item_ids.includes(item.section5_item_id) &&
      typeof item.body === "string" && item.body.trim() && Array.isArray(item.evidence) &&
      item.evidence.length > 0 && item.evidence.every((entry) => typeof entry === "string" && entry.trim()) &&
      item.body_source === "review-session-progress.section6_instruction_draft" &&
      item.evidence_source === "review-session-progress.section5_intervention" &&
      typeof item.has_user_decidable_spots === "boolean")) {
    throw new Error("invalid interventions: section-6 body and section-5 evidence sources are required");
  }
  const interventionIds = value.interventions.map((item) => item.section5_item_id);
  if (new Set(interventionIds).size !== interventionIds.length ||
      stableStringify([...interventionIds].sort()) !== stableStringify([...value.section5_item_ids].sort())) {
    throw new Error("section-5 inventory does not match intervention coverage");
  }
  if (Object.hasOwn(value, "eligible_section5_count")) {
    throw new Error("eligible_section5_count is self-referential; section5_item_ids is authoritative");
  }
  const requiredForkStages = ["pre-review", "pre-delivery"];
  if (!Array.isArray(value.fork_rechecks) || value.fork_rechecks.length !== requiredForkStages.length ||
      requiredForkStages.some((stage) => !value.fork_rechecks.some((entry) => entry && entry.stage === stage &&
        Array.isArray(entry.superseding_child_session_ids) &&
        new Set(entry.superseding_child_session_ids).size === entry.superseding_child_session_ids.length &&
        entry.superseding_child_session_ids.every((sessionId) => VALID_TARGET.test(sessionId))))) {
    throw new Error("fork_rechecks must record superseding child session ids at pre-review and pre-delivery");
  }
  const supersedingChildren = [...new Set(value.fork_rechecks.flatMap((entry) => entry.superseding_child_session_ids))];
  if (supersedingChildren.length > 0) {
    throw new Error(`fork recheck found superseding child session(s): ${supersedingChildren.join(",")}`);
  }
  if (!value.signal_availability || stableStringify(value.signal_availability) !== stableStringify(state.signal_availability)) {
    throw new Error("review signal_availability does not match the triggering watcher state");
  }
  if (
    Object.hasOwn(value, "evidence") ||
    !Array.isArray(value.review_evidence) ||
    value.review_evidence.length === 0 ||
    !value.review_evidence.every((entry) => typeof entry === "string" && entry.trim()) ||
    !value.model ||
    typeof value.model.id !== "string" ||
    !value.model.id.trim()
  ) throw new Error("invalid review_evidence/model");
  for (const key of ["input_tokens", "output_tokens"]) {
    if (!Number.isInteger(value.model[key]) || value.model[key] < 0) throw new Error(`invalid model.${key}`);
  }
  const terminalKeys = [
    "original_goals_covered",
    "no_owner_self_remaining",
    "no_in_flight_work",
    "no_pending_user_decision_or_blocker",
  ];
  if (!value.terminal_decision || terminalKeys.some((key) => ![true, false, "unknown"].includes(value.terminal_decision[key]))) {
    throw new Error("invalid terminal_decision");
  }
  return clone(value);
}

function recordReview(input, reviewValue) {
  const state = clone(input);
  const review = normalizeReview(reviewValue, state);
  const fingerprint = reviewFingerprint(review);
  const previous = state.review_fingerprints[review.review_id];
  if (previous && previous !== fingerprint) {
    throw new Error(`review_id ${review.review_id} was reused with different content`);
  }
  if (!previous) {
    state.review_fingerprints[review.review_id] = fingerprint;
    state.token_usage.deep_input_tokens += review.model.input_tokens;
    state.token_usage.deep_output_tokens += review.model.output_tokens;
    state.token_usage.deep_total_tokens = state.token_usage.deep_input_tokens + state.token_usage.deep_output_tokens;
    state.model_calls.deep_reviews += 1;
    state.review_usage[review.review_id] = clone(review.model);
    state.latest_review = { ...review, review_fingerprint: fingerprint };
  }
  state.state = "watching";
  state.updated_at = iso(Date.now());
  return state;
}

function deliverReview(input, reviewValue, { homeDir = os.homedir(), enqueue, notify = () => 1, inspect } = {}) {
  const state = recordReview(input, reviewValue);
  const review = state.latest_review;
  const delivery = state.delivery_records[review.review_id] || {};
  let enqueued = 0;
  let notifyAccepted = 0;
  const expectedRecords = [];
  const enqueueRecord = enqueue || ((record) => enqueueMessage({ homeDir, sessionId: state.target_session_id, record }));
  const inspectRecords = inspect || ((records) => inspectQueueRecords({
    homeDir,
    sessionId: state.target_session_id,
    records,
  }));

  for (let index = 0; index < review.interventions.length; index += 1) {
    const key = review.interventions[index].section5_item_id;
    const prior = delivery[key] || {};
    const record = {
      id: `${review.review_id}-${key}`,
      from: `supervisor:${state.supervisor_session_id}`,
      ts: review.created_at,
      body: review.interventions[index].body,
      evidence: review.interventions[index].evidence,
      has_user_decidable_spots: review.interventions[index].has_user_decidable_spots,
    };
    expectedRecords.push(record);
    const fingerprint = crypto.createHash("sha256").update(stableStringify(record)).digest("hex");
    const enqueueResult = enqueueRecord(record, state);
    const acceptedEnqueue = enqueueResult.status === "enqueued" ||
      (enqueueResult.status === "duplicate" && inspectRecords([record]) === 1);
    if (acceptedEnqueue) {
      enqueued += 1;
      prior.enqueued = true;
      prior.transport_id = record.id;
      prior.record_fingerprint = fingerprint;
    }
    if (acceptedEnqueue && (prior.notify_accepted || notify(record, state) === 0)) {
      notifyAccepted += 1;
      prior.notify_accepted = true;
    }
    delivery[key] = prior;
  }
  state.delivery_records[review.review_id] = delivery;
  const queueWriteBackVerified = inspectRecords(expectedRecords);
  const counts = {
    eligible_section5: review.section5_item_ids.length,
    enqueued,
    queue_write_back_verified: queueWriteBackVerified,
    intervention_im_notify_exit_zero: notifyAccepted,
  };
  const complete = counts.eligible_section5 > 0 &&
    [counts.enqueued, counts.queue_write_back_verified, counts.intervention_im_notify_exit_zero]
      .every((count) => count === counts.eligible_section5);
  state.latest_review.delivery_counts = counts;
  state.latest_review.delivery_complete = complete;
  return { state, review: state.latest_review, counts, complete };
}

function terminalDecisionIsComplete(decision) {
  return [
    "original_goals_covered",
    "no_owner_self_remaining",
    "no_in_flight_work",
    "no_pending_user_decision_or_blocker",
  ].every((key) => decision[key] === true);
}

function finishReview(input, reviewValue, { stateFile, completionNotify, nowMs = Date.now() } = {}) {
  let state = recordReview(input, reviewValue);
  const review = state.latest_review;
  if (!terminalDecisionIsComplete(review.terminal_decision)) return { state, completion_notify_accepted: false };
  state.state = "completion-pending-notify";
  state.completion_report = {
    review_id: review.review_id,
    target_session_id: state.target_session_id,
    terminal_decision: review.terminal_decision,
    review_evidence: review.review_evidence,
    delivery_counts: review.delivery_counts || null,
    delivery_complete: review.delivery_complete === true,
    persisted_at: iso(nowMs),
  };
  saveState(stateFile, state);
  const accepted = completionNotify(state.completion_report, state) === 0;
  if (accepted) {
    state.state = "terminal";
    state.next_completion_notify_at = null;
    state.completion_notify_deadline_at = null;
  } else {
    state.state = "completion-pending-notify";
    state.next_completion_notify_at = iso(nowMs + Math.min(state.config.interval_ms * 2, 15 * 60_000));
    state.completion_notify_deadline_at = iso(nowMs + state.config.hard_timeout_ms);
  }
  saveState(stateFile, state);
  return { state, completion_notify_accepted: accepted };
}

function retryCompletionNotification(input, { stateFile, completionNotify, nowMs = Date.now() } = {}) {
  const state = clone(input);
  if (state.state !== "completion-pending-notify" || !state.completion_report) {
    return { state, completion_notify_accepted: false, attempted: false };
  }
  const dueAt = Date.parse(state.next_completion_notify_at);
  if (Number.isFinite(dueAt) && nowMs < dueAt) {
    return { state, completion_notify_accepted: false, attempted: false };
  }
  const accepted = completionNotify(state.completion_report, state) === 0;
  if (accepted) {
    state.state = "terminal";
    state.next_completion_notify_at = null;
    state.completion_notify_deadline_at = null;
  } else {
    state.next_completion_notify_at = iso(nowMs + Math.min(state.config.interval_ms * 2, 15 * 60_000));
  }
  state.updated_at = iso(nowMs);
  saveState(stateFile, state);
  return { state, completion_notify_accepted: accepted, attempted: true };
}

function values(args, flag) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) if (args[index] === flag) out.push(args[index + 1]);
  return out;
}

function one(args, flag, fallback = null) {
  const found = values(args, flag);
  if (found.length > 1) throw new Error(`${flag} may appear only once`);
  return found.length ? found[0] : fallback;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function flagPresent(args, flag) {
  return args.includes(flag);
}

function pathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseCli(argv) {
  const command = argv[0] || "watch";
  const valueFlags = new Set([
    "--target", "--supervisor", "--transcript", "--home", "--runtime-root", "--state-file",
    "--repo", "--ledger", "--target-pid", "--interval-ms", "--hard-timeout-ms", "--window",
    "--silence-multiplier", "--git-zero-rounds", "--review-file", "--child-timeout-ms",
  ]);
  const booleanFlags = new Set(["--disable-git-signal"]);
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (booleanFlags.has(token)) continue;
    if (!valueFlags.has(token)) throw new Error(`unknown flag: ${token}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      throw new Error(`missing value for ${token}`);
    }
    index += 1;
  }
  const targets = values(argv, "--target");
  if (command === "watch" && targets.length !== 1) throw new Error("exactly one --target is required");
  if (command === "watch" && !VALID_TARGET.test(targets[0])) throw new Error("--target must be a full session UUID");
  const homeDir = path.resolve(one(argv, "--home", os.homedir()));
  const canonicalRuntimeRoot = path.join(homeDir, ".claude", "state");
  const requestedRuntimeRoot = path.resolve(one(argv, "--runtime-root", canonicalRuntimeRoot));
  if (requestedRuntimeRoot !== canonicalRuntimeRoot) {
    throw new Error("--runtime-root must equal the state root derived from --home");
  }
  const runtimeRoot = canonicalRuntimeRoot;
  const supervisorSessionId = one(argv, "--supervisor");
  if (command === "watch" && !VALID_SUPERVISOR.test(supervisorSessionId || "")) throw new Error("valid --supervisor is required");
  const stateFile = path.resolve(one(
    argv,
    "--state-file",
    supervisorSessionId ? path.join(runtimeRoot, "peer-supervision", `${supervisorSessionId}.json`) : path.join(runtimeRoot, "peer-supervision", "unknown.json"),
  ));
  if (!pathInside(path.join(runtimeRoot, "peer-supervision"), stateFile)) {
    throw new Error("--state-file must stay inside runtime_root/peer-supervision");
  }
  if (command === "watch") {
    const canonicalStateFile = path.resolve(path.join(runtimeRoot, "peer-supervision", `${supervisorSessionId}.json`));
    if (stateFile !== canonicalStateFile) {
      throw new Error(`--state-file must equal canonical supervisor state path ${canonicalStateFile}`);
    }
  }
  const repoPath = one(argv, "--repo");
  const disableGitSignal = flagPresent(argv, "--disable-git-signal");
  if (command === "watch" && Boolean(repoPath) === disableGitSignal) {
    throw new Error("watch requires exactly one of --repo or --disable-git-signal");
  }
  return {
    command,
    targetSessionId: targets[0] || null,
    supervisorSessionId,
    targetTranscript: one(argv, "--transcript"),
    ledgerPath: one(argv, "--ledger"),
    repoPath,
    gitSignalEnabled: Boolean(repoPath),
    targetPid: one(argv, "--target-pid") ? positiveInteger(one(argv, "--target-pid"), "--target-pid") : null,
    runtimeRoot,
    stateFile,
    cancelFile: `${stateFile.slice(0, -5)}.cancel`,
    claimFile: `${stateFile.slice(0, -5)}.watcher-claim`,
    intervalMs: positiveInteger(one(argv, "--interval-ms", DEFAULT_INTERVAL_MS), "--interval-ms"),
    hardTimeoutMs: positiveInteger(one(argv, "--hard-timeout-ms", DEFAULT_HARD_TIMEOUT_MS), "--hard-timeout-ms"),
    windowSize: positiveInteger(one(argv, "--window", DEFAULT_WINDOW_SIZE), "--window"),
    silenceMultiplier: positiveInteger(one(argv, "--silence-multiplier", DEFAULT_SILENCE_MULTIPLIER), "--silence-multiplier"),
    gitZeroRounds: positiveInteger(one(argv, "--git-zero-rounds", DEFAULT_GIT_ZERO_ROUNDS), "--git-zero-rounds"),
    reviewFile: one(argv, "--review-file"),
    homeDir,
    childTimeoutMs: positiveInteger(one(argv, "--child-timeout-ms", DEFAULT_CHILD_TIMEOUT_MS), "--child-timeout-ms"),
    acceptedReviewCommandBlobs: REVIEW_COMMAND_BLOBS,
  };
}

function ownedWritePaths(options) {
  const inboxPaths = pathsFor(options.homeDir, options.targetSessionId);
  return [
    options.stateFile,
    options.cancelFile,
    options.claimFile,
    inboxPaths.queue,
    inboxPaths.lock,
  ];
}

function interventionNotificationText(record, state) {
  const decisionNote = record.has_user_decidable_spots
    ? " This intervention contained `【】` user-decidable spots filled with recommended defaults."
    : "";
  return `Peer supervisor intervention ${record.id} for ${state.target_session_id}:${decisionNote} ${record.body}`;
}

function processAlive(pid) {
  if (!pid) return null;
  try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code !== "ESRCH"); }
}

function runGitHead(repoPath, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  if (result.error && result.error.code === "ETIMEDOUT") return { status: "timeout", head: null };
  if (result.status !== 0) return { status: "unavailable", head: null };
  const head = result.stdout.trim();
  return head ? { status: "ok", head } : { status: "unavailable", head: null };
}

function validateRepoPath(repoPath) {
  let stat;
  try { stat = fs.statSync(repoPath); } catch { throw new Error("repo path does not exist"); }
  if (!stat.isDirectory()) throw new Error("repo path must be a directory");
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: DEFAULT_CHILD_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.status !== 0 || result.stdout.trim() !== "true") throw new Error("repo path is not a readable git worktree");
}

function readTranscriptActivity(state) {
  const file = state.target_transcript;
  const descriptor = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(descriptor);
    const size = stat.size;
    const start = Math.min(state.observation.transcript_offset || 0, size);
    const bytes = Buffer.alloc(size - start);
    fs.readSync(descriptor, bytes, 0, bytes.length, start);
    const raw = bytes.toString("utf8");
    const lastNewline = raw.lastIndexOf("\n");
    const complete = lastNewline >= 0 ? raw.slice(0, lastNewline + 1) : "";
    let latest = state.observation.last_activity_at;
    for (const line of complete.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line);
        if (typeof value.timestamp === "string" && Number.isFinite(Date.parse(value.timestamp))) {
          if (!latest || Date.parse(value.timestamp) > Date.parse(latest)) latest = value.timestamp;
        }
      } catch { /* malformed transcript line is isolated */ }
    }
    const transcriptOffset = start + Buffer.byteLength(complete);
    return {
      last_activity_at: latest || iso(stat.mtimeMs),
      transcript_bytes: size,
      transcript_mtime: stat.mtime.toISOString(),
      transcript_offset: transcriptOffset,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function collectSample(state, nowMs = Date.now(), childTimeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
  const transcript = readTranscriptActivity(state);
  let ledgerMtime = null;
  let ledgerStatus = state.ledger_path ? "unavailable" : "disabled";
  if (state.ledger_path) {
    try {
      ledgerMtime = fs.statSync(state.ledger_path).mtimeMs;
      ledgerStatus = "ok";
    } catch { ledgerMtime = null; }
  }
  let gitHead = null;
  let gitStatus = state.repo_path ? "unavailable" : "disabled";
  if (state.repo_path) {
    const result = runGitHead(state.repo_path, childTimeoutMs);
    gitHead = result.head;
    gitStatus = result.status;
  }
  const targetAlive = processAlive(state.target_pid);
  return {
    sampled_at: iso(nowMs),
    ...transcript,
    target_alive: targetAlive,
    target_process_status: state.target_pid ? (targetAlive ? "alive" : "exited") : "disabled",
    ledger_mtime_ms: ledgerMtime,
    ledger_status: ledgerStatus,
    git_head: gitHead,
    git_status: gitStatus,
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function validWatcherClaim(value) {
  return value && typeof value === "object" && Number.isInteger(value.owner_pid) && value.owner_pid > 0 &&
    typeof value.owner_token === "string" && value.owner_token.length > 0 &&
    Number.isFinite(Date.parse(value.claimed_at)) && Number.isFinite(Date.parse(value.deadline_at)) &&
    Date.parse(value.deadline_at) > Date.parse(value.claimed_at);
}

function readWatcherClaim(file) {
  try {
    const value = JSON.parse(fs.readlinkSync(file, "utf8"));
    return validWatcherClaim(value) ? value : null;
  } catch { return null; }
}

function acquireWatcherClaim(file, hardTimeoutMs, nowMs = Date.now()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString("hex");
  const claim = {
    owner_pid: process.pid,
    owner_token: token,
    claimed_at: iso(nowMs),
    deadline_at: iso(nowMs + Math.max(WATCHER_CLAIM_LEASE_MS, hardTimeoutMs + 5 * 60_000)),
  };
  while (true) {
    try {
      fs.symlinkSync(JSON.stringify(claim), file);
      return { acquired: true, claim };
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const existing = readWatcherClaim(file);
      if (existing && Date.parse(existing.deadline_at) > nowMs && processAlive(existing.owner_pid)) {
        return { acquired: false, existing };
      }
      const stale = `${file}.stale.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.renameSync(file, stale);
        fs.unlinkSync(stale);
      } catch (reclaimError) {
        if (reclaimError && reclaimError.code === "ENOENT") continue;
        throw reclaimError;
      }
    }
  }
}

function releaseWatcherClaim(file, token) {
  const claim = readWatcherClaim(file);
  if (!claim || claim.owner_token !== token) return;
  const released = `${file}.released.${token}`;
  try {
    fs.renameSync(file, released);
    fs.unlinkSync(released);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}

function watchLoop(options) {
  const acquired = acquireWatcherClaim(options.claimFile, options.hardTimeoutMs);
  if (!acquired.acquired) {
    return {
      kind: "already-watching",
      target_session_id: options.targetSessionId,
      state_file: options.stateFile,
      state: "watching",
      owner_pid: acquired.existing.owner_pid,
      deadline_at: acquired.existing.deadline_at,
    };
  }
  const claim = acquired.claim;
  try {
  let state;
  if (fs.existsSync(options.stateFile)) {
    state = loadState(options.stateFile);
    if (state.target_session_id !== options.targetSessionId) throw new Error("state file belongs to another target");
    if (state.supervisor_session_id !== options.supervisorSessionId) throw new Error("state file belongs to another supervisor");
    if (path.resolve(state.runtime_root) !== path.resolve(options.runtimeRoot)) throw new Error("state runtime_root disagrees with --home");
    if (path.resolve(state.target_transcript) !== path.resolve(options.targetTranscript)) {
      throw new Error("state transcript disagrees with --transcript");
    }
    if (state.state === "hard-timeout") {
      state.state = "watching";
      state.waiter_started_at = iso(Date.now());
      state.waiter_deadline_at = iso(Date.now() + options.hardTimeoutMs);
    }
  } else {
    state = createState({
      supervisorSessionId: options.supervisorSessionId,
      targetSessionId: options.targetSessionId,
      targetTranscript: options.targetTranscript,
      stateFile: options.stateFile,
      ledgerPath: options.ledgerPath,
      repoPath: options.repoPath,
      targetPid: options.targetPid,
      runtimeRoot: options.runtimeRoot,
      intervalMs: options.intervalMs,
      hardTimeoutMs: options.hardTimeoutMs,
      windowSize: options.windowSize,
      silenceMultiplier: options.silenceMultiplier,
      gitZeroRounds: options.gitZeroRounds,
      acceptedReviewCommandBlobs: options.acceptedReviewCommandBlobs,
    });
  }
  while (true) {
    if (fs.existsSync(options.cancelFile)) {
      const result = cancelledWake(state);
      state.state = result.state;
      state.counters.cancellations += 1;
      state.updated_at = iso(Date.now());
      saveState(options.stateFile, state);
      return result;
    }
    if (state.state !== "completion-pending-notify" && Date.now() >= Date.parse(state.waiter_deadline_at)) {
      const result = deadlineWake(state);
      state.state = result.state;
      state.counters.hard_timeouts += 1;
      state.updated_at = iso(Date.now());
      saveState(options.stateFile, state);
      return result;
    }
    if (state.state === "completion-pending-notify") {
      const completionDeadline = Date.parse(state.completion_notify_deadline_at || state.waiter_deadline_at);
      if (Date.now() >= completionDeadline) {
        const result = deadlineWake(state);
        state.state = result.state;
        state.counters.hard_timeouts += 1;
        state.updated_at = iso(Date.now());
        saveState(options.stateFile, state);
        return result;
      }
      const retried = retryCompletionNotification(state, {
        stateFile: options.stateFile,
        completionNotify: options.completionNotify || ((report) => imNotify(
          `Peer supervision completion retry ${report.review_id} for ${state.target_session_id}; report is persisted.`,
          options.childTimeoutMs,
        )),
      });
      state = retried.state;
      if (state.state === "terminal") return wake("terminal", state, { completion_notify_accepted: true });
      const remaining = Math.max(1, Math.min(
        Date.parse(state.next_completion_notify_at) - Date.now(),
        completionDeadline - Date.now(),
      ));
      sleep(remaining);
      continue;
    }
    const sampled = collectSample(state, Date.now(), options.childTimeoutMs);
    const result = advance(state, sampled);
    state = result.state;
    if (result.wake) bindSnapshotIntegrity(state, result.wake);
    saveState(options.stateFile, state);
    if (result.wake) return result.wake;
    const remaining = Date.parse(state.waiter_deadline_at) - Date.now();
    if (remaining > 0) sleep(Math.min(state.config.interval_ms, remaining));
  }
  } finally {
    releaseWatcherClaim(options.claimFile, claim.owner_token);
  }
}

function imNotify(text, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
  const result = spawnSync("im-notify", [text], {
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return result.status === null ? 1 : result.status;
}

function main(argv = process.argv.slice(2)) {
  const options = parseCli(argv);
  if (options.command === "watch") {
    if (!options.targetTranscript) throw new Error("--transcript is required");
    process.stdout.write(`${JSON.stringify(watchLoop(options))}\n`);
    return;
  }
  if (!["record-review", "deliver-review"].includes(options.command)) throw new Error(`unknown command: ${options.command}`);
  if (!options.reviewFile) throw new Error("--review-file is required");
  const state = loadState(options.stateFile);
  const review = JSON.parse(fs.readFileSync(options.reviewFile, "utf8"));
  let delivered;
  try {
    if (options.command === "record-review") {
      const updated = recordReview(state, review);
      saveState(options.stateFile, updated);
      process.stdout.write(`${JSON.stringify({ kind: "review-recorded", review_id: review.review_id })}\n`);
      return;
    }
    delivered = deliverReview(state, review, {
      homeDir: options.homeDir,
      enqueue: (record) => enqueueMessage({ homeDir: options.homeDir, sessionId: state.target_session_id, record }),
      notify: (record) => imNotify(interventionNotificationText(record, state), options.childTimeoutMs),
    });
  } catch (error) {
    if (!error || error.code !== "SNAPSHOT_STALE") throw error;
    const rearmed = rearmAfterSnapshotStale(state);
    saveState(options.stateFile, rearmed);
    process.stdout.write(`${JSON.stringify({
      kind: "snapshot-stale",
      state_file: options.stateFile,
      target_session_id: state.target_session_id,
      reason: error.message,
    })}\n`);
    process.exitCode = 1;
    return;
  }
  saveState(options.stateFile, delivered.state);
  const emptyDelivery = delivered.counts.eligible_section5 === 0;
  if (!delivered.complete && !emptyDelivery) {
    process.stdout.write(`${JSON.stringify({ kind: "delivery-incomplete", counts: delivered.counts })}\n`);
    process.exitCode = 1;
    return;
  }
  if (emptyDelivery && !terminalDecisionIsComplete(delivered.review.terminal_decision)) {
    process.stdout.write(`${JSON.stringify({ kind: "delivery-empty", counts: delivered.counts })}\n`);
    return;
  }
  const finished = finishReview(delivered.state, review, {
    stateFile: options.stateFile,
    completionNotify: (report) => imNotify(
      `Peer supervision completed for ${state.target_session_id}; review ${report.review_id} is persisted.`,
      options.childTimeoutMs,
    ),
  });
  process.stdout.write(`${JSON.stringify({
    kind: finished.state.state === "watching" ? "delivery-complete" : finished.state.state,
    counts: delivered.counts,
    completion_notify_accepted: finished.completion_notify_accepted,
  })}\n`);
  if (finished.state.state === "completion-pending-notify") process.exitCode = 1;
}

module.exports = {
  DEFAULT_GIT_ZERO_ROUNDS,
  DEFAULT_HARD_TIMEOUT_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_SILENCE_MULTIPLIER,
  DEFAULT_WINDOW_SIZE,
  REVIEW_COMMAND_BLOB,
  REVIEW_COMMAND_BLOBS,
  acquireWatcherClaim,
  advance,
  cancelledWake,
  createState,
  deadlineWake,
  deliverReview,
  filePrefixSha256,
  finishReview,
  imNotify,
  interventionNotificationText,
  collectSample,
  loadState,
  markDeepReviewTriggered,
  normalizeReview,
  ownedWritePaths,
  parseCli,
  recordReview,
  rearmAfterSnapshotStale,
  retryCompletionNotification,
  runGitHead,
  saveState,
  terminalDecisionIsComplete,
  transitionSignals,
  signalAvailability,
  watchLoop,
};

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`peer-session-watch: ${error.message}\n`);
    process.exitCode = 1;
  }
}
