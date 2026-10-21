import path from "node:path"
import { ToolError, ensureInsideProject } from "./fsutil.js"
import { extensionFor, synthesize } from "../provider/elevenlabs.js"
import { declinedOutput, type Tool, type ToolContext, type ToolResult } from "./types.js"

/**
 * Speech generation.
 *
 * The model writes a script and calls this tool; the audio is saved into the
 * project so it can be played, opened or shipped.
 */

export interface AudioSettings {
  provider: "elevenlabs" | "none"
  apiKey?: string
  /** ElevenLabs model id, e.g. eleven_multilingual_v2. */
  model?: string
  /** ElevenLabs voice id. */
  voiceId?: string
  /** Human name of the voice, for display. */
  voiceName?: string
  /** Where files are written, relative to the project root. */
  outputDir?: string
  /** ElevenLabs output format, e.g. mp3_44100_128. */
  outputFormat?: string
  stability?: number
  speed?: number
}

const DEFAULT_OUTPUT_DIR = "assets/audio"

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return slug || "narration"
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

export function createAudioTool(settings: AudioSettings): Tool {
  return {
    name: "audio",
    description:
      "Turn a script into speech and save the audio file into the project. " +
      "Use this for narration, voiceovers, documentation audio or any spoken output.",
    permissionAction: "audio",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The script to read out." },
        path: { type: "string", description: "Optional file name to save as, relative to the output folder." },
        voice: { type: "string", description: "Optional ElevenLabs voice id, overriding the configured one." },
        model: { type: "string", description: "Optional ElevenLabs model id, overriding the configured one." },
        speed: { type: "number", description: "Optional speaking speed, roughly 0.7 to 1.2." },
      },
      required: ["text"],
    },
    async run(args: any, context: ToolContext): Promise<ToolResult> {
      const text = String(args.text ?? "").trim()
      if (!text) throw new ToolError("text must not be empty")
      if (!settings.provider || settings.provider === "none") {
        throw new ToolError(
          "speech generation is not configured. Set it up with: /audio key <your-elevenlabs-key>",
        )
      }

      const outputDir = settings.outputDir ?? DEFAULT_OUTPUT_DIR
      const extension = extensionFor(settings.outputFormat)
      const name = args.path ? String(args.path) : `${slugify(text)}-${timestamp()}.${extension}`
      const relative = path.posix.join(outputDir, name)
      const target = ensureInsideProject(context.projectRoot, relative)

      const outcome = await context.requestPermission({
        action: "audio",
        resource: text.slice(0, 120),
        summary: `Generate speech (${text.length} characters)`,
        detail: `Saved to ${relative}${settings.voiceName ? ` with the voice "${settings.voiceName}"` : ""}`,
        alwaysPatterns: [],
      })
      if (!outcome.granted) {
        return {
          output: declinedOutput("the audio generation", outcome.message),
          isError: true,
        }
      }

      const result = await synthesize(settings.apiKey ?? "", {
        text,
        voiceId: args.voice ? String(args.voice) : (settings.voiceId ?? ""),
        modelId: args.model ? String(args.model) : settings.model,
        outputFormat: settings.outputFormat,
        stability: settings.stability,
        speed: args.speed !== undefined ? Number(args.speed) : settings.speed,
      })

      const applied = await context.mutate({
        path: target.absolute,
        content: result.audio.toString("base64"),
        encoding: "base64",
        reason: "generated speech",
      })
      if (!applied.applied) {
        throw new ToolError(`the audio was not saved${applied.reason ? `: ${applied.reason}` : "."}`)
      }

      return {
        output: `Generated ${relative} (${result.audio.length} bytes of ${result.contentType}).`,
        meta: { path: relative, provider: "elevenlabs", model: settings.model, voice: settings.voiceId },
      }
    },
  }
}
