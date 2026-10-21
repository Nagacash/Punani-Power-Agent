import { spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { isDestructiveCommand } from "./bash.js"
import { ToolError, resolveInProject } from "./fsutil.js"
import { declinedOutput, type Tool, type ToolContext, type ToolResult } from "./types.js"

/**
 * Start a dev server and keep it running.
 *
 * The plain bash tool runs a command in the foreground and kills it when the
 * timeout hits, which is right for a build and wrong for a dev server: the
 * server dies the moment the tool returns, and a preview pointed at it shows
 * "connection refused". This tool detaches the process, waits for it to
 * answer on a port, and points the preview at the URL it actually bound.
 */

/** Ports a dev server commonly takes, in the order we would guess. */
const COMMON_PORTS = [3000, 5173, 4321, 8080, 8000, 4000, 5000, 3001, 5174, 4200]

/** How long to wait for the server to start answering. */
const DEFAULT_WAIT_MS = 30_000

/** The dev servers this process started, so they can be stopped with it. */
const running = new Map<number, { child: ReturnType<typeof spawn>; log: string }>()

/** Stop every dev server this process started. */
export function stopDevServers(): void {
  for (const [, entry] of running) {
    // The child leads its own process group, so this takes the server it
    // started with it. Killing only the shell would leave the server up.
    try {
      if (entry.child.pid) process.kill(-entry.child.pid, "SIGTERM")
    } catch {
      try {
        entry.child.kill("SIGTERM")
      } catch {
        /* already gone */
      }
    }
  }
  running.clear()
}

/** Does something answer on this port, on this address? */
function probe(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(600)
    socket.once("error", () => resolve(false))
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host, () => {
      socket.end()
      resolve(true)
    })
  })
}

/**
 * Does something answer on this port?
 *
 * Both loopback families are checked. "localhost" resolves to ::1 before
 * 127.0.0.1 on most systems, and a Vite server binds to "localhost", so it
 * listens on ::1 only. Probing IPv4 alone never finds it.
 */
async function portAnswers(port: number): Promise<boolean> {
  const [v4, v6] = await Promise.all([probe(port, "127.0.0.1"), probe(port, "::1")])
  return v4 || v6
}

/**
 * Find the port the server took.
 *
 * The dev server usually says so itself, and it knows better than we do: if
 * 3000 was busy, Next takes 3001. Fall back to probing, but only ports that
 * were free before we started, so an unrelated server already on 3000 is
 * never mistaken for ours.
 */
async function findPort(log: string, hint: number | undefined, wasBusy: Set<number>): Promise<number | undefined> {
  const fromLog = [...log.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/gi)].map((m) =>
    Number(m[1]),
  )
  for (const port of fromLog) {
    if (await portAnswers(port)) return port
  }
  if (hint && (await portAnswers(hint))) return hint
  for (const port of COMMON_PORTS) {
    if (wasBusy.has(port)) continue
    if (await portAnswers(port)) return port
  }
  return undefined
}

