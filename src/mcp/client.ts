import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { log } from "../core/logger.js"
import { version } from "../core/version.js"
import { redactError } from "../core/redact.js"

/**
 * A client for MCP servers that speak over stdio.
 *
 * The transport is newline-delimited JSON-RPC 2.0. A session is:
 *
 *   -> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   <- {"jsonrpc":"2.0","id":1,"result":{"serverInfo":{...}}}
 *   -> {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   -> {"jsonrpc":"2.0","id":2,"method":"tools/list"}
 *   <- {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
 *   -> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":...,"arguments":{...}}}
 *   <- {"jsonrpc":"2.0","id":3,"result":{"content":[...]}}
 */

export interface McpServerConfig {
  /** Human label. Also the prefix for the tools it exposes. */
  name: string
  /** The executable to run (stdio transport). Mutually exclusive with url. */
  command?: string
  args?: string[]
  /** Streamable HTTP endpoint (HTTP transport). Mutually exclusive with command. */
  url?: string
  /** Extra environment for the child process. */
  env?: Record<string, string>
  /** Set to false to keep it configured but not start it. */
  enabled?: boolean
  /** Seconds to wait for the handshake. */
  timeoutSeconds?: number
}

export interface McpToolInfo {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpToolResult {
  content: { type: string; text?: string; mimeType?: string }[]
  isError?: boolean
}

/** The surface both the stdio and HTTP MCP clients expose to the registry. */
export interface McpSession {
  name: string
  connected: boolean
  serverName?: string
  availableTools: McpToolInfo[]
  connect(): Promise<void>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
  close(): Promise<void>
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class McpClient implements McpSession {
  private child?: ChildProcessWithoutNullStreams
  private buffer = ""
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private serverInfo?: { name?: string; version?: string }
  private tools: McpToolInfo[] = []
  private closed = false

  constructor(private readonly config: McpServerConfig) {}

  get name(): string {
    return this.config.name
  }

  get connected(): boolean {
    return Boolean(this.child) && !this.closed
  }

  get serverName(): string | undefined {
    return this.serverInfo?.name
  }

  get availableTools(): McpToolInfo[] {
    return this.tools
  }

  /** Start the process and complete the handshake. */
  async connect(): Promise<void> {
    if (this.child) return
    if (!this.config.command) {
      throw new Error(`the ${this.config.name} server has no command to run`)
    }
    const timeout = (this.config.timeoutSeconds ?? 30) * 1000

    this.child = spawn(this.config.command, this.config.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.config.env ?? {}) },
    })
    this.closed = false

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk))
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim()
      if (text) log.debug(`mcp ${this.config.name}: ${text.slice(0, 400)}`)
    })
    this.child.on("error", (error) => {
      log.warn(`mcp ${this.config.name} could not start: ${redactError(error)}`)
      this.failAll(new Error(`the ${this.config.name} server could not start: ${error.message}`))
    })
    this.child.on("exit", (code) => {
      this.closed = true
      this.failAll(new Error(`the ${this.config.name} server exited with code ${code}`))
    })

    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "punani-powerd", version },
      },
      timeout,
    )
    this.serverInfo = result?.serverInfo
    this.notify("notifications/initialized")

    const listed = await this.request("tools/list", {}, timeout)
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []
    log.info(`mcp ${this.config.name} connected with ${this.tools.length} tools`)
  }

  /** Call one of the server's tools. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      (this.config.timeoutSeconds ?? 60) * 1000,
    )
    return { content: result?.content ?? [], isError: result?.isError === true }
  }

  /** Stop the server. */
  async close(): Promise<void> {
    this.closed = true
    this.failAll(new Error("the server was closed"))
    if (this.child) {
      this.child.kill("SIGTERM")
      this.child = undefined
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8")
    let index: number
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message?.id !== "number") continue
      const entry = this.pending.get(message.id)
      if (!entry) continue
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(message.error.message ?? "the MCP server returned an error"))
      } else {
        entry.resolve(message.result)
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (!this.child) return Promise.reject(new Error(`the ${this.config.name} server is not running`))
    const id = this.nextId++
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the ${this.config.name} server did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child!.stdin.write(payload)
    })
  }

  private notify(method: string): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/**
 * A client for MCP servers that speak Streamable HTTP.
 *
 * The transport is JSON-RPC 2.0 over POST to a single URL. Each request is
 * stateless; a session is:
 *
 *   -> POST { jsonrpc: "2.0", id: 1, method: "initialize", params: {...} }
 *   <- { jsonrpc: "2.0", id: 1, result: { serverInfo: {...} } }
 *   -> POST { jsonrpc: "2.0", method: "notifications/initialized" }
 *   -> POST { jsonrpc: "2.0", id: 2, method: "tools/list" }
 *   <- { jsonrpc: "2.0", id: 2, result: { tools: [...] } }
 */
