/**
 * LLM error taxonomy.
 *
 * Every failure the client can produce is classified so the UI can say what
 * went wrong and point at a configured model that would work instead.
 */

export type LlmErrorKind =
  | "auth"
  | "rate_limit"
  | "quota"
  | "model_not_found"
  | "no_tool_support"
  | "context_length"
  | "bad_request"
  | "network"
  | "server"
  | "unknown"

export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status?: number
  readonly providerID: string
  readonly modelID: string
  /** Models that could be tried instead. Filled in by the agent. */
  suggestions: string[] = []
  readonly detail?: string

  constructor(init: {
    kind: LlmErrorKind
    message: string
    providerID: string
    modelID: string
    status?: number
    detail?: string
  }) {
    super(init.message)
    this.name = "LlmError"
    this.kind = init.kind
    this.providerID = init.providerID
    this.modelID = init.modelID
    this.status = init.status
    this.detail = init.detail
  }

  /** Short label used in the terminal. */
  get title(): string {
    switch (this.kind) {
      case "auth":
        return "Authentication failed"
      case "rate_limit":
        return "Rate limited"
      case "quota":
        return "Quota exhausted"
      case "model_not_found":
        return "Model not found"
      case "no_tool_support":
        return "Model does not support tool calls"
      case "context_length":
        return "Context length exceeded"
      case "bad_request":
        return "Request rejected"
      case "network":
        return "Network failure"
      case "server":
        return "Provider error"
      default:
        return "Request failed"
    }
  }

  /**
   * A more specific fix, when the provider can tell us exactly what is
   * missing. The FreeLLMAPI router, for instance, answers with a message about
   * upstream keys, and pointing at its dashboard saves a lot of guessing.
   */
  get hint(): string | undefined {
    const body = `${this.message} ${this.detail ?? ""}`
    const lower = body.toLowerCase()
    if (this.providerID !== "freellmapi") return undefined
    if (
      !lower.includes("no candidate model") &&
      !lower.includes("no key configured") &&
      !lower.includes("usable provider key") &&
      !lower.includes("all models exhausted") &&
      !lower.includes("routing exhausted")
    ) {
      return undefined
    }

    // The router names the platforms it could not use. Naming the ones with a
    // real free tier turns "you are missing a key" into "here is the key".
    const parts = [
      "The FreeLLMAPI router is running but has no usable upstream key. " +
        "Open its dashboard and add one on the Keys page: http://localhost:5173 " +
        `— a key for any of these platforms will work: ${FREELLMAPI_FREE_PLATFORMS.join(", ")}. ` +
        "A key for a platform the catalog does not serve is not enough. " +
        "Then `freellmapi/auto` routes to whatever still has quota.",
    ]
    return parts.join(" ")
  }

  /** Actionable next step. */
  get remedy(): string {
    switch (this.kind) {
      case "auth":
        return "The API key was rejected. Re-enter it with /provider <id> key <value>."
      case "rate_limit":
        return "The provider is throttling. Wait, or switch to another configured model."
      case "quota":
        return "The free-tier quota for this model is used up. Try a different model or provider."
      case "model_not_found":
        return "The provider does not know this model id. Pick one from the catalog with /models."
      case "no_tool_support":
        return "This model cannot run tools, so it cannot drive the agent. Choose a model with tool support."
      case "context_length":
        return "The conversation is larger than the model context window. Start a new session or pick a larger-context model."
      case "bad_request":
        return "The provider rejected the request. Check the model id and the provider baseURL."
      case "network":
        return "The endpoint could not be reached. Check that it is running and the baseURL is correct."
      case "server":
        return "The provider returned a server error. Retry, or switch model."
      default:
        return "Retry, or switch to another configured model."
    }
  }
}

/**
 * FreeLLMAPI platforms that serve models from the public catalog and have a
 * free tier worth signing up for. Used to turn the router's "no key" error
 * into a list of places to get one.
 */
const FREELLMAPI_FREE_PLATFORMS = [
  "google",
  "openrouter",
  "groq",
  "nvidia",
  "zhipu",
  "mistral",
  "cohere",
  "ollama",
  "longcat",
  "qianfan",
]

const TOOL_HINTS = [
  "tool",
  "tools",
  "function",
  "function_call",
  "function_calling",
  "does not support tools",
  "tools are not supported",
  "tool use",
  "tool_use",
]

const RATE_HINTS = ["rate limit", "rate_limit", "too many requests", "429", "slow down", "try again later"]
const QUOTA_HINTS = ["quota", "insufficient_quota", "exceeded your current quota", "billing", "out of credit", "usage limit"]
const CONTEXT_HINTS = [
  "context length",
  "context_length",
  "maximum context",
  "too many tokens",
  "reduce the length",
  "context window",
]
const NO_MODEL_HINTS = ["model not found", "unknown model", "does not exist", "model_not_found", "no such model"]

/** Classify a non-2xx provider response. */
export function classifyHttpError(init: {
  status: number
  body: string
  providerID: string
  modelID: string
}): LlmError {
  const body = init.body.toLowerCase()
  const detail = init.body.length > 400 ? `${init.body.slice(0, 400)}…` : init.body
  const message = ((): string => {
    try {
      const parsed = JSON.parse(init.body)
      const error = parsed?.error
      if (typeof error === "string") return error
      if (error?.message) return String(error.message)
      if (typeof parsed?.message === "string") return parsed.message
    } catch {
      /* not JSON */
    }
    return init.body || `HTTP ${init.status}`
  })()

  if (init.status === 401 || init.status === 403) {
    return new LlmError({ kind: "auth", message, providerID: init.providerID, modelID: init.modelID, status: init.status, detail })
  }
  if (init.status === 429) {
    const kind = QUOTA_HINTS.some((hint) => body.includes(hint))
      ? "quota"
      : RATE_HINTS.some((hint) => body.includes(hint))
        ? "rate_limit"
        : "rate_limit"
    return new LlmError({ kind, message, providerID: init.providerID, modelID: init.modelID, status: init.status, detail })
  }
  if (init.status === 404 || NO_MODEL_HINTS.some((hint) => body.includes(hint))) {
    return new LlmError({
      kind: "model_not_found",
      message,
      providerID: init.providerID,
      modelID: init.modelID,
      status: init.status,
      detail,
    })
  }
  if (TOOL_HINTS.some((hint) => body.includes(hint))) {
    return new LlmError({
      kind: "no_tool_support",
      message: message || "This model does not support tool calls.",
      providerID: init.providerID,
      modelID: init.modelID,
      status: init.status,
      detail,
    })
  }
  if (CONTEXT_HINTS.some((hint) => body.includes(hint))) {
    return new LlmError({
      kind: "context_length",
      message,
      providerID: init.providerID,
      modelID: init.modelID,
      status: init.status,
      detail,
    })
  }
  if (init.status >= 500) {
    return new LlmError({ kind: "server", message, providerID: init.providerID, modelID: init.modelID, status: init.status, detail })
  }
  if (init.status >= 400) {
    return new LlmError({ kind: "bad_request", message, providerID: init.providerID, modelID: init.modelID, status: init.status, detail })
  }
  return new LlmError({ kind: "unknown", message, providerID: init.providerID, modelID: init.modelID, status: init.status, detail })
}

/** Classify a transport-level failure. */
export function classifyNetworkError(error: unknown, providerID: string, modelID: string): LlmError {
  const message = error instanceof Error ? error.message : String(error)
  const kind: LlmErrorKind =
    message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")
      ? "network"
      : "unknown"
  return new LlmError({ kind, message, providerID, modelID, detail: message })
}
