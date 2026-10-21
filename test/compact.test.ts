import assert from "node:assert/strict"
import { test } from "node:test"
import { compactConversation, conversationTokens, shouldCompact } from "../src/agent/compact.ts"
import type { ChatClient, ChatMessage } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"

const model: ModelInfo = {
  id: "mock",
  providerID: "mock",
  name: "Mock",
  contextWindow: 32_000,
  toolSupport: true,
  reasoning: false,
  vision: false,
  cost: { input: 0, output: 0, currency: "USD" },
  status: "active",
  origin: "catalog",
}

function many(count: number, size = 400): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index} ${"x".repeat(size)}`,
  }))
}

test("a short conversation is left alone", () => {
  assert.equal(shouldCompact(many(10), model), false)
})

test("a long conversation is worth folding", () => {
  // 400 messages of 400 characters is well past half of 32k tokens.
  assert.equal(shouldCompact(many(400), model), true)
})

test("the tokens of a conversation are counted", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "x".repeat(400) }]
  assert.equal(conversationTokens(messages), 100)
})

test("the older part is folded and the recent part is kept whole", async () => {
  const messages = many(20)
  const client: ChatClient = {
    providerID: "mock",
    complete: async () => ({
      content: "Handover: the user asked for a refactor and it was done.",
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 0 },
      modelID: "mock",
    }),
  }

  const result = await compactConversation(client, model, messages, { keepRecent: 6 })
  assert.equal(result.folded, 14)
  assert.equal(result.messages.length, 7)
  assert.match(result.messages[0]!.content as string, /Handover/)
  // The recent messages are the ones that were kept, in order.
  assert.equal(result.messages[1]!.content, messages[14]!.content)
  assert.equal(result.messages[6]!.content, messages[19]!.content)
})

test("a summary that fails leaves the conversation alone", async () => {
  const messages = many(20)
  const client: ChatClient = {
    providerID: "mock",
    complete: async () => {
      throw new Error("the provider is down")
    },
  }
  const result = await compactConversation(client, model, messages, { keepRecent: 6 })
  assert.equal(result.folded, 0)
  assert.equal(result.messages.length, messages.length)
})

test("a short conversation is never folded", async () => {
  const messages = many(4)
  const client: ChatClient = {
    providerID: "mock",
    complete: async () => {
      throw new Error("should not be called")
    },
  }
  const result = await compactConversation(client, model, messages, { keepRecent: 8 })
  assert.equal(result.folded, 0)
})
