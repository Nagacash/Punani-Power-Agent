import fs from "node:fs"
import path from "node:path"
import { paths } from "../core/paths.js"

/**
 * The always-on surface.
 *
 * The rules the agent always follows should be files, not code. A file can be
 * edited by a person, by the agent, or by a harness that measures the agent
 * and rewrites what did not work. Code cannot.
 *
 * Four files, in the order they are read:
 *
 *   .punani/guardrails.md      what the agent must not do
 *   .punani/tool_guidance.md   how to use the tools
 *   .punani/memory.md          what the agent learned about this project
 *   <config>/memory.md         the same, for every project
 *
 * The project files come first, so a project can override the user's.
 */

export interface AlwaysOnFile {
  /** The label the model sees. */
  name: string
  /** The path it was read from. */
  file: string
  /** Its text. */
  text: string
}

export interface AlwaysOn {
  /** The files, in the order they are read. */
  files: AlwaysOnFile[]
  /** True when the budget cut something off. */
  truncated: boolean
}

/** How much the always-on files may cost, in characters. */
export const ALWAYS_ON_LIMIT = 24_000

const PROJECT_FILES: [string, string][] = [
  ["guardrails.md", "Guardrails"],
  ["tool_guidance.md", "Tool guidance"],
  ["memory.md", "What this project taught us"],
]

export function alwaysOnFiles(projectRoot: string): { file: string; name: string }[] {
  const files: { file: string; name: string }[] = []
  for (const [name, label] of PROJECT_FILES) {
    files.push({ file: path.join(projectRoot, ".punani", name), name: label })
  }
  files.push({ file: path.join(paths.configDir, "memory.md"), name: "What I learned" })
  return files
}

/**
 * Read the always-on files.
 *
 * The budget is shared: every file competes for the same space, because they
 * all sit in the prompt on every turn. A file that does not fit is dropped
 * whole, never cut in half, so the agent never reads half a rule.
 */
export function loadAlwaysOn(projectRoot: string, limit = ALWAYS_ON_LIMIT): AlwaysOn {
  const files: AlwaysOnFile[] = []
  let used = 0
  let truncated = false

  for (const { file, name } of alwaysOnFiles(projectRoot)) {
    let text: string
    try {
      text = fs.readFileSync(file, "utf8").trim()
    } catch {
      continue
    }
    if (!text) continue
    if (used + text.length > limit) {
      truncated = true
      continue
    }
    files.push({ name, file, text })
    used += text.length
  }

  return { files, truncated }
}

/** The always-on files as text for the system prompt. */
export function renderAlwaysOn(alwaysOn: AlwaysOn): string {
  if (alwaysOn.files.length === 0) return ""
  const parts: string[] = []
  for (const file of alwaysOn.files) {
    parts.push(`${file.name} (${file.file}):\n${file.text}`)
  }
  if (alwaysOn.truncated) {
    parts.push("Some of these files did not fit and were left out. Read them if you need them.")
  }
  return parts.join("\n\n")
}
