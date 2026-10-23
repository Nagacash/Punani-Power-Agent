import crypto from "node:crypto"
import { spawn } from "node:child_process"
import os from "node:os"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ConfigStore } from "../config/store.js"
import { ProviderRegistry } from "../provider/registry.js"
import { SessionStore, toChatMessages, type SessionMeta } from "../session/store.js"
import { buildTools } from "../tool/registry.js"
import { createSkillTools } from "../tool/skill.js"
import { defaultRoots, discoverSkills, groupSkills, renderGroupIndex } from "../skills/loader.js"
import { McpRegistry } from "../mcp/registry.js"
import { buildSystemPrompt, describeProject, runAgentTurn, DEFAULT_MAX_STEPS } from "../agent/agent.js"
import { modelKey } from "../provider/types.js"
import { loadAlwaysOn, renderAlwaysOn } from "../agent/prompt.js"
import { buildRoutes, renderRoutes } from "../skills/routing.js"
import { stopDevServers } from "../tool/dev.js"
import { loadProjectInstructions } from "../agent/instructions.js"
import { PermissionEngine, resolvePermission } from "../agent/permission.js"
import { createClient } from "../llm/factory.js"
import { createFailover } from "../provider/failover.js"
import { diffLines } from "../tool/diff.js"
import { diskMutate } from "../tool/fsutil.js"
import { messageText, type ChatMessage, type ContentPart } from "../llm/client.js"
import type { ModelInfo } from "../provider/types.js"
import type { Tool, ToolContext } from "../tool/types.js"
import { EventHub, PermissionQueue } from "./events.js"
import { PreviewServer } from "./preview.js"
import { devPreviewTargets } from "./dev-preview.js"
import { listWebInstances, nextTaskLabel, registerWebInstance, unregisterWebInstance } from "./instances.js"
import { spawnTaskWindow } from "./spawn-task.js"
import { Settings } from "./settings.js"
import { log } from "../core/logger.js"
import { projectChangedNote } from "../core/project.js"
import { version } from "../core/version.js"
import { redactError } from "../core/redact.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

export interface WebOptions {
  projectRoot: string
  port: number
  host: string
  /** Where the in-browser folder browser may look. Defaults to the home folder. */
  browseRoot?: string
  /** Extra roots the folder browser may enter, such as mounted external drives. */
  extraRoots?: string[]
  /** Pre-set sign-in token (spawned task windows only; localhost). */
  token?: string
  /** Shown in the task switcher when several web servers share one project. */
  taskLabel?: string
}

/**
 * Find the browser state library.
 *
 * A build copies it next to the compiled server. Running from source there
 * is no copy, so fall back to the installed package. Without this the page
 * loads and then every script import 404s, which leaves a page with no
 * working buttons and no error anyone can see.
 */
function findVendorFile(): string | undefined {
  const installed = findAsset("vendor", "zustand.js")
  if (installed) return installed
  const fromPackage = path.join(HERE, "..", "..", "node_modules", "zustand", "esm", "vanilla.mjs")
  try {
    if (fs.existsSync(fromPackage)) return fromPackage
  } catch {
    /* not there */
  }
  return undefined
}

/**
 * Where the browser assets live.
 *
 * A build puts them next to the compiled server, so the install directory is
 * the first place to look. A single-file binary has no install directory:
 * its module path points inside the binary, not on the disk, so the assets
 * are laid out beside the executable instead.
 */
function assetRoots(): string[] {
  const roots = [HERE]
  try {
    const beside = path.dirname(process.execPath)
    if (beside && !roots.includes(beside)) roots.push(beside)
  } catch {
    /* no executable path to work with */
  }
  return roots
}

/** Find a browser asset, wherever it was installed. */
function findAsset(...parts: string[]): string | undefined {
  for (const root of assetRoots()) {
    const file = path.join(root, ...parts)
    try {
      if (fs.existsSync(file)) return file
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/**
 * Where the landing page lives.
 *
 * The landing site is public, so the sign-in page sends people there rather
 * than at a local port that is usually not running. Override it with
 * PUNANI_LANDING_URL when the site is somewhere else.
 */
function landingUrl(): string {
  const configured = process.env.PUNANI_LANDING_URL?.trim()
  return (configured || "https://punani.agency").replace(/\/+$/, "")
}

/** Did this request come from this machine? */
function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1"
}

/**
 * Escape a string for an AppleScript literal.
 *
 * A backslash has to be escaped before a quote is, or the quote does not
 * close anything and the rest of the path is code.
 */
export function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Is this a loopback host we should mirror onto the other family? */
function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost"
}

/** The port was taken. The caller decides whether to reuse it or move. */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly host: string,
  ) {
    super(`port ${port} is already in use on ${host}`)
    this.name = "PortInUseError"
  }
}

/**
 * The browser frontend.
 *
 * It runs the same agent loop as the terminal, over HTTP instead of a TTY.
 * Two things make it safe to expose locally:
 *
 *   1. A 256-bit token is minted at startup. The first request must carry it
 *      in the URL; the server swaps it for an HttpOnly cookie and redirects.
 *   2. Every mutating request is checked for a same-origin `Origin` header,
 *      so a page on another site cannot drive the agent from your browser.
 *
 * It binds to 127.0.0.1 by default. Exposing it wider means exposing shell
 * execution, so that is opt-in and warns.
 */
export class WebServer {
  private readonly hub = new EventHub()
  private readonly permissions = new PermissionQueue()
  private readonly sessions: SessionStore
  private readonly registry: ProviderRegistry
  readonly preview: PreviewServer
  /** MCP servers, started once and kept for the session. */
  private mcp?: McpRegistry
  private mcpTools: Tool[] = []
  /** The skills available to the agent, and the index that goes in the prompt. */
  private skillTools: Tool[] = []
  private skillCatalog = ""
  private projectInstructions = ""
  private skillRoutes = ""
  private alwaysOn = ""
  /**
   * Keys the browser sent with this request. They are used for the call and
   * then forgotten: the server never writes them to disk.
   */
  private requestKeys: Record<string, string> = {}
  /** Running native folder pickers, by id. */
  private readonly pickers = new Map<
    string,
    { child: ReturnType<typeof spawn>; path?: string; done: boolean; cancelled: boolean }
  >()
  private pickerCounter = 0
  private readonly settings: Settings
  /** The sign-in token. Printed by the CLI and pasted into the gate page. */
  readonly token: string
  readonly taskLabel: string
  private server?: http.Server
  /** A second listener on the other loopback family, so "localhost" works. */
  private mirror?: http.Server
  /** The active project. Switchable from the browser. */
  private projectRoot: string
  /** The port in use. Changeable before the server starts. */
  private boundPort: number
  /** Where the folder browser is allowed to look. */
  private readonly browseRoot: string
  /** Extra roots, such as mounted external drives. */
  private readonly extraRoots: string[]

