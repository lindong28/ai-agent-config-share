#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, test } = require("node:test");

const ACTIVE_PLAN = path.resolve(__dirname, "../../bin/active-plan");
const PRE_COMPACT = path.join(__dirname, "pre-compact.js");
const POST_COMPACT = path.join(__dirname, "post-compact-restore.js");
const REAL_STATE_DIR = path.join(os.homedir(), ".claude", "state");
// Captured from the real legacy producer-to-consumer chain before the program
// branch was added. Normalizing only fakeHome keeps the byte contract portable.
const LEGACY_GOLDEN_BASE64 =
  "eyJob29rU3BlY2lmaWNPdXRwdXQiOnsiaG9va0V2ZW50TmFtZSI6IlNlc3Npb25TdGFydCIsImFkZGl0aW9uYWxDb250ZXh0IjoiW0NPTlRFWFQgV0FTIEpVU1QgQ09NUEFDVEVEXSBSZWNvdmVyeSBicmllZmluZyBjYXB0dXJlZCBieSB0aGUgUHJlQ29tcGFjdCBob29rOlxuXG4jIyBBQ1RJVkUgTE9ORy1UQVNLIFBMQU4g4oCUIHJlYWQgdGhlc2UgYmVmb3JlIGRvaW5nIGFueXRoaW5nIGVsc2VcblRhc2s6IExlZ2FjeSBwbGFuXG4tIHBsYW46ICAgIDxGQUtFX0hPTUU+L2ZpeHR1cmVzL2xlZ2FjeS9wbGFuLm1kXG4tIHN0YXRlICA6IDxGQUtFX0hPTUU+L2ZpeHR1cmVzL2xlZ2FjeS9zdGF0ZS5tZCAgKHByb2dyZXNzIHNuYXBzaG90OyBvcGVuIGlzc3VlcyBsaXZlIGhlcmUpXG4tIGpvdXJuYWw6IDxGQUtFX0hPTUU+L2ZpeHR1cmVzL2xlZ2FjeS9qb3VybmFsLm1kICAoZGVjaXNpb25zICYgbGVzc29uczsgYXZvaWRzIHJlcGVhdGluZyBtaXN0YWtlcylcblxuYH4vLmNsYXVkZS9yZWZlcmVuY2VzL2xvbmctdGFzay1wcm90b2NvbC5tZGAgcmVxdWlyZXMgcmVhZGluZyBzdGF0ZS5tZCBhbmQgam91cm5hbC5tZCBiZWZvcmUgY2hvb3NpbmcgdGhlIG5leHQgYWN0aW9uLiBUaGUgcGxhbiBkaXJlY3RvcnkgSVMgdGhlIGhhbmRvZmYg4oCUIG5vIGhhbmRvZmYgZG9jdW1lbnQgaXMgbmVlZGVkLlxuXG4tLS1cbkFjdGlvbjogcmVhZCBzdGF0ZS5tZCBhbmQgam91cm5hbC5tZCwgdGhlbiByZXN1bWUgdGhlIGluX3Byb2dyZXNzIHRhc2sgcmVjb3JkZWQgdGhlcmUuIERvIE5PVCBhc2sgdGhlIHVzZXIgXCJ3aGF0IG5leHQ/XCIgYW5kIGRvIE5PVCByZWx5IG9uIHRoZSB0YXNrIGxpc3QgYWJvdmUg4oCUIGxvbmctdGFzayBzZXNzaW9ucyB0cmFjayBwcm9ncmVzcyBpbiBzdGF0ZS5tZCwgbm90IGluIFRhc2tDcmVhdGUvVGFza1VwZGF0ZS4ifX0=";

let fakeHome;
let surrogateHome;
let surrogateStateDir;
let surrogateBaseline;
let fixtureRoot;
let transcriptPath;
let planPath;
let programPath;
let safeTempRoot;
let subprocessCount = 0;
const usedSessionIds = new Set();

const RECOVERY_PREAMBLE =
  "[CONTEXT WAS JUST COMPACTED] Recovery briefing captured by the PreCompact hook:";
const PLAN_ACTION =
  "Action: read state.md and journal.md, then resume the in_progress task recorded there. " +
  'Do NOT ask the user "what next?" and do NOT rely on the task list above — long-task sessions ' +
  "track progress in state.md, not in TaskCreate/TaskUpdate.";
