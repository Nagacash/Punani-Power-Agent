import { spawn } from "node:child_process"
import crypto from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { findFreePort, nextTaskLabel } from "./instances.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export interface SpawnedTaskWindow {
  ok: true
  host: string
  port: number
  label: string
  token: string
  loginUrl: string
  url: string
}

export async function spawnTaskWindow(
  input: {
    projectRoot: string
    host: string
    portStart?: number
    portEnd?: number
  },
): Promise<SpawnedTaskWindow | { ok: false; error: string }> {
  const host = input.host
  const port = await findFreePort(host, input.portStart ?? 4096, input.portEnd ?? 4196)
  if (!port) {
    return { ok: false, error: "no free port between 4096 and 4196 for another task window" }
  }

  const mainScript = path.join(HERE, "..", "main.js")
  const token = crypto.randomBytes(32).toString("hex")
  const label = nextTaskLabel(input.projectRoot)

  const child = spawn(
    process.execPath,
    [
      mainScript,
      "web",
      "--host",
      host,
      "--port",
      String(port),
      "-C",
      input.projectRoot,
      "--token",
      token,
      "--spawned",
      "--task-label",
      label,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  )
  child.unref()

  const url = `http://${host}:${port}`
  return {
    ok: true,
    host,
    port,
    label,
    token,
    url,
    loginUrl: `${url}/?t=${token}`,
  }
}
