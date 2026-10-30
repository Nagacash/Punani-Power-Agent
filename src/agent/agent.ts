import path from "node:path"
import fs from "node:fs"
import { log } from "../core/logger.js"
import type { ChatClient, ChatMessage, ToolCall } from "../llm/client.js"
import { LlmError } from "../llm/errors.js"
import type { ModelInfo } from "../provider/types.js"
import { estimateCost, modelKey } from "../provider/types.js"
import { toDefinition, type Tool, type ToolContext, type ToolResult } from "../tool/types.js"
import { compactConversation, shouldCompact } from "./compact.js"
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
    "- Lead with the answer or the plan. No empty preamble and no restating the question word for word.",
    "- If the question can be answered without tools, answer it and stop. Do not explore the project to be helpful.",
    "- A public site (for example punani.agency) is not in the repo unless you read those files here. Use `fetch_url` for a normal page, or load scrapling-official when the skill routes say so.",
    "- For `bash`, the workdir is relative to the project root (usually \".\"). Never pass an absolute path as workdir.",
    "- A greeting, an opinion or a question about what you were already shown is answered, not investigated.",
    "- Match depth to the ask: one line for a hello, a short structured recap after real tool work.",
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
    "How the work gets done:",
    "- Reading, writing a file, editing it and running a command go through. Do not ask for permission, and do not narrate the steps: do the work.",
    "- The app asks the user when a change can lose work: overwriting a file, rewriting one, or a command that deletes or publishes. That is the only time to stop and say why, in one line.",
    "- A declined call is a decision. Do not run it another way, do not try a different command for the same result, and do not build a workaround. Say what you need and wait.",
    "",
    "Skills:",
    "- The routing table below says which skill answers which situation. A route that matches the request is a decision, not a hint: load that skill before you start, and follow it.",
    "- Load one skill, not five.",
    "- A skill that needs a repository, a remote or a pipeline that this project does not have is the wrong skill.",
    "  Say so and work without it. Do not load a big workflow for a small task.",
    "- A skill can ask for receipts: the tools the turn has to have used. Produce them before you say you are done.",
    "",
    "Closing a turn:",
    "- When you used tools, end with a brief recap: what changed, what you verified, and what is still blocked.",
    "- The user should not have to ask whether you finished. If nothing changed, say that plainly.",
    "",
    "How to write (Cursor-style, plain text UI):",
    "- Write like a strong IDE pair-programmer: complete sentences, precise, easy to scan.",
    "- Use short paragraphs. Use `- ` bullet lines for steps, options, or lists of files.",
    "- Do not use # headings, **bold**, tables, or ``` code fences. The terminal and browser strip markdown syntax.",
    "- Put commands, paths, and code identifiers in backticks.",
    "- When something fails, say what failed, why, and what to do next.",
    "  Never answer with a bare error string like 'connection refused'.",
    "- If a task needs information you cannot get from the tools, say so plainly.",
    "",
    "Voice:",
    "- Direct colleague tone, not a chatbot. No 'Great question', no 'I hope this helps', no 'Let me know if'.",
    "- No puffery: delve, leverage, robust, seamless, comprehensive, pivotal, landscape, ensure. Say what happened.",
    "- No engagement bait or forced follow-up questions at the end.",
    "- No em dash. Use a comma or a full stop.",
    "- Take a position when the evidence supports it; say when you are unsure.",
    "- If the user steers mid-task, treat it as refinement unless they clearly change direction.",
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
  type: "assistant_text" | "reasoning" | "tool_start" | "tool_end" | "error" | "usage" | "done" | "notice" | "summary"
  text?: string
  /** True when `text` is a streaming chunk, not the full reply. */
  partial?: boolean
  tool?: string
  toolCallId?: string
  args?: Record<string, unknown>
  result?: ToolResult
  error?: LlmError
  usage?: { inputTokens: number; outputTokens: number; cost: number }
  /** What the turn actually did, so the user does not have to guess. */
  summary?: { changed: string[]; commands: string[] }
}

