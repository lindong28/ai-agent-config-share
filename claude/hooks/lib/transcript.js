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

module.exports = { lastAssistantMessage, TAIL_CHARS };
