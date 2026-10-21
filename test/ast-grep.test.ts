import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { astGrepTool, isAstGrepAvailable } from "../src/tool/ast-grep.ts"
import { BUILTIN_TOOLS, buildTools } from "../src/tool/registry.ts"
import type { ToolContext } from "../src/tool/types.ts"

/**
 * Structural search.
 *
 * The tool is only offered when the binary is on the path, so the model is
 * never told about a tool that cannot run.
 */

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-astgrep-"))
  fs.writeFileSync(path.join(root, "app.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")
  return root
}

const context = (root: string): ToolContext => ({
  projectRoot: root,
  requestPermission: async () => ({ granted: true }),
  notify: () => {},
  previewDiff: () => {},
  mutate: async () => ({ applied: true }),
})

test("the tool is only there when the binary is", () => {
  const available = isAstGrepAvailable()
  const offered = BUILTIN_TOOLS.some((tool) => tool.name === "astgrep")
  assert.equal(offered, available, "the tool and the binary must agree")
  assert.equal(
    buildTools().some((tool) => tool.name === "astgrep"),
    available,
  )
})

test("a pattern is required", async () => {
  const root = project()
  await assert.rejects(
    () => astGrepTool.run({ pattern: "  " }, context(root)),
    /pattern is required/,
  )
})

test("the search says what it found, or that it could not run", async () => {
  const root = project()
  const result = await astGrepTool.run({ pattern: "function $NAME($$$)" }, context(root))
  if (isAstGrepAvailable()) {
    assert.doesNotMatch(result.output, /not installed/)
    assert.match(result.output, /app\.ts/)
  } else {
    assert.match(result.output, /ast-grep is not installed/)
    assert.equal(result.isError, true)
  }
})
