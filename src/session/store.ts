import fs from "node:fs"
import path from "node:path"
import { paths } from "../core/paths.js"
import { messageText, type ChatMessage } from "../llm/client.js"

/**
 * Session storage.
 *
 * Each session is a JSONL file: one JSON object per line, appended as the
 * session runs. That makes it cheap to write, easy to tail, and tolerant of a
 * crash mid-turn. A session can be reopened and continued.
 */

export type Role = "user" | "assistant" | "tool" | "system"

export interface StoredToolCall {
  id: string
  name: string
  arguments: string
}

export interface SessionMessage {
  role: Role
  content: string
  /** Tool name, for role=tool. */
  tool?: string
  /** Tool call id this message answers. */
  toolCallId?: string
  /** Tool calls the assistant requested, kept so the turn can be replayed exactly. */
  toolCalls?: StoredToolCall[]
  /** Model that produced an assistant message. */
  model?: string
  /** Provider that produced an assistant message. */
  provider?: string
  tokensIn?: number
  tokensOut?: number
  cost?: number
  /** Why the turn ended. Only on the turn record. */
  stoppedReason?: string
  /** The provider error that ended the turn, when it ended badly. */
  errorKind?: string
  errorMessage?: string
  timestamp: number
}

export interface SessionMeta {
  id: string
  title: string
  created: number
  updated: number
  projectRoot: string
  model?: string
  provider?: string
  messageCount: number
  /** Free-form marker so a session can be tagged as a task to resume. */
  tag?: string
}

export interface StoredSession {
  meta: SessionMeta
  messages: SessionMessage[]
}

