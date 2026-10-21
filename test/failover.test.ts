import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { runAgentTurn, type AgentEvent } from "../src/agent/agent.ts"
import { LlmError, type LlmErrorKind } from "../src/llm/errors.ts"
import { createClient } from "../src/llm/factory.ts"
import { ConfigStore } from "../src/config/store.ts"
import { ProviderRegistry } from "../src/provider/registry.ts"
import { createFailover } from "../src/provider/failover.ts"
import type { CatalogResult } from "../src/provider/catalog.ts"
import type { ChatClient } from "../src/llm/client.ts"
import type { ModelInfo, ProviderConfig } from "../src/provider/types.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * What happens when a provider refuses the request.
 *
 * A throttle is not a failure of the task, so the turn moves to another model
 * and carries on. A rejected key is not a throttle: it fails the same way
 * everywhere, so the turn ends and says so.
 */

function makeModel(id: string, providerID: string, cost = 0): ModelInfo {
  return {
    id,
    providerID,
    name: id,
    contextWindow: 32_000,
    toolSupport: true,
    reasoning: false,
    vision: false,
    cost: { input: cost, output: cost, currency: "USD" },
    status: "active",
    origin: "catalog",
  }
}

const noopContext: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

function refusingClient(kind: LlmErrorKind, modelID = "a"): ChatClient {
  return {
    providerID: "openrouter",
    complete: async () => {
      throw new LlmError({
        kind,
        message: "slow down",
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
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      modelID: "b",
    }),
  } as unknown as ChatClient
}

test("a rate limit moves the turn to another model instead of ending it", async () => {
  const events: AgentEvent[] = []
  let calls = 0
  const result = await runAgentTurn(
    {
      client: refusingClient("rate_limit"),
      model: makeModel("a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async () => {
        calls++
        return { client: workingClient("the answer from the other model"), model: makeModel("b", "groq") }
      },
      onEvent: (event) => events.push(event),
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(calls, 1)
  assert.equal(result.stoppedReason, "finished")
  assert.equal(result.messages.at(-1)!.content, "the answer from the other model")

  const notice = events.find((event) => event.type === "notice")
  assert.ok(notice, "the switch should be reported")
  assert.match(notice.text!, /Rate limited on openrouter\/a/)
  assert.match(notice.text!, /groq\/b/)
})

test("a quota that is used up moves the turn too", async () => {
  let calls = 0
  const result = await runAgentTurn(
    {
      client: refusingClient("quota"),
      model: makeModel("a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async () => {
        calls++
        return { client: workingClient("done"), model: makeModel("b", "groq") }
      },
    },
    [{ role: "user", content: "hi" }],
  )
  assert.equal(calls, 1)
  assert.equal(result.stoppedReason, "finished")
})

test("a rejected key does not move the turn", async () => {
  let calls = 0
  const result = await runAgentTurn(
    {
      client: refusingClient("auth"),
      model: makeModel("a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async () => {
        calls++
        return { client: workingClient("done"), model: makeModel("b", "groq") }
      },
    },
    [{ role: "user", content: "hi" }],
  )
  assert.equal(calls, 0, "a bad key fails the same way everywhere")
  assert.equal(result.stoppedReason, "error")
  assert.equal(result.error?.kind, "auth")
})

test("the turn gives up rather than trying providers forever", async () => {
  let calls = 0
  const result = await runAgentTurn(
    {
      client: refusingClient("rate_limit"),
      model: makeModel("a", "openrouter"),
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: async () => {
        calls++
        return { client: refusingClient("rate_limit", `m${calls}`), model: makeModel(`m${calls}`, "groq") }
      },
    },
    [{ role: "user", content: "hi" }],
  )
  assert.equal(calls, 3, "three providers is enough")
  assert.equal(result.stoppedReason, "error")
  assert.equal(result.error?.kind, "rate_limit")
})

/** A registry with a known catalog, so the ranking can be tested offline. */
class StubRegistry extends ProviderRegistry {
  constructor(
    private readonly catalogModels: ModelInfo[],
    private readonly usable: string[],
    config: ConfigStore,
  ) {
    super(config)
  }

  override async catalog(provider: ProviderConfig): Promise<CatalogResult> {
    return { models: this.catalogModels.filter((model) => model.providerID === provider.id), notes: [] }
  }

  override providers(): ProviderConfig[] {
    return this.usable.map((id) => ({ id, kind: "openai-compatible", name: id, baseURL: "" }))
  }

  override async isUsable(provider: ProviderConfig): Promise<boolean> {
    return this.usable.includes(provider.id)
  }
}

/** A config on disk, so the store can be read like the real one. */
function makeConfig(): ConfigStore {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-stub-"))
  return new ConfigStore(path.join(tmp, "config.json"))
}

test("the free model on another provider comes first", async () => {
  const registry = new StubRegistry(
    [
      makeModel("other-free", "openrouter"),
      makeModel("elsewhere-free", "groq"),
      makeModel("paid", "openai", 3),
    ],
    ["openrouter", "groq", "openai"],
    makeConfig(),
  )
  const ranked = await registry.fallbackModels(makeModel("failed", "openrouter"))
  assert.deepEqual(
    ranked.map((model) => model.id),
    ["elsewhere-free", "paid", "other-free"],
  )
})

test("the router comes first, because it knows where the quota is left", async () => {
  const registry = new StubRegistry(
    [makeModel("auto", "freellmapi"), makeModel("elsewhere-free", "groq")],
    ["freellmapi", "groq"],
    makeConfig(),
  )
  const ranked = await registry.fallbackModels(makeModel("failed", "openrouter"))
  assert.equal(ranked[0]!.id, "auto")
})

test("a provider without a key is not offered", async () => {
  const registry = new StubRegistry(
    [makeModel("free", "groq"), makeModel("paid", "openai", 3)],
    ["groq"],
    makeConfig(),
  )
  const ranked = await registry.fallbackModels(makeModel("failed", "openrouter"))
  assert.deepEqual(
    ranked.map((model) => model.id),
    ["free"],
  )
})

/** The built-ins are off, so the test never reaches the real internet. */
const BUILTIN_IDS = [
  "freellmapi",
  "ollama",
  "lmstudio",
  "openai",
  "openrouter",
  "anthropic",
  "nvidia",
  "groq",
  "cerebras",
]

test("a provider that is down is not offered", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-down-"))
  const config = new ConfigStore(path.join(tmp, "config.json"))
  for (const id of BUILTIN_IDS) {
    config.setProvider({ id, kind: "openai-compatible", name: id, baseURL: "", enabled: false })
  }
  // The router is configured, has a key, and is not running. Its seeded
  // `auto` model must not be offered: it cannot answer.
  config.setProvider({
    id: "freellmapi",
    kind: "freellmapi",
    name: "FreeLLMAPI",
    baseURL: "http://127.0.0.1:9/v1",
  })
  config.setApiKey("freellmapi", "key-router")

  const registry = new ProviderRegistry(config)
  const ranked = await registry.fallbackModels(makeModel("failed", "openrouter"))
  assert.deepEqual(
    ranked.map((model) => model.id),
    [],
    "a provider that cannot be reached is not a fallback",
  )
})

test("over the wire: a throttled provider hands the turn to another one", async () => {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      if (request.url?.endsWith("/models")) {
        const id = request.url.startsWith("/a/") ? "model-a" : "model-b"
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "list",
            data: [{ id, name: id, context_window: 32_000, supported_parameters: ["tools"] }],
          }),
        )
        return
      }
      if (request.url?.startsWith("/a/")) {
        response.writeHead(429, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: { message: "Rate limit exceeded for this model" } }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "the answer from the other provider" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  const url = `http://127.0.0.1:${address.port}`

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-failover-"))
  const config = new ConfigStore(path.join(tmp, "config.json"))
  for (const id of BUILTIN_IDS) {
    config.setProvider({ id, kind: "openai-compatible", name: id, baseURL: "", enabled: false })
  }
  config.setProvider({ id: "a", kind: "openai-compatible", name: "A", baseURL: `${url}/a/v1` })
  config.setProvider({ id: "b", kind: "openai-compatible", name: "B", baseURL: `${url}/b/v1` })
  config.setApiKey("a", "key-a")
  config.setApiKey("b", "key-b")

  const registry = new ProviderRegistry(config)
  const modelA = await registry.findModel("a/model-a")
  const providerA = registry.provider("a")
  assert.ok(modelA, "the first provider should publish a model")
  assert.ok(providerA)

  const events: AgentEvent[] = []
  const result = await runAgentTurn(
    {
      client: createClient(providerA, "key-a"),
      model: modelA,
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
      fallback: createFailover({ registry, config }),
      onEvent: (event) => events.push(event),
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(result.stoppedReason, "finished")
  assert.equal(result.messages.at(-1)!.content, "the answer from the other provider")
  const notice = events.find((event) => event.type === "notice")
  assert.match(notice?.text ?? "", /Rate limited on a\/model-a/)
  assert.match(notice?.text ?? "", /b\/model-b/)

  await new Promise<void>((resolve) => server.close(() => resolve()))
})
