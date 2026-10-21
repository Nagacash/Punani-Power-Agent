import { LlmError, classifyHttpError, classifyNetworkError } from "./errors.js"

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A text or image part of a message. */
export interface ContentPart {
  type: "text" | "image_url"
  text?: string
  image_url?: { url: string }
}

/** The text of a message, when it is plain text. */
export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
  }
  return ""
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  /** Plain text, or a list of parts when the message carries an image. */
  content: string | ContentPart[] | null
  /** Tool calls requested by the assistant. */
  toolCalls?: ToolCall[]
  /** For role=tool: which call this answers. */
  toolCallId?: string
  /** For role=tool: the tool name. */
  name?: string
}

export interface ToolCall {
  id: string
  name: string
  /** JSON string of the arguments, as sent by the provider. */
  arguments: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
}

export interface CompletionResult {
  content: string
  /** Reasoning text, when the model exposes it separately. */
  reasoning?: string
  toolCalls: ToolCall[]
  usage: Usage
  /** Model actually used, which may differ from the requested one (router models). */
  modelID: string
  raw?: unknown
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  tools?: ToolDefinition[]
  signal?: AbortSignal
  temperature?: number
  maxOutputTokens?: number
  /** When set, uses SSE streaming and emits text as it arrives. */
  onToken?: (delta: string) => void
  /** When set, emits the model's thinking as it arrives. */
  onReasoning?: (delta: string) => void
  /** How hard a reasoning model is asked to think. */
  reasoningEffort?: "low" | "medium" | "high"
}

export interface LlmClientOptions {
  baseURL: string
  apiKey?: string
  providerID: string
  headers?: Record<string, string>
  timeoutMs?: number
}

function base(url: string): string {
  return url.replace(/\/+$/, "")
}

function isToolCall(value: any): boolean {
  return value && typeof value === "object" && typeof value.function?.name === "string"
}

function parseChoiceMessage(message: any): { content: string; reasoning?: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .filter(isToolCall)
    .map((call: any, index: number) => ({
      id: call.id ?? `call_${index}`,
      name: call.function.name,
      arguments:
        typeof call.function.arguments === "string"
          ? call.function.arguments
          : JSON.stringify(call.function.arguments ?? {}),
    }))

  const reasoning =
    typeof message?.reasoning === "string" && message.reasoning.trim() !== ""
      ? message.reasoning
      : typeof message?.reasoning_content === "string" && message.reasoning_content.trim() !== ""
        ? message.reasoning_content
        : undefined

  return {
    content: typeof message?.content === "string" ? message.content : "",
    reasoning,
    toolCalls,
  }
}

function usageFromPayload(payload: any): Usage {
  return {
    inputTokens: Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens ?? 0),
    outputTokens: Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens ?? 0),
    reasoningTokens:
      Number(payload?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) ||
      0,
  }
}

/**
 * What the agent needs from a provider.
 *
 * The OpenAI-compatible client and the Anthropic client both satisfy it, so
 * the agent does not know which one is talking to the model.
 */
export interface ChatClient {
  readonly providerID: string
  complete(request: ChatRequest): Promise<CompletionResult>
}

/**
 * Minimal OpenAI-compatible chat client.
 *
 * Uses streaming when `onToken` is provided; otherwise one JSON response.
 */
export class LlmClient implements ChatClient {
  private readonly options: LlmClientOptions

  constructor(options: LlmClientOptions) {
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

    const message = payload?.choices?.[0]?.message ?? {}
    const parsed = parseChoiceMessage(message)
    const usage = usageFromPayload(payload)

    return {
      content: parsed.content,
      reasoning: parsed.reasoning,
      toolCalls: parsed.toolCalls,
      usage: {
        ...usage,
        reasoningTokens: usage.reasoningTokens || (parsed.reasoning ? Math.ceil(parsed.reasoning.length / 4) : 0),
      },
      modelID: payload?.model ?? request.model,
      raw: payload,
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
      const message = payload?.choices?.[0]?.message ?? {}
      const parsed = parseChoiceMessage(message)
      // The thinking comes first, the same order it arrives in over SSE.
      if (parsed.reasoning) {
        request.onReasoning?.(parsed.reasoning)
      }
      if (parsed.content.trim()) {
        request.onToken?.(parsed.content)
      }
      const usage = usageFromPayload(payload)
      return {
        content: parsed.content,
        reasoning: parsed.reasoning,
        toolCalls: parsed.toolCalls,
        usage: {
          ...usage,
          reasoningTokens: usage.reasoningTokens || (parsed.reasoning ? Math.ceil(parsed.reasoning.length / 4) : 0),
        },
        modelID: payload?.model ?? request.model,
        raw: payload,
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
    let reasoning = ""
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
          if (data === "[DONE]") continue

          let payload: any
          try {
            payload = JSON.parse(data)
          } catch {
            continue
          }

          if (payload?.model) modelID = payload.model
          if (payload?.usage) {
            usage = usageFromPayload(payload)
          }

          const delta = payload?.choices?.[0]?.delta ?? {}
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content
            request.onToken?.(delta.content)
          }
          if (typeof delta.reasoning === "string" && delta.reasoning) {
            reasoning += delta.reasoning
            request.onReasoning?.(delta.reasoning)
          }
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            reasoning += delta.reasoning_content
            request.onReasoning?.(delta.reasoning_content)
          }

          for (const part of delta.tool_calls ?? []) {
            const index = Number(part.index ?? 0)
            const entry = toolAcc.get(index) ?? { id: part.id ?? `call_${index}`, name: "", args: "" }
            if (part.id) entry.id = part.id
            if (part.function?.name) entry.name = part.function.name
            if (part.function?.arguments) entry.args += part.function.arguments
            toolAcc.set(index, entry)
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    const toolCalls: ToolCall[] = [...toolAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({
        id: entry.id,
        name: entry.name,
        arguments: entry.args || "{}",
      }))
      .filter((call) => call.name)

    return {
      content,
      reasoning: reasoning.trim() !== "" ? reasoning : undefined,
      toolCalls,
      usage: {
        ...usage,
        reasoningTokens: usage.reasoningTokens || (reasoning ? Math.ceil(reasoning.length / 4) : 0),
      },
      modelID,
    }
  }

  private async post(request: ChatRequest, stream: boolean): Promise<{ response: Response; text: string }> {
    const url = `${base(this.options.baseURL)}/chat/completions`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      ...(this.options.headers ?? {}),
    }
    if (this.options.apiKey) headers.authorization = `Bearer ${this.options.apiKey}`

    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((message) => serializeMessage(message)),
      stream,
    }
    if (request.tools?.length) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
      body.tool_choice = "auto"
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens
    if (request.reasoningEffort) {
      // OpenRouter takes the effort in its own object; OpenAI and the
      // OpenAI-compatible servers take a flat field.
      if (this.options.providerID === "openrouter") {
        body.reasoning = { effort: request.reasoningEffort }
      } else {
        body.reasoning_effort = request.reasoningEffort
      }
    }

    const timeout = this.options.timeoutMs ?? 180_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    const onAbort = (): void => controller.abort()
    request.signal?.addEventListener("abort", onAbort, { once: true })

    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
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

    if (stream) {
      return { response, text: "" }
    }

    const text = await response.text()
    return { response, text }
  }
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      name: message.name,
      content: message.content ?? "",
    }
  }
  if (Array.isArray(message.content)) {
    return { role: message.role, content: message.content }
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }
  return { role: message.role, content: message.content ?? "" }
}