// The program action forks on journal presence. Both branches send the agent to the
// SAME authority (per-task sync anchors + the first-party artifacts they point at —
// run-program.md's glossary puts execution state there, not in the ledger and not in
// the journal); the fork is only about what the journal can be mined for.
const AUTHORITY_HINT = "核的是每行的同步锚点与证据指针指向的一手产物（执行态以它为准）。";
// The ten columns are sliced per task, so any current-state fact belonging to no single
// row can only sit outside the table. Step 1 used to name only 状态表, which made that
// content invisible to the recovering agent — the briefing pointed at a file and told it
// to verify a part.
const LEDGER_SCOPE =
  "ledger 是一份文件不是一张表：表格以外的正文可能还写着不属于任何" +
  "一行的当前态，一并读、同样以一手产物为准。";
const JOURNAL_CAVEAT =
  "线索一律回到对应权威源核实，不得据 journal 直接改状态，" +
  "也不得把其中的「已完成/已交付」写成 accepted——验收是单独一步。";
const STALENESS_NOTE =
  "陈旧不限于 in-flight——pending / dispatched / awaiting-verify 同样会过期，" +
  "accepted 也可能被新证据推翻。停轮对账规则见 `~/.claude/commands/custom/run-program.md`。";
const PROGRAM_ACTION_RECONCILE =
  "Action: **先核后续**，顺序不可颠倒。" +
  "(1) 逐行核 ledger 状态表：" + AUTHORITY_HINT + LEDGER_SCOPE +
  "(2) 通读 journal 找分歧线索（不限末尾几条）：从未入表的任务、既有行的验收判据/路由/" +
  "next action 更正、用户新增或改变的要求。" + JOURNAL_CAVEAT +
  "(3) 把前两步核出的偏差修进表。" +
  "(4) 完成第 1–3 步之后，才按修好的表接续。" + STALENESS_NOTE;
const PROGRAM_ACTION_NO_JOURNAL =
  "Action: **先核后续**，顺序不可颠倒。" +
  "(1) 逐行核 ledger 状态表，每一行都核、不只在飞的那些：" + AUTHORITY_HINT + LEDGER_SCOPE +
  "(2) journal 缺失，表外任务没有线索源——改从 transcript、当前 task list、" +
  "以及带本 program tag 的一手产物里找；穷举不了就如实记「本次恢复未能穷举表外任务」，不得当作没有。" +
  "(3) 把前两步核出的偏差修进表，并按上面 MISSING 那条重建 journal。" +
  "(4) 完成第 1–3 步之后，才接续。" + STALENESS_NOTE;

// The invariant is read off the PRODUCER'S DATA, not off the rendered sentence. Two
// rounds of regexes over the prose each died to a new wording that kept every keyword
// and inverted the behaviour — matching natural language against a spec that does not
// constrain its producer is what `pattern-matching-scope.md` forbids. The hook now emits
// typed steps, so "exactly one resume step and it is last" is a structural fact.
//
// The frozen literal goldens above stay: structure catches invariant violations, the
// goldens catch prose drift. Deriving the goldens from the producer would make the
// equality tautological — the symmetric-edit hole the reviewer kept exploiting.
const { programActionSteps, renderProgramAction } = require(POST_COMPACT);

function assertResumeIsGated(journalPresent, label) {
  const steps = programActionSteps({
    journalPresent,
    AUTHORITY_HINT,
    LEDGER_SCOPE,
    JOURNAL_CAVEAT,
    STALENESS_NOTE,
  });
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["verify", "clues", "repair", "resume"],
    `${label}: the action must be verify → clues → repair → resume`,
  );
  assert.equal(
    steps.filter((step) => step.kind === "resume").length,
    1,
    `${label}: exactly one step may resume`,
  );
  assert.equal(steps[steps.length - 1].kind, "resume", `${label}: resuming must be the last step`);
  // The producer itself refuses a mis-ordered contract — proven here rather than assumed,
  // so a future edit that moves the resume step cannot silently render a briefing whose
  // gating is wrong.
  const misordered = [steps[3], ...steps.slice(0, 3)];
  assert.throws(
    () => renderProgramAction(misordered),
    /resume step must be last/,
    `${label}: the renderer must reject a resume step that is not last`,
  );
}

