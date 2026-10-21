import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { WebServer, readImages, messageOf, transcriptOf } from "../src/web/server.ts"

/**
 * A picture the user pasted.
 *
 * It has to reach the model as an image part, and it has to stay a picture:
 * anything that is not an image is dropped rather than passed on.
 */

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

let mock: http.Server
let mockURL: string
let projectRoot: string
let configFile: string
const seen: any[] = []

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-pic-project-"))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-pic-state-"))
  configFile = path.join(tmp, "config.json")

  mock = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            data: [
              {
                id: "mock",
                name: "Mock",
                context_window: 32_000,
                supported_parameters: ["tools", "image"],
                architecture: { modality: "text+image->text" },
              },
            ],
          }),
        )
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      seen.push(body)
      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "I can see it." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const address = mock.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  mockURL = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

test("only a picture is taken, and only one that is small enough", () => {
  const images = readImages([
    PNG,
    "data:text/plain;base64,aGk=",
    "not a data url",
    42,
    `data:image/png;base64,${"A".repeat(8 * 1024 * 1024)}`,
  ])
  assert.equal(images.length, 1)
  assert.equal(images[0]!.mime, "image/png")
  assert.equal(images[0]!.url, PNG)
})

test("a message with a picture carries it to the model", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: `${mockURL}/v1`,
    defaultContextWindow: 32_000,
  })
  config.setApiKey("mock", "mock-secret-value-123456")
  config.setDefaultModel("mock/mock")

  const server = new WebServer(config, { projectRoot, port: 0, host: "127.0.0.1" })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as unknown as { token: string }).token

  try {
    const response = await fetch(`${base}/api/message`, {
      method: "POST",
      headers: { "x-punani-token": token, "content-type": "application/json" },
      body: JSON.stringify({ text: "what is this?", images: [PNG] }),
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true }, "the turn should have started")

    // Give the turn a moment to reach the provider.
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.ok(seen.length > 0, "the provider should have been asked")
    const user = seen[0].messages.find((message: any) => message.role === "user")
    assert.ok(Array.isArray(user.content), "the message carries parts")
    const image = user.content.find((part: any) => part.type === "image_url")
    assert.ok(image, "the picture should be in the message")
    assert.equal(image.image_url.url, PNG)
    assert.equal(user.content[0].text, "what is this?")
  } finally {
    await server.stop()
  }
})

test("the transcript says a picture came with it", () => {
  const images = readImages([PNG])
  assert.equal(transcriptOf("look", images), "[1 image attached]\nlook")
  assert.equal(transcriptOf("look", []), "look")
  assert.equal(messageOf("look", []), "look")
})
