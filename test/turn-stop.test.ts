import assert from "node:assert/strict"
import { test } from "node:test"
import { runAgentTurn } from "../src/agent/agent.ts"
import { interpretPermissionReply } from "../src/ui/prompt.ts"
import type { ChatClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { Tool, ToolContext } from "../src/tool/types.ts"

/**
 * A turn that cannot continue ends.
 *
 * Nobody answering at the prompt is not a refusal, and a refusal the model
 * argues with is a loop. Both have to end the turn.
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

const request = {
  action: "bash",
  resource: "npm run dev",
  summary: "Run: npm run dev",
  alwaysPatterns: ["npm run dev"],
}

/** A tool that asks, and is answered the way the test says. */
function askingTool(outcome: { granted: boolean; unanswered?: boolean }): Tool {
  return {
    name: "bash",
    description: "run a command",
    parameters: { type: "object", properties: {} },
    permissionAction: "bash",
    run: async (_args: any, context: ToolContext) => {
      const answer = await context.requestPermission(request)
      if (!answer.granted) {
        return {
          output: answer.unanswered
            ? "The user did not answer the request to run the command, so the turn stops here."
            : "The user declined to run the command. That is the final answer: do not try again.",
          isError: true,
          stop: answer.unanswered === true,
        }
      }
      return { output: "the server is up" }
    },
  }
}

/** A context that answers the permission request the way the test says. */
function answering(outcome: { granted: boolean; unanswered?: boolean }): ToolContext {
  return {
    projectRoot: "/tmp/project",
    requestPermission: async () => outcome,
    notify: () => {},
    previewDiff: () => {},
    mutate: async () => ({ applied: true }),
  }
}

/** A model that asks for the same command every time. */
function loopingClient(): ChatClient {
  return {
    providerID: "mock",
    complete: async () => ({
      content: "",
      toolCalls: [{ id: "call_1", name: "bash", arguments: JSON.stringify({ command: "npm run dev" }) }],
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      modelID: "mock",
    }),
  } as unknown as ChatClient
}

const context: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

test("an empty answer is nobody answering, not a yes", () => {
  const outcome = interpretPermissionReply("", request)
  assert.equal(outcome.granted, false)
  assert.equal(outcome.unanswered, true)
})

test("an unanswered prompt ends the turn", async () => {
  const tool = askingTool({ granted: false, unanswered: true })
  const result = await runAgentTurn(
    {
      client: loopingClient(),
      model,
      tools: [tool],
      projectRoot: "/tmp/project",
      context: answering({ granted: false, unanswered: true }),
    },
    [{ role: "user", content: "start the server" }],
  )
  assert.equal(result.stoppedReason, "aborted")
})

test("the same request after a refusal ends the turn instead of looping", async () => {
  const tool = askingTool({ granted: false })
  const result = await runAgentTurn(
    {
      client: loopingClient(),
      model,
      tools: [tool],
      projectRoot: "/tmp/project",
      context: answering({ granted: false }),
    },
    [{ role: "user", content: "start the server" }],
  )
  assert.equal(result.stoppedReason, "declined")
  // The tool ran once, not once per step.
  const toolMessages = result.messages.filter((message) => message.role === "tool")
  assert.equal(toolMessages.length, 1)
})