const UNKNOWN_TYPE_ACTION =
  "Action: inspect or repair this active marker before resuming. " +
  "Do not apply long-task or program recovery semantics.";

function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertTempRootSeparatedFromRealState(tempRoot, realStateDir) {
  const resolvedTempRoot = fs.realpathSync(tempRoot);
  const resolvedRealState = fs.realpathSync(realStateDir);
  if (pathContains(resolvedRealState, resolvedTempRoot)) {
    assert.fail(
      `FAIL unsafe temp root overlaps real state directory: temp=${resolvedTempRoot}; ` +
        `real-state=${resolvedRealState}`,
    );
  }
  return resolvedTempRoot;
}

function expectedPlanBriefing({ title, plan, state, journal }) {
  const lines = [
    RECOVERY_PREAMBLE,
    "",
    "## ACTIVE LONG-TASK PLAN — read these before doing anything else",
  ];
  if (title) lines.push(`Task: ${title}`);
  lines.push(`- plan:    ${plan}`);
  const missing = [];
  if (state) lines.push(`- state  : ${state}  (progress snapshot; open issues live here)`);
  else missing.push("state");
  if (journal) lines.push(`- journal: ${journal}  (decisions & lessons; avoids repeating mistakes)`);
  else missing.push("journal");
  if (missing.length) {
    lines.push(
      `- NOTE: ${missing.join(" and ")} not found in ${path.dirname(plan)} — ` +
        "long-task-protocol requires them; create them before continuing.",
    );
  }
  lines.push(
    "",
    "`~/.claude/references/long-task-protocol.md` requires reading state.md and journal.md " +
      "before choosing the next action. The plan directory IS the handoff — no handoff document is needed.",
    "",
    "---",
    PLAN_ACTION,
  );
  return lines.join("\n");
}

function expectedProgramBriefing(program, readable, journal) {
  const lines = [
    RECOVERY_PREAMBLE,
    "",
    readable
      ? "## ACTIVE PROGRAM — read the ledger before doing anything else"
      : "## ACTIVE PROGRAM — ledger unavailable",
    readable ? `- program: ${program}` : `- UNAVAILABLE ledger: ${program}`,
  ];
  if (readable) {
    // The readable branch always says something about journal.md: a path line
    // when it exists, an explicit MISSING line otherwise — silent absence would
    // be indistinguishable from a healthy recovery.
    const journalPath = journal || path.join(path.dirname(program), "journal.md");
    lines.push(
      journal
        ? `- journal: ${journalPath}  (append-only 过程时间线：巡检打点、派发记录、教训)`
        : `- MISSING journal: ${journalPath} — ledger 目录应含 journal.md：` +
          "曾有则先找回（git/备份）；找不回或从未创建则现在新建，首条以当场时钟读数记录缺口或起点，勿以空文件冒充连续历史。",
    );
  }
  lines.push(
    "",
    "---",
    readable
      ? (journal ? PROGRAM_ACTION_RECONCILE : PROGRAM_ACTION_NO_JOURNAL)
      : "Action: locate the ledger at the path above, or confirm the program was closed and clear " +
        "the marker with `~/.claude/bin/active-plan clear`. Do not apply long-task recovery semantics.",
  );
  return lines.join("\n");
}

function renderType(value) {
  return JSON.stringify(value);
}

function expectedUnknownTypeBriefing(target, type) {
  return [
    RECOVERY_PREAMBLE,
    "",
    "## ACTIVE MARKER — type is unrecognized; no recovery protocol was selected",
    `- target: ${target}`,
    `- type: ${renderType(type)}`,
    "",
    "---",
    UNKNOWN_TYPE_ACTION,
  ].join("\n");
}

function probePathDefensively(target) {
  try {
    fs.lstatSync(target);
    return { status: "present" };
  } catch (error) {
    return {
      status: error && error.code === "ENOENT" ? "vanished" : "unreadable",
      code: error && error.code ? error.code : "unknown",
    };
  }
}

