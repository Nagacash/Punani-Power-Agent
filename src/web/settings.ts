import { ConfigStore, MEDIA_API_KEY_IDS } from "../config/store.js"
import { KNOWN_MCP_SERVERS } from "../mcp/client.js"
import type { McpServerConfig } from "../mcp/client.js"
import type { ImageSettings } from "../tool/image.js"
import type { AudioSettings } from "../tool/audio.js"
import { redact } from "../core/redact.js"
import { log } from "../core/logger.js"

/**
 * The settings API.
 *
 * Everything a user can configure from the browser lives here: provider keys,
 * endpoints, the image and speech backends, and the MCP servers.
 *
 * Two rules:
 *   1. A key is never sent back to the browser. Reads return whether a key is
 *      stored and where it came from, never the value.
 *   2. Every write goes through the same ConfigStore as the terminal, so both
 *      frontends edit one file.
 */

export type MediaKeySlot = (typeof MEDIA_API_KEY_IDS)[number]

export interface SettingsView {
  mediaKeys: Record<MediaKeySlot, { hasDiskKey: boolean }>
  providers: {
    id: string
    name: string
    kind: string
    baseURL: string
    anonymous: boolean
    hasKey: boolean
    keySource?: "config" | "env"
    modelCount: number
    builtin: boolean
  }[]
  image: Omit<ImageSettings, "apiKey"> & { hasKey: boolean }
  audio: Omit<AudioSettings, "apiKey"> & { hasKey: boolean }
  mcp: McpServerConfig[]
  knownMcp: { name: string; note: string; command: string }[]
  defaultModel?: string
}

export class Settings {
  constructor(private readonly config: ConfigStore) {}

  /** The whole configuration, with secrets left out. */
  view(modelCounts: Record<string, number> = {}): SettingsView {
    const stored = this.config.get()
    const providers = this.config.providers().map((provider) => {
      const { key, source } = this.config.apiKey(provider)
      const builtin = KNOWN_PROVIDER_IDS.has(provider.id) && !stored.providers[provider.id]
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseURL: provider.baseURL,
        anonymous: provider.anonymous === true,
        hasKey: Boolean(key),
        keySource: source,
        modelCount: modelCounts[provider.id] ?? 0,
        builtin,
      }
    })

    const image = { ...stored.image }
    const audio = { ...stored.audio }
    const mk = stored.mediaKeys ?? {}
    const imageHasKey =
      image.provider === "kling"
        ? Boolean(mk.kling)
        : image.provider === "openai-compatible"
          ? Boolean(mk.fal)
          : false
    const audioHasKey = Boolean(mk.elevenlabs)
    delete (image as any).apiKey
    delete (audio as any).apiKey

    const mediaKeys = {
      elevenlabs: { hasDiskKey: Boolean(mk.elevenlabs) },
      kling: { hasDiskKey: Boolean(mk.kling) },
      fal: { hasDiskKey: Boolean(mk.fal) },
    } satisfies Record<MediaKeySlot, { hasDiskKey: boolean }>

