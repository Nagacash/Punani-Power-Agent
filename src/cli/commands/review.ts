import { execFileSync } from "node:child_process"

/**
 * The diff a review is about.
 *
 * The user asks for the uncommitted changes, a commit, a branch, or a pull
 * request, and the agent gets that diff and nothing else.
 */

/** The most a diff may be before it is cut short. */
const MAX_DIFF_CHARS = 60_000

export interface ReviewDiff {
  /** What is being reviewed, in words. */
  label: string
  /** The diff itself. */
  diff: string
  /** True when the diff was too long and was cut short. */
  truncated: boolean
  /** Why there is no diff. */
  error?: string
}

function run(root: string, command: string[], args: string[]): { output?: string; error?: string } {
  try {
    const output = execFileSync(command[0]!, [...command.slice(1), ...args], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { output }
  } catch (error) {
    // Git says what went wrong on stderr. That is the useful part.
    const stderr = (error as { stderr?: Buffer | string }).stderr
    const detail = typeof stderr === "string" ? stderr : stderr?.toString() ?? ""
    const said = detail
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("usage:"))
    return { error: said ?? (error instanceof Error ? error.message : String(error)) }
  }
}

/**
 * Collect the diff to review.
 *
 * Without an argument it is the changes that are not committed yet. `commit`,
 * `branch` and `pr` name the other three.
 */
export function collectReviewDiff(root: string, argument: string): ReviewDiff {
  const parts = argument.split(/\s+/).filter(Boolean)
  const kind = (parts[0] ?? "").toLowerCase()
  const value = parts.slice(1).join(" ")

  let label = ""
  let result: { output?: string; error?: string }

  switch (kind) {
    case "":
      label = "the uncommitted changes"
      result = run(root, ["git"], ["diff", "HEAD"])
      break

    case "commit": {
      if (!value) return { label, diff: "", truncated: false, error: "which commit? Try /review commit <sha>." }
      label = `commit ${value}`
      result = run(root, ["git"], ["show", value])
      break
    }

    case "branch": {
      if (!value) return { label, diff: "", truncated: false, error: "which branch? Try /review branch <name>." }
      label = `branch ${value}`
      const base = run(root, ["git"], ["merge-base", "HEAD", value])
      if (base.error || !base.output) {
        return { label, diff: "", truncated: false, error: `no branch called ${value} here.` }
      }
      result = run(root, ["git"], ["diff", `${base.output.trim()}..${value}`])
      break
    }

    case "pr": {
      if (!value) return { label, diff: "", truncated: false, error: "which pull request? Try /review pr <number>." }
      label = `pull request ${value}`
      result = run(root, ["gh"], ["pr", "diff", value])
      break
    }

    default:
      return {
        label: "",
        diff: "",
        truncated: false,
        error: `unknown target "${kind}". Use commit, branch or pr.`,
      }
  }

  if (result.error !== undefined) {
    return { label, diff: "", truncated: false, error: result.error.split("\n")[0] }
  }
  const diff = result.output ?? ""
  if (!diff.trim()) {
    return { label, diff: "", truncated: false, error: `nothing to review in ${label}.` }
  }
  const truncated = diff.length > MAX_DIFF_CHARS
  return {
    label,
    diff: truncated ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… the diff was cut short here` : diff,
    truncated,
  }
}

/** The prompt the review turn runs on. */
export function reviewPrompt(target: ReviewDiff): string {
  return [
    `Review ${target.label}.`,
    "",
    "Look for what is wrong: a bug, a case that is not handled, a security problem, a change that does not match the code around it. Point at the file and the line.",
    "",
    "Say what you found. If the changes are fine, say so in one line. Do not change anything.",
    "",
    "The diff:",
    "```",
    target.diff,
    "```",
  ].join("\n")
}
