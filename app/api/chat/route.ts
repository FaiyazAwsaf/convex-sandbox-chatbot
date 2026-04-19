import { type NextRequest } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { sandboxManager } from "../../../lib/sandbox";
import { runAgentInSandbox } from "../../../lib/agent";

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
// Orchestrates one conversation turn:
//   1. Provision a Daytona VM for the thread (first message only)
//   2. Persist the user message and create a streaming assistant placeholder
//   3. Upload the Pi Agent runner script and execute it INSIDE the VM
//
// The agent script running in the VM writes token deltas and tool logs
// directly to Convex via HTTP. The browser's useQuery subscriptions pick
// up those changes in real-time over the Convex WebSocket — no SSE token
// forwarding needed here. SSE is used only for lifecycle events.
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
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

  // ---------------------------------------------------------------------------
  // SSE stream — lifecycle events only (status, sandbox_ready, done, error)
  // Token deltas are written by the in-VM script directly to Convex.
  // ---------------------------------------------------------------------------
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let streamClosed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; },
    cancel()          { streamClosed = true; },
  });

  function sendEvent(data: Record<string, unknown>) {
    if (streamClosed) return;
    try {
      streamController.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    } catch {
      streamClosed = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Main async work — runs after the SSE Response is returned
  // ---------------------------------------------------------------------------
  (async () => {
    let sandboxId: string | undefined = incomingSandboxId;
    let assistantMessageId: Id<"messages"> | null = null;

    try {
      // 1. Provision sandbox on the first message in a thread.
      if (!sandboxId) {
        sendEvent({ type: "status", text: "Creating sandbox…" });
        sandboxId = await sandboxManager.createSandbox(threadId);
        await convex.mutation(api.threads.updateThreadSandbox, { threadId, sandboxId });
        sendEvent({ type: "sandbox_ready", sandboxId });
      }

      // 2. Persist the user message.
      await convex.mutation(api.messages.sendMessage, { threadId, content: message });

      // 3. Create an empty streaming assistant placeholder.
      //    The in-VM script fills it in via appendMessageContent mutations.
      assistantMessageId = await convex.mutation(
        api.messages.appendAssistantMessage,
        { threadId }
      );

      sendEvent({ type: "message_start", messageId: assistantMessageId });

      // 4. Upload and run the Pi Agent script inside the VM.
      //    The script writes tokens + tool logs to Convex and marks the
      //    message "done" or "error" before exiting.
      await runAgentInSandbox({
        sandboxId,
        threadId,
        messageId: assistantMessageId,
        userMessage: message,
      });

      sendEvent({ type: "done" });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Best-effort: ensure the message is marked errored if the script didn't
      // get a chance to do it itself.
      if (assistantMessageId) {
        await convex
          .mutation(api.messages.updateMessage, {
            messageId: assistantMessageId,
            status: "error",
          })
          .catch(() => {});
      }

      sendEvent({ type: "error", message: errorMessage });
    } finally {
      streamClosed = true;
      try { streamController.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
