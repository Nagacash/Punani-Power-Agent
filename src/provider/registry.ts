import { ConfigStore } from "../config/store.js"
import { log } from "../core/logger.js"
import { redactError } from "../core/redact.js"
import { fetchCatalog, type CatalogResult } from "./catalog.js"
import { BUILTIN_PROVIDERS, type ModelOverride } from "./builtin.js"
import { modelKey, type ModelInfo, type ProviderConfig, type ProviderState } from "./types.js"

export interface ProviderStatus {
  provider: ProviderConfig
  hasKey: boolean
  keySource?: "config" | "env"
  models: ModelInfo[]
  notes: string[]
  error?: string
}

/**
 * The provider registry.
 *
 * Holds the merged view of: built-in providers, user-defined providers, the
 * live model catalog of each provider, and per-model overrides from config.
 */
export class ProviderRegistry {
  private readonly catalogCache = new Map<string, { at: number; result: CatalogResult }>()
  private readonly TTL_MS = 60_000

  constructor(readonly config: ConfigStore) {}

  providers(): ProviderConfig[] {
    return this.config.providers()
  }

  /** One provider by id, or undefined. */
  provider(id: string): ProviderConfig | undefined {
    return this.providers().find((entry) => entry.id === id)
  }

  /** Resolve the key for a provider, preferring the config file then the env var. */
  keyFor(provider: ProviderConfig): { key?: string; source?: "config" | "env" } {
    return this.config.apiKey(provider)
  }

  /** True when the provider is usable: it has a key, or needs none. */
  async isUsable(provider: ProviderConfig): Promise<boolean> {
    if (provider.anonymous) return true
    const { key } = this.keyFor(provider)
    if (key) return true
    const builtin = BUILTIN_PROVIDERS.find((entry) => entry.config.id === provider.id)
    if (builtin && !builtin.requiresKey) return true
    return false
  }

  /**
   * Fetch the model catalog for a provider.
   * The result is cached briefly so the UI can call it repeatedly.
   */
  async catalog(provider: ProviderConfig, force = false): Promise<CatalogResult> {
    const cached = this.catalogCache.get(provider.id)
    if (!force && cached && Date.now() - cached.at < this.TTL_MS) return cached.result
    const { key } = this.keyFor(provider)
    const result = await fetchCatalog(provider, key)
    this.catalogCache.set(provider.id, { at: Date.now(), result })
    return result
  }

  /** Model list for a provider, with config overrides applied. */
  async models(provider: ProviderConfig, force = false): Promise<{ models: ModelInfo[]; notes: string[]; error?: string }> {
    try {
      const { models, notes } = await this.catalog(provider, force)
      return { models: models.map((model) => this.applyOverride(model)), notes }
    } catch (error) {
      const message = redactError(error)
      log.warn(`catalog fetch failed for ${provider.id}: ${message}`)
      const seed = BUILTIN_PROVIDERS.find((entry) => entry.config.id === provider.id)?.seedModels ?? []
      const fallback: ModelInfo[] = seed.map((id) =>
        this.applyOverride({
          id,
          providerID: provider.id,
          name: id,
          contextWindow: provider.defaultContextWindow ?? 32_768,
          toolSupport: true,
          reasoning: false,
          vision: false,
          cost: { input: 0, output: 0, currency: "USD" },
          status: "active",
          origin: "builtin",
        }),
      )
      return { models: fallback, notes: [], error: message }
    }
  }

  private applyOverride(model: ModelInfo): ModelInfo {
    const override = this.config.modelOverride(modelKey(model))
    if (!override) return model
    return {
      ...model,
      name: override.name ?? model.name,
      contextWindow: override.contextWindow ?? model.contextWindow,
      maxOutput: override.maxOutput ?? model.maxOutput,
      toolSupport: override.toolSupport ?? model.toolSupport,
      cost: override.cost
        ? {
            input: override.cost.input ?? model.cost.input,
            output: override.cost.output ?? model.cost.output,
            currency: model.cost.currency,
          }
        : model.cost,
      status: override.status ?? model.status,
    }
  }

  /**
   * Every model across every provider whose catalog can be read.
   *
   * The catalog is fetched even without a key: several providers publish it
   * publicly, and you want to see what is on offer before you go get a key.
   * Providers that need a key to list will simply contribute nothing.
   *
   * Providers are queried in parallel. One unreachable provider must not add
   * its timeout to every other provider's wait.
   */
  async allModels(): Promise<ModelInfo[]> {
    const results = await Promise.all(
      this.providers().map(async (provider) => {
        const { models } = await this.models(provider)
        return models
      }),
    )
    return results.flat()
  }

  /** Find one model by `provider/model`. */
  async findModel(key: string): Promise<ModelInfo | undefined> {
    const [providerID, ...rest] = key.split("/")
    if (!providerID || rest.length === 0) return undefined
    const provider = this.providers().find((entry) => entry.id === providerID)
    if (!provider) return undefined
    const modelID = rest.join("/")
    const { models } = await this.models(provider)
    return models.find((model) => model.id === modelID)
  }

