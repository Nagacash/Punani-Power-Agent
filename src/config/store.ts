import fs from "node:fs"
import path from "node:path"
import { paths } from "../core/paths.js"
import { registerSecret } from "../core/redact.js"
import { BUILTIN_PROVIDERS, type ModelOverride } from "../provider/builtin.js"
import type { ProviderConfig, ReasoningEffort } from "../provider/types.js"
import type { ImageSettings } from "../tool/image.js"
import type { AudioSettings } from "../tool/audio.js"
import { resolveTtsModelId } from "../provider/elevenlabs.js"
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
  /** Speech/image keys — separate from LLM provider keys even when ids overlap (e.g. provider "kling"). */
  mediaKeys: Record<string, string>
  /** "provider/model" -> overrides. */
  models: Record<string, ModelOverride>
  /** "provider/model" -> how hard the model is asked to think. */
  reasoningEffort?: Record<string, ReasoningEffort>
  /** tool action -> ordered rules. Last match wins. */
  permissions: Record<string, PermissionRule[]>
  /** Which version of the default rules this file was written against. */
  permissionsVersion?: number
  /** Extra headers sent with requests, per provider id. */
  headers: Record<string, Record<string, string>>
  /** Image generation backend. */
  image: ImageSettings
  /** Speech generation backend. */
  audio: AudioSettings
  /** MCP servers to start with the agent. */
  mcp: McpServerConfig[]
}

/**
 * The rules that ship with the app.
 *
 * The work itself does not need a signature. An agent that stops for every
 * line is an agent the user has to watch, and the user cannot get anything
 * done. So reading, writing, editing and running a command go through, and
 * only what can lose work or reach outside the project asks.
 *
 * The dangerous half of a tool has its own action, so the rules for it can
 * be separate: `bash` is an ordinary command, `bash-destructive` is one that
 * can lose work.
 */
export const DEFAULT_PERMISSIONS: Record<string, PermissionRule[]> = {
  read: [{ pattern: "*", effect: "allow" }],
  search: [{ pattern: "*", effect: "allow" }],
  write: [{ pattern: "*", effect: "allow" }],
  edit: [{ pattern: "*", effect: "allow" }],
  bash: [{ pattern: "*", effect: "allow" }],
  fetch: [{ pattern: "*", effect: "allow" }],
  // These ask. The first pair can overwrite what is there; the last can
  // delete it.
  "write-destructive": [{ pattern: "*", effect: "ask" }],
  "edit-destructive": [{ pattern: "*", effect: "ask" }],
  "bash-destructive": [{ pattern: "*", effect: "ask" }],
}

/**
 * The rules that shipped before the agent stopped for every line.
 *
 * A config that still carries them gets the new ones, so the change lands
 * on a machine that has been running the app for a while. A rule the user
 * wrote is kept.
 */
const LEGACY_PERMISSIONS: Record<string, PermissionRule[]> = {
  read: [{ pattern: "*", effect: "allow" }],
  search: [{ pattern: "*", effect: "allow" }],
  write: [{ pattern: "*", effect: "ask" }],
  edit: [{ pattern: "*", effect: "ask" }],
  bash: [
    { pattern: "*", effect: "ask" },
    { pattern: "git status*", effect: "allow" },
    { pattern: "git diff*", effect: "allow" },
    { pattern: "git log*", effect: "allow" },
    { pattern: "ls*", effect: "allow" },
    { pattern: "cat*", effect: "allow" },
  ],
}

/**
 * Which version of the default rules this config was written against.
 *
 * Bumped when the defaults change, so a config can be brought forward.
 */
export const PERMISSIONS_VERSION = 2

/** Media backends store keys here — not duplicated under `image` / `audio`. */
export const MEDIA_API_KEY_IDS = ["elevenlabs", "kling", "fal"] as const

function ensureMediaKeys(config: ConfigFile): Record<string, string> {
  if (!config.mediaKeys || typeof config.mediaKeys !== "object") config.mediaKeys = {}
  return config.mediaKeys
}

function normalizeMediaKeys(config: ConfigFile): boolean {
  let migrated = false
  const media = ensureMediaKeys(config)
  if (config.audio.apiKey) {
    if (!media.elevenlabs) media.elevenlabs = config.audio.apiKey
    delete config.audio.apiKey
    migrated = true
  }
  if (config.image.apiKey) {
    const key = config.image.apiKey
    const speech = media.elevenlabs ?? config.apiKeys.elevenlabs
    if (config.image.provider === "kling" && key !== speech) {
      if (!media.kling) media.kling = key
    } else if (config.image.provider === "openai-compatible" && key !== speech) {
      if (!media.fal) media.fal = key
    }
    delete config.image.apiKey
    migrated = true
  }
  if (!media.elevenlabs && config.apiKeys.elevenlabs && config.audio.provider === "elevenlabs") {
    media.elevenlabs = config.apiKeys.elevenlabs
    migrated = true
  }
  for (const id of MEDIA_API_KEY_IDS) {
    const legacy = config.apiKeys[id]
    if (legacy && !media[id]) {
      media[id] = legacy
      migrated = true
    }
    if (legacy && !config.providers[id]) {
      delete config.apiKeys[id]
      migrated = true
    }
  }
  const speech = media.elevenlabs
  if (speech) {
    if (media.kling === speech) {
      delete media.kling
      migrated = true
    }
    if (media.fal === speech) {
      delete media.fal
      migrated = true
    }
  }
  return migrated
}

