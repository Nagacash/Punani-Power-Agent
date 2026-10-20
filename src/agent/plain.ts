/**
 * Turn model output into readable plain text.
 *
 * The reply is shown as plain text, so any markdown the model wrote shows up
 * as its own syntax: "**done**", "# Heading" and "```" are noise to someone
 * who just wants to read the answer. This removes the syntax and keeps the
 * words, so the answer reads the same whatever the model happened to write.
 *
 * The browser has its own copy of this in ui.html, because a page can only
 * import what the server serves it. Keep the two in step.
 */
export function plainText(text: string | undefined | null): string {
  let out = String(text ?? "")
  // Fenced code: keep the code, drop the fence.
  out = out.replace(/```[a-zA-Z0-9+#.-]*\n?/g, "")
  // Inline code and emphasis markers.
  out = out.replace(/`([^`]+)`/g, "$1")
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1")
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
  out = out.replace(/__([^_]+)__/g, "$1")
  // Headings: drop the hashes, keep the words.
  out = out.replace(/^#{1,6}\s+/gm, "")
  // Links: keep the label, keep the target in brackets.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
  // Images and horizontal rules.
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
  out = out.replace(/^\s*([-*_])\s*\1\s*\1[\s\S]*$/gm, "")
  // Bullets become a plain bullet character.
  out = out.replace(/^\s*[-*+]\s+/gm, "• ")
  return out.trim()
}
