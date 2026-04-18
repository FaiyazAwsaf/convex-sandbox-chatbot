"use client";

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
// ---------------------------------------------------------------------------
// Types that mirror the Convex schema
// ---------------------------------------------------------------------------
interface Thread {
  _id: Id<"threads">;
  title: string;
  sandboxId?: string;
  status: "creating" | "active" | "closed";
  createdAt: number;
}

interface Message {
  _id: Id<"messages">;
  threadId: Id<"threads">;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "streaming" | "done" | "error";
  createdAt: number;
}

interface ToolLog {
  _id: Id<"toolLogs">;
  threadId: Id<"threads">;
  messageId: Id<"messages">;
  toolName: string;
  input: string;
  output: string;
  executionOrder: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// ToolLogRow — collapsible tool call entry
// ---------------------------------------------------------------------------
function ToolLogRow({ log }: { log: ToolLog }) {
  const [open, setOpen] = useState(false);

  let inputPretty = log.input;
  let outputPretty = log.output;
  try { inputPretty = JSON.stringify(JSON.parse(log.input), null, 2); } catch { /* leave raw */ }
  try { outputPretty = JSON.stringify(JSON.parse(log.output), null, 2); } catch { /* leave raw */ }

  const hasOutput = log.output && log.output !== '""' && log.output !== "";

  return (
    <div className="border border-gray-700 rounded mb-1 text-xs font-mono">
      <button
        className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-800 hover:bg-gray-750 text-left rounded"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-yellow-400 font-semibold">{log.toolName}</span>
        <span className="text-gray-500">#{log.executionOrder}</span>
        {!hasOutput && (
          <span className="ml-auto text-gray-500 animate-pulse">running…</span>
        )}
        <span className="ml-auto text-gray-500">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="px-3 py-2 bg-gray-900 space-y-2 rounded-b">
          <div>
            <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">Input</div>
            <pre className="whitespace-pre-wrap break-all text-green-300 bg-gray-950 rounded p-2 max-h-40 overflow-auto">
              {inputPretty}
            </pre>
          </div>
          {hasOutput && (
            <div>
              <div className="text-gray-500 uppercase text-[10px] tracking-wider mb-1">Output</div>
              <pre className="whitespace-pre-wrap break-all text-blue-300 bg-gray-950 rounded p-2 max-h-40 overflow-auto">
                {outputPretty}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble
// ---------------------------------------------------------------------------
function MessageBubble({
  message,
  toolLogs,
}: {
  message: Message;
  toolLogs: ToolLog[];
}) {
  const isUser = message.role === "user";
  const isStreaming = message.status === "streaming";
  const isError = message.status === "error";

  // Tool logs that belong to this assistant message
  const myLogs = toolLogs
    .filter((l) => l.messageId === message._id)
    .sort((a, b) => a.executionOrder - b.executionOrder);

  return (
    <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {/* Role label */}
      <span className="text-[10px] uppercase tracking-widest text-gray-500 px-1">
        {isUser ? "You" : "Assistant"}
      </span>

      {/* Tool logs above the assistant message (only for assistant) */}
      {!isUser && myLogs.length > 0 && (
        <div className="w-full mb-1">
          {myLogs.map((log) => (
            <ToolLogRow key={log._id as string} log={log} />
          ))}
        </div>
      )}

      {/* Bubble */}
      <div
        className={[
          "max-w-[85%] rounded-xl px-4 py-2.5 text-sm leading-relaxed",
          isUser
            ? "bg-blue-600 text-white rounded-br-sm"
            : isError
            ? "bg-red-900/50 border border-red-700 text-red-300 rounded-bl-sm"
            : "bg-gray-800 text-gray-100 rounded-bl-sm",
        ].join(" ")}
      >
        {isError ? (
          <span>Error generating response.</span>
        ) : (
          <>
            <span className="whitespace-pre-wrap">{message.content}</span>
            {isStreaming && (
              <span className="inline-block w-2 h-4 bg-gray-300 ml-1 align-middle animate-pulse rounded-sm" />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — thread list
// ---------------------------------------------------------------------------
function Sidebar({
  threads,
  selectedId,
  onSelect,
  onNewThread,
}: {
  threads: Thread[] | undefined;
  selectedId: string | null;
  onSelect: (t: Thread) => void;
  onNewThread: () => void;
}) {
  return (
    <aside className="w-64 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col h-full">
      {/* Header */}
      <div className="p-3 border-b border-gray-800">
        <button
          onClick={onNewThread}
          className="w-full bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium py-2 px-3 rounded-lg transition-colors"
        >
          + New Conversation
        </button>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto py-1">
        {threads === undefined && (
          <p className="text-gray-500 text-xs text-center mt-4">Loading…</p>
        )}
        {threads?.length === 0 && (
          <p className="text-gray-500 text-xs text-center mt-4">No conversations yet.</p>
        )}
        {threads?.map((thread) => (
          <button
            key={thread._id as string}
            onClick={() => onSelect(thread)}
            className={[
              "w-full text-left px-3 py-2.5 flex flex-col gap-0.5 hover:bg-gray-800 transition-colors",
              selectedId === thread._id ? "bg-gray-800 border-l-2 border-blue-500" : "border-l-2 border-transparent",
            ].join(" ")}
          >
            <span className="text-sm text-gray-100 truncate">{thread.title}</span>
            <span
              className={[
                "text-[10px] uppercase tracking-wider",
                thread.status === "active"
                  ? "text-green-400"
                  : thread.status === "creating"
                  ? "text-yellow-400"
                  : "text-gray-500",
              ].join(" ")}
            >
              {thread.status}
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function Home() {
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  // Track the sandboxId locally so the first send can pass it once it's known
  const [localSandboxId, setLocalSandboxId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  // Status text shown above the input (e.g. "Creating sandbox…")
  const [statusText, setStatusText] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // --- Convex queries ---
  const threads = useQuery(api.threads.listThreads) as Thread[] | undefined;
  const messages = useQuery(
    api.messages.getMessages,
    selectedThread ? { threadId: selectedThread._id } : "skip"
  ) as Message[] | undefined;
  const toolLogs = useQuery(
    api.toolLogs.getToolLogs,
    selectedThread ? { threadId: selectedThread._id } : "skip"
  ) as ToolLog[] | undefined;

  // --- Convex mutations ---
  const createThread = useMutation(api.threads.createThread);

  // Scroll to bottom whenever messages update
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // When the selected thread gets a sandboxId back from Convex, cache it locally
  useEffect(() => {
    if (selectedThread?.sandboxId && !localSandboxId) {
      setLocalSandboxId(selectedThread.sandboxId);
    }
  }, [selectedThread?.sandboxId, localSandboxId]);

  // Keep selectedThread in sync with live Convex thread list
  useEffect(() => {
    if (!selectedThread || !threads) return;
    const updated = threads.find((t) => t._id === selectedThread._id);
    if (updated) setSelectedThread(updated);
  }, [threads]); // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  async function handleNewThread() {
    const title = `Conversation ${new Date().toLocaleString()}`;
    const id = await createThread({ title }) as Id<"threads">;
    const newThread: Thread = {
      _id: id,
      title,
      status: "creating",
      createdAt: Date.now(),
    };
    setSelectedThread(newThread);
    setLocalSandboxId(null);
    setStatusText(null);
    inputRef.current?.focus();
  }

  async function handleSend() {
    if (!input.trim() || !selectedThread || isSending) return;

    const message = input.trim();
    setInput("");
    setIsSending(true);
    setStatusText(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: selectedThread._id,
          message,
          sandboxId: localSandboxId ?? selectedThread.sandboxId ?? undefined,
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      // Consume the SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          switch (event.type) {
            case "status":
              setStatusText(event.text as string);
              break;
            case "sandbox_ready":
              setLocalSandboxId(event.sandboxId as string);
              setStatusText(null);
              break;
            case "message_start":
            case "token":
              // Convex real-time subscription picks these up automatically
              setStatusText(null);
              break;
            case "done":
              setStatusText(null);
              break;
            case "error":
              setStatusText(`Error: ${event.message as string}`);
              break;
          }
        }
      }
    } catch (err) {
      setStatusText(`Failed to send: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  const isStreaming = messages?.some((m) => m.status === "streaming") ?? false;

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* LEFT SIDEBAR */}
      <Sidebar
        threads={threads}
        selectedId={selectedThread?._id ?? null}
        onSelect={(t) => {
          setSelectedThread(t);
          setLocalSandboxId(t.sandboxId ?? null);
          setStatusText(null);
        }}
        onNewThread={handleNewThread}
      />

      {/* MAIN AREA */}
      <div className="flex-1 flex flex-col min-w-0 h-full">
        {!selectedThread ? (
          // Empty state
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              <p className="text-lg mb-1">No conversation selected</p>
              <p className="text-sm">Click "New Conversation" to start</p>
            </div>
          </div>
        ) : (
          <>
            {/* Thread header */}
            <div className="border-b border-gray-800 px-4 py-3 flex items-center gap-3 flex-shrink-0">
              <span className="font-medium truncate">{selectedThread.title}</span>
              <span
                className={[
                  "text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full",
                  selectedThread.status === "active"
                    ? "bg-green-900 text-green-400"
                    : selectedThread.status === "creating"
                    ? "bg-yellow-900 text-yellow-400"
                    : "bg-gray-800 text-gray-500",
                ].join(" ")}
              >
                {selectedThread.status}
              </span>
              {selectedThread.sandboxId && (
                <span className="text-[10px] text-gray-600 font-mono ml-auto truncate">
                  sandbox: {selectedThread.sandboxId.slice(0, 12)}…
                </span>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {messages === undefined && (
                <p className="text-gray-500 text-sm text-center mt-8">Loading messages…</p>
              )}
              {messages?.length === 0 && (
                <p className="text-gray-500 text-sm text-center mt-8">
                  Send a message to start the conversation.
                  {!selectedThread.sandboxId && (
                    <span className="block mt-1 text-xs text-yellow-500">
                      A sandbox VM will be provisioned on your first message.
                    </span>
                  )}
                </p>
              )}
              {messages?.map((msg) => (
                <MessageBubble
                  key={msg._id as string}
                  message={msg}
                  toolLogs={toolLogs ?? []}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Status bar */}
            {(statusText || isStreaming) && (
              <div className="px-4 py-1.5 text-xs text-yellow-400 flex items-center gap-2 border-t border-gray-800 bg-gray-900 flex-shrink-0">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                {statusText ?? "Agent is responding…"}
              </div>
            )}

            {/* Input area */}
            <div className="border-t border-gray-800 p-3 flex-shrink-0">
              <div className="flex gap-2 items-end">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  placeholder={
                    isSending ? "Waiting for response…" : "Message the agent… (Enter to send, Shift+Enter for newline)"
                  }
                  disabled={isSending}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none disabled:opacity-50 leading-relaxed max-h-40 overflow-auto"
                  style={{ fieldSizing: "content" } as React.CSSProperties}
                />
                <button
                  onClick={handleSend}
                  disabled={!input.trim() || isSending}
                  className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-shrink-0"
                >
                  Send
                </button>
              </div>
              <p className="text-[10px] text-gray-600 mt-1.5 pl-1">
                Enter ↵ to send · Shift+Enter for newline · Tool calls shown inline above responses
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