function pinnedMetadata(stat) {
  return {
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
    ino: stat.ino.toString(),
    nlink: stat.nlink.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    birthtimeNs: stat.birthtimeNs.toString(),
  };
}

function snapshotStateTree(root) {
  const entries = new Map();
  const visit = (target, relative) => {
    const stat = fs.lstatSync(target, { bigint: true });
    const record = { metadata: pinnedMetadata(stat) };
    if (stat.isFile()) {
      record.kind = "file";
      record.bytes = fs.readFileSync(target).toString("base64");
    } else if (stat.isSymbolicLink()) {
      record.kind = "symlink";
      record.target = fs.readlinkSync(target);
    } else if (stat.isDirectory()) {
      record.kind = "directory";
    } else {
      record.kind = "other";
    }
    entries.set(relative, record);
    if (record.kind === "directory") {
      for (const name of fs.readdirSync(target).sort()) {
        visit(path.join(target, name), path.join(relative, name));
      }
    }
  };
  visit(root, ".");
  return entries;
}

function absoluteSnapshotPath(root, relative) {
  return relative === "." ? root : path.join(root, relative);
}

function assertSurrogateTreeUnchanged(root, baseline, context) {
  let current;
  try {
    current = snapshotStateTree(root);
  } catch (error) {
    const target = error && error.path ? error.path : root;
    assert.fail(
      `FAIL damaged a pre-existing marker: ${target} could not be snapshotted ${context} ` +
        `(${error && error.code ? error.code : "unknown"})`,
    );
  }

  for (const relative of [...current.keys()].sort()) {
    if (!baseline.has(relative)) {
      assert.fail(
        `FAIL leaked into live state: ${absoluteSnapshotPath(root, relative)} was added ${context}; ` +
          "the surrogate state tree must exactly match its pre-subprocess snapshot",
      );
    }
  }
  for (const relative of [...baseline.keys()].sort()) {
    const target = absoluteSnapshotPath(root, relative);
    if (!current.has(relative)) {
      assert.fail(
        `FAIL damaged a pre-existing marker: ${target} is absent ${context}; ` +
          "the surrogate state tree must exactly match its pre-subprocess snapshot",
      );
    }
    if (JSON.stringify(current.get(relative)) !== JSON.stringify(baseline.get(relative))) {
      assert.fail(
        `FAIL damaged a pre-existing marker: ${target} has different bytes or pinned metadata ${context}; ` +
          "the surrogate state tree must exactly match its pre-subprocess snapshot",
      );
    }
  }
}

function ownedRealStatePaths(root, sid) {
  return [
    path.join(root, `active-plan-${sid}.json`),
    path.join(root, `compact-snapshot-${sid}.json`),
  ];
}

function assertNoRealStateAppearances(root, sessionIds, context) {
  for (const sid of sessionIds) {
    for (const target of ownedRealStatePaths(root, sid)) {
      const observed = probePathDefensively(target);
      if (observed.status === "present") {
        assert.fail(
          `FAIL our own marker or snapshot appeared in the real directory: ${target} exists ${context}; ` +
            "the real state directory is read-only to this test",
        );
      }
      if (observed.status === "unreadable") {
        assert.fail(
          `FAIL our own marker or snapshot appeared in the real directory: ${target} could not be classified ` +
            `${context} (${observed.code}); fail-closed because absence could not be proved`,
        );
      }
    }
  }
}

function assertIsolationGuards(context) {
  let firstFailure;
  for (const check of [
    () => assertSurrogateTreeUnchanged(surrogateStateDir, surrogateBaseline, context),
    () => assertNoRealStateAppearances(REAL_STATE_DIR, usedSessionIds, context),
  ]) {
    try {
      check();
    } catch (error) {
      if (!firstFailure) firstFailure = error;
    }
  }
  if (firstFailure) throw firstFailure;
}

function runScript(script, input, sid, args = []) {
  usedSessionIds.add(sid);
  subprocessCount++;
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input: input === undefined ? undefined : JSON.stringify(input),
    env: {
      ...process.env,
      HOME: fakeHome,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
    },
  });
  assertIsolationGuards(`after subprocess ${subprocessCount} (${path.basename(script)})`);
  return result;
}

