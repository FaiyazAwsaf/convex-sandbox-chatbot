// TODO: Daytona sandbox manager
// Responsibilities:
// - createSandbox(threadId) → sandboxId
//   - Uses @daytona/sdk to spin up a new VM
//   - Installs Pi Agent packages inside the VM
//   - Returns the sandboxId to store in Convex
// - getSandbox(sandboxId) → Sandbox instance
// - destroySandbox(sandboxId)
//
// IMPORTANT: This module runs in the Next.js server (API route / server action).
// It provisions the VM and bootstraps the Pi Agent inside it.
// The Pi Agent itself MUST run inside the Daytona VM, not here.
//
// See Daytona TS SDK: https://www.daytona.io/docs/en/typescript-sdk/

// TODO: import Daytona from "@daytona/sdk"

export async function createSandbox(_threadId: string): Promise<string> {
  // TODO:
  // 1. new Daytona({ apiKey: process.env.DAYTONA_API_KEY })
  // 2. daytona.sandbox.create({ ... })
  // 3. Install Pi Agent deps inside VM via sandbox.exec
  // 4. Return sandboxId
  throw new Error("Not implemented");
}

export async function getSandbox(_sandboxId: string) {
  // TODO: return live sandbox handle from Daytona SDK
  throw new Error("Not implemented");
}

export async function destroySandbox(_sandboxId: string): Promise<void> {
  // TODO: daytona.sandbox.delete(sandboxId)
  throw new Error("Not implemented");
}
