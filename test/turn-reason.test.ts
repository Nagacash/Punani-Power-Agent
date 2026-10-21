import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

// The state directory has to be set before the logger loads, so this import
// comes first.
import { stateDir } from "./env.ts"
import { runAgentTurn } from "../src/agent/agent.ts"
import { LlmError } from "../src/llm/errors.ts"
import { SessionStore } from "../src/session/store.ts"
import type { ChatClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { Tool, ToolContext } from "../src/tool/types.ts"

/**
 * Why a turn stopped.
 *
 * The transcript does not say it: the answer and the tools look the same
 * whether the model finished, hit the step limit, was cancelled, or died on a
 * provider error. The stop reason goes into the log file and the session, so
 * a post-mortem is possible.
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

function logText(): string {
  const file = path.join(stateDir, "punani.log")
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
}

test("a turn that dies on the provider says so in the log", async () => {
  const client = {
    providerID: "mock",
    complete: async () => {
      throw new LlmError({
        kind: "rate_limit",
        message: "Too Many Requests",
        providerID: "mock",
        modelID: "mock",
        status: 429,
      })
    },
  } as unknown as ChatClient

  const result = await runAgentTurn(
    {
      client,
      model,
      tools: [],
      projectRoot: "/tmp/project",
      context: noopContext,
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(result.stoppedReason, "error")
  assert.match(logText(), /turn failed on mock\/mock: rate_limit/)
})

test("a turn that runs out of steps says so in the log", async () => {
  const tool: Tool = {
    name: "read",
    description: "read a file",
    parameters: { type: "object", properties: {} },
    permissionAction: "read",
    run: async () => ({ output: "the file" }),
  }
  const client = {
    providerID: "mock",
    complete: async () => ({
      content: "",
      toolCalls: [{ id: "call_1", name: "read", arguments: "{}" }],
      usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      modelID: "mock",
    }),
  } as unknown as ChatClient

  const result = await runAgentTurn(
    {
      client,
      model,
      tools: [tool],
      projectRoot: "/tmp/project",
      context: noopContext,
      maxSteps: 2,
    },
    [{ role: "user", content: "hi" }],
  )

  assert.equal(result.stoppedReason, "max_steps")
  assert.match(logText(), /turn stopped after 2 tool steps/)
})

test("the session log records why the turn ended", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-sessions-"))
  const sessions = new SessionStore(dir)
  const meta = sessions.create("/tmp/project", "mock", "mock")

  sessions.appendTurn(meta, { stoppedReason: "max_steps" })
  sessions.appendTurn(meta, {
    stoppedReason: "error",
    errorKind: "rate_limit",
    errorMessage: "Too Many Requests",
  })

  const stored = sessions.read(meta.id)!
  const turns = stored.messages.filter((message) => message.stoppedReason)
  assert.equal(turns.length, 2)
  assert.equal(turns[0]!.stoppedReason, "max_steps")
  assert.equal(turns[1]!.errorKind, "rate_limit")
  assert.equal(turns[1]!.errorMessage, "Too Many Requests")
})
