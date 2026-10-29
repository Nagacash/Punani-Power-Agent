/** One-line recap after a turn, for terminal and browser. */
export function formatTaskSummary(summary: { changed: string[]; commands: string[] }): string {
  const parts: string[] = []
  if (summary.changed.length > 0) {
    const shown = summary.changed.slice(0, 3).join(", ")
    const more = summary.changed.length > 3 ? ` (+${summary.changed.length - 3} more)` : ""
    parts.push(`touched ${summary.changed.length} file(s): ${shown}${more}`)
  }
  if (summary.commands.length > 0) {
    parts.push(`ran ${summary.commands.length} command(s)`)
  }
  if (parts.length === 0) return "Task complete (no file changes recorded)."
  return `Task complete · ${parts.join(" · ")}`
}
