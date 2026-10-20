import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { WebServer } from "../src/web/server.ts"

/**
 * End-to-end check of the browser frontend.
 *
 * A mock provider scripts a read, an edit and a final answer. The test drives
 * the server the way a browser does: it opens the event stream, posts a
 * message, waits for a permission request to arrive, approves it, and then
 * checks the diff, the tool result and the final answer all came through.
 */

let mock: http.Server
let mockURL: string
let projectRoot: string
let configFile: string
let step = 0

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-web-project-"))
  fs.writeFileSync(path.join(projectRoot, "hello.txt"), "original line\nsecond line\n")

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "punani-web-state-"))
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
              { id: "web-mock", name: "Web Mock", context_window: 32_000, supported_parameters: ["tools"] },
            ],
          }),
        )
        return
      }
      if (request.url === "/v1/chat/completions") {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
        // Keyed off the request count only. The agent sends one request per
        // step, so this walks the script in order: edit, then bash, then the
        // final answer.
        step++
        let message: any
        if (step === 1) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_edit",
                type: "function",
                function: {
                  name: "edit",
                  arguments: JSON.stringify({
                    path: "hello.txt",
                    oldString: "original line",
                    newString: "edited line",
                  }),
                },
              },
            ],
          }
        } else if (step === 2) {
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_bash",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "echo hello" }) },
              },
            ],
          }
        } else {
          message = { role: "assistant", content: "The file now says edited line." }
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            model: "web-mock",
            choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
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
  mockURL = `http://127.0.0.1:${address.port}/v1`
})

after(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

/** Open the event stream and collect events until `stop` says so. */
function listen(base: string, token: string, onEvent: (event: any) => boolean): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = []
    const request = http.get(
      `${base}/api/events`,
      { headers: { "x-punani-token": token, accept: "text/event-stream" } },
      (response) => {
        response.setEncoding("utf8")
        let buffer = ""
        response.on("data", (chunk) => {
          buffer += chunk
          let index: number
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            if (!frame.startsWith("data: ")) continue
            const event = JSON.parse(frame.slice(6))
            events.push(event)
            if (onEvent(event)) {
              request.destroy()
              resolve(events)
              return
            }
          }
        })
        response.on("error", reject)
      },
    )
    request.on("error", (error: any) => {
      if (error.code !== "ECONNRESET") reject(error)
    })
  })
}