function runActivePlan(args, sid) {
  return runScript(ACTIVE_PLAN, undefined, sid, [...args, "--session", sid]);
}

function markerPath(sid) {
  return path.join(fakeHome, ".claude", "state", `active-plan-${sid}.json`);
}

function snapshotPath(sid) {
  return path.join(fakeHome, ".claude", "state", `compact-snapshot-${sid}.json`);
}

function preCompact(sid) {
  const result = runScript(
    PRE_COMPACT,
    { session_id: sid, transcript_path: transcriptPath, trigger: "manual" },
    sid,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  return JSON.parse(fs.readFileSync(snapshotPath(sid), "utf8"));
}

function postCompact(sid) {
  const result = runScript(POST_COMPACT, { session_id: sid, source: "compact" }, sid);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.notEqual(result.stdout, "", "SessionStart must emit a recovery envelope");
  return result;
}

function briefingFrom(result) {
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

function normalizeFakeHome(bytes) {
  return bytes.split(fakeHome).join("<FAKE_HOME>");
}

function createPlanFixture(label, { state = true, journal = true } = {}) {
  const dir = path.join(fixtureRoot, label);
  fs.mkdirSync(dir, { recursive: true });
  const plan = path.join(dir, "plan.md");
  const statePath = path.join(dir, "state.md");
  const journalPath = path.join(dir, "journal.md");
  fs.writeFileSync(plan, `# ${label}\n`);
  if (state) fs.writeFileSync(statePath, "# State\n");
  if (journal) fs.writeFileSync(journalPath, "# Journal\n");
  return {
    dir,
    plan,
    state: state ? statePath : null,
    journal: journal ? journalPath : null,
  };
}

function rewriteMarkerType(sid, type, { remove = false } = {}) {
  const marker = JSON.parse(fs.readFileSync(markerPath(sid), "utf8"));
  if (remove) delete marker.type;
  else marker.type = type;
  const serialized = JSON.stringify(marker, null, 2);
  fs.writeFileSync(markerPath(sid), serialized);
  return serialized;
}

function legacyMarkerWithoutType(sid, targetPlan = planPath, title = "Legacy plan") {
  const setResult = runActivePlan(["set", targetPlan, "--title", title], sid);
  assert.equal(setResult.status, 0, setResult.stderr);
  return rewriteMarkerType(sid, undefined, { remove: true });
}

before(() => {
  // This read-only precondition must remain the first operation: no test path
  // may be created until realpath containment against live state is excluded.
  safeTempRoot = assertTempRootSeparatedFromRealState(os.tmpdir(), REAL_STATE_DIR);
  fakeHome = fs.mkdtempSync(path.join(safeTempRoot, "post-compact-program-test-"));
  surrogateHome = fs.mkdtempSync(path.join(safeTempRoot, "post-compact-surrogate-home-"));
  surrogateStateDir = path.join(surrogateHome, ".claude", "state");
  fs.mkdirSync(surrogateStateDir, { recursive: true });
  for (const label of ["alpha", "beta"]) {
    fs.writeFileSync(
      path.join(surrogateStateDir, `active-plan-surrogate-other-${label}-${crypto.randomUUID()}.json`),
      JSON.stringify({ session_id: `other-session-${label}`, owner: "surrogate" }),
    );
  }
  surrogateBaseline = snapshotStateTree(surrogateStateDir);

  fixtureRoot = path.join(fakeHome, "fixtures");
  const planDir = path.join(fixtureRoot, "legacy");
  const programDir = path.join(fixtureRoot, "program");
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(programDir, { recursive: true });
  planPath = path.join(planDir, "plan.md");
  programPath = path.join(programDir, "program.md");
  transcriptPath = path.join(fixtureRoot, "transcript.jsonl");
  fs.writeFileSync(planPath, "# Legacy plan\n");
  fs.writeFileSync(path.join(planDir, "state.md"), "# State\n");
  fs.writeFileSync(path.join(planDir, "journal.md"), "# Journal\n");
  fs.writeFileSync(programPath, "# Program ledger\n");
  fs.writeFileSync(transcriptPath, "");
  assertIsolationGuards("before the first subprocess");
});

after(() => {
  let failure;
  try {
    assertIsolationGuards("at suite end");
  } catch (error) {
    failure = error;
  } finally {
    if (fakeHome) fs.rmSync(fakeHome, { recursive: true, force: true });
    if (surrogateHome) fs.rmSync(surrogateHome, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(
    `surrogate-state whole-tree protection: PASS (${surrogateBaseline.size} paths matched exactly ` +
      `after ${subprocessCount} subprocesses)`,
  );
  console.log(
    `real-state read-only protection: PASS (checked ${usedSessionIds.size * 2} unique test paths after ` +
      `${subprocessCount} subprocesses; no marker or snapshot appeared in the real directory)`,
  );
});

test("legacy marker without type matches the pre-change recovery golden byte-for-byte", () => {
  const sid = `post-compact-legacy-${process.pid}-${crypto.randomUUID()}`;
  const serializedMarker = legacyMarkerWithoutType(sid);
  const showResult = runActivePlan(["show"], sid);
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.equal(showResult.stdout, serializedMarker, "show must preserve legacy marker bytes");

  const snapshot = preCompact(sid);
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot.active_plan, "type"),
    false,
    "legacy marker must reach the real snapshot without a synthetic type",
  );
  const normalized = normalizeFakeHome(postCompact(sid).stdout);
  assert.equal(
    Buffer.from(normalized).toString("base64"),
    LEGACY_GOLDEN_BASE64,
    "legacy recovery output changed byte-for-byte from the captured pre-change golden",
  );
});

test("program marker survives the real producer-to-consumer compaction chain", () => {
  const sid = `post-compact-program-${process.pid}-${crypto.randomUUID()}`;
  const setResult = runActivePlan(["set", programPath, "--type", "program", "--title", "Pilot"], sid);
  assert.equal(setResult.status, 0, setResult.stderr);

  const snapshot = preCompact(sid);
  assert.equal(
    snapshot.active_plan.type,
    "program",
    "PreCompact snapshot must preserve active_plan.type=program from the real marker",
  );
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(briefing, expectedProgramBriefing(programPath, true));
  assert.match(briefing, /MISSING journal/, "a ledger without journal.md must surface the gap, not skip it");
  assertResumeIsGated(false, "no-journal branch");
  // Without a journal there is no lead on which rows are missing, so the sweep cannot
  // be narrowed to the in-flight ones — that narrowing is exactly how the earlier
  // draft would have skipped stale pending/dispatched/awaiting-verify rows.
  assert.match(briefing, /每一行都核、不只在飞的那些/, "no journal means no way to narrow the sweep");
  assert.match(briefing, /表格以外的正文/, "step 1 must widen past the table: facts belonging to no row live outside it");
  assert.match(briefing, /同样以一手产物为准/, "table-external text is not self-authorising — it carries the same authority chain");
  // Without a journal the off-table tasks have no clue source at all — "walk the rows"
  // structurally cannot find a task that has no row. The action must name where else to
  // look, and must make an incomplete sweep say so instead of reading as "none found".
  assert.match(briefing, /transcript、当前 task list/, "off-table tasks need a named discovery source");
  assert.match(briefing, /未能穷举表外任务/, "an incomplete sweep must be recorded, not read as an empty one");
  assert.doesNotMatch(briefing, /通读 journal/, "cannot mine a journal that is absent");
});

test("program marker injects journal.md when the ledger directory has one", () => {
  const sid = `post-compact-program-journal-${process.pid}-${crypto.randomUUID()}`;
  const dir = path.join(fixtureRoot, "program-with-journal");
  const ledger = path.join(dir, "program.md");
  const journal = path.join(dir, "journal.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledger, "# Program ledger\n");
  fs.writeFileSync(journal, "# Journal\n");
  const setResult = runActivePlan(["set", ledger, "--type", "program"], sid);
  assert.equal(setResult.status, 0, setResult.stderr);

  const snapshot = preCompact(sid);
  assert.equal(snapshot.active_plan.type, "program");
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(briefing, expectedProgramBriefing(ledger, true, journal));
  // Helper-independent anchors: a symmetric refactor that broke both the hook
  // and the helper the same way would keep assert.equal green.
  assert.match(briefing, /- journal: /);
  assert.doesNotMatch(briefing, /MISSING journal/);
  assertResumeIsGated(true, "journal-present branch");
  // This branch's distinguishing duty, and the exact place two review rounds landed:
  // the journal is a clue source for ANY divergence, not just for rows the table never
  // got. Narrowing it to missing rows silently drops corrections to acceptance criteria,
  // routing and next action that surface in the journal before the first-party artifact
  // moves. And the clues are not only in the tail.
  assert.match(briefing, /不限末尾几条/, "an earlier journal entry can hold the only trace of an off-table task");
  assert.match(briefing, /既有行的验收判据\/路由\/next action 更正/, "clues cover existing rows, not just missing ones");
  assert.match(briefing, /不限于 in-flight/, "stale rows are not only the in-flight ones");
  assert.match(briefing, /表格以外的正文/, "step 1 must widen past the table on the journal-present branch too");
});

test("program marker reports an unavailable ledger removed after PreCompact", () => {
  const sid = `post-compact-program-missing-${process.pid}-${crypto.randomUUID()}`;
  const dir = path.join(fixtureRoot, "program-missing-after-snapshot");
  const ledger = path.join(dir, "program.md");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(ledger, "# Program ledger\n");
  const setResult = runActivePlan(["set", ledger, "--type", "program"], sid);
  assert.equal(setResult.status, 0, setResult.stderr);

  const snapshot = preCompact(sid);
  assert.equal(snapshot.active_plan.type, "program");
  fs.unlinkSync(ledger);
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(briefing, expectedProgramBriefing(ledger, false));
  assert.doesNotMatch(briefing, /ACTIVE LONG-TASK PLAN|state\.md|journal\.md/);
});

test("default type=plan marker follows the real producer-to-consumer chain", () => {
  const sid = `post-compact-explicit-plan-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("explicit-plan");
  const setResult = runActivePlan(
    ["set", fixture.plan, "--title", "Explicit plan"],
    sid,
  );
  assert.equal(setResult.status, 0, setResult.stderr);

  const snapshot = preCompact(sid);
  assert.equal(snapshot.active_plan.type, "plan");
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(
    briefing,
    expectedPlanBriefing({ title: "Explicit plan", ...fixture }),
  );
});

test("legacy marker missing one sibling keeps the reviewable long-task output", () => {
  const sid = `post-compact-legacy-one-missing-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("legacy-one-missing", { journal: false });
  legacyMarkerWithoutType(sid, fixture.plan, "Legacy one missing");
  const snapshot = preCompact(sid);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.active_plan, "type"), false);
  assert.equal(
    briefingFrom(postCompact(sid)),
    expectedPlanBriefing({ title: "Legacy one missing", ...fixture }),
  );
});

test("legacy marker missing both siblings keeps the reviewable long-task output", () => {
  const sid = `post-compact-legacy-both-missing-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("legacy-both-missing", { state: false, journal: false });
  legacyMarkerWithoutType(sid, fixture.plan, "Legacy both missing");
  const snapshot = preCompact(sid);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.active_plan, "type"), false);
  assert.equal(
    briefingFrom(postCompact(sid)),
    expectedPlanBriefing({ title: "Legacy both missing", ...fixture }),
  );
});

test("legacy marker pointing at a deleted plan keeps legacy recovery output", () => {
  const sid = `post-compact-legacy-deleted-plan-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("legacy-deleted-plan");
  legacyMarkerWithoutType(sid, fixture.plan, "Legacy deleted plan");
  const snapshot = preCompact(sid);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot.active_plan, "type"), false);
  fs.unlinkSync(fixture.plan);
  assert.equal(
    briefingFrom(postCompact(sid)),
    expectedPlanBriefing({ title: "Legacy deleted plan", ...fixture }),
  );
});

