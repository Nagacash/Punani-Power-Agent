import path from "node:path"
import fs from "node:fs"
import type { ChatClient, ChatMessage, ToolCall } from "../llm/client.js"
import { LlmError } from "../llm/errors.js"
import type { ModelInfo } from "../provider/types.js"
import { estimateCost } from "../provider/types.js"
import { toDefinition, type Tool, type ToolContext, type ToolResult } from "../tool/types.js"
import type { Skill } from "../skills/loader.js"

/** The system prompt. It states the operating rules the agent must follow. */
export interface PromptParts {
  /** The skill index. */
  catalog?: string
  /** The project's own instruction files. */
  instructions?: string
  /** The always-on files: guardrails, tool guidance, memory. */
  alwaysOn?: string
  /** The routing table: which skill answers which situation. */
  routes?: string
}

export function buildSystemPrompt(
  projectRoot: string,
  capabilities: { image?: boolean; audio?: boolean; vision?: boolean } = {},
  parts: PromptParts = {},
): string {
  // A relative path is easier to read, but only while it stays short. A path
  // that climbs out of the current directory is worse than the absolute one.
  const relative = (() => {
    const rel = path.relative(process.cwd(), projectRoot)
    if (!rel || rel.startsWith("..")) return projectRoot
    return rel
  })()
  const rules = [
    `You are Punani powerd, a terminal coding agent by Naga Codex, working inside the project at ${relative}.`,
    "",
    "Answer first:",
    "- The user reads the reply, not your thinking. Keep deliberation in your thinking, never in the reply.",
    "- Lead with the answer or the plan. No preamble, no restating the question, no recap.",
    "- If the question can be answered without tools, answer it and stop. Do not explore the project to be helpful.",
    "- A greeting, an opinion or a question about what you were already shown is answered, not investigated.",
    "",
    "Working in the project:",
    "- Use the tools to inspect and change files. Do not guess file contents; read them first.",
    "- Never invent file paths. Use `glob` or `grep` to find them.",
    "- Prefer `edit` over `write` for changes to existing files. `write` replaces a whole file.",
    "- Use the fewest calls that answer the question. One `bash` command that prints what you need beats three that print it piecemeal.",
    "- Do not explore what one read answers. Do not run a command whose answer you already have:",
    "  a second directory listing, a git log in a directory that is not a repository, a search for a file you were told about.",
    "- When the meaning of the request changes the work, ask one question. Do not go looking for context that is not there.",
    "- Make the smallest change that solves the problem. Match the surrounding code style.",
    "- Never leave scratch files in the project. A throwaway script belongs in the system temp directory.",
    "",
    "The user approves every command and every write:",
    "- Explain in one line why a command is needed, then run it.",
    "- A declined call is a decision. Do not run it another way, do not try a different command for the same result, and do not build a workaround. Say what you need and wait.",
    "",
    "Skills:",
    "- The routing table below says which skill answers which situation. A route that matches the request is a decision, not a hint: load that skill before you start, and follow it.",
    "- Load one skill, not five.",
    "- A skill that needs a repository, a remote or a pipeline that this project does not have is the wrong skill.",
    "  Say so and work without it. Do not load a big workflow for a small task.",
    "- A skill can ask for receipts: the tools the turn has to have used. Produce them before you say you are done.",
    "",
    "How to write:",
    "- Plain prose. No markdown: no **bold**, no # headings, no ``` code fences, no tables.",
    "  The reply is read as plain text, so markdown syntax shows up as noise.",
    "- Short paragraphs, one idea each. A sentence or two beats a wall of text.",
    "- When something fails, say what failed, why it failed, and what to do next.",
    "  Never answer with a bare error string like 'connection refused'.",
    "- Put commands, paths and code in backticks so they read as one item.",
    "- After editing, state clearly what changed and whether it was verified.",
    "- If a task needs information you cannot get from the tools, say so plainly.",
    "",
    "Voice:",
    "- Write like a person, not a chatbot. No 'Great question', no 'I hope this helps', no 'Let me know if'.",
    "- No puffery: delve, leverage, robust, seamless, comprehensive, pivotal, landscape, ensure. Say what happened.",
    "- No 'not just X but Y', no rule of three, no bold label followed by a colon.",
    "- No em dash. Use a comma or a full stop.",
    "- Take a position. Do not hedge every sentence with 'might' or 'could'.",
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
      "- You can see images. Reading a picture shows you the picture itself: look at it before you describe it, and never guess its contents.",
    )
  }
  if (media.length > 0) {
    rules.push("", "Media:", ...media)
  }
  // The routing table goes before the instructions and the index: it is the
  // part that decides which skill the rest of the turn runs on.
  if (parts.routes) {
    rules.push("", parts.routes)
  }
  if (parts.alwaysOn) {
    rules.push("", parts.alwaysOn)
  }
  if (parts.instructions) {
    rules.push("", parts.instructions)
  }
  if (parts.catalog) {
    rules.push("", parts.catalog)
  }

  return rules.join("\n")
}

