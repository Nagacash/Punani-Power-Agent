/**
 * Unified diff generation.
 *
 * Used to show the user exactly what an edit will do before it is written.
 * Standard LCS-based diff, emitted in unified format.
 */

export interface DiffLine {
  kind: "context" | "add" | "remove"
  text: string
  /** 1-based line number in the old file, when present. */
  oldLine?: number
  /** 1-based line number in the new file, when present. */
  newLine?: number
}

export interface DiffResult {
  lines: DiffLine[]
  additions: number
  deletions: number
}

/** Longest-common-subsequence table walk producing an edit script. */
function lcsMatrix(a: string[], b: string[]): number[][] {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = matrix[i]!
      const next = matrix[i + 1]!
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!)
    }
  }
  return matrix
}

export function diffLines(oldText: string, newText: string): DiffResult {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const matrix = lcsMatrix(a, b)
  const lines: DiffLine[] = []
  let additions = 0
  let deletions = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "context", text: a[i]!, oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (matrix[i + 1]![j]! >= matrix[i]![j + 1]!) {
      lines.push({ kind: "remove", text: a[i]!, oldLine: i + 1 })
      deletions++
      i++
    } else {
      lines.push({ kind: "add", text: b[j]!, newLine: j + 1 })
      additions++
      j++
    }
  }
  while (i < a.length) {
    lines.push({ kind: "remove", text: a[i]!, oldLine: i + 1 })
    deletions++
    i++
  }
  while (j < b.length) {
    lines.push({ kind: "add", text: b[j]!, newLine: j + 1 })
    additions++
    j++
  }
  return { lines, additions, deletions }
}

/** Render a diff as a unified-format patch text. */
export function toUnifiedDiff(path: string, oldText: string, newText: string, context = 3): string {
  const { lines } = diffLines(oldText, newText)
  const hunks: string[] = []
  let index = 0
  while (index < lines.length) {
    if (lines[index]!.kind === "context") {
      index++
      continue
    }
    let start = index
    let oldCount = 0
    let newCount = 0
    let lead = 0
    while (start > 0 && lines[start - 1]!.kind === "context" && lead < context) {
      start--
      lead++
    }
    let end = index
    let trailing = 0
    while (end < lines.length) {
      const line = lines[end]!
      if (line.kind === "context") {
        trailing++
        if (trailing > context) break
      } else {
        trailing = 0
        if (line.kind === "remove") oldCount++
        else newCount++
      }
      end++
    }
    const slice = lines.slice(start, end)
    const oldStart = slice.find((line) => line.oldLine)?.oldLine ?? 1
    const newStart = slice.find((line) => line.newLine)?.newLine ?? 1
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`
    const body = slice.map((line) => {
      const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "
      return prefix + line.text
    })
    hunks.push([header, ...body].join("\n"))
    index = end
  }
  if (hunks.length === 0) return ""
  return [`--- a/${path}`, `+++ b/${path}`, ...hunks].join("\n")
}

/** Count changed lines, used for the summary line. */
export function diffStats(oldText: string, newText: string): { additions: number; deletions: number } {
  const { additions, deletions } = diffLines(oldText, newText)
  return { additions, deletions }
}