  private session!: SessionMeta
  private messages: ChatMessage[] = []
  private permissionEngine!: PermissionEngine
  private model?: ModelInfo
  /** Resolves once the default model is known. */
  private modelReady: Promise<void> = Promise.resolve()
  private busy = false
  private abort?: AbortController
  /** Follow-up prompts sent while a turn is still running. */
  private readonly messageQueue: { text: string; images: AttachedImage[] }[] = []
  /** The file the preview was last pointed at. */
  private lastMedia = ""
  /** After abort, drop the in-flight user message and partial reply. */
  private revertAfterAbort = false
  /** Invalidates stale forced-stop timers when a new run or abort starts. */
  private abortEpoch = 0
  /** The tool call currently running, so a diff can be attached to it. */
  private currentToolId?: string

  constructor(
    private readonly config: ConfigStore,
    private readonly options: WebOptions,
  ) {
    this.sessions = new SessionStore()
    this.boundPort = options.port
    this.registry = new ProviderRegistry(config)
    this.projectRoot = options.projectRoot
    this.browseRoot = options.browseRoot ?? os.homedir()
    this.settings = new Settings(this.config)
    this.rescanSkills(options.projectRoot)
    this.preview = new PreviewServer(options.projectRoot)
    // The key only opens the reload channel. It is put in the preview page,
    // so a sandboxed page can reach the channel without the session cookie,
    // which a sandboxed page cannot send.
    this.preview.reloadKey = crypto.randomBytes(16).toString("hex")
    this.preview.on("reload", () => this.hub.send({ type: "reload" }))
    this.preview.on("state", (state) => this.hub.send({ type: "preview", ...state }))
    this.extraRoots = options.extraRoots ?? []
    const preset = options.token?.trim()
    this.token =
      preset && /^[a-f0-9]{64}$/i.test(preset) ? preset : crypto.randomBytes(32).toString("hex")
    const siblings = listWebInstances(options.projectRoot)
    this.taskLabel =
      options.taskLabel?.trim() ||
      (siblings.length === 0 ? "Task 1" : nextTaskLabel(options.projectRoot))
  }

  get url(): string {
    return `http://${this.options.host}:${this.boundPort}`
  }

  /** The bound port. Useful when the port was chosen by the OS. */
  get port(): number {
    const address = this.server?.address()
    if (address && typeof address !== "string") return address.port
    return this.boundPort
  }

  /** Change the port before the server starts. */
  setPort(port: number): void {
    this.boundPort = port
  }

  get loginUrl(): string {
    return `${this.url}/?t=${this.token}`
  }

