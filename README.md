# Convex Sandbox Chatbot

A chatbot platform where every conversation thread runs inside its own isolated Daytona VM. The AI agent (Pi Agent) executes code, reads files, and browses the web from within the VM — never from the Next.js server. Convex serves as the real-time backend that persists messages, tool logs, and session state.

Built as a systems design assessment demonstrating multi-plane architecture, real-time observability, and sandboxed AI execution.

---

## Architecture

The system is split into three independent planes. Each plane has a single responsibility and communicates with the others over well-defined interfaces.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PLANE 1 — UI  (Next.js / React)                                        │
│                                                                          │
│   Browser                                                                │
│   ┌─────────────────────────────────────────────────────┐               │
│   │  app/page.tsx                                        │               │
│   │  ├─ Sidebar: useQuery(threads.listThreads)           │               │
│   │  ├─ Messages: useQuery(messages.getMessages)         │  ←── Convex  │
│   │  ├─ Tool logs: useQuery(toolLogs.getToolLogs)        │    WebSocket  │
│   │  └─ Input box → POST /api/chat ──────────────────────────────┐      │
│   └─────────────────────────────────────────────────────┘        │      │
└──────────────────────────────────────────────────────────────────│──────┘
                                                                   │ SSE
┌──────────────────────────────────────────────────────────────────│──────┐
│  PLANE 2 — CONTROL  (Convex + Next.js API route)                 │      │
│                                                                   ▼      │
│   app/api/chat/route.ts  (POST /api/chat)                               │
│   ├─ Provisions Daytona VM on first message                             │
│   ├─ Persists user message → Convex                                     │
│   ├─ Creates streaming assistant message → Convex                       │
│   ├─ Runs Pi Agent turn (lib/agent.ts)                                  │
│   ├─ Streams SSE tokens → browser                                       │
│   └─ Writes tool logs + final content → Convex                         │
│                                                                          │
│   Convex (cloud)                                                         │
│   ├─ threads    { title, sandboxId, status }                            │
│   ├─ messages   { role, content, status: streaming|done|error }         │
│   ├─ toolLogs   { toolName, input, output, executionOrder }             │
│   └─ sessions   { threadId, sandboxId, status }                         │
└──────────────────────────────────────────┬──────────────────────────────┘
                                           │ Daytona SDK (HTTP)
┌──────────────────────────────────────────▼──────────────────────────────┐
│  PLANE 3 — EXECUTION  (Daytona VM, one per thread)                      │
│                                                                          │
│   Isolated VM                                                            │
│   ├─ bash      → sandbox.process.executeCommand(cmd)                    │
│   ├─ read      → sandbox.fs.downloadFile(path)                          │
│   ├─ write     → sandbox.fs.uploadFile(buffer, path)                    │
│   ├─ edit      → read + string replace + write                          │
│   ├─ grep      → bash: grep -rn <pattern> <path>                        │
│   ├─ glob      → bash: shopt globstar; for f in <pattern>; echo $f      │
│   ├─ webfetch  → bash: curl -sL <url> | head -c 51200                   │
│   └─ websearch → bash: curl DuckDuckGo Instant Answer API               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why Pi Agent runs in the orchestrator (not inside the VM)

The original design intent is for the agent reasoning loop itself to run inside the Daytona VM, with the VM hosting a TypeScript runtime, the Anthropic SDK, and an HTTP server. This would provide maximum isolation — a compromised prompt couldn't affect the host server at all.

The current implementation makes a practical tradeoff: the Pi Agent reasoning loop runs in the Next.js API route, but every tool call it makes executes **inside** the VM via the Daytona SDK. The VM still provides full isolation at the tool layer — shell commands, filesystem access, and outbound HTTP all run inside the ephemeral container. LLM calls go directly from the server to Anthropic's API over HTTPS, which is acceptable since they carry no host credentials.

The benefit of this tradeoff is significantly reduced VM bootstrap complexity — no need to bundle the Anthropic SDK, manage long-lived processes inside the VM, or implement a bidirectional communication protocol between the host and the in-VM agent.

---

## How Components Interact

### Step-by-step: User message → Agent response

