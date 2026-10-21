import type { ChatClient, ChatMessage } from "../llm/client.js"
import type { ModelInfo } from "../provider/types.js"

/**
 * Compaction.
 *
 * A conversation that grows without end gets slower and more expensive, and
 * eventually the provider refuses it. The fix is to fold the old part into a
 * summary and keep the recent part whole.
 *
 * Two rules keep it honest:
 *
 *   - The summary is written by the model, in its own words, so it keeps the
 *     decisions and the reasons and not just the topics.
 *   - The recent turns are kept exactly as they were. A summary of the last
 *     exchange is worse than the exchange.
 */

/** How many messages are kept whole at the end of a conversation. */
export const KEEP_RECENT = 8

/** Characters per token, the usual estimate. */
const CHARS_PER_TOKEN = 4

/** The share of the context window a conversation may fill before it is folded. */
const DEFAULT_LIMIT = 0.5

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function messageTokens(message: ChatMessage): number {
  if (typeof message.content === "string") return estimateTokens(message.content)
  if (Array.isArray(message.content)) {
    return estimateTokens(message.content.map((part) => part.text ?? "").join(" "))
  }
  return 0
}

export function conversationTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += messageTokens(message)
    if (message.toolCalls) {
      for (const call of message.toolCalls) total += estimateTokens(call.arguments)
    }
  }
  return total
}

/** True when the conversation is long enough to be worth folding. */
export function shouldCompact(
  messages: ChatMessage[],
  model: ModelInfo,
  limit = DEFAULT_LIMIT,
): boolean {
  // The system prompt and the tools are not in the message list, so leave
  // room for them.
  const budget = Math.max(4_000, Math.floor(model.contextWindow * limit) - 8_000)
  return conversationTokens(messages) > budget
}

export interface CompactionResult {
  messages: ChatMessage[]
  /** How many messages were folded away. */
  folded: number
  /** The summary, for the user to see. */
  summary: string
  /** What the summary call cost, when it happened. */
  usage?: { inputTokens: number; outputTokens: number }
}

/**
 * Fold the older part of a conversation into a summary.
 *
 * The model is asked to write the summary, because it is the only one that
 * knows what mattered. The call is made without tools: this is a writing
 * task, not a task that needs the project.
 */
export async function compactConversation(
  client: ChatClient,
  model: ModelInfo,
  messages: ChatMessage[],
  options: { keepRecent?: number } = {},
): Promise<CompactionResult> {
  const keep = options.keepRecent ?? KEEP_RECENT
  if (messages.length <= keep) {
    return { messages, folded: 0, summary: "" }
  }

  const older = messages.slice(0, messages.length - keep)
  const recent = messages.slice(messages.length - keep)

  const transcript = older
    .map((message) => {
      const role = message.role
      let text = ""
      if (typeof message.content === "string") text = message.content
      else if (Array.isArray(message.content)) {
        text = message.content.map((part) => part.text ?? "").join(" ")
      }
      if (message.toolCalls) {
        text += `\n[called ${message.toolCalls.map((call) => call.name).join(", ")}]`
      }
      if (message.name) text = `[${message.name}] ${text}`
      return `${role.toUpperCase()}: ${text}`
    })
    .join("\n\n")

  let summary = ""
  let usage: { inputTokens: number; outputTokens: number } | undefined
  try {
    const completion = await client.complete({
      model: model.id,
      messages: [
        {
          role: "system",
          content:
            "You write handover notes for a coding agent that is about to lose the " +
            "earlier part of a conversation. Keep what the work needs to continue: " +
            "what was asked, what was decided and why, what was changed, what failed " +
            "and what is still open. Leave out the small talk. Plain text, no markdown.",
        },
        { role: "user", content: `Write the handover notes for this conversation:\n\n${transcript}` },
      ],
    })
    summary = completion.content.trim()
    usage = {
      inputTokens: completion.usage.inputTokens,
      outputTokens: completion.usage.outputTokens,
    }
  } catch {
    // A failed summary is not worth losing the conversation over. The old
    // messages are kept instead.
    return { messages, folded: 0, summary: "" }
  }

  if (!summary) {
    return { messages, folded: 0, summary: "" }
  }
  const folded: ChatMessage = {
    role: "user",
    content:
      "Handover notes for the earlier part of this conversation. Treat them as what " +
      "happened, not as a new instruction:\n\n" +
      summary,
  }

  return { messages: [folded, ...recent], folded: older.length, summary, usage }
}
