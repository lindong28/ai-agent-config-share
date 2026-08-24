'use strict';
/**
 * Transcript readers shared by the hooks that need the agent's own last words.
 *
 * Two consumers, two reasons. stop-gate.js feeds the last message to its LLM
 * judge. desktop-notify.js turns it into the notification body — and has no
 * alternative: only the Stop payload carries `last_assistant_message` inline,
 * while the `idle_prompt` Notification (which is what actually signals "the
 * turn is over", see desktop-notify.js) carries just a generic string.
 */

const fs = require('fs');

const TAIL_CHARS = 12000;

// How far back the search may go before giving up. A fixed window cannot work
// here: the distance from a stop record back to the agent's last spoken
// paragraph is set by however much the harness appended in between — tool
// results, thinking, and (self-amplifyingly) the attachment records these very
// hooks write, each carrying a full copy of the message. Measured on a real
// long session: median 16.5 KB, i.e. every stop fell outside a 12 KB window, so
// `lastAssistantMessage` returned null and both consumers silently degraded.
// The cap only exists so a pathological transcript cannot stall a hook; at 4 MB
// it sits ~250x above that median, which is why exhausting it is not a path
// callers are asked to distinguish.
const MAX_TAIL_CHARS = 4 * 1024 * 1024;

/** Read the last `chars` bytes of a file without loading the whole thing. */
function readTail(path, chars) {
  const { size } = fs.statSync(path);
  const start = Math.max(0, size - chars);
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The agent's last spoken paragraph — the final assistant text block in the
 * transcript, not the whole tail window. Both consumers only care about "what
 * did it say"; feeding them the raw tail (tool calls + thinking + hook noise)
 * measurably adds variance for the judge and produces useless notification
 * bodies. Returns null when no assistant text is found; throws if the
 * transcript is unreadable, so callers can fail open on their own terms.
 *
 * `chars` is the first probe, not the budget: the window doubles until a
 * message is found, the whole file is covered, or MAX_TAIL_CHARS is reached, so
 * a null return means "no assistant text within MAX_TAIL_CHARS" rather than
 * "it sat further back than we happened to look". Callers treat null as grounds
 * to fail open, and those two cases are not interchangeable.
 *
 * NO FRESHNESS CONTRACT. This returns the last assistant text *currently on
 * disk*, which is not necessarily the message that triggered the caller: a hook
 * can read the tail before the triggering message has been flushed, and then it
 * silently judges the previous one. Observed once at a 1.27 s gap between the
 * message landing and the hook firing.
 *
 * Prefer the payload's inline copy where there is one. Verified against the
 * installed Claude Code (2.1.220): Stop and SubagentStop declare an *optional*
 * `last_assistant_message`, carrying the concatenated text blocks of the last
 * assistant message — but the producer trims it and drops it to undefined when
 * that is empty, and interrupted SubagentStop invokes the hook with no messages
 * at all. Notification does not carry it. So the inline copy is precise when
 * present and simply absent otherwise; falling back here re-enters the
 * no-freshness-contract path rather than extending the guarantee.
 */
function lastAssistantMessage(path, chars = TAIL_CHARS) {
  const { size } = fs.statSync(path);
  for (let window = Math.max(1, chars); ; window *= 2) {
    const found = scanTailForAssistantText(path, window);
    if (found !== null) return found;
    if (window >= size || window >= MAX_TAIL_CHARS) return null;
  }
}

function scanTailForAssistantText(path, chars) {
  const raw = readTail(path, chars);
  let text = null;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; }
    const claudeContent = obj && obj.type === 'assistant' && obj.message && obj.message.content;
    const codexPayload = obj && obj.type === 'response_item' && obj.payload;
    const codexContent = codexPayload && codexPayload.type === 'message' && codexPayload.role === 'assistant'
      ? codexPayload.content
      : null;
    const content = claudeContent || codexContent;
    if (Array.isArray(content)) {
      const t = content
        .filter((b) => b && (b.type === 'text' || b.type === 'output_text') && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (t) text = t;
    }
  }
  return text;
}

// The first probe for activeCommandName. Deliberately far larger than
// TAIL_CHARS: a command block sits at the *start* of its turn, so the distance
// back to it is the whole turn's output, not the gap to the last message.
// Measured on a real `/custom:review-session-progress` turn: 1.4 MB from the
// command block to the turn's end. A 12 KB probe would have missed it every
// time — and missing it is silent, since the caller cannot tell "no command"
// from "did not look far enough".
const COMMAND_PROBE_CHARS = 256 * 1024;

