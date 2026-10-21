import assert from "node:assert/strict"
import { test } from "node:test"
import { buildSystemPrompt, runAgentTurn } from "../src/agent/agent.ts"
import { detectVision } from "../src/provider/catalog.ts"
import { defaultRoots } from "../src/skills/loader.ts"
import { declinedOutput } from "../src/tool/types.ts"
import type { LlmClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { AgentEvent } from "../src/agent/agent.ts"
import type { Tool, ToolContext } from "../src/tool/types.ts"

const model: ModelInfo = {
  id: "mock",
  providerID: "mock",
  name: "Mock",
  contextWindow: 32_000,
  toolSupport: true,
  reasoning: true,
  vision: true,
  cost: { input: 0, output: 0, currency: "USD" },
  status: "active",
  origin: "catalog",
}

function fakeClient(reply: string, reasoning = "thinking about it", toolName?: string): LlmClient {
  let asked = false
  return {
    providerID: "mock",
    complete: async (request: any) => {
      if (toolName && !asked) {
        asked = true
        return {
          content: "",
          toolCalls: [{ id: "call_1", name: toolName, arguments: "{}" }],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          modelID: "mock",
        }
      }
      request.onReasoning?.(reasoning)
      request.onToken?.(reply)
      return {
        content: reply,
        reasoning,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        modelID: "mock",
      }
    },
  } as unknown as LlmClient
}

const noopContext: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

test("a model that takes images is detected, whichever way the provider says so", () => {
  // OpenRouter nests the modalities under `architecture`.
  assert.equal(
    detectVision({ architecture: { input_modalities: ["text", "image", "video"] } }),
    true,
  )
  assert.equal(detectVision({ architecture: { modality: "text+image->text" } }), true)
  // Other providers put them at the top level.
  assert.equal(detectVision({ input_modalities: ["text", "image"] }), true)
  assert.equal(detectVision({ vision: true }), true)
  assert.equal(detectVision({ architecture: { input_modalities: ["text"] } }), false)
  assert.equal(detectVision({}), false)
})

test("the thinking is streamed once, not streamed and then repeated", async () => {
  const events: AgentEvent[] = []
  await runAgentTurn(
    {
      client: fakeClient("The answer is 42."),
      model,
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      onEvent: (event) => events.push(event),
    },
    [{ role: "user", content: "what is the answer?" }],
  )

  const reasoning = events.filter((event) => event.type === "reasoning")
  assert.equal(reasoning.length, 1, "the thinking should arrive once")
  assert.equal(reasoning[0]!.partial, true)
  assert.equal(reasoning[0]!.text, "thinking about it")

  const text = events.filter((event) => event.type === "assistant_text")
  assert.equal(text.length, 1)
  assert.equal(text[0]!.text, "The answer is 42.")
})

test("a picture the model can see is attached to the tool result", async () => {
  const imageTool: Tool = {
    name: "read",
    description: "read a picture",
    parameters: { type: "object", properties: {} },
    permissionAction: "read",
    run: async () => ({ output: "photo.png (image, 10 bytes)", image: { mime: "image/png", data: "AAAA" } }),
  }
  const result = await runAgentTurn(
    {
      client: fakeClient("I can see it.", "thinking", "read"),
      model,
      tools: [imageTool],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    [{ role: "user", content: "what is in the picture?" }],
  )
  const toolMessage = result.messages.find((message) => message.role === "tool")
  assert.ok(Array.isArray(toolMessage!.content), "the picture should ride along with the tool result")
  const parts = toolMessage!.content as any[]
  assert.equal(parts[1]!.type, "image_url")
  assert.match(parts[1]!.image_url.url, /^data:image\/png;base64,/)
})

test("a picture the model cannot see says so, and says not to work around it", async () => {
  const imageTool: Tool = {
    name: "read",
    description: "read a picture",
    parameters: { type: "object", properties: {} },
    permissionAction: "read",
    run: async () => ({ output: "photo.png (image, 10 bytes)", image: { mime: "image/png", data: "AAAA" } }),
  }
  const result = await runAgentTurn(
    {
      client: fakeClient("I cannot see it.", "thinking", "read"),
      model: { ...model, vision: false },
      tools: [imageTool],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    [{ role: "user", content: "what is in the picture?" }],
  )
  const toolMessage = result.messages.find((message) => message.role === "tool")
  assert.equal(typeof toolMessage!.content, "string")
  assert.match(toolMessage!.content as string, /cannot see images/)
  assert.match(toolMessage!.content as string, /do not build a workaround/)
})

test("the prompt says to answer first, to respect a decline, and to sound human", () => {
  const prompt = buildSystemPrompt("/tmp/project", { vision: true })
  assert.match(prompt, /Answer first/)
  assert.match(prompt, /A declined call is a decision/)
  assert.match(prompt, /do not build a workaround/)
  assert.match(prompt, /No 'Great question'/)
  assert.match(prompt, /No em dash/)
  assert.match(prompt, /You can see images/)
})

test("a decline tells the model the answer is final", () => {
  const message = declinedOutput("to run the command", "not now")
  assert.match(message, /declined to run the command/)
  assert.match(message, /do not try again/)
  assert.match(message, /do not build a workaround/)
  assert.match(message, /not now/)
})

test("the opencode skill folder is one of the roots", () => {
  const roots = defaultRoots("/tmp/project").map((root) => root.path)
  assert.ok(
    roots.some((path) => path.endsWith("opencode/skills")),
    "the opencode skills should be discovered",
  )
})

test("a turn reports only the messages it added, not the history", async () => {
  const history = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "hello" },
  ]
  const result = await runAgentTurn(
    {
      client: fakeClient("the answer"),
      model,
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    history,
  )

  assert.equal(result.added.length, 1)
  assert.equal(result.added[0]!.content, "the answer")
  assert.equal(result.messages.length, 3)
})
