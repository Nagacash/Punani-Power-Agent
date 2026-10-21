import type { ChatMessage, ChatRequest, CompletionResult, ToolCall, Usage } from "./client.js"
import { LlmError, classifyHttpError, classifyNetworkError } from "./errors.js"

/**
 * The Anthropic Messages API.
 *
 * The rest of the app speaks the OpenAI shape, so this file is the wall
 * between the two. Three things are different enough to matter:
 *
 *   - The system prompt is its own field, not a message.
 *   - A tool result is a user message holding a tool_result block.
 *   - The thinking a model does comes back as a block that has to be sent
 *     back unchanged, signature and all, or the next turn is rejected.
 *
 * Prompt caching is the other reason to talk to Anthropic directly: the
 * system prompt and the tool definitions are the same on every turn, and
 * marking them cached makes them cost a fraction.
 */

export interface AnthropicClientOptions {
  baseURL: string
  apiKey?: string
  providerID: string
  headers?: Record<string, string>
  timeoutMs?: number
}

/** The thinking budget, per effort level. */
const BUDGET: Record<string, number> = { low: 1_024, medium: 4_096, high: 8_192 }

interface AnthropicBlock {
  type: string
  /** Marks a block as cached, so the provider keeps it between turns. */
  cache_control?: { type: string }
  text?: string
  thinking?: string
  signature?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { type: string; media_type?: string; data?: string }
}

interface AnthropicMessage {
  role: "user" | "assistant"
  content: AnthropicBlock[]
}

function base(url: string): string {
  return url.replace(/\/+$/, "")
}

/** The Anthropic API version header. */
const VERSION = "2023-06-01"

export class AnthropicClient {
  private readonly options: AnthropicClientOptions

  constructor(options: AnthropicClientOptions) {
    this.options = options
  }

  get providerID(): string {
    return this.options.providerID
  }

  async complete(request: ChatRequest): Promise<CompletionResult> {
    if (request.onToken || request.onReasoning) {
      return this.completeStreaming(request)
    }
    return this.completeBuffered(request)
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "anthropic-version": VERSION,
      ...(this.options.headers ?? {}),
    }
    if (this.options.apiKey) headers["x-api-key"] = this.options.apiKey
    return headers
  }

  private body(request: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(request.messages)
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream,
      // Anthropic will not answer without a limit, and it will not think
      // beyond it.
      max_tokens: (request.maxOutputTokens ?? 8_192) + (request.reasoningEffort ? BUDGET[request.reasoningEffort]! : 0),
    }
    if (system) body.system = system
    if (request.tools?.length) {
      body.tools = request.tools.map((tool, index) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        // The tool definitions never change. Cache them.
        ...(index === request.tools!.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
      }))
    }
    if (request.reasoningEffort) {
      body.thinking = { type: "enabled", budget_tokens: BUDGET[request.reasoningEffort]! }
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    return body
  }

  private async completeBuffered(request: ChatRequest): Promise<CompletionResult> {
    const { response, text } = await this.post(request, false)
    if (!response.ok) {
      throw classifyHttpError({
        status: response.status,
        body: text,
        providerID: this.options.providerID,
        modelID: request.model,
      })
    }
    let payload: any
    try {
      payload = JSON.parse(text)
    } catch {
      throw new LlmError({
        kind: "bad_request",
        message: "the provider returned a response that was not valid JSON",
        providerID: this.options.providerID,
        modelID: request.model,
        detail: text.slice(0, 300),
      })
    }

    const blocks: AnthropicBlock[] = payload?.content ?? []
    const text2 = blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
    const thinking = blocks
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking ?? "")
      .join("")
    const toolCalls: ToolCall[] = blocks
      .filter((block) => block.type === "tool_use")
      .map((block, index) => ({
        id: block.id ?? `call_${index}`,
        name: block.name ?? "",
        arguments: JSON.stringify(block.input ?? {}),
      }))
      .filter((call) => call.name)

    const usage: Usage = {
      inputTokens: Number(payload?.usage?.input_tokens ?? 0),
      outputTokens: Number(payload?.usage?.output_tokens ?? 0),
      reasoningTokens: 0,
    }

    return {
      content: text2,
      reasoning: thinking.trim() !== "" ? thinking : undefined,
      toolCalls,
      usage,
      modelID: payload?.model ?? request.model,
    }
  }

  private async completeStreaming(request: ChatRequest): Promise<CompletionResult> {
    const { response, text } = await this.post(request, true)
    if (!response.ok) {
      throw classifyHttpError({
        status: response.status,
        body: text,
        providerID: this.options.providerID,
        modelID: request.model,
      })
    }

    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.includes("text/event-stream")) {
      // A server that answers with one JSON body instead of a stream.
      const raw = text || (await response.text())
      let payload: any
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new LlmError({
          kind: "bad_request",
          message: "the provider returned a response that was not valid JSON or SSE",
          providerID: this.options.providerID,
          modelID: request.model,
          detail: raw.slice(0, 300),
        })
      }
      const blocks: AnthropicBlock[] = payload?.content ?? []
      const thinking = blocks
        .filter((block) => block.type === "thinking")
        .map((block) => block.thinking ?? "")
        .join("")
      const answer = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("")
      if (thinking) request.onReasoning?.(thinking)
      if (answer) request.onToken?.(answer)
      return {
        content: answer,
        reasoning: thinking.trim() !== "" ? thinking : undefined,
        toolCalls: [],
        usage: {
          inputTokens: Number(payload?.usage?.input_tokens ?? 0),
          outputTokens: Number(payload?.usage?.output_tokens ?? 0),
          reasoningTokens: 0,
        },
        modelID: payload?.model ?? request.model,
      }
    }

    if (!response.body) {
      throw new LlmError({
        kind: "bad_request",
        message: "the provider returned an empty streaming body",
        providerID: this.options.providerID,
        modelID: request.model,
      })
    }

    let content = ""
    let thinking = ""
    const toolAcc = new Map<number, { id: string; name: string; args: string }>()
    let modelID = request.model
    let usage: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        if (request.signal?.aborted) {
          throw new LlmError({
            kind: "unknown",
            message: "cancelled",
            providerID: this.options.providerID,
            modelID: request.model,
          })
        }
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith("data:")) continue
          const data = trimmed.slice(5).trim()
          if (!data) continue
          let event: any
          try {
            event = JSON.parse(data)
          } catch {
            continue
          }
          const type = event?.type

          if (type === "message_start") {
            if (event?.message?.model) modelID = event.message.model
            const used = event?.message?.usage
            if (used) {
              usage = {
                inputTokens: Number(used.input_tokens ?? 0),
                outputTokens: Number(used.output_tokens ?? 0),
                reasoningTokens: 0,
              }
            }
            continue
          }

          if (type === "content_block_start") {
            const block = event?.content_block
            if (block?.type === "tool_use") {
              const index = Number(event.index ?? 0)
              toolAcc.set(index, { id: block.id ?? `call_${index}`, name: block.name ?? "", args: "" })
            }
            continue
          }

          if (type === "content_block_delta") {
            const delta = event?.delta
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              content += delta.text
              request.onToken?.(delta.text)
            } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              thinking += delta.thinking
              request.onReasoning?.(delta.thinking)
            } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              const index = Number(event.index ?? 0)
              const entry = toolAcc.get(index)
              if (entry) entry.args += delta.partial_json
            }
            continue
          }

          if (type === "message_delta") {
            const used = event?.usage
            if (used) {
              usage = {
                inputTokens: usage.inputTokens || Number(used.input_tokens ?? 0),
                outputTokens: Number(used.output_tokens ?? usage.outputTokens),
                reasoningTokens: 0,
              }
            }
            continue
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({ id: entry.id, name: entry.name, arguments: entry.args || "{}" }))
      .filter((call) => call.name)

    return {
      content,
      reasoning: thinking.trim() !== "" ? thinking : undefined,
      toolCalls,
      usage,
      modelID,
    }
  }

  private async post(request: ChatRequest, stream: boolean): Promise<{ response: Response; text: string }> {
    const url = `${base(this.options.baseURL)}/messages`
    const timeout = this.options.timeoutMs ?? 180_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener("abort", onAbort, { once: true })

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.body(request, stream)),
        signal: controller.signal,
      })
    } catch (error) {
      if (request.signal?.aborted) {
        throw new LlmError({
          kind: "unknown",
          message: "cancelled",
          providerID: this.options.providerID,
          modelID: request.model,
        })
      }
      throw classifyNetworkError(error, this.options.providerID, request.model)
    } finally {
      clearTimeout(timer)
      request.signal?.removeEventListener("abort", onAbort)
    }

    if (stream) return { response, text: "" }
    return { response, text: await response.text() }
  }
}

