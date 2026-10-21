import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { paths } from "../core/paths.js"
import { xmlEscape } from "./loader.js"
import type { Skill } from "./loader.js"

/**
 * The routing table.
 *
 * With a thousand skills, listing them all in the prompt is how the wrong one
 * gets loaded: the model sees 124 groups and picks by keyword. A route says
 * outright which skill answers which situation, in a line it can act on:
 *
 *   when: the user wants a security review -> naga-review
 *
 * Routes come from two places: the `triggers` a skill declares in its own
 * frontmatter, and a routes file the project or the user keeps. The file wins,
 * because it is the one a person edits.
 */

export interface Route {
  /** The situation that makes this route true. */
  when: string
  /** The skill to load. */
  skill: string
  /** Where the route came from: "skill" or the file it was read from. */
  source: string
  /** Situations where this skill is the wrong one. */
  antiTriggers: string[]
}

/** The project routes file, when there is one. */
export function projectRoutesFile(projectRoot: string): string {
  return path.join(projectRoot, ".punani", "routes.md")
}

/** The user routes file, when there is one. */
export function userRoutesFile(): string {
  return path.join(paths.configDir, "routes.md")
}

/**
 * The routes file that ships with the app.
 *
 * It points at the skills a coding agent needs: a browser to look at a page,
 * and a way to understand an app that was shipped as a binary. A route that
 * names a skill the machine does not have is skipped, so a route never
 * points at nothing.
 */
export function bundledRoutesFile(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.join(here, "..", "bundled", "routes.md"),
    path.join(here, "..", "..", "bundled", "routes.md"),
    path.join(path.dirname(process.execPath), "bundled", "routes.md"),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Read a routes file.
 *
 * The format is one route per line:
 *
 *   when: the user wants a security review -> naga-review
 *
 * A line without a skill, or with an unknown skill, is skipped.
 */
export function parseRoutes(text: string, source: string, known: Set<string>): Route[] {
  const routes: Route[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const match = trimmed.match(/^when:\s*(.+?)\s*->\s*([A-Za-z0-9._-]+)\s*$/)
    if (!match) continue
    const skill = match[2]!.toLowerCase()
    if (known.size > 0 && !known.has(skill)) continue
    routes.push({ when: match[1]!.trim(), skill, source, antiTriggers: [] })
  }
  return routes
}

/** Read a routes file from disk, if it is there. */
export function loadRoutesFile(file: string, known: Set<string>): Route[] {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return []
  }
  return parseRoutes(text, file, known)
}

/** Every route a skill declares in its own frontmatter. */
export function routesFromSkills(skills: Skill[]): Route[] {
  const routes: Route[] = []
  for (const skill of skills) {
    for (const when of skill.triggers) {
      routes.push({ when, skill: skill.name, source: "skill", antiTriggers: skill.antiTriggers })
    }
  }
  return routes
}

/**
 * The routing table for a project: the routes files first, then the skills
 * that declare their own triggers. A route named twice keeps the first.
 */
export function buildRoutes(
  projectRoot: string,
  skills: Skill[],
  options: { userRoutes?: boolean; bundledRoutes?: boolean } = {},
): Route[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const known = new Set(byName.keys())
  const routes: Route[] = []
  const seen = new Set<string>()

  const add = (route: Route): void => {
    const key = `${route.when.toLowerCase()}::${route.skill}`
    if (seen.has(key)) return
    seen.add(key)
    // A route keeps what the skill itself says about when not to use it.
    const skill = byName.get(route.skill)
    routes.push({
      ...route,
      antiTriggers: route.antiTriggers.length > 0 ? route.antiTriggers : (skill?.antiTriggers ?? []),
    })
  }

  const files = [projectRoutesFile(projectRoot)]
  if (options.userRoutes !== false) files.push(userRoutesFile())
  // The routes that ship with the app come last, so a project can replace
  // any of them.
  const bundled = bundledRoutesFile()
  if (bundled && options.bundledRoutes !== false) files.push(bundled)
  for (const file of files) {
    for (const route of loadRoutesFile(file, known)) add(route)
  }
  for (const route of routesFromSkills(skills)) {
    // A route file entry for the same skill wins over the skill's own.
    if (routes.some((existing) => existing.skill === route.skill && existing.source !== "skill")) continue
    add(route)
  }
  return routes
}

/** One line, so a route cannot end the line it is on. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * The routing table, as text for the system prompt.
 *
 * The table competes with the model's own output for the context, so it is
 * capped. Skills without a route are still reachable through `skill_search`.
 */
export function renderRoutes(routes: Route[], limit = 60): string {
  if (routes.length === 0) return ""
  const lines = ["Routing. Load one skill, and only one:"]
  for (const route of routes.slice(0, limit)) {
    // A route is text from a skill's own frontmatter. It goes into the
    // system prompt, so it is escaped and put on one line: a skill cannot
    // write a line of its own into the prompt.
    const not =
      route.antiTriggers.length > 0 ? ` Not for ${xmlEscape(route.antiTriggers.join(", "))}.` : ""
    lines.push(`- When ${xmlEscape(oneLine(route.when))}, load the \`${xmlEscape(route.skill)}\` skill.${not}`)
  }
  if (routes.length > limit) {
    lines.push(`- ${routes.length - limit} more route(s) are not shown. Use skill_search to find them.`)
  }
  return lines.join("\n")
}
