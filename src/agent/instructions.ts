import fs from "node:fs"
import path from "node:path"

/**
 * The project's own instructions.
 *
 * A repository usually says how it wants to be worked on: AGENTS.md,
 * CLAUDE.md, .cursorrules, Copilot's instructions file. They are the closest
 * thing to a project's conventions, and an agent that ignores them will write
 * code in a style the maintainers did not ask for.
 */

const SOURCES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
  "GEMINI.md",
]

/** How much of each file to take. */
const PER_FILE_LIMIT = 8_000
const TOTAL_LIMIT = 20_000

export interface ProjectInstructions {
  /** The text to put in the prompt. */
  text: string
  /** Which files it came from. */
  files: string[]
}

/**
 * Read the instruction files at the project root.
 *
 * Missing files are normal, so this never throws. The result is bounded, so a
 * huge instructions file cannot eat the context.
 */
export function loadProjectInstructions(root: string): ProjectInstructions {
  const chunks: string[] = []
  const files: string[] = []
  let total = 0

  for (const name of SOURCES) {
    if (total >= TOTAL_LIMIT) break
    const file = path.join(root, name)
    let text: string
    try {
      text = fs.readFileSync(file, "utf8")
    } catch {
      continue
    }
    const trimmed = text.trim()
    if (!trimmed) continue
    const room = Math.min(PER_FILE_LIMIT, TOTAL_LIMIT - total)
    chunks.push(`### ${name}\n\n${trimmed.slice(0, room)}`)
    files.push(name)
    total += Math.min(room, trimmed.length)
  }

  if (chunks.length === 0) return { text: "", files: [] }
  return {
    text: [
      "The project has its own instructions. Follow them.",
      "",
      ...chunks,
    ].join("\n\n"),
    files,
  }
}
