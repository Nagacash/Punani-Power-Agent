import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { bundledRoot, defaultRoots, discoverSkills } from "../src/skills/loader.ts"
import { buildRoutes, bundledRoutesFile, parseRoutes } from "../src/skills/routing.ts"
import { KNOWN_MCP_SERVERS } from "../src/mcp/client.ts"

/**
 * The skills and the routes that ship with the app.
 *
 * The app carries a browser skill and the REA skill, and a routes file that
 * points at them. The routes file also points at the browser-use skill,
 * which lives on the machine rather than in the app, so a route has to be
 * able to name a skill it does not ship.
 */

test("the bundled skills are found", () => {
  const root = bundledRoot()
  assert.ok(root, "the app should carry its own skills")
  assert.equal(root.source, "punani")

  const skills = discoverSkills([root])
  const names = skills.map((skill) => skill.name)
  assert.ok(names.includes("browser"), "the browser skill should ship")
  assert.ok(names.includes("reverse-engineer-anything"), "the REA skill should ship")
})

test("the bundled skills come last, so a project can replace them", () => {
  const roots = defaultRoots("/tmp/project")
  const last = roots[roots.length - 1]!
  assert.equal(last.source, "punani")
  assert.equal(roots[0]!.source, "project")
})

test("the routes that ship with the app point at the browser and at REA", () => {
  const file = bundledRoutesFile()
  assert.ok(file, "the app should carry a routes file")
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /-> browser-use/)
  assert.match(text, /-> reverse-engineer-anything/)
})

test("a route for a skill the machine does not have is skipped", () => {
  const file = bundledRoutesFile()!
  const text = fs.readFileSync(file, "utf8")
  // A machine without the browser-use skill.
  const without = parseRoutes(text, file, new Set(["reverse-engineer-anything"]))
  assert.ok(without.every((route) => route.skill !== "browser-use"))
  assert.ok(without.some((route) => route.skill === "reverse-engineer-anything"))
})

test("the routing table reaches the browser skill and the REA skill", () => {
  const skills = discoverSkills(defaultRoots("/tmp/project"))
  const routes = buildRoutes("/tmp/project", skills)
  const named = (skill: string): boolean => routes.some((route) => route.skill === skill)
  assert.ok(named("browser"), "the browser skill should be routed to")
  assert.ok(named("reverse-engineer-anything"), "the REA skill should be routed to")
})

test("the REA server is one the app knows how to start", () => {
  const rea = KNOWN_MCP_SERVERS.rea
  assert.ok(rea, "rea should be a known MCP server")
  assert.equal(rea.command, "npx")
  assert.ok(rea.args?.some((arg) => arg.includes("rea-agents")), "it should run rea-agents")
  assert.ok(rea.args?.includes("mcp"), "it should run the MCP server")
})

test("the REA skill says where the tools come from", () => {
  const root = bundledRoot()
  assert.ok(root)
  const file = path.join(root.path, "reverse-engineer-anything", "SKILL.md")
  const text = fs.readFileSync(file, "utf8")
  assert.match(text, /\/mcp add rea/, "the skill should say how to get the tools")
  assert.match(text, /morluto\/rea/, "the skill should say where it came from")
})
