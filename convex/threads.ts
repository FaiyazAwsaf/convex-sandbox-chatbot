import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Creates a new thread with status "creating". sandboxId is filled later
// once the Daytona VM is provisioned via updateThreadSandbox.
export const createThread = mutation({
  args: { title: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("threads", {
      title: args.title,
      sandboxId: undefined,
      status: "creating",
      createdAt: Date.now(),
    });
  },
});

// Returns all threads newest-first for the sidebar list.
export const listThreads = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("threads")
      .withIndex("by_createdAt")
      .order("desc")
      .collect();
  },
});

// Called by the sandbox manager once the Daytona VM is up and the Pi Agent
// is bootstrapped. Sets sandboxId and flips status to "active".
export const updateThreadSandbox = mutation({
  args: {
    threadId: v.id("threads"),
    sandboxId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.threadId, {
      sandboxId: args.sandboxId,
      status: "active",
    });
  },
});
