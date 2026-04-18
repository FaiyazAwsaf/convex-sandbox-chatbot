import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Records a tool invocation. Called by the Pi Agent inside the Daytona VM
// before executing the tool. Output is stored as empty string until the
// tool completes and the agent calls logTool again with the result.
export const logTool = mutation({
  args: {
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    toolName: v.string(),
    input: v.string(),       // JSON-stringified tool arguments
    output: v.string(),      // JSON-stringified result; "" until complete
    executionOrder: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("toolLogs", {
      threadId: args.threadId,
      messageId: args.messageId,
      toolName: args.toolName,
      input: args.input,
      output: args.output,
      executionOrder: args.executionOrder,
      createdAt: Date.now(),
    });
  },
});

// Updates the output of an existing tool log row.
// Called on onToolCall "end" to fill in the result after execution completes.
export const updateToolLog = mutation({
  args: {
    toolLogId: v.id("toolLogs"),
    output: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.toolLogId, { output: args.output });
  },
});

// Returns all tool logs for a thread ordered by execution sequence.
// Used by the UI to render the tool call trace under each assistant message.
export const getToolLogs = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("toolLogs")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();
  },
});