```
1. User clicks "New Conversation"
   └─ useMutation(threads.createThread) → Convex inserts thread (status: "creating")

2. User types a message and presses Enter
   └─ Browser POSTs { threadId, message, sandboxId? } to /api/chat

3. API route: first message on thread → provision VM
   ├─ sandboxManager.createSandbox(threadId)           # Daytona API call
   │   └─ Creates isolated TypeScript VM, auto-stops after 10 min idle
   └─ convex.mutation(threads.updateThreadSandbox)      # sandboxId + status: "active"
      └─ Convex WebSocket pushes update → browser sidebar shows "active"

4. API route: persist the user message
   └─ convex.mutation(messages.sendMessage)             # role: "user", status: "done"

5. API route: create a placeholder assistant message
   └─ convex.mutation(messages.appendAssistantMessage)  # role: "assistant", status: "streaming"
      └─ Convex WebSocket pushes it → browser shows blinking cursor

6. API route: run the Pi Agent turn
   ├─ agent.subscribe(event => ...)
   └─ agent.prompt(userMessage)
       │
       ├─ LLM streams text deltas
       │   └─ onToken(delta) → SSE "token" event → browser appends to message bubble
       │
       ├─ LLM requests a tool call (e.g. bash { command: "ls /home" })
       │   ├─ onToolCall({ phase: "start", ... })
       │   │   └─ SSE "tool_start" event → browser shows tool running indicator
       │   ├─ sandboxManager.runCommand(sandboxId, "ls /home")  # runs INSIDE VM
       │   └─ onToolCall({ phase: "end", result, ... })
       │       ├─ SSE "tool_end" event
       │       └─ convex.mutation(toolLogs.logTool)     # persisted for observability
       │           └─ Convex WebSocket → browser shows collapsible tool log
       │
       └─ LLM produces final stop message

7. API route: finalize
   ├─ convex.mutation(messages.updateMessage, { content, status: "done" })
   │   └─ Convex WebSocket → browser blinking cursor disappears
   └─ SSE "done" event → client closes stream
```

### Convex as the source of truth

Convex acts as a persistent, reactive store that decouples the SSE stream from the UI. Even if the browser disconnects mid-stream and reconnects, `useQuery(messages.getMessages)` will return the current accumulated state. The SSE stream is an optimistic fast path; Convex is the durable record.

### Daytona VM lifecycle

| Event | Action | VM State |
|---|---|---|
| First message on thread | `createSandbox()` | Boots, billing starts |
| No activity for 10 minutes | Auto-stop (configured at creation) | Stopped, billing pauses |
| Thread closed | `deleteSandbox()` — stop then delete | VM released |
| Subsequent messages on stopped VM | `runCommand()` auto-wakes VM | Running again |

Each thread gets exactly one VM for its lifetime. The `sandboxId` is persisted in the `threads` table so it survives Next.js cold starts.

---

## Tech Stack

| Technology | Role | Why chosen |
|---|---|---|
| **Next.js 16** | Frontend + API routes | App Router gives server components, streaming responses, and edge-compatible API routes in one framework |
| **React 19** | UI rendering | Concurrent features align well with real-time chat; `useTransition` prevents input lag during Convex mutations |
| **Convex** | Realtime database + backend | Built-in WebSocket subscriptions (`useQuery`) mean zero polling code; mutations are transactional; schema is TypeScript-native with generated `Id<T>` types |
| **Daytona SDK** | VM provisioning + execution | Managed sandbox lifecycle (create/start/stop/delete) with per-sandbox filesystem and process APIs; TypeScript SDK with strong types |
| **Pi Agent** (`@mariozechner/pi-agent-core`) | Agent reasoning loop | Lightweight, event-driven agent framework purpose-built for tool-calling LLMs; clean subscribe/prompt API with typed tool definitions |
| **`@mariozechner/pi-ai`** | LLM provider abstraction | Wraps Anthropic's API with typed model selection (`getModel("anthropic", "claude-sonnet-4-6")`) |
| **Tailwind CSS 4** | Styling | Utility-first, zero-runtime CSS; v4's `@import "tailwindcss"` directive eliminates most config boilerplate |
| **TypeScript 6** | Type safety across all layers | Convex generates typed `Id<T>` for table foreign keys; Pi Agent's `AgentTool<T>` types tool parameters end-to-end |
| **`tsx`** | Running TypeScript scripts directly | Used for the smoke-test (`npx tsx test.ts`) without a separate build step |

---

## Tradeoffs Made

### Simplified for this assessment

