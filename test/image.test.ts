import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { createImageTool } from "../src/tool/image.ts"
import { ConfigStore } from "../src/config/store.ts"
import { WebServer } from "../src/web/server.ts"
import { diskMutate } from "../src/tool/fsutil.ts"

/**
 * Image generation and the file route that lets the browser show the result.
 */

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
)

let mock: http.Server
let mockURL: string
let projectRoot: string
let configFile: string

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-image-project-"))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-image-state-"))
  configFile = path.join(tmp, "config.json")

  mock = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      if (request.url === "/v1/images/generations") {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        response.writeHead(200, { "content-type": "application/json" })
        response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }], echoed: body.prompt }))
        return
      }
      response.writeHead(404)
      response.end("{}")
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const address = mock.address()
  if (!address || typeof address === "string") throw new Error("mock did not bind")
  mockURL = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

test("the image tool writes a png into the project", async () => {
  const tool = createImageTool({
    provider: "openai-compatible",
    baseURL: mockURL,
    model: "test-image-1",
    outputDir: "art",
  })

  let permission: string | undefined
  const context = {
    projectRoot,
    requestPermission: async (request: any) => {
      permission = request.action
      return { granted: true }
    },
    notify: () => {},
    previewDiff: () => {},
    mutate: diskMutate,
  }

  const result = await tool.run({ prompt: "a red cube on white", size: "1024x1024" }, context)
  assert.equal(permission, "image")
  assert.equal(result.meta?.provider, "openai-compatible")
  assert.equal(result.meta?.model, "test-image-1")

  const file = path.join(projectRoot, result.meta!.path)
  assert.ok(fs.existsSync(file), "the image should be written into the project")
  const bytes = fs.readFileSync(file)
  assert.equal(bytes.subarray(1, 4).toString(), "PNG")
})

test("a declined image request produces no file", async () => {
  const tool = createImageTool({ provider: "openai-compatible", baseURL: mockURL, model: "m" })
  const before = fs.readdirSync(projectRoot).length
  const result = await tool.run(
    { prompt: "declined" },
    {
      projectRoot,
      requestPermission: async () => ({ granted: false, message: "no" }),
      notify: () => {},
      previewDiff: () => {},
      mutate: diskMutate,
    },
  )
  assert.equal(result.isError, true)
  assert.match(result.output, /declined/i)
  assert.equal(fs.readdirSync(projectRoot).length, before)
})

test("the image tool explains a missing endpoint", async () => {
  const tool = createImageTool({ provider: "openai-compatible" })
  await assert.rejects(
    () =>
      tool.run(
        { prompt: "x" },
        {
          projectRoot,
          requestPermission: async () => ({ granted: true }),
          notify: () => {},
          previewDiff: () => {},
          mutate: diskMutate,
        },
      ),
    /no image endpoint is set/,
  )
})

test("the file route serves project files and refuses paths outside it", async () => {  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mockURL,
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")

  fs.writeFileSync(path.join(projectRoot, "inside.txt"), "inside content")
  fs.writeFileSync(path.join(os.tmpdir(), "punani-outside.txt"), "secret")

  const server = new WebServer(config, { projectRoot, port: 0, host: "127.0.0.1" })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as any).token as string

  try {
    const inside = await fetch(`${base}/file?path=inside.txt`, { headers: { "x-punani-token": token } })
    assert.equal(inside.status, 200)
    assert.equal(await inside.text(), "inside content")

    // A traversal out of the project must be refused.
    const escape = await fetch(`${base}/file?path=../punani-outside.txt`, {
      headers: { "x-punani-token": token },
    })
    assert.equal(escape.status, 403)

    const absolute = await fetch(`${base}/file?path=${encodeURIComponent("/etc/passwd")}`, {
      headers: { "x-punani-token": token },
    })
    assert.equal(absolute.status, 403)

    // And it still needs the token.
    const noToken = await fetch(`${base}/file?path=inside.txt`)
    assert.equal(noToken.status, 401)
  } finally {
    await server.stop()
  }
})