export class McpHttpClient implements McpSession {
  private readonly config: McpServerConfig
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private serverInfo?: { name?: string; version?: string }
  private tools: McpToolInfo[] = []
  private closed = false

  constructor(config: McpServerConfig) {
    this.config = config
  }

  get name(): string {
    return this.config.name
  }

  get connected(): boolean {
    return Boolean(this.serverInfo) && !this.closed
  }

  get serverName(): string | undefined {
    return this.serverInfo?.name
  }

  get availableTools(): McpToolInfo[] {
    return this.tools
  }

  /** Complete the initialize handshake and list tools. */
  async connect(): Promise<void> {
    if (this.closed) return
    const timeout = (this.config.timeoutSeconds ?? 30) * 1000

    const result = await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "punani-powerd", version },
      },
      timeout,
    )
    this.serverInfo = result?.serverInfo

    await this.notify("notifications/initialized")

    const listed = await this.request("tools/list", {}, timeout)
    this.tools = Array.isArray(listed?.tools) ? listed.tools : []
    log.info(`mcp ${this.config.name} connected over http with ${this.tools.length} tools`)
  }

  /** Call one of the server's tools over HTTP. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.request(
      "tools/call",
      { name, arguments: args },
      (this.config.timeoutSeconds ?? 60) * 1000,
    )
    return { content: result?.content ?? [], isError: result?.isError === true }
  }

  /** No background process to stop; just mark the session closed. */
  async close(): Promise<void> {
    this.closed = true
    this.failAll(new Error("the http session was closed"))
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.closed || !this.config.url) {
      return Promise.reject(new Error(`the ${this.config.name} server is not running`))
    }
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the ${this.config.name} server did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      void fetch(this.config.url!, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then(async (response) => {
          clearTimeout(timer)
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          if (!response.ok) {
            entry.reject(new Error(`the ${this.config.name} server answered ${response.status} ${response.statusText}`))
            return
          }
          const text = await response.text()
          let message: any
          try {
            message = JSON.parse(text)
          } catch {
            entry.reject(new Error(`the ${this.config.name} server returned invalid JSON`))
            return
          }
          if (typeof message?.id !== "number" || message.id !== id) {
            entry.reject(new Error(`the ${this.config.name} server returned a mismatched response id`))
            return
          }
          if (message.error) {
            entry.reject(new Error(message.error.message ?? "the MCP server returned an error"))
          } else {
            entry.resolve(message.result)
          }
        })
        .catch((error) => {
          clearTimeout(timer)
          const entry = this.pending.get(id)
          if (!entry) return
          this.pending.delete(id)
          if ((error as Error)?.name === "AbortError" || /timed out/i.test((error as Error).message)) {
            entry.reject(new Error(`the ${this.config.name} server did not answer ${method} in time`))
          } else {
            entry.reject(error as Error)
          }
        })
    })
  }

  private notify(method: string): void {
    if (this.closed || !this.config.url) return
    void fetch(this.config.url!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    }).catch((error) => log.debug(`mcp ${this.config.name} notify ${method} failed: ${(error as Error).message}`))
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }
}

/**
 * Well-known MCP servers, so a user can say "add the filesystem server" and
 * get the right command without looking it up.
 */
export const KNOWN_MCP_SERVERS: Record<
  string,
  { command: string; args?: string[]; note: string; env?: Record<string, string> }
> = {
  filesystem: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    note: "read and write files in a folder you choose",
  },
  memory: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    note: "a knowledge graph the agent can keep notes in",
  },
  github: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    note: "issues, pull requests and repositories",
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" },
  },
  fetch: {
    command: "uvx",
    args: ["mcp-server-fetch"],
    note: "fetch a URL and turn it into text",
  },
  sqlite: {
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "./database.db"],
    note: "query a SQLite database",
  },
  puppeteer: {
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
    note: "drive a headless browser",
  },
  rea: {
    command: "npx",
    args: ["-y", "rea-agents@latest", "mcp"],
    note: "reverse engineer apps, binaries and packages, and show the evidence",
  },
  browser: {
    command: "uvx",
    args: ["browser-harness-mcp"],
    note: "drive your real Chrome over CDP, logged in as you. No LLM key needed.",
  },
  video: {
    command: "npx",
    args: ["-y", "@sylphx/anymd", "mcp"],
    note: "read a video: transcript, subtitles and metadata, locally. No API key.",
  },
}
