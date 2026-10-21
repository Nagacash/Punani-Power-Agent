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
  /**
   * Directories that may be read from outside the project, such as the skill
   * library. A skill refers to its own files, and the agent has to be able to
   * open them.
   */
  allowedReadDirs?: string[]
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
  /**
   * True when nobody answered at all.
   *
   * That is not a refusal: there is nobody to say no. The turn ends, rather
   * than handing the model a refusal it will argue with and retry.
   */
  unanswered?: boolean
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
  /**
   * True when the turn should end here.
   *
   * Set when the user did not answer, or when the model asked for the same
   * thing twice after a refusal. Handing that back to the model starts a
   * loop.
   */
  stop?: boolean
  /** Optional metadata for the session log. */
  meta?: Record<string, unknown>
}

/**
 * What the model is told when the user says no.
 *
 * The wording matters as much as the refusal. Left to itself, a model treats
 * "no" as an obstacle and finds another route to the same result. This says
 * plainly that the answer is final, and that the right move is to ask.
 */
export function declinedOutput(what: string, feedback?: string): string {
  const base =
    `The user declined ${what}. That is the final answer: do not try again, ` +
    `do not reach the same result another way, and do not build a workaround. ` +
    `Say what you need and wait.`
  return feedback ? `${base} Feedback: ${feedback}` : base
}

/**
 * What a tool returns when the user said no, or said nothing.
 *
 * A refusal goes back to the model, because the model has to know. Nobody
 * answering does not: the turn ends there, so the model is not given a
 * refusal to argue with and retry for ever.
 */
export function declinedResult(what: string, outcome: PermissionOutcome): ToolResult {
  if (outcome.unanswered) {
    return {
      output:
        `The user did not answer the request ${what}, so the turn stops here. ` +
        "Say what you need and wait for the answer.",
      isError: true,
      stop: true,
    }
  }
  return { output: declinedOutput(what, outcome.message), isError: true }
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
