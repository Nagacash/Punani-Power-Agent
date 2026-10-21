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
  /**
   * What the permission is asked for. A file outside the project is named by
   * the root it came from, so two files with the same name do not share one
   * permission.
   */
  resource?: string
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

/**
 * Resolve a path for reading.
 *
 * The project is the usual answer, but a skill lives outside it and refers to
 * its own files. Those are readable too, when the caller says where the
 * library is.
 */
export function ensureReadable(
  root: string,
  candidate: string,
  extraDirs: string[] = [],
): ResolvedPath {
  const resolved = resolveInProject(root, candidate)
  if (!resolved.outside) {
    // The path is inside the project, but a link inside it can point out.
    // The real path has to stay inside the real project.
    const realRoot = realPath(root)
    const realTarget = realPath(resolved.absolute)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new ToolError(
        `path "${candidate}" is a link that points outside the project directory. ` +
          "Only files inside the project can be read.",
      )
    }
    return resolved
  }
  for (const dir of extraDirs) {
    const base = path.resolve(dir)
    // Follow the links on both sides. A link inside the library must not be a
    // way out of it.
    const realBase = realPath(base)
    const realTarget = realPath(resolved.absolute)
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) continue
    const relative = path.relative(realBase, realTarget).split(path.sep).join("/")
    return {
      absolute: resolved.absolute,
      relative,
      // The name of the root is part of the identity, so a library file and a
      // project file with the same name do not share one permission.
      resource: `skill:${path.basename(realBase)}/${relative}`,
      outside: false,
    }
  }
  throw new ToolError(
    `path "${candidate}" is outside the project directory. Only files inside the project ` +
      (extraDirs.length > 0 ? "and the skill library " : "") + "can be read.",
  )
}

/**
 * The real path on disk.
 *
 * A file that is not there yet has no real path, so the directory that
 * holds it is resolved and the missing parts are put back. Without this a
 * new file in a linked directory (a temp directory, say) would look like it
 * was somewhere else.
 */
export function realPath(target: string): string {
  let current = target
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return tail.length ? path.join(real, ...tail) : real
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      tail.unshift(path.basename(current))
      current = parent
    }
  }
}


export function ensureInsideProject(root: string, candidate: string): ResolvedPath {
  const resolved = resolveInProject(root, candidate)
  if (resolved.outside) {
    throw new ToolError(
      `path "${candidate}" is outside the project directory. Only files inside the project can be read or written.`,
    )
  }
  // A link inside the project that points out of it is not inside it.
  const realRoot = realPath(root)
  const realTarget = realPath(resolved.absolute)
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new ToolError(
      `path "${candidate}" is a link that points outside the project directory. ` +
        "Only files inside the project can be read or written.",
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

/** Write bytes the same way: into a temp file, then over the name. */
function writeBytes(absolute: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  const temp = `${absolute}.${process.pid}.tmp`
  fs.writeFileSync(temp, bytes, { mode: 0o644 })
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
    // Through a temp file, like the text path: writing straight to the name
    // would follow a link out of the project.
    writeBytes(change.path, Buffer.from(change.content, "base64"))
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

/**
 * Turn a glob into a regular expression.
 *
 * `*`, `**` and `?` behave as they do in a shell. `{a,b}` is a set of
 * alternatives, because a model reaching for a glob almost always writes
 * `*.{png,jpg}` and expects it to work.
 */
export function globToRegex(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern, 0)}$`)
}

/** How long a glob may get before its braces are left alone. */
const MAX_GLOB_SOURCE = 2_000
/** How many alternatives one brace group may hold. */
const MAX_GLOB_OPTIONS = 64

function globSource(pattern: string, depth: number): string {
  let source = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === "{" && depth < 4) {
      const end = pattern.indexOf("}", i)
      if (end > i) {
        const options = pattern.slice(i + 1, end).split(",")
        // A brace group with hundreds of options makes a regex that backtracks
        // forever. A glob that long is a mistake, not a search.
        if (options.length <= MAX_GLOB_OPTIONS) {
          const expanded = options.map((option) => globSource(option, depth + 1)).join("|")
          if (source.length + expanded.length <= MAX_GLOB_SOURCE) {
            source += `(?:${expanded})`
            i = end
            continue
          }
        }
        source += "\\{"
        continue
      }
      source += "\\{"
    } else if (char === "*") {
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
  return source
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
