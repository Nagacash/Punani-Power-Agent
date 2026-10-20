#!/usr/bin/env node
/**
 * A mock OpenAI-compatible server for the offline demo.
 *
 * It speaks the same wire protocol as a real provider:
 *   GET  /v1/models          -> the model catalog
 *   POST /v1/chat/completions -> a scripted tool call, then a final answer
 *
 * The script is driven by a JSON file so you can shape the demo: which tool
 * the model calls, and what it says when it is done.
 *
 *   node samples/mock-server.mjs --port 3001 --script samples/demo-script.json
 */

import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1 || index === process.argv.length - 1) return fallback
  return process.argv[index + 1]
}

const port = Number(arg("port", 3001))
const scriptFile = arg("script", path.join(here, "demo-script.json"))
const script = JSON.parse(fs.readFileSync(scriptFile, "utf8"))

const MODELS = {
  object: "list",
  data: [
    {
      id: "demo-assistant",
      object: "model",
      created: 0,
      owned_by: "mock",
      name: "Demo Assistant (offline mock)",
      context_window: 32_768,
      context_length: 32_768,
      available: true,
      execution_status: "ready",
      supported_parameters: ["tools", "temperature"],
    },
    {
      id: "demo-plain",
      object: "model",
      created: 0,
      owned_by: "mock",
      name: "Demo Plain (no tool support)",
      context_window: 8_192,
      available: true,
      execution_status: "ready",
      supported_parameters: [],
    },
  ],
}

let step = 0

function toolCallMessage(call) {
  return {
    role: "assistant",
    content: call.say ?? "",
    tool_calls: [
      {
        id: call.id ?? `call_${step}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
      },
    ],
  }
}

const server = http.createServer((request, response) => {
  const chunks = []
  request.on("data", (chunk) => chunks.push(chunk))
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8")

    if (request.url === "/v1/models" || request.url === "/models") {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(MODELS))
      return
    }

    if (request.url === "/v1/chat/completions" || request.url === "/chat/completions") {
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = {}
      }
      // The script is a fixed sequence of turns: each request consumes one
      // step, so the agent sees a tool call, then a tool call, then the answer.
      const scriptStep = script.steps[Math.min(step, script.steps.length - 1)]

      let message
      if (scriptStep?.tool && step < script.steps.length) {
        message = toolCallMessage(scriptStep.tool)
        step++
      } else {
        message = { role: "assistant", content: scriptStep?.say ?? "Done." }
        step++
      }

      response.writeHead(200, { "content-type": "application/json" })
      response.end(
        JSON.stringify({
          model: body.model ?? "demo-assistant",
          choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 256, completion_tokens: 42 },
        }),
      )
      return
    }

    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { message: `no route for ${request.url}` } }))
  })
})

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock OpenAI-compatible server on http://127.0.0.1:${port}/v1\n`)
  process.stdout.write(`script: ${scriptFile}\n`)
})
