import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Inserts a user message. Returns the new messageId.
export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      threadId: args.threadId,
      role: "user",
      content: args.content,
      status: "done",
      createdAt: Date.now(),
    });
  },
});

// Creates an empty assistant message with status "streaming".
// The Pi Agent writes chunks into it via updateMessage as it runs.
export const appendAssistantMessage = mutation({
  args: {
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("messages", {
      threadId: args.threadId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
    });
  },
});

// Updates a message's content and/or status. Used by the Pi Agent inside the
// Daytona VM to stream output back to Convex over HTTP.
export const updateMessage = mutation({
  args: {
    messageId: v.id("messages"),
    content: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("streaming"),
        v.literal("done"),
        v.literal("error")
      )
    ),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.content !== undefined) patch.content = args.content;
    if (args.status !== undefined) patch.status = args.status;
    await ctx.db.patch(args.messageId, patch);
  },
});

// Atomically appends a token chunk to an existing message's content.
// Used by the API route during streaming to avoid full-content overwrites.
export const appendMessageContent = mutation({
  args: {
    messageId: v.id("messages"),
    chunk: v.string(),
  },
  handler: async (ctx, args) => {
    const msg = await ctx.db.get(args.messageId);
    if (!msg) throw new Error("Message not found");
    await ctx.db.patch(args.messageId, { content: msg.content + args.chunk });
  },
});

// Returns all messages for a thread in chronological order.
export const getMessages = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .order("asc")
      .collect();
  },
});
