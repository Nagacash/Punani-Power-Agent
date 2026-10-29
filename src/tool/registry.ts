import { bashTool } from "./bash.js"
import { devTool } from "./dev.js"
import { createImageTool, type ImageSettings } from "./image.js"
import { createAudioTool, type AudioSettings } from "./audio.js"
import { editTool, writeTool } from "./edit-tools.js"
import { globTool, grepTool, readTool } from "./fs-tools.js"
import { astGrepTool, isAstGrepAvailable } from "./ast-grep.js"
import { fetchUrlTool } from "./fetch-url.js"
import type { Tool } from "./types.js"

/**
 * The tool set exposed to the model.
 *
 * The image tool is only added when a backend is configured, so the model is
 * never told about a capability that cannot work.
 */
type SettingsSource<T> = T | (() => T)

function resolve<T>(source: SettingsSource<T> | undefined): () => T {
  if (typeof source === "function") return source as () => T
  const value = source as T
  return () => value
}

export function buildTools(
  image?: SettingsSource<ImageSettings>,
  audio?: SettingsSource<AudioSettings>,
  mcp: Tool[] = [],
): Tool[] {
  const getImage = resolve(image ?? ({ provider: "none" } satisfies ImageSettings))
  const getAudio = resolve(audio ?? ({ provider: "none" } satisfies AudioSettings))
  const tools: Tool[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool, devTool, fetchUrlTool]
  // The structural search is only offered when the binary is there, so the
  // model is never told about a tool that cannot run.
  if (isAstGrepAvailable()) tools.push(astGrepTool)
  const imageNow = getImage()
  const audioNow = getAudio()
  if (imageNow.provider && imageNow.provider !== "none") tools.push(createImageTool(getImage))
  if (audioNow.provider && audioNow.provider !== "none") tools.push(createAudioTool(getAudio))
  tools.push(...mcp)
  return tools
}

export const BUILTIN_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
  devTool,
  fetchUrlTool,
]
if (isAstGrepAvailable()) BUILTIN_TOOLS.push(astGrepTool)

export function toolsByName(): Map<string, Tool> {
  return new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]))
}

export * from "./types.js"
export * from "./diff.js"