/** A client and model to carry on with after a provider refused the request. */
export interface AgentFallbackResult {
  client: ChatClient
  model: ModelInfo
}

/**
 * Called when a provider throttles the request.
 *
 * It returns where to go next, or nothing when there is nowhere to go. The
 * turn then fails the way it would have without a fallback.
 */
export type AgentFallback = (
  error: LlmError,
  failed: ModelInfo,
) => Promise<AgentFallbackResult | undefined>

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
  /** The share of the context window a conversation may fill. Lower folds it sooner. */
  compactionLimit?: number
  maxSteps?: number
  signal?: AbortSignal
  /** Moves the turn to another model when the provider refuses the request. */
  fallback?: AgentFallback
  onEvent?: (event: AgentEvent) => void
}

/** What one model call cost. */
export interface AgentStepUsage {
  inputTokens: number
  outputTokens: number
  cost: number
  /** The model that took the call. */
  model: string
  /** The provider it came from. */
  provider: string
}

export interface AgentTurnResult {
  /** The conversation as the model sees it, with the system prompt first. */
  messages: ChatMessage[]
  /**
   * The messages this turn added. The history before the turn is not in
   * here, so a session log does not record the same answer twice.
   */
  added: ChatMessage[]
  /** The cost of the whole turn. */
  usage: { inputTokens: number; outputTokens: number; cost: number }
  /**
   * The usage of each model call, in the order the calls happened. One
   * entry per answer, so a transcript can say what each step cost instead
   * of the turn total on every line.
   */
  steps: AgentStepUsage[]
  /** What the summary call cost, when the conversation was folded. */
  compaction?: AgentStepUsage
  stoppedReason: "finished" | "max_steps" | "aborted" | "declined" | "error"
  error?: LlmError
}

/**
 * The agent loop.
 *
 * Sends the conversation to the model, runs whatever tools it asks for, feeds
 * the results back, and repeats until the model answers without asking for a
 * tool. Tool failures are reported back to the model rather than aborting the
 * turn, so the model can correct itself. A provider that refuses the request
 * hands the turn to another model rather than ending it.
 */

/** How many providers one turn may try before it gives up. */
const MAX_SWITCHES = 3

/** How long to wait before trying the next model after a rate limit. */
const RATE_LIMIT_BACKOFF_MS = 3_000

/** How many tool rounds one turn may take before it stops. */
export const DEFAULT_MAX_STEPS = 40