async function post(base: string, token: string, route: string, body: any): Promise<any> {
  const response = await fetch(`${base}/api/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-punani-token": token },
    body: JSON.stringify(body),
  })
  return await response.json()
}

test("the folder browser lists folders and the project can be switched", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mockURL,
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")

  // A browse root with two folders, one of them hidden and one of them noise.
  const browseRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-browse-"))
  fs.mkdirSync(path.join(browseRoot, "alpha"))
  fs.mkdirSync(path.join(browseRoot, "beta"))
  fs.mkdirSync(path.join(browseRoot, "node_modules"))
  fs.mkdirSync(path.join(browseRoot, ".hidden"))
  fs.writeFileSync(path.join(browseRoot, "a-file.txt"), "x")

  const server = new WebServer(config, {
    projectRoot,
    port: 0,
    host: "127.0.0.1",
    browseRoot,
  })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as any).token as string

  try {
    const res = await fetch(`${base}/api/browse?path=`, { headers: { "x-punani-token": token } })
    assert.equal(res.status, 200)
    const listing = await res.json()
    assert.equal(listing.path, browseRoot)
    const names = listing.directories.map((d: any) => d.name)
    assert.ok(names.includes("alpha"))
    assert.ok(names.includes("beta"))
    // Noise and dot folders are not offered.
    assert.ok(!names.includes("node_modules"))
    assert.ok(!names.includes(".hidden"))

    // A path outside the browse root is clamped back to it.
    const escape = await fetch(`${base}/api/browse?path=${encodeURIComponent("/etc")}`, {
      headers: { "x-punani-token": token },
    })
    const escaped = await escape.json()
    assert.equal(escaped.path, browseRoot)

    // Switching the project changes what the agent works on.
    const target = path.join(browseRoot, "alpha")
    const switched = await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": token },
      body: JSON.stringify({ path: target }),
    })
    assert.deepEqual(await switched.json(), { ok: true, project: target })

    const state = await (await fetch(`${base}/api/state`, { headers: { "x-punani-token": token } })).json()
    assert.equal(state.project, target)

    // A path that is not a folder is refused.
    const bad = await fetch(`${base}/api/project`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": token },
      body: JSON.stringify({ path: path.join(browseRoot, "a-file.txt") }),
    })
    assert.equal((await bad.json()).ok, false)
  } finally {
    await server.stop()
  }
})

test("the browser interface runs a turn and asks for permission", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mockURL,
    env: "MOCK_API_KEY",
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")
  config.setDefaultModel("mock/web-mock")

  const server = new WebServer(config, { projectRoot, port: 0, host: "127.0.0.1" })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as any).token as string

  try {
    // The token gate.
    const unauth = await fetch(`${base}/api/state`)
    assert.equal(unauth.status, 401)

    const foreign = await fetch(`${base}/api/state`, {
      headers: { "x-punani-token": token, origin: "https://evil.example.com" },
    })
    assert.equal(foreign.status, 403)

    const allowed = await fetch(`${base}/api/state`, { headers: { "x-punani-token": token } })
    assert.equal(allowed.status, 200)
    const state = await allowed.json()
    assert.equal(state.model.id, "web-mock")
    assert.equal(state.project, projectRoot)

    // The HTML is served with a restrictive content security policy.
    const page = await fetch(`${base}/`, { headers: { "x-punani-token": token } })
    assert.equal(page.status, 200)
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/)

    // Drive a turn. The stream must show: a diff, a permission request, the
    // tool result, and the final answer.
    const stream = listen(base, token, (event) => event.type === "done")

    // Approve each prompt as it arrives. This watcher has to be running
    // before the turn starts, otherwise nothing can answer it.
    const approved: string[] = []
    const approval = (async () => {
      for (let i = 0; i < 400; i++) {
        const pending = await (
          await fetch(`${base}/api/state`, { headers: { "x-punani-token": token } })
        ).json()
        if (pending.pending.length > 0) {
          const id = pending.pending[0].id
          const action = pending.pending[0].request.action
          const result = await post(base, token, "permission", { id, reply: "once" })
          assert.deepEqual(result, { ok: true })
          approved.push(action)
          if (approved.length >= 2) return
          continue
        }
        if (approved.length >= 2) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (approved.length < 2) throw new Error("expected two permission requests, saw " + approved.length)
    })()

    const started = await post(base, token, "message", { text: "change the first line" })
    assert.deepEqual(started, { ok: true })

    const events = await stream
    await approval

    // Both the edit and the shell command must have been asked about.
    assert.deepEqual(approved, ["edit", "bash"])

    const types = events.map((event) => event.type)
    assert.ok(types.includes("diff"), "a diff should be previewed before the edit")
    assert.ok(types.includes("permission"), "the edit should ask for approval")
    assert.ok(types.includes("tool_end"), "the tool should report a result")
    assert.ok(types.includes("assistant"), "the model should answer")
    assert.ok(types.includes("done"), "the turn should finish")

    const diff = events.find((event) => event.type === "diff")
    assert.equal(diff.path, "hello.txt")
    assert.equal(diff.additions, 1)
    assert.equal(diff.deletions, 1)

    const permission = events.find((event) => event.type === "permission")
    assert.equal(permission.action, "edit")
    assert.equal(permission.destructive, true)
    assert.ok(permission.id)

    const toolEnd = events.find((event) => event.type === "tool_end" && event.tool === "edit")
    assert.match(toolEnd.output, /Edited hello\.txt/)

    const answer = events.find((event) => event.type === "assistant")
    assert.match(answer.text, /edited line/)

    // The file on disk was actually changed.
    assert.equal(fs.readFileSync(path.join(projectRoot, "hello.txt"), "utf8"), "edited line\nsecond line\n")
  } finally {
    await server.stop()
  }
})

test("the preview serves the project and injects live reload", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mockURL,
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")

  fs.writeFileSync(
    path.join(projectRoot, "page.html"),
    "<!doctype html><html><body><h1>hi</h1></body></html>",
  )
  fs.writeFileSync(path.join(projectRoot, "style.css"), "body{color:red}")

  const server = new WebServer(config, { projectRoot, port: 0, host: "127.0.0.1" })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as any).token as string

  try {
    // Turn the preview on.
    const on = await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": token },
      body: JSON.stringify({ mode: "static" }),
    })
    assert.equal((await on.json()).mode, "static")

    // It serves the project with the reload script injected.
    const page = await fetch(`${base}/preview/page.html`, { headers: { "x-punani-token": token } })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<h1>hi<\/h1>/)
    assert.match(html, /preview\/live/)

    // Content types are right.
    const css = await fetch(`${base}/preview/style.css`, { headers: { "x-punani-token": token } })
    assert.match(css.headers.get("content-type") ?? "", /text\/css/)

    // It cannot read outside the project.
    const escape = await fetch(`${base}/preview/../../../etc/passwd`, {
      headers: { "x-punani-token": token },
    })
    assert.equal(escape.status, 404)

    // And it still needs the token.
    const noToken = await fetch(`${base}/preview/page.html`)
    assert.equal(noToken.status, 401)
  } finally {
    await server.stop()
  }
})
