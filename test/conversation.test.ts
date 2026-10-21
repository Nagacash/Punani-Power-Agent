import assert from "node:assert/strict"
import { test } from "node:test"
import { runAgentTurn } from "../src/agent/agent.ts"
import type { ChatClient, ChatMessage } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * The conversation has to survive the turn.
 *
 * The caller keeps the messages the turn returns and sends them back with
 * the next one. If that chain breaks, every turn starts from nothing and the
 * agent keeps asking the same questions.
 */

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

const noopContext: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

/** A client that remembers every conversation it was given. */
function recordingClient(): { client: ChatClient; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = []
  const client = {
    providerID: "mock",
    complete: async (request: { messages: ChatMessage[] }) => {
      seen.push(request.messages.map((message) => ({ ...message })))
      return {
        content: `answer ${seen.length}`,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        modelID: "mock",
      }
    },
  } as unknown as ChatClient
  return { client, seen }
}

test("the second turn still has the first one in it", async () => {
  const { client, seen } = recordingClient()
  const system: ChatMessage = { role: "system", content: "the rules" }

  const first = await runAgentTurn(
    { client, model, tools: [], projectRoot: "/tmp/project", context: noopContext },
    [system, { role: "user", content: "the first question" }],
  )

  // What the caller does: keep the messages, drop the system prompt, and
  // add the next question.
  const history: ChatMessage[] = first.messages.filter((message) => message.role !== "system")
  history.push({ role: "user", content: "the second question" })

  await runAgentTurn(
    { client, model, tools: [], projectRoot: "/tmp/project", context: noopContext },
    [system, ...history],
  )

  assert.equal(seen.length, 2)
  const second = seen[1]!
  assert.equal(second[0]!.role, "system", "the rules are still there")
  assert.equal(second[1]!.content, "the first question")
  assert.equal(second[2]!.content, "answer 1")
  assert.equal(second[3]!.content, "the second question")
})