export interface AgentEvent {
  type: "assistant_text" | "reasoning" | "tool_start" | "tool_end" | "error" | "usage" | "done" | "notice"
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
  client: ChatClient
  model: ModelInfo
  tools: Tool[]
  projectRoot: string
  context: ToolContext
  /** The skill library, so the turn can check what a loaded skill asked for. */
  skills?: Skill[]
  /** How hard a reasoning model is asked to think. */
  reasoningEffort?: "low" | "medium" | "high"
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
  // What the turn actually did, so a skill's receipts can be checked.
  const turn: TurnState = { loadedSkills: [], toolsUsed: new Set() }

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "aborted" }
    }

    let completion
    let streamedText = false
    let streamedReasoning = false
    try {
      completion = await client.complete({
        model: model.id,
        messages,
        tools: tools.map(toDefinition),
        signal,
        reasoningEffort: options.reasoningEffort,
        onToken: options.onEvent
          ? (delta) => {
              streamedText = true
              options.onEvent?.({ type: "assistant_text", text: delta, partial: true })
            }
          : undefined,
        onReasoning: options.onEvent
          ? (delta) => {
              streamedReasoning = true
              options.onEvent?.({ type: "reasoning", text: delta, partial: true })
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
    if (completion.reasoning && !streamedReasoning) {
      options.onEvent?.({ type: "reasoning", text: completion.reasoning })
    }
    if (completion.content.trim() && !streamedText) {
      options.onEvent?.({ type: "assistant_text", text: completion.content })
    }

    if (completion.toolCalls.length === 0) {
      options.onEvent?.({ type: "usage", usage: usageOf(inputTokens, outputTokens, model) })
      checkReceipts(options, turn.loadedSkills, turn.toolsUsed)
      return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "finished" }
    }

    for (const call of completion.toolCalls) {
      await runToolCall(call, toolMap, context, messages, options, turn)
      if (signal?.aborted) {
        return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "aborted" }
      }
    }
  }

  options.onEvent?.({ type: "usage", usage: usageOf(inputTokens, outputTokens, model) })
  return { messages, usage: usageOf(inputTokens, outputTokens, model), stoppedReason: "max_steps" }
}

/** What the turn did, so a skill's receipts can be checked at the end. */
interface TurnState {
  /** The skills the model loaded, by name. */
  loadedSkills: string[]
  /** The tools the model called. */
  toolsUsed: Set<string>
}

async function runToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  context: ToolContext,
  messages: ChatMessage[],
  options: AgentOptions,
  turn: TurnState,
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
  turn.toolsUsed.add(call.name)
  if (call.name === "skill_load") {
    const loaded = String(args?.name ?? "").toLowerCase()
    if (loaded && !turn.loadedSkills.includes(loaded)) turn.loadedSkills.push(loaded)
  }

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

  // A picture the model can see is sent as an image part, so the agent can
  // look at what it just made and refine it.
  if (result.image && !model?.vision) {
    result.output += " (this model cannot see images, so it was not attached. Say so, do not build a workaround.)"
    result.isError = true
  }

  emit?.({ type: "tool_end", tool: call.name, toolCallId: call.id, result })

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

  messages.push({ role: "tool", content: result.output, toolCallId: call.id, name: call.name })
}

/**
 * Check the receipts a loaded skill asked for.
 *
 * A receipt is a tool the turn had to use. The agent is told when one is
 * missing, so a claim of "done" can be checked against what happened.
 */
function checkReceipts(options: AgentOptions, loaded: string[], used: Set<string>): void {
  const skills = options.skills
  if (!skills || loaded.length === 0) return
  for (const name of loaded) {
    const skill = skills.find((entry) => entry.name === name)
    if (!skill || skill.requiredReceipts.length === 0) continue
    const missing = skill.requiredReceipts.filter((receipt) => !used.has(receipt))
    if (missing.length === 0) continue
    options.onEvent?.({
      type: "notice",
      text: `The ${skill.name} skill asked for ${missing.join(", ")}, and the turn did not use ${missing.length === 1 ? "it" : "them"}.`,
    })
  }
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
