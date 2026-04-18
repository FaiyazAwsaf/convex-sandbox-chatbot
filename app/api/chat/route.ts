import { type NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { sandboxManager } from "../../../lib/sandbox";
import { createAgentForThread, runAgentTurn } from "../../../lib/agent";
import type { ToolCallInfo } from "../../../lib/agent";

// ---------------------------------------------------------------------------
// Agent cache
// ---------------------------------------------------------------------------
// Agents are stateful — they accumulate conversation history. Cache by threadId
// so the same agent instance handles successive turns within a warm server process.
// NOTE: This is an in-process cache.  On cold-starts (serverless) a fresh agent
//       is created and prior history is not replayed.  A future improvement would
//       be to prime the agent from the Convex message log on cache miss.
const agentCache = new Map<string, ReturnType<typeof createAgentForThread>>();

function getOrCreateAgent(threadId: string, sandboxId: string) {
  let agent = agentCache.get(threadId);
  if (!agent) {
    agent = createAgentForThread(threadId, sandboxId);
    agentCache.set(threadId, agent);
  }
  return agent;
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------
interface ChatRequest {
  threadId: string;
  message: string;
  sandboxId?: string;
}

// ---------------------------------------------------------------------------
// POST /api/chat
// ---------------------------------------------------------------------------
export async function POST(req: NextRequest) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // threadId arrives as a plain string from JSON; cast to the branded Convex type.
  const threadId = body.threadId as Id<"threads">;
  const { message, sandboxId: incomingSandboxId } = body;

  if (!threadId || !message) {
    return new Response(
      JSON.stringify({ error: "threadId and message are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  // Each request gets its own client — ConvexHttpClient is stateful and must
  // not be shared across concurrent requests.
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

  // ---------------------------------------------------------------------------
  // Set up the ReadableStream for Server-Sent Events
  // ---------------------------------------------------------------------------
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      streamClosed = true;
    },
  });

  function sendEvent(data: Record<string, unknown>) {
    if (streamClosed) return;
    try {
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      // Stream was closed by the client mid-response — ignore.
      streamClosed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Main async work — fires after Response is returned so SSE can start flowing
  // ---------------------------------------------------------------------------
  (async () => {
    let sandboxId: string | undefined = incomingSandboxId;
    let assistantMessageId: Id<"messages"> | null = null;

    try {
      // 1. Provision sandbox if this is the first message on the thread
      if (!sandboxId) {
        sendEvent({ type: "status", text: "Creating sandbox…" });
        sandboxId = await sandboxManager.createSandbox(threadId);
        await convex.mutation(api.threads.updateThreadSandbox, {
          threadId,
          sandboxId,
        });
        sendEvent({ type: "sandbox_ready", sandboxId });
      }

      // 2. Persist the user message in Convex
      await convex.mutation(api.messages.sendMessage, {
        threadId,
        content: message,
      });

      // 3. Create an empty assistant message (status: "streaming") in Convex.
      //    The UI can subscribe to this document and watch it fill in.
      assistantMessageId = await convex.mutation(
        api.messages.appendAssistantMessage,
        { threadId }
      );

      sendEvent({ type: "message_start", messageId: assistantMessageId });

      // 4. Get (or create) the stateful Pi Agent for this thread
      const agent = getOrCreateAgent(threadId, sandboxId);

      // Counter for tool execution ordering within this turn
      let toolOrder = 0;

      // Map from toolCallId → start-phase metadata so we can log a complete
      // row to Convex on end (tool_execution_end doesn't carry args).
      const pendingTools = new Map<
        string,
        { toolName: string; args: unknown; order: number }
      >();

      // Accumulate streamed tokens locally; flush to Convex once at the end
      // to avoid hitting Convex mutation rate limits during fast streams.
      let accumulatedContent = "";

      // 5. Run the agent turn
      await runAgentTurn(
        agent,
        message,
        // onToolCall — fired twice per tool (start + end)
        async (info: ToolCallInfo) => {
          if (info.phase === "start") {
            pendingTools.set(info.toolCallId, {
              toolName: info.toolName,
              args: info.args,
              order: toolOrder++,
            });

            sendEvent({
              type: "tool_start",
              toolCallId: info.toolCallId,
              toolName: info.toolName,
              args: info.args,
            });
          } else {
            // end — correlate with the start-phase record
            const pending = pendingTools.get(info.toolCallId);
            pendingTools.delete(info.toolCallId);

            const input = JSON.stringify(pending?.args ?? {});
            const output = JSON.stringify(info.result ?? "");
            const executionOrder = pending?.order ?? 0;

            await convex.mutation(api.toolLogs.logTool, {
              threadId,
              messageId: assistantMessageId!,
              toolName: info.toolName,
              input,
              output,
              executionOrder,
            });

            sendEvent({
              type: "tool_end",
              toolCallId: info.toolCallId,
              toolName: info.toolName,
              isError: info.isError ?? false,
            });
          }
        },
        // onToken — stream each text delta to the client via SSE
        async (token: string) => {
          accumulatedContent += token;
          sendEvent({ type: "token", text: token });
        }
      );

      // 6. Persist the full assistant content and mark done
      await convex.mutation(api.messages.updateMessage, {
        messageId: assistantMessageId!,
        content: accumulatedContent,
        status: "done",
      });

      sendEvent({ type: "done" });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Best-effort: mark the in-progress assistant message as errored
      if (assistantMessageId) {
        await convex
          .mutation(api.messages.updateMessage, { messageId: assistantMessageId, status: "error" })
          .catch(() => {});
      }

      sendEvent({ type: "error", message: errorMessage });
    } finally {
      streamClosed = true;
      try {
        streamController.close();
      } catch {
        // Already closed (e.g. client disconnected) — safe to ignore.
      }
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Tell Nginx / Vercel edge not to buffer the stream
      "X-Accel-Buffering": "no",
    },
  });
}
