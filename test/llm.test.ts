import assert from "node:assert/strict"
import http from "node:http"
import { after, before, test } from "node:test"
import { LlmClient } from "../src/llm/client.ts"

/**
 * The wire format.
 *
 * The client talks to OpenAI-compatible servers, and the body it sends is what
 * a provider sees. The reasoning effort is the one setting that changes shape
 * between providers, so it gets its own server to look at.
 */

let server: http.Server
let baseURL: string
const bodies: any[] = []

before(async () => {
  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          model: "mock",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
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

test("a router takes the effort in its own object", async () => {
  bodies.length = 0
  const client = new LlmClient({ baseURL, providerID: "openrouter", apiKey: "x" })
  await client.complete({
    model: "mock",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "high",
  })
  assert.deepEqual(bodies[0]!.reasoning, { effort: "high" })
  assert.equal(bodies[0]!.reasoning_effort, undefined)
})

test("everything else takes a flat field", async () => {
  bodies.length = 0
  const client = new LlmClient({ baseURL, providerID: "openai", apiKey: "x" })
  await client.complete({
    model: "mock",
    messages: [{ role: "user", content: "hi" }],
    reasoningEffort: "low",
  })
  assert.equal(bodies[0]!.reasoning_effort, "low")
  assert.equal(bodies[0]!.reasoning, undefined)
})

test("no effort means no effort is sent", async () => {
  bodies.length = 0
  const client = new LlmClient({ baseURL, providerID: "openrouter", apiKey: "x" })
  await client.complete({ model: "mock", messages: [{ role: "user", content: "hi" }] })
  assert.equal(bodies[0]!.reasoning, undefined)
  assert.equal(bodies[0]!.reasoning_effort, undefined)
})

test("a picture goes with the tool result", async () => {
  bodies.length = 0
  const client = new LlmClient({ baseURL, providerID: "mock", apiKey: "x" })
  await client.complete({
    model: "mock",
    messages: [
      { role: "user", content: "what is in the picture?" },
      {
        role: "tool",
        name: "read",
        toolCallId: "call_1",
        content: [
          { type: "text", text: "a.png (image, 4 bytes)" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ],
  })
  const tool = bodies[0]!.messages.find((message: any) => message.role === "tool")
  assert.equal(tool.content[1].type, "image_url")
  assert.match(tool.content[1].image_url.url, /^data:image\/png;base64,/)
})
