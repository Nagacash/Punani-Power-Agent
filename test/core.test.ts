import assert from "node:assert/strict"
import { test } from "node:test"
import { diffLines, diffStats, toUnifiedDiff } from "../src/tool/diff.ts"
import { matchesPattern } from "../src/agent/permission.ts"
import { globToRegex, parseIgnoreFile } from "../src/tool/fsutil.ts"
import { redact } from "../src/core/redact.ts"
import { classifyHttpError } from "../src/llm/errors.ts"
import { estimateCost, formatCost, modelKey, parseModelKey } from "../src/provider/types.ts"

test("diffLines marks added and removed lines", () => {
  const { lines, additions, deletions } = diffLines("a\nb\nc", "a\nB\nc")
  assert.equal(additions, 1)
  assert.equal(deletions, 1)
  assert.equal(lines.filter((l) => l.kind === "context").length, 2)
})

test("diffLines reports no change for identical text", () => {
  const { additions, deletions } = diffStats("same\ntext", "same\ntext")
  assert.equal(additions, 0)
  assert.equal(deletions, 0)
})

test("toUnifiedDiff emits a unified header and hunk", () => {
  const patch = toUnifiedDiff("src/a.ts", "one\ntwo\n", "one\nTWO\n")
  assert.match(patch, /^--- a\/src\/a\.ts/)
  assert.match(patch, /\+\+\+ b\/src\/a\.ts/)
  assert.match(patch, /@@/)
  assert.match(patch, /-two/)
  assert.match(patch, /\+TWO/)
})

test("permission patterns: exact, wildcard and bare word", () => {
  assert.equal(matchesPattern("*", "anything at all"), true)
  assert.equal(matchesPattern("git *", "git status --short"), true)
  assert.equal(matchesPattern("git *", "git"), false)
  assert.equal(matchesPattern("git", "git"), true)
  assert.equal(matchesPattern("grep ?", "grep x"), true)
  assert.equal(matchesPattern("grep ?", "grep xy"), false)
})

test("ignore file parsing handles negation and directory rules", () => {
  const rules = parseIgnoreFile("node_modules/\n*.log\n!keep.log\n")
  assert.equal(rules.length, 3)
  assert.equal(rules[0]!.negated, false)
  assert.equal(rules[0]!.directoryOnly, true)
  assert.equal(rules[2]!.negated, true)
})

test("globToRegex handles ** and single star", () => {
  const anyDepth = globToRegex("src/**/*.ts")
  assert.equal(anyDepth.test("src/a/b/c.ts"), true)
  const sameDir = globToRegex("src/*.ts")
  assert.equal(sameDir.test("src/a.ts"), true)
  assert.equal(sameDir.test("src/a/b.ts"), false)
})

test("redact scrubs api keys and bearer tokens", () => {
  const text = "key=sk-abcdefghijklmnopqrstuvwxyz and Authorization: Bearer abcdefghijklmnop"
  const out = redact(text)
  assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwxyz"))
  assert.ok(!out.includes("abcdefghijklmnop"))
})

test("http errors classify into actionable kinds", () => {
  const auth = classifyHttpError({ status: 401, body: "bad key", providerID: "p", modelID: "m" })
  assert.equal(auth.kind, "auth")

  const rate = classifyHttpError({ status: 429, body: "rate limit exceeded", providerID: "p", modelID: "m" })
  assert.equal(rate.kind, "rate_limit")

  const quota = classifyHttpError({ status: 429, body: "insufficient_quota", providerID: "p", modelID: "m" })
  assert.equal(quota.kind, "quota")

  const tools = classifyHttpError({
    status: 400,
    body: "this model does not support tools",
    providerID: "p",
    modelID: "m",
  })
  assert.equal(tools.kind, "no_tool_support")

  const missing = classifyHttpError({ status: 404, body: "model not found", providerID: "p", modelID: "m" })
  assert.equal(missing.kind, "model_not_found")

  const context = classifyHttpError({
    status: 400,
    body: "maximum context length is 8192 tokens",
    providerID: "p",
    modelID: "m",
  })
  assert.equal(context.kind, "context_length")
})

test("model keys round trip", () => {
  assert.equal(modelKey({ providerID: "ollama", modelID: "llama3" }), "ollama/llama3")
  assert.deepEqual(parseModelKey("ollama/llama3"), { providerID: "ollama", modelID: "llama3" })
  assert.equal(parseModelKey("nope"), undefined)
})

test("cost estimation and formatting", () => {
  const cost = { input: 3, output: 15, currency: "USD" }
  const value = estimateCost(cost, 1_000_000, 1_000_000)
  assert.equal(value, 18)
  assert.equal(formatCost({ input: 0, output: 0, currency: "USD" }), "free")
})
