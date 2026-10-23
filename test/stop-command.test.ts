import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { bashTool } from "../src/tool/bash.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * A command that is running can be stopped.
 *
 * The turn waits for a tool. If a running command cannot be ended, the turn
 * waits for ever, and Ctrl+C does nothing: the turn hangs with the command
 * still running. So the command has to end when the turn is cancelled, and
 * everything the command started has to end with it.
 */

function context(projectRoot: string, signal?: AbortSignal): ToolContext {
  return {
    projectRoot,
    signal,
    requestPermission: async () => ({ granted: true }),
    notify: () => {},
    previewDiff: () => {},
    mutate: async () => ({ applied: true }),
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test("a cancelled turn ends the running command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-bash-abort-"))
  const controller = new AbortController()
  const started = Date.now()

  const running = bashTool.run({ command: "sleep 30" }, context(root, controller.signal))
  // Give the shell a moment to actually be running before it is cancelled.
  await sleep(300)
  controller.abort()

  const result = await running
  const elapsed = Date.now() - started

  // It came back, and it came back fast. Before the fix this never resolved.
  assert.equal(result.stop, true)
  assert.equal(result.isError, true)
  assert.match(result.output, /the turn was stopped/)
  assert.ok(elapsed < 10_000, `the command took ${elapsed}ms to stop`)
})

test("cancelling ends the children the command started, not just the shell", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-bash-tree-"))
  const marker = path.join(root, "grandchild.pid")
  const controller = new AbortController()

  // The shell starts a child of its own, writes that child's pid, and waits.
  // The test looks for the pid rather than for a side effect, because a
  // survivor that writes its marker slowly would not be noticed in time.
  const running = bashTool.run(
    { command: `sh -c 'sleep 30' & echo $! | tee "${marker}"; wait` },
    context(root, controller.signal),
  )

  // Wait for the pid to be written.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && !fs.existsSync(marker)) {
    await sleep(50)
  }
  assert.ok(fs.existsSync(marker), "the child never started")
  const pid = Number(fs.readFileSync(marker, "utf8").trim())
  assert.ok(Number.isFinite(pid) && pid > 0, "the child pid was not written")

  // The child is running now.
  assert.doesNotThrow(() => process.kill(pid, 0), "the child was not running")

  controller.abort()
  await running

  // And it is gone. The pid is checked directly, so a survivor cannot pass
  // by being slow to write a marker.
  await sleep(300)
  assert.throws(
    () => process.kill(pid, 0),
    /ESRCH/,
    "the child of the command kept running after the turn was stopped",
  )
})

test("a command that is cancelled before it starts never runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-bash-pre-"))
  const marker = path.join(root, "ran.txt")
  const controller = new AbortController()
  controller.abort()

  const result = await bashTool.run({ command: `echo ran > "${marker}"` }, context(root, controller.signal))

  assert.equal(result.stop, true)
  assert.equal(fs.existsSync(marker), false, "the command ran even though the turn was over")
})

test("a command that finishes on its own is not a failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-bash-ok-"))
  const result = await bashTool.run({ command: "echo hello" }, context(root))
  assert.equal(result.isError, false)
  assert.notEqual(result.stop, true)
  assert.match(result.output, /hello/)
  assert.match(result.output, /exit code 0/)
})