**Agent runs in Next.js, not inside the VM.**
The design spec requires the Pi Agent to run *inside* the Daytona VM. This would require bootstrapping a TypeScript runtime inside each ephemeral container, copying the agent bundle on VM creation, and running a local HTTP server inside the VM for bidirectional communication. The current approach trades that complexity for a simpler architecture: the agent runs in Next.js but dispatches all tool execution into the VM — isolation at the tool layer rather than the LLM layer.

**In-process agent cache, no cold-start recovery.**
The `agentCache` Map survives warm requests but is lost on serverless cold starts. A production system would serialize the agent's conversation history to Convex and rehydrate on cache miss, so a new server instance can continue mid-conversation without losing context.

**Token streaming flushes once at the end.**
Streamed tokens are accumulated in memory and written to Convex as a single mutation after the agent turn completes, rather than after each token. This avoids hitting Convex's mutation rate limits during fast streams but means Convex's copy of the message lags the SSE stream. The `appendMessageContent` mutation exists for a future incremental flush approach.

**No authentication.**
There is no user identity, login, or access control. Any client with a `threadId` can send messages to that thread. Production would require Convex Auth (Clerk, Auth0, or custom JWT) with per-user thread ownership enforced in mutation handlers.

**Tool output is truncated.**
`webfetch` caps at 50 KB and `grep` returns up to 250 lines. Production agents need smarter chunking — semantic search over indexed content rather than full-file reads.

**Delete permission not available on test API key.**
The Daytona API key in the test environment has create/execute/stop permissions but not delete. `deleteSandbox()` degrades gracefully: it stops the sandbox (halting billing) and logs a warning; actual deletion requires an API key with the `sandbox:delete` scope.

### What would be different in production

| Concern | Current | Production |
|---|---|---|
| Agent location | Next.js server process | Inside Daytona VM, communicating over localhost HTTP |
| Auth | None | Convex Auth + per-user thread ownership |
| Cold-start recovery | Agent history lost | Hydrate from Convex message log on cache miss |
| Token persistence | Single flush at turn end | `appendMessageContent` per N tokens for live Convex sync |
| VM provisioning | On first message (slow) | Pool of pre-warmed VMs; assign on thread creation |
| Observability | Tool logs in Convex | Structured logs + Datadog/Grafana; alert on agent error rate |
| Dangling VMs | Auto-stop after 10 min | Cron job to reap VMs abandoned longer than N hours |
| Secrets | `.env.local` | Secrets manager (Vault, AWS Secrets Manager) with rotation |

---

## Setup & Running

### Prerequisites

