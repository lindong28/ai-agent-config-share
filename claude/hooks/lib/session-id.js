"use strict";

const CLAUDE_SESSION_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const CLAUDE_SESSION_ID = new RegExp(`^${CLAUDE_SESSION_ID_PATTERN}$`, "i");
const SUPERVISOR_LABEL = new RegExp(`^supervisor:${CLAUDE_SESSION_ID_PATTERN}$`, "i");

module.exports = {
  CLAUDE_SESSION_ID,
  CLAUDE_SESSION_ID_PATTERN,
  SUPERVISOR_LABEL,
};
