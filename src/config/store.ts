import fs from "node:fs"
import path from "node:path"
import { paths } from "../core/paths.js"
import { registerSecret } from "../core/redact.js"
import { BUILTIN_PROVIDERS, type ModelOverride } from "../provider/builtin.js"
import type { ProviderConfig } from "../provider/types.js"
import type { ImageSettings } from "../tool/image.js"
import type { AudioSettings } from "../tool/audio.js"
import type { McpServerConfig } from "../mcp/client.js"

/**
 * The single local config file.
 *
 * It holds provider definitions, API keys, per-model overrides and the
 * permission ruleset. It is written with mode 0600 and the directory with 0700,
 * so it is readable only by the owner. Keys are also registered with the
 * redactor so they can never be printed.
 */

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  pattern: string
  effect: PermissionEffect
}

export interface ConfigFile {
  version: 1
  defaultModel?: string
  defaultProvider?: string
  providers: Record<string, ProviderConfig>
  /** provider id -> API key. Never leaves the machine except to its own endpoint. */
  apiKeys: Record<string, string>
  /** "provider/model" -> overrides. */
  models: Record<string, ModelOverride>
  /** tool action -> ordered rules. Last match wins. */
  permissions: Record<string, PermissionRule[]>
  /** Extra headers sent with requests, per provider id. */
  headers: Record<string, Record<string, string>>
  /** Image generation backend. */
  image: ImageSettings
  /** Speech generation backend. */
  audio: AudioSettings
  /** MCP servers to start with the agent. */
  mcp: McpServerConfig[]
}

export const DEFAULT_PERMISSIONS: Record<string, PermissionRule[]> = {
  read: [{ pattern: "*", effect: "allow" }],
  search: [{ pattern: "*", effect: "allow" }],
  write: [{ pattern: "*", effect: "ask" }],
  edit: [{ pattern: "*", effect: "ask" }],
  // The general rule comes first: the last matching rule wins, so the
  // specific allowances below have to be listed after it.
  bash: [
    { pattern: "*", effect: "ask" },
    { pattern: "git status*", effect: "allow" },
    { pattern: "git diff*", effect: "allow" },
    { pattern: "git log*", effect: "allow" },
    { pattern: "ls*", effect: "allow" },
    { pattern: "cat*", effect: "allow" },
  ],
}

function emptyConfig(): ConfigFile {
  return {
    version: 1,
    providers: {},
    apiKeys: {},
    models: {},
    permissions: structuredClone(DEFAULT_PERMISSIONS),
    headers: {},
    image: { provider: "none" },
    audio: { provider: "none" },
    mcp: [],
  }
}