  async start(): Promise<void> {
    this.permissionEngine = new PermissionEngine(this.config.permissions())
    this.session = this.sessions.create(this.projectRoot)

    const handler = (request: http.IncomingMessage, response: http.ServerResponse): void => {
      this.handle(request, response).catch((error) => {
        response.writeHead(500, { "content-type": "application/json" })
        response.end(JSON.stringify({ error: String(error) }))
      })
    }

    this.server = http.createServer(handler)

    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject)
        this.server!.listen(this.boundPort, this.options.host, () => resolve())
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error
      throw new PortInUseError(this.boundPort, this.options.host)
    }

    // "localhost" resolves to ::1 before 127.0.0.1 on most systems, and a
    // browser that only tries the first one gets "connection refused". Bind
    // the other loopback family too, so both spellings work. A failure here
    // is not worth failing the start over.
    if (isLoopback(this.options.host)) {
      // Take the family the primary listener actually got, and the port it
      // actually got. A configured host of "localhost" may have resolved to
      // either, and a port of 0 is assigned by the system.
      const address = this.server!.address()
      const bound = typeof address === "object" && address !== null ? address : undefined
      const mirrorHost = bound?.family === "IPv6" ? "127.0.0.1" : "::1"
      const mirrorPort = bound?.port ?? this.boundPort
      this.mirror = http.createServer(handler)
      try {
        await new Promise<void>((resolve) => {
          this.mirror!.once("error", () => resolve())
          this.mirror!.listen(mirrorPort, mirrorHost, () => resolve())
        })
      } catch {
        /* the other family is not available; one listener is enough */
      }
    }

    registerWebInstance({
      host: this.options.host,
      port: this.boundPort,
      projectRoot: this.projectRoot,
      pid: process.pid,
      label: this.taskLabel,
      started: Date.now(),
    })

    // Picking the default model means querying every provider's catalog. Do it
    // in the background so the server is reachable straight away, but hold on
    // to the promise: a message that arrives before the catalog is known must
    // wait for it, not be told that no model is configured.
    this.modelReady = this.resolveModel()
    void this.startMcp()
  }

  /** Re-read the skills and the instructions for the current project. */
  private rescanSkills(root: string): void {
    const skills = discoverSkills(defaultRoots(root))
    const groups = groupSkills(skills)
    this.skillTools = createSkillTools(groups, skills)
    this.skillCatalog = renderGroupIndex(groups)
    this.projectInstructions = loadProjectInstructions(root).text
    this.skillRoutes = renderRoutes(buildRoutes(root, skills))
    this.alwaysOn = renderAlwaysOn(loadAlwaysOn(root))
  }

  /** Start the MCP servers and collect their tools. */
  private async startMcp(): Promise<void> {
    const servers = this.config.mcpServers()
    if (servers.length === 0) return
    const mcp = new McpRegistry(servers)
    this.mcp = mcp
    try {
      this.mcpTools = await mcp.start()
      for (const problem of mcp.problems) {
        this.hub.send({ type: "notice", text: `MCP: ${problem}` })
      }
      if (this.mcpTools.length > 0) {
        this.hub.send({
          type: "notice",
          text: `${this.mcpTools.length} MCP tool(s) ready from ${mcp.connected.length} server(s)`,
        })
      }
    } catch (error) {
      log.warn(`mcp failed to start: ${redactError(error)}`)
    }
  }

  private async resolveModel(): Promise<void> {
    try {
      const configured = this.config.get().defaultModel
      const found = configured ? await this.registry.findModel(configured) : undefined
      this.model = found ?? (await this.registry.defaultModel())
      if (this.model) {
        this.session.model = this.model.id
        this.session.provider = this.model.providerID
        this.hub.send({ type: "state", ...this.snapshot() })
      }
    } catch (error) {
      log.warn(`could not resolve the default model: ${redactError(error)}`)
    }
  }

  async stop(): Promise<void> {
    unregisterWebInstance(this.options.host, this.boundPort)
    this.permissions.rejectAll("server stopped")
    this.abort?.abort()
    await this.mcp?.stop()
    stopDevServers()
    // The file watcher holds the event loop open if it is left running.
    this.preview.disable()
    for (const picker of this.pickers.values()) picker.child.kill()
    this.pickers.clear()
    await Promise.all([
      new Promise<void>((resolve) => this.server?.close(() => resolve())),
      // No mirror means no second listener to close. The promise has to
      // settle either way, or stop() waits forever.
      this.mirror
        ? new Promise<void>((resolve) => this.mirror!.close(() => resolve()))
        : Promise.resolve(),
    ])
  }

  /* ---------------------------------------------------------------- */
  /* HTTP                                                              */
  /* ---------------------------------------------------------------- */

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.url)

    // The landing URL carries the token; hand it over as a cookie and clean up.
    if (url.pathname === "/" && url.searchParams.get("t")) {
      if (url.searchParams.get("t") !== this.token) {
        // The token is minted per run, so a link from an earlier run is dead.
        // Show the sign-in page rather than a bare refusal: it has the box to
        // paste the current token into.
        this.sendHelp(response, "That sign-in link is from an earlier run. The token changes every time the server starts — paste the current one below.")
        return
      }
      response.writeHead(302, {
        "set-cookie": `punani=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        location: "/",
      })
      response.end()
      return
    }

    // A pasted token is exchanged for the cookie before the gate, otherwise
    // the gate would reject the very request that signs you in.
    if (url.pathname === "/session") {
      await this.acceptToken(request, response)
      return
    }

    // Unauthenticated, and it says nothing secret: it only lets another
    // instance recognise this one and reuse it instead of failing.
    if (url.pathname === "/identify") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      response.end(
        JSON.stringify({
          app: "punani-powerd",
          version,
          // The token is the sign-in credential. Hand it over only to a
          // request that came from this machine, so a second local instance
          // can tell the user how to get in without exposing it to the
          // network when the server is bound wider. The path of the project
          // and the process id say more about the machine than a caller
          // needs, so they stay out of it.
          ...(isLoopbackAddress(request.socket.remoteAddress) ? { token: this.token } : {}),
        }),
      )
      return
    }

    this.requestKeys = readBrowserKeys(request)

    const denied = this.denied(request, url)
    if (denied) {
      // A browser hitting the page without a valid link gets a page that says
      // what to do. An API caller gets a JSON error with a usable message.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        this.sendHelp(response)
        return
      }
      response.writeHead(denied, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          error:
            denied === 401
              ? "unauthorized: open the private link that `punani web` printed in your terminal"
              : "forbidden: this request came from another origin",
        }),
      )
      return
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      this.sendHtml(response)
      return
    }

    if (url.pathname === "/api/events") {
      this.sendEvents(request, response)
      return
    }

    if (url.pathname === "/file") {
      this.sendFile(response, url)
      return
    }

    if (url.pathname === "/logo.png") {
      this.sendLogo(response)
      return
    }

    if (url.pathname === "/vendor/zustand.js") {
      this.sendVendor(response)
      return
    }

    if (url.pathname === "/preview/live") {
      this.sendPreviewEvents(request, response)
      return
    }

    if (url.pathname.startsWith("/preview/")) {
      this.sendPreviewFile(response, url.pathname.slice("/preview".length))
      return
    }

    if (url.pathname.startsWith("/api/")) {
      await this.sendApi(request, response, url)
      return
    }

    response.writeHead(404, { "content-type": "text/plain" })
    response.end("not found")
  }

  /** The settings view, with the model counts filled in. */
  private async settingsView(): Promise<unknown> {
    const counts: Record<string, number> = {}
    for (const provider of this.config.providers()) {
      const { models } = await this.registry.models(provider)
      counts[provider.id] = models.length
    }
    return this.settings.view(counts)
  }

  /**
   * Open the native macOS folder chooser.
   *
   * The in-browser browser can only walk the home folder and the mounted
   * volumes. The real chooser can reach anything the user has access to, on
   * any drive, and it is what people expect.
   */
  private startFolderPicker(startAt?: string): string {
    const id = `pick_${++this.pickerCounter}`
    const prompt = "Select the project folder for Punani powerd"
    // The path goes into an AppleScript string literal. A backslash has to
    // be escaped before a quote is, or the quote does not close anything.
    const escaped = startAt ? startAt.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : ""
    const script = startAt
      ? `POSIX path of (choose folder with prompt "${prompt}" default location POSIX file "${escaped}")`
      : `POSIX path of (choose folder with prompt "${prompt}")`

    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] })
    const state = { child, path: undefined as string | undefined, done: false, cancelled: false }
    this.pickers.set(id, state)

    const out: Buffer[] = []
    child.stdout?.on("data", (chunk) => out.push(chunk as Buffer))
    child.on("error", () => {
      state.done = true
      state.cancelled = true
    })
    child.on("close", (code) => {
      state.done = true
      const chosen = Buffer.concat(out).toString("utf8").trim()
      if (code === 0 && chosen) state.path = chosen
      else state.cancelled = true
    })
    return id
  }

  private folderPickerStatus(id: string): { status: "waiting" | "done" | "cancelled" | "unknown"; path?: string } {
    const state = this.pickers.get(id)
    if (!state) return { status: "unknown" }
    if (!state.done) return { status: "waiting" }
    if (state.path) {
      this.pickers.delete(id)
      return { status: "done", path: state.path }
    }
    this.pickers.delete(id)
    return { status: "cancelled" }
  }

  /** Serve a file from the project for the preview pane. */
  private sendPreviewFile(response: http.ServerResponse, requestPath: string): void {
    const resolved = this.preview.resolve(requestPath)
    if (!resolved) {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
      return
    }
    try {
      // Only the index is addressed with the key. The reload navigates to the
      // page's own path with the key, and the key opens the index, so a page
      // at another path must not carry it.
      const isIndex = this.isPreviewIndex(requestPath)
      const bytes = this.preview.read(resolved.file, resolved.type, isIndex)
      response.writeHead(200, {
        "content-type": resolved.type,
        "cache-control": "no-store",
        // A page from the project is not the app. The sandbox gives it its
        // own origin, so a page the model wrote cannot use the session the
        // app holds, and a site cannot read the project through it.
        "content-security-policy": "sandbox allow-scripts allow-forms allow-popups",
        // The reload key is in the page. Without this it rides along to
        // whatever the page loads from the internet.
        "referrer-policy": "no-referrer",
      })
      response.end(bytes)
    } catch {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end("could not read the file")
    }
  }

  /**
   * The reload channel for the preview.
   *
   * It is a script, not an event stream, because the preview page is served
   * sandboxed and a sandboxed page cannot read a cross-origin response. A
   * script tag is executed instead of read, so the browser runs it and the
   * page reloads itself.
   *
   * The response stays open until something changes. A browser runs a script
   * when it has finished arriving, never while it is still streaming, so the
   * response ends with the reload command. The page reloads, and the new page
   * opens a new channel.
   */
  private sendPreviewEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    })
    // A comment keeps the connection warm without running anything. The first
    // one goes out at once, so the browser has something to parse and the
    // page knows the channel is open.
    response.write("// ready\n")
    let open = true
    const unsubscribe = this.hub.subscribe((event) => {
      if (event.type !== "reload" || !open) return
      open = false
      // Ending the response is what makes the browser run the script.
      //
      // The page has to come back with the key, not with the session: the
      // page is sandboxed, so a navigation it starts is cross-site and the
      // session cookie is not sent with it. The key opens the page and the
      // channel, and nothing else.
      //
      // A page in a frame is left alone. The app reloads its own preview
      // from the outside, where the frame is same-origin and the session
      // works, so the frame must not reload itself as well.
      response.end(
        `if (window.top === window.self) window.location.replace(location.pathname + "?k=${this.preview.reloadKey}");\n`,
      )
    })
    const keepAlive = setInterval(() => {
      if (!open) return
      response.write("// ping\n")
    }, 20_000)
    request.on("close", () => {
      open = false
      clearInterval(keepAlive)
      unsubscribe()
    })
  }

  /** The state library, served from the install directory. */
  private sendVendor(response: http.ServerResponse): void {
    const file = findVendorFile()
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
      return
    }
    try {
      const bytes = fs.readFileSync(file)
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
      })
      response.end(bytes)
    } catch {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
    }
  }

  /** The mark. Served from the install directory, not the project. */
  private sendLogo(response: http.ServerResponse): void {
    const file = findAsset("logo.png")
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
      return
    }
    try {
      const bytes = fs.readFileSync(file)
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
      })
      response.end(bytes)
    } catch {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
    }
  }

  /**
   * List the folders under a path, so a browser user can choose a project
   * without touching a terminal. Only directories are listed, and only inside
   * the browse root.
   */
  private browse(requested: string): {
    path: string
    parent: string | null
    home: string
    places: { name: string; path: string }[]
    directories: { name: string; path: string }[]
    error?: string
  } {
    const home = this.browseRoot
    const roots = [home, ...this.extraRoots]
    let target = requested ? path.resolve(home, requested) : home

    // Clamp to whichever allowed root contains the target.
    const inside = (root: string, candidate: string): boolean => {
      const relative = path.relative(root, candidate)
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
    }
    if (!roots.some((root) => inside(root, target))) {
      const wanted = path.resolve("/" + requested.replace(/^[/~]+/, ""))
      const matched = roots.find((root) => inside(root, wanted))
      target = matched ? wanted : home
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return {
        path: target,
        parent: null,
        home,
        places: this.places(),
        directories: [],
        error: "that folder does not exist",
      }
    }
    if (!stat.isDirectory()) {
      target = path.dirname(target)
    }

    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
    } catch (error) {
      return {
        path: target,
        parent: null,
        home,
        places: this.places(),
        directories: [],
        error: (error as Error).message,
      }
    }

    const hidden = new Set([
      "node_modules", ".git", ".hg", ".svn", "dist", "build", "out",
      ".next", ".nuxt", ".cache", ".venv", "venv", "__pycache__",
      "target", ".gradle", ".idea", ".vscode", "coverage", ".DS_Store",
    ])

    const directories = entries
      .filter((entry) => entry.isDirectory() && !hidden.has(entry.name) && !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))

    // The parent link stops at the root of whichever place we are in.
    const relativeParent = path.dirname(target)
    const parent = roots.some((root) => inside(root, relativeParent)) ? relativeParent : null

    return { path: target, parent, home, places: this.places(), directories }
  }

  /** The places the folder browser can start from: the home folder and any volumes. */
  private places(): { name: string; path: string }[] {
    const places = [{ name: "Home", path: this.browseRoot }]
    for (const root of this.extraRoots) {
      try {
        if (!fs.statSync(root).isDirectory()) continue
      } catch {
        continue
      }
      places.push({ name: path.basename(root) || root, path: root })
    }
    return places
  }

  /** Switch the agent to a different project folder. */
  private switchProject(requested: string): { ok: boolean; error?: string; project?: string } {
    const target = requested.startsWith("/") ? path.resolve(requested) : path.resolve(this.browseRoot, requested)
    try {
      if (!fs.statSync(target).isDirectory()) {
        return { ok: false, error: "that is not a folder" }
      }
    } catch {
      return { ok: false, error: "that folder does not exist" }
    }

    this.projectRoot = target
    this.preview.setProject(target)
    // A different project has its own skills and its own instructions.
    this.rescanSkills(target)
    this.session = this.sessions.create(target, this.model?.id, this.model?.providerID)
    // The conversation carries over, so the agent has to be told that the
    // ground moved under it. It goes into the transcript too, so a session
    // that is resumed later still carries the boundary.
    const note = projectChangedNote(target)
    this.messages.push({ role: "user", content: note })
    this.sessions.append(this.session, { role: "user", content: note, timestamp: Date.now() })
    this.hub.send({ type: "state", ...this.snapshot() })
    this.hub.send({ type: "notice", text: `project changed to ${target}` })
    return { ok: true, project: target }
  }

  /**
   * The real path on disk.
   *
   * A file that is not there yet has no real path, so the directory that
   * holds it is resolved and the missing parts are put back.
   */
  private realPath(target: string): string {
    let current = target
    const tail: string[] = []
    for (;;) {
      try {
        const real = fs.realpathSync(current)
        return tail.length ? path.join(real, ...tail) : real
      } catch {
        const parent = path.dirname(current)
        if (parent === current) return target
        tail.unshift(path.basename(current))
        current = parent
      }
    }
  }

  /**
   * Serve a file from the project so generated images can be shown inline.
   * The path is resolved and checked to be inside the project root, so this
   * cannot be used to read files elsewhere on the machine.
   */
  private sendFile(response: http.ServerResponse, url: URL): void {
    const requested = url.searchParams.get("path") ?? ""
    const target = path.resolve(this.projectRoot, requested)
    const relative = path.relative(this.projectRoot, target)
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403, { "content-type": "text/plain" })
      response.end("forbidden")
      return
    }
    // A link inside the project that points out of it is not inside it.
    const realRoot = this.realPath(this.projectRoot)
    const realTarget = this.realPath(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      response.writeHead(403, { "content-type": "text/plain" })
      response.end("forbidden")
      return
    }
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(target)
    } catch {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("not found")
      return
    }
    const type = target.endsWith(".png")
      ? "image/png"
      : target.endsWith(".jpg") || target.endsWith(".jpeg")
        ? "image/jpeg"
        : target.endsWith(".webp")
          ? "image/webp"
          : "application/octet-stream"
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" })
    response.end(bytes)
  }

  /**
   * Exchange a pasted token for the session cookie.
   *
   * The private link is the normal way in, but a landing page that links to
   * the app has no way to know the token. This lets a person paste it.
   */
  private async acceptToken(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "use POST" }))
      return
    }
    const body = await readJson(request)
    const token = String(body.token ?? "").trim()
    if (token !== this.token) {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: "that token was not accepted" }))
      return
    }
    response.writeHead(200, {
      "content-type": "application/json",
      "set-cookie": `punani=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    })
    response.end(JSON.stringify({ ok: true }))
  }

  /** A plain page explaining what to do when the link is missing or stale. */
  private sendHelp(response: http.ServerResponse, message?: string): void {
    response.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    response.end(`<!doctype html><meta charset="utf-8">
<title>Punani powerd — sign in</title>
<style>
  body{background:#000;color:#ece4d2;font:15px/1.65 "Avenir Next",-apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}
  div{max-width:520px;padding:32px}
  h1{font:400 30px/1.2 Didot,"Bodoni 72",Baskerville,Georgia,serif;margin:0 0 14px}
  p{color:#9a927f}
  form{display:flex;gap:9px;margin:22px 0 12px;flex-wrap:wrap}
  input{flex:1;min-width:220px;background:#0c0b09;border:1px solid rgba(204,180,120,.16);color:#ece4d2;border-radius:999px;padding:13px 18px;font:14px/1 ui-monospace,Menlo,monospace}
  input:focus{outline:none;border-color:rgba(204,180,120,.4)}
  button{background:#ccb478;border:1px solid #ccb478;color:#120f07;border-radius:999px;padding:13px 24px;font:600 13px/1 inherit;cursor:pointer}
  code{background:#17140e;border:1px solid rgba(204,180,120,.12);border-radius:5px;padding:2px 7px;font:13px ui-monospace,Menlo,monospace;color:#ccb478}
  a{color:#ccb478}
  .err{color:#d4674f;font:13px ui-monospace,Menlo,monospace;margin-top:10px}
  .note{margin-top:28px;padding-top:18px;border-top:1px solid rgba(204,180,120,.12);font-size:13px}
</style>
<div>
  <h1>Punani powerd</h1>
  <p>This interface needs the private link that <code>punani web</code> printed in your terminal.
     You can paste the token here instead of hunting for the link.</p>
  <form id="f">
    <input id="t" placeholder="paste the token" autocomplete="off" spellcheck="false" />
    <button type="submit">Sign in</button>
  </form>
  <p style="font:13px ui-monospace,Menlo,monospace">The token is the part after <code>?t=</code> in the link. Run <code>punani web --open</code> to open the signed-in link automatically.</p>
  <p class="err" id="e"${message ? "" : " hidden"}>${message ?? "That token was not accepted. Copy it again from the terminal."}</p>
  <p class="note">This page is the <strong>local coding agent</strong> on port 4096. It does not use Clerk.
     The email list and Clerk sign-up live on the <a href="${landingUrl()}#join">Punani AI landing page</a>.</p>
</div>
<script>
  document.getElementById("f").addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = document.getElementById("t").value.trim();
    if (!value) return;
    const res = await fetch("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: value }),
    });
    if (res.ok) { location.href = "/"; return; }
    document.getElementById("e").hidden = false;
  });
</script>`)
  }

  /**
   * Token check plus an origin check against cross-site requests.
   * Returns null when allowed, or the status code to refuse with.
   */
  private denied(request: http.IncomingMessage, url: URL): number | null {
    // The address the client used has to be one of ours. A rebound name
    // points at this server from a page on the internet, and that page
    // passes every other check.
    if (!this.isOwnHost(request.headers.host ?? "")) return 403

    const header = request.headers["x-punani-token"]
    const cookie = parseCookie(request.headers.cookie ?? "")["punani"]
    // The reload channel and the page itself carry their own key. The
    // preview page is sandboxed, so its requests count as cross-site and the
    // session cookie is not sent with them.
    //
    // The key opens the channel and the page, and nothing else. Any other
    // file in the project still needs the session, so a page that reads the
    // key out of its own markup cannot walk off and read the project.
    if (url.pathname === "/preview/live" || this.isPreviewIndex(url.pathname)) {
      const key = url.searchParams.get("k")
      if (key && key === this.preview.reloadKey) return null
    }

    // The token in the query string is only for the sign-in exchange. On
    // every other path it would end up in history and in referrers.
    const query = url.pathname === "/" || url.pathname === "/session" ? url.searchParams.get("t") : null
    const supplied = (Array.isArray(header) ? header[0] : header) ?? cookie ?? query
    if (supplied !== this.token) return 401

    // A request carrying an Origin header must come from this server.
    const origin = request.headers.origin
    if (origin) {
      let originHost: string
      try {
        originHost = new URL(origin).host
      } catch {
        return 403
      }
      // Compare against the host the client addressed, not the one this
      // server believes it has. A browser on "localhost:4096" sends that as
      // both Host and Origin, and a module script fetch carries an Origin
      // header, so comparing against the bound address refused every script
      // load under the name people actually type.
      const host = request.headers.host ?? url.host
      if (originHost !== host) return 403
    }
    return null
  }

  /**
   * Is this the preview page itself?
   *
   * The index of the project, and nothing else. The reload key opens this
   * one page and the reload channel. Every other file needs the session, so
   * a page that reads the key cannot use it to walk the project.
   *
   * pathname may be the full URL path (/preview/) or the slice passed to
   * sendPreviewFile ("/"), so both forms are accepted.
   */
  private isPreviewIndex(pathname: string): boolean {
    return pathname === "/preview/" || pathname === "/preview" || pathname === "/preview/index.html"
      || pathname === "/" || pathname === "/index.html"
  }

  /**
   * True when the address in the Host header is this server.
   *
   * A browser that resolved a name to this address can send any Host it
   * likes, so the name is checked against the addresses the server actually
   * answers on, not against the socket.
   */
  private isOwnHost(host: string): boolean {
    // A server the user bound to the network is open on purpose, and a task
    // window on another device reaches it by its address on the network. The
    // check is for the default, where the loopback address is the one thing
    // that keeps a page on the internet out.
    if (!isLoopback(this.options.host)) return true
    if (!host) return false
    const name = host.trim().toLowerCase()
    // The port the server actually answers on, which is not the one that was
    // asked for when the port was left to the system.
    const port = String(this.port)
    for (const candidate of ["127.0.0.1", "localhost", "[::1]"]) {
      if (name === candidate || name === `${candidate}:${port}`) return true
    }
    return false
  }

  private sendHtml(response: http.ServerResponse): void {
    const file = findAsset("ui.html")
    if (!file) {
      response.writeHead(404, { "content-type": "text/plain" })
      response.end("the browser interface was not installed next to this binary")
      return
    }
    try {
      const html = fs.readFileSync(file, "utf8")
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline'; " +
          "connect-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; " +
          // The preview pane frames the project itself, and optionally a dev
          // server the user is already running.
          "frame-src 'self' http: https:",
      })
      response.end(html)
    } catch {
      response.writeHead(500, { "content-type": "text/plain" })
      response.end("ui.html is missing from the install")
    }
  }

  private sendEvents(request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    response.write(": connected\n\n")

    const write = (event: Record<string, unknown>): void => {
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    const unsubscribe = this.hub.subscribe(write)
    write({ type: "state", ...this.snapshot() })

    const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000)
    request.on("close", () => {
      clearInterval(keepAlive)
      unsubscribe()
    })
  }

  private async sendApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const route = url.pathname.replace("/api/", "")
    // A message can carry pictures, so it gets a bigger body than the rest.
    const limit = url.pathname === "/api/message" ? MAX_MESSAGE_BYTES : MAX_BODY_BYTES
    const body = request.method === "POST" ? await readJson(request, limit) : {}

    switch (route) {
      case "state":
        return json(response, this.snapshot())
      case "message":
        return json(
          response,
          await this.startTurn(String(body.text ?? ""), readImages(body.images)),
        )
      case "revert-user":
        return json(response, this.revertLastUserMessage())
      case "permission":
        return json(response, this.answerPermission(body))
      case "abort":
        return json(response, this.requestAbort())
      case "models":
        return json(response, { models: await this.registry.allModels() })
      case "model": {
        const found = await this.registry.findModel(String(body.model ?? ""))
        if (!found) return json(response, { error: `unknown model ${body.model}` }, 404)
        this.model = found
        this.config.setDefaultModel(String(body.model))
        this.hub.send({ type: "state", ...this.snapshot() })
        return json(response, { ok: true, model: found })
      }
      case "sessions":
        return json(response, { sessions: this.sessions.list() })
      case "resume":
        return json(response, this.resume(String(body.id ?? "")))
      case "history":
        return json(response, { messages: this.messages })
      case "providers":
        return json(response, { providers: await this.registry.status() })
      case "browse":
        return json(response, this.browse(String(url.searchParams.get("path") ?? "")))
      case "pick-folder": {
        // Start the native chooser and hand back an id to poll.
        const id = this.startFolderPicker(body.startAt ? String(body.startAt) : undefined)
        return json(response, { id })
      }
      case "pick-folder-status":
        return json(response, this.folderPickerStatus(String(url.searchParams.get("id") ?? "")))
      case "settings":
        return json(response, await this.settingsView())
      case "settings-key": {
        const result = this.settings.setKey(String(body.provider ?? ""), String(body.key ?? ""))
        if (result.ok) this.hub.send({ type: "notice", text: `key stored for ${body.provider}` })
        return json(response, result, result.ok ? 200 : 400)
      }
      case "settings-key-clear": {
        this.settings.clearKey(String(body.provider ?? ""))
        this.hub.send({ type: "notice", text: `key removed for ${body.provider}` })
        return json(response, { ok: true })
      }
      case "settings-provider": {
        const result = this.settings.setProvider(body)
        return json(response, result, result.ok ? 200 : 400)
      }
      case "settings-provider-remove": {
        this.settings.removeProvider(String(body.id ?? ""))
        return json(response, { ok: true })
      }
      case "settings-image": {
        const result = this.settings.setImage(body)
        return json(response, result, result.ok ? 200 : 400)
      }
      case "settings-audio": {
        const result = this.settings.setAudio(body)
        return json(response, result, result.ok ? 200 : 400)
      }
      case "settings-mcp": {
        const result = this.settings.setMcp(body.servers)
        return json(response, result, result.ok ? 200 : 400)
      }
      case "settings-model": {
        this.settings.setDefaultModel(body.model ? String(body.model) : undefined)
        return json(response, { ok: true })
      }
      case "settings-voices": {
        const { listVoices } = await import("../provider/elevenlabs.js")
        try {
          const voices = await listVoices(body.key ? String(body.key) : undefined)
          return json(response, { voices })
        } catch (error) {
          return json(response, { error: (error as Error).message }, 400)
        }
      }
      case "preview": {
        const mode = String(body.mode ?? "off")
        if (mode === "static" || mode === "url") {
          this.preview.enable(mode, body.url ? String(body.url) : undefined)
        } else {
          this.preview.disable()
        }
        this.hub.send({ type: "preview", ...this.preview.state() })
        return json(response, { ok: true, ...this.preview.state() })
      }
      case "project":
        return json(response, this.switchProject(String(body.path ?? "")))
      case "task-windows":
        return json(response, {
          current: { port: this.boundPort, host: this.options.host, label: this.taskLabel, url: this.url },
          windows: listWebInstances(this.projectRoot),
        })
      case "task-window":
        return json(response, await this.openAnotherTaskWindow())
      default:
        return json(response, { error: "unknown route" }, 404)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Agent                                                             */
  /* ---------------------------------------------------------------- */

  private snapshot(): Record<string, unknown> {
    const info = {
      ...describeProject(this.projectRoot),
      // Which instruction files the agent is following. Worth showing: it
      // explains why it behaves the way it does in this project.
      instructions: loadProjectInstructions(this.projectRoot).files,
    }
    const devPreview = devPreviewTargets(this.projectRoot)
    return {
      session: this.session,
      model: this.model,
      project: this.projectRoot,
      projectInfo: info,
      devPreview,
      taskLabel: this.taskLabel,
      taskPort: this.boundPort,
      taskWindows: listWebInstances(this.projectRoot),
      busy: this.busy,
      pending: this.permissions.list(),
      providers: this.config.providers().map((provider) => ({ id: provider.id, name: provider.name })),
      preview: this.preview.state(),
      mcp: {
        servers: this.config.mcpServers().map((server) => ({ name: server.name, enabled: server.enabled !== false })),
        connected: this.mcp?.connected ?? [],
        tools: this.mcpTools.length,
      },
    }
  }

  private async startTurn(text: string, images: AttachedImage[] = []): Promise<unknown> {
    if (!text.trim() && images.length === 0) return { error: "empty message" }

    if (this.busy) {
      this.messageQueue.push({ text: text.trim(), images })
      this.hub.send({ type: "user", text: text.trim(), queued: true })
      this.hub.send({
        type: "notice",
        text: `Follow-up queued (${this.messageQueue.length}). It will run when the current turn finishes.`,
      })
      return { ok: true, queued: true, queueLength: this.messageQueue.length }
    }

    // The catalog may still be loading. Waiting is right; saying "no model
    // configured" when one is about to be is not.
    await this.modelReady

    if (!this.model) {
      const msg = "no model is configured yet. Pick one in the model picker."
      this.hub.send({ type: "notice", text: msg })
      return { error: msg }
    }
    if (images.length > 0 && !this.model.vision) {
      const msg = `${this.model.name} cannot see pictures. Pick a model that can, or describe the picture.`
      this.hub.send({ type: "notice", text: msg })
      return { error: msg }
    }
    const provider = this.registry.providers().find((entry) => entry.id === this.model!.providerID)
    if (!provider) {
      const msg = `provider ${this.model.providerID} is not configured`
      this.hub.send({ type: "notice", text: msg })
      return { error: msg }
    }
    const { key } = this.registry.keyFor(provider)
    if (!key && !this.requestKeys[provider.id] && !provider.anonymous) {
      const msg = `no API key for ${provider.id}. Add one in Settings or run punani --init.`
      this.hub.send({ type: "notice", text: msg })
      return { error: msg }
    }

    this.abortEpoch++
    this.busy = true
    this.abort = new AbortController()
    this.hub.send({ type: "state", ...this.snapshot() })
    this.hub.send({ type: "user", text })

    this.sessions.append(this.session, {
      role: "user",
      content: transcriptOf(text, images),
      timestamp: Date.now(),
    })
    this.messages.push({ role: "user", content: messageOf(text, images) })

    // The turn runs in the background. Everything it produces arrives over the
    // event stream, so the request that started it can return immediately.
    void this.runTurn(provider, key)
    return { ok: true }
  }

  /** Run a turn in the background, and report what went wrong if it fails. */
  private async runTurn(provider: any, key: string | undefined): Promise<void> {
    try {
      await this.executeTurn(provider, key)
    } catch (error) {
      this.hub.send({
        type: "error",
        title: "Agent failed",
        message: error instanceof Error ? error.message : String(error),
        remedy: "Check the provider settings, then try again.",
        suggestions: await this.suggestions(),
      })
      this.busy = false
      this.abort = undefined
      this.hub.send({ type: "state", ...this.snapshot() })
      this.drainMessageQueue()
    }
  }

  /** Run one turn and send everything it produces to the browser. */
  private async executeTurn(provider: any, key: string | undefined): Promise<void> {
    // When the turn started, so the pane can tell what it made.
    const started = Date.now()
    const tools = [
      ...buildTools(this.config.imageSettings(), this.config.audioSettings(), this.mcpTools),
      ...this.skillTools,
    ]
    // A key the browser sent wins over the one on disk, so the browser can
    // hold a key the server never sees.
    const effectiveKey = key ?? this.requestKeys[provider.id]
    const client = createClient(provider, effectiveKey, this.config.headers(provider.id))

    // A provider that throttles hands the turn to another model. The session
    // follows it, so the next turn starts on the model that works.
    const failover = createFailover({
      registry: this.registry,
      config: this.config,
      keyFor: (providerID) => {
        const browserKey = this.requestKeys[providerID]
        if (browserKey) return browserKey
        const entry = this.registry.provider(providerID)
        return entry ? this.registry.keyFor(entry).key : undefined
      },
      onSwitch: (next) => {
        this.model = next
        this.session.model = next.id
        this.session.provider = next.providerID
      },
    })

    const context: ToolContext = {
      allowedReadDirs: defaultRoots(this.projectRoot).map((root) => root.path),
      projectRoot: this.projectRoot,
      requestPermission: (request) =>
        resolvePermission(this.permissionEngine, request, async (pending) => {
          const { id, promise } = this.permissions.create(pending)
          this.hub.send({
            type: "permission",
            id,
            action: pending.action,
            resource: pending.resource,
            summary: pending.summary,
            detail: pending.detail,
            destructive: pending.destructive === true,
            alwaysPatterns: pending.alwaysPatterns,
          })
          return await promise
        }),
      notify: (message: string) => this.hub.send({ type: "notice", text: message }),
      setPreview: (url: string) => {
        this.preview.enable("url", url)
        this.hub.send({ type: "preview", ...this.preview.state() })
      },
      previewDiff: (file: string, before: string, after: string) => {
        const result = diffLines(before, after)
        this.hub.send({
          type: "diff",
          id: this.currentToolId,
          path: file,
          additions: result.additions,
          deletions: result.deletions,
          lines: result.lines.map((line) => ({
            kind: line.kind,
            text: line.text,
            oldLine: line.oldLine,
            newLine: line.newLine,
          })),
        })
      },
      mutate: diskMutate,
      signal: this.abort?.signal,
    }

    const imageSettings = this.config.imageSettings()
    const audioSettings = this.config.audioSettings()
    const system = buildSystemPrompt(
      this.projectRoot,
      {
        image: imageSettings.provider !== "none",
        audio: audioSettings.provider !== "none",
        vision: this.model?.vision === true,
      },
      {
        catalog: this.skillCatalog,
        instructions: this.projectInstructions,
        routes: this.skillRoutes,
        alwaysOn: this.alwaysOn,
      },
    )
    const result = await runAgentTurn(
      {
        client,
        model: this.model!,
        reasoningEffort: this.config.reasoningEffort(modelKey(this.model!)),
        tools,
        projectRoot: this.projectRoot,
        context,
        signal: this.abort?.signal,
        fallback: failover,
        onEvent: (event) => {
          if (event.type === "assistant_text" && event.text) {
            this.hub.send({ type: "assistant", text: event.text, delta: event.partial === true })
          }
          if (event.type === "reasoning" && event.text) {
            this.hub.send({ type: "reasoning", text: event.text, delta: event.partial === true })
          }
          if (event.type === "tool_start") {
            this.currentToolId = event.toolCallId
            this.hub.send({ type: "tool_start", tool: event.tool, id: event.toolCallId, args: event.args })
          }
          if (event.type === "tool_end" && event.result) {
            this.currentToolId = undefined
            this.hub.send({
              type: "tool_end",
              tool: event.tool,
              id: event.toolCallId,
              output: event.result.output,
              isError: event.result.isError === true,
              meta: event.result.meta,
            })
          }
          if (event.type === "notice" && event.text) {
            this.hub.send({ type: "notice", text: event.text })
          }
        },
      },
      [{ role: "system", content: system }, ...this.messages],
    )

    if (result.error) {
      this.hub.send({
        type: "error",
        title: result.error.title,
        message: result.error.message,
        remedy: result.error.remedy,
        hint: result.error.hint,
        ...(await this.suggestions()),
      })
    } else if (result.stoppedReason === "max_steps") {
      // A turn that hits the step limit looks like a finished one unless
      // something says so.
      this.hub.send({
        type: "notice",
        text: `Stopped after ${DEFAULT_MAX_STEPS} tool steps to stay within budget. The task may be unfinished.`,
      })
    }

    // The messages of the turn, each with the usage of the call that made it.
    this.sessions.appendTurnMessages(this.session, result.added, result.steps)

    // Why the turn ended, and what the whole turn cost.
    this.sessions.appendTurn(this.session, {
      stoppedReason: result.stoppedReason,
      errorKind: result.error?.kind,
      errorMessage: result.error?.message,
      usage: result.usage,
    })

    // A picture or a clip the agent just made is the thing the user wants to
    // see, so the pane shows it.
    this.showNewMedia(started)

    this.messages = result.messages.filter((message) => message.role !== "system")

    if (this.revertAfterAbort && result.stoppedReason === "aborted") {
      this.revertAfterAbort = false
      const reverted = this.applyRevertLastUser()
      this.busy = false
      this.abort = undefined
      this.hub.send({
        type: "done",
        stoppedReason: "aborted",
        usage: result.usage,
      })
      this.hub.send({ type: "state", ...this.snapshot() })
      if (reverted.ok && reverted.text) {
        this.hub.send({ type: "revert", text: reverted.text })
      }
      this.drainMessageQueue()
      return
    }

    this.busy = false
    this.abort = undefined
    this.hub.send({
      type: "done",
      stoppedReason: result.stoppedReason,
      usage: result.usage,
    })
    this.hub.send({ type: "state", ...this.snapshot() })
    this.drainMessageQueue()
  }

  /**
   * Show what the turn made, in the preview pane.
   *
   * The file is found by what changed in the project, so it does not matter
   * which tool made it: the picture tool, or a skill that rendered a clip.
   */
  private showNewMedia(started: number): void {
    const found = this.preview.newestMedia(started - 250)
    if (!found) return
    // The same file again is not news.
    if (found.path === this.lastMedia) return
    this.lastMedia = found.path
    this.preview.showFile(found.path)
    this.hub.send({
      type: "notice",
      text: `The preview is showing ${found.path}, made by this turn.`,
    })
  }

  private drainMessageQueue(): void {
    const next = this.messageQueue.shift()
    if (next) void this.startTurn(next.text, next.images)
  }

  private requestAbort(): { ok: true } {
    this.abortEpoch++
    const epoch = this.abortEpoch
    this.abort?.abort()
    this.permissions.rejectAll("cancelled by the user")
    if (this.busy) {
      this.hub.send({ type: "notice", text: "Stopping…" })
      setTimeout(() => {
        if (epoch !== this.abortEpoch || !this.busy) return
        this.busy = false
        this.abort = undefined
        this.hub.send({
          type: "done",
          stoppedReason: "aborted",
          usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
        })
        this.hub.send({ type: "state", ...this.snapshot() })
        this.hub.send({ type: "notice", text: "Run stopped." })
        this.drainMessageQueue()
      }, 4000)
    }
    return { ok: true }
  }

  private revertLastUserMessage(): { ok: boolean; text?: string; error?: string; pending?: boolean } {
    if (this.busy) {
      this.revertAfterAbort = true
      this.messageQueue.length = 0
      this.abort?.abort()
      this.permissions.rejectAll("message reverted")
      return { ok: true, pending: true }
    }
    return this.applyRevertLastUser()
  }

  private applyRevertLastUser(): { ok: boolean; text?: string; error?: string } {
    let idx = -1
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === "user") {
        idx = i
        break
      }
    }
    if (idx < 0) return { ok: false, error: "no user message to revert" }

    const text = messageText(this.messages[idx]!)
    this.messages = this.messages.slice(0, idx)

    const stored = this.sessions.read(this.session.id)
    if (stored) {
      let storedIdx = -1
      for (let i = stored.messages.length - 1; i >= 0; i--) {
        if (stored.messages[i]!.role === "user") {
          storedIdx = i
          break
        }
      }
      if (storedIdx >= 0) {
        this.sessions.rewrite(this.session, stored.messages.slice(0, storedIdx))
      }
    }

    this.hub.send({ type: "history", messages: this.historyForClient() })
    return { ok: true, text }
  }

  private async openAnotherTaskWindow(): Promise<Record<string, unknown>> {
    const spawned = await spawnTaskWindow({
      projectRoot: this.projectRoot,
      host: this.options.host,
    })
    if (!spawned.ok) return spawned
    this.hub.send({
      type: "notice",
      text: `${spawned.label} started on port ${spawned.port}. Each task window has its own agent — avoid two tasks editing the same files at once.`,
    })
    return { ...spawned }
  }

  private historyForClient(): { role: string; content: string }[] {
    return this.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: messageText(m) }))
      .filter((m) => m.content.trim())
  }

  private async suggestions(): Promise<{ list: string[]; costs: Record<string, string> }> {
    if (!this.model) return { list: [], costs: {} }
    const alternatives = await this.registry.alternatives(this.model)
    const list: string[] = []
    const costs: Record<string, string> = {}
    for (const model of alternatives) {
      const key = `${model.providerID}/${model.id}`
      list.push(key)
      costs[key] =
        model.cost.input === 0 && model.cost.output === 0
          ? "free"
          : `$${model.cost.input}/$${model.cost.output} per 1M`
    }
    return { list, costs }
  }

  private answerPermission(body: any): { ok: boolean; error?: string } {
    const id = String(body.id ?? "")
    const reply = String(body.reply ?? "reject")
    const message = typeof body.message === "string" ? body.message : undefined

    // The id is assigned when the request is queued; the browser gets it there.
    const entry = this.permissions.list().find((item) => item.id === id)
    if (!entry) return { ok: false, error: "unknown permission" }

    const granted = reply === "once" || reply === "always"
    const remember = reply === "always"
    const patterns =
      remember && entry.request.alwaysPatterns?.length
        ? entry.request.alwaysPatterns
        : remember
          ? [entry.request.resource]
          : undefined
    const ok = this.permissions.reply(id, { granted, remember, message, patterns })
    return ok ? { ok: true } : { ok: false, error: "unknown permission" }
  }

  private resume(id: string): { ok: boolean; error?: string } {
    const stored = this.sessions.read(id)
    if (!stored) return { ok: false, error: "no such session" }
    this.session = stored.meta
    this.messages = toChatMessages(stored.messages)
    this.hub.send({ type: "state", ...this.snapshot() })
    this.hub.send({ type: "history", messages: this.messages })
    return { ok: true }
  }
}

