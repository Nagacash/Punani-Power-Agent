import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runAgentTurn } from "../src/agent/agent.ts"
import { SessionStore } from "../src/session/store.ts"
import { estimateCost } from "../src/provider/types.ts"
import type { ChatClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { Tool, ToolContext } from "../src/tool/types.ts"

/**
 * What each step cost.
 *
 * A turn is several model calls. The transcript used to put the turn total on
 * every message, so a long turn looked like every line had cost the whole
 * conversation. Each message now carries the call that produced it.
 */

const model: ModelInfo = {
  id: "mock",
  providerID: "mock",
  name: "Mock",
  contextWindow: 32_000,
  toolSupport: true,
  reasoning: false,
  vision: false,
  cost: { input: 3, output: 15, currency: "USD" },
  status: "active",
  origin: "catalog",
}

const noopContext: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

const tool: Tool = {
  name: "read",
  description: "read a file",
  parameters: { type: "object", properties: {} },
  permissionAction: "read",
  run: async () => ({ output: "the file" }),
}

/** One call that asks for a tool, one that answers. */
function steppingClient(): ChatClient {
  let call = 0
  return {
    providerID: "mock",
    complete: async () => {
      call++
      if (call === 1) {
        return {
          content: "",
          toolCalls: [{ id: "call_1", name: "read", arguments: "{}" }],
          usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 0 },
          modelID: "mock",
        }
      }
      return {
        content: "the answer",
        toolCalls: [],
        usage: { inputTokens: 200, outputTokens: 20, reasoningTokens: 0 },
        modelID: "mock",
      }
    },
  } as unknown as ChatClient
}

test("the agent reports each model call on its own", async () => {
  const result = await runAgentTurn(
    {
      client: steppingClient(),
      model,
      tools: [tool],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(result.steps.length, 2)
  assert.equal(result.steps[0]!.inputTokens, 100)
  assert.equal(result.steps[0]!.outputTokens, 10)
  assert.equal(result.steps[0]!.model, "mock")
  assert.equal(result.steps[0]!.provider, "mock")
  assert.equal(result.steps[1]!.inputTokens, 200)
  assert.equal(result.steps[1]!.outputTokens, 20)

  // The turn total is still the sum of the steps.
  assert.equal(result.usage.inputTokens, 300)
  assert.equal(result.usage.outputTokens, 30)
  assert.equal(
    result.usage.cost,
    estimateCost(model.cost, 100, 10) + estimateCost(model.cost, 200, 20),
  )
})

test("the transcript says what each step cost, not the turn total", async () => {
  const result = await runAgentTurn(
    {
      client: steppingClient(),
      model,
      tools: [tool],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    [{ role: "user", content: "hi" }],
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-usage-"))
  const sessions = new SessionStore(dir)
  const meta = sessions.create("/tmp/project", "mock", "mock")
  sessions.appendTurnMessages(meta, result.added, result.steps)
  sessions.appendTurn(meta, { stoppedReason: result.stoppedReason, usage: result.usage })

  const stored = sessions.read(meta.id)!
  const answers = stored.messages.filter((message) => message.role === "assistant")
  assert.equal(answers.length, 2)
  assert.equal(answers[0]!.tokensIn, 100, "the tool call is worth the first call")
  assert.equal(answers[1]!.tokensIn, 200, "the answer is worth the second call")
  assert.notEqual(answers[0]!.tokensIn, answers[1]!.tokensIn)
  assert.equal(answers[0]!.cost, estimateCost(model.cost, 100, 10))

  const turn = stored.messages.find((message) => message.stoppedReason)!
  assert.equal(turn.tokensIn, 300, "the turn record carries the total")
  assert.equal(turn.tokensOut, 30)
})
