import type { Skill } from "./loader.js"

/**
 * Finding a skill by name or keyword.
 *
 * The library holds close to a thousand skills, so the agent cannot read them
 * all. This scores them instead: the words of the query against the name, the
 * description and the metadata, with a bonus when the name starts with the
 * query.
 */

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "was", "not",
  "from", "into", "when", "how", "what", "why", "can", "will", "should", "would",
  "make", "build", "create", "add", "use", "using", "get", "set", "run", "code",
])

function terms(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z0-9+#.-]+/)) {
    if (word.length < 3 || STOP.has(word)) continue
    out.add(word)
  }
  return out
}

/** Score every skill against the query, and return the best ones. */
export function searchSkills(skills: Skill[], query: string, limit = 10): Skill[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  const words = terms(trimmed)
  const needle = trimmed.toLowerCase()

  const scored = skills
    .map((skill) => {
      const meta = Object.values(skill.metadata)
        .map((value) => (Array.isArray(value) ? value.join(" ") : value))
        .join(" ")
      const haystack = terms(`${skill.name} ${skill.description} ${skill.group ?? ""} ${meta}`)
      let score = 0
      for (const word of haystack) {
        if (!words.has(word)) continue
        score += skill.name.includes(word) ? 5 : skill.name.toLowerCase().includes(word) ? 3 : 1
      }
      if (skill.name.toLowerCase().startsWith(needle)) score += 20
      else if (skill.name.toLowerCase().includes(needle)) score += 8
      if (skill.group && words.has(skill.group.toLowerCase())) score += 2
      return { skill, score }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)

  return scored.map((entry) => entry.skill)
}
