#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { lastAssistantMessage } = require("./transcript");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-codex-"));
const file = path.join(dir, "rollout.jsonl");
fs.writeFileSync(file, [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "claude earlier" }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "codex latest" }] } }),
  "",
].join("\n"));

assert.equal(lastAssistantMessage(file), "codex latest");
console.log("Codex transcript reader test passed");
