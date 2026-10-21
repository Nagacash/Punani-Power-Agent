import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Skills.
 *
 * A skill is a directory holding a `SKILL.md` with a small YAML frontmatter
 * header — the shape the agentskills.io open standard defines. The agent gets
 * an index and pulls the body on demand.
 *
 * The index cannot be flat. A thousand skills cost around fifty thousand tokens
 * of descriptions, which is a quarter of a context window burned before the
 * user types anything. So the index is a table of contents: groups first, then
 * the skills in a group, then the body. The group comes from the skill's own
 * `subdomain` frontmatter when it has one, and from the first word of its name
 * when it does not.
 *
 * Nothing here is a hard dependency, and the frontmatter is parsed leniently:
 * most of the skills on a real machine carry fields the standard does not
 * define, and refusing them would throw away the whole library.
 */

export interface Skill {
  /** The id the agent uses. The directory name, which is unique on disk. */
  name: string
  /** The name from the frontmatter, which is only a label. */
  title: string
  description: string
  /** The `subdomain` field, when the skill has one. */
  group?: string
  /** Every other frontmatter field, kept as-is. */
  metadata: Record<string, string | string[]>
  /** Tools the skill may use without asking, for the turn it is active in. */
  allowedTools: string[]
  /** Situations that mean this skill is the one to load. */
  triggers: string[]
  /** Situations where this skill is the wrong one. */
  antiTriggers: string[]
  /** What the turn has to produce for the work to count as done. */
  requiredReceipts: string[]
  /** When true the model must not load this skill on its own. */
  disableModelInvocation: boolean
  /** Absolute path of the SKILL.md. */
  file: string
  /** The directory holding the skill, for reading its references. */
  dir: string
  /** Which root it was found under. */
  source: string
}

export interface SkillRoot {
  path: string
  source: string
}

/** Where skills are looked for, most specific first. */
export function defaultRoots(projectRoot: string): SkillRoot[] {
  return [
    { path: path.join(projectRoot, ".punani", "skills"), source: "project" },
    { path: path.join(projectRoot, ".agents", "skills"), source: "project" },
    { path: path.join(projectRoot, ".claude", "skills"), source: "project" },
    { path: path.join(os.homedir(), ".agents", "skills"), source: "agent" },
    { path: path.join(os.homedir(), ".claude", "skills"), source: "claude" },
    // Opencode keeps its own skills here. Without this root the agent cannot
    // see the ones that only exist for opencode.
    { path: path.join(os.homedir(), ".config", "opencode", "skills"), source: "opencode" },
  ]
}