/** Pause before trying the next model, so a rate-limit window can reset.
 *
 * Honors the turn's abort signal: if the user cancels while waiting, the
 * sleep resolves early and the switch is not attempted. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error("aborted"))
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Pause for ms milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runAgentTurn(options: AgentOptions, history: ChatMessage[]): Promise<AgentTurnResult> {
  const { tools, context, signal } = options
  // The model and its client can change mid-turn, when a provider throttles.
  let client = options.client
  let model = options.model
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]))
  const messages: ChatMessage[] = [...history]
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  let switches = 0
  // What the turn actually did, so a skill's receipts can be checked.
  const turn: TurnState = {
    loadedSkills: [],
    toolsUsed: new Set(),
    refused: new Set(),
    changed: [],
    commands: [],
  }
  // The messages this turn produced, for the session log.
  const added: ChatMessage[] = []
  // What each model call cost, so the transcript can say so per step.
  const steps: AgentStepUsage[] = []
  let compaction: AgentStepUsage | undefined
  const usage = () => ({ inputTokens, outputTokens, cost })

  /**
   * Move the turn to another model when the provider refuses the request.
   *
   * A throttle and an unreachable provider qualify: neither is a failure of
   * the task. A wrong key or a bad request does not, because it fails the
   * same way on every provider, and switching would only hide the problem.
   */
  async function switchModel(error: LlmError): Promise<boolean> {
    if (!options.fallback) return false
    if (signal?.aborted) return false
    if (error.kind !== "rate_limit" && error.kind !== "quota" && error.kind !== "network") return false
    if (switches >= MAX_SWITCHES) return false
    const from = model
    // A rate limit or quota is usually about the provider, not the model:
    // waiting briefly lets the throttle window reset before trying another model.
    if (error.kind === "rate_limit" || error.kind === "quota") {
      try {
        await abortableSleep(RATE_LIMIT_BACKOFF_MS, signal)
      } catch {
        // The turn was cancelled while waiting. Do not attempt the switch.
        return false
      }
    }
    const next = await options.fallback(error, from)
    if (!next) return false
    switches++
    client = next.client
    model = next.model
    options.onEvent?.({
      type: "notice",
      text: `${error.title} on ${modelKey(from)}. Carrying on with ${modelKey(model)}.`,
    })
    return true
  }

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) {
      return { messages, added, usage: usage(), steps, compaction, stoppedReason: "aborted" }
    }

    // A conversation that has grown past the limit is folded into a summary,
    // so the next turn still fits and still costs what it should.
    if (shouldCompact(messages, model, options.compactionLimit ?? 0.5)) {
      const folded = await compactConversation(client, model, messages)
      if (folded.usage) {
        // The summary is a model call too, and it costs tokens. A long turn
        // can fold more than once, so the calls add up.
        const summaryCost = estimateCost(model.cost, folded.usage.inputTokens, folded.usage.outputTokens)
        inputTokens += folded.usage.inputTokens
        outputTokens += folded.usage.outputTokens
        cost += summaryCost
        compaction = {
          inputTokens: (compaction?.inputTokens ?? 0) + folded.usage.inputTokens,
          outputTokens: (compaction?.outputTokens ?? 0) + folded.usage.outputTokens,
          cost: (compaction?.cost ?? 0) + summaryCost,
          model: model.id,
          provider: model.providerID,
        }
      }
      if (folded.folded > 0) {
        messages.length = 0
        messages.push(...folded.messages)
        options.onEvent?.({
          type: "notice",
          text: `Folded ${folded.folded} earlier message(s) into a summary, to keep the conversation within the context window.`,
        })
      }
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
      // A cancelled request is not a failure. The turn was stopped on
      // purpose, so it ends as an abort and not as an error.
      if (signal?.aborted) {
        return { messages, added, usage: usage(), steps, compaction, stoppedReason: "aborted" }
      }
      const llmError =
        error instanceof LlmError
          ? error
          : new LlmError({
              kind: "unknown",
              message: error instanceof Error ? error.message : String(error),
              providerID: model.providerID,
              modelID: model.id,
            })
      // A throttle is not a failure of the task. Move the turn to a model
      // that can answer, and carry on with the same conversation.
      if (await switchModel(llmError)) continue
      // The turn is over and the reason is not in the transcript. Write it
      // down, or nobody can tell later why the run stopped.
      log.error(
        `turn failed on ${llmError.providerID}/${llmError.modelID}: ${llmError.kind} — ${llmError.message}`,
      )
      options.onEvent?.({ type: "error", error: llmError })
      return { messages, added, usage: usage(), steps, compaction, stoppedReason: "error", error: llmError }
    }

    inputTokens += completion.usage.inputTokens
    outputTokens += completion.usage.outputTokens
    const stepCost = estimateCost(model.cost, completion.usage.inputTokens, completion.usage.outputTokens)
    cost += stepCost
    steps.push({
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
      cost: stepCost,
      model: model.id,
      provider: model.providerID,
    })

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: completion.content,
      toolCalls: completion.toolCalls.length ? completion.toolCalls : undefined,
    }
    messages.push(assistantMessage)
    added.push(assistantMessage)
    if (completion.reasoning && !streamedReasoning) {
      options.onEvent?.({ type: "reasoning", text: completion.reasoning })
    }
    if (completion.content.trim() && !streamedText) {
      options.onEvent?.({ type: "assistant_text", text: completion.content })
    }

    if (completion.toolCalls.length === 0) {
      options.onEvent?.({ type: "usage", usage: usage() })
      options.onEvent?.({
        type: "summary",
        summary: { changed: [...turn.changed], commands: [...turn.commands] },
      })
      checkReceipts(options, turn.loadedSkills, turn.toolsUsed)
      return { messages, added, usage: usage(), steps, compaction, stoppedReason: "finished" }
    }

    for (const call of completion.toolCalls) {
      // The same call after a refusal is a loop, not an attempt. Stop.
      if (turn.refused.has(callKey(call))) {
        options.onEvent?.({
          type: "notice",
          text: `${call.name} was already declined. The turn stops here instead of asking again.`,
        })
        return { messages, added, usage: usage(), steps, compaction, stoppedReason: "declined" }
      }
      const result = await runToolCall(call, toolMap, context, messages, options, turn, added, model)
      if (result?.stop) {
        return { messages, added, usage: usage(), steps, compaction, stoppedReason: "aborted" }
      }
      if (signal?.aborted) {
        return { messages, added, usage: usage(), steps, compaction, stoppedReason: "aborted" }
      }
    }
  }

  log.warn(`turn stopped after ${maxSteps} tool steps, to stay within budget`)
  options.onEvent?.({ type: "usage", usage: usage() })
  options.onEvent?.({
    type: "summary",
    summary: { changed: [...turn.changed], commands: [...turn.commands] },
  })
  return { messages, added, usage: usage(), steps, compaction, stoppedReason: "max_steps" }
}

