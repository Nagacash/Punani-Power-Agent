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
        // The turn makes a picture. The preview pane should pick it up.
        if (step === 1) {
          fs.writeFileSync(path.join(projectRoot, "made.png"), "not really a png")
        }
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
          // A command that can lose work. That one asks.
          message = {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_bash",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "rm -rf ./build" }) },
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
          if (approved.length >= 1) return
          continue
        }
        if (approved.length >= 1) return
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (approved.length < 1) throw new Error("expected a permission request, saw " + approved.length)
    })()

    const started = await post(base, token, "message", { text: "change the first line" })
    assert.deepEqual(started, { ok: true })

    const events = await stream
    await approval

    // The ordinary edit went through without asking. The command that can
    // lose work asked.
    assert.deepEqual(approved, ["bash-destructive"])

    // The picture the turn made is in the preview pane.
    const after = await (await fetch(`${base}/api/state`, { headers: { "x-punani-token": token } })).json()
    assert.equal(after.preview.mode, "file")
    assert.equal(after.preview.file, "made.png")

    const types = events.map((event) => event.type)
    assert.ok(types.includes("diff"), "a diff should be previewed before the edit")
    assert.ok(types.includes("permission"), "the destructive command should ask for approval")
    assert.ok(types.includes("tool_end"), "the tool should report a result")
    assert.ok(types.includes("assistant"), "the model should answer")
    assert.ok(types.includes("done"), "the turn should finish")

    const diff = events.find((event) => event.type === "diff")
    assert.equal(diff.path, "hello.txt")
    assert.equal(diff.additions, 1)
    assert.equal(diff.deletions, 1)

    const permission = events.find((event) => event.type === "permission")
    assert.equal(permission.action, "bash-destructive")
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
    path.join(projectRoot, "index.html"),
    "<!doctype html><html><body><h1>hi</h1></body></html>",
  )
  fs.writeFileSync(
    path.join(projectRoot, "page.html"),
    "<!doctype html><html><body><h1>another</h1></body></html>",
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
    const page = await fetch(`${base}/preview/`, { headers: { "x-punani-token": token } })
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /<h1>hi<\/h1>/)
    assert.match(html, /preview\/live/)

    // The marker is a script tag, not an event stream. The preview page is
    // sandboxed, so it has an opaque origin and the browser will not let it
    // read a cross-origin response: an EventSource there is refused, and it
    // retries for ever. A script tag is executed rather than read, so it
    // works from a sandboxed page.
    assert.match(html, /<script src="\/preview\/live\?k=[a-f0-9]+" async><\/script>/)
    assert.doesNotMatch(html, /EventSource/)

    // Only the index carries it. The reload navigates to the page's own
    // path with the key, and the key opens the index, so a page at another
    // path must not carry it or it would reload into a refusal.
    const other = await fetch(`${base}/preview/page.html`, { headers: { "x-punani-token": token } })
    assert.equal(other.status, 200)
    assert.doesNotMatch(await other.text(), /preview\/live/)

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

test("the live reload channel is a script that reloads the page", async () => {
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mockURL,
    defaultContextWindow: 8_192,
  })
  config.setApiKey("mock", "mock-secret-value-123456")

  fs.writeFileSync(path.join(projectRoot, "page.html"), "<!doctype html><html><body></body></html>")

  const server = new WebServer(config, { projectRoot, port: 0, host: "127.0.0.1" })
  await server.start()
  const base = `http://127.0.0.1:${server.port}`
  const token = (server as any).token as string

  try {
    await fetch(`${base}/api/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-punani-token": token },
      body: JSON.stringify({ mode: "static" }),
    })

    // The channel is a script, not an event stream.
    const live = await fetch(`${base}/preview/live`, { headers: { "x-punani-token": token } })
    assert.equal(live.status, 200)
    assert.match(live.headers.get("content-type") ?? "", /javascript/)
    // The body stays open on purpose, so let it go. An open response keeps
    // the server from closing, and the test run never finishes.
    await live.body?.cancel()

    // The page carries the key the channel is addressed with.
    const key = (server as any).preview.reloadKey as string
    assert.match(key, /^[a-f0-9]{32}$/)

    // The key opens the page and the channel.
    fs.writeFileSync(path.join(projectRoot, "index.html"), "<!doctype html><html><body><h1>home</h1></body></html>")
    const withKey = await fetch(`${base}/preview/?k=${key}`)
    assert.equal(withKey.status, 200)
    assert.match(await withKey.text(), /preview\/live\?k=/)

    // It opens nothing else. A page that reads the key out of its own
    // markup must not be able to walk the project with it.
    fs.writeFileSync(path.join(projectRoot, "secret.txt"), "not yours\n")
    for (const route of ["/preview/secret.txt", "/preview/style.css", "/preview/page.html", "/api/state"]) {
      const refused = await fetch(`${base}${route}?k=${key}`)
      assert.equal(refused.status, 401, `${route} must not open with the reload key`)
    }

    // And a wrong key opens nothing.
    const wrongKey = await fetch(`${base}/preview/?k=${"0".repeat(32)}`)
    assert.equal(wrongKey.status, 401)

    // A change on disk runs the reload command down the open response.
    //
    // The response stays open, so the channel has to be closed whatever
    // happens, or the server never finishes shutting down and the run hangs.
    const controller = new AbortController()
    try {
      const stream = await fetch(`${base}/preview/live?k=${key}`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      // One read is kept and reused. A read that times out is still waiting,
      // and starting another one would leave the first to take the reload
      // command and throw it away.
      let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null
      const read = async (ms: number): Promise<string> => {
        pending ??= reader.read()
        const chunk = await Promise.race([
          pending.then((c) => c),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
        ])
        // A read that timed out is still pending, so it is kept for next time.
        if (!chunk) return ""
        pending = null
        return chunk.done ? "" : new TextDecoder().decode(chunk.value)
      }
      assert.match(await read(2_000), /ready/)

      setTimeout(() => fs.writeFileSync(path.join(projectRoot, "index.html"), "<p>changed</p>"), 150)
      let reloadCommand = ""
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline && !reloadCommand) {
        const text = await read(1_000)
        if (text.includes("location.replace")) reloadCommand = text
      }
      assert.ok(reloadCommand, "the reload command never reached the page")
      // The command comes back with the key, so the page can load again: the
      // session cookie cannot be used, because the page is sandboxed.
      assert.match(reloadCommand, new RegExp(`k=${key}`))
    } finally {
      controller.abort()
    }
  } finally {
    await server.stop()
  }
})