    return {
      mediaKeys,
      providers,
      image: { ...image, hasKey: imageHasKey },
      audio: { ...audio, hasKey: audioHasKey },
      mcp: stored.mcp.map((server) => ({
        ...server,
        env: server.env
          ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, value ? "«set»" : ""]))
          : undefined,
      })),
      knownMcp: Object.entries(KNOWN_MCP_SERVERS).map(([name, entry]) => ({
        name,
        note: entry.note,
        command: `${entry.command} ${(entry.args ?? []).join(" ")}`.trim(),
      })),
      defaultModel: stored.defaultModel,
    }
  }

  /** Store an API key. */
  setKey(providerId: string, key: string): { ok: boolean; error?: string } {
    const provider = this.config.provider(providerId)
    if (!provider) return { ok: false, error: `unknown provider "${providerId}"` }
    const value = key.trim()
    if (!value) return { ok: false, error: "the key was empty" }
    this.config.setApiKey(providerId, value)
    log.info(`settings: stored a key for ${providerId}`)
    return { ok: true }
  }

  clearKey(providerId: string): { ok: boolean } {
    this.config.clearApiKey(providerId)
    return { ok: true }
  }

  /** Point a provider somewhere else, or add a new one. */
  setProvider(input: {
    id: string
    baseURL?: string
    name?: string
    kind?: string
    enabled?: boolean
  }): { ok: boolean; error?: string } {
    const id = input.id?.trim()
    if (!id) return { ok: false, error: "a provider needs an id" }
    const existing = this.config.provider(id)
    if (!existing && !input.baseURL) {
      return { ok: false, error: "a new provider needs a base URL" }
    }
    const provider = {
      ...(existing ?? {
        id,
        kind: "openai-compatible" as const,
        name: id,
        baseURL: "",
        env: `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        defaultContextWindow: 32_768,
      }),
      id,
    }
    if (input.baseURL) provider.baseURL = input.baseURL.replace(/\/+$/, "")
    if (input.name) provider.name = input.name
    if (input.kind) provider.kind = input.kind as ImageSettings extends never ? never : any
    if (input.enabled !== undefined) provider.enabled = input.enabled
    this.config.setProvider(provider)
    return { ok: true }
  }

  removeProvider(providerId: string): { ok: boolean } {
    this.config.removeProvider(providerId)
    return { ok: true }
  }

  /** The image backend. */
  setImage(input: Partial<ImageSettings> & { apiKey?: string }): { ok: boolean; error?: string } {
    const current = this.config.imageSettings()
    const next: ImageSettings = { ...current }
    if (input.provider) next.provider = input.provider
    if (input.model !== undefined) next.model = input.model
    if (input.baseURL !== undefined) next.baseURL = input.baseURL.replace(/\/+$/, "")
    if (input.outputDir !== undefined) next.outputDir = input.outputDir
    if (input.timeoutSeconds !== undefined) next.timeoutSeconds = input.timeoutSeconds
    if (input.apiKey !== undefined) {
      const value = input.apiKey.trim()
      if (value) {
        if (next.provider === "none") next.provider = "openai-compatible"
        if (next.provider === "kling") this.config.setMediaKey("kling", value)
        else if (next.provider === "openai-compatible") this.config.setMediaKey("fal", value)
      }
    }
    delete next.apiKey
    this.config.setImageSettings(next)
    return { ok: true }
  }

  /** Store a speech or image API key (elevenlabs, kling, fal). */
  setMediaKey(id: (typeof MEDIA_API_KEY_IDS)[number], key: string): { ok: boolean; error?: string } {
    if (!MEDIA_API_KEY_IDS.includes(id)) return { ok: false, error: `unknown media key "${id}"` }
    const value = key.trim()
    if (!value) return { ok: false, error: "the key was empty" }
    const result = this.config.setMediaKey(id, value)
    if (!result.ok) return result
    log.info(`settings: stored media key ${id}`)
    return { ok: true }
  }

  clearMediaKey(id: (typeof MEDIA_API_KEY_IDS)[number]): { ok: boolean } {
    if (MEDIA_API_KEY_IDS.includes(id)) this.config.clearMediaKey(id)
    return { ok: true }
  }

  /** The speech backend. */
  setAudio(input: Partial<AudioSettings> & { apiKey?: string }): { ok: boolean; error?: string } {
    const current = this.config.audioSettings()
    const next: AudioSettings = { ...current }
    if (input.provider) next.provider = input.provider
    if (input.model !== undefined) next.model = input.model
    if (input.voiceId !== undefined) next.voiceId = input.voiceId
    if (input.voiceName !== undefined) next.voiceName = input.voiceName
    if (input.outputDir !== undefined) next.outputDir = input.outputDir
    if (input.outputFormat !== undefined) next.outputFormat = input.outputFormat
    if (input.apiKey !== undefined) {
      const value = input.apiKey.trim()
      if (value) {
        next.apiKey = value
        if (next.provider === "none") next.provider = "elevenlabs"
      }
    }
    this.config.setAudioSettings(next)
    return { ok: true }
  }

  /** Replace the MCP server list. */
  setMcp(servers: McpServerConfig[]): { ok: boolean; error?: string } {
    if (!Array.isArray(servers)) return { ok: false, error: "expected a list of servers" }
    const clean = servers
      .filter((server) => server && typeof server.name === "string" && typeof server.command === "string")
      .map((server) => ({
        name: server.name,
        command: server.command,
        args: Array.isArray(server.args) ? server.args.map(String) : undefined,
        env: server.env && typeof server.env === "object" ? server.env : undefined,
        enabled: server.enabled !== false,
        timeoutSeconds: Number(server.timeoutSeconds) || undefined,
      }))
    this.config.setMcpServers(clean)
    return { ok: true }
  }

  /** The default model. */
  setDefaultModel(model: string | undefined): { ok: boolean } {
    this.config.setDefaultModel(model)
    return { ok: true }
  }
}

/** The providers that ship with the app. */
const KNOWN_PROVIDER_IDS = new Set([
  "freellmapi",
  "ollama",
  "lmstudio",
  "openai",
  "openrouter",
  "nvidia",
  "groq",
  "cerebras",
])

export { redact }
