import { Daytona, CodeLanguage } from "@daytona/sdk";
import type { Sandbox } from "@daytona/sdk";

/**
 * Manages the lifecycle of Daytona VM sandboxes.
 * Runs in the Next.js server (API routes / server actions).
 * The Pi Agent itself runs INSIDE the VM — not here.
 */
class SandboxManager {
  private daytona: Daytona;

  constructor() {
    // Reads DAYTONA_API_KEY from env by default.
    // Throws DaytonaError at construction time if the key is missing.
    this.daytona = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      apiUrl: process.env.DAYTONA_API_URL,
    });
  }

  /**
   * Provisions a new TypeScript sandbox for a conversation thread.
   * Auto-stops after 10 minutes of inactivity to control costs.
   * Returns the sandbox ID to persist in Convex (threads.sandboxId).
   */
  async createSandbox(threadId: string): Promise<string> {
    try {
      const sandbox = await this.daytona.create(
        {
          language: CodeLanguage.TYPESCRIPT,
          autoStopInterval: 10, // minutes
          labels: { threadId },
        },
        { timeout: 120 } // 2-minute timeout for VM boot
      );
      // Wait for the container to fully boot and get a reachable IP.
      await this.daytona.start(sandbox, 60);
      return sandbox.id;
    } catch (error) {
      throw new Error(
        `Failed to create sandbox for thread ${threadId}: ${String(error)}`
      );
    }
  }

  /**
   * Retrieves an existing sandbox by its ID.
   * Throws if the sandbox does not exist or is not reachable.
   */
  async getSandbox(sandboxId: string): Promise<Sandbox> {
    try {
      return await this.daytona.get(sandboxId);
    } catch (error) {
      throw new Error(
        `Failed to get sandbox ${sandboxId}: ${String(error)}`
      );
    }
  }

  /**
   * Runs a shell command inside the sandbox and returns stdout.
   * Throws if the command exits with a non-zero code.
   */
  async runCommand(sandboxId: string, command: string): Promise<string> {
    try {
      const sandbox = await this.getSandbox(sandboxId);
      const response = await sandbox.process.executeCommand(command);

      if (response.exitCode !== 0) {
        throw new Error(
          `Command exited with code ${response.exitCode}: ${response.result}`
        );
      }

      return response.result;
    } catch (error) {
      throw new Error(
        `Failed to run command in sandbox ${sandboxId}: ${String(error)}`
      );
    }
  }

  /**
   * Reads a file from the sandbox filesystem and returns its content as a string.
   */
  async readFile(sandboxId: string, path: string): Promise<string> {
    try {
      const sandbox = await this.getSandbox(sandboxId);
      const buffer = await sandbox.fs.downloadFile(path);
      return buffer.toString("utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read file ${path} from sandbox ${sandboxId}: ${String(error)}`
      );
    }
  }

  /**
   * Writes a string to a file in the sandbox filesystem.
   * Creates the file if it does not exist; overwrites if it does.
   */
  async writeFile(
    sandboxId: string,
    path: string,
    content: string
  ): Promise<void> {
    try {
      const sandbox = await this.getSandbox(sandboxId);
      await sandbox.fs.uploadFile(Buffer.from(content, "utf-8"), path);
    } catch (error) {
      throw new Error(
        `Failed to write file ${path} in sandbox ${sandboxId}: ${String(error)}`
      );
    }
  }

  /**
   * Permanently deletes a sandbox and releases all associated resources.
   * Should be called when a thread is closed.
   */
  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId);

    // A running sandbox must be stopped before it can be deleted.
    try {
      await this.daytona.stop(sandbox);
    } catch (error) {
      throw new Error(
        `Failed to stop sandbox ${sandboxId} before deletion: ${String(error)}`
      );
    }

    try {
      await this.daytona.delete(sandbox);
    } catch (error) {
      throw new Error(
        `Failed to delete sandbox ${sandboxId}: ${String(error)}`
      );
    }
  }
}

export const sandboxManager = new SandboxManager();
