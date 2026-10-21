import { spawn } from "node:child_process"
import { ToolError, resolveInProject } from "./fsutil.js"
import { declinedOutput, type Tool, type ToolContext, type ToolResult } from "./types.js"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 256 * 1024

/** Commands that destroy data or change the machine in a way that is hard to undo. */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r|-[a-zA-Z]*f|-[a-zA-Z]*rf)\b/,
  /\brm\s+-rf?\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+push\b.*--force/,
  /\bmkfs\b/,
  /\bdd\s+if=.*of=/,
  /\bshutdown\b|\breboot\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bchown\s+-R\b/,
  /\bkillall\b/,
  /\bnpm\s+publish\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh/,
  /\bwget\b[^|]*\|\s*(ba)?sh/,
  />\s*\/dev\/(sd|disk|nvme)/,
]

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))
}

/** Run one shell command in the project directory, with explicit user approval. */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run one shell command in the project directory. The user approves the command " +
    "before it runs. Use the configured shell, otherwise /bin/sh. Output is captured.",
  permissionAction: "bash",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      workdir: { type: "string", description: "Optional working directory, relative to the project root." },
      timeout: { type: "number", description: `Timeout in milliseconds (max ${MAX_TIMEOUT_MS}).` },
    },
    required: ["command"],
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    const command = String(args.command ?? "").trim()
    if (!command) throw new ToolError("command must not be empty")

    const workdirArg = args.workdir ? String(args.workdir) : "."
    const workdir = resolveInProject(context.projectRoot, workdirArg)
    if (workdir.outside) {
      throw new ToolError(`workdir "${workdirArg}" is outside the project directory.`)
    }

    const destructive = isDestructiveCommand(command)
    const outcome = await context.requestPermission({
      action: "bash",
      resource: command,
      summary: `Run: ${command}`,
      detail: destructive
        ? "This command can delete or overwrite data. Check it carefully before approving."
        : `Working directory: ${workdir.absolute}`,
      destructive,
      // Approving a command always whitelists this exact command for the session.
      alwaysPatterns: [command],
    })
    if (!outcome.granted) {
      return {
        output: declinedOutput("to run the command", outcome.message),
        isError: true,
      }
    }

    const timeout = Math.min(Number(args.timeout ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
    const shell = process.env.PUNANI_SHELL || process.env.SHELL || "/bin/sh"

    return await new Promise<ToolResult>((resolve) => {
      let child
      try {
        child = spawn(shell, ["-c", command], {
          cwd: workdir.absolute,
          env: { ...process.env, PUNANI_PROJECT_ROOT: context.projectRoot },
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        resolve({ output: `could not start the shell: ${(error as Error).message}`, isError: true })
        return
      }

      const chunks: Buffer[] = []
      let bytes = 0
      let truncated = false
      let timedOut = false

      const collect = (chunk: Buffer): void => {
        if (bytes >= MAX_OUTPUT_BYTES) {
          truncated = true
          return
        }
        const room = MAX_OUTPUT_BYTES - bytes
        if (chunk.length > room) {
          chunks.push(chunk.subarray(0, room))
          bytes = MAX_OUTPUT_BYTES
          truncated = true
        } else {
          chunks.push(chunk)
          bytes += chunk.length
        }
      }

      child.stdout?.on("data", collect)
      child.stderr?.on("data", collect)

      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGKILL")
      }, timeout)

      const onAbort = (): void => {
        child.kill("SIGKILL")
      }
      context.signal?.addEventListener("abort", onAbort, { once: true })

      child.on("error", (error) => {
        clearTimeout(timer)
        context.signal?.removeEventListener("abort", onAbort)
        resolve({ output: `could not run the command: ${error.message}`, isError: true })
      })

      child.on("close", (code, signal) => {
        clearTimeout(timer)
        context.signal?.removeEventListener("abort", onAbort)
        const output = Buffer.concat(chunks).toString("utf8")
        const parts: string[] = []
        if (output.trim()) parts.push(output.trimEnd())
        if (truncated) parts.push(`[output truncated at ${MAX_OUTPUT_BYTES} bytes]`)
        if (timedOut) parts.push(`[command timed out after ${timeout}ms]`)
        else if (signal) parts.push(`[command killed with ${signal}]`)
        else parts.push(`[exit code ${code ?? 0}]`)
        resolve({
          output: parts.join("\n"),
          isError: (code ?? 0) !== 0 || timedOut,
          meta: { exitCode: code, timedOut, truncated },
        })
      })
    })
  },
}
