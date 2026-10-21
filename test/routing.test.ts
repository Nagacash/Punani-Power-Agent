import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { buildRoutes, parseRoutes, renderRoutes } from "../src/skills/routing.ts"
import { discoverSkills, parseFrontmatter } from "../src/skills/loader.ts"
import { loadAlwaysOn, renderAlwaysOn } from "../src/agent/prompt.ts"
import { runAgentTurn } from "../src/agent/agent.ts"
import type { LlmClient } from "../src/llm/client.ts"
import type { ModelInfo } from "../src/provider/types.ts"
import type { AgentEvent } from "../src/agent/agent.ts"
import type { Skill } from "../src/skills/loader.ts"
import type { ToolContext } from "../src/tool/types.ts"

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test("a routes file is read one line at a time", () => {
  const known = new Set(["naga-review", "naga-verify"])
  const routes = parseRoutes(
    [
      "# a comment",
      "",
      "when: the user wants a security review -> naga-review",
      "when: the code needs a quality gate -> naga-verify",
      "when: a broken line",
      "when: an unknown skill -> not-a-skill",
    ].join("\n"),
    "test",
    known,
  )
  assert.equal(routes.length, 2)
  assert.equal(routes[0]!.skill, "naga-review")
  assert.equal(routes[0]!.when, "the user wants a security review")
})

test("a skill's own triggers become routes", () => {
  const skill = {
    name: "punani-platform",
    title: "punani-platform",
    description: "How the platform works.",
    triggers: ["a change has to be applied and reviewed"],
    antiTriggers: ["the question is about the user's code"],
    requiredReceipts: ["bash"],
    allowedTools: [],
    disableModelInvocation: false,
    file: "/tmp/SKILL.md",
    dir: "/tmp",
    source: "test",
    metadata: {},
  } as unknown as Skill
  const routes = buildRoutes(tempDir("punani-routes-"), [skill], { userRoutes: false })
  assert.equal(routes.length, 1)
  assert.equal(routes[0]!.skill, "punani-platform")
  assert.deepEqual(routes[0]!.antiTriggers, ["the question is about the user's code"])
})

test("the routing table says which skill to load, and stops at the budget", () => {
  const routes = parseRoutes(
    ["when: one -> a", "when: two -> b", "when: three -> c"].join("\n"),
    "test",
    new Set(),
  )
  const table = renderRoutes(routes, 2)
  assert.match(table, /load the `a` skill/)
  assert.match(table, /1 more route/)
  assert.doesNotMatch(table, /load the `c` skill/)
})

test("frontmatter can carry a list", () => {
  const meta = parseFrontmatter(
    ["---", "name: x", "triggers:", "  - one thing", "  - another thing", "---", "", "body"].join("\n"),
  )
  assert.deepEqual(meta.triggers, ["one thing", "another thing"])
})

test("the always-on files are read, and the budget leaves a file out whole", () => {
  const root = tempDir("punani-always-")
  fs.mkdirSync(path.join(root, ".punani"), { recursive: true })
  fs.writeFileSync(path.join(root, ".punani", "guardrails.md"), "Never touch main.")
  fs.writeFileSync(path.join(root, ".punani", "memory.md"), "The tests are run with npm test.")

  const alwaysOn = loadAlwaysOn(root)
  assert.equal(alwaysOn.files.length, 2)
  assert.match(renderAlwaysOn(alwaysOn), /Never touch main\./)

  // A file that does not fit is left out, not cut in half.
  const tight = loadAlwaysOn(root, 10)
  assert.equal(tight.files.length, 0)
  assert.equal(tight.truncated, true)
})

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

const context: ToolContext = {
  projectRoot: "/tmp/project",
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
}

function clientThatCallsThenAnswers(calls: { name: string; args: any }[]): LlmClient {
  let index = 0
  return {
    providerID: "mock",
    complete: async () => {
      const call = calls[index++]
      if (call) {
        return {
          content: "",
          toolCalls: [{ id: `call_${index}`, name: call.name, arguments: JSON.stringify(call.args) }],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
          modelID: "mock",
        }
      }
      return {
        content: "Done.",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        modelID: "mock",
      }
    },
  } as unknown as LlmClient
}

