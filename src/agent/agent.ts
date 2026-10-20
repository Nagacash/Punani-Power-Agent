import path from "node:path"
import fs from "node:fs"
import type { ChatMessage, LlmClient, ToolCall } from "../llm/client.js"
import { LlmError } from "../llm/errors.js"
import type { ModelInfo } from "../provider/types.js"
import { estimateCost } from "../provider/types.js"
import { toDefinition, type Tool, type ToolContext, type ToolResult } from "../tool/types.js"

/** The system prompt. It states the operating rules the agent must follow. */
export function buildSystemPrompt(
  projectRoot: string,
  capabilities: { image?: boolean; audio?: boolean; vision?: boolean } = {},
  catalog: string = "",
  instructions: string = "",
): string {
  const relative = path.relative(process.cwd(), projectRoot) || "."
  const rules = [
    `You are Punani powerd, a terminal coding agent by Naga Codex, working inside the project at ${relative}.`,
    "",
    "Operating rules:",
    "- Use the tools to inspect and change files. Do not guess file contents; read them first.",
    "- Prefer `edit` over `write` for changes to existing files. `write` replaces a whole file.",
    "- Never invent file paths. Use `glob` or `grep` to find them.",
    "- Shell commands need the user's approval. Explain in one line why a command is needed.",
    "- Make the smallest change that solves the problem. Match the surrounding code style.",
    "- After editing, state clearly what changed and whether it was verified.",
    "- If a task needs information you cannot get from the tools, say so plainly.",
    "",
    "How to write:",
    "- Plain prose. No markdown: no **bold**, no # headings, no ``` code fences, no tables.",
    "  The reply is read as plain text, so markdown syntax shows up as noise.",
    "- Short paragraphs, one idea each. A sentence or two beats a wall of text.",
    "- When something fails, say what failed, why it failed, and what to do next.",
    "  Never answer with a bare error string like 'connection refused'.",
    "- Put commands, paths and code in backticks so they read as one item.",
  ]

  const media: string[] = []
  if (capabilities.image) {
    media.push(
      "- You can generate images with the `image` tool. Use it when a page, diagram or asset needs a picture rather than a placeholder.",
    )
  }
  if (capabilities.audio) {
    media.push(
      "- You can turn a written script into speech with the `audio` tool. Write the script as narration the listener should hear.",
    )
  }
  if (capabilities.vision) {
    media.push(
      "- You can see images. After generating a picture, read it back with `read` to check it, then iterate on the prompt until it is right.",
    )
  }
  if (media.length > 0) {
    rules.push("", "Media:", ...media)
  }
  if (instructions) {
    rules.push("", instructions)
  }
  if (catalog) {
    rules.push("", catalog)
  }

  return rules.join("\n")
}

export interface AgentEvent {
  type: "assistant_text" | "reasoning" | "tool_start" | "tool_end" | "error" | "usage" | "done"
  text?: string
  /** True when `text` is a streaming chunk, not the full reply. */
  partial?: boolean
  tool?: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: ToolResult
  error?: LlmError
  usage?: { inputTokens: number; outputTokens: number; cost: number }
}

export interface AgentOptions {
  client: LlmClient
  model: ModelInfo
  tools: Tool[]
  projectRoot: string
  context: ToolContext
  maxSteps?: number
  signal?: AbortSignal
  onEvent?: (event: AgentEvent) => void
}

export interface AgentTurnResult {
  messages: ChatMessage[]
  usage: { inputTokens: number; outputTokens: number; cost: number }
  stoppedReason: "finished" | "max_steps" | "aborted" | "error"
  error?: LlmError
}

/**
 * The agent loop.
 *
 * Sends the conversation to the model, runs whatever tools it asks for, feeds
 * the results back, and repeats until the model answers without asking for a
 * tool. Tool failures are reported back to the model rather than aborting the
 * turn, so the model can correct itself.
 */
