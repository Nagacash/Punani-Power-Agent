import path from "node:path"
import { spawn } from "node:child_process"
import { ToolError, diskMutate, ensureInsideProject } from "./fsutil.js"
import { declinedResult, type Tool, type ToolContext, type ToolResult } from "./types.js"
import { pickKlingAssetUrl } from "./image.js"

/**
 * Short video generation (Kling CLI).
 *
 * Same auth and polling model as image: `kling text_to_video`, JSON on stdout.
 */

export interface VideoSettings {
  provider: "kling" | "none"
  model?: string
  outputDir?: string
  timeoutSeconds?: number
  /** Default duration in seconds when the tool omits `duration` (Kling often allows 5 or 10). */
  defaultDurationSeconds?: number
}

const DEFAULT_OUTPUT_DIR = "assets/generated"

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "video"
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

/** @internal */
export function resolveVideoOutputPath(
  outputDir: string,
  pathArg: string | undefined,
  defaultName: string,
): string {
  if (!pathArg) return path.posix.join(outputDir, defaultName)
  const name = pathArg.replace(/\\/g, "/").replace(/^\/+/, "")
  if (name.startsWith(`${outputDir}/`) || name === outputDir) return name
  if (name.includes("/")) return name
  return path.posix.join(outputDir, name)
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

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new ToolError(`could not download the video: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function generateWithKling(
  settings: VideoSettings,
  prompt: string,
  destination: string,
  durationSeconds: number,
): Promise<{ credits?: number; model: string; watermarkFree: boolean }> {
  const model = settings.model
  if (!model) {
    throw new ToolError(
      "no video model is set. Run `kling who_am_i` for `text_to_video` models, then set one in the config: " +
        '{"video": {"provider": "kling", "model": "<name>"}}',
    )
  }

  const poll = String(settings.timeoutSeconds ?? 180)
  const args = [
    "text_to_video",
    "--model",
    model,
    "--duration",
    String(durationSeconds),
    "--poll",
    poll,
    prompt,
  ]
  let result: { code: number | null; stdout: string; stderr: string }
  try {
    result = await runCommand("kling", args, (settings.timeoutSeconds ?? 180) * 1000 + 60_000)
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

  const picked = pickKlingAssetUrl(payload, result.stdout)
  if (!picked) {
    throw new ToolError(
      `the kling CLI did not return a video URL. Output: ${result.stdout.trim().slice(0, 300) || "(empty)"}`,
    )
  }

  const bytes = await download(picked.url)
  await diskMutate({ path: destination, content: bytes.toString("base64"), encoding: "base64" })
  return {
    model,
    credits: payload?.creditsConsumed,
    watermarkFree: picked.watermarkFree,
  }
}

/** The video tool. */
export function createVideoTool(getSettings: () => VideoSettings): Tool {
  return {
    name: "video",
    description:
      "Generate a short video from a text description and save it into the project (MP4 under the generated-assets folder). " +
      "Uses the Kling CLI when configured. Prefer a concise prompt and an explicit duration when the user cares about cost.",
    permissionAction: "video",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the video should show (motion, style, length intent)." },
        path: { type: "string", description: "Optional file name to save as, relative to the output folder (.mp4)." },
        duration: {
          type: "number",
          description: "Clip length in seconds. Kling models often allow 5 or 10; omit to use config defaultDurationSeconds or 5.",
        },
      },
      required: ["prompt"],
    },
    async run(args: any, context: ToolContext): Promise<ToolResult> {
      const settings = getSettings()
      const prompt = String(args.prompt ?? "").trim()
      if (!prompt) throw new ToolError("prompt must not be empty")
      if (!settings.provider || settings.provider === "none") {
        throw new ToolError(
          "video generation is not configured. Set it in the config file or run: " +
            "/video kling <model> — then try again.",
        )
      }

      let duration = Number(args.duration)
      if (!Number.isFinite(duration) || duration <= 0) {
        const d = settings.defaultDurationSeconds
        duration = Number.isFinite(d) && d! > 0 ? d! : 5
      }
      duration = Math.round(duration)

      const outputDir = settings.outputDir ?? DEFAULT_OUTPUT_DIR
      const relative = resolveVideoOutputPath(
        outputDir,
        args.path ? String(args.path) : undefined,
        `${slugify(prompt)}-${timestamp()}.mp4`,
      )
      const target = ensureInsideProject(context.projectRoot, relative)

      const outcome = await context.requestPermission({
        action: "video",
        resource: prompt,
        summary: `Generate a video (${duration}s): ${prompt.slice(0, 80)}`,
        detail: `Saved to ${relative}`,
        alwaysPatterns: [],
      })
      if (!outcome.granted) {
        return declinedResult("the video generation", outcome)
      }

      if (settings.provider === "kling") {
        const result = await generateWithKling(settings, prompt, target.absolute, duration)
        const wmNote = result.watermarkFree
          ? ""
          : " Note: Kling did not return a watermark-free URL for this account; upgrade/credits may be required for clean exports."
        return {
          output: `Generated ${relative} with Kling (${result.model}, ${duration}s).${wmNote}`,
          meta: { path: relative, provider: "kling", model: result.model },
        }
      }

      throw new ToolError("unsupported video provider")
    },
  }
}