test("a skill that asked for a receipt is told when the turn did not produce it", async () => {
  const skill = {
    name: "punani-platform",
    title: "punani-platform",
    description: "How the platform works.",
    triggers: [],
    antiTriggers: [],
    requiredReceipts: ["bash", "edit"],
    allowedTools: [],
    disableModelInvocation: false,
    file: "/tmp/SKILL.md",
    dir: "/tmp",
    source: "test",
    metadata: {},
  } as unknown as Skill

  const events: AgentEvent[] = []
  await runAgentTurn(
    {
      client: clientThatCallsThenAnswers([{ name: "skill_load", args: { name: "punani-platform" } }]),
      model,
      tools: [
        {
          name: "skill_load",
          description: "load a skill",
          parameters: { type: "object", properties: {} },
          permissionAction: "skill",
          run: async () => ({ output: "body" }),
        },
      ],
      projectRoot: "/tmp/project",
      context,
      skills: [skill],
      onEvent: (event) => events.push(event),
    },
    [{ role: "user", content: "do the thing" }],
  )

  const notice = events.find((event) => event.type === "notice")
  assert.ok(notice, "the turn should report the missing receipts")
  assert.match(notice!.text ?? "", /bash/)
  assert.match(notice!.text ?? "", /edit/)
})

test("a turn that produced the receipts is not nagged", async () => {
  const skill = {
    name: "punani-platform",
    title: "punani-platform",
    description: "How the platform works.",
    triggers: [],
    antiTriggers: [],
    requiredReceipts: ["bash"],
    allowedTools: [],
    disableModelInvocation: false,
    file: "/tmp/SKILL.md",
    dir: "/tmp",
    source: "test",
    metadata: {},
  } as unknown as Skill

  const events: AgentEvent[] = []
  await runAgentTurn(
    {
      client: clientThatCallsThenAnswers([
        { name: "skill_load", args: { name: "punani-platform" } },
        { name: "bash", args: { command: "npm test" } },
      ]),
      model,
      tools: [
        {
          name: "skill_load",
          description: "load a skill",
          parameters: { type: "object", properties: {} },
          permissionAction: "skill",
          run: async () => ({ output: "body" }),
        },
        {
          name: "bash",
          description: "run a command",
          parameters: { type: "object", properties: {} },
          permissionAction: "bash",
          run: async () => ({ output: "ok" }),
        },
      ],
      projectRoot: "/tmp/project",
      context,
      skills: [skill],
      onEvent: (event) => events.push(event),
    },
    [{ role: "user", content: "do the thing" }],
  )

  assert.equal(events.find((event) => event.type === "notice"), undefined)
})

test("a skill that declares triggers is discovered with them", () => {
  const root = tempDir("punani-skill-trigger-")
  const dir = path.join(root, "punani-platform")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    [
      "---",
      "name: punani-platform",
      "description: How the platform works.",
      "triggers:",
      "  - a change has to be applied and reviewed",
      "required_receipts: [bash, edit]",
      "---",
      "",
      "body",
    ].join("\n"),
  )
  const skills = discoverSkills([{ path: root, source: "test" }])
  assert.equal(skills.length, 1)
  assert.deepEqual(skills[0]!.triggers, ["a change has to be applied and reviewed"])
  assert.deepEqual(skills[0]!.requiredReceipts, ["bash", "edit"])
})

test("a skill's own files can be read, and the rest of the disk cannot", async () => {
  const root = tempDir("punani-read-")
  const library = tempDir("punani-library-")
  const dir = path.join(library, "test")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "writing-guide.md"), "how to write a test")

  const { readTool } = await import("../src/tool/fs-tools.ts")
  const context: ToolContext = {
    projectRoot: root,
    allowedReadDirs: [library],
    requestPermission: async () => ({ granted: true }),
    notify: () => {},
    previewDiff: () => {},
    mutate: async () => ({ applied: true }),
  }

  const inside = await readTool.run({ path: path.join(library, "test", "writing-guide.md") }, context)
  assert.match(inside.output, /how to write a test/)

  await assert.rejects(
    () => readTool.run({ path: "/etc/hosts" }, context),
    /outside the project/,
  )
})
