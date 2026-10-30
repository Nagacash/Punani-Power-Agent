import { ToolError } from "./fsutil.js"
import { type Tool, type ToolContext, type ToolResult } from "./types.js"

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 30_000

/** Fetch a public HTTP(S) URL and return text for the model (landing pages, docs). */
export const fetchUrlTool: Tool = {
  name: "fetch_url",
  description:
    "Fetch a public http or https URL and return the response body as text. " +
    "Use this to read a landing page, docs or API docs when the content is not in the project. " +
    "For heavy scraping or anti-bot sites, load the scrapling-official skill instead.",
  permissionAction: "fetch",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http or https URL to fetch." },
    },
    required: ["url"],
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    const raw = String(args.url ?? "").trim()
    if (!raw) throw new ToolError("url must not be empty")
    let parsed: URL
    try {
      parsed = new URL(raw)
    } catch {
      throw new ToolError(`"${raw}" is not a valid URL`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ToolError("only http and https URLs are allowed")
    }

    const outcome = await context.requestPermission({
      action: "fetch",
      resource: parsed.toString(),
      summary: `Fetch: ${parsed.hostname}${parsed.pathname}`,
      detail: "Reads a public page from the network. The response is shown to the model only.",
    })
    if (!outcome.granted) {
      return { output: "fetch was declined", isError: true }
    }

    if (context.signal?.aborted) {
      return { output: "the turn was stopped before the fetch ran", isError: true, stop: true }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const onAbort = () => controller.abort()
    context.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: { "user-agent": "PunaniPowerd/1.0 (+https://punani.agency)" },
        redirect: "follow",
      })
      const buffer = Buffer.from(await response.arrayBuffer())
      const truncated = buffer.length > MAX_BYTES
      const body = (truncated ? buffer.subarray(0, MAX_BYTES) : buffer).toString("utf8")
      const type = response.headers.get("content-type") ?? "unknown"
      const lines = [
        `HTTP ${response.status} ${response.statusText}`,
        `content-type: ${type}`,
        truncated ? `(body truncated to ${MAX_BYTES} bytes)` : "",
        "",
        body,
      ].filter(Boolean)
      return {
        output: lines.join("\n"),
        isError: !response.ok,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new ToolError(`could not fetch ${parsed.hostname}: ${message}`)
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener("abort", onAbort)
    }
  },
}
