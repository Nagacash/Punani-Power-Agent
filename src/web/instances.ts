import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { paths } from "../core/paths.js"

export interface WebInstanceRecord {
  host: string
  port: number
  projectRoot: string
  pid: number
  label: string
  started: number
}

function registryFile(): string {
  return path.join(paths.dataDir, "web-instances.json")
}

function readAll(): WebInstanceRecord[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), "utf8"))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function writeAll(records: WebInstanceRecord[]): void {
  fs.mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(registryFile(), JSON.stringify(records, null, 2), { mode: 0o600 })
}

/** Drop entries whose process is gone or port no longer answers. */
export function pruneWebInstances(): WebInstanceRecord[] {
  const kept: WebInstanceRecord[] = []
  for (const entry of readAll()) {
    try {
      process.kill(entry.pid, 0)
      kept.push(entry)
    } catch {
      /* process exited */
    }
  }
  if (kept.length !== readAll().length) writeAll(kept)
  return kept
}

export function registerWebInstance(entry: WebInstanceRecord): void {
  const all = pruneWebInstances().filter((e) => !(e.host === entry.host && e.port === entry.port))
  all.push(entry)
  writeAll(all)
}

export function unregisterWebInstance(host: string, port: number): void {
  writeAll(pruneWebInstances().filter((e) => !(e.host === host && e.port === port)))
}

export function listWebInstances(projectRoot?: string): WebInstanceRecord[] {
  const all = pruneWebInstances()
  if (!projectRoot) return all
  const norm = path.resolve(projectRoot)
  return all.filter((e) => path.resolve(e.projectRoot) === norm)
}

export function nextTaskLabel(projectRoot: string): string {
  const n = listWebInstances(projectRoot).length + 1
  return `Task ${n}`
}

export async function findFreePort(host: string, start: number, end: number): Promise<number | undefined> {
  const used = new Set(pruneWebInstances().map((e) => e.port))
  for (let port = start; port <= end; port++) {
    if (used.has(port)) continue
    const free = await portAvailable(host, port)
    if (free) return port
  }
  return undefined
}

function portAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.once("listening", () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}
