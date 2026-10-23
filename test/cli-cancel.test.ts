import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { ConfigStore } from "../src/config/store.ts"

/**
 * Ctrl+C stops a running command in the terminal.
 *
 * The turn waits for the tool, so a command that cannot be ended hangs the
 * turn for ever: the app sits there, the command keeps running, and Ctrl+C
 * does nothing. This drives the real CLI against a mock provider, so the
 * whole path is covered: the key press, the abort signal, the tool, and the
 * command that has to die.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, "..")
const CLI = path.join(ROOT, "src", "main.ts")

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Start a mock provider that asks for one bash call and then answers. */
async function startMockProvider(command: string): Promise<{
  url: string
  close: () => Promise<void>
  toolRequested: () => boolean
}> {
  let asked = false
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "mock-bash",
                name: "Mock Bash",
                context_window: 32_000,
                supported_parameters: ["tools"],
              },
            ],
          }),
        )
        return
      }
      if (request.url === "/v1/chat/completions") {
        const hasToolResult = (body.messages ?? []).some((message: any) => message.role === "tool")
        if (!hasToolResult) {
          asked = true
          response.writeHead(200, { "content-type": "application/json" })
          response.end(
            JSON.stringify({
              model: "mock-bash",
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [
                      {
                        id: "call_1",
                        type: "function",
                        function: {
                          name: "bash",
                          arguments: JSON.stringify({ command }),
                        },
                      },
                    ],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
          )
          return
        }
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            model: "mock-bash",
            choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
          }),
        )
        return
      }
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "not found" } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("server did not bind")
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    toolRequested: () => asked,
  }
}

/** Is a process with this marker still running? */
function stillRunning(marker: string): boolean {
  try {
    // The command writes its own pid, so the test can look for it directly.
    const pid = Number(fs.readFileSync(marker, "utf8").trim())
    if (!Number.isFinite(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("Ctrl+C ends the running command and the turn finishes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "punani-cli-cancel-"))
  const projectRoot = path.join(home, "project")
  fs.mkdirSync(projectRoot, { recursive: true })
  const marker = path.join(projectRoot, "command.pid")

  // The command records its own pid, so the test can tell whether it died.
  // tee, not a redirect: a redirect is a destructive command and would stop
  // the turn at the permission prompt instead of running.
  const command = `echo $$ | tee "${marker}"; sleep 45`

  const mock = await startMockProvider(command)

  const configFile = path.join(home, "config.json")
  const config = new ConfigStore(configFile)
  config.setProvider({
    id: "mock",
    kind: "openai-compatible",
    name: "Mock",
    baseURL: mock.url,
    defaultContextWindow: 32_000,
  })
  config.setApiKey("mock", "mock-secret-value-123456")
  config.setDefaultModel("mock/mock-bash")

  // Node runs the CLI itself. A wrapper such as npx would sit between the
  // test and the app, and the signal would stop at the wrapper.
  //
  // The cwd is the checkout, so the tsx loader resolves. The project is
  // chosen with -C, and the commands run there.
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", CLI, "-C", projectRoot, "-m", "mock/mock-bash"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        PUNANI_CONFIG: configFile,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )

  let output = ""
  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
  })
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8")
  })

  try {
    // Hand it the question. The turn starts and asks for the bash call.
    child.stdin?.write("run the sleep command\n")

    // Wait for the command to be running.
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (fs.existsSync(marker) && mock.toolRequested()) break
      await sleep(100)
    }
    assert.ok(fs.existsSync(marker), `the command never started. Output:\n${output}`)
    assert.ok(stillRunning(marker), "the command was not running")

    // This is Ctrl+C. It arrives as a signal, because the input is a pipe
    // and not a terminal.
    child.kill("SIGINT")

    // The turn has to end. Before the fix it waited for the sleep for ever,
    // so this never appeared.
    const ended = Date.now() + 20_000
    while (Date.now() < ended && !/stopped/i.test(output)) {
      await sleep(100)
    }
    assert.match(output, /the turn was stopped/i, `the turn did not end. Output:\n${output}`)
    assert.match(output, /stopped/i, `the turn did not report that it stopped. Output:\n${output}`)

    // And the command itself has to be gone, not just the shell that ran it.
    await sleep(500)
    assert.equal(stillRunning(marker), false, "the command was still running after the interrupt")
  } finally {
    child.kill("SIGKILL")
    await mock.close()
  }
})
