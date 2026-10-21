import path from "node:path"
import { spawn } from "node:child_process"
import { ToolError, diskMutate, ensureInsideProject } from "./fsutil.js"
import { declinedResult, type Tool, type ToolContext, type ToolResult } from "./types.js"

/**
 * Image generation.
 *
 * Two backends:
 *
 *   kling   - drives the `kling` CLI. All interaction with that service goes
 *             through the CLI, which owns authentication, polling and the
 *             regional endpoint. The CLI prints JSON when it is not attached
 *             to a terminal.
 *   openai  - any OpenAI-compatible /v1/images/generations endpoint.
 *
 * The generated file lands inside the project, so the agent can then look at
 * it, read it, or hand it to the user.
 */

export interface ImageSettings {
  /** Which backend to use. */
  provider: "kling" | "openai-compatible" | "none"
  /** Model name. Kling requires one; OpenAI-compatible endpoints usually have a default. */
  model?: string
  /** Base URL for the openai-compatible backend. */
  baseURL?: string
  /** API key for the openai-compatible backend. */
  apiKey?: string
  /** Where files are written, relative to the project root. */
  outputDir?: string
  /** How long to wait for Kling, in seconds. */
  timeoutSeconds?: number
}

const DEFAULT_OUTPUT_DIR = "assets/generated"

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "image"
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
    child.stdout?.on("data", (chunk) => out.push(chunk as Buffer))
    child.stderr?.on("data", (chunk) => err.push(chunk as Buffer))
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

/** Pull the first http(s) URL out of a blob of CLI output. */
function findUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s"'\\]+/)
  return match?.[0]
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new ToolError(`could not download the image: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Drive the Kling CLI for a text-to-image request. */
async function generateWithKling(
  settings: ImageSettings,
  prompt: string,
  destination: string,
): Promise<{ credits?: number; model: string }> {
  const model = settings.model
  if (!model) {
    throw new ToolError(
      "no image model is set. Run `kling who_am_i` to see the available models, then set one in the config: " +
        '{"image": {"provider": "kling", "model": "<name>"}}',
    )
  }

  const args = ["text_to_image", "--model", model, "--poll", String(settings.timeoutSeconds ?? 120), prompt]
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await runCommand("kling", args, (settings.timeoutSeconds ?? 120) * 1000 + 30_000)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new ToolError(
        "the `kling` command was not found. Install it with: npm i -g @klingai/cli-global, then run `kling login`.",
      )
    }
    throw new ToolError(`could not run the kling CLI: ${(error as Error).message}`)
  }

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-4).join(" ")
    throw new ToolError(
      `the kling CLI failed (exit ${result.code}). ${detail}`.trim() +
        (result.stderr.includes("login") || result.stdout.includes("login")
          ? " Run `kling login` to sign in again."
          : ""),
    )
  }

  let payload: any
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    payload = undefined
  }

  const url =
    payload?.works?.find((work: any) => work?.url)?.url ??
    payload?.works?.[0]?.url ??
    findUrl(result.stdout)
  if (!url) {
    throw new ToolError(
      `the kling CLI did not return an image URL. Output: ${result.stdout.trim().slice(0, 300) || "(empty)"}`,
    )
  }

  const bytes = await download(url)
  await diskMutate({ path: destination, content: bytes.toString("base64"), encoding: "base64" })
  return { model, credits: payload?.creditsConsumed }
}

/** Any OpenAI-compatible image endpoint. */
async function generateWithOpenAI(
  settings: ImageSettings,
  prompt: string,
  destination: string,
  size: string | undefined,
): Promise<{ model: string }> {
  const base = (settings.baseURL ?? "").replace(/\/+$/, "")
  if (!base) {
    throw new ToolError(
      'no image endpoint is set. Add one to the config: {"image": {"provider": "openai-compatible", "baseURL": "https://.../v1", "apiKey": "..."}}',
    )
  }
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`

  const body: Record<string, unknown> = { prompt, n: 1 }
  if (settings.model) body.model = settings.model
  if (size) body.size = size

  const response = await fetch(`${base}/images/generations`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new ToolError(`the image endpoint returned HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new ToolError("the image endpoint did not return valid JSON")
  }

  const first = payload?.data?.[0]
  if (!first) throw new ToolError("the image endpoint returned no image data")
  if (first.b64_json) {
    await diskMutate({ path: destination, content: first.b64_json, encoding: "base64" })
  } else if (first.url) {
    const bytes = await download(first.url)
    await diskMutate({ path: destination, content: bytes.toString("base64"), encoding: "base64" })
  } else {
    throw new ToolError("the image endpoint returned neither b64_json nor a url")
  }
  return { model: settings.model ?? "default" }
}

/** The image tool. */
export function createImageTool(settings: ImageSettings): Tool {
  return {
    name: "image",
    description:
      "Generate an image from a text description and save it into the project. " +
      "The file is written under the generated-assets folder and the path is returned.",
    permissionAction: "image",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the image should show." },
        path: { type: "string", description: "Optional file name to save as, relative to the output folder." },
        size: { type: "string", description: "Optional size, for example 1024x1024. OpenAI-compatible endpoints only." },
      },
      required: ["prompt"],
    },
    async run(args: any, context: ToolContext): Promise<ToolResult> {
      const prompt = String(args.prompt ?? "").trim()
      if (!prompt) throw new ToolError("prompt must not be empty")
      if (!settings.provider || settings.provider === "none") {
        throw new ToolError(
          "image generation is not configured. Set it in the config file: " +
            '{"image": {"provider": "kling", "model": "<name>"}} or {"image": {"provider": "openai-compatible", "baseURL": "..."}}',
        )
      }

      const outputDir = settings.outputDir ?? DEFAULT_OUTPUT_DIR
      const name = args.path ? String(args.path) : `${slugify(prompt)}-${timestamp()}.png`
      const relative = path.posix.join(outputDir, name)
      const target = ensureInsideProject(context.projectRoot, relative)

      const outcome = await context.requestPermission({
        action: "image",
        resource: prompt,
        summary: `Generate an image: ${prompt.slice(0, 80)}`,
        detail: `Saved to ${relative}`,
        alwaysPatterns: [],
      })
      if (!outcome.granted) {
        return declinedResult("the image generation", outcome)
      }

      if (settings.provider === "kling") {
        const result = await generateWithKling(settings, prompt, target.absolute)
        return {
          output: `Generated ${relative} with Kling (${result.model}).`,
          meta: { path: relative, provider: "kling", model: result.model },
        }
      }

      const result = await generateWithOpenAI(settings, prompt, target.absolute, args.size ? String(args.size) : undefined)
      return {
        output: `Generated ${relative} with ${result.model}.`,
        meta: { path: relative, provider: settings.provider, model: result.model },
      }
    },
  }
}
