import fs from "node:fs"
import path from "node:path"
import { EventEmitter } from "node:events"

/**
 * The preview server.
 *
 * Two ways to see what you are building:
 *
 *   static  the project's own files are served from the project root, with
 *           live reload injected into every HTML page. Works for any static
 *           site, and for anything that only needs the browser.
 *   url     an existing dev server is shown instead, and the pane reloads
 *           when the source changes. This is the one for Vite, Next, Nuxt and
 *           anything else with its own dev server.
 *
 * A watcher on the project root drives both. It ignores the usual noise.
 */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".tsx": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".wasm": "application/wasm",
}

/** The files the pane can show: pictures, clips and sound. */
const MEDIA: Record<string, "image" | "video" | "audio"> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".svg": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mov": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".ogg": "audio",
}

/** The kind of a file, when the pane can show it. */
function mediaKind(name: string): "image" | "video" | "audio" | undefined {
  return MEDIA[path.extname(name).toLowerCase()]
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".turbo",
  ".parcel-cache",
  "tmp",
])

export type PreviewMode = "static" | "url" | "file" | "off"

/** The script that reloads the page when the source changes. */
const LIVE_RELOAD = `<script>
(() => {
  let socket;
  const connect = () => {
    socket = new EventSource("/preview/live");
    socket.onmessage = (event) => {
      if (event.data === "reload") location.reload();
    };
    socket.onerror = () => { socket.close(); setTimeout(connect, 1500); };
  };
  connect();
})();
</script>`

export class PreviewServer extends EventEmitter {
  private watcher?: fs.FSWatcher
  private timer?: NodeJS.Timeout
  private readonly ignore = new Set(IGNORED)

  mode: PreviewMode = "off"
  /** The external dev server to show, when mode is "url". */
  url = ""
  /** The file to show, when mode is "file". */
  file = ""
  /** The port the built-in static server listens on. */
  port = 0

  constructor(private projectRoot: string) {
    super()
  }

  /** Point the preview at a different project. */
  setProject(root: string): void {
    this.projectRoot = root
    this.restartWatcher()
  }

  /** Turn the preview on, in static, url or file mode. */
  enable(mode: Exclude<PreviewMode, "off">, url?: string): void {
    this.mode = mode
    if (url) this.url = url
    this.startWatcher()
    this.emit("state", this.state())
  }

  /**
   * Show a file the agent just made.
   *
   * A picture or a clip that was just generated is the thing the user wants
   * to see, so the pane shows it rather than the page behind it.
   */
  showFile(relative: string): void {
    this.file = relative
    this.mode = "file"
    this.startWatcher()
    this.emit("state", this.state())
  }

  disable(): void {
    this.mode = "off"
    this.stopWatcher()
    this.emit("state", this.state())
  }

  state(): { mode: PreviewMode; url: string; file: string; port: number } {
    return { mode: this.mode, url: this.url, file: this.file, port: this.port }
  }

  /**
   * The newest picture, clip or sound the project grew, since a moment.
   *
   * The agent writes a picture or renders a clip into the project, and the
   * pane should show it. The files are found by looking at what changed, so
   * it does not matter which tool made them.
   */
  newestMedia(since: number): { path: string; kind: "image" | "video" | "audio" } | undefined {
    let newest: { path: string; kind: "image" | "video" | "audio"; at: number } | undefined
    const walk = (dir: string, depth: number): void => {
      if (depth > 6) return
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || this.ignore.has(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
          continue
        }
        if (!entry.isFile()) continue
        const kind = mediaKind(entry.name)
        if (!kind) continue
        let at = 0
        try {
          at = fs.statSync(full).mtimeMs
        } catch {
          continue
        }
        if (at < since) continue
        if (!newest || at > newest.at) {
          newest = { path: path.relative(this.projectRoot, full).split(path.sep).join("/"), kind, at }
        }
      }
    }
    walk(this.projectRoot, 0)
    if (!newest) return undefined
    return { path: newest.path, kind: newest.kind }
  }

  /* ---------------------------------------------------------------- */
  /* Watching                                                          */
  /* ---------------------------------------------------------------- */

  private startWatcher(): void {
    this.stopWatcher()
    try {
      this.watcher = fs.watch(this.projectRoot, { recursive: true }, (_event, filename) => {
        if (!filename) return
        const relative = String(filename)
        const first = relative.split(path.sep)[0] ?? ""
        if (this.ignore.has(first) || first.startsWith(".")) return
        if (relative.includes("/.") || relative.startsWith(".")) return
        this.scheduleReload()
      })
    } catch (error) {
      // Recursive watching is not supported everywhere; the preview still works,
      // it just will not reload by itself.
      this.emit("problem", `could not watch for changes: ${(error as Error).message}`)
    }
  }

  private stopWatcher(): void {
    this.watcher?.close()
    this.watcher = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  private restartWatcher(): void {
    if (this.mode === "off") return
    this.startWatcher()
  }

  /** Coalesce a burst of file events into one reload. */
  private scheduleReload(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.emit("reload")
    }, 120)
  }

  /* ---------------------------------------------------------------- */
  /* Serving                                                           */
  /* ---------------------------------------------------------------- */

  /** Resolve a request path to a file inside the project. */
  resolve(requestPath: string): { file: string; type: string } | undefined {
    const cleaned = decodeURIComponent(requestPath.split("?")[0] ?? "/")
    const relative = cleaned === "/" || cleaned === "" ? "index.html" : cleaned.replace(/^\/+/, "") || "index.html"
    const target = path.resolve(this.projectRoot, relative)
    const inside = path.relative(this.projectRoot, target)
    if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined
    // A link inside the project that points out of it is not served.
    if (!this.staysInside(target)) return undefined

    let file = target
    let type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream"

    try {
      let stat = fs.statSync(file)
      if (stat.isDirectory()) {
        file = path.join(file, "index.html")
        type = MIME[".html"] ?? "text/html; charset=utf-8"
        stat = fs.statSync(file)
      }
      if (!stat.isFile()) return undefined
    } catch {
      return undefined
    }
    return { file, type }
  }

  /**
   * True when the real path of a file is still inside the project.
   *
   * The path is checked twice on purpose: the name has to be inside, and
   * the file it points at has to be inside as well.
   */
  private staysInside(target: string): boolean {
    const realRoot = this.realPath(this.projectRoot)
    const realTarget = this.realPath(target)
    return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)
  }

  /** The real path on disk, or the path of the directory that holds it. */
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

  /** Read a file, adding the reload script to HTML. */
  read(file: string, type: string): Buffer {
    const bytes = fs.readFileSync(file)
    if (!type.startsWith("text/html")) return bytes
    const html = bytes.toString("utf8")
    if (html.includes("/preview/live")) return bytes
    // Inject before </body> when there is one, else before </html>, else append.
    if (/<\/body>/i.test(html)) {
      return Buffer.from(html.replace(/<\/body>/i, `${LIVE_RELOAD}\n</body>`), "utf8")
    }
    if (/<\/html>/i.test(html)) {
      return Buffer.from(html.replace(/<\/html>/i, `${LIVE_RELOAD}\n</html>`), "utf8")
    }
    return Buffer.from(`${html}\n${LIVE_RELOAD}\n`, "utf8")
  }
}
