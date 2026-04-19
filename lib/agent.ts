import { sandboxManager } from "./sandbox";

// ---------------------------------------------------------------------------
// buildAgentScript
// ---------------------------------------------------------------------------
// Returns a self-contained TypeScript script that runs INSIDE the Daytona VM
// via `tsx /tmp/agent-runner.ts`. All runtime values come from environment
// variables injected by runAgentInSandbox.
//
// The script:
//   1. Restores conversation history from Convex over HTTP
//   2. Builds a Pi Agent with 8 Node.js-native tools
//   3. Writes live token deltas and tool logs back to Convex as they arrive
//   4. Marks the message "done" or "error" when the turn completes
// ---------------------------------------------------------------------------

export function buildAgentScript(_params: {
  threadId: string;
  messageId: string;
  userMessage: string;
  convexUrl: string;
}): string {
  // The script is static — all values are injected as env vars at runtime.
  // No template-literal interpolations appear inside the script body so the
  // outer backtick string is safe.
  return `
import { execSync } from "child_process";
import * as fs from "fs";
import * as nodePath from "path";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentToolResult, AgentEvent } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

// ── Config from environment ─────────────────────────────────────────────────
const CONVEX_URL   = process.env.CONVEX_URL;
const THREAD_ID    = process.env.THREAD_ID;
const MESSAGE_ID   = process.env.MESSAGE_ID;
const USER_MESSAGE = process.env.USER_MESSAGE;
const API_KEY      = process.env.CHATLLM_API_KEY;
const BASE_URL     = process.env.CHATLLM_BASE_URL;
const MODEL_ID     = process.env.CHATLLM_MODEL;

if (!CONVEX_URL || !THREAD_ID || !MESSAGE_ID || !USER_MESSAGE || !API_KEY || !BASE_URL || !MODEL_ID) {
  console.error("[agent-runner] missing required env vars");
  process.exit(1);
}

// ── Convex HTTP helper ───────────────────────────────────────────────────────
async function convexHttp(
  method,
  fnPath,
  args
) {
  const url = CONVEX_URL + "/api/" + method;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fnPath, args, format: "json" }),
  });
  if (!res.ok) {
    throw new Error("Convex HTTP " + res.status + " calling " + fnPath);
  }
  const data = await res.json();
  if (data.status !== "success") {
    throw new Error("Convex " + method + " " + fnPath + " failed: " + data.errorMessage);
  }
  return data.value;
}

// ── Tool result helper ───────────────────────────────────────────────────────
function textResult(text) {
  return { content: [{ type: "text", text }], details: text };
}

// ── Model (OpenAI-compatible ChatLLM endpoint) ───────────────────────────────
const model = {
  id: MODEL_ID,
  name: MODEL_ID,
  api: "openai-completions",
  provider: "openai-completions",
  baseUrl: BASE_URL,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 16384,
};

// ── Tools (Node.js built-ins) ────────────────────────────────────────────────
const tools = [
  // bash -----------------------------------------------------------------------
  {
    name: "bash",
    label: "Bash",
    description: "Run a shell command and return stdout/stderr.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
    }),
    execute: async (_id, p) => {
      try {
        const out = execSync(p.command, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        return textResult(out);
      } catch (e) {
        return textResult("Error (exit " + (e.status ?? 1) + "): " + (e.stderr ?? e.message ?? String(e)));
      }
    },
  },

  // read -----------------------------------------------------------------------
  {
    name: "read",
    label: "Read file",
    description: "Read the full contents of a file from the VM filesystem.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the file" }),
    }),
    execute: async (_id, p) => textResult(fs.readFileSync(p.path, "utf-8")),
  },

  // write ----------------------------------------------------------------------
  {
    name: "write",
    label: "Write file",
    description: "Write (or overwrite) a file. Creates parent directories as needed.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the file" }),
      content: Type.String({ description: "Full content to write" }),
    }),
    execute: async (_id, p) => {
      fs.mkdirSync(nodePath.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, p.content);
      return textResult("Wrote " + p.content.length + " bytes to " + p.path);
    },
  },

  // edit -----------------------------------------------------------------------
  {
    name: "edit",
    label: "Edit file",
    description: "Replace the first occurrence of old_string with new_string in a file. Throws if old_string is not found.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path to the file" }),
      old_string: Type.String({ description: "Exact string to replace" }),
      new_string: Type.String({ description: "Replacement string" }),
    }),
    execute: async (_id, p) => {
      const original = fs.readFileSync(p.path, "utf-8");
      if (!original.includes(p.old_string)) {
        throw new Error("edit: string not found in " + p.path + ": " + JSON.stringify(p.old_string));
      }
      fs.writeFileSync(p.path, original.replace(p.old_string, p.new_string));
      return textResult("Edited " + p.path);
    },
  },

  // grep -----------------------------------------------------------------------
  {
    name: "grep",
    label: "Grep",
    description: "Search for a pattern in files. Returns matching lines with file names and line numbers.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Regex or literal pattern" }),
      path: Type.String({ description: "File or directory path to search" }),
      flags: Type.Optional(Type.String({ description: "Extra grep flags (default: -rn)" })),
    }),
    execute: async (_id, p) => {
      const flags = p.flags ?? "-rn";
      const out = execSync(
        "grep " + flags + " " + JSON.stringify(p.pattern) + " " + p.path + " 2>&1 || true",
        { encoding: "utf-8" }
      );
      return textResult(out.trim() || "(no matches)");
    },
  },

  // glob -----------------------------------------------------------------------
  {
    name: "glob",
    label: "Glob",
    description: "Find files matching a glob pattern. Supports ** for recursive matching.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Glob pattern e.g. src/**/*.ts" }),
      cwd: Type.Optional(Type.String({ description: "Working directory (default: /)" })),
    }),
    execute: async (_id, p) => {
      const cwd = p.cwd ?? "/";
      const out = execSync(
        "bash -c 'shopt -s globstar nullglob 2>/dev/null; cd " +
          JSON.stringify(cwd) +
          "; for f in " + p.pattern + "; do echo \\"$f\\"; done' 2>/dev/null || true",
        { encoding: "utf-8" }
      );
      return textResult(out.trim() || "(no matches)");
    },
  },

  // webfetch -------------------------------------------------------------------
  {
    name: "webfetch",
    label: "Web Fetch",
    description: "Fetch the raw content of a URL using curl. Returns up to 50 KB.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    execute: async (_id, p) => {
      const out = execSync(
        "curl -sL --max-time 30 " + JSON.stringify(p.url) + " 2>&1 | head -c 51200",
        { encoding: "utf-8" }
      );
      return textResult(out);
    },
  },

  // websearch ------------------------------------------------------------------
  {
    name: "websearch",
    label: "Web Search",
    description: "Search the web using DuckDuckGo Instant Answer API. Returns a JSON summary.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    execute: async (_id, p) => {
      const encoded = encodeURIComponent(p.query);
      const ddgUrl =
        "https://api.duckduckgo.com/?q=" + encoded + "&format=json&no_html=1&skip_disambig=1";
      const out = execSync(
        "curl -sL --max-time 30 " + JSON.stringify(ddgUrl) + " 2>&1 | head -c 20480",
        { encoding: "utf-8" }
      );
      return textResult(out);
    },
  },
];

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Fetch prior messages from Convex to restore conversation history.
  const allMsgs = await convexHttp("query", "messages:getMessages", { threadId: THREAD_ID });

  // Exclude the current streaming assistant message — it has no content yet.
  const history = allMsgs.filter(m => m._id !== MESSAGE_ID && m.status === "done");

  // 2. Build the agent.
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt:
        "You are a helpful coding assistant inside an isolated VM. " +
        "Use your tools to help the user: run commands, read/write/edit files, " +
        "search code, and fetch web content. " +
        "Always prefer targeted reads over blind exploration. " +
        "When you make edits, verify the result with a read afterwards.",
    },
    convertToLlm: (messages) =>
      messages.filter(
        (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
      ),
    getApiKey: () => API_KEY,
  });

  // 3. Prime the agent with conversation history so it remembers prior turns.
  if (history.length > 0) {
    agent.state.messages = history.map(m => {
      if (m.role === "user") {
        return { role: "user", content: m.content, timestamp: Date.now() };
      }
      return {
        role: "assistant",
        content: [{ type: "text", text: m.content }],
        api: "openai-completions",
        provider: "openai-completions",
        model: MODEL_ID,
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: "stop",
        timestamp: Date.now(),
      };
    });
  }

  // 4. Subscribe to events — write live deltas and tool logs to Convex.
  let toolOrder = 0;
  const pendingLogs = new Map(); // toolCallId → toolLogId

  const unsubscribe = agent.subscribe(async (event) => {
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        await convexHttp("mutation", "messages:appendMessageContent", {
          messageId: MESSAGE_ID,
          chunk: event.assistantMessageEvent.delta,
        });
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolLogId = await convexHttp("mutation", "toolLogs:logTool", {
        threadId: THREAD_ID,
        messageId: MESSAGE_ID,
        toolName: event.toolName,
        input: JSON.stringify(event.args),
        output: "",
        executionOrder: toolOrder++,
      });
      pendingLogs.set(event.toolCallId, toolLogId);
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolLogId = pendingLogs.get(event.toolCallId);
      pendingLogs.delete(event.toolCallId);
      if (toolLogId) {
        await convexHttp("mutation", "toolLogs:updateToolLog", {
          toolLogId,
          output: JSON.stringify(event.result ?? ""),
        });
      }
      return;
    }

    if (event.type === "agent_end") {
      for (const msg of event.messages) {
        if (msg.role === "assistant" && msg.stopReason === "error") {
          throw new Error(msg.errorMessage ?? "Agent turn failed");
        }
      }
    }
  });

  // 5. Run the agent turn.
  try {
    await agent.prompt(USER_MESSAGE);
    await convexHttp("mutation", "messages:updateMessage", {
      messageId: MESSAGE_ID,
      status: "done",
    });
  } catch (err) {
    console.error("[agent-runner] error:", err);
    await convexHttp("mutation", "messages:updateMessage", {
      messageId: MESSAGE_ID,
      status: "error",
    }).catch(() => {});
    throw err;
  } finally {
    unsubscribe();
  }
}

main().catch(err => {
  console.error("[agent-runner] fatal:", err);
  process.exit(1);
});
`;
}

