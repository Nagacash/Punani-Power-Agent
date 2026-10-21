import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { makeCompleter } from "../src/cli/repl.ts"

/**
 * What the terminal completes.
 *
 * A line that starts with a slash is a command. A line with an at sign names
 * a file. Everything else is left to the model.
 */

const commands = ["/help", "/models", "/model", "/skill", "/exit"]

test("a slash line completes to a command", () => {
  const complete = makeCompleter({ commands })
  const [matches, line] = complete("/mo")
  assert.deepEqual(matches, ["/models", "/model"])
  assert.equal(line, "/mo")
})

test("a slash line that matches nothing completes to nothing", () => {
  const complete = makeCompleter({ commands })
  assert.deepEqual(complete("/zzz")[0], [])
})

test("an at sign completes to a file in the project", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-complete-"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src", "greet.ts"), "")
  fs.writeFileSync(path.join(root, "readme.md"), "")
  fs.writeFileSync(path.join(root, ".hidden"), "")

  const complete = makeCompleter({ commands, projectRoot: root })
  const [matches] = complete("@")
  assert.ok(matches.includes("@readme.md"))
  assert.ok(!matches.includes("@.hidden"), "hidden files are not offered")
})

test("an at sign completes inside a folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-complete2-"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(path.join(root, "src", "greet.ts"), "")
  fs.writeFileSync(path.join(root, "src", "index.ts"), "")

  const complete = makeCompleter({ commands, projectRoot: root })
  const [matches] = complete("@src/g")
  assert.deepEqual(matches, ["@src/greet.ts"])
})

test("a line that is neither is left alone", () => {
  const complete = makeCompleter({ commands, projectRoot: "/tmp" })
  assert.deepEqual(complete("add a --loud flag")[0], [])
})
