#!/usr/bin/env node
/**
 * A minimal MCP server, used to test the client.
 *
 * It speaks newline-delimited JSON-RPC 2.0 over stdio and exposes two tools:
 * `echo` and `add`. No dependencies, so it runs anywhere Node does.
 */

let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8")
  let index
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    handle(message)
  }
})

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function replyError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`)
}

function handle(message) {
  const { id, method, params } = message

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "punani-test-mcp", version: "1.0.0" },
    })
    return
  }

  if (method === "tools/list") {
    reply(id, {
      tools: [
        {
          name: "echo",
          description: "Echo the text back.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string", description: "What to echo" } },
            required: ["text"],
          },
        },
        {
          name: "add",
          description: "Add two numbers.",
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" }, b: { type: "number" } },
            required: ["a", "b"],
          },
        },
      ],
    })
    return
  }

  if (method === "tools/call") {
    const name = params?.name
    const args = params?.arguments ?? {}
    if (name === "echo") {
      reply(id, { content: [{ type: "text", text: `echo: ${args.text ?? ""}` }] })
      return
    }
    if (name === "add") {
      reply(id, { content: [{ type: "text", text: String((Number(args.a) || 0) + (Number(args.b) || 0)) }] })
      return
    }
    replyError(id, `unknown tool ${name}`)
    return
  }

  // Notifications get no reply.
}