/**
 * The keys the browser kept in its own storage, sent on every request.
 * They are used for that request only and are never written to disk.
 */
function readBrowserKeys(request: http.IncomingMessage): Record<string, string> {
  const header = request.headers["x-punani-keys"]
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function json(response: http.ServerResponse, payload: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
  response.end(JSON.stringify(payload))
}

/**
 * An image the user attached to a message.
 *
 * It travels as a data URL, because that is what the model providers take.
 */
export interface AttachedImage {
  url: string
  mime: string
  bytes: number
}

/** The most one image may weigh, the same limit the read tool has. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** The most images one message may carry. */
const MAX_IMAGES = 6

/**
 * Read the images out of a request.
 *
 * A data URL that is not an image, or that is too big, is dropped rather
 * than passed on: the provider would refuse it, and a refusal in the middle
 * of a conversation is worse than a missing picture.
 */
export function readImages(value: unknown): AttachedImage[] {
  if (!Array.isArray(value)) return []
  const out: AttachedImage[] = []
  for (const item of value) {
    if (typeof item !== "string") continue
    const match = item.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s)
    if (!match) continue
    const mime = match[1]!
    const base64 = match[2]!
    const bytes = Math.floor((base64.length * 3) / 4)
    if (bytes > MAX_IMAGE_BYTES) continue
    if (out.length >= MAX_IMAGES) break
    out.push({ url: `data:${mime};base64,${base64}`, mime, bytes })
  }
  return out
}

/** The message the model sees: the text, and the pictures with it. */
export function messageOf(text: string, images: AttachedImage[]): string | ContentPart[] {
  if (images.length === 0) return text
  return [
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
    ...images.map((image) => ({ type: "image_url" as const, image_url: { url: image.url } })),
  ]
}

/** What the transcript keeps: the text, and a note that pictures came with it. */
export function transcriptOf(text: string, images: AttachedImage[]): string {
  if (images.length === 0) return text
  const note = `[${images.length} image${images.length === 1 ? "" : "s"} attached]`
  return text.trim() ? `${note}\n${text}` : note
}

/** A request body is small. Anything larger is not a request we want. */
const MAX_BODY_BYTES = 1024 * 1024
/** A message with pictures in it is bigger. */
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024

async function readJson(request: http.IncomingMessage, limit = MAX_BODY_BYTES): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > limit) {
      request.destroy()
      return {}
    }
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return {}
  }
}

function parseCookie(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}
