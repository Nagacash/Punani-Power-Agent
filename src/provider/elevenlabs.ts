/**
 * ElevenLabs text to speech.
 *
 * The API is small and stable:
 *   GET  /v1/voices                       -> the voice catalog
 *   GET  /v1/models                       -> the model catalog (needs a key)
 *   POST /v1/text-to-speech/{voice_id}    -> the audio bytes
 *
 * Auth is the `xi-api-key` header.
 */

export interface ElevenLabsVoice {
  voiceId: string
  name: string
  category: string
  description?: string
  labels?: Record<string, string>
}

export interface ElevenLabsModel {
  id: string
  name: string
  description?: string
  canDoTextToSpeech: boolean
}

export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"

/** Models that work for text to speech, used when the catalog is not reachable. */
export const KNOWN_TTS_MODELS = [
  "eleven_multilingual_v2",
  "eleven_turbo_v2_5",
  "eleven_flash_v2_5",
  "eleven_v3",
]

const TIMEOUT_MS = 60_000

async function call(
  path: string,
  apiKey: string | undefined,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    }
    if (apiKey) headers["xi-api-key"] = apiKey
    return await fetch(`${ELEVENLABS_BASE_URL}${path}`, { ...init, headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Read the error body in ElevenLabs' shape: `{detail: {message, code}}`. */
function readError(body: string): string {
  try {
    const parsed = JSON.parse(body)
    const detail = parsed?.detail
    if (typeof detail === "string") return detail
    if (detail?.message) return String(detail.message)
    if (parsed?.message) return String(parsed.message)
  } catch {
    /* not JSON */
  }
  const trimmed = body.trim()
  if (!trimmed) return "no error detail was returned"
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed
}

/**
 * The voice catalog.
 *
 * The public endpoint answers without a key, but an *invalid* key is rejected
 * outright. So a mistyped key falls back to the public list, and the caller
 * still gets to see the voices while the key problem is reported.
 */
export async function listVoices(apiKey?: string): Promise<ElevenLabsVoice[]> {
  try {
    return await fetchVoices(apiKey)
  } catch (error) {
    if (!apiKey) throw error
    const fallback = await fetchVoices(undefined).catch(() => [] as ElevenLabsVoice[])
    if (fallback.length > 0) {
      throw new Error(
        `${(error as Error).message}. The public voice list is shown below, but the key is not valid yet.`,
      )
    }
    throw error
  }
}

async function fetchVoices(apiKey?: string): Promise<ElevenLabsVoice[]> {
  const response = await call("/voices", apiKey)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`could not fetch the ElevenLabs voices: ${readError(text)}`)
  }
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error("the ElevenLabs voices endpoint did not return valid JSON")
  }
  const rows: any[] = Array.isArray(payload?.voices) ? payload.voices : []
  return rows
    .map((row) => ({
      voiceId: String(row?.voice_id ?? ""),
      name: String(row?.name ?? ""),
      category: String(row?.category ?? ""),
      description: typeof row?.description === "string" ? row.description : undefined,
      labels: row?.labels,
    }))
    .filter((voice) => voice.voiceId !== "")
}

/** The model catalog. Needs a key. */
export async function listModels(apiKey?: string): Promise<ElevenLabsModel[]> {
  if (!apiKey) return KNOWN_TTS_MODELS.map((id) => ({ id, name: id, canDoTextToSpeech: true }))
  const response = await call("/models", apiKey)
  const text = await response.text()
  if (!response.ok) return KNOWN_TTS_MODELS.map((id) => ({ id, name: id, canDoTextToSpeech: true }))
  let payload: any
  try {
    payload = JSON.parse(text)
  } catch {
    return KNOWN_TTS_MODELS.map((id) => ({ id, name: id, canDoTextToSpeech: true }))
  }
  const rows: any[] = Array.isArray(payload) ? payload : []
  const models = rows.map((row) => ({
    id: String(row?.model_id ?? row?.id ?? ""),
    name: String(row?.name ?? row?.model_id ?? ""),
    description: typeof row?.description === "string" ? row.description : undefined,
    canDoTextToSpeech: row?.can_do_text_to_speech !== false,
  }))
  const usable = models.filter((model) => model.canDoTextToSpeech && model.id !== "")
  return usable.length > 0 ? usable : KNOWN_TTS_MODELS.map((id) => ({ id, name: id, canDoTextToSpeech: true }))
}

export interface SynthesizeOptions {
  text: string
  voiceId: string
  modelId?: string
  /** ElevenLabs output format, e.g. mp3_44100_128. */
  outputFormat?: string
  stability?: number
  similarityBoost?: number
  speed?: number
}

export interface SynthesizeResult {
  audio: Buffer
  contentType: string
  requestId?: string
}

/** Turn text into speech. Returns the raw audio bytes. */
export async function synthesize(apiKey: string, options: SynthesizeOptions): Promise<SynthesizeResult> {
  if (!apiKey) {
    throw new Error("no ElevenLabs API key. Set one with: /audio key <value>")
  }
  if (!options.voiceId) {
    throw new Error("no ElevenLabs voice is set. Pick one with: /audio voice")
  }

  const body: Record<string, unknown> = { text: options.text }
  if (options.modelId) body.model_id = options.modelId

  const voiceSettings: Record<string, number> = {}
  if (options.stability !== undefined) voiceSettings.stability = options.stability
  if (options.similarityBoost !== undefined) voiceSettings.similarity_boost = options.similarityBoost
  if (options.speed !== undefined) voiceSettings.speed = options.speed
  if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings

  const query = options.outputFormat ? `?output_format=${encodeURIComponent(options.outputFormat)}` : ""
  const response = await call(`/text-to-speech/${encodeURIComponent(options.voiceId)}${query}`, apiKey, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`ElevenLabs returned HTTP ${response.status}: ${readError(text)}`)
  }

  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length === 0) throw new Error("ElevenLabs returned an empty audio file")
  return {
    audio,
    contentType: response.headers.get("content-type") ?? "audio/mpeg",
    requestId: response.headers.get("x-request-id") ?? undefined,
  }
}

/** The file extension that matches an output format. */
export function extensionFor(outputFormat: string | undefined): string {
  if (!outputFormat) return "mp3"
  if (outputFormat.startsWith("wav")) return "wav"
  if (outputFormat.startsWith("pcm")) return "pcm"
  if (outputFormat.startsWith("opus")) return "opus"
  if (outputFormat.startsWith("ulaw")) return "ulaw"
  if (outputFormat.startsWith("alaw")) return "alaw"
  return "mp3"
}
