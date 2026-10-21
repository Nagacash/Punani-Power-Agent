import assert from "node:assert/strict"
import http from "node:http"
import { after, before, test } from "node:test"
import { AnthropicClient, toAnthropicMessages } from "../src/llm/anthropic.ts"
import { createClient } from "../src/llm/factory.ts"
import type { ProviderConfig } from "../src/provider/types.ts"

/**
 * The Anthropic client.
 *
 * Anthropic does not speak the OpenAI shape, so this is the wall between the
 * two. What matters is that the system prompt becomes its own field, a tool
 * result becomes a user message, the roles alternate, and the thinking comes
 * back as it was sent.
 */

let server: http.Server
let baseURL: string
const bodies: any[] = []
let nextResponse = ""

before(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(nextResponse)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  baseURL = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test("the system prompt is its own field, and the roles alternate", () => {
  const { system, messages } = toAnthropicMessages([
    { role: "system", content: "You are a coding agent." },
    { role: "user", content: "read the file" },
    { role: "assistant", content: "on it" },
    { role: "tool", name: "read", toolCallId: "toolu_1", content: "the file" },
    { role: "assistant", content: "done" },
  ])

  assert.equal(system.length, 1)
  assert.equal(system[0]!.text, "You are a coding agent.")
  assert.deepEqual(system[0]!.cache_control, { type: "ephemeral" })

  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  )
  assert.equal(messages[2]!.content[0]!.type, "tool_result")
  assert.equal(messages[2]!.content[0]!.tool_use_id, "toolu_1")
})

test("a tool call becomes a tool_use block", () => {
  const { messages } = toAnthropicMessages([
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "toolu_9", name: "read", arguments: '{"path":"a.ts"}' }],
    },
  ])
  const block = messages[1]!.content[0]!
  assert.equal(block.type, "tool_use")
  assert.equal(block.id, "toolu_9")
  assert.equal(block.name, "read")
  assert.deepEqual(block.input, { path: "a.ts" })
})

test("a picture becomes a base64 source", () => {
  const { messages } = toAnthropicMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ])
  const blocks = messages[0]!.content
  assert.equal(blocks[0]!.type, "text")
  assert.equal(blocks[1]!.type, "image")
  assert.equal(blocks[1]!.source!.media_type, "image/png")
  assert.equal(blocks[1]!.source!.data, "AAAA")
})

test("the thinking and the answer arrive as they were written", async () => {
  bodies.length = 0
  nextResponse = [
    'data: {"type":"message_start","message":{"model":"claude-test","usage":{"input_tokens":11,"output_tokens":0}}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me think"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer"}}',
    'data: {"type":"message_delta","usage":{"output_tokens":9}}',
    "",
  ].join("\n")

  const client = new AnthropicClient({ baseURL, apiKey: "k", providerID: "anthropic" })
  const thinking: string[] = []
  const text: string[] = []
  const result = await client.complete({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    onReasoning: (delta) => thinking.push(delta),
    onToken: (delta) => text.push(delta),
  })

  assert.equal(thinking.join(""), "let me think")
  assert.equal(text.join(""), "The answer")
  assert.equal(result.content, "The answer")
  assert.equal(result.reasoning, "let me think")
  assert.equal(result.usage.inputTokens, 11)
  assert.equal(result.usage.outputTokens, 9)
})

test("a tool call arrives over the stream", async () => {
  bodies.length = 0
  nextResponse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_3","name":"read"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
    "",
  ].join("\n")

  const client = new AnthropicClient({ baseURL, apiKey: "k", providerID: "anthropic" })
  const result = await client.complete({
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    onToken: () => {},
  })
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0]!.name, "read")
  assert.deepEqual(JSON.parse(result.toolCalls[0]!.arguments), { path: "a.ts" })
})

test("the request carries the tools, the cache mark and the thinking budget", async () => {
  bodies.length = 0
  nextResponse = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}'
  const client = new AnthropicClient({ baseURL, apiKey: "k", providerID: "anthropic" })
  await client.complete({
    model: "claude-test",
    messages: [{ role: "system", content: "rules" }, { role: "user", content: "hi" }],
    tools: [
      { name: "read", description: "read a file", parameters: { type: "object" } },
      { name: "bash", description: "run a command", parameters: { type: "object" } },
    ],
    reasoningEffort: "medium",
    onToken: () => {},
  })

  const body = bodies[0]!
  assert.equal(body.max_tokens, 8_192 + 4_096)
  assert.deepEqual(body.thinking, { type: "enabled", budget_tokens: 4_096 })
  assert.equal(body.tools.length, 2)
  assert.equal(body.tools[0].input_schema.type, "object")
  // The last tool is the one that gets cached.
  assert.equal(body.tools[1].cache_control.type, "ephemeral")
  assert.equal(body.tools[0].cache_control, undefined)
})

test("an Anthropic provider gets the Anthropic client", () => {
  const provider: ProviderConfig = {
    id: "anthropic",
    kind: "anthropic",
    name: "Anthropic",
    baseURL: "https://api.anthropic.com/v1",
    env: "ANTHROPIC_API_KEY",
    defaultContextWindow: 200_000,
  }
  const client = createClient(provider, "k")
  assert.equal(client.constructor.name, "AnthropicClient")
})
