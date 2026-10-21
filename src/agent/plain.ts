/**
 * Turn model output into readable plain text.
 *
 * The reply is shown as plain text, so any markdown the model wrote shows up
 * as its own syntax: "**done**", "# Heading" and "```" are noise to someone
 * who just wants to read the answer. This removes the syntax and keeps the
 * words, so the answer reads the same whatever the model happened to write.
 *
 * The browser has its own copy of this in ui.html, because a page can only
 * import what the server serves it. Keep the two in step; the tests compare
 * them.
 */
export function plainText(text: string | undefined | null): string {
  let out = String(text ?? "")
  // Fenced code: keep the code, drop the fence.
  out = out.replace(/```[a-zA-Z0-9+#.-]*\n?/g, "")

  // Take the inline code out of harm's way. A command like grep '*error*' has
  // asterisks that are part of the command, not emphasis.
  const spans: string[] = []
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    spans.push(code)
    return `\u0000${spans.length - 1}\u0000`
  })

  // Emphasis markers.
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1")
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
  out = out.replace(/__([^_]+)__/g, "$1")
  // Headings: drop the hashes, keep the words.
  out = out.replace(/^#{1,6}\s+/gm, "")
  // Images before links, or the link rule eats the image first.
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  // A horizontal rule is a line of three or more of the same marker. The
  // line has to end there, or the match runs on and eats the rest of the
  // reply.
  out = out.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
  // Bullets become a plain bullet character.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "• ")

  // Put the inline code back.
  out = out.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => spans[Number(index)] ?? "")
  return out.trim()
}

/**
 * Clean a reply that is still arriving.
 *
 * The whole reply is cleaned at once by `plainText`, but a stream cannot be:
 * a heading marker or a bullet can be split across two chunks. So the text is
 * held back until the line is complete, and each finished line is cleaned on
 * its own. Indentation is kept, because it carries the shape of a code block.
 */
export interface PlainStream {
  /** The part of the current line that has not ended yet. */
  pending: string
}

export function createPlainStream(): PlainStream {
  return { pending: "" }
}

/** Clean the finished lines of a stream, and hold the rest back. */
export function plainStream(text: string, state: PlainStream): string {
  state.pending += text
  const parts = state.pending.split("\n")
  state.pending = parts.pop() ?? ""
  if (parts.length === 0) return ""
  return parts.map(plainLine).join("\n") + "\n"
}

/** Clean whatever is left when the reply ends. */
export function flushPlainStream(state: PlainStream): string {
  const rest = state.pending
  state.pending = ""
  return rest ? plainLine(rest) : ""
}

/** The line-anchored part of `plainText`, with the indentation left alone. */
function plainLine(line: string): string {
  return line
    .replace(/^(\s*)#{1,6}\s+/, "$1")
    .replace(/^(\s*)[-*+][ \t]+/, "$1• ")
    .replace(/^(\s*)([-*_])(?:[ \t]*\2){2,}[ \t]*$/, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
}
