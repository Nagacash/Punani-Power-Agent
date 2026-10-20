import fs from "node:fs"
import { paths } from "./paths.js"
import { redact } from "./redact.js"

const MAX_LOG_BYTES = 2 * 1024 * 1024

export type LogLevel = "debug" | "info" | "warn" | "error"

function write(level: LogLevel, message: string): void {
  if (process.env.PUNANI_LOG === "off") return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(message)}\n`
  try {
    fs.mkdirSync(paths.stateDir, { recursive: true })
    const file = paths.logFile
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.rmSync(file)
    }
    fs.appendFileSync(file, line, { mode: 0o600 })
  } catch {
    /* logging must never break the app */
  }
}

export const log = {
  debug: (message: string) => write("debug", message),
  info: (message: string) => write("info", message),
  warn: (message: string) => write("warn", message),
  error: (message: string) => write("error", message),
}