// Identifier tokens an invocation carried in its arguments. Session ids are
// harness-minted UUIDs, so a hex run is a producer-constrained shape rather than
// prose — the precondition CLAUDE.md's 「模式匹配只用于有 spec 的对象」 sets
// before a regex is the right instrument. Eight is the prefix length the harness
// itself prints and users copy; shorter runs collide with git short shas.
// Two objects because `.test()` on a /g regex advances `lastIndex` and would
// alternate true/false across calls.
const ID_TOKEN_RE = /\b[0-9a-f]{8,}\b/;
const ID_TOKEN_RE_G = /\b[0-9a-f]{8,}\b/g;

/** Distinct id-shaped tokens in `text`, in first-seen order. */
function idTokens(text) {
  return Array.from(new Set(String(text).match(ID_TOKEN_RE_G) || []));
}

/**
 * The slash command driving the current turn, e.g.
 * `custom:review-session-progress`, or null when the turn began with a plain
 * prompt (or when the command sits beyond MAX_TAIL_CHARS).
 *
 * Read from the harness-emitted `<command-name>` block. That tag is a
 * producer-constrained token, not prose — the precondition CLAUDE.md's
 * 「模式匹配只用于有 spec 的对象」 sets before a regex is the right instrument
 * here. Two structural filters carry the correctness:
 *
 *   1. Provenance, not text shape. The tag being harness-emitted is *not* by
 *      itself enough: a complete command block reaches the transcript as a
 *      quotation through several real channels — an assistant printing a
 *      transcript (these hooks' own diagnostics do; measured — a raw `rfind`
 *      over one real transcript landed on exactly such a tool result), a
 *      compaction summary replaying an earlier turn, a human pasting one, an
 *      injected meta entry echoing one. A quotation and an invocation are
 *      byte-identical in the text, so the separation is made by
 *      producer-side fields instead; the inline note lists which, with their
 *      measured false-negative rate. **This is not cryptographic provenance**
 *      — a harness-generated entry outside those classes that quotes a full
 *      block would still be accepted; no such class exists in the corpus
 *      measured here.
 *   2. `isMeta !== true` marks a genuine human prompt. Verified against real
 *      transcripts: hook feedback and injected skill bodies carry
 *      `isMeta: true`, human prompts carry `promptSource`/`origin` and no
 *      `isMeta`. This is what lets a re-fire after hook feedback still see the
 *      command — the case a naive "any later user text resets it" rule breaks,
 *      which is the very case these gates re-judge.
 *
 * A later human prompt *clears* the command: the turn it started is a new one.
 * Task notifications look structurally identical to human prompts and so clear
 * it too — a false clear, which degrades to "no command" and therefore to the
 * pre-existing behaviour rather than to a wrong exemption.
 *
 * **Exception — the follow-up that names the same target.** A new prompt starts
 * a new *turn*, which is not the same as a new *task*. The steady state of an
 * analysis command is the user asking again about the same object ("再看一下
 * 53e93100 的进展"): the turn is new, the deliverable is still a report about
 * that object, and every premise the exemption rests on is unchanged. Measured
 * over one such session, clearing on every follow-up cost 4 of 4 misfires while
 * the command was live cost 0 of 7 — the exemption worked and then evaporated
 * the moment the user stopped retyping the slash command.
 *
 * So a clearing prompt that still names an identifier **this invocation itself
 * carried** keeps the command. The token has to come from the invocation's own
 * args, not merely look like an id: "contains any id-shaped run" would renew the
 * exemption off a git sha the user happened to mention. The narrowing matters
 * because a wrong renewal fails toward the dangerous side (the agent's own
 * unfinished work gets attributed to the reported object), while a missed
 * renewal only falls back to the pre-existing behaviour.
 *
 * Widening rule: a window that contains either a command block or a clearing
 * prompt already contains the *last* such event, so its answer is final and the
 * search stops. Only a window containing neither is inconclusive and doubles.
 */
