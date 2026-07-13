#!/usr/bin/env node
// ask-user-mcp — AskUserQuestion for MCP clients that support elicitation
// (e.g. Codex CLI). Mirrors Claude Code's built-in AskUserQuestion tool so
// shared skills/commands referencing that tool work unchanged outside Claude.
//
// Each question becomes one elicitation/create form: an enum (single-select)
// or array-of-enum (multi-select) field, plus an optional free-text "other"
// field that overrides the selection — mirroring Claude's built-in "Other".

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Claude's native tool waits indefinitely; mirror that as closely as practical.
// 24h keeps the call bounded without ever timing out a real decision.
const ELICIT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

const server = new McpServer({ name: "ask-user", version: "1.0.0" });

const questionShape = z.object({
  question: z.string().describe("The complete question to ask the user"),
  header: z.string().optional().describe("Very short label for the question (chip/tag)"),
  multiSelect: z.boolean().optional().describe("Allow selecting multiple options"),
  options: z
    .array(
      z.object({
        label: z.string().describe("Display text of the choice (1-5 words)"),
        description: z.string().optional().describe("What this option means / tradeoffs"),
      })
    )
    .min(2)
    .max(4)
    .describe("2-4 mutually exclusive choices (non-exclusive if multiSelect)"),
});

function buildMessage(q) {
  const lines = [q.question, ""];
  for (const opt of q.options) {
    lines.push(opt.description ? `• ${opt.label} — ${opt.description}` : `• ${opt.label}`);
  }
  return lines.join("\n");
}

function buildSchema(q) {
  const labels = q.options.map((o) => o.label);
  const answer = q.multiSelect
    ? { type: "array", title: q.header || "Answer", items: { type: "string", enum: labels } }
    : { type: "string", title: q.header || "Answer", enum: labels };
  return {
    type: "object",
    properties: {
      answer,
      other: {
        type: "string",
        title: "Other (free text; overrides the selection above)",
      },
    },
    required: [],
  };
}

server.registerTool(
  "AskUserQuestion",
  {
    description:
      "Ask the user 1-4 questions, each with 2-4 predefined options, and return " +
      "their answers. Use when you need the user to decide between concrete " +
      "alternatives (approach, tradeoff, scope). Renders a native form in the " +
      "client via MCP elicitation. Mark a recommended option by appending " +
      "'(Recommended)' to its label.",
    inputSchema: { questions: z.array(questionShape).min(1).max(4) },
  },
  async ({ questions }) => {
    const answers = [];
    for (const q of questions) {
      let result;
      try {
        result = await server.server.elicitInput(
          { message: buildMessage(q), requestedSchema: buildSchema(q) },
          { timeout: ELICIT_TIMEOUT_MS }
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify({ answers }, null, 2) +
                `\n\nElicitation failed for the remaining questions (${err?.message ?? err}). ` +
                `The answers above (if any) are valid — keep them. For the remaining ` +
                `questions, fall back to asking in chat: list the options as a numbered ` +
                `list, mark the recommended one, then end your turn and wait for the ` +
                `user's reply. Do not pick on the user's behalf.`,
            },
          ],
          isError: true,
        };
      }

      if (result.action !== "accept") {
        answers.push({ question: q.question, action: result.action });
        return {
          content: [
            {
              type: "text",
              text:
                JSON.stringify({ answers }, null, 2) +
                `\n\nThe user ${result.action === "decline" ? "declined" : "dismissed"} the ` +
                `question form. Do not assume an answer; ask in chat or stop and wait.`,
            },
          ],
        };
      }

      const other = result.content?.other?.trim();
      const selected = result.content?.answer;
      const hasSelection = Array.isArray(selected) ? selected.length > 0 : selected != null && selected !== "";
      if (!other && !hasSelection) {
        answers.push({ question: q.question, header: q.header, unanswered: true });
        continue; // form submitted empty — surface it, let the model re-ask this one
      }
      const chosen = other ? { custom: other } : { selected };
      answers.push({ question: q.question, header: q.header, ...chosen });
    }
    const unanswered = answers.filter((a) => a.unanswered);
    const note = unanswered.length
      ? `\n\nQuestions marked "unanswered": the user submitted the form empty. You MUST ` +
        `re-ask those questions in chat (numbered options, recommended one marked), then ` +
        `end your turn and wait. Do not proceed or assume an answer for them.`
      : "";
    return { content: [{ type: "text", text: JSON.stringify({ answers }, null, 2) + note }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
