import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { ProviderRegistry } from "../src/provider/registry.ts"
import { LlmClient } from "../src/llm/client.ts"
import { BUILTIN_TOOLS } from "../src/tool/registry.ts"
import { runAgentTurn } from "../src/agent/agent.ts"
import { PermissionEngine, checkPermission } from "../src/agent/permission.ts"
import { SessionStore, toChatMessages } from "../src/session/store.ts"
import { diskMutate } from "../src/tool/fsutil.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * End-to-end check of the agent loop against a mock OpenAI-compatible server.
 *
 * The server hands back a tool call for `read`, then a final answer once the
 * tool result comes back. That exercises: catalog fetch, model selection, the
 * chat request, the permission gate, the tool itself, and the session log.
 */

let server: http.Server
let baseURL: string
let projectRoot: string
let sessionDir: string
let configFile: string
let turn = 0
const seenRequests: any[] = []

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-project-"))
  fs.writeFileSync(path.join(projectRoot, "hello.txt"), "greeting from the sample project\n")
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true })
  fs.writeFileSync(path.join(projectRoot, "src", "app.ts"), "export const answer = 42\n")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-state-"))
  sessionDir = path.join(tmp, "sessions")
  configFile = path.join(tmp, "config.json")

  server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
      seenRequests.push({ url: request.url, body })

      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "mock-tooler",
                name: "Mock Tooler",
                context_window: 32_000,
                supported_parameters: ["tools"],
              },
              { id: "mock-plain", name: "Mock Plain", context_window: 8_000, supported_parameters: [] },
            ],
          }),
        )
        return
      }

      if (request.url === "/v1/chat/completions") {
        turn++
        const hasToolResult = (body.messages ?? []).some((message: any) => message.role === "tool")
        if (!hasToolResult) {
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              model: "mock-tooler",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "read",
                          arguments: JSON.stringify({ path: "hello.txt" }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 120, completion_tokens: 18 },
            }),
          )
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            model: "mock-tooler",
            choices: [{ message: { role: "assistant", content: "The file greets you." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 200, completion_tokens: 9 },
          }),
        )
        return
      }

      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "not found" } }))
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

test("the agent reads a file through a tool call and answers", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL,
    env: "MOCK_API_KEY",
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")

  const registry = new ProviderRegistry(config)
  const model = await registry.findModel("mock/mock-tooler")
  assert.ok(model, "model should be found in the catalog")
  assert.equal(model!.toolSupport, true)
  assert.equal(model!.contextWindow, 32_000)

  const asked: string[] = []
  const permissions = new PermissionEngine(config.permissions())
  const context: ToolContext = {
    projectRoot,
    requestPermission: async (request) => {
      asked.push(request.action)
      const outcome = await checkPermission(permissions, request, async () => ({ granted: true }))
      return outcome
    },
    notify: () => {},
    previewDiff: () => {},
    mutate: diskMutate,
  }

  const client = new LlmClient({ baseURL, apiKey: "mock-secret-value-123456", providerID: "mock" })
  const result = await runAgentTurn(
    { client, model: model!, tools: BUILTIN_TOOLS, projectRoot, context },
    [{ role: "user", content: "What does hello.txt say?" }],
  )

  assert.equal(result.stoppedReason, "finished")
  assert.equal(result.error, undefined)
  assert.ok(asked.includes("read"), "the read action should have been permission-checked")

  const toolMessage = result.messages.find((message) => message.role === "tool")
  assert.ok(toolMessage, "a tool result should be in the message list")
  assert.match(toolMessage!.content ?? "", /greeting from the sample project/)

  const last = result.messages[result.messages.length - 1]!
  assert.equal(last.role, "assistant")
  assert.match(last.content ?? "", /greets you/)

  // The provider must have received the tool definition and the tool result.
  const chatRequests = seenRequests.filter((entry) => entry.url === "/v1/chat/completions")
  assert.ok(chatRequests.length >= 2, "the agent should have made a second request after the tool ran")
  const first = chatRequests[0]!
  assert.equal(first.body.tools.length, BUILTIN_TOOLS.length)
  const lastRequest = chatRequests[chatRequests.length - 1]!
  assert.ok(
    lastRequest.body.messages.some((message: any) => message.role === "tool" && message.tool_call_id === "call_1"),
    "the tool result should be sent back to the provider",
  )
  assert.equal(result.usage.inputTokens, 320)
})

test("a model without tool support is marked and rejected by the registry", async () => {
  const config = new ConfigStore(configFile)
  const registry = new ProviderRegistry(config)
  const model = await registry.findModel("mock/mock-plain")
  assert.ok(model)
  assert.equal(model!.toolSupport, false)
})

test("the session store records and reads back a conversation", async () => {
  const store = new SessionStore(sessionDir)
  const meta = store.create(projectRoot, "mock/mock-tooler", "mock")
  store.append(meta, { role: "user", content: "hello there", timestamp: Date.now() })
  store.append(meta, { role: "assistant", content: "hi", model: "mock/mock-tooler", timestamp: Date.now() })

  const stored = store.read(meta.id)
  assert.ok(stored)
  assert.equal(stored!.messages.length, 2)
  assert.equal(stored!.messages[0]!.content, "hello there")
  assert.ok(stored!.meta.title.startsWith("hello there"))
})

