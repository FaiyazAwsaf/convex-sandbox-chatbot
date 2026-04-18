import { getModel, Type } from "@mariozechner/pi-ai";
import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool, AgentToolResult, AgentEvent } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { sandboxManager } from "./sandbox";

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

export type ToolCallPhase = "start" | "end";

export interface ToolCallInfo {
  phase: ToolCallPhase;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Only present when phase === "end" */
  result?: unknown;
  isError?: boolean;
}

export type OnToolCallCallback = (info: ToolCallInfo) => void | Promise<void>;
export type OnTokenCallback = (token: string) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps a plain string in the AgentToolResult envelope the framework expects. */
function textResult(text: string): AgentToolResult<string> {
  return {
    content: [{ type: "text", text }],
    details: text,
  };
}

// ---------------------------------------------------------------------------
// createAgentForThread
// ---------------------------------------------------------------------------

/**
 * Creates a Pi Agent instance wired to a specific Daytona sandbox.
 *
 * Architecture note:
 *   - The Agent (LLM reasoning loop) runs in the Next.js server process.
 *   - Every tool executes its work INSIDE the Daytona VM via sandboxManager.
 *   - No tool logic runs locally — commands, file I/O, and network requests all
 *     happen inside the isolated VM identified by `sandboxId`.
 *
 * The returned Agent is stateful: it accumulates conversation history in
 * `agent.state.messages`. Callers should keep the same instance alive for
 * the full lifetime of the thread.
 */
export function createAgentForThread(threadId: string, sandboxId: string): Agent {
  const model = getModel("anthropic", "claude-sonnet-4-6");

  // -------------------------------------------------------------------------
  // Tool definitions — all execution is delegated to the Daytona VM
  // -------------------------------------------------------------------------

  const tools: AgentTool<any>[] = [
    // -- bash ----------------------------------------------------------------
    {
      name: "bash",
      label: "Bash",
      description:
        "Run a shell command inside the sandbox VM and return its stdout/stderr.",
      parameters: Type.Object({
        command: Type.String({ description: "Shell command to execute" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        const output = await sandboxManager.runCommand(sandboxId, params.command);
        return textResult(output);
      },
    },

    // -- read ----------------------------------------------------------------
    {
      name: "read",
      label: "Read file",
      description: "Read the full contents of a file from the sandbox VM filesystem.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the file inside the VM" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        const content = await sandboxManager.readFile(sandboxId, params.path);
        return textResult(content);
      },
    },

    // -- write ---------------------------------------------------------------
    {
      name: "write",
      label: "Write file",
      description:
        "Write (or overwrite) a file in the sandbox VM filesystem with the provided content.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the file inside the VM" }),
        content: Type.String({ description: "Full content to write" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        await sandboxManager.writeFile(sandboxId, params.path, params.content);
        return textResult(`Wrote ${params.content.length} bytes to ${params.path}`);
      },
    },

    // -- edit ----------------------------------------------------------------
    {
      name: "edit",
      label: "Edit file",
      description:
        "Replace the first occurrence of `old_string` with `new_string` in a file. " +
        "Throws if `old_string` is not found — use `read` first to confirm the exact text.",
      parameters: Type.Object({
        path: Type.String({ description: "Absolute path to the file inside the VM" }),
        old_string: Type.String({ description: "Exact string to replace (must be unique in the file)" }),
        new_string: Type.String({ description: "Replacement string" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        const original = await sandboxManager.readFile(sandboxId, params.path);
        if (!original.includes(params.old_string)) {
          throw new Error(
            `edit: string not found in ${params.path}: ${JSON.stringify(params.old_string)}`
          );
        }
        const updated = original.replace(params.old_string, params.new_string);
        await sandboxManager.writeFile(sandboxId, params.path, updated);
        return textResult(`Edited ${params.path}`);
      },
    },

    // -- grep ----------------------------------------------------------------
    {
      name: "grep",
      label: "Grep",
      description:
        "Search for a regex or literal pattern in files inside the sandbox VM. " +
        "Returns matching lines with file names and line numbers.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Regex or literal pattern to search for" }),
        path: Type.String({ description: "File or directory path to search" }),
        flags: Type.Optional(
          Type.String({ description: "Extra grep flags e.g. -i for case-insensitive (default: -rn)" })
        ),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        const flags = params.flags ?? "-rn";
        // `|| true` prevents a non-zero exit code (no matches) from throwing.
        const output = await sandboxManager.runCommand(
          sandboxId,
          `grep ${flags} ${JSON.stringify(params.pattern)} ${params.path} 2>&1 || true`
        );
        return textResult(output.trim() || "(no matches)");
      },
    },

    // -- glob ----------------------------------------------------------------
    {
      name: "glob",
      label: "Glob",
      description:
        "Find files matching a glob pattern inside the sandbox VM. " +
        "Supports `**` for recursive matching (e.g. `src/**/*.ts`).",
      parameters: Type.Object({
        pattern: Type.String({ description: "Glob pattern, e.g. src/**/*.ts or **/*.json" }),
        cwd: Type.Optional(
          Type.String({ description: "Working directory to expand the pattern from (default: /)" })
        ),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        const cwd = params.cwd ?? "/";
        // Use bash globstar so ** works.  nullglob silences unmatched patterns.
        const output = await sandboxManager.runCommand(
          sandboxId,
          `bash -c 'shopt -s globstar nullglob 2>/dev/null; cd ${JSON.stringify(cwd)}; for f in ${params.pattern}; do echo "$f"; done' 2>/dev/null || true`
        );
        return textResult(output.trim() || "(no matches)");
      },
    },

    // -- webfetch ------------------------------------------------------------
    {
      name: "webfetch",
      label: "Web Fetch",
      description:
        "Fetch the raw content of a URL from inside the sandbox VM using curl. " +
        "Returns up to 50 KB of response body.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        // Fetch inside the VM.  Pipe through head to cap response size.
        const output = await sandboxManager.runCommand(
          sandboxId,
          `curl -sL --max-time 30 ${JSON.stringify(params.url)} 2>&1 | head -c 51200`
        );
        return textResult(output);
      },
    },

    // -- websearch -----------------------------------------------------------
    {
      name: "websearch",
      label: "Web Search",
      description:
        "Search the web using DuckDuckGo's Instant Answer API from inside the sandbox VM. " +
        "Returns a JSON summary with abstract text, answer, and related topics.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<string>> => {
        // encodeURIComponent inside bash via jq or python, or just build the URL here
        // and pass the already-encoded URL to curl running in the VM.
        const encodedQuery = encodeURIComponent(params.query);
        const output = await sandboxManager.runCommand(
          sandboxId,
          `curl -sL --max-time 30 "https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1" 2>&1 | head -c 20480`
        );
        return textResult(output);
      },
    },
  ];

  // -------------------------------------------------------------------------
  // Agent construction
  // -------------------------------------------------------------------------

  return new Agent({
    initialState: {
      model,
      tools,
      systemPrompt:
        `You are a helpful coding assistant with access to an isolated Daytona VM ` +
        `(thread: ${threadId}). Use your tools to help the user: run commands, ` +
        `read/write/edit files, search code, and fetch web content. ` +
        `Always prefer targeted reads over blind exploration. ` +
        `When you make edits, verify the result with a read afterwards.`,
    },
    // Pass all standard LLM message types through; filter out any custom/UI messages.
    convertToLlm: (messages) =>
      messages.filter(
        (m): m is Message =>
          (m as { role: string }).role === "user" ||
          (m as { role: string }).role === "assistant" ||
          (m as { role: string }).role === "toolResult"
      ),
    // Resolve the API key dynamically so it can be rotated without restarting.
    getApiKey: () => process.env.ANTHROPIC_API_KEY,
  });
}