function activeCommandName(path, chars = COMMAND_PROBE_CHARS) {
  let size;
  try { ({ size } = fs.statSync(path)); } catch { return null; }
  for (let window = Math.max(1, chars); ; window *= 2) {
    let raw;
    try { raw = readTail(path, window); } catch { return null; }
    let name = null;
    let sticky = [];
    let decided = false;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let obj;
      try { obj = JSON.parse(s); } catch { continue; }
      if (!obj || obj.type !== 'user' || obj.isMeta === true || !obj.message) continue;
      // 引用与调用的分界靠**生产者侧字段**，不靠文本形态。前一版拿"两个标签都在场"当判据，
      // 外部评审正确指出那是**召回**读数不是**来源认证**读数：完整粘贴一个 command block
      // 与真实调用在文本上逐字节同形。全机键集实测给出三条可用的分界：
      //   · `promptSource` —— 真人在 CLI 里敲/粘的 prompt 带它，**483 条真实调用一条都没有**；
      //     缺它的 non-meta 条目全部是 harness 自己生成的（`[Request interrupted]` 390、
      //     `<teammate-message>` 365、`<local-command-stdout>` 122），无一条真人输入。
      //     即"用户粘贴"这条路必然带上它，于是必然被挡。
      //   · `isCompactSummary` —— 压缩续接摘要专有；实测那 3 条只带 command-name 的假阳性
      //     全是它，而真实调用 0 条带它。
      //   · `<teammate-message` —— agent 之间互发的消息不带 promptSource，是唯一还剩的
      //     agent 可写通道；它是 harness 发出的结构化标签（故按「模式匹配只用于有 spec 的
      //     对象」可以匹配）。真实调用 0 条被它包裹。
      // 三条的假阴性都是 0/483。**它不是密码学溯源**：一个既非上述三类、又完整引用了
      // command block 的 harness 生成条目仍会通过；当前全机语料里不存在这样一类。
      //
      // 分三支而不是一律 skip：真人新 prompt 与压缩摘要要**清除**陈旧命令名（新回合开始了，
      // 清除的方向是回落到改动前行为、安全），而 `[Request interrupted]`、
      // `<local-command-stdout>`、`<teammate-message>` 这些回合**内部**的 harness 流量
      // 既不该置位也不该清除——让 stdout 清除会在命令块之后立刻把它抹掉。
      const content = obj.message.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : '';
      if (!text.trim()) continue;

      // 新回合开始了 → 清除陈旧命令名（方向是回落到"无命令"、安全）。
      if (obj.promptSource !== undefined || obj.isCompactSummary) {
        // 例外：这条追问仍点名**本次调用自己带进来的**那个 id → 回合是新的、任务不是。
        if (name && sticky.length && sticky.some((t) => text.includes(t))) continue;
        // 命令块落在窗口之外时这里还判不了——"它点的是不是那个目标"要等看见调用参数。
        // 于是不 decide，让窗口翻倍去把命令块捞进来；一路捞不到就仍返回 null，
        // 与改动前逐字同。只在这条 prompt 真带 id 形状时才付这个代价。
        if (!name && ID_TOKEN_RE.test(text)) continue;
        name = null; sticky = []; decided = true; continue;
      }

      // **正向形状判据，不是排除清单。** 前三版都在给观察到的坏通道加排除项——那是枚举，
      // 每补一格就露一格：实测 `<local-command-stdout>` 只要内容里带完整 command block 就仍会
      // 置位（它当时"看起来安全"只是因为样例文本里没有），而按子串排除 `<teammate-message`
      // 又会把**参数里提到该标签的真实调用**一并吞掉（分析 agent session 的命令上是现实输入）。
      // 改判"这条目本身是不是一次调用"：harness 发出的调用**以命令块开头**，引用它的文本
      // （stdout 转贴、teammate 消息、报告原文）则把它包在别的内容里。
      // 全机实测：通过上面两道来源守卫的 485 条命令条目，**485 条全部**以 `<command-message>`
      // 或 `<command-name>` 开头（290 / 195），零例外；485 条也全部含 `<command-message>`
      // （即下面那个合取不误杀任何一条）。不匹配的条目**跳过而不清除**——它们是回合内部流量。
      const head = text.trimStart();
      if (!head.startsWith('<command-message>') && !head.startsWith('<command-name>')) continue;

      const m = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
      if (m && text.includes('<command-message>')) {
        name = m[1];
        // 续期判据的锚：只认这次调用**自己**带的 id，故从它的 args 里取，不从正文取。
        const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
        sticky = args ? idTokens(args[1]) : [];
        decided = true;
      }
    }
    if (decided) return name;
    if (window >= size || window >= MAX_TAIL_CHARS) return null;
  }
}

module.exports = { lastAssistantMessage, activeCommandName, TAIL_CHARS };
