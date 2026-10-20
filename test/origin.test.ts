import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { WebServer } from "../src/web/server.ts"

/**
 * The Origin check has to tell "this request came from my own page" apart
 * from "this request came from somewhere else".
 *
 * The subtle part: a browser that reaches the server as "localhost:4096"
 * sends Host: localhost:4096 and Origin: http://localhost:4096. Comparing
 * the Origin against the address the server is bound to (127.0.0.1:4096)
 * calls that a forgery, and every module script load is refused, which
 * leaves the page with no JavaScript at all.
 */

const TOKEN = "c".repeat(64)

/**
 * A raw request. `fetch` refuses to set the Host header, and the Host header
 * is the whole point of this test.
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; type: string | null }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk) => chunks.push(chunk as Buffer))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            type: response.headers["content-type"] ?? null,
          }),
        )
      },
    )
    request.on("error", reject)
    request.end()
  })
}

async function startServer(): Promise<{ base: string; token: string; stop: () => Promise<void> }> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-origin-project-"))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-origin-state-"))
  const config = new ConfigStore(path.join(stateDir, "config.json"))
  const server = new WebServer(config, {
    projectRoot,
    port: 0,
    host: "127.0.0.1",
    token: TOKEN,
  })
  await server.start()
  return {
    base: `http://127.0.0.1:${server.port}`,
    token: TOKEN,
    stop: () => server.stop(),
  }
}

test("a request from the page's own origin is allowed", async () => {
  const { base, stop } = await startServer()
  try {
    const port = Number(new URL(base).port)
    // The page was reached as "localhost", so that is what Host and Origin say.
    const res = await rawGet(port, "/vendor/zustand.js", {
      "x-punani-token": TOKEN,
      host: `localhost:${port}`,
      origin: `http://localhost:${port}`,
    })
    assert.equal(res.status, 200, "the module script must load")
    assert.match(res.type ?? "", /javascript/)
  } finally {
    await stop()
  }
})

test("a request from another site is refused", async () => {
  const { base, stop } = await startServer()
  try {
    const port = Number(new URL(base).port)
    const res = await rawGet(port, "/vendor/zustand.js", {
      "x-punani-token": TOKEN,
      origin: "http://evil.example",
    })
    assert.equal(res.status, 403)
  } finally {
    await stop()
  }
})

test("a request with no origin is allowed", async () => {
  const { base, stop } = await startServer()
  try {
    const res = await fetch(`${base}/vendor/zustand.js`, {
      headers: { "x-punani-token": TOKEN },
    })
    assert.equal(res.status, 200)
  } finally {
    await stop()
  }
})

test("the module script the page imports is actually served", async () => {
  const { base, stop } = await startServer()
  try {
    const page = await fetch(`${base}/`, { headers: { "x-punani-token": TOKEN } })
    assert.equal(page.status, 200)
    const html = await page.text()
    // The importmap points the module script at this file. If it is missing,
    // the page loads and then every button is dead.
    assert.match(html, /"zustand\/vanilla":\s*"\/vendor\/zustand\.js"/)
    const mod = await fetch(`${base}/vendor/zustand.js`, { headers: { "x-punani-token": TOKEN } })
    assert.equal(mod.status, 200)
    assert.match(await mod.text(), /export\s*\{[^}]*createStore/)
  } finally {
    await stop()
  }
})
