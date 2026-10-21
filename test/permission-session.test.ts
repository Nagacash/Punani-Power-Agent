import assert from "node:assert/strict"
import { test } from "node:test"
import { PermissionEngine, resolvePermission } from "../src/agent/permission.ts"

test("remember applies when patterns are returned (web Always path)", async () => {
  const engine = new PermissionEngine({
    "bash-destructive": [{ pattern: "*", effect: "ask" }],
  })
  const request = {
    action: "bash-destructive",
    resource: "rm -rf build",
    summary: "Run: rm -rf build",
    alwaysPatterns: ["rm -rf build"],
    destructive: true,
  }
  const outcome = await resolvePermission(engine, request, async () => ({
    granted: true,
    remember: true,
    patterns: request.alwaysPatterns,
  }))
  assert.equal(outcome.granted, true)
  assert.equal(engine.decide("bash-destructive", "rm -rf build").effect, "allow")
  assert.equal(engine.decide("bash-destructive", "rm -rf other").effect, "ask")
})

test("remember does not widen to a different action", async () => {
  const engine = new PermissionEngine({
    bash: [{ pattern: "*", effect: "ask" }],
    "bash-destructive": [{ pattern: "*", effect: "ask" }],
  })
  const request = {
    action: "bash",
    resource: "npm test",
    summary: "Run: npm test",
    alwaysPatterns: ["npm test"],
  }
  await resolvePermission(engine, request, async () => ({
    granted: true,
    remember: true,
    patterns: ["npm test"],
  }))
  assert.equal(engine.decide("bash", "npm test").effect, "allow")
  assert.equal(engine.decide("bash-destructive", "rm -rf build").effect, "ask")
})
