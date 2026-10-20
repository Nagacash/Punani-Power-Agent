import fs from "node:fs"
import path from "node:path"

/**
 * File-system helpers used by the tools.
 *
 * Every path that comes from a model is resolved against the project root and
 * checked to stay inside it, so a tool call cannot escape the project.
 */

export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolError"
  }
}

export interface ResolvedPath {
  /** Absolute path on disk. */
  absolute: string
  /** Path relative to the project root, using forward slashes. */
  relative: string
  /** True when the path is outside the project root. */
  outside: boolean
}

export function resolveInProject(root: string, candidate: string): ResolvedPath {
  const absolute = path.resolve(root, candidate)
  const relative = path.relative(root, absolute)
  const outside = relative.startsWith("..") || path.isAbsolute(relative)
  return {
    absolute,
    relative: outside ? absolute : relative.split(path.sep).join("/"),
    outside,
  }
}

export function ensureInsideProject(root: string, candidate: string): ResolvedPath {
  const resolved = resolveInProject(root, candidate)
  if (resolved.outside) {
    throw new ToolError(
      `path "${candidate}" is outside the project directory. Only files inside the project can be read or written.`,
    )
  }
  return resolved
}

export function readTextFile(absolute: string): string {
  try {
    return fs.readFileSync(absolute, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") throw new ToolError(`file not found: ${absolute}`)
    if (code === "EISDIR") throw new ToolError(`path is a directory: ${absolute}`)
    throw new ToolError(`cannot read ${absolute}: ${(error as Error).message}`)
  }
}

export function writeTextFile(absolute: string, content: string): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temp = `${absolute}.${process.pid}.tmp`
  fs.writeFileSync(temp, content, { mode: 0o644 })
  fs.renameSync(temp, absolute)
}

/** Read a file, but only if it changed since the caller last saw it. */
export function readIfUnchanged(absolute: string, expected: string | undefined): { content: string; changed: boolean } {
  const current = readTextFile(absolute)
  if (expected === undefined) return { content: current, changed: true }
  return { content: current, changed: current !== expected }
}

/**
 * The default mutator: write straight to disk.
 *
 * This is what the terminal and the browser use. An editor supplies its own,
 * so a change arrives as a reviewable diff rather than a silent write.
 */
export async function diskMutate(change: {
  path: string
  content: string
  encoding?: "utf8" | "base64"
}): Promise<{ applied: boolean }> {
  if (change.encoding === "base64") {
    fs.mkdirSync(path.dirname(change.path), { recursive: true })
    fs.writeFileSync(change.path, Buffer.from(change.content, "base64"))
    return { applied: true }
  }
  writeTextFile(change.path, change.content)
  return { applied: true }
}

export function fileExists(absolute: string): boolean {
  return fs.existsSync(absolute)
}

export function isDirectory(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

/**
 * Parse a `.gitignore`-style file into matchers.
 * Supports `*`, `?`, `**`, negation with `!` and directory-only `/` suffixes.
 */
export interface IgnoreRule {
  regex: RegExp
  negated: boolean
  directoryOnly: boolean
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const raw of content.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    let negated = false
    let pattern = line
    if (pattern.startsWith("!")) {
      negated = true
      pattern = pattern.slice(1)
    }
    let directoryOnly = false
    if (pattern.endsWith("/")) {
      directoryOnly = true
      pattern = pattern.slice(0, -1)
    }
    rules.push({ regex: globToRegex(pattern), negated, directoryOnly })
  }
  return rules
}

export function globToRegex(pattern: string): RegExp {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches any number of directories
        if (pattern[i + 2] === "/") {
          source += "(?:.*/)?"
          i += 2
        } else {
          source += ".*"
          i += 1
        }
      } else {
        source += "[^/]*"
      }
    } else if (char === "?") {
      source += "[^/]"
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

export class IgnoreSet {
  private rules: IgnoreRule[] = []

  add(content: string): void {
    this.rules.push(...parseIgnoreFile(content))
  }

  ignores(relativePath: string, isDir: boolean): boolean {
    let ignored = false
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDir) continue
      const normalized = relativePath.replace(/^\.\//, "")
      const matched =
        rule.regex.test(normalized) ||
        (rule.regex.test(path.basename(normalized)) && !rule.regex.source.includes("/"))
      if (!matched) continue
      ignored = !rule.negated
    }
    return ignored
  }
}

/** Load ignore rules from the project root and any nested .gitignore files. */
export function loadIgnoreRules(root: string): IgnoreSet {
  const set = new IgnoreSet()
  const files = [".gitignore", ".ignore", ".punaniignore"]
  for (const name of files) {
    const file = path.join(root, name)
    try {
      set.add(fs.readFileSync(file, "utf8"))
    } catch {
      /* not present */
    }
  }
  return set
}
