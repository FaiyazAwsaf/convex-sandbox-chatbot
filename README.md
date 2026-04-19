# Convex Sandbox Chatbot

A chatbot where every conversation thread gets its own isolated Daytona VM. The Pi Agent reasoning loop runs **inside** that VM — not on the Next.js server. Convex is the real-time backend/database. TypeScript throughout.

---

## Architecture

Three independent planes with single responsibilities:

```
┌──────────────────────────────────────────────────────────────────┐
│  PLANE 1 — UI  (Next.js / React)                                 │
│                                                                  │
│   Browser                                                        │
│   ├─ Sidebar:   useQuery(threads.listThreads)    ←── Convex WS   │
│   ├─ Messages:  useQuery(messages.getMessages)   ←── Convex WS   │
│   ├─ Tool logs: useQuery(toolLogs.getToolLogs)   ←── Convex WS   │
│   └─ Input box → POST /api/chat ─────────────────────────┐       │
└─────────────────────────────────────────────────────────-│───────┘
                                                           │ SSE (lifecycle only)
┌──────────────────────────────────────────────────────────│───────┐
│  PLANE 2 — CONTROL  (Next.js API + Convex)               ▼       │
│                                                                  │
│   app/api/chat/route.ts                                          │
│   ├─ Provisions Daytona VM on first message                      │
│   ├─ Persists user message + creates assistant placeholder       │
│   ├─ Builds agent script → uploads to VM → executes via tsx      │
│   └─ Emits SSE: status | sandbox_ready | message_start | done   │
│                                                                  │
│   Convex (cloud)                                                 │
│   ├─ threads   { title, sandboxId, status }                      │
│   ├─ messages  { role, content, status: streaming|done|error }   │
│   └─ toolLogs  { toolName, input, output, executionOrder }       │
└──────────────────────────────────────────┬───────────────────────┘
                                           │ Daytona SDK
┌──────────────────────────────────────────▼───────────────────────┐
│  PLANE 3 — EXECUTION  (Daytona VM, one per thread)               │
│                                                                  │
│   agent-runner.ts (runs inside VM via tsx)                       │
│   ├─ Fetches conversation history from Convex via HTTP           │
│   ├─ Constructs Pi Agent with 8 Node.js-native tools             │
│   ├─ On text_delta  → POST Convex messages:appendMessageContent  │
│   ├─ On tool_start  → POST Convex toolLogs:logTool               │
│   ├─ On tool_end    → POST Convex toolLogs:updateToolLog         │
│   └─ On done/error  → POST Convex messages:updateMessage         │
│                                                                  │
│   Tools (Node.js built-ins inside the VM)                        │
│   bash · read · write · edit · grep · glob · webfetch · websearch│
└──────────────────────────────────────────────────────────────────┘
```

---

## How Components Interact

### User message → agent response

```
1. User sends message → POST /api/chat

2. First message on thread:
   ├─ sandboxManager.createSandbox(threadId)    # Daytona: boot VM
   ├─ installDependencies()                     # npm install pi-agent-core, tsx, etc.
   └─ convex.mutation(threads.updateThreadSandbox)

3. Persist messages:
   ├─ convex.mutation(messages.sendMessage)          # user message
   └─ convex.mutation(messages.appendAssistantMessage) # streaming placeholder

4. Run agent inside VM:
   ├─ buildAgentScript() → self-contained TypeScript string
   ├─ sandboxManager.writeFile(vm, "/tmp/agent/agent-runner.ts", script)
   └─ sandbox.process.executeCommand("tsx agent-runner.ts", env)
          │
          │  Inside VM:
          ├─ Pi Agent receives USER_MESSAGE
          ├─ Streams token deltas → Convex (appendMessageContent)
          ├─ Executes tools using child_process / fs → results → Convex (toolLogs)
          └─ Marks message done/error → Convex (updateMessage)

5. Browser sees live updates via Convex WebSocket — no SSE token forwarding needed.
```

### Daytona VM lifecycle

| Event | Action |
|---|---|
| First message | `createSandbox()` → boot VM → install dependencies |
| Subsequent messages on stopped VM | `getSandbox()` auto-restarts |
| 10 min idle | Auto-stop (configured at VM creation) |
| Thread closed | `deleteSandbox()` → stop → delete |

Each thread maps to exactly one VM. `sandboxId` is persisted in Convex, surviving Next.js cold starts.

---

## Tech Stack