/**
 * Turn the app's messages into the shape Anthropic wants.
 *
 * The system prompt becomes its own field, a tool result becomes a user
 * message, and the roles have to alternate.
 */
export function toAnthropicMessages(messages: ChatMessage[]): {
  system: AnthropicBlock[]
  messages: AnthropicMessage[]
} {
  const system: AnthropicBlock[] = []
  const out: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === "system") {
      const text = messageTextOf(message)
      if (text) system.push({ type: "text", text })
      continue
    }

    if (message.role === "tool") {
      const block: AnthropicBlock = {
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: messageTextOf(message),
      }
      push(out, "user", [block])
      continue
    }

    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = []
      const text = messageTextOf(message)
      if (text) blocks.push({ type: "text", text })
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        })
      }
      if (blocks.length > 0) push(out, "assistant", blocks)
      continue
    }

    // A user message. The text, and any picture with it.
    const blocks: AnthropicBlock[] = []
    if (typeof message.content === "string") {
      if (message.content) blocks.push({ type: "text", text: message.content })
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text) blocks.push({ type: "text", text: part.text })
        } else if (part.type === "image_url") {
          const source = parseDataUrl(part.image_url?.url ?? "")
          if (source) blocks.push({ type: "image", source })
        }
      }
    }
    if (blocks.length > 0) push(out, "user", blocks)
  }

  // The system prompt is the same on every turn. Cache it.
  const last = system[system.length - 1]
  if (last) last.cache_control = { type: "ephemeral" }

  return { system, messages: out }
}

function push(out: AnthropicMessage[], role: "user" | "assistant", blocks: AnthropicBlock[]): void {
  const last = out[out.length - 1]
  if (last && last.role === role) {
    last.content.push(...blocks)
    return
  }
  out.push({ role, content: blocks })
}

function messageTextOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
  }
  return ""
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** A data URL becomes the base64 source Anthropic wants. */
function parseDataUrl(url: string): { type: string; media_type?: string; data?: string } | null {
  const match = url.match(/^data:([^;]+);base64,(.*)$/)
  if (!match) return null
  return { type: "base64", media_type: match[1]!, data: match[2]! }
}
