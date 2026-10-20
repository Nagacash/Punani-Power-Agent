import { McpClient, type McpServerConfig, type McpToolInfo } from "./client.js"
import { ToolError } from "../tool/fsutil.js"
import type { Tool, ToolContext, ToolResult } from "../tool/types.js"

/**
 * Turns the tools an MCP server exposes into tools the agent can call.
 *
 * The tool name is `<server>_<tool>`, lower-cased, because the OpenAI-compatible
 * wire format only allows letters, digits, underscore and dash.
 */

function wireName(server: string, tool: string): string {
  const cleaned = `${server}_${tool}`.toLowerCase().replace(/[^a-z0-9_-]/g, "_")
  return cleaned.slice(0, 64)
}

/** Build a tool that calls one MCP tool. */
function toTool(server: McpServerConfig, client: McpClient, info: McpToolInfo): Tool {
  return {
    name: wireName(server.name, info.name),
    description: `[${server.name}] ${info.description || info.name}`,
    permissionAction: "mcp",
    parameters: info.inputSchema ?? { type: "object", properties: {} },
    async run(args: any, context: ToolContext): Promise<ToolResult> {
      const outcome = await context.requestPermission({
        action: "mcp",
        resource: `${server.name}.${info.name}`,
        summary: `Call ${server.name}.${info.name}`,
        detail: Object.keys(args ?? {}).length
          ? `Arguments: ${Object.keys(args).join(", ")}`
          : "No arguments.",
        alwaysPatterns: [`${server.name}.${info.name}`],
      })
      if (!outcome.granted) {
        return {
          output: `The user declined the call to ${server.name}.${info.name}.${
            outcome.message ? ` Feedback: ${outcome.message}` : ""
          }`,
          isError: true,
        }
      }

      let result
      try {
        result = await client.callTool(info.name, args ?? {})
      } catch (error) {
        throw new ToolError(`the ${server.name} server failed: ${(error as Error).message}`)
      }

      const text = (result.content ?? [])
        .map((part) => (part.type === "text" ? (part.text ?? "") : `[${part.type}]`))
        .join("\n")
        .trim()

      return {
        output: text || "(the server returned no output)",
        isError: result.isError === true,
        meta: { mcp: server.name, tool: info.name },
      }
    },
  }
}

/**
 * Holds the MCP servers for a session and hands their tools to the agent.
 *
 * Servers are started lazily and in parallel, and one that fails to start
 * never stops the agent: it is reported and the rest carry on.
 */
export class McpRegistry {
  private readonly clients = new Map<string, McpClient>()
  private readonly tools: Tool[] = []
  readonly problems: string[] = []

  constructor(private readonly servers: McpServerConfig[]) {}

  /** Start every enabled server and collect its tools. */
  async start(): Promise<Tool[]> {
    this.tools.length = 0
    this.problems.length = 0
    const enabled = this.servers.filter((server) => server.enabled !== false)
    if (enabled.length === 0) return this.tools

    await Promise.all(
      enabled.map(async (server) => {
        const client = new McpClient(server)
        try {
          await client.connect()
          this.clients.set(server.name, client)
          for (const info of client.availableTools) {
            this.tools.push(toTool(server, client, info))
          }
        } catch (error) {
          const message = (error as Error).message
          this.problems.push(`${server.name}: ${message}`)
          await client.close().catch(() => {})
        }
      }),
    )

    return this.tools
  }

  get connected(): { name: string; tools: number; server?: string }[] {
    return [...this.clients.values()].map((client) => ({
      name: client.name,
      tools: client.availableTools.length,
      server: client.serverName,
    }))
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close().catch(() => {})))
    this.clients.clear()
  }
}
