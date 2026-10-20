import net from "node:net"

/**
 * Finding a port to listen on.
 *
 * A busy port is not an error. Someone else may already be running the agent,
 * or an unrelated program may have the port. Both are ordinary, so both get an
 * ordinary answer: reuse the first, move to the second.
 */

export interface Identified {
  app: string
  version: string
  pid: number
  project: string
}

/** Ask whoever is on a port whether they are a Punani instance. */
export async function identify(port: number, host = "127.0.0.1", timeoutMs = 1200): Promise<Identified | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://${host}:${port}/identify`, { signal: controller.signal })
    if (!response.ok) return undefined
    const body = (await response.json()) as Partial<Identified>
    if (body?.app !== "punani-powerd") return undefined
    return body as Identified
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** True when something is already listening on the port. */
export function isPortBusy(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(800)
    socket.once("error", () => resolve(false))
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, host, () => {
      socket.end()
      resolve(true)
    })
  })
}

/** Find a free port, starting at `from` and walking up. */
export async function findFreePort(from: number, host = "127.0.0.1", attempts = 50): Promise<number> {
  for (let port = from; port < from + attempts; port++) {
    if (!(await isPortBusy(port, host))) return port
  }
  throw new Error(`no free port found between ${from} and ${from + attempts}`)
}
