import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  threads: defineTable({
    title: v.string(),
    sandboxId: v.optional(v.string()),
    status: v.union(
      v.literal("creating"),
      v.literal("active"),
      v.literal("closed")
    ),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),

  messages: defineTable({
    threadId: v.id("threads"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system")
    ),
    content: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("streaming"),
      v.literal("done"),
      v.literal("error")
    ),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

  toolLogs: defineTable({
    threadId: v.id("threads"),
    messageId: v.id("messages"),
    toolName: v.string(), // bash | read | write | edit | grep | glob | webfetch | websearch
    input: v.string(),    // JSON-stringified tool input
    output: v.string(),   // JSON-stringified tool output (empty string until complete)
    executionOrder: v.number(),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId"])
    .index("by_message", ["messageId"]),

  sessions: defineTable({
    threadId: v.id("threads"),
    sandboxId: v.string(),
    status: v.union(v.literal("active"), v.literal("stopped")),
  }).index("by_thread", ["threadId"]),
});
