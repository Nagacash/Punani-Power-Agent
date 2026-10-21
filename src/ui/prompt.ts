import { style, symbol } from "./theme.js"
import { diffLines } from "../tool/diff.js"
import type { PermissionOutcome, PermissionRequest } from "../tool/types.js"

/**
 * The permission prompt.
 *
 * The user sees exactly what is about to happen, and for destructive actions
 * the warning is stated explicitly. The reply maps to:
 *   y  allow once
 *   a  allow this pattern for the rest of the session
 *   n  reject
 *   n <text>  reject with feedback, which is passed back to the model
 */
export function renderPermissionRequest(request: PermissionRequest): void {
  process.stdout.write("\n")
  const label = permissionLabel(request.action)
  process.stdout.write(`${style.bgYellow(style.black(` ${label} `))} ${style.bold(request.summary)}\n`)
  if (request.destructive) {
    process.stdout.write(`  ${style.red(symbol.warn)} ${style.red("This action can destroy or overwrite data.")}\n`)
  }
  if (request.detail) {
    for (const line of request.detail.split("\n").slice(0, 12)) {
      process.stdout.write(`  ${style.gray("│")} ${line}\n`)
    }
  }
  if (request.alwaysPatterns?.length) {
    const patterns = request.alwaysPatterns.map((p) => style.cyan(p)).join(", ")
    process.stdout.write(`  ${style.gray("allow again for:")} ${patterns}\n`)
  }
  process.stdout.write(
    `  ${style.green("y")}${style.gray(" once")}  ${style.green("a")}${style.gray(" always")}  ` +
      `${style.red("n")}${style.gray(" reject")}  ${style.gray("(optionally n <reason>)")}\n`,
  )
}

/**
 * The name of the action, for the prompt.
 *
 * The dangerous half of a tool has its own action, so the label says what
 * is about to happen rather than which rule fired.
 */
export function permissionLabel(action: string): string {
  switch (action) {
    case "write-destructive":
      return "WRITE (REPLACES)"
    case "edit-destructive":
      return "EDIT (REWRITES)"
    case "bash-destructive":
      return "BASH (DESTRUCTIVE)"
    default:
      return action.toUpperCase()
  }
}

/** Turn the user's typed reply into a decision. */
export function interpretPermissionReply(reply: string, request: PermissionRequest): PermissionOutcome {
  const trimmed = reply.trim()
  const lowered = trimmed.toLowerCase()

  if (lowered === "" ) {
    // Nobody answered. That is not a yes, and it is not a no either: there
    // is nobody to say it. The turn stops.
    return { granted: false, unanswered: true }
  }
  if (lowered === "y" || lowered === "yes") {
    return { granted: true }
  }
  if (lowered === "a" || lowered === "always") {
    return { granted: true, remember: true, patterns: request.alwaysPatterns ?? [request.resource] }
  }
  if (lowered === "n" || lowered === "no") {
    return { granted: false }
  }
  if (lowered.startsWith("n ")) {
    return { granted: false, message: trimmed.slice(2).trim() || undefined }
  }
  // Anything else is treated as a rejection, but the text is kept as feedback.
  return { granted: false, message: trimmed }
}

/**
 * Render a diff so the user can see exactly what will change before it is
 * written. Context lines around each hunk are kept; long runs are elided.
 */
export function renderDiff(path: string, before: string, after: string, maxLines = 40): void {
  const { lines, additions, deletions } = diffLines(before, after)
  if (additions === 0 && deletions === 0) {
    process.stdout.write(`  ${style.gray("│")} ${style.gray("(no textual change)")}\n`)
    return
  }
  const changedIndexes = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0)
  const keep = new Set<number>()
  for (const index of changedIndexes) {
    for (let offset = -2; offset <= 2; offset++) {
      const target = index + offset
      if (target >= 0 && target < lines.length) keep.add(target)
    }
  }
  process.stdout.write(`  ${style.bold(style.white(path))} ${style.green(`+${additions}`)} ${style.red(`-${deletions}`)}\n`)
  let previous = -1
  let shown = 0
  for (let index = 0; index < lines.length; index++) {
    if (!keep.has(index)) continue
    if (previous !== -1 && index > previous + 1) {
      process.stdout.write(`  ${style.gray("│")} ${style.gray("…")}\n`)
    }
    if (shown >= maxLines) {
      process.stdout.write(`  ${style.gray("│")} ${style.gray(`… ${lines.length - index} more lines`)}\n`)
      break
    }
    const line = lines[index]!
    const number = style.gray(String(line.newLine ?? line.oldLine ?? "").padStart(5))
    if (line.kind === "add") {
      process.stdout.write(`  ${style.green("+")} ${number} ${style.green(line.text)}\n`)
    } else if (line.kind === "remove") {
      process.stdout.write(`  ${style.red("-")} ${number} ${style.red(line.text)}\n`)
    } else {
      process.stdout.write(`  ${style.gray(" ")} ${number} ${style.gray(line.text)}\n`)
    }
    previous = index
    shown++
  }
}
