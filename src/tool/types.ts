import type { ToolDefinition } from "../llm/client.js"

/**
 * A tool the model can call.
 *
 * `run` receives already-validated arguments. Anything destructive must go
 * through the permission gate before `run` is called; the tool layer itself
 * never writes to disk without that gate.
 */
/** A change to one file. */
export interface FileChange {
  /** Absolute path. */
  path: string
  /** The full new content. */
  content: string
  /** The content before the change, when it is known. */
  previous?: string
  /** How to read the content. Binary media is carried as base64. */
  encoding?: "utf8" | "base64"
  /** Why the file is changing, for the editor's diff title. */
  reason?: string
}

export interface ToolContext {
  /** Absolute project root. */
  projectRoot: string
  /** Ask the user for permission. Resolves true when the action may proceed. */
  requestPermission: (request: PermissionRequest) => Promise<PermissionOutcome>
  /** Report progress to the user, e.g. "applying edit to src/a.ts". */
  notify: (message: string) => void
  /**
   * Show the user what a change will look like, before it is written.
   * The UI renders the diff; the tool layer just hands over the two versions.
   */
  previewDiff: (path: string, before: string, after: string) => void
  /**
   * Point the preview pane at a running dev server.
   * Optional: not every front end has a preview.
   */
  setPreview?: (url: string) => void
  /**
   * Apply a change to a file.
   *
   * The terminal writes it. An editor shows it as a diff and applies it only
   * if the user accepts. This is what keeps the agent inside the editor's
   * review workflow instead of writing behind its back.
   */
  mutate: (change: FileChange) => Promise<{ applied: boolean; reason?: string }>
  /** Abort signal, set when the user cancels. */
  signal?: AbortSignal
}

export interface PermissionRequest {
  /** Permission action, e.g. "bash", "edit", "write", "read". */
  action: string
  /** The concrete resource being acted on, e.g. the command or the file path. */
  resource: string
  /** Extra context shown to the user. */
  detail?: string
  /** A short human summary of what will happen. */
  summary: string
  /** True when the action can destroy data. Drives the extra warning. */
  destructive?: boolean
  /** Patterns that "always allow" would whitelist. */
  alwaysPatterns?: string[]
}

export interface PermissionOutcome {
  granted: boolean
  /** Remember the decision for the rest of the session. */
  remember?: boolean
  /** Patterns to remember, when the user chose "always". */
  patterns?: string[]
  /** User feedback when rejecting, fed back to the model. */
  message?: string
}

export interface ToolResult {
  /** Text handed back to the model. */
  output: string
  /**
   * An image the model should look at, when the file is a picture and the
   * model can see. Sent as an image part alongside the text.
   */
  image?: { mime: string; data: string }
  /** True when the tool failed; the model is told about the error. */
  isError?: boolean
  /** Optional metadata for the session log. */
  meta?: Record<string, unknown>
}

export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Permission action this tool is gated by. */
  permissionAction: string
  run: (args: any, context: ToolContext) => Promise<ToolResult>
}

export function toDefinition(tool: Tool): ToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
