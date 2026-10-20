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
