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
 * held back until the shape of the line is known, and once it is known the
 * line streams out as it arrives. A one-line answer therefore appears while
 * it is being written, not after.
 */
export interface PlainStream {
  /** The part of the current line that has not been sent yet. */
  pending: string
  /** True once the current line is plain text and can be sent as it comes. */
  raw: boolean
}

export function createPlainStream(): PlainStream {
  return { pending: "", raw: false }
}

/** Clean the finished lines of a stream, and hold the rest back. */
export function plainStream(text: string, state: PlainStream): string {
  state.pending += text
  let out = ""

  for (;;) {
    const newline = state.pending.indexOf("\n")
    if (newline === -1) {
      if (state.raw) {
        out += state.pending
        state.pending = ""
        return out
      }
      const decided = decide(state.pending)
      if (!decided) return out
      out += decided.text
      state.pending = decided.rest
      state.raw = true
      continue
    }

    const line = state.pending.slice(0, newline)
    const rest = state.pending.slice(newline + 1)
    out += state.raw ? line : plainLine(line)
    out += "\n"
    state.pending = rest
    state.raw = false
  }
}

/** Clean whatever is left when the reply ends. */
export function flushPlainStream(state: PlainStream): string {
  const rest = state.pending
  state.pending = ""
  const text = state.raw ? rest : rest ? plainLine(rest) : ""
  state.raw = false
  return text
}

/**
 * Work out what a line starts with, before the line is finished.
 *
 * Returns null while the answer is still unknown, which happens when the line
 * could still turn into a bullet, a heading, a rule or a code fence.
 */
function decide(partial: string): { text: string; rest: string } | null {
  // A code fence is a whole line. Wait for it.
  if (partial.startsWith("```")) return null
  // A horizontal rule is a whole line too.
  if (/^[ \t]*[-*_][ \t]*[-*_][ \t]*[-*_]/.test(partial)) return null

  const match = partial.match(/^([ \t]*)([-*+]|#{1,6})([ \t]*)([\s\S]*)$/)
  if (!match) return { text: partial, rest: "" }

  const indent = match[1] ?? ""
  const marker = match[2] ?? ""
  const space = match[3] ?? ""
  const rest = match[4] ?? ""
  if (rest === "" && space === "") {
    // The marker could still be followed by a space, so it could still be a
    // bullet or a heading. Wait for one more character.
    return null
  }
  if (space === "") {
    // A marker with no space after it is ordinary text.
    return { text: partial, rest: "" }
  }
  if (marker === "-" || marker === "*" || marker === "+") {
    return { text: `${indent}• `, rest }
  }
  // A heading keeps its text and drops the hashes.
  return { text: indent, rest }
}

/** The line-anchored part of `plainText`, with the indentation left alone. */
function plainLine(line: string): string {
  return line
    .replace(/^```[a-zA-Z0-9+#.-]*[ \t]*$/, "")
    .replace(/^(\s*)#{1,6}\s+/, "$1")
    .replace(/^(\s*)[-*+][ \t]+/, "$1• ")
    .replace(/^(\s*)([-*_])(?:[ \t]*\2){2,}[ \t]*$/, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
}
