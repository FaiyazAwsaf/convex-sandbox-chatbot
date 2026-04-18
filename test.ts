/**
 * Sandbox smoke-test — run with:
 *   npx tsx test.ts
 *
 * Requires DAYTONA_API_KEY in the environment (or .env.local).
 * Tests three things:
 *   1. A sandbox can be created
 *   2. A shell command can be executed inside it
 *   3. The sandbox can be deleted
 */

import { config } from "dotenv";
import { sandboxManager } from "./lib/sandbox.js";

// Load .env.local so DAYTONA_API_KEY is available when running directly.
config({ path: ".env.local" });

const THREAD_ID = `test-thread-${Date.now()}`;

async function run() {
  let sandboxId: string | undefined;

  // ── 1. Create ────────────────────────────────────────────────────────────
  console.log("[ 1/3 ] Creating sandbox for thread:", THREAD_ID);
  try {
    sandboxId = await sandboxManager.createSandbox(THREAD_ID);
    console.log("       ✓ sandboxId:", sandboxId);
  } catch (err) {
    console.error("       ✗ createSandbox failed:", err);
    process.exit(1);
  }

  // ── 2. Run command ───────────────────────────────────────────────────────
  console.log("[ 2/3 ] Running `echo hello` inside sandbox");
  try {
    const output = await sandboxManager.runCommand(sandboxId, "echo hello");
    const trimmed = output.trim();
    if (trimmed !== "hello") {
      throw new Error(`Unexpected output: ${JSON.stringify(trimmed)}`);
    }
    console.log("       ✓ output:", trimmed);
  } catch (err) {
    console.error("       ✗ runCommand failed:", err);
    // Still try to delete before exiting.
    await sandboxManager.deleteSandbox(sandboxId).catch(() => {});
    process.exit(1);
  }

  // ── 3. Delete ────────────────────────────────────────────────────────────
  console.log("[ 3/3 ] Deleting sandbox");
  try {
    await sandboxManager.deleteSandbox(sandboxId);
    console.log("       ✓ deleted");
  } catch (err) {
    console.error("       ✗ deleteSandbox failed:", err);
    process.exit(1);
  }

  console.log("\nAll smoke-tests passed.");
}

run();
