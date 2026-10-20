/**
 * Secret redaction.
 *
 * Every string that leaves the process (log lines, error messages, UI output) goes
 * through `redact()`. Registered secrets are replaced by a short fingerprint so the
 * user can tell two keys apart without the key ever being visible.
 */

const registry = new Map<string, string>()

/** Register a secret so it is scrubbed from all future output. */
export function registerSecret(secret: string | undefined | null): void {
  if (!secret) return
  const value = secret.trim()
  if (value.length < 8) return
  registry.set(value, `«redacted:${fingerprint(value)}»`)
}

/** Short, non-reversible fingerprint used to label a secret. */
export function fingerprint(secret: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * Patterns that match a whole secret. The entire match is replaced.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\bfreellmapi-[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
]

/**
 * Patterns where only the secret part is replaced and a prefix is kept.
 * The prefix is captured in a named group `keep`.
 */
const PREFIXED_PATTERNS: RegExp[] = [
  /(?<keep>\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /(?<keep>"?(?:api[_-]?key|apikey|token|secret|password)"?\s*[:=]\s*"?)[^\s"',}]{8,}/gi,
]

/** Scrub known secrets and secret-looking patterns out of a string. */
export function redact(input: string): string {
  let out = input
  for (const [secret, label] of registry) {
    if (secret && out.includes(secret)) out = out.split(secret).join(label)
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "«redacted»")
  }
  for (const pattern of PREFIXED_PATTERNS) {
    out = out.replace(pattern, (...args: any[]) => {
      const groups = args[args.length - 1]
      const keep = typeof groups === "object" && groups !== null ? (groups.keep ?? "") : ""
      return `${keep}«redacted»`
    })
  }
  return out
}

/** Redact an unknown error value into a printable string. */
export function redactError(error: unknown): string {
  if (error instanceof Error) return redact(error.message)
  if (typeof error === "string") return redact(error)
  try {
    return redact(JSON.stringify(error))
  } catch {
    return redact(String(error))
  }
}
