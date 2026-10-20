import type { ModelInfo, ProviderConfig, ProviderKind } from "./types.js"

/**
 * Built-in provider definitions.
 *
 * Every one of them speaks the OpenAI wire protocol (`/models` + `/chat/completions`),
 * so a single client covers all of them. FreeLLMAPI and the two local runtimes are
 * the three recommended tiers; the generic entry lets the user point at anything else.
 */

export interface BuiltinProvider {
  config: ProviderConfig
  /** Model ids offered before a catalog lookup succeeds. */
  seedModels: string[]
  /** True when the provider must not be contacted without a key. */
  requiresKey: boolean
}

export const FREELLMAPI_DEFAULT_BASE_URL = "http://localhost:3001/v1"

export const BUILTIN_PROVIDERS: BuiltinProvider[] = [
  {
    config: {
      id: "freellmapi",
      kind: "freellmapi",
      name: "FreeLLMAPI",
      baseURL: FREELLMAPI_DEFAULT_BASE_URL,
      env: "FREELLMAPI_API_KEY",
      defaultContextWindow: 32_768,
    },
    // The router itself is addressable as `auto`; the catalog is fetched live.
    seedModels: ["auto"],
    requiresKey: true,
  },
  {
    config: {
      id: "ollama",
      kind: "ollama",
      name: "Ollama (local)",
      baseURL: "http://localhost:11434",
      env: "OLLAMA_API_KEY",
      anonymous: true,
      defaultContextWindow: 32_768,
    },
    seedModels: [],
    requiresKey: false,
  },
  {
    config: {
      id: "lmstudio",
      kind: "lmstudio",
      name: "LM Studio (local)",
      baseURL: "http://localhost:1234/v1",
      env: "LMSTUDIO_API_KEY",
      anonymous: true,
      defaultContextWindow: 32_768,
    },
    seedModels: [],
    requiresKey: false,
  },
  {
    config: {
      id: "openai",
      kind: "openai-compatible",
      name: "OpenAI",
      baseURL: "https://api.openai.com/v1",
      env: "OPENAI_API_KEY",
      defaultContextWindow: 128_000,
    },
    seedModels: ["gpt-4o-mini", "gpt-4o", "o4-mini"],
    requiresKey: true,
  },
  {
    config: {
      id: "openrouter",
      kind: "openai-compatible",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      env: "OPENROUTER_API_KEY",
      defaultContextWindow: 128_000,
    },
    seedModels: [],
    requiresKey: true,
  },
  {
    config: {
      id: "nvidia",
      kind: "openai-compatible",
      name: "NVIDIA NIM",
      baseURL: "https://integrate.api.nvidia.com/v1",
      env: "NVIDIA_API_KEY",
      defaultContextWindow: 128_000,
    },
    // Free API credits on signup. The catalog is public; inference needs a key.
    seedModels: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
      "deepseek-ai/deepseek-v4.1-flash",
      "mistralai/codestral-22b-instruct-v0.1",
    ],
    requiresKey: true,
  },
  {
    config: {
      id: "groq",
      kind: "openai-compatible",
      name: "Groq",
      baseURL: "https://api.groq.com/openai/v1",
      env: "GROQ_API_KEY",
      defaultContextWindow: 128_000,
    },
    seedModels: [],
    requiresKey: true,
  },
  {
    config: {
      id: "cerebras",
      kind: "openai-compatible",
      name: "Cerebras",
      baseURL: "https://api.cerebras.ai/v1",
      env: "CEREBRAS_API_KEY",
      defaultContextWindow: 128_000,
    },
    seedModels: [],
    requiresKey: true,
  },
]

export function builtinByKind(kind: ProviderKind): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS.find((entry) => entry.config.kind === kind)
}

export function builtinById(id: string): BuiltinProvider | undefined {
  return BUILTIN_PROVIDERS.find((entry) => entry.config.id === id)
}

/** Per-model overrides the user can set in the config file. */
export interface ModelOverride {
  contextWindow?: number
  toolSupport?: boolean
  maxOutput?: number
  cost?: { input?: number; output?: number }
  status?: ModelInfo["status"]
  name?: string
}
