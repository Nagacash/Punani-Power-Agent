import type { ModelCost, ModelInfo, ProviderConfig } from "./types.js"

/**
 * Model catalog adapters.
 *
 * Every adapter returns a normalised `ModelInfo[]`. Adapters never throw for
 * "model missing" — an unreachable endpoint is reported as a plain error the
 * caller can show to the user.
 */

export interface CatalogResult {
  models: ModelInfo[]
  /** Non-fatal notes, e.g. "12 of 80 models are currently unavailable". */
  notes: string[]
}

export class CatalogError extends Error {
  readonly hint: string
  constructor(message: string, hint: string) {
    super(message)
    this.name = "CatalogError"
    this.hint = hint
  }
}

const FETCH_TIMEOUT_MS = 8_000

async function fetchJson(url: string, headers: Record<string, string>): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      const detail = extractApiError(text) || `HTTP ${response.status}`
      throw new Error(detail)
    }
    return text ? JSON.parse(text) : {}
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(timer)
  }
}

export function extractApiError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    const error = parsed?.error
    if (typeof error === "string") return error
    if (error && typeof error.message === "string") return error.message
    if (typeof parsed?.message === "string") return parsed.message
  } catch {
    /* not JSON */
  }
  const trimmed = body.trim()
  if (!trimmed) return undefined
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

function authHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  return headers
}

