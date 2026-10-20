import { spawn } from "node:child_process"

/**
 * The Kling CLI.
 *
 * Kling is authenticated by the CLI itself, with a browser OAuth flow, and it
 * owns the regional endpoint, the polling and the model catalog. The app never
 * talks to that service directly — it drives the CLI and reads what it prints.
 */

export interface KlingWhoAmI {
  loggedIn: boolean
  /** Every model name the CLI reported, for any generation command. */
  models: string[]
  /** The models reported specifically for text_to_image. */
  imageModels: string[]
  raw: string
  error?: string
}

async function run(
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("kling", args, { stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout?.on("data", (chunk) => {
      out.push(chunk as Buffer)
      onLine?.(chunk.toString("utf8"))
    })
    child.stderr?.on("data", (chunk) => {
      err.push(chunk as Buffer)
      onLine?.(chunk.toString("utf8"))
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      })
    })
  })
}

/** Collect every string that looks like a model name out of a payload. */
function collectModels(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    // Model names are lowercase with digits and dashes.
    if (/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/.test(value) && value.length < 60) into.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectModels(entry, into)
    return
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectModels(entry, into)
  }
}

/** Find the models listed under a named tool, if the payload has that shape. */
function modelsForTool(payload: any, tool: string): string[] {
  const found = new Set<string>()
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return
    for (const [key, value] of Object.entries(node)) {
      if (key === tool) {
        const scoped = new Set<string>()
        collectModels(value, scoped)
        for (const name of scoped) found.add(name)
      }
      if (Array.isArray(value)) value.forEach(visit)
      else if (value && typeof value === "object") visit(value)
    }
  }
  visit(payload)
  return [...found]
}

/** Ask the CLI who we are and which models are available. */
export async function whoAmI(): Promise<KlingWhoAmI> {
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await run(["who_am_i"], 30_000)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      return {
        loggedIn: false,
        models: [],
        imageModels: [],
        raw: "",
        error:
          "the `kling` command was not found. Install it with: npm i -g @klingai/cli-global (or @klingai/cli-cn for the China region).",
      }
    }
    return {
      loggedIn: false,
      models: [],
      imageModels: [],
      raw: "",
      error: `could not run the kling CLI: ${(error as Error).message}`,
    }
  }

  const raw = `${result.stdout}\n${result.stderr}`.trim()
  if (result.code !== 0) {
    const needsLogin = /login|invalid_grant|unauthor/i.test(raw)
    return {
      loggedIn: false,
      models: [],
      imageModels: [],
      raw,
      error: needsLogin
        ? "not signed in to Kling. Run `kling login` to sign in."
        : raw.split("\n").slice(-3).join(" "),
    }
  }

  let payload: any
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    payload = undefined
  }

  const all = new Set<string>()
  if (payload) {
    collectModels(payload, all)
    // Ignore obvious non-model strings.
    for (const noise of ["text_to_image", "text_to_video", "image_to_image", "image_to_video", "query_tasks"]) {
      all.delete(noise)
    }
  }

  return {
    loggedIn: true,
    models: [...all].sort(),
    imageModels: payload ? modelsForTool(payload, "text_to_image") : [],
    raw,
  }
}

/** Run the interactive login. The browser opens for the user to complete. */
export async function login(timeoutMs = 180_000): Promise<{ ok: boolean; output: string }> {
  return await new Promise((resolve) => {
    const child = spawn("kling", ["login"], { stdio: ["inherit", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout?.on("data", (chunk) => chunks.push(chunk as Buffer))
    child.stderr?.on("data", (chunk) => chunks.push(chunk as Buffer))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ ok: false, output: (error as Error).message })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output: Buffer.concat(chunks).toString("utf8") })
    })
  })
}
