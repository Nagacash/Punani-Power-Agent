import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { McpClient } from "../src/mcp/client.ts"
import { McpRegistry } from "../src/mcp/registry.ts"
import { ConfigStore } from "../src/config/store.ts"
import { diskMutate } from "../src/tool/fsutil.ts"

const SERVER = path.resolve("samples/test-mcp-server.mjs")

test("the mcp client handshakes, lists tools and calls one", async () => {
  const client = new McpClient({
    name: "test",
    command: "node",
    args: [SERVER],
  })
  try {
    await client.connect()
    assert.equal(client.serverName, "punani-test-mcp")
    const names = client.availableTools.map((tool) => tool.name)
    assert.deepEqual(names, ["echo", "add"])

    const echoed = await client.callTool("echo", { text: "hello from punani" })
    assert.equal(echoed.content[0]?.text, "echo: hello from punani")

    const summed = await client.callTool("add", { a: 2, b: 40 })
    assert.equal(summed.content[0]?.text, "42")
  } finally {
    await client.close()
  }
})

test("a server that cannot start is reported, not fatal", async () => {
  const registry = new McpRegistry([
    { name: "broken", command: "definitely-not-a-real-command-xyz" },
    { name: "test", command: "node", args: [SERVER] },
  ])
  const tools = await registry.start()
  try {
    // The good server still connected.
    assert.equal(tools.length, 2)
    assert.equal(registry.connected.length, 1)
    assert.equal(registry.problems.length, 1)
    assert.match(registry.problems[0]!, /broken/)
  } finally {
    await registry.stop()
  }
})

test("mcp tools are named for the wire and gated by a permission", async () => {
  const registry = new McpRegistry([{ name: "test", command: "node", args: [SERVER] }])
  const tools = await registry.start()
  try {
    const echo = tools.find((tool) => tool.name === "test_echo")
    assert.ok(echo, "the tool should be named server_tool")
    assert.equal(echo!.permissionAction, "mcp")

    let asked: string | undefined
    const granted = await echo!.run(
      { text: "hi" },
      {
        projectRoot: process.cwd(),
        requestPermission: async (request: any) => {
          asked = request.resource
          return { granted: true }
        },
        notify: () => {},
        previewDiff: () => {},
        mutate: diskMutate,
      },
    )
    assert.equal(asked, "test.echo")
    assert.match(granted.output, /echo: hi/)

    // A refused call writes nothing and says so.
    const refused = await echo!.run(
      { text: "hi" },
      {
        projectRoot: process.cwd(),
        requestPermission: async () => ({ granted: false, message: "no" }),
        notify: () => {},
        previewDiff: () => {},
        mutate: diskMutate,
      },
    )
    assert.equal(refused.isError, true)
    assert.match(refused.output, /declined/i)
  } finally {
    await registry.stop()
  }
})

test("the config file round trips the mcp servers", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "punani-mcp-")), "config.json")
  const config = new ConfigStore(file)
  config.setMcpServers([
    { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
    { name: "off", command: "node", enabled: false },
  ])
  const reread = new ConfigStore(file).mcpServers()
  assert.equal(reread.length, 2)
  assert.equal(reread[0]!.name, "filesystem")
  assert.deepEqual(reread[0]!.args?.slice(-1), ["/tmp"])
  assert.equal(reread[1]!.enabled, false)
})
