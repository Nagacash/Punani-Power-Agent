import { spawn, execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { ToolError, loadIgnoreRules, resolveInProject } from "./fsutil.js"
import { walkFiles } from "./fs-tools.js"
import type { Tool, ToolContext, ToolResult } from "./types.js"

/**
 * Structural search.
 *
 * A text search finds the word. A structural search finds the thing: every
 * call to a function, every method on a type, every place a pattern appears
 * in the syntax of the language.
 *
 * It needs the `ast-grep` binary. When it is not there the tool is not
 * offered at all, and the agent uses the text search it already has.
 */

const CANDIDATES = ["ast-grep", "sg"]

/** The binary that was found, and whether it is really ast-grep. */
let resolved: { path: string } | undefined
let looked = false

/**
 * True when ast-grep is on the path.
 *
 * The name alone is not enough: on Linux `sg` is the setgid utility, and
 * running it with ast-grep's arguments fails quietly. The binary has to
 * say that it is ast-grep.
 */
export function isAstGrepAvailable(): boolean {
  if (looked) return resolved !== undefined
  looked = true
  for (const binary of CANDIDATES) {
    const found = findOnPath(binary)
    if (!found) continue
    if (!saysItIsAstGrep(found)) continue
    resolved = { path: found }
    break
  }
  return resolved !== undefined
}

/** Ask the binary what it is. */
function saysItIsAstGrep(binary: string): boolean {
  try {
    const version = execFileSync(binary, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
    return /ast-grep/i.test(version)
  } catch {
    return false
  }
}

/** Where a binary is, if it is there at all. */
function findOnPath(binary: string): string | undefined {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    const candidate = path.join(dir, binary)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

const MAX_MATCHES = 100

export const astGrepTool: Tool = {
  name: "astgrep",
  description:
    "Search the code by its structure rather than its text. Give a pattern in the " +
    "language's own syntax, for example `console.log($A)` or `fn $NAME($$$) -> $RET` " +
    "or `class $C { $$$ }`, and it finds every place that shape appears, with the " +
    "file and the line. Use it when a text search would match too much or too little.",
  permissionAction: "search",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The pattern, in the language's own syntax." },
      language: { type: "string", description: "Optional language, e.g. typescript, python, rust." },
      path: { type: "string", description: "Optional directory to restrict the search to." },
      limit: { type: "number", description: `Maximum number of matches (default ${MAX_MATCHES}).` },
    },
    required: ["pattern"],
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "").trim()
    if (!pattern) throw new ToolError("a pattern is required")

    const outcome = await context.requestPermission({
      action: "search",
      resource: `astgrep:${pattern}`,
      summary: `Search the code for ${pattern}`,
      alwaysPatterns: [`astgrep:${pattern}`],
    })
    if (!outcome.granted) {
      return { output: `The user declined the structural search.${outcome.message ? ` Feedback: ${outcome.message}` : ""}`, isError: true }
    }

    const scope = args.path ? resolveInProject(context.projectRoot, String(args.path)) : undefined
    if (scope?.outside) {
      throw new ToolError(`path "${args.path}" is outside the project directory.`)
    }

    const binary = isAstGrepAvailable() ? resolved?.path : undefined
    if (!binary) {
      return {
        output:
          "ast-grep is not installed, so the structural search did not run. " +
          "Use grep for a text search, or install ast-grep to unlock this one.",
        isError: true,
      }
    }

    const limit = Math.max(1, Math.min(500, Number(args.limit ?? MAX_MATCHES)))
    const files = candidateFiles(context, scope?.absolute, args.language ? String(args.language) : undefined)
    if (files.length === 0) {
      return { output: "no files to search" }
    }

    const matches = await runAstGrep(binary, pattern, files, limit, context)
    if (matches.length === 0) {
      return { output: `no match for ${pattern}` }
    }
    return { output: matches.join("\n"), meta: { pattern, count: matches.length } }
  },
}

/** The files worth searching: inside the project, not ignored, not a binary. */
function candidateFiles(context: ToolContext, scope: string | undefined, language: string | undefined): string[] {
  const ignores = loadIgnoreRules(context.projectRoot)
  const extensions: Record<string, string[]> = {
    typescript: [".ts", ".tsx", ".mts", ".cts"],
    tsx: [".tsx"],
    javascript: [".js", ".jsx", ".mjs", ".cjs"],
    python: [".py"],
    rust: [".rs"],
    go: [".go"],
    java: [".java"],
    ruby: [".rb"],
    php: [".php"],
    c: [".c", ".h"],
    cpp: [".cpp", ".cc", ".hpp"],
    csharp: [".cs"],
  }
  const wanted = language ? extensions[language.toLowerCase()] : undefined

  const files: string[] = []
  for (const file of walkFiles(context.projectRoot, scope, undefined)) {
    const relative = path.relative(context.projectRoot, file).split(path.sep).join("/")
    if (ignores.ignores(relative, false)) continue
    if (wanted && !wanted.some((extension) => relative.endsWith(extension))) continue
    files.push(file)
  }
  return files.slice(0, 2_000)
}

/**
 * Read the matches out of ast-grep's output.
 *
 * The compact JSON is one array of matches. Older builds printed one match
 * per line, so both shapes are read.
 */
function parseMatches(body: string): any[] {
  const text = body.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === "object") return [parsed]
    return []
  } catch {
    /* not one JSON document: try it line by line */
  }
  const out: any[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (Array.isArray(parsed)) out.push(...parsed)
      else if (parsed && typeof parsed === "object") out.push(parsed)
    } catch {
      /* not a match line */
    }
  }
  return out
}

async function runAstGrep(
  binary: string,
  pattern: string,
  files: string[],
  limit: number,
  context: ToolContext,
): Promise<string[]> {
  const args = ["run", "--pattern", pattern, "--json=compact"]
  // Everything after this is a file name, even one that starts with a dash.
  args.push("--")
  for (const file of files) args.push(file)

  return await new Promise<string[]>((resolve) => {
    const child = spawn(binary, args, {
      cwd: context.projectRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    })
    const chunks: Buffer[] = []
    let bytes = 0
    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytes > 512 * 1024) return
      bytes += chunk.length
      chunks.push(chunk)
    })
    child.on("error", () => resolve([]))
    child.on("close", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const out: string[] = []
      for (const match of parseMatches(body)) {
        if (out.length >= limit) break
        const file = match.file ?? ""
        const relative = path.relative(context.projectRoot, path.resolve(context.projectRoot, file)).split(path.sep).join("/")
        const text = (match.text ?? "").split("\n")[0]!.trim().slice(0, 160)
        // The line in the output is the one a person would look at.
        const line = match.range?.start?.line ?? match.line ?? 0
        out.push(`${relative}:${line + 1}: ${text}`)
      }
      resolve(out)
    })
  })
}
