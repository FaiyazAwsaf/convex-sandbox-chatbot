// TODO: Pi Agent setup and invocation
// Responsibilities:
// - buildAgentScript() → string of TS code to run INSIDE the Daytona VM
//   - Creates a Pi Agent with tools: bash, read, write, edit, grep, glob, webfetch, websearch
//   - Connects to Convex to write messages and tool logs back via HTTP
//   - Reads the user message, runs the agent loop, streams output back
// - runAgentInSandbox(sandboxId, threadId, messageId, userMessage)
//   - Uploads the agent script into the VM
//   - Executes it via sandbox.exec("tsx agent-runner.ts")
//
// IMPORTANT: Pi Agent logic runs INSIDE the Daytona VM.
// This file only constructs and dispatches the script; it does NOT run the agent locally.
//
// See Pi Agent tutorial: https://nader.substack.com/p/how-to-build-a-custom-agent-framework
// Packages: @mariozechner/pi-ai, @mariozechner/pi-agent-core, @mariozechner/pi-coding-agent

export function buildAgentScript(_params: {
  threadId: string;
  messageId: string;
  userMessage: string;
  convexUrl: string;
}): string {
  // TODO: Return a self-contained TypeScript script that:
  // 1. Imports Pi Agent packages
  // 2. Creates tools: bash, read, write, edit, grep, glob, webfetch, websearch
  // 3. Instantiates the Pi Agent with ANTHROPIC_API_KEY
  // 4. Runs agent.run(userMessage)
  // 5. Streams chunks back to Convex via fetch (appendMessageContent mutation)
  // 6. Logs tool calls to Convex (logToolCall / setToolOutput mutations)
  throw new Error("Not implemented");
}

export async function runAgentInSandbox(_params: {
  sandboxId: string;
  threadId: string;
  messageId: string;
  userMessage: string;
}): Promise<void> {
  // TODO:
  // 1. Get sandbox handle via getSandbox(sandboxId)
  // 2. Build agent script via buildAgentScript(...)
  // 3. Write script to VM filesystem via sandbox.fs.write
  // 4. Execute: sandbox.exec("tsx /tmp/agent-runner.ts")
  // 5. Stream stdout back and update Convex message status
  throw new Error("Not implemented");
}
