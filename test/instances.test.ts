import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { paths } from "../src/core/paths.js"
import {
  listWebInstances,
  nextTaskLabel,
  pruneWebInstances,
  registerWebInstance,
  unregisterWebInstance,
} from "../src/web/instances.js"

test("web instance registry tracks task windows", () => {
  const registry = path.join(paths.dataDir, "web-instances.json")
  const backup = fs.existsSync(registry) ? fs.readFileSync(registry, "utf8") : null
  try {
    fs.mkdirSync(paths.dataDir, { recursive: true })
    fs.writeFileSync(registry, "[]")
    const project = path.join(os.tmpdir(), "punani-task-test")
    registerWebInstance({
      host: "127.0.0.1",
      port: 4096,
      projectRoot: project,
      pid: process.pid,
      label: "Task 1",
      started: Date.now(),
    })
    assert.equal(listWebInstances(project).length, 1)
    assert.equal(nextTaskLabel(project), "Task 2")
    unregisterWebInstance("127.0.0.1", 4096)
    assert.equal(listWebInstances(project).length, 0)
    pruneWebInstances()
  } finally {
    if (backup === null) fs.rmSync(registry, { force: true })
    else fs.writeFileSync(registry, backup)
  }
})
