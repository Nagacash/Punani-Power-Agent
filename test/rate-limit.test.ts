import assert from "node:assert/strict"
import { test } from "node:test"
import { runAgentTurn, type AgentEvent } from "../src/agent/agent.ts"
import { LlmError } from "../src/llm/errors.ts"
import type { ChatClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { ToolContext } from "../src/tool/types.ts"

function makeModel(id: string, providerID: string): ModelInfo {
  return {
    id, providerID, name: id, contextWindow: 32_000, toolSupport: true,
    reasoning: false, vision: false, cost: { input: 0, output: 0, currency: "USD" },
    status: "active", origin: "catalog",
  }
}

const noopContext: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

function rateLimitedClient(modelID: string): ChatClient {
  return {
    providerID: "openrouter",
    complete: async () => {
      throw new LlmError({
        kind: "rate_limit",
        message: "Rate limit exceeded",
        providerID: "openrouter",
        modelID,
      })
    },
  } as unknown as ChatClient
}

function workingClient(reply: string): ChatClient {
  return {
    providerID: "groq",
    complete: async () => ({
      content: reply,
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, modelID: "groq-model" },
    }),
  } as unknown as ChatClient
}

test("three rate limits exhaust MAX_SWITCHES and end the turn as an error", async () => {
  let switches = 0
  const result = await runAgentTurn(
    {
      client: rateLimitedClient("model-a"),
      model: makeModel("model-a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async (_error, failed) => {
        switches++
        if (failed.id === "model-a") return { client: rateLimitedClient("model-b"), model: makeModel("model-b", "openrouter") }
        if (failed.id === "model-b") return { client: rateLimitedClient("model-c"), model: makeModel("model-c", "openrouter") }
        return undefined
      },
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(switches, 3)
  assert.equal(result.stoppedReason, "error")
  assert.equal(result.error?.kind, "rate_limit")
})

test("a rate limit moves to a working model and the turn finishes", async () => {
  let calls = 0
  const result = await runAgentTurn(
    {
      client: rateLimitedClient("model-a"),
      model: makeModel("model-a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async () => {
        calls++
        return { client: workingClient("the answer"), model: makeModel("model-b", "groq") }
      },
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(calls, 1)
  assert.equal(result.stoppedReason, "finished")
  assert.equal(result.messages.at(-1)!.content, "the answer")
})