  /** Free OpenRouter model that works out of the box when a key is set. */
  static readonly RECOMMENDED_FREE_MODEL = "openrouter/minimax/minimax-m3.1-flash:free"

  /** Router aliases that need upstream keys in FreeLLMAPI — not a first-run default. */
  private static isRouterAlias(model: ModelInfo): boolean {
    if (model.providerID !== "freellmapi") return false
    return model.id === "auto" || model.id === "fusion" || model.id.startsWith("auto:")
  }

  /** The model to start with: the configured default, else the first usable one. */
  async defaultModel(): Promise<ModelInfo | undefined> {
    const usable = new Set<string>()
    for (const provider of this.providers()) {
      if (await this.isUsable(provider)) usable.add(provider.id)
    }

    const configured = this.config.get().defaultModel
    if (configured) {
      const found = await this.findModel(configured)
      if (found && !ProviderRegistry.isRouterAlias(found)) return found
    }

    const recommended = await this.findModel(ProviderRegistry.RECOMMENDED_FREE_MODEL)
    if (recommended?.status === "active" && usable.has(recommended.providerID)) {
      return recommended
    }

    const models = await this.allModels()
    const active = models.filter(
      (model) => model.status === "active" && !ProviderRegistry.isRouterAlias(model),
    )
    return (
      active.find((model) => model.toolSupport && usable.has(model.providerID)) ??
      active.find((model) => model.toolSupport) ??
      active.find((model) => usable.has(model.providerID)) ??
      active[0]
    )
  }

  /**
   * Models that could be used instead of the one that just failed.
   *
   * Ranked by whether they would actually work, and by cost:
   *   1. a provider you hold a key for, or a local runtime
   *   2. free before paid
   *   3. tool support, because an agent without tools is useless
   *   4. active before unavailable
   */
  async alternatives(failed: ModelInfo): Promise<ModelInfo[]> {
    const models = await this.allModels()
    const usable = new Set<string>()
    for (const provider of this.providers()) {
      if (await this.isUsable(provider)) usable.add(provider.id)
    }

    const rank = (model: ModelInfo): number => {
      let score = 0
      if (model.status !== "active") score += 100
      if (!model.toolSupport) score += 50
      if (!usable.has(model.providerID)) score += 40
      // Free before paid: the whole point of the free tiers.
      if (model.cost.input !== 0 || model.cost.output !== 0) score += 8
      if (model.providerID === failed.providerID) score -= 2
      return score
    }

    return models
      .filter((model) => model.id !== failed.id || model.providerID !== failed.providerID)
      .sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
      .slice(0, 5)
  }

  /**
   * Models to move to when the current one is throttled.
   *
   * Free models come first, then a paid model whose provider already holds a
   * key, so a switch never costs money the user did not agree to spend.
   * Another provider comes before the same one: a rate limit is usually about
   * the provider, not about the model. A provider that cannot be reached is
   * not a fallback at all, so it is left out.
   */
  async fallbackModels(failed: ModelInfo): Promise<ModelInfo[]> {
    const usable = new Set<string>()
    for (const provider of this.providers()) {
      if (await this.isUsable(provider)) usable.add(provider.id)
    }

    const candidates: ModelInfo[] = []
    // The catalogs are fetched in parallel. This runs on the throttled path,
    // and a provider that is down must not add its timeout to every other
    // provider's wait.
    const fetched = await Promise.allSettled(
      this.providers()
        .filter((provider) => usable.has(provider.id))
        .map(async (provider) => (await this.catalog(provider)).models.map((model) => this.applyOverride(model))),
    )
    for (const result of fetched) {
      // A provider that cannot be reached cannot answer, so it is left out.
      if (result.status === "fulfilled") candidates.push(...result.value)
    }

    const open = candidates.filter(
      (model) =>
        model.toolSupport &&
        model.status === "active" &&
        usable.has(model.providerID) &&
        !(model.providerID === failed.providerID && model.id === failed.id),
    )

    const rank = (model: ModelInfo): number => {
      let score = 0
      // The router knows which upstream still has quota.
      if (ProviderRegistry.isRouterAlias(model)) score -= 12
      // A throttled provider is likely still throttled.
      if (model.providerID === failed.providerID) score += 20
      // Free before paid.
      if (model.cost.input !== 0 || model.cost.output !== 0) score += 8
      return score
    }

    return open.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id))
  }

  /** Status of every provider, for the `/providers` view. */
  async status(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = []
    for (const provider of this.providers()) {
      const { key, source } = this.keyFor(provider)
      const usable = await this.isUsable(provider)
      const { models, notes, error } = usable
        ? await this.models(provider)
        : { models: [], notes: [], error: "no API key configured" }
      out.push({ provider, hasKey: Boolean(key), keySource: source, models, notes, error })
    }
    return out
  }
}

export function overrideFor(config: ConfigStore, key: string): ModelOverride | undefined {
  return config.modelOverride(key)
}

export type { ProviderState }