// ---------------------------------------------------------------------------
// runAgentTurn
// ---------------------------------------------------------------------------

/**
 * Sends `userMessage` to the agent and drives the full turn to completion.
 *
 * - `onToken` fires for each streamed text delta so the UI can display tokens
 *   as they arrive (caller should debounce before writing to Convex).
 * - `onToolCall` fires twice per tool invocation:
 *     • phase "start" — before execution (log the call to Convex immediately)
 *     • phase "end"   — after execution (update the log with the result)
 *
 * Returns when the agent has finished all tool calls and produced a final
 * stop message.  Throws if the underlying LLM turn ends in an error.
 */
export async function runAgentTurn(
  agent: Agent,
  userMessage: string,
  onToolCall: OnToolCallCallback,
  onToken: OnTokenCallback
): Promise<void> {
  // Subscribe before prompting so no events are missed.
  const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
    switch (event.type) {
      case "message_update": {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          await onToken(ae.delta);
        }
        break;
      }

      case "tool_execution_start": {
        await onToolCall({
          phase: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      }

      case "tool_execution_end": {
        await onToolCall({
          phase: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: undefined,
          result: event.result,
          isError: event.isError,
        });
        break;
      }

      case "agent_end": {
        // Check the final assistant message for errors.
        for (const msg of event.messages) {
          if (
            (msg as { role: string }).role === "assistant" &&
            (msg as { stopReason?: string }).stopReason === "error"
          ) {
            // Surface the error so the caller can update message status in Convex.
            throw new Error(
              (msg as { errorMessage?: string }).errorMessage ?? "Agent turn failed"
            );
          }
        }
        break;
      }
    }
  });

  try {
    await agent.prompt(userMessage);
  } finally {
    unsubscribe();
  }
}
