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

export type PreviewMode = "static" | "url" | "off"

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

  /** Turn the preview on, in static or url mode. */
  enable(mode: Exclude<PreviewMode, "off">, url?: string): void {
    this.mode = mode
    if (url) this.url = url
    this.startWatcher()
    this.emit("state", this.state())
  }

  disable(): void {
    this.mode = "off"
    this.stopWatcher()
    this.emit("state", this.state())
  }

  state(): { mode: PreviewMode; url: string; port: number } {
    return { mode: this.mode, url: this.url, port: this.port }
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