test("unknown string marker type gets a protocol-neutral diagnostic", () => {
  const sid = `post-compact-unknown-string-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("unknown-string");
  const setResult = runActivePlan(["set", fixture.plan, "--type", "plan"], sid);
  assert.equal(setResult.status, 0, setResult.stderr);
  rewriteMarkerType(sid, "future");
  const snapshot = preCompact(sid);
  assert.equal(snapshot.active_plan.type, "future");
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(briefing, expectedUnknownTypeBriefing(fixture.plan, "future"));
  assert.doesNotMatch(briefing, /ACTIVE LONG-TASK PLAN|ACTIVE PROGRAM|long-task-protocol|run-program/);
});

test("non-string marker type gets a protocol-neutral diagnostic", () => {
  const sid = `post-compact-unknown-null-${process.pid}-${crypto.randomUUID()}`;
  const fixture = createPlanFixture("unknown-null");
  const setResult = runActivePlan(["set", fixture.plan, "--type", "plan"], sid);
  assert.equal(setResult.status, 0, setResult.stderr);
  rewriteMarkerType(sid, null);
  const snapshot = preCompact(sid);
  assert.equal(snapshot.active_plan.type, null);
  const briefing = briefingFrom(postCompact(sid));
  assert.equal(briefing, expectedUnknownTypeBriefing(fixture.plan, null));
  assert.doesNotMatch(briefing, /ACTIVE LONG-TASK PLAN|ACTIVE PROGRAM|long-task-protocol|run-program/);
});

test("show stays byte-compatible and clear stays idempotent", () => {
  const sid = `post-compact-clear-${process.pid}-${crypto.randomUUID()}`;
  const serializedMarker = legacyMarkerWithoutType(sid);
  const showResult = runActivePlan(["show"], sid);
  assert.equal(showResult.status, 0, showResult.stderr);
  assert.equal(showResult.stdout, serializedMarker);

  const firstClear = runActivePlan(["clear"], sid);
  const secondClear = runActivePlan(["clear"], sid);
  assert.equal(firstClear.status, 0, firstClear.stderr);
  assert.equal(secondClear.status, 0, secondClear.stderr);
  assert.equal(secondClear.stdout, firstClear.stdout);
  assert.equal(fs.existsSync(markerPath(sid)), false);
});

test("temp-root guard rejects only temp roots inside real state", () => {
  assert.throws(
    () => assertTempRootSeparatedFromRealState(fakeHome, safeTempRoot),
    /FAIL unsafe temp root overlaps real state directory:/,
  );
  assert.doesNotThrow(() => assertTempRootSeparatedFromRealState(safeTempRoot, fakeHome));
});

test("surrogate guard names an unexpected added path", () => {
  const guardRoot = fs.mkdtempSync(path.join(safeTempRoot, "post-compact-leak-guard-"));
  try {
    const baseline = snapshotStateTree(guardRoot);
    const leakedPath = path.join(guardRoot, `unexpected-${crypto.randomUUID()}.json`);
    fs.writeFileSync(leakedPath, "unexpected\n");
    assert.throws(
      () => assertSurrogateTreeUnchanged(guardRoot, baseline, "guard self-test"),
      new RegExp(`FAIL leaked into live state: ${leakedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  } finally {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  }
});