/** What the turn did, so a skill's receipts can be checked at the end. */
interface TurnState {
  /** The skills the model loaded, by name. */
  loadedSkills: string[]
  /** The tools the model called. */
  toolsUsed: Set<string>
  /** The calls the user refused, so the same one is not asked for twice. */
  refused: Set<string>
  /** Files the turn created or edited, relative to the project root. */
  changed: string[]
  /** Commands the turn ran. */
  commands: string[]
}

/**
 * Run one tool the model asked for, and put the result back in the
 * conversation so the model can answer with it.
 */
async function runToolCall(
  call: ToolCall,
  toolMap: Map<string, Tool>,
  context: ToolContext,
  messages: ChatMessage[],
  options: AgentOptions,
  turn: TurnState,
  added: ChatMessage[],
  model: ModelInfo,
): Promise<ToolResult | undefined> {
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
    const failed: ChatMessage = { role: "tool", content: result.output, toolCallId: call.id, name: call.name }
    messages.push(failed)
    added.push(failed)
    return result
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

  // Keep track of what the turn actually did, so the end of the turn can
  // tell the user plainly what changed. A failure is not a change.
  if (result.meta?.path && !result.isError) {
    turn.changed.push(String(result.meta.path))
  }
  if (call.name === "bash" && args.command && !result.isError) {
    turn.commands.push(String(args.command))
  }

  // A refusal is remembered. Asking for the same thing again is a loop.
  if (result.isError && (result.output.startsWith("The user declined") || result.output.startsWith("The user did not answer"))) {
    turn.refused.add(callKey(call))
  }

  if (result.image && model?.vision) {
    const withImage: ChatMessage = {
      role: "tool",
      content: [
        { type: "text", text: result.output },
        { type: "image_url", image_url: { url: `data:${result.image.mime};base64,${result.image.data}` } },
      ],
      toolCallId: call.id,
      name: call.name,
    }
    messages.push(withImage)
    added.push(withImage)
    return result
  }

  const plain: ChatMessage = { role: "tool", content: result.output, toolCallId: call.id, name: call.name }
  messages.push(plain)
  added.push(plain)
  return result
}

/** What makes a call the same call: the tool and what it was asked to do. */
function callKey(call: ToolCall): string {
  return `${call.name}:${call.arguments ?? ""}`
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