/**
 * Read the frontmatter of a markdown file.
 *
 * Only flat `key: value` pairs, which is the whole format these files use.
 * A folded value (`description: >-` and the lines under it) is joined into
 * one line, because that is what the model reads.
 * Unknown keys are kept, not dropped.
 */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  if (!text.startsWith("---")) return {}
  const end = text.indexOf("\n---", 3)
  if (end === -1) return {}
  const out: Record<string, string | string[]> = {}
  let key = ""
  let block = false
  let literal = false
  let list = false
  for (const line of text.slice(3, end).split("\n")) {
    const pair = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (pair) {
      key = pair[1]!.toLowerCase()
      const value = pair[2]!.trim().replace(/^["']|["']$/g, "")
      // A block scalar: the value is the lines that follow.
      if (/^[>|][+-]?$/.test(value)) {
        out[key] = ""
        block = true
        literal = value.startsWith("|")
        continue
      }
      block = false
      list = value === ""
      if (value) out[key] = value
      else if (key) out[key] = []
      continue
    }
    if (!key || !line.trim() || line.trimStart().startsWith("#")) continue
    if (list) {
      // A YAML list: one "- item" per line.
      const item = line.trim().replace(/^-\s*/, "").replace(/^["']|["']$/g, "")
      if (!item) continue
      const current = out[key]
      const list2 = Array.isArray(current) ? current : []
      list2.push(item)
      out[key] = list2
      continue
    }
    if (block) {
      const piece = line.trim()
      out[key] = out[key] ? `${out[key]}${literal ? "\n" : " "}${piece}` : piece
      continue
    }
    // A continuation of a folded value.
    out[key] = `${out[key] ?? ""} ${line.trim()}`.trim()
  }
  return out
}

/** One field of the frontmatter, as plain text. A list takes its first item. */
function asText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value[0]
  return value
}

function parseList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim().replace(/^["']|["']$/g, "")).filter(Boolean)
  }
  if (!value) return []
  return value
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

/** The first paragraph, used when a skill has no description. */
function firstParagraph(text: string): string {
  const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text
  const paragraph = body
    .split("\n\n")
    .map((chunk) => chunk.replace(/^#+\s*/gm, "").trim())
    .find((chunk) => chunk.length > 20)
  return (paragraph ?? "").split("\n")[0]!.slice(0, 240)
}

/** A name the agent can pass back safely. */
function isValidName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/** Find every skill under the roots. Later roots do not override earlier ones. */
export function discoverSkills(roots: SkillRoot[]): Skill[] {
  const skills: Skill[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue
      const dir = path.join(root.path, entry.name)
      // A skill folder is often a symlink to a shared checkout, so the link
      // has to be followed to know whether it is a folder.
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = fs.statSync(dir).isDirectory()
        } catch {
          continue
        }
      }
      if (!isDirectory) continue
      let file = path.join(dir, "SKILL.md")
      if (!fs.existsSync(file)) {
        const lower = path.join(dir, "skill.md")
        if (!fs.existsSync(lower)) continue
        file = lower
      }

      let text: string
      try {
        text = fs.readFileSync(file, "utf8")
      } catch {
        continue
      }

      const meta = parseFrontmatter(text)
      // The directory name is the id. The frontmatter name is only a label, and
      // on a real machine it collides: the same skill is installed under two
      // roots, and different skills share a frontmatter name.
      const name = entry.name.toLowerCase()
      if (!isValidName(name) || seen.has(name)) continue
      seen.add(name)

      const known = new Set([
        "name",
        "description",
        "license",
        "compatibility",
        "metadata",
        "allowed-tools",
        "disable-model-invocation",
        "triggers",
        "anti-triggers",
        "anti_triggers",
        "required-receipts",
        "required_receipts",
        "subdomain",
        "domain",
      ])
      const extra: Record<string, string | string[]> = {}
      for (const [key, value] of Object.entries(meta)) {
        if (!known.has(key)) extra[key] = value
      }

      skills.push({
        name,
        title: asText(meta.name) ?? entry.name,
        description: asText(meta.description) ?? firstParagraph(text),
        group: asText(meta.subdomain) ?? asText(meta.domain),
        metadata: extra,
        allowedTools: parseList(meta["allowed-tools"]),
        triggers: parseList(meta["triggers"]),
        antiTriggers: parseList(meta["anti-triggers"] ?? meta["anti_triggers"]),
        requiredReceipts: parseList(meta["required-receipts"] ?? meta["required_receipts"]),
        disableModelInvocation: meta["disable-model-invocation"] === "true",
        file,
        dir,
        source: root.source,
      })
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

export interface SkillGroup {
  id: string
  count: number
  /** A one-line description of the group, taken from its best member. */
  gist: string
  skills: Skill[]
}

/** Words that are too common to group by. */
const WEAK_TOKENS = new Set([
  "and", "for", "the", "with", "using", "use", "code", "data", "tool", "tools",
  "system", "app", "api", "web", "cli", "build", "make", "get", "set", "run", "dev",
])

/**
 * Group the skills that carry no subdomain of their own.
 *
 * Grouping by the first word of the name scatters the design skills one per
 * group, which puts them out of the index entirely. Grouping by the word the
 * skill *shares* with its siblings puts them together instead: the design
 * skills land on "design", the ones about interfaces on "frontend".
 */
function inferGroups(skills: Skill[]): Map<string, string> {
  const tokens = new Map<string, string[]>()
  for (const skill of skills) {
    const parts = new Set(skill.name.split(/[-_]/).filter((part) => part.length > 2 && !WEAK_TOKENS.has(part)))
    tokens.set(skill.name, [...parts])
  }

  // How many other skills mention each word.
  const counts = new Map<string, number>()
  for (const parts of tokens.values()) {
    for (const part of parts) counts.set(part, (counts.get(part) ?? 0) + 1)
  }

  const assignment = new Map<string, string>()
  for (const [name, parts] of tokens) {
    if (parts.length === 0) {
      assignment.set(name, "other")
      continue
    }
    let best = parts[0]!
    let bestScore = -1
    for (const part of parts) {
      // A word shared by many siblings wins; a longer word is more specific.
      const score = (counts.get(part) ?? 0) * 100 + part.length
      if (score > bestScore) {
        bestScore = score
        best = part
      }
    }
    assignment.set(name, best)
  }
  return assignment
}

/** Group the skills, so the index is a table of contents rather than a wall. */
export function groupSkills(skills: Skill[]): SkillGroup[] {
  const groups = new Map<string, Skill[]>()
  const ungrouped = skills.filter((skill) => !skill.group)
  const inferred = inferGroups(ungrouped)

  for (const skill of skills) {
    const id = skill.group ?? inferred.get(skill.name) ?? "other"
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(skill)
  }
  return [...groups.entries()]
    .map(([id, members]) => ({
      id,
      count: members.length,
      gist: members[0]!.description.replace(/\s+/g, " ").slice(0, 90),
      skills: members.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
}

/**
 * Escape text for an XML-ish envelope.
 *
 * A skill is a file on disk. If its name or description carried a closing
 * tag it could break out of the catalog and impersonate another entry, so the
 * markup is neutralised before it reaches the model.
 */
export function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Make sure a body cannot close the envelope it is delivered in. */
export function neutralizeEnvelopeTags(input: string): string {
  return input
    .replace(/<skill_content/gi, "&lt;skill_content")
    .replace(/<\/skill_content/gi, "&lt;/skill_content")
    .replace(/<available_skills/gi, "&lt;available_skills")
    .replace(/<\/available_skills/gi, "&lt;/available_skills")
}

/** Strip control characters, which some models treat as instructions. */
export function stripControl(input: string): string {
  return input.replace(/[ --]/g, "")
}

/**
 * A group needs a few members to be worth a line in the index. The leftovers
 * are one skill each, and naming a group after a single skill is just the
 * skill's name with a count on it.
 */
const MIN_GROUP_SIZE = 3

/** The tier-zero index: the groups, not the skills. */
export function renderGroupIndex(groups: SkillGroup[]): string {
  const big = groups.filter((group) => group.count >= MIN_GROUP_SIZE)
  const small = groups.filter((group) => group.count < MIN_GROUP_SIZE)
  if (groups.length === 0) return ""

  const lines = [
    "You have access to a library of skills: folders of instructions for specific tasks.",
    "",
    "Start from a group. Call `skill_list` with a group id to see that group's skills,",
    "call `skill_search` to look for one by name or keyword, and call `skill_load` to read",
    "a skill in full before doing that kind of work.",
    "",
    "<available_skill_groups>",
  ]
  for (const group of big) {
    lines.push(
      `  <group id="${xmlEscape(group.id)}" count="${group.count}">${xmlEscape(stripControl(group.gist).slice(0, 80))}</group>`,
    )
  }
  lines.push("</available_skill_groups>")
  if (small.length > 0) {
    // The leftovers are listed by name only. A name is enough to load one, and
    // it costs a fraction of a description.
    const names = small.flatMap((group) => group.skills.map((skill) => skill.name)).sort()
    lines.push("")
    lines.push(
      `These ${names.length} skill(s) are in groups too small to list. Load one by name with skill_load:`,
    )
    lines.push(names.map((name) => `  ${xmlEscape(name)}`).join(" "))
  }
  return lines.join("\n")
}

/** The tier-one index: the skills inside one group. */
export function renderSkillEntries(skills: Skill[]): string {
  if (skills.length === 0) return ""
  const lines = ["<available_skills>"]
  for (const skill of skills) {
    lines.push("  <skill>")
    lines.push(`    <name>${xmlEscape(skill.name)}</name>`)
    if (skill.title && skill.title !== skill.name) {
      lines.push(`    <title>${xmlEscape(stripControl(skill.title))}</title>`)
    }
    lines.push(`    <description>${xmlEscape(stripControl(skill.description))}</description>`)
    lines.push("  </skill>")
  }
  lines.push("</available_skills>")
  return lines.join("\n")
}
