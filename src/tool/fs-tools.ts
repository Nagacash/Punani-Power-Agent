import fs from "node:fs"
import path from "node:path"
import {
  ToolError,
  ensureInsideProject,
  ensureReadable,
  globToRegex,
  loadIgnoreRules,
  readTextFile,
  resolveInProject,
} from "./fsutil.js"

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

/** Largest image the read tool will hand to the model. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
import { declinedOutput, type Tool, type ToolResult } from "./types.js"

const MAX_READ_BYTES = 2 * 1024 * 1024
const DEFAULT_LIMIT = 2000

/** Read a file (or a slice of it) with line numbers. */
export const readTool: Tool = {
  name: "read",
  description:
    "Read a file from the project. Returns the content with line numbers. " +
    "Use offset and limit to page through large files.",
  permissionAction: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root." },
      offset: { type: "number", description: "1-based first line to return." },
      limit: { type: "number", description: "Maximum number of lines to return (default 2000)." },
    },
    required: ["path"],
  },
  async run(args: any, context): Promise<ToolResult> {
    const target = ensureReadable(context.projectRoot, String(args.path), context.allowedReadDirs)
    // A file outside the project is named by the root it came from, so the
    // permission it asks for is its own.
    const resource = target.resource ?? target.relative
    const outcome = await context.requestPermission({
      action: "read",
      resource,
      summary: target.resource ? `Read ${target.resource}` : `Read ${target.relative}`,
      alwaysPatterns: [resource],
    })
    if (!outcome.granted) {
      return {
        output: declinedOutput(`to read ${target.relative}`, outcome.message),
        isError: true,
      }
    }
    const stat = fs.statSync(target.absolute)
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target.absolute, { withFileTypes: true })
      const listing = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort()
        .join("\n")
      return { output: `Directory ${target.relative}:\n${listing}` }
    }
    if (stat.size > MAX_READ_BYTES) {
      throw new ToolError(
        `file is ${stat.size} bytes, larger than the ${MAX_READ_BYTES} byte read limit. Use grep to search it instead.`,
      )
    }
    const imageType = IMAGE_TYPES[path.extname(target.absolute).toLowerCase()]
    if (imageType) {
      if (stat.size > MAX_IMAGE_BYTES) {
        throw new ToolError(
          `the image is ${stat.size} bytes, larger than the ${MAX_IMAGE_BYTES} byte limit for showing images.`,
        )
      }
      const bytes = fs.readFileSync(target.absolute)
      return {
        output: `${target.relative} (image, ${stat.size} bytes)`,
        image: { mime: imageType, data: bytes.toString("base64") },
      }
    }

    const content = readTextFile(target.absolute)
    const allLines = content.split("\n")
    const offset = Math.max(1, Number(args.offset ?? 1))
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT))
    const slice = allLines.slice(offset - 1, offset - 1 + limit)
    const body = slice.map((line, index) => `${offset + index}\t${line}`).join("\n")
    const truncated = offset - 1 + limit < allLines.length
    const header = `${target.relative} (${allLines.length} lines)${truncated ? " [truncated]" : ""}`
    return { output: `${header}\n${body}` }
  },
}

/** List files matching a glob pattern. */
export const globTool: Tool = {
  name: "glob",
  description:
    "Find files by glob pattern, for example `src/**/*.ts`. Results are sorted by " +
    "modification time, newest first. Respects .gitignore.",
  permissionAction: "search",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern to match against project-relative paths." },
      limit: { type: "number", description: "Maximum number of results (default 200)." },
    },
    required: ["pattern"],
  },
  async run(args: any, context): Promise<ToolResult> {
    const pattern = String(args.pattern)
    const limit = Math.max(1, Number(args.limit ?? 200))
    const outcome = await context.requestPermission({
      action: "search",
      resource: `glob:${pattern}`,
      summary: `Find files matching ${pattern}`,
      alwaysPatterns: [`glob:${pattern}`],
    })
    if (!outcome.granted) {
      return { output: declinedOutput("the file search", outcome.message), isError: true }
    }
    const results = await findByGlob(context.projectRoot, pattern, limit)
    if (results.length === 0) return { output: `No files matched ${pattern}` }
    return { output: results.join("\n") }
  },
}

/** Search file contents with a regular expression. */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines with " +
    "file and line number. Respects .gitignore.",
  permissionAction: "search",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Optional directory or file to restrict the search to." },
      include: { type: "string", description: "Optional glob to filter which files are searched." },
      limit: { type: "number", description: "Maximum number of matching lines (default 200)." },
    },
    required: ["pattern"],
  },
  async run(args: any, context): Promise<ToolResult> {
    const pattern = String(args.pattern)
    let regex: RegExp
    try {
      regex = new RegExp(pattern, "i")
    } catch (error) {
      throw new ToolError(`invalid regular expression: ${(error as Error).message}`)
    }
    const limit = Math.max(1, Number(args.limit ?? 200))
    const scope = args.path ? ensureInsideProject(context.projectRoot, String(args.path)) : undefined
    const include = args.include ? String(args.include) : undefined

    const outcome = await context.requestPermission({
      action: "search",
      resource: `grep:${pattern}`,
      summary: `Search for /${pattern}/`,
      alwaysPatterns: [`grep:${pattern}`],
    })
    if (!outcome.granted) {
      return { output: declinedOutput("the search", outcome.message), isError: true }
    }

    const matches: string[] = []
    for (const file of walkFiles(context.projectRoot, scope?.absolute, include)) {
      let content: string
      try {
        const stat = fs.statSync(file)
        if (stat.size > MAX_READ_BYTES) continue
        content = fs.readFileSync(file, "utf8")
      } catch {
        continue
      }
      if (content.includes("\u0000")) continue
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= limit) break
        if (regex.test(lines[i]!)) {
          const relative = path.relative(context.projectRoot, file).split(path.sep).join("/")
          matches.push(`${relative}:${i + 1}: ${lines[i]!.trim().slice(0, 300)}`)
        }
      }
      if (matches.length >= limit) break
    }
    if (matches.length === 0) return { output: `No matches for /${pattern}/` }
    return { output: matches.join("\n") }
  },
}

async function findByGlob(root: string, pattern: string, limit: number): Promise<string[]> {
  const regex = globToRegex(pattern)
  const ignores = loadIgnoreRules(root)
  const found: { file: string; mtime: number }[] = []
  for (const file of walkFiles(root, undefined, undefined)) {
    const relative = path.relative(root, file).split(path.sep).join("/")
    if (ignores.ignores(relative, false)) continue
    if (!regex.test(relative)) continue
    try {
      found.push({ file: relative, mtime: fs.statSync(file).mtimeMs })
    } catch {
      /* skip */
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found.slice(0, limit).map((entry) => entry.file)
}

/** Depth-first walk of the project, skipping heavy and ignored directories. */
export function walkFiles(root: string, scope: string | undefined, include: string | undefined): string[] {
  const ignores = loadIgnoreRules(root)
  const includeRegex = include ? globToRegex(include) : undefined
  const skipDirs = new Set([
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
    "coverage",
  ])
  const out: string[] = []
  const start = scope ?? root
  const stack = [start]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        if (ignores.ignores(relative, true)) continue
        stack.push(absolute)
        continue
      }
      if (!entry.isFile()) continue
      if (ignores.ignores(relative, false)) continue
      if (includeRegex && !includeRegex.test(relative)) continue
      out.push(absolute)
    }
  }
  return out
}

export { resolveInProject }