function base(provider: ProviderConfig): string {
  return provider.baseURL.replace(/\/+$/, "")
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible (/v1/models)                                      */
/* ------------------------------------------------------------------ */

export async function fetchOpenAICompatible(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  const url = `${base(provider)}/models`
  let payload: any
  try {
    payload = await fetchJson(url, authHeaders(apiKey))
  } catch (error) {
    throw new CatalogError(
      `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      `Check that ${provider.name} is running and that baseURL is correct.`,
    )
  }
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : []
  const models: ModelInfo[] = rows.map((row) => {
    const id = String(row?.id ?? row?.name ?? "")
    const contextWindow =
      Number(row?.context_window) ||
      Number(row?.context_length) ||
      Number(row?.context_length_tokens) ||
      provider.defaultContextWindow ||
      8_192
    return {
      id,
      providerID: provider.id,
      name: String(row?.name ?? row?.display_name ?? id),
      contextWindow,
      maxOutput: Number(row?.max_output_tokens) || undefined,
      toolSupport: detectToolSupport(row),
      reasoning: detectReasoning(row),
      vision: detectVision(row),
      cost: parsePricing(row),
      status: "active",
      origin: "catalog",
    } satisfies ModelInfo
  })
  return { models: models.filter((m) => m.id !== ""), notes: [] }
}

/**
 * Read a model's price.
 *
 * OpenRouter and friends quote USD *per token* as a decimal string
 * (`"0.00000015"` = $0.15 per million). Convert to per-million so the number
 * in the UI is readable. A provider that quotes no pricing is treated as free.
 */
export function parsePricing(row: any): ModelCost {
  const pricing = row?.pricing
  if (!pricing || typeof pricing !== "object") return { input: 0, output: 0, currency: "USD" }
  const perToken = (value: unknown): number => {
    const number = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN
    if (!Number.isFinite(number)) return 0
    return number * 1_000_000
  }
  return {
    input: perToken(pricing.prompt ?? pricing.input),
    output: perToken(pricing.completion ?? pricing.output),
    currency: "USD",
  }
}

function detectToolSupport(row: any): boolean {
  // Only an explicitly present list counts. A missing key means the provider
  // did not say, which is not the same as saying no.
  const declared = row?.supported_parameters ?? row?.supported_features
  if (Array.isArray(declared)) {
    if (declared.length === 0) return false
    return declared.some(
      (entry) =>
        String(entry).toLowerCase().includes("tool") || String(entry).toLowerCase().includes("function"),
    )
  }
  if (typeof row?.tool_call === "boolean") return row.tool_call
  if (typeof row?.supports_tools === "boolean") return row.supports_tools
  if (row?.capabilities && typeof row.capabilities === "object" && typeof row.capabilities.toolcall === "boolean") {
    return row.capabilities.toolcall
  }
  return true
}

function detectReasoning(row: any): boolean {
  const supported: string[] = row?.supported_features ?? row?.supported_parameters ?? []
  if (Array.isArray(supported) && supported.length > 0) {
    return supported.some((entry) => String(entry).toLowerCase().includes("reason"))
  }
  if (typeof row?.reasoning === "boolean") return row.reasoning
  return false
}

/**
 * Whether a model takes images as input.
 *
 * OpenRouter nests the modalities under `architecture`, and every other
 * provider puts them at the top level, so both are read. Getting this wrong
 * means the agent never sees a picture the user pointed it at.
 */
export function detectVision(row: any): boolean {
  const modalities: string[] = [
    ...(row?.architecture?.input_modalities ?? []),
    ...(row?.input_modalities ?? row?.modalities?.input ?? []),
  ]
  if (Array.isArray(modalities) && modalities.length > 0) {
    return modalities.some((entry) => String(entry).toLowerCase() === "image")
  }
  if (typeof row?.vision === "boolean") return row.vision
  // "text+image->text" takes an image; "text->image" makes one.
  const modality = String(row?.architecture?.modality ?? "")
  if (modality) {
    const input = modality.split("->")[0] ?? ""
    return /image/.test(input.toLowerCase())
  }
  return false
}

/* ------------------------------------------------------------------ */
/* FreeLLMAPI                                                          */
/* ------------------------------------------------------------------ */

/**
 * FreeLLMAPI is an OpenAI-compatible router. Its `/v1/models` response adds
 * `context_window`, `available`, `unavailable_reason`, `execution_status` and
 * `supported_parameters` on top of the OpenAI fields.
 */
export async function fetchFreeLLMAPI(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  const url = `${base(provider)}/models`
  let payload: any
  try {
    payload = await fetchJson(url, authHeaders(apiKey))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new CatalogError(
      `could not reach the FreeLLMAPI router at ${url}: ${detail}`,
      "Start the router (default port 3001), or point baseURL at your own instance. " +
        "See https://freellmapi.co for the self-hosted setup.",
    )
  }
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : []
  const notes: string[] = []
  let unavailable = 0

  const models: ModelInfo[] = rows.map((row) => {
    const id = String(row?.id ?? "")
    const available = row?.available !== false
    const reason = row?.unavailable_reason ?? null
    const executionStatus = row?.execution_status ?? null
    if (!available) unavailable++

    const contextWindow =
      Number(row?.context_window) || Number(row?.context_length) || provider.defaultContextWindow || 32_768

    // The router ids (`auto`, `auto:<profile>`, `fusion`) are meta-models: the
    // router picks the concrete model, so tool support is not knowable up front.
    const isRouterId = id === "auto" || id === "fusion" || id.startsWith("auto:")

    const toolSupport = isRouterId
      ? true
      : detectToolSupport(row) ||
        (Array.isArray(row?.supported_parameters) &&
          row.supported_parameters.some((p: unknown) => String(p).toLowerCase() === "tools"))

    const status: ModelInfo["status"] = !available
      ? "unavailable"
      : executionStatus === "needsKey" || executionStatus === "exhausted"
        ? "unavailable"
        : "active"

    return {
      id,
      providerID: provider.id,
      name: String(row?.name ?? id),
      contextWindow,
      maxOutput: Number(row?.max_output_tokens) || undefined,
      toolSupport,
      reasoning: detectReasoning(row),
      vision: detectVision(row),
      cost: { input: 0, output: 0, currency: "USD" },
      status,
      note: !available && reason ? `unavailable: ${reason}` : executionStatus === "needsKey" ? "needs provider key" : undefined,
      origin: "catalog",
    } satisfies ModelInfo
  })

  if (unavailable > 0) {
    notes.push(`${unavailable} of ${models.length} catalog models are currently unavailable`)
  }
  return { models, notes }
}

/* ------------------------------------------------------------------ */
/* Ollama                                                              */
/* ------------------------------------------------------------------ */

/** Ollama exposes a richer native API at `/api/tags`. */
export async function fetchOllama(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  const root = base(provider).replace(/\/v1$/, "")
  let payload: any
  try {
    payload = await fetchJson(`${root}/api/tags`, authHeaders(apiKey))
  } catch (error) {
    throw new CatalogError(
      `could not reach Ollama at ${root}: ${error instanceof Error ? error.message : String(error)}`,
      "Start it with `ollama serve`, or set the provider baseURL to your Ollama host.",
    )
  }
  const rows: any[] = Array.isArray(payload?.models) ? payload.models : []
  const models: ModelInfo[] = rows.map((row) => {
    const id = String(row?.name ?? row?.model ?? "")
    const family = String(row?.details?.family ?? "")
    // Tool calling in Ollama needs a model that was trained for it.
    const toolSupport = family === "" ? true : !/embed|vision-only/.test(family)
    return {
      id,
      providerID: provider.id,
      name: id,
      contextWindow: provider.defaultContextWindow ?? 32_768,
      toolSupport,
      reasoning: /deepseek|qwen3|thinking|reason/.test(id),
      vision: /llava|vision|minicpm-v|moondream|bakllava/.test(id),
      cost: { input: 0, output: 0, currency: "USD" },
      status: "active",
      origin: "catalog",
    } satisfies ModelInfo
  })
  const notes: string[] = []
  if (models.length > 0) {
    notes.push("Ollama does not report a context window; raise it with `OLLAMA_CONTEXT_LENGTH` if a model rejects long input")
  }
  return { models, notes }
}

/* ------------------------------------------------------------------ */
/* LM Studio                                                           */
/* ------------------------------------------------------------------ */

export async function fetchLmStudio(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  const url = `${base(provider)}/models`
  let payload: any
  try {
    payload = await fetchJson(url, authHeaders(apiKey))
  } catch (error) {
    throw new CatalogError(
      `could not reach LM Studio at ${url}: ${error instanceof Error ? error.message : String(error)}`,
      "Start the local server in LM Studio, or set the provider baseURL to its address.",
    )
  }
  const rows: any[] = Array.isArray(payload?.data) ? payload.data : []
  const models: ModelInfo[] = rows.map((row) => {
    const id = String(row?.id ?? "")
    const contextWindow = Number(row?.context_length) || provider.defaultContextWindow || 32_768
    return {
      id,
      providerID: provider.id,
      name: String(row?.name ?? id),
      contextWindow,
      toolSupport: true,
      reasoning: /reason|think/.test(id),
      vision: /vision|llava/.test(id),
      cost: { input: 0, output: 0, currency: "USD" },
      status: "active",
      origin: "catalog",
    } satisfies ModelInfo
  })
  return { models, notes: [] }
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

/**
 * The price of a Claude model, per million tokens.
 *
 * Anthropic publishes a price list, but not in the catalog endpoint, so this
 * is a table. It goes stale when they change a price; the number is only
 * used for the cost estimate in the header.
 */
const ANTHROPIC_PRICES: Record<string, { input: number; output: number }> = {
  "claude-opus-4": { input: 5, output: 25 },
  "claude-sonnet-4": { input: 3, output: 15 },
  "claude-haiku-4": { input: 1, output: 5 },
  "claude-3-7": { input: 3, output: 15 },
  "claude-3-5": { input: 3, output: 15 },
  "claude-3": { input: 15, output: 75 },
}

/** The context window of a Claude model, when the name says which one it is. */
function anthropicContext(id: string): number {
  if (/claude-opus-4/.test(id)) return 200_000
  if (/claude-sonnet-4/.test(id)) return 200_000
  if (/claude-haiku-4/.test(id)) return 200_000
  if (/claude-3-7/.test(id)) return 200_000
  if (/claude-3-5/.test(id)) return 200_000
  if (/claude-3/.test(id)) return 200_000
  return 128_000
}

function anthropicPrice(id: string): { input: number; output: number } {
  for (const [family, price] of Object.entries(ANTHROPIC_PRICES)) {
    if (id.includes(family)) return price
  }
  return { input: 3, output: 15 }
}

/**
 * The Anthropic model list.
 *
 * It has no context window, no price and no capability flags, so they come
 * from the name of the model.
 */
export async function fetchAnthropic(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  const url = `${base(provider)}/models`
  let payload: any
  try {
    payload = await fetchJson(url, {
      ...authHeaders(apiKey),
      "anthropic-version": "2023-06-01",
    })
  } catch (error) {
    throw new CatalogError(
      `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      `Check that ${provider.name} is reachable and that the key is right.`,
    )
  }

  const rows: any[] = Array.isArray(payload?.data) ? payload.data : []
  const models: ModelInfo[] = rows.map((row) => {
    const id = String(row?.id ?? "")
    const price = anthropicPrice(id)
    return {
      id,
      providerID: provider.id,
      name: String(row?.display_name ?? id),
      contextWindow: anthropicContext(id),
      toolSupport: true,
      // Extended thinking arrived with Claude 3.7 and is on every model since.
      reasoning: /claude-(opus|sonnet|haiku)-4|claude-3-7/.test(id),
      vision: true,
      cost: { input: price.input, output: price.output, currency: "USD" },
      status: "active",
      origin: "catalog",
    } satisfies ModelInfo
  })

  return { models: models.filter((model) => model.id !== ""), notes: [] }
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */

export async function fetchCatalog(
  provider: ProviderConfig,
  apiKey: string | undefined,
): Promise<CatalogResult> {
  switch (provider.kind) {
    case "freellmapi":
      return fetchFreeLLMAPI(provider, apiKey)
    case "ollama":
      return fetchOllama(provider, apiKey)
    case "lmstudio":
      return fetchLmStudio(provider, apiKey)
    case "anthropic":
      return fetchAnthropic(provider, apiKey)
    case "openai-compatible":
      return fetchOpenAICompatible(provider, apiKey)
  }
}
