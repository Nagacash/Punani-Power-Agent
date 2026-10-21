import fs from "node:fs"
import path from "node:path"
import { paths } from "../core/paths.js"
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
  options: { userRoutes?: boolean } = {},
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
  for (const file of files) {
    for (const route of loadRoutesFile(file, known)) add(route)
  }
  for (const route of routesFromSkills(skills)) {
    // A route file entry for the same skill wins.
    if (routes.some((existing) => existing.skill === route.skill)) continue
    add(route)
  }
  return routes
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
    const not = route.antiTriggers.length > 0 ? ` Not for ${route.antiTriggers.join(", ")}.` : ""
    lines.push(`- When ${route.when}, load the \`${route.skill}\` skill.${not}`)
  }
  if (routes.length > limit) {
    lines.push(`- ${routes.length - limit} more route(s) are not shown. Use skill_search to find them.`)
  }
  return lines.join("\n")
}