test("a stored session replays into the provider message format", async () => {
  const store = new SessionStore(sessionDir)
  const meta = store.create(projectRoot, "mock/mock-tooler", "mock")
  store.append(meta, { role: "user", content: "read hello.txt", timestamp: Date.now() })
  store.append(meta, {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_9", name: "read", arguments: '{"path":"hello.txt"}' }],
    timestamp: Date.now(),
  })
  store.append(meta, {
    role: "tool",
    content: "greeting from the sample project",
    tool: "read",
    toolCallId: "call_9",
    timestamp: Date.now(),
  })

  const stored = store.read(meta.id)!
  const messages = toChatMessages(stored.messages)
  assert.equal(messages.length, 3)
  assert.equal(messages[0]!.role, "user")
  assert.equal(messages[1]!.role, "assistant")
  assert.equal(messages[1]!.toolCalls?.[0]!.id, "call_9")
  assert.equal(messages[1]!.toolCalls?.[0]!.name, "read")
  assert.equal(messages[2]!.role, "tool")
  assert.equal(messages[2]!.toolCallId, "call_9")
  assert.equal(messages[2]!.name, "read")
})

test("a denied permission stops the tool from running", async () => {
  const config = new ConfigStore(configFile)
  // Rule 1: deny outright.
  const denying = new PermissionEngine({
    read: [{ pattern: "*", effect: "deny" }],
  })
  const denyContext: ToolContext = {
    projectRoot,
    requestPermission: async (request) => checkPermission(denying, request, async () => ({ granted: true })),
    notify: () => {},
    previewDiff: () => {},
    mutate: diskMutate,
  }
  const read = BUILTIN_TOOLS.find((tool) => tool.name === "read")!
  const denied = await read.run({ path: "hello.txt" }, denyContext)
  assert.equal(denied.isError, true)
  assert.match(denied.output, /declined/i)

  // Rule 2: ask, and the user rejects.
  const asking = new PermissionEngine({
    read: [{ pattern: "*", effect: "ask" }],
  })
  const askContext: ToolContext = {
    projectRoot,
    requestPermission: async (request) => checkPermission(asking, request, async () => ({ granted: false, message: "not now" })),
    notify: () => {},
    previewDiff: () => {},
    mutate: diskMutate,
  }
  const rejected = await read.run({ path: "hello.txt" }, askContext)
  assert.equal(rejected.isError, true)
  assert.match(rejected.output, /declined/i)
  assert.match(rejected.output, /not now/)
})

test("the default ruleset lets the work through and asks for the damage", async () => {
  const config = new ConfigStore(configFile)
  const engine = new PermissionEngine(config.permissions())
  // The work itself does not need a signature.
  assert.equal(engine.decide("read", "src/app.ts").effect, "allow")
  assert.equal(engine.decide("search", "src").effect, "allow")
  assert.equal(engine.decide("edit", "src/app.ts").effect, "allow")
  assert.equal(engine.decide("write", "src/new.ts").effect, "allow")
  assert.equal(engine.decide("bash", "npm test").effect, "allow")
  assert.equal(engine.decide("bash", "git status").effect, "allow")
  // What can lose work asks.
  assert.equal(engine.decide("write-destructive", "src/app.ts").effect, "ask")
  assert.equal(engine.decide("edit-destructive", "src/app.ts").effect, "ask")
  assert.equal(engine.decide("bash-destructive", "rm -rf build").effect, "ask")
})

test("a config written before the rules changed is brought forward", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-perm-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      permissions: {
        read: [{ pattern: "*", effect: "allow" }],
        write: [{ pattern: "*", effect: "ask" }],
        edit: [{ pattern: "*", effect: "ask" }],
        bash: [
          { pattern: "*", effect: "ask" },
          { pattern: "npm test*", effect: "allow" },
        ],
      },
    }),
  )
  const config = new ConfigStore(file)
  const engine = new PermissionEngine(config.permissions())
  // The old defaults are replaced.
  assert.equal(engine.decide("edit", "src/app.ts").effect, "allow")
  assert.equal(engine.decide("write", "src/app.ts").effect, "allow")
  // A rule the user wrote is kept.
  assert.equal(engine.decide("bash", "npm test").effect, "allow")
  // And the new actions are in place.
  assert.equal(engine.decide("bash-destructive", "rm -rf build").effect, "ask")
})

test("an always-allow reply is remembered for the session", async () => {
  const engine = new PermissionEngine({ bash: [{ pattern: "*", effect: "ask" }] })
  const request = {
    action: "bash",
    resource: "npm test",
    summary: "Run: npm test",
    alwaysPatterns: ["npm test"],
  }
  const outcome = await checkPermission(engine, request, async () => ({
    granted: true,
    remember: true,
    patterns: ["npm test"],
  }))
  assert.equal(outcome.granted, true)
  assert.equal(engine.decide("bash", "npm test").effect, "allow")
  assert.equal(engine.decide("bash", "npm run build").effect, "ask")
})