- Node.js 20+
- A [Convex](https://dashboard.convex.dev) account (free tier works)
- A [Daytona](https://app.daytona.io) account with an API key
- An [Anthropic](https://console.anthropic.com) API key

### 1. Clone and install

```bash
git clone https://github.com/FaiyazAwsaf/convex-sandbox-chatbot.git
cd convex-sandbox-chatbot
npm install
```

### 2. Configure environment variables

Create `.env.local` at the project root:

```env
# Daytona — VM provisioning and execution
DAYTONA_API_KEY=your_daytona_api_key
DAYTONA_API_URL=https://app.daytona.io/api

# Convex — filled automatically by `npx convex dev` after login
CONVEX_DEPLOYMENT=dev:your-deployment-slug
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://your-deployment.convex.site

# Anthropic — LLM completions for the Pi Agent
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Initialize Convex

Log in and push the schema (this also generates `convex/_generated/`):

```bash
npx convex dev --once
```

If this is your first time, `convex dev` will prompt you to log in and create a project. The `CONVEX_DEPLOYMENT` and `NEXT_PUBLIC_CONVEX_URL` values will be written to `.env.local` automatically.

### 4. Run the smoke-test (optional)

Verify that your Daytona API key can create sandboxes and execute commands:

```bash
npx tsx test.ts
```

Expected output:
```
[ 1/3 ] Creating sandbox for thread: test-thread-...
       ✓ sandboxId: xxxxxxxx-...
[ 2/3 ] Running `echo hello` inside sandbox
       ✓ output: hello
[ 3/3 ] Deleting sandbox
       ✓ deleted
```

### 5. Start the development servers

Run Convex and Next.js concurrently in two terminals:

```bash
# Terminal 1 — Convex (watches schema changes, pushes functions live)
npm run convex:dev

# Terminal 2 — Next.js dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 6. Using the app

1. Click **+ New Conversation** in the left sidebar.
2. Type a message and press **Enter**. On the first message, a Daytona VM is provisioned (~10–30 seconds). A status bar shows "Creating sandbox…".
3. The agent responds in real-time. Tool calls (bash, file reads, web fetches) appear inline as collapsible panels beneath the response — this is the observability panel.
4. Subsequent messages on the same thread reuse the existing VM instantly.

---

## Environment Variables

| Variable | Required | Description | Where to get it |
|---|---|---|---|
| `DAYTONA_API_KEY` | Yes | Authenticates requests to the Daytona API for VM provisioning and command execution | [app.daytona.io](https://app.daytona.io) → Settings → API Keys |
| `DAYTONA_API_URL` | No | Base URL of the Daytona API. Defaults to `https://app.daytona.io/api` if unset | Only needed for self-hosted Daytona |
| `ANTHROPIC_API_KEY` | Yes | Authenticates requests to Anthropic's API for LLM completions (Claude Sonnet 4.6) | [console.anthropic.com](https://console.anthropic.com) → API Keys |
| `CONVEX_DEPLOYMENT` | Yes | Identifies the Convex deployment. Format: `dev:slug` or `prod:slug` | Set automatically by `npx convex dev` |
| `NEXT_PUBLIC_CONVEX_URL` | Yes | WebSocket + HTTP URL for the Convex React client (browser-visible) | Set automatically by `npx convex dev` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | No | HTTP Actions URL for the Convex deployment. Needed only if adding Convex HTTP endpoints | Set automatically by `npx convex dev` |

> **Security note:** Variables prefixed `NEXT_PUBLIC_` are bundled into the browser bundle. Never put secret keys (API keys, tokens) in `NEXT_PUBLIC_` variables.

---

## Project Structure

```
convex-sandbox-chatbot/
├── app/
│   ├── api/chat/route.ts        # POST /api/chat — SSE orchestrator endpoint
│   ├── ConvexClientProvider.tsx # Client-side ConvexProvider wrapper
│   ├── ErrorBoundary.tsx        # React class-based error boundary
│   ├── globals.css              # Tailwind CSS v4 entry point
│   ├── layout.tsx               # Root layout — ConvexProvider + ErrorBoundary
│   └── page.tsx                 # Chat UI: sidebar, messages, tool log panel
├── convex/
│   ├── schema.ts                # Database schema (threads, messages, toolLogs, sessions)
│   ├── threads.ts               # createThread, listThreads, updateThreadSandbox
│   ├── messages.ts              # sendMessage, appendAssistantMessage, updateMessage, getMessages
│   ├── toolLogs.ts              # logTool, updateToolLog, getToolLogs
│   └── _generated/              # Auto-generated by `npx convex dev` — do not edit
├── lib/
│   ├── agent.ts                 # Pi Agent: createAgentForThread, runAgentTurn, all 8 tools
│   └── sandbox.ts               # SandboxManager: Daytona VM lifecycle (create/run/read/write/delete)
├── test.ts                      # Sandbox smoke-test: create → run command → delete
├── CLAUDE.md                    # Project specification (AI assistant context)
└── .env.local                   # Environment variables — not committed to git
```

---

## Database Schema

```
threads
  _id          Id<"threads">
  title        string
  sandboxId?   string          -- populated after VM is provisioned
  status       "creating" | "active" | "closed"
  createdAt    number          -- index: by_createdAt (sidebar sort)

messages
  _id          Id<"messages">
  threadId     Id<"threads">   -- index: by_thread
  role         "user" | "assistant" | "system"
  content      string          -- accumulates during streaming
  status       "pending" | "streaming" | "done" | "error"
  createdAt    number

toolLogs
  _id             Id<"toolLogs">
  threadId        Id<"threads">   -- index: by_thread
  messageId       Id<"messages">  -- index: by_message
  toolName        string          -- bash | read | write | edit | grep | glob | webfetch | websearch
  input           string          -- JSON-stringified tool arguments
  output          string          -- JSON-stringified result; empty string until complete
  executionOrder  number          -- ordering within a single assistant turn
  createdAt       number

sessions
  _id          Id<"sessions">
  threadId     Id<"threads">   -- index: by_thread
  sandboxId    string
  status       "active" | "stopped"
```
