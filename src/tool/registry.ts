import { bashTool } from "./bash.js"
import { createImageTool, type ImageSettings } from "./image.js"
import { createAudioTool, type AudioSettings } from "./audio.js"
import { editTool, writeTool } from "./edit-tools.js"
import { globTool, grepTool, readTool } from "./fs-tools.js"
import type { Tool } from "./types.js"

/**
 * The tool set exposed to the model.
 *
 * The image tool is only added when a backend is configured, so the model is
 * never told about a capability that cannot work.
 */
export function buildTools(
  image?: ImageSettings,
  audio?: AudioSettings,
  mcp: Tool[] = [],
): Tool[] {
  const tools: Tool[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool]
  if (image && image.provider && image.provider !== "none") tools.push(createImageTool(image))
  if (audio && audio.provider && audio.provider !== "none") tools.push(createAudioTool(audio))
  tools.push(...mcp)
  return tools
}

export const BUILTIN_TOOLS: Tool[] = [readTool, writeTool, editTool, globTool, grepTool, bashTool]

export function toolsByName(): Map<string, Tool> {
  return new Map(BUILTIN_TOOLS.map((tool) => [tool.name, tool]))
}

export * from "./types.js"
export * from "./diff.js"