export const devTool: Tool = {
  name: "dev",
  description:
    "Start the project's dev server so the user can see it in the preview pane. " +
    "The server keeps running after this call returns, and the preview is pointed " +
    "at the URL it actually bound. Use this instead of `npm run dev` in bash, " +
    "which is killed when the command finishes. Stop it with `dev stop`.",
  permissionAction: "bash",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command that starts the dev server. Defaults to `npm run dev`.",
      },
      port: { type: "number", description: "The port it will use, if you already know it." },
      timeout: {
        type: "number",
        description: `How long to wait for it to start answering, in milliseconds (default ${DEFAULT_WAIT_MS}).`,
      },
      stop: {
        type: "boolean",
        description: "Set true to stop the dev server instead of starting one.",
      },
    },
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    if (args.stop) {
      const stopped: string[] = []
      for (const [pid, entry] of running) {
        try {
          if (entry.child.pid) process.kill(-entry.child.pid, "SIGTERM")
          else entry.child.kill("SIGTERM")
          stopped.push(`${pid} (log: ${entry.log})`)
        } catch {
          /* already gone */
        }
        running.delete(pid)
      }
      return {
        output: stopped.length
          ? `Stopped ${stopped.length} dev server(s):\n${stopped.join("\n")}`
          : "No dev server is running.",
      }
    }

    const command = String(args.command ?? "npm run dev").trim()
    const workdirArg = args.workdir ? String(args.workdir) : "."
    const workdir = resolveInProject(context.projectRoot, workdirArg)
    if (workdir.outside) {
      throw new ToolError(`workdir "${workdirArg}" is outside the project directory.`)
    }

    const outcome = await context.requestPermission({
      action: "bash",
      resource: command,
      summary: `Run in the background: ${command}`,
      detail:
        "This server keeps running after the command returns, so the preview pane can " +
        "show it. It stays up until it is stopped.",
      // The same warning the bash tool gives, for the same reason.
      destructive: isDestructiveCommand(command),
      alwaysPatterns: [command],
    })
    if (!outcome.granted) {
      return { output: declinedOutput("to run the command", outcome.message), isError: true }
    }

    // Which of the usual ports were already taken. A server that is not
    // ours must never be mistaken for the one we just started.
    const wasBusy = new Set<number>()
    for (const port of COMMON_PORTS) {
      if (await portAnswers(port)) wasBusy.add(port)
    }

    const logDir = path.join(context.projectRoot, ".punani")
    fs.mkdirSync(logDir, { recursive: true })
    const logPath = path.join(logDir, "dev.log")
    // Truncate: the previous run's output is not what the user is looking at.
    const logStream = fs.createWriteStream(logPath, { flags: "w" })

    const shell = process.env.PUNANI_SHELL || process.env.SHELL || "/bin/sh"
    const child = spawn(shell, ["-c", command], {
      cwd: workdir.absolute,
      // The dev server serves the project. It belongs on the loopback
      // address, whatever the command says.
      env: { ...process.env, PUNANI_PROJECT_ROOT: context.projectRoot, HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so it is not killed by signals meant for us.
      detached: true,
    })
    child.stdout?.pipe(logStream)
    child.stderr?.pipe(logStream)
    // The pipes keep the event loop alive as long as the server runs, and
    // the server is meant to outlive this call. Without this the process
    // that made the call never gets to exit.
    // The pipes are sockets at runtime, even though the type says Readable.
    const unref = (stream: NodeJS.ReadableStream | null): void => {
      ;(stream as unknown as { unref?: () => void } | null)?.unref?.()
    }
    unref(child.stdout)
    unref(child.stderr)
    child.unref()
    running.set(child.pid ?? 0, { child, log: logPath })

    const waitMs = Math.min(Number(args.timeout ?? DEFAULT_WAIT_MS), 120_000)
    const deadline = Date.now() + waitMs
    let port: number | undefined
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400))
      port = await findPort(readLog(logPath), args.port ? Number(args.port) : undefined, wasBusy)
      if (port) break
      if (child.exitCode !== null) break
    }

    const log = readLog(logPath)
    if (!port) {
      const tail = log.trim().split("\n").slice(-20).join("\n")
      return {
        output:
          `Started \`${command}\` (pid ${child.pid}) but nothing answered on a port within ${waitMs}ms.\n` +
          `Log: ${logPath}\n\n` +
          (tail ? `Last output:\n${tail}\n` : ""),
        isError: true,
      }
    }

    const url = `http://localhost:${port}`
    context.setPreview?.(url)
    context.notify(`preview: ${url}`)
    return {
      output:
        `Started \`${command}\` (pid ${child.pid}).\n` +
        `The preview is now showing ${url}\n` +
        `Log: ${logPath}\n` +
        `Stop it with the dev tool's stop option.`,
    }
  },
}

function readLog(file: string): string {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