test("surrogate guard names damage to a pre-existing marker", () => {
  const guardRoot = fs.mkdtempSync(path.join(safeTempRoot, "post-compact-damage-guard-"));
  try {
    const damagedPath = path.join(guardRoot, `active-plan-other-${crypto.randomUUID()}.json`);
    fs.writeFileSync(damagedPath, JSON.stringify({ session_id: "other-session" }), { mode: 0o600 });
    const baseline = snapshotStateTree(guardRoot);
    fs.chmodSync(damagedPath, 0o644);
    assert.throws(
      () => assertSurrogateTreeUnchanged(guardRoot, baseline, "guard self-test"),
      new RegExp(`FAIL damaged a pre-existing marker: ${damagedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
  } finally {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  }
});

test("real-directory guard names an owned marker or snapshot", () => {
  const guardRoot = fs.mkdtempSync(path.join(safeTempRoot, "post-compact-real-state-guard-"));
  try {
    const sid = `real-state-guard-${crypto.randomUUID()}`;
    const target = ownedRealStatePaths(guardRoot, sid)[1];
    fs.writeFileSync(target, "test snapshot\n");
    assert.throws(
      () => assertNoRealStateAppearances(guardRoot, new Set([sid]), "guard self-test"),
      new RegExp(
        `FAIL our own marker or snapshot appeared in the real directory: ${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      ),
    );
  } finally {
    fs.rmSync(guardRoot, { recursive: true, force: true });
  }
});