/** Web UI or mistaken `/audio voice` list numbers sometimes land in `audio.model`. */
function normalizeAudioSettings(config: ConfigFile): boolean {
  const model = config.audio.model
  if (!model) return false
  const resolved = resolveTtsModelId(model)
  if (resolved === model) return false
  if (resolved) config.audio.model = resolved
  else delete config.audio.model
  return true
}

function emptyConfig(): ConfigFile {
  return {
    version: 1,
    providers: {},
    apiKeys: {},
    mediaKeys: {},
    models: {},
    permissions: structuredClone(DEFAULT_PERMISSIONS),
    permissionsVersion: PERMISSIONS_VERSION,
    headers: {},
    image: { provider: "none" },
    audio: { provider: "none" },
    mcp: [],
  }
}

/** Keys that would change the shape of an object rather than fill it. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"])

function coerce(raw: any): { config: ConfigFile; migratedPermissions: boolean; migratedMedia: boolean } {
  const base = emptyConfig()
  if (!raw || typeof raw !== "object") return { config: base, migratedPermissions: false, migratedMedia: false }
  let migratedPermissions = false
  const config: ConfigFile = {
    version: 1,
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
    defaultProvider: typeof raw.defaultProvider === "string" ? raw.defaultProvider : undefined,
    providers: {},
    apiKeys: {},
    mediaKeys: {},
    models: {},
    permissions: {},
    permissionsVersion: PERMISSIONS_VERSION,
    headers: {},
    image: { provider: "none" },
    audio: { provider: "none" },
    mcp: [],
  }
  if (raw.providers && typeof raw.providers === "object") {
    for (const [id, value] of Object.entries<any>(raw.providers)) {
      if (!value || typeof value !== "object") continue
      if (DANGEROUS_KEYS.has(id)) continue
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
      if (typeof value === "string" && value.length > 0 && !DANGEROUS_KEYS.has(id)) config.apiKeys[id] = value
    }
  }
  if (raw.mediaKeys && typeof raw.mediaKeys === "object") {
    for (const [id, value] of Object.entries<any>(raw.mediaKeys)) {
      if (typeof value === "string" && value.length > 0 && !DANGEROUS_KEYS.has(id)) config.mediaKeys[id] = value
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
  // A config written before the rules changed is brought forward: the old
  // defaults are replaced by the new ones, and a rule the user wrote stays.
  if (raw.permissionsVersion !== PERMISSIONS_VERSION) {
    for (const action of Object.keys(DEFAULT_PERMISSIONS)) {
      const stored = config.permissions[action] ?? []
      const kept = stored.filter(
        (rule) =>
          !(LEGACY_PERMISSIONS[action] ?? []).some(
            (old) => old.pattern === rule.pattern && old.effect === rule.effect,
          ),
      )
      config.permissions[action] = [...structuredClone(DEFAULT_PERMISSIONS[action]!), ...kept]
    }
    config.permissionsVersion = PERMISSIONS_VERSION
    migratedPermissions = true
  } else {
    for (const action of Object.keys(DEFAULT_PERMISSIONS)) {
      if (!config.permissions[action]) {
        config.permissions[action] = structuredClone(DEFAULT_PERMISSIONS[action]!)
      }
    }
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
  const migratedMedia = normalizeMediaKeys(config)
  const migratedAudio = normalizeAudioSettings(config)
  return { config, migratedPermissions, migratedMedia: migratedMedia || migratedAudio }
}

export class ConfigStore {
  private config!: ConfigFile
  private loaded = false
  /** Last known mtime of the config file on disk (for reload when another process saves). */
  private diskMtimeMs = 0

  constructor(private readonly file: string = paths.configFile) {}

  get path(): string {
    return this.file
  }

  load(): ConfigFile {
    if (this.loaded) return this.config
    return this.readFromDisk()
  }

  /** Pick up `/audio key`, web Settings, or hand edits from another process. */
  reloadFromDiskIfNewer(): void {
    this.ensureLoaded()
    let mtime = 0
    try {
      mtime = fs.statSync(this.file).mtimeMs
    } catch {
      return
    }
    if (mtime <= this.diskMtimeMs) return
    this.loaded = false
    this.readFromDisk()
  }

  private readFromDisk(): ConfigFile {
    let raw: any = undefined
    let fileExisted = false
    try {
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"))
      fileExisted = true
      this.diskMtimeMs = fs.statSync(this.file).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `config file at ${this.file} could not be read: ${(error as Error).message}. ` +
            "Fix or delete it and re-run.",
        )
      }
    }
    const { config, migratedPermissions, migratedMedia } = coerce(raw)
    this.config = config
    for (const key of Object.values(this.config.apiKeys)) registerSecret(key)
    for (const key of Object.values(this.config.mediaKeys ?? {})) registerSecret(key)
    this.loaded = true
    if ((migratedPermissions || migratedMedia) && fileExisted) this.save()
    else if (fileExisted) {
      try {
        this.diskMtimeMs = fs.statSync(this.file).mtimeMs
      } catch {
        /* best effort */
      }
    }
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
    if (providerId === "elevenlabs") {
      ensureMediaKeys(config).elevenlabs = key
      if (config.audio.provider === "none") config.audio.provider = "elevenlabs"
    }
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

  /** How hard a model is asked to think. */
  reasoningEffort(key: string): ReasoningEffort | undefined {
    return this.get().reasoningEffort?.[key]
  }

  setReasoningEffort(key: string, effort: ReasoningEffort | undefined): void {
    const config = this.get()
    config.reasoningEffort = config.reasoningEffort ?? {}
    if (effort) config.reasoningEffort[key] = effort
    else delete config.reasoningEffort[key]
    this.save()
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

  /** ElevenLabs speech key — only `mediaKeys.elevenlabs` (not LLM provider keys). */
  elevenLabsKey(): string | undefined {
    const config = this.get()
    return config.mediaKeys?.elevenlabs ?? config.audio.apiKey
  }

  mediaKey(id: (typeof MEDIA_API_KEY_IDS)[number]): string | undefined {
    return this.get().mediaKeys?.[id]
  }

  setMediaKey(id: (typeof MEDIA_API_KEY_IDS)[number], key: string): { ok: boolean; error?: string } {
    const value = key.trim()
    if (!value) return { ok: false, error: "the key was empty" }
    const config = this.get()
    const media = ensureMediaKeys(config)
    const eleven = media.elevenlabs ?? config.audio.apiKey
    if (id !== "elevenlabs" && eleven && value === eleven) {
      return {
        ok: false,
        error:
          "that is the same value as your ElevenLabs speech key. Use a different Kling/image key, or save speech under Settings → speech.",
      }
    }
    if (id === "elevenlabs" && media.kling === value) delete media.kling
    if (id === "elevenlabs" && media.fal === value) delete media.fal
    media[id] = value
    registerSecret(value)
    if (id === "elevenlabs") {
      delete config.audio.apiKey
      if (config.audio.provider === "none") config.audio.provider = "elevenlabs"
    }
    if (id === "kling" && config.image.provider === "kling") delete config.image.apiKey
    this.save()
    return { ok: true }
  }

  /** Image settings with keys resolved for the active backend. */
  resolvedImageSettings(overrides?: Partial<Record<(typeof MEDIA_API_KEY_IDS)[number], string>>): ImageSettings {
    const image = { ...this.get().image }
    delete image.apiKey
    if (image.provider === "kling") return image
    if (image.provider === "openai-compatible") {
      const fal = overrides?.fal ?? this.mediaKey("fal")
      return fal ? { ...image, apiKey: fal } : image
    }
    return image
  }

  /** Speech settings; ElevenLabs auth comes from `apiKeys.elevenlabs`. */
  resolvedAudioSettings(overrides?: Partial<Record<(typeof MEDIA_API_KEY_IDS)[number], string>>): AudioSettings {
    const audio = { ...this.get().audio }
    delete audio.apiKey
    const key = overrides?.elevenlabs ?? this.elevenLabsKey()
    return key && audio.provider === "elevenlabs" ? { ...audio, apiKey: key } : audio
  }

  clearMediaKey(id: (typeof MEDIA_API_KEY_IDS)[number]): void {
    const config = this.get()
    const media = ensureMediaKeys(config)
    delete media[id]
    this.save()
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
    const { apiKey, ...audio } = settings
    if (audio.model !== undefined) {
      const resolved = resolveTtsModelId(audio.model)
      if (resolved) audio.model = resolved
      else delete audio.model
    }
    config.audio = audio
    if (typeof apiKey === "string" && apiKey.trim()) {
      ensureMediaKeys(config).elevenlabs = apiKey.trim()
      registerSecret(apiKey)
      delete config.audio.apiKey
    }
    this.save()
  }

  setImageSettings(settings: ImageSettings): void {
    const config = this.get()
    const { apiKey, ...rest } = settings
    config.image = { ...rest }
    const next = config.image
    if (typeof apiKey === "string" && apiKey.trim()) {
      const value = apiKey.trim()
      if (next.provider === "kling") this.setMediaKey("kling", value)
      else if (next.provider === "openai-compatible") this.setMediaKey("fal", value)
    }
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
      this.diskMtimeMs = fs.statSync(this.file).mtimeMs
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
