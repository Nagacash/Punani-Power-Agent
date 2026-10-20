import type { PermissionEffect, PermissionRule } from "../config/store.js"
import type { PermissionOutcome, PermissionRequest } from "../tool/types.js"

/**
 * Permission engine.
 *
 * Rules are an ordered list per action; the last matching rule wins.
 * A rule pattern is matched against the resource with shell-style wildcards:
 * `*` matches anything, `?` matches one character, `git *` matches any git
 * command with arguments, `git` alone matches only that bare word.
 */

export function matchesPattern(pattern: string, resource: string): boolean {
  if (pattern === "*") return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const regexSource = escaped.replace(/\*/g, ".*").replace(/\?/g, ".")
  return new RegExp(`^${regexSource}$`).test(resource)
}

/** A rule that lives for the duration of the session only. */
export interface SessionRule extends PermissionRule {
  action: string
}

export interface ResolvedDecision {
  effect: PermissionEffect
  /** The rule that decided it. */
  rule?: PermissionRule
}

export class PermissionEngine {
  /** Rules added at runtime by the user choosing "always allow". */
  private readonly sessionAllow: SessionRule[] = []

  constructor(private readonly rules: Record<string, PermissionRule[]>) {}

  /** Rules currently in force for an action, for display. */
  effectiveRules(action: string): PermissionRule[] {
    return [...(this.rules[action] ?? []), ...this.sessionAllow.filter((rule) => rule.action === action)]
  }

  decide(action: string, resource: string): ResolvedDecision {
    const applicable = [
      ...(this.rules[action] ?? []),
      ...this.sessionAllow.filter((rule) => rule.action === action),
    ]
    let decided: ResolvedDecision = { effect: "ask" }
    for (const rule of applicable) {
      if (matchesPattern(rule.pattern, resource)) decided = { effect: rule.effect, rule }
    }
    return decided
  }

  /** Remember an "always allow" decision for the rest of the session. */
  remember(action: string, patterns: string[]): void {
    for (const pattern of patterns) {
      if (this.sessionAllow.some((rule) => rule.action === action && rule.pattern === pattern)) continue
      this.sessionAllow.push({ pattern, effect: "allow", action })
    }
  }

  forget(): void {
    this.sessionAllow.length = 0
  }
}

/** Ask the user for permission. Implemented by the UI layer. */
export type PermissionAsk = (request: PermissionRequest) => Promise<PermissionOutcome>

/**
 * Gate a tool call.
 *
 * - `allow` -> proceed silently.
 * - `deny`  -> refuse and tell the model why.
 * - `ask`   -> ask the user, and remember the answer when they say so.
 *
 * Both frontends go through this one function, so the terminal and the browser
 * behave identically. `ask` is only called when the ruleset says `ask`.
 */
export async function resolvePermission(
  engine: PermissionEngine,
  request: PermissionRequest,
  ask: PermissionAsk,
): Promise<PermissionOutcome> {
  const decision = engine.decide(request.action, request.resource)
  if (decision.effect === "allow") return { granted: true }
  if (decision.effect === "deny") {
    return {
      granted: false,
      message: `The permission rule for "${request.action}" denies "${request.resource}".`,
    }
  }
  const outcome = await ask(request)
  if (outcome.granted && outcome.remember && outcome.patterns?.length) {
    engine.remember(request.action, outcome.patterns)
  }
  return outcome
}

/**
 * Gate a tool call, resolving a pending human decision.
 *
 * Kept as a separate name for callers that only need the ask path; the
 * ruleset check still happens first.
 */
export async function checkPermission(
  engine: PermissionEngine,
  request: PermissionRequest,
  ask: PermissionAsk,
): Promise<PermissionOutcome> {
  return resolvePermission(engine, request, ask)
}
