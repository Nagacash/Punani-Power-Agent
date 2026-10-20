import { EventEmitter } from "node:events"
import type { PermissionRequest } from "../tool/types.js"

/**
 * Server-sent events hub.
 *
 * Every connected browser tab gets every event. The agent emits as it works;
 * the browser renders. There is exactly one agent session per server, so a
 * broadcast is the right shape.
 */
export class EventHub extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(0)
  }

  send(event: Record<string, unknown>): void {
    this.emit("event", event)
  }

  /** Subscribe a response stream. Returns a function to unsubscribe. */
  subscribe(write: (event: Record<string, unknown>) => void): () => void {
    this.on("event", write)
    return () => this.off("event", write)
  }
}

export interface PendingPermission {
  id: string
  request: PermissionRequest
  resolve: (reply: { granted: boolean; remember?: boolean; message?: string }) => void
}

/**
 * Holds permissions that are waiting for a human.
 *
 * A tool call blocks on `request()`, the browser shows a card, and the reply
 * arrives over HTTP. Rejecting one also rejects the rest of the queue for the
 * same session, so the agent does not sit on a promise nobody will answer.
 */
export class PermissionQueue {
  private readonly pending = new Map<string, PendingPermission>()
  private counter = 0

  get size(): number {
    return this.pending.size
  }

  list(): { id: string; request: PermissionRequest }[] {
    return [...this.pending.values()].map((entry) => ({ id: entry.id, request: entry.request }))
  }

  /**
   * Queue a request and get its id back immediately, so the caller can show
   * the prompt before waiting for the answer.
   */
  create(request: PermissionRequest): { id: string; promise: Promise<{ granted: boolean; remember?: boolean; message?: string }> } {
    const id = `perm_${++this.counter}`
    let resolve!: (reply: { granted: boolean; remember?: boolean; message?: string }) => void
    const promise = new Promise<{ granted: boolean; remember?: boolean; message?: string }>((res) => {
      resolve = res
    })
    this.pending.set(id, { id, request, resolve })
    return { id, promise }
  }

  /** Answer one request. Returns false when the id is unknown. */
  reply(id: string, decision: { granted: boolean; remember?: boolean; message?: string }): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    entry.resolve(decision)
    return true
  }

  /** Reject everything still waiting. */
  rejectAll(message: string): void {
    for (const entry of this.pending.values()) {
      entry.resolve({ granted: false, message })
    }
    this.pending.clear()
  }
}