export async function runAgentTurn(options: AgentOptions, history: ChatMessage[]): Promise<AgentTurnResult> {
  const { client, model, tools, context, signal } = options
  const maxSteps = options.maxSteps ?? 40
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
  const messages: ChatMessage[] = [...history]
  let inputTokens = 0
  let outputTokens = 0

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "aborted" }
    }

    let completion
    let streamedText = false
    try {
      completion = await client.complete({
        model: model.id,
        messages,
        tools: tools.map(toDefinition),
        signal,
        onToken: options.onEvent
          ? (delta) => {
              streamedText = true
              options.onEvent?.({ type: "assistant_text", text: delta, partial: true })
            }
          : undefined,
      })
    } catch (error) {
      const llmError =
        error instanceof LlmError
          ? error
          : new LlmError({
              kind: "unknown",
              message: error instanceof Error ? error.message : String(error),
              providerID: model.providerID,
              modelID: model.id,
            })
      options.onEvent?.({ type: "error", error: llmError })
      return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "error", error: llmError }
    }

    inputTokens += completion.usage.inputTokens
    outputTokens += completion.usage.outputTokens

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
    }
    messages.push(assistantMessage)
    if (completion.reasoning) {
      options.onEvent?.({ type: "reasoning", text: completion.reasoning })
    }
    if (completion.content.trim() && !streamedText) {
      options.onEvent?.({ type: "assistant_text", text: completion.content })
    }

    if (completion.toolCalls.length === 0) {
      options.onEvent?.({ type: "usage", usage: usageOf(inputTokens, outputTokens, model) })
      return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "finished" }
    }

    for (const call of completion.toolCalls) {
      await runToolCall(call, toolMap, context, messages, options)
      if (signal?.aborted) {
        return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "aborted" }
      }
    }
  }

  options.onEvent?.({ type: "usage", usage: usageOf(inputTokens, outputTokens, model) })
  return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "max_steps" }
}

async function runToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  context: ToolContext,
  messages: ChatMessage[],
  options: AgentOptions,
): Promise<void> {
  const model = options.model
  const emit = options.onEvent
  let args: any = {}
  try {
    args = call.arguments ? JSON.parse(call.arguments) : {}
  } catch {
    const result: ToolResult = {
      output: `The arguments for ${call.name} were not valid JSON. Send a JSON object.`,
      isError: true,
    }
    emit?.({ type: "tool_start", tool: call.name, toolCallId: call.id })
    emit?.({ type: "tool_end", tool: call.name, toolCallId: call.id, result })
    messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name })
    return
  }

  emit?.({ type: "tool_start", tool: call.name, toolCallId: call.id, args })

  const tool = toolMap.get(call.name)
  let result: ToolResult
  if (!tool) {
    result = {
      output: `Unknown tool "${call.name}". Available tools: ${[...toolMap.keys()].join(", ")}.`,
      isError: true,
    }
  } else {
    try {
      result = await tool.run(args, context)
    } catch (error) {
      result = { output: `The ${call.name} tool failed: ${(error as Error).message}`, isError: true }
    }
  }

  emit?.({ type: "tool_end", tool: call.name, toolCallId: call.id, result })

  // A picture the model can see is sent as an image part, so the agent can
  // look at what it just made and refine it.
  if (result.image && model?.vision) {
    messages.push({
      role: "tool",
      content: [
        { type: "text", text: result.output },
        { type: "image_url", image_url: { url: `data:${result.image.mime};base64,${result.image.data}` } },
      ],
      toolCallId: call.id,
      name: call.name,
    })
    return
  }
  if (result.image && !model?.vision) {
    result.output += " (this model cannot see images, so it was not attached)"
  }

  messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name })
}

function usageOf(inputTokens: number, outputTokens: number, model: ModelInfo) {
  return { inputTokens, outputTokens, cost: estimateCost(model.cost, inputTokens, outputTokens) }
}

/** Collect the project context shown in the header: name, git branch, file count. */
export function describeProject(root: string): { name: string; branch?: string; dirty?: boolean; fileCount?: number } {
  const name = path.basename(root)
  let branch: string | undefined
  let dirty: boolean | undefined
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim()
    if (head.startsWith("ref:")) {
      branch = head.replace("ref: refs/heads/", "")
      const status = fs.readFileSync(path.join(root, ".git", "status"), "utf8")
      dirty = !status.includes("nothing to commit")
    } else {
      branch = head.slice(0, 8)
    }
  } catch {
    /* not a git repo */
  }
  return { name, branch, dirty }
}
