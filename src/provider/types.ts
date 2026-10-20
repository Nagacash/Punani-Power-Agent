/**
 * Provider and model types.
 *
 * The shape mirrors what a real OpenAI-compatible endpoint can tell us, so the
 * same record works for a remote API, a local Ollama daemon, or a proxy router.
 */

export type ProviderKind = "freellmapi" | "ollama" | "lmstudio" | "openai-compatible"

export type ProviderSource = "builtin" | "user" | "env"

export interface ProviderConfig {
  /** Stable id, unique across the config. Used as the `provider/model` prefix. */
  id: string
  kind: ProviderKind
  /** Display name shown in the UI. */
  name: string
  /** Base URL of the OpenAI-compatible API, without a trailing slash. */
  baseURL: string
  /** Environment variable that may hold the API key, if the user prefers that. */
  env?: string
  /** True when the provider needs no credential (local daemons). */
  anonymous?: boolean
  /** Default context window for models that do not report one. */
  defaultContextWindow?: number
  enabled?: boolean
}

export interface ModelCost {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  currency: string
}

export interface ModelInfo {
  /** Model id exactly as the endpoint expects it. */
  id: string
  /** Owning provider id. */
  providerID: string
  /** Human readable name. */
  name: string
  /** Total context window in tokens. */
  contextWindow: number
  /** Max tokens the model may emit in one response, when known. */
  maxOutput?: number
  /** Whether the model can be called with `tools` / tool calls. */
  toolSupport: boolean
  /** Whether the model exposes reasoning/thinking output. */
  reasoning: boolean
  /** Whether the model accepts image input. */
  vision: boolean
  cost: ModelCost
  /** `active` models are callable; others are listed but disabled. */
  status: "active" | "preview" | "unavailable" | "deprecated"
  /** Why the model is unavailable, when it is. */
  note?: string
  /** Where this model record came from. */
  origin: "catalog" | "builtin" | "config"
}

export interface ProviderState {
  config: ProviderConfig
  /** Present when a credential is configured (or the provider is anonymous). */
  hasKey: boolean
  /** Source of the credential. */
  keySource?: "config" | "env"
  /** Last error raised while talking to this provider. */
  lastError?: string
}

export interface ModelRef {
  providerID: string
  modelID: string
}

export function modelKey(ref: ModelRef | ModelInfo): string {
  if ("modelID" in ref) return `${ref.providerID}/${ref.modelID}`
  return `${ref.providerID}/${ref.id}`
}

export function parseModelKey(key: string): ModelRef | undefined {
  const index = key.indexOf("/")
  if (index <= 0 || index === key.length - 1) return undefined
  return { providerID: key.slice(0, index), modelID: key.slice(index + 1) }
}

/** Rough USD cost of one turn, given token counts. */
export function estimateCost(cost: ModelCost, inputTokens: number, outputTokens: number): number {
  const input = (inputTokens / 1_000_000) * cost.input
  const output = (outputTokens / 1_000_000) * cost.output
  return input + output
}

export function formatCost(cost: ModelCost): string {
  if (cost.input === 0 && cost.output === 0) return "free"
  const format = (value: number): string => {
    if (value === 0) return "0"
    if (value < 0.01) return value.toFixed(4)
    return value.toFixed(2)
  }
  return `$${format(cost.input)}/M in, $${format(cost.output)}/M out`
}