function coerce(raw: any): ConfigFile {
  const base = emptyConfig()
  if (!raw || typeof raw !== "object") return base
  const config: ConfigFile = {
    version: 1,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
    providers: {},
    apiKeys: {},
    models: {},
    permissions: {},
    headers: {},
    image: { provider: "none" },
    audio: { provider: "none" },
    mcp: [],
  }
  if (raw.providers && typeof raw.providers === "object") {
    for (const [id, value] of Object.entries<any>(raw.providers)) {
      if (!value || typeof value !== "object") continue
      config.providers[id] = {
        id: value.id ?? id,
        kind: value.kind ?? "openai-compatible",
        name: value.name ?? id,
        baseURL: String(value.baseURL ?? "").replace(/\/+$/, ""),
        env: typeof value.env === "string" ? value.env : undefined,
        anonymous: value.anonymous === true,
        defaultContextWindow: Number(value.defaultContextWindow) || undefined,
        enabled: value.enabled !== false,
      }
    }
  }
  if (raw.apiKeys && typeof raw.apiKeys === "object") {
    for (const [id, value] of Object.entries<any>(raw.apiKeys)) {
      if (typeof value === "string" && value.length > 0) config.apiKeys[id] = value
    }
  }
  if (raw.models && typeof raw.models === "object") {
    for (const [id, value] of Object.entries<any>(raw.models)) {
      if (value && typeof value === "object") config.models[id] = value as ModelOverride
    }
  }
  if (raw.permissions && typeof raw.permissions === "object") {
    for (const [action, rules] of Object.entries<any>(raw.permissions)) {
      if (!Array.isArray(rules)) continue
      config.permissions[action] = rules
        .filter((rule: any) => rule && typeof rule.pattern === "string")
        .map((rule: any) => ({
          pattern: rule.pattern,
          effect: (["allow", "ask", "deny"].includes(rule.effect) ? rule.effect : "ask") as PermissionEffect,
        }))
    }
  }
  for (const action of Object.keys(DEFAULT_PERMISSIONS)) {
    if (!config.permissions[action]) config.permissions[action] = structuredClone(DEFAULT_PERMISSIONS[action]!)
  }
  if (raw.image && typeof raw.image === "object") {
    const image = raw.image
    config.image = {
      provider: ["kling", "openai-compatible", "none"].includes(image.provider) ? image.provider : "none",
      model: typeof image.model === "string" ? image.model : undefined,
      baseURL: typeof image.baseURL === "string" ? image.baseURL.replace(/\/+$/, "") : undefined,
      apiKey: typeof image.apiKey === "string" && image.apiKey.length > 0 ? image.apiKey : undefined,
      outputDir: typeof image.outputDir === "string" ? image.outputDir : undefined,
      timeoutSeconds: Number(image.timeoutSeconds) || undefined,
    }
    if (config.image.apiKey) registerSecret(config.image.apiKey)
  }
  if (raw.audio && typeof raw.audio === "object") {
    const audio = raw.audio
    config.audio = {
      provider: audio.provider === "elevenlabs" ? "elevenlabs" : "none",
      apiKey: typeof audio.apiKey === "string" && audio.apiKey.length > 0 ? audio.apiKey : undefined,
      model: typeof audio.model === "string" ? audio.model : undefined,
      voiceId: typeof audio.voiceId === "string" ? audio.voiceId : undefined,
      voiceName: typeof audio.voiceName === "string" ? audio.voiceName : undefined,
      outputDir: typeof audio.outputDir === "string" ? audio.outputDir : undefined,
      outputFormat: typeof audio.outputFormat === "string" ? audio.outputFormat : undefined,
      stability: Number.isFinite(Number(audio.stability)) ? Number(audio.stability) : undefined,
      speed: Number.isFinite(Number(audio.speed)) ? Number(audio.speed) : undefined,
    }
    if (config.audio.apiKey) registerSecret(config.audio.apiKey)
  }
  if (Array.isArray(raw.mcp)) {
    config.mcp = raw.mcp
      .filter((entry: any) => entry && typeof entry.name === "string" && typeof entry.command === "string")
      .map((entry: any) => ({
        name: entry.name,
        command: entry.command,
        args: Array.isArray(entry.args) ? entry.args.map(String) : undefined,
        env: entry.env && typeof entry.env === "object" ? entry.env : undefined,
        enabled: entry.enabled !== false,
        timeoutSeconds: Number(entry.timeoutSeconds) || undefined,
      }))
  }
  if (raw.headers && typeof raw.headers === "object") {
    for (const [id, value] of Object.entries<any>(raw.headers)) {
      if (value && typeof value === "object") config.headers[id] = value
    }
  }
  return config
}

export class ConfigStore {
  private config!: ConfigFile
  private loaded = false

  constructor(private readonly file: string = paths.configFile) {}

  get path(): string {
    return this.file
  }

