import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"
import { devTool, stopDevServers } from "../src/tool/dev.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * The plain bash tool kills a command when it times out, which kills a dev
 * server the moment the tool returns. The dev tool detaches it instead, finds
 * the port it actually bound, and points the preview at it.
 */

/** A project whose dev script serves a port. */
function makeProject(port: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-dev-project-"))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "dev-fixture",
      private: true,
      scripts: {
        dev: `node -e "require('http').createServer((q,s)=>{console.log('ready on http://localhost:${port}');s.end('ok')}).listen(${port},'127.0.0.1')"`,
      },
    }),
  )
  return root
}

function context(projectRoot: string, onPreview: (url: string) => void): ToolContext {
  return {
    projectRoot,
    requestPermission: async () => ({ granted: true }),
    notify: () => {},
    previewDiff: () => {},
    mutate: async () => ({ applied: true }),
    setPreview: onPreview,
  }
}

after(() => {
  stopDevServers()
  // The servers the tool started run in their own process group. Kill the
  // groups, so the test run leaves nothing behind to hold the runner open.
  for (const pid of strayGroups) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
})

/** Process groups the tool started, so the test can clean up after itself. */
const strayGroups: number[] = []

test("the dev server stays up and the preview points at it", async () => {
  const port = 4391
  const projectRoot = makeProject(port)
  let preview = ""
  const result = await devTool.run({ command: "npm run dev" }, context(projectRoot, (url) => (preview = url)))

  assert.ok(!result.isError, `the dev tool failed: ${result.output}`)
  const pid = Number(/\(pid (\d+)\)/.exec(result.output)?.[1] ?? 0)
  if (pid) strayGroups.push(pid)
  assert.equal(preview, `http://localhost:${port}`, "the preview must point at the port that answered")

  // The point of the tool: the server is still up after the call returns.
  const body = await new Promise<string>((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk as Buffer))
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    })
    request.on("error", reject)
    request.on("timeout", () => {
      request.destroy()
      reject(new Error("timed out"))
    })
  })
  assert.equal(body, "ok")
})

test("the dev server is stopped on request", async () => {
  const port = 4392
  const projectRoot = makeProject(port)
  const started = await devTool.run({ command: "npm run dev" }, context(projectRoot, () => {}))
  const pid = Number(/\(pid (\d+)\)/.exec(started.output)?.[1] ?? 0)
  if (pid) strayGroups.push(pid)
  assert.ok(await new Promise((resolve) => {
    const socket = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, () => resolve(true))
    socket.on("error", () => resolve(false))
  }))

  const result = await devTool.run({ stop: true }, context(projectRoot, () => {}))
  assert.match(result.output, /Stopped/)

  // Give it a moment to actually go away.
  await new Promise((resolve) => setTimeout(resolve, 800))
  const stillUp = await new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, () => resolve(true))
    request.on("error", () => resolve(false))
  })
  assert.equal(stillUp, false, "the server must be gone")
})

test("a command that never serves anything reports the log instead of hanging", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-dev-dead-"))
  const result = await devTool.run(
    { command: "sleep 30", timeout: 1500 },
    context(projectRoot, () => {}),
  )
  const pid = Number(/\(pid (\d+)\)/.exec(result.output)?.[1] ?? 0)
  if (pid) strayGroups.push(pid)
  assert.ok(result.isError, "this should be reported as a failure")
  assert.match(result.output, /Log:/)
  assert.ok(fs.existsSync(path.join(projectRoot, ".punani", "dev.log")), "the log must exist")
})
