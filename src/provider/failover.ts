import { createClient } from "../llm/factory.js"
import type { ChatClient } from "../llm/client.js"
import type { LlmError } from "../llm/errors.js"
import type { ConfigStore } from "../config/store.js"
import type { ProviderRegistry } from "./registry.js"
import { modelKey, type ModelInfo } from "./types.js"

export interface FallbackTarget {
  client: ChatClient
  model: ModelInfo
}

/**
 * Move a turn to another model when the provider refuses the request.
 *
 * The ranking lives in the registry: free models first, another provider
 * before the same one, and the FreeLLMAPI router ahead of everything because
 * it routes to whatever upstream still has quota. A paid model is only
 * reached when its provider already holds a key.
 */
export function createFailover(options: {
  registry: ProviderRegistry
  config: ConfigStore
  /** Overrides the stored key, for a key the browser holds. */
  keyFor?: (providerID: string) => string | undefined
  /** Called when the turn moves to another model. */
  onSwitch?: (model: ModelInfo) => void
}): (error: LlmError, failed: ModelInfo) => Promise<FallbackTarget | undefined> {
  const { registry, config } = options
  // A model that already refused does not get a second chance this turn.
  const tried = new Set<string>()

  return async (_error, failed) => {
    tried.add(modelKey(failed))
    const candidates = await registry.fallbackModels(failed)
    for (const model of candidates) {
      const key = modelKey(model)
      if (tried.has(key)) continue
      const provider = registry.provider(model.providerID)
      if (!provider) continue
      const apiKey = options.keyFor?.(provider.id) ?? registry.keyFor(provider).key
      tried.add(key)
      options.onSwitch?.(model)
      return { client: createClient(provider, apiKey, config.headers(provider.id)), model }
    }
    return undefined
  }
}