function newId(): string {
  return `ses_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export class SessionStore {
  constructor(private readonly dir: string = paths.sessionsDir) {}

  private file(id: string): string {
    return path.join(this.dir, `${id}.jsonl`)
  }

  private indexFile(): string {
    return path.join(this.dir, "index.json")
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  create(projectRoot: string, model?: string, provider?: string): SessionMeta {
    this.ensureDir()
    const id = newId()
    const meta: SessionMeta = {
      id,
      title: "New session",
      created: Date.now(),
      updated: Date.now(),
      projectRoot,
      model,
      provider,
      messageCount: 0,
    }
    fs.writeFileSync(this.file(id), "", { mode: 0o600 })
    this.writeIndex(meta)
    return meta
  }

  append(meta: SessionMeta, message: SessionMessage): void {
    this.ensureDir()
    fs.appendFileSync(this.file(meta.id), `${JSON.stringify(message)}\n`, { mode: 0o600 })
    meta.updated = Date.now()
    meta.messageCount += 1
    if (meta.title === "New session" && message.role === "user" && message.content.trim()) {
      meta.title = message.content.trim().split("\n")[0]!.slice(0, 80)
    }
    this.writeIndex(meta)
  }

  /**
   * Write the messages a turn produced.
   *
   * Each assistant message carries the usage of the call that produced it,
   * so the transcript says what each step cost instead of the turn total on
   * every line.
   */
  appendTurnMessages(
    meta: SessionMeta,
    added: ChatMessage[],
    steps: {
      inputTokens: number
      outputTokens: number
      cost: number
      model: string
      provider: string
    }[],
  ): void {
    let step = 0
    for (const message of added) {
      if (message.role === "assistant") {
        // The step is counted even when the message is not written: the call
        // happened, and the tokens were spent.
        const usage = steps[step]
        step++
        const text = messageText(message)
        const calls = message.toolCalls ?? []
        if (!text.trim() && calls.length === 0) continue
        this.append(meta, {
          role: "assistant",
          content: text,
          toolCalls: calls.length
            ? calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
            : undefined,
          model: usage?.model,
          provider: usage?.provider,
          tokensIn: usage?.inputTokens ?? 0,
          tokensOut: usage?.outputTokens ?? 0,
          cost: usage?.cost ?? 0,
          timestamp: Date.now(),
        })
        continue
      }
      if (message.role === "tool") {
        this.append(meta, {
          role: "tool",
          content: messageText(message),
          tool: message.name,
          toolCallId: message.toolCallId,
          timestamp: Date.now(),
        })
      }
    }
  }

  /**
   * Record how a turn ended.
   *
   * The transcript alone does not say why a run stopped: the answer and the
   * tools look the same whether the model finished, hit the step limit, was
   * cancelled, or died on a provider error. This is the only record of that,
   * so it is written whatever the reason.
   */
  appendTurn(
    meta: SessionMeta,
    turn: {
      stoppedReason: string
      errorKind?: string
      errorMessage?: string
      usage?: { inputTokens: number; outputTokens: number; cost: number }
    },
  ): void {
    this.append(meta, {
      role: "system",
      content: "",
      stoppedReason: turn.stoppedReason,
      errorKind: turn.errorKind,
      errorMessage: turn.errorMessage,
      tokensIn: turn.usage?.inputTokens ?? 0,
      tokensOut: turn.usage?.outputTokens ?? 0,
      cost: turn.usage?.cost ?? 0,
      timestamp: Date.now(),
    })
  }

  /** Give the session a name of its own. */
  rename(meta: SessionMeta, title: string): void {
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 80)
    if (!clean) return
    meta.title = clean
    meta.updated = Date.now()
    this.writeIndex(meta)
  }

  /**
   * Copy the session into a new one.
   *
   * The fork starts with the same transcript, so the work can be carried on
   * in another direction without losing what came before it.
   */
  fork(meta: SessionMeta): SessionMeta {
    const stored = this.read(meta.id)
    const forkMeta = this.create(meta.projectRoot, meta.model, meta.provider)
    forkMeta.title = `${meta.title} (fork)`
    this.rewrite(forkMeta, stored?.messages ?? [])
    return forkMeta
  }

  /** Write the index, so a change to the meta lands on disk. */
  save(meta: SessionMeta): void {
    meta.updated = Date.now()
    this.writeIndex(meta)
  }

  /** Replace the on-disk transcript (for edit / revert in the browser). */
  rewrite(meta: SessionMeta, messages: SessionMessage[]): void {
    this.ensureDir()
    const body = messages.length ? `${messages.map((m) => JSON.stringify(m)).join("\n")}\n` : ""
    fs.writeFileSync(this.file(meta.id), body, { mode: 0o600 })
    meta.updated = Date.now()
    meta.messageCount = messages.length
    this.writeIndex(meta)
  }

  read(id: string): StoredSession | undefined {
    const file = this.file(id)
    if (!fs.existsSync(file)) return undefined
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "")
    const messages: SessionMessage[] = []
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line))
      } catch {
        /* skip a partially written line */
      }
    }
    const meta = this.index().find((entry) => entry.id === id)
    return {
      meta: meta ?? {
        id,
        title: messages.find((m) => m.role === "user")?.content.slice(0, 80) ?? "Recovered session",
        created: messages[0]?.timestamp ?? Date.now(),
        updated: messages[messages.length - 1]?.timestamp ?? Date.now(),
        projectRoot: process.cwd(),
        messageCount: messages.length,
      },
      messages,
    }
  }

  index(): SessionMeta[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile(), "utf8"))
      return Array.isArray(raw) ? raw : []
    } catch {
      return []
    }
  }

  /**
   * Write the index.
   *
   * The session that was just written goes into the index, so the list of
   * sessions knows about it, and about every change to it.
   */
  private writeIndex(meta?: SessionMeta): void {
    try {
      this.ensureDir()
      const index = this.index()
      if (meta) {
        const at = index.findIndex((entry) => entry.id === meta.id)
        if (at >= 0) index[at] = { ...meta }
        else index.push({ ...meta })
      }
      fs.writeFileSync(this.indexFile(), JSON.stringify(index, null, 2), { mode: 0o600 })
    } catch {
      /* index is a convenience, not a requirement */
    }
  }

  /** Rebuild the index from the JSONL files. */
  rebuildIndex(): SessionMeta[] {
    this.ensureDir()
    const metas: SessionMeta[] = []
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith(".jsonl")) continue
      const id = file.replace(/\.jsonl$/, "")
      const stored = this.read(id)
      if (stored) metas.push(stored.meta)
    }
    fs.writeFileSync(this.indexFile(), JSON.stringify(metas, null, 2), { mode: 0o600 })
    return metas
  }

  list(): SessionMeta[] {
    return this.index().sort((a, b) => b.updated - a.updated)
  }
}

/**
 * Rebuild the provider-facing message list from a stored session.
 *
 * The system prompt is not stored: it is rebuilt from the current model and
 * project, so it always reflects the present configuration.
 */
export function toChatMessages(messages: SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content })
      continue
    }
    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls?.length
          ? message.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
          : undefined,
      })
      continue
    }
    if (message.role === "tool") {
      // Skip tool results whose originating call is not in the history.
      out.push({
        role: "tool",
        content: message.content,
        toolCallId: message.toolCallId,
        name: message.tool,
      })
    }
  }
  return out
}
