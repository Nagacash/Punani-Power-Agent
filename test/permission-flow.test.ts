import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { bashTool } from "../src/tool/bash.ts"
import { editTool, writeTool } from "../src/tool/edit-tools.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * The agent gets on with the work.
 *
 * An ordinary edit, a new file and an ordinary command go through without
 * asking. What can lose work asks. The two halves of a tool have their own
 * action, so the rules can tell them apart.
 */

/** A context that records what was asked for. */
function recorder(): { context: ToolContext; asked: string[] } {
  const asked: string[] = []
  const context: ToolContext = {
    projectRoot: "",
    requestPermission: async (request) => {
      asked.push(request.action)
      return { granted: true }
    },
    notify: () => {},
    previewDiff: () => {},
    mutate: async () => ({ applied: true }),
  }
  return { context, asked }
}

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-ask-"))
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, name), content)
  }
  return root
}

test("a new file goes through, replacing one asks", async () => {
  const root = project({ "there.txt": "old\n" })
  const { context, asked } = recorder()
  context.projectRoot = root

  await writeTool.run({ path: "new.txt", content: "hello\n" }, context)
  assert.deepEqual(asked, ["write"], "a new file is ordinary work")

  await writeTool.run({ path: "there.txt", content: "new\n" }, context)
  assert.deepEqual(asked, ["write", "write-destructive"], "replacing a file can lose work")
})

test("a small edit goes through, a rewrite asks", async () => {
  const many = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n")
  const root = project({ "small.txt": "one\ntwo\nthree\n", "big.txt": many })
  const { context, asked } = recorder()
  context.projectRoot = root

  await editTool.run({ path: "small.txt", oldString: "two", newString: "TWO" }, context)
  assert.deepEqual(asked, ["edit"], "a line here and there is ordinary work")

  await editTool.run(
    { path: "big.txt", oldString: many.split("\n").slice(0, 20).join("\n"), newString: "replaced" },
    context,
  )
  assert.deepEqual(asked, ["edit", "edit-destructive"], "taking a third of a file with it is a rewrite")
})

test("an ordinary command goes through, a destructive one asks", async () => {
  const root = project({ "a.txt": "hello\n" })
  const { context, asked } = recorder()
  context.projectRoot = root

  await bashTool.run({ command: "npm test" }, context)
  await bashTool.run({ command: "grep -r foo ." }, context)
  assert.deepEqual(asked, ["bash", "bash"], "running a command is ordinary work")

  await bashTool.run({ command: "rm -rf build" }, context)
  await bashTool.run({ command: "git push --force origin main" }, context)
  assert.deepEqual(
    asked,
    ["bash", "bash", "bash-destructive", "bash-destructive"],
    "a command that can lose work asks",
  )
})
