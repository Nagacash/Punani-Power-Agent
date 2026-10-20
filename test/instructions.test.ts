import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { WebServer } from "../src/web/server.ts"
import { loadProjectInstructions } from "../src/agent/instructions.ts"

/**
 * A repository tells the agent how it wants to be worked on, in AGENTS.md,
 * CLAUDE.md and friends. The agent has to read those, and it has to read the
 * new ones when the project changes.
 *
 * A mock provider records every system prompt it is given, so the test can
 * assert on what the model actually saw.
 */

let mock: http.Server
let mockURL: string
let stateDir: string
let configFile: string
let projectA: string
let projectB: string

/** The server only accepts a 64 hex character token. */
const TOKEN = "a".repeat(64)

/** The system prompt of every request the mock provider received. */
const systemPrompts: string[] = []

before(async () => {
  projectA = fs.mkdtempSync(path.join(os.tmpdir(), "punani-inst-a-"))
  projectB = fs.mkdtempSync(path.join(os.tmpdir(), "punani-inst-b-"))
  fs.writeFileSync(
    path.join(projectA, "AGENTS.md"),
    "# Project A rules\n\nAlways use `pnpm test` to run the tests.\n",
  )
  fs.writeFileSync(
    path.join(projectB, "AGENTS.md"),
    "# Project B rules\n\nAlways use `make check` to run the checks.\n",
  )

  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-inst-state-"))
  configFile = path.join(stateDir, "config.json")

  mock = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            data: [{ id: "inst-mock", name: "Inst Mock", context_window: 32_000 }],
          }),
        )
        return
      }
      if (request.url === "/v1/chat/completions") {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
        const system = (body.messages ?? [])
          .filter((m: any) => m.role === "system")
          .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n")
        systemPrompts.push(system)
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            model: "inst-mock",
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
        )
        return
      }
      response.writeHead(404)
      response.end("{}")
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const address = mock.address()
  if (!address || typeof address === "string") throw new Error("mock did not bind")
  mockURL = `${mockURLBase(address.port)}`
})

function mockURLBase(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

/** A server on the mock provider, pointed at a project. */
async function startServer(projectRoot: string): Promise<{ server: WebServer; base: string }> {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "inst",
    kind: "openai-compatible",
    name: "Inst Mock",
    baseURL: mockURL,
    env: "INST_API_KEY",
    anonymous: true,
    defaultContextWindow: 32_000,
  })
  config.setDefaultModel("inst/inst-mock")

  const server = new WebServer(config, {
    projectRoot,
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
    taskLabel: "Test",
  })
  await server.start()
  return { server, base: `http://127.0.0.1:${server.port}` }
}

async function ask(base: string, text: string): Promise<void> {
  const before = systemPrompts.length
  const response = await fetch(`${base}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-punani-token": TOKEN },
    body: JSON.stringify({ text }),
  })
  assert.equal(response.status, 200)
  // The turn runs in the background. Wait for the provider to be called, which
  // is the only proof the prompt was built and sent.
  for (let i = 0; i < 200; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (systemPrompts.length > before) return
  }
  throw new Error("the provider was never called")
}

test("the loader finds the instruction files at the project root", () => {
  const result = loadProjectInstructions(projectA)
  assert.deepEqual(result.files, ["AGENTS.md"])
  assert.match(result.text, /pnpm test/)
  assert.doesNotMatch(result.text, /make check/)
})

test("a project with no instructions gives nothing", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "punani-inst-empty-"))
  const result = loadProjectInstructions(empty)
  assert.deepEqual(result.files, [])
  assert.equal(result.text, "")
})

test("the project instructions reach the model", async () => {
  systemPrompts.length = 0
  const { server, base } = await startServer(projectA)
  try {
    await ask(base, "hello")
    assert.ok(systemPrompts.length > 0, "the provider was never called")
    const prompt = systemPrompts.at(-1)!
    assert.match(prompt, /Project A rules/)
    assert.match(prompt, /pnpm test/)
  } finally {
    await server.stop()
  }
})

test("switching projects swaps the instructions", async () => {
  systemPrompts.length = 0
  const { server, base } = await startServer(projectA)
  try {
    await ask(base, "hello")
    assert.match(systemPrompts.at(-1)!, /Project A rules/)

    const switched = await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": TOKEN },
      body: JSON.stringify({ path: projectB }),
    })
    assert.equal(switched.status, 200)
    assert.equal(((await switched.json()) as any).ok, true)

    await ask(base, "hello again")
    const prompt = systemPrompts.at(-1)!
    assert.match(prompt, /Project B rules/)
    assert.match(prompt, /make check/)
    assert.doesNotMatch(prompt, /pnpm test/)
  } finally {
    await server.stop()
  }
})

/** A project with one project-local skill. */
function writeSkill(root: string, name: string): void {
  const dir = path.join(root, ".agents", "skills", name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: The ${name} skill for this project only.\n---\n\nDo the ${name} thing.\n`,
  )
}

test("switching projects swaps the project skills", async () => {
  systemPrompts.length = 0
  writeSkill(projectA, "alpha-skill")
  writeSkill(projectB, "beta-skill")

  const { server, base } = await startServer(projectA)
  try {
    await ask(base, "hello")
    const first = systemPrompts.at(-1)!
    assert.match(first, /alpha-skill/)
    assert.doesNotMatch(first, /beta-skill/)

    await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": TOKEN },
      body: JSON.stringify({ path: projectB }),
    })

    await ask(base, "hello again")
    const second = systemPrompts.at(-1)!
    assert.match(second, /beta-skill/)
    assert.doesNotMatch(second, /alpha-skill/)
  } finally {
    await server.stop()
  }
})
