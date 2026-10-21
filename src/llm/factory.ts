import { AnthropicClient } from "./anthropic.js"
import { LlmClient, type ChatClient } from "./client.js"
import type { ProviderConfig } from "../provider/types.js"

/**
 * The client for a provider.
 *
 * Most providers speak the OpenAI shape. Anthropic does not, and gets its
 * own client, so the rest of the app never has to know the difference.
 */
export function createClient(
  provider: ProviderConfig,
  apiKey: string | undefined,
  headers: Record<string, string> = {},
): ChatClient {
  if (provider.kind === "anthropic") {
    return new AnthropicClient({
      baseURL: provider.baseURL,
      apiKey,
      providerID: provider.id,
      headers,
    })
  }
  return new LlmClient({
    baseURL: provider.baseURL,
    apiKey,
    providerID: provider.id,
    headers,
  })
}