  load(): ConfigFile {
    if (this.loaded) return this.config
    let raw: any = undefined
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `config file at ${this.file} could not be read: ${(error as Error).message}. ` +
            "Fix or delete it and re-run.",
        )
      }
    }
    this.config = coerce(raw)
    for (const key of Object.values(this.config.apiKeys)) registerSecret(key)
    this.loaded = true
    return this.config
  }

  private ensureLoaded(): void {
    if (!this.loaded) this.load()
  }

  get(): ConfigFile {
    this.ensureLoaded()
    return this.config
  }

  /** All provider definitions: user-defined ones plus the built-ins not overridden. */
  providers(): ProviderConfig[] {
    const config = this.get()
    const map = new Map<string, ProviderConfig>()
    for (const builtin of BUILTIN_PROVIDERS) {
      map.set(builtin.config.id, { ...builtin.config })
    }
    for (const [id, value] of Object.entries(config.providers)) {
      map.set(id, { ...value, id })
    }
    return [...map.values()].filter((provider) => provider.enabled !== false)
  }

  provider(id: string): ProviderConfig | undefined {
    return this.providers().find((entry) => entry.id === id)
  }

  /** API key for a provider, preferring the config file, then the env var. */
  apiKey(provider: ProviderConfig): { key?: string; source?: "config" | "env" } {
    const config = this.get()
    const stored = config.apiKeys[provider.id]
    if (stored) return { key: stored, source: "config" }
    if (provider.env) {
      const fromEnv = process.env[provider.env]
      if (fromEnv) {
        registerSecret(fromEnv)
        return { key: fromEnv, source: "env" }
      }
    }
    return {}
  }

  setApiKey(providerId: string, key: string): void {
    const config = this.get()
    config.apiKeys[providerId] = key
    registerSecret(key)
    this.save()
  }

  clearApiKey(providerId: string): void {
    const config = this.get()
    delete config.apiKeys[providerId]
    this.save()
  }

  setProvider(provider: ProviderConfig): void {
    const config = this.get()
    config.providers[provider.id] = provider
    this.save()
  }

  removeProvider(providerId: string): void {
    const config = this.get()
    delete config.providers[providerId]
    delete config.apiKeys[providerId]
    this.save()
  }

  setDefaultModel(key: string | undefined): void {
    const config = this.get()
    config.defaultModel = key
    this.save()
  }

  setModelOverride(key: string, override: ModelOverride): void {
    const config = this.get()
    config.models[key] = { ...(config.models[key] ?? {}), ...override }
    this.save()
  }

  modelOverride(key: string): ModelOverride | undefined {
    return this.get().models[key]
  }

  permissions(): Record<string, PermissionRule[]> {
    return this.get().permissions
  }

  setPermissions(rules: Record<string, PermissionRule[]>): void {
    const config = this.get()
    config.permissions = rules
    this.save()
  }

  headers(providerId: string): Record<string, string> {
    return this.get().headers[providerId] ?? {}
  }

  imageSettings(): ImageSettings {
    return this.get().image
  }

  audioSettings(): AudioSettings {
    return this.get().audio
  }

  mcpServers(): McpServerConfig[] {
    return this.get().mcp
  }

  setMcpServers(servers: McpServerConfig[]): void {
    const config = this.get()
    config.mcp = servers
    this.save()
  }

  setAudioSettings(settings: AudioSettings): void {
    const config = this.get()
    config.audio = settings
    if (settings.apiKey) registerSecret(settings.apiKey)
    this.save()
  }

  setImageSettings(settings: ImageSettings): void {
    const config = this.get()
    config.image = settings
    if (settings.apiKey) registerSecret(settings.apiKey)
    this.save()
  }

  /** Persist with restrictive permissions. The key never leaves this machine. */
  save(): void {
    const dir = path.dirname(this.file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try {
      fs.chmodSync(dir, 0o700)
    } catch {
      /* best effort */
    }
    const payload = `${JSON.stringify(this.get(), null, 2)}\n`
    const temp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temp, payload, { mode: 0o600 })
    fs.renameSync(temp, this.file)
    try {
      fs.chmodSync(this.file, 0o600)
    } catch {
      /* best effort */
    }
  }

  /** True when the file exists and is not readable by group/other. */
  permissionsSafe(): { ok: boolean; mode: string | undefined } {
    try {
      const stat = fs.statSync(this.file)
      const mode = (stat.mode & 0o777).toString(8).padStart(3, "0")
      return { ok: (stat.mode & 0o077) === 0, mode }
    } catch {
      return { ok: true, mode: undefined }
    }
  }
}
