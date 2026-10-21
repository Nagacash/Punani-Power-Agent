import fs from "node:fs"
import path from "node:path"

/**
 * The project files the agent reads on every turn.
 *
 * They are the closest thing Punani has to an AGENTS.md: what the agent must
 * not do, how it should use the tools, and what it has learned about this
 * project. A file that is already there is never touched.
 */

export interface ProjectFile {
  name: string
  /** What the file is for, in one line. */
  purpose: string
  template: string
}

export const PROJECT_FILES: ProjectFile[] = [
  {
    name: "guardrails.md",
    purpose: "what the agent must not do",
    template: `# Guardrails

The agent reads this on every turn. Write the rules it must not break here.

- Never change files outside this project.
- Never commit, push, or rewrite history without being asked.
- Never remove a file the user did not ask you to remove.
- Never print a secret, a key, or the contents of a .env file.

Add the rules this project needs. One per line, plain text.
`,
  },
  {
    name: "tool_guidance.md",
    purpose: "how the tools should be used here",
    template: `# Tool guidance

The agent reads this on every turn. Write how the tools are used in this
project here.

- The tests run with \`npm test\`, and the type check with \`npm run typecheck\`.
- A change is finished when the tests pass, not when the code compiles.
- Use \`bash\` for one command that prints what is needed, not for exploring.

Add the commands, the layout, and the traps. One per line, plain text.
`,
  },
  {
    name: "memory.md",
    purpose: "what the agent has learned about this project",
    template: `# What this project taught us

The agent reads this on every turn. Write what it learned here, so it does
not have to learn it again.

- The build is slow on a cold cache. Give it a minute before assuming it hung.
- The dev server holds the port; kill it before starting another.

Add what a future turn should know. One per line, plain text.
`,
  },
]

/**
 * Write the project files that are missing.
 *
 * A file that already exists is kept as it is: the point of the command is
 * to start a project off, not to overwrite what the user wrote.
 */
export function initProjectFiles(root: string): { written: string[]; kept: string[] } {
  const dir = path.join(root, ".punani")
  fs.mkdirSync(dir, { recursive: true })
  const written: string[] = []
  const kept: string[] = []
  for (const file of PROJECT_FILES) {
    const target = path.join(dir, file.name)
    if (fs.existsSync(target)) {
      kept.push(file.name)
      continue
    }
    fs.writeFileSync(target, file.template, { mode: 0o644 })
    written.push(file.name)
  }
  return { written, kept }
}
