import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { plainText } from "../src/agent/plain.ts"

/**
 * Replies are read as plain text, so markdown syntax would show up as its own
 * syntax. Two copies of the cleanup exist: one in TypeScript for the
 * terminal, one inside the page for the browser. The browser copy is pulled
 * out of the shipped file and run here, so the page is tested as it ships.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.join(HERE, "..", "src", "web", "ui.html")

/** The browser's own copy, taken from the file that is served. */
function browserPlain(): (text: string) => string {
  const html = fs.readFileSync(UI, "utf8")
  const start = html.indexOf("function plain(text) {")
  assert.ok(start !== -1, "ui.html must have a plain() function")
  // Take the function and everything up to its closing brace.
  let depth = 0
  let end = start
  for (let i = html.indexOf("{", start); i < html.length; i++) {
    if (html[i] === "{") depth++
    else if (html[i] === "}") {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  const source = html.slice(start, end)
  return new Function(`${source}; return plain;`)() as (text: string) => string
}

const CASES: Array<{ name: string; input: string; expect: string }> = [
  {
    name: "bold markers go, the words stay",
    input: "**Done** and *also* this",
    expect: "Done and also this",
  },
  {
    name: "headings lose their hashes",
    input: "# Title\n\nSome text",
    expect: "Title\n\nSome text",
  },
  {
    name: "code fences go, the code stays",
    input: "Here:\n```js\nconst x = 1\n```\nDone",
    expect: "Here:\nconst x = 1\nDone",
  },
  {
    name: "inline code keeps its text",
    input: "Run `npm test` first",
    expect: "Run npm test first",
  },
  {
    name: "bullets become plain bullets",
    input: "- one\n- two",
    expect: "• one\n• two",
  },
  {
    name: "links keep the label and the target",
    input: "See [the docs](https://example.com).",
    expect: "See the docs (https://example.com).",
  },
  {
    name: "a command keeps the asterisks that are part of it",
    input: "Run `grep '*error*' log.txt` to find it",
    expect: "Run grep '*error*' log.txt to find it",
  },
  {
    name: "a horizontal rule does not eat the rest of the reply",
    input: "Before\n---\nAfter the rule",
    expect: "Before\n\nAfter the rule",
  },
  {
    name: "a diff header is not mistaken for a rule",
    input: "--- a/src/index.ts\n+++ b/src/index.ts",
    expect: "--- a/src/index.ts\n+++ b/src/index.ts",
  },
  {
    name: "an image keeps its alt text, not a link",
    input: "![a diagram](https://example.com/a.png)",
    expect: "a diagram",
  },
  {
    name: "plain text is left alone",
    input: "Everything is fine. The server is on port 3000.",
    expect: "Everything is fine. The server is on port 3000.",
  },
]

test("the terminal copy reads as plain text", () => {
  for (const { name, input, expect } of CASES) {
    assert.equal(plainText(input), expect, name)
  }
})

test("the browser copy reads as plain text", () => {
  const plain = browserPlain()
  for (const { name, input, expect } of CASES) {
    assert.equal(plain(input), expect, name)
  }
})

test("both copies agree", () => {
  const plain = browserPlain()
  const samples = [
    "**bold** and `code`",
    "# heading\n- a\n- b",
    "```\nblock\n```",
    "plain",
    "[link](http://x)",
  ]
  for (const sample of samples) {
    assert.equal(plain(sample), plainText(sample), `they disagree on: ${sample}`)
  }
})