| Technology | Role |
|---|---|
| **Next.js** | Frontend + API orchestration route |
| **Convex** | Real-time reactive DB; WebSocket subscriptions replace polling |
| **Daytona SDK** | VM lifecycle (create/start/stop/delete) + FS + process execution |
| **Pi Agent** (`@mariozechner/pi-agent-core`) | Event-driven agent loop running inside the VM |
| **tsx** | Runs the TypeScript agent script inside the VM without a build step |
| **Tailwind CSS** | Styling |

---

## Tradeoffs

**Convex as the communication channel.**
`sandbox.process.executeCommand` does not stream stdout. Rather than polling or adding an HTTP server inside the VM, the in-VM agent script writes directly to Convex via the HTTP API (`POST /api/mutation`). The browser's `useQuery` subscriptions pick up changes instantly. SSE is used only for lifecycle events (sandbox_ready, done, error).

**Dependencies pre-installed at sandbox creation.**
`installDependencies()` runs `npm install` once per VM immediately after boot, before the first message. This adds ~30s to VM creation but means subsequent turns pay zero install cost.

**No authentication.**
Any client with a `threadId` can send messages. Production would require Convex Auth with per-user thread ownership enforced in mutation validators.

**Tool output truncated.**
`webfetch` caps at 50 KB; grep returns up to the shell default. Production agents would need smarter chunking or semantic search.

**No VM pooling.**
VMs are provisioned on demand (~15–30s cold start on first message). Production would maintain a pool of pre-warmed VMs for instant assignment.

---

## Setup

### Prerequisites

- Node.js 20+
- [Convex](https://dashboard.convex.dev) account
- [Daytona](https://app.daytona.io) account + API key
- [ChatLLM by Abacus AI](https://abacus.ai) account + API key

### 1. Install

```bash
git clone https://github.com/FaiyazAwsaf/convex-sandbox-chatbot.git
cd convex-sandbox-chatbot
npm install
```

### 2. Environment variables

Create `.env.local`:

```env
# Daytona
DAYTONA_API_KEY=your_daytona_api_key
DAYTONA_API_URL=https://app.daytona.io/api

# Convex (auto-filled by `npx convex dev`)
CONVEX_DEPLOYMENT=dev:your-deployment-slug
NEXT_PUBLIC_CONVEX_URL=https://your-deployment.convex.cloud

# ChatLLM (Abacus AI — OpenAI-compatible endpoint)
CHATLLM_API_KEY=your_chatllm_api_key
CHATLLM_BASE_URL=https://routellm.abacus.ai/v1
CHATLLM_MODEL=route-llm
```

### 3. Initialize Convex

```bash
npx convex dev --once
```

### 4. Start dev servers

```bash
# Terminal 1
npm run convex:dev

# Terminal 2
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DAYTONA_API_KEY` | Yes | Daytona API authentication |
| `DAYTONA_API_URL` | Yes | Daytona API base URL |
| `CONVEX_DEPLOYMENT` | Yes | Convex deployment identifier |
| `NEXT_PUBLIC_CONVEX_URL` | Yes | Convex WebSocket/HTTP URL (browser-visible) |
| `CHATLLM_API_KEY` | Yes | ChatLLM API key (injected into the VM as env var) |
| `CHATLLM_BASE_URL` | Yes | OpenAI-compatible base URL for the LLM endpoint |
| `CHATLLM_MODEL` | Yes | Model ID to use (e.g. `route-llm`) |

---

## Project Structure

```
convex-sandbox-chatbot/
├── app/
│   ├── api/chat/route.ts        # SSE orchestrator: provisions VM, runs agent, lifecycle events
│   ├── ConvexClientProvider.tsx # Client-side ConvexProvider wrapper
│   ├── ErrorBoundary.tsx        # React error boundary
│   ├── layout.tsx               # Root layout
│   └── page.tsx                 # Chat UI: sidebar, messages, tool logs
├── convex/
│   ├── schema.ts                # DB schema: threads, messages, toolLogs, sessions
│   ├── threads.ts               # createThread, listThreads, updateThreadSandbox
│   ├── messages.ts              # sendMessage, appendAssistantMessage, appendMessageContent, updateMessage
│   └── toolLogs.ts              # logTool, updateToolLog, getToolLogs
├── lib/
│   ├── agent.ts                 # buildAgentScript() + runAgentInSandbox()
│   └── sandbox.ts               # SandboxManager: create/get/run/read/write/installDeps/delete
└── next.config.ts               # serverExternalPackages for Daytona + Pi Agent
```