// ---------------------------------------------------------------------------
// runAgentInSandbox
// ---------------------------------------------------------------------------
// Wires everything together:
//   1. Builds the in-VM TypeScript script
//   2. Uploads + runs it inside the Daytona sandbox with all required env vars
//   3. Throws if the script exits non-zero (message will already be marked
//      "error" by the script before it exits)
// ---------------------------------------------------------------------------

export async function runAgentInSandbox(params: {
  sandboxId: string;
  threadId: string;
  messageId: string;
  userMessage: string;
}): Promise<void> {
  const { sandboxId, threadId, messageId, userMessage } = params;

  const script = buildAgentScript({
    threadId,
    messageId,
    userMessage,
    convexUrl: process.env.NEXT_PUBLIC_CONVEX_URL!,
  });

  const { exitCode, output } = await sandboxManager.runScript(
    sandboxId,
    script,
    {
      CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL ?? "",
      THREAD_ID: threadId,
      MESSAGE_ID: messageId,
      USER_MESSAGE: userMessage,
      // Fall back to ANTHROPIC_API_KEY for local dev without ChatLLM credentials.
      CHATLLM_API_KEY:
        process.env.CHATLLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
      CHATLLM_BASE_URL:
        process.env.CHATLLM_BASE_URL ?? "https://api.anthropic.com",
      CHATLLM_MODEL: process.env.CHATLLM_MODEL ?? "claude-sonnet-4-6",
    },
  );

  if (exitCode !== 0) {
    throw new Error(
      "[agent-runner] exited " + exitCode + (output ? ":\n" + output : ""),
    );
  }
}
