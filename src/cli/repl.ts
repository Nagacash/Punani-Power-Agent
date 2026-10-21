import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { Writable } from "node:stream"
import { APP_TITLE, paths } from "../core/paths.js"
import { ConfigStore } from "../config/store.js"
import { ProviderRegistry } from "../provider/registry.js"
import { LlmClient } from "../llm/client.js"
import { buildTools } from "../tool/registry.js"
import { createSkillTools } from "../tool/skill.js"
import { defaultRoots, discoverSkills, groupSkills, renderGroupIndex, type Skill } from "../skills/loader.js"
import { buildRoutes, renderRoutes, type Route } from "../skills/routing.js"
import { searchSkills } from "../skills/search.js"
import { loadAlwaysOn, renderAlwaysOn } from "../agent/prompt.js"
import { McpRegistry } from "../mcp/registry.js"
import { KNOWN_MCP_SERVERS } from "../mcp/client.js"
import { PermissionEngine, resolvePermission } from "../agent/permission.js"
import { buildSystemPrompt, describeProject, runAgentTurn, type PromptParts } from "../agent/agent.js"
import { loadProjectInstructions } from "../agent/instructions.js"
import { createPlainStream, flushPlainStream, plainStream, plainText } from "../agent/plain.js"
import { SessionStore, type SessionMeta } from "../session/store.js"
import { messageText, type ChatMessage } from "../llm/client.js"
import type { ModelInfo } from "../provider/types.js"
import { modelKey } from "../provider/types.js"
import { diskMutate } from "../tool/fsutil.js"
import type { Tool, ToolContext } from "../tool/types.js"
import {
  assistantLine,
  banner,
  errorLine,
  infoLine,
  modelBanner,
  modelTable,
  successLine,
  toolLine,
  toolResultLine,
  userLine,
  warnLine,
} from "../ui/render.js"
import { interpretPermissionReply, renderDiff, renderPermissionRequest } from "../ui/prompt.js"
import { login as klingLogin, whoAmI as klingWhoAmI } from "../provider/kling.js"
import {
  listModels as elevenLabsModels,
  listVoices as elevenLabsVoices,
} from "../provider/elevenlabs.js"
import { style, symbol } from "../ui/theme.js"

/** Interactive prompt for a single line of input. */
export type Prompter = (question: string) => Promise<string>

/** Interactive prompt that does not echo what is typed. */
export type SecretPrompter = (question: string) => Promise<string>

/** Everything the REPL needs, assembled once at startup. */
export interface AppDeps {
  config: ConfigStore
  registry: ProviderRegistry
  sessions: SessionStore
  projectRoot: string
  ask: Prompter
  /** Same as ask, but does not echo what is typed. */
  askSecret?: SecretPrompter
  /**
   * True when the terminal already echoed what the user typed. The reply is
   * then not printed again, so it does not appear twice.
   */
  echoesInput?: boolean
  /** Mutable so /model can switch models mid-session. */
  state: { model: ModelInfo; providerName: string }
  /** An existing session to reopen, when the user asked to resume one. */
  resume?: { meta: SessionMeta; messages: ChatMessage[] }
  /** The skill library, filled in when the app starts. */
  skills?: Skill[]
  /** The parts of the system prompt that are not written in code. */
  promptParts?: PromptParts
}

export async function startApp(deps: AppDeps): Promise<void> {
  const { config, sessions, projectRoot, ask } = deps
  const permissions = new PermissionEngine(config.permissions())
  const session = deps.resume?.meta ?? sessions.create(projectRoot, deps.state.model.id, deps.state.model.providerID)
  const info = describeProject(projectRoot)

  banner(
    APP_TITLE,
    `${info.name}${info.branch ? ` (${info.branch}${info.dirty ? "*" : ""})` : ""} · session ${session.id.slice(4, 12)}`,
  )
  modelBanner(deps.state.model, deps.state.providerName)
  infoLine(`project ${projectRoot}`)
  infoLine(`config ${config.path}`)
  if (deps.resume) {
    infoLine(`resumed ${deps.resume.messages.length} earlier messages`)
  }
  infoLine("Type /help for commands, /exit to quit.")

  const messages: ChatMessage[] = [...(deps.resume?.messages ?? [])]
  const imageSettings = config.imageSettings()
  const audioSettings = config.audioSettings()
  const instructions = loadProjectInstructions(projectRoot)
  if (instructions.files.length > 0) {
    infoLine(`following ${instructions.files.join(", ")}`)
  }

  // Skills: a table of contents, not a wall of descriptions.
  const skillRoots = defaultRoots(projectRoot)
  const skills = discoverSkills(skillRoots)
  const groups = groupSkills(skills)
  const catalog = renderGroupIndex(groups)
  deps.skills = skills
  if (groups.length > 0) {
    infoLine(`${skills.length} skill(s) in ${groups.length} group(s) available`)
  }

  // The always-on surface: rules, guidance and memory, kept in files.
  const alwaysOn = loadAlwaysOn(projectRoot)
  if (alwaysOn.files.length > 0) {
    infoLine(`always on: ${alwaysOn.files.map((file) => file.name).join(", ")}`)
  }

  // The routing table: which skill answers which situation.
  const routes = buildRoutes(projectRoot, skills)
  const routeTable = renderRoutes(routes)
  if (routes.length > 0) {
    infoLine(`${routes.length} route(s) in the skill table`)
  }

  // The prompt, apart from the rules that are written in code.
  deps.promptParts = {
    catalog,
    instructions: instructions.text,
    routes: routeTable,
    alwaysOn: renderAlwaysOn(alwaysOn),
  }

  // Start the MCP servers and fold their tools into the agent's tool set.
  const mcp = new McpRegistry(config.mcpServers())
  const mcpTools = await mcp.start()
  for (const problem of mcp.problems) warnLine(`mcp: ${problem}`)
  if (mcpTools.length > 0) {
    infoLine(`${mcpTools.length} tool(s) from ${mcp.connected.length} MCP server(s)`)
  }
  const tools = [...buildTools(imageSettings, audioSettings, mcpTools), ...createSkillTools(groups, skills)]

  while (true) {
    let line: string
    try {
      line = await ask(`${style.green("›")} `)
    } catch {
      break
    }
    const input = line.trim()
    if (input === "") continue

    if (input.startsWith("/")) {
      const handled = await handleCommand(input, deps, session, messages, permissions, catalog, skills, routes)
      if (handled === "exit") break
      continue
    }

    if (!deps.echoesInput) {
      userLine(input)
    }
    sessions.append(session, { role: "user", content: input, timestamp: Date.now() })
    messages.push({ role: "user", content: input })

    await runTurn(deps, session, messages, permissions, tools)
  }

  infoLine("bye")
}

/** Run one agent turn and record the result in the session. */
async function runTurn(
  deps: AppDeps,
  session: SessionMeta,
  messages: ChatMessage[],
  permissions: PermissionEngine,
  tools: Tool[],
): Promise<void> {
  const { registry, projectRoot, ask, sessions } = deps
  const model = deps.state.model

  const provider = registry.providers().find((entry) => entry.id === model.providerID)
  if (!provider) {
    errorLine(`provider "${model.providerID}" is no longer configured. Use /models to pick another.`)
    return
  }
  const { key } = registry.keyFor(provider)
  if (!key && !provider.anonymous) {
    errorLine(`no API key for provider "${provider.id}". Use /provider ${provider.id} key <value>.`)
    return
  }

  const client = new LlmClient({
    baseURL: provider.baseURL,
    apiKey: key,
    providerID: provider.id,
    headers: deps.config.headers(provider.id),
  })

  const context: ToolContext = {
    projectRoot,
    allowedReadDirs: defaultRoots(projectRoot).map((root) => root.path),
    requestPermission: (request) =>
      resolvePermission(permissions, request, async (pending) => {
        renderPermissionRequest(pending)
        const reply = await ask(`${style.yellow("?")} `)
        stdout.write("\n")
        return interpretPermissionReply(reply, pending)
      }),
    notify: (message) => infoLine(message),
    previewDiff: (file, before, after) => renderDiff(file, before, after),
    setPreview: (url) => infoLine(`preview: ${url}`),
    mutate: diskMutate,
  }

  const system = buildSystemPrompt(
    projectRoot,
    {
      image: deps.config.imageSettings().provider !== "none",
      audio: deps.config.audioSettings().provider !== "none",
      vision: model.vision,
    },
    deps.promptParts ?? {},
  )
  const withSystem: ChatMessage[] = [{ role: "system", content: system }, ...messages]

  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.once("SIGINT", onSigint)

  const result = await runAgentTurn(
    {
      client,
      model,
      tools,
      projectRoot,
      context,
      skills: deps.skills,
      signal: controller.signal,
      onEvent: onEvent,
    },
    withSystem,
  )
  process.off("SIGINT", onSigint)

  if (result.error) {
    await reportError(result.error, deps, model)
  } else if (result.stoppedReason === "max_steps") {
    warnLine(`stopped after ${40} tool steps to stay within budget`)
  }

  // Persist the assistant side of the conversation, minus the system prompt.
  for (const message of result.messages) {
    if (message.role === "system") continue
    if (message.role === "assistant") {
      const text = messageText(message)
      const calls = message.toolCalls ?? []
      if (!text.trim() && calls.length === 0) continue
      sessions.append(session, {
        role: "assistant",
        content: text,
        toolCalls: calls.length
          ? calls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }))
          : undefined,
        model: model.id,
        provider: model.providerID,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        cost: result.usage.cost,
        timestamp: Date.now(),
      })
    } else if (message.role === "tool") {
      sessions.append(session, {
        role: "tool",
        content: messageText(message),
        tool: message.name,
        toolCallId: message.toolCallId,
        timestamp: Date.now(),
      })
    }
  }

  // Replace the in-memory history with what the provider expects next time.
  messages.length = 0
  messages.push(...result.messages.filter((message) => message.role !== "system"))
}

let assistantStreaming = false
let reasoningOpen = false
let reasoningAtLineStart = false
let reasoningLines = 0
let reply = createPlainStream()

/** How many lines of thinking are worth the screen. */
const THINKING_LINES = 12

function endAssistantStream(): void {
  if (assistantStreaming) {
    const rest = flushPlainStream(reply)
    if (rest) process.stdout.write(rest)
    process.stdout.write("\n")
    assistantStreaming = false
  }
}

/** Close the thinking block, so the answer starts on a line of its own. */
function endReasoning(): void {
  if (reasoningOpen) {
    process.stdout.write("\n")
    reasoningOpen = false
  }
}

/**
 * Write a piece of the model's thinking.
 *
 * The pieces arrive in whatever order the model wrote them, so the indent
 * belongs to the line, not to the piece. Indenting per piece would put spaces
 * in the middle of a sentence.
 */
function writeReasoning(text: string): void {
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      process.stdout.write("\n")
      reasoningAtLineStart = true
    }
    const line = lines[index]!
    if (line === "") continue
    // A long train of thought is noise. The plan is in the first lines; the
    // rest is the model working it out.
    if (reasoningLines >= THINKING_LINES) {
      if (reasoningLines === THINKING_LINES) {
        process.stdout.write(`\n${style.gray("    … thinking continues")}\n`)
        reasoningLines++
      }
      return
    }
    if (reasoningAtLineStart) process.stdout.write("    ")
    process.stdout.write(style.gray(line))
    reasoningAtLineStart = false
    reasoningLines++
  }
}

function onEvent(event: import("../agent/agent.js").AgentEvent): void {
  switch (event.type) {
    case "assistant_text":
      if (event.partial && event.text) {
        if (!assistantStreaming) {
          endReasoning()
          reply = createPlainStream()
          process.stdout.write(`\n${style.blue(symbol.arrow)} `)
          assistantStreaming = true
        }
        process.stdout.write(plainStream(event.text, reply))
      } else if (event.text) {
        endReasoning()
        endAssistantStream()
        assistantLine(plainText(event.text))
      }
      break
    case "reasoning":
      if (event.text) {
        if (!reasoningOpen) {
          endAssistantStream()
          process.stdout.write(`\n${style.gray("  thinking")}\n`)
          reasoningOpen = true
          reasoningAtLineStart = true
          reasoningLines = 0
        }
        writeReasoning(event.text)
      }
      break
    case "tool_start":
      endReasoning()
      endAssistantStream()
      toolLine(event.tool ?? "?", event.args)
      break
    case "tool_end":
      if (event.result) toolResultLine(event.result.output, event.result.isError === true)
      break
    case "notice":
      if (event.text) warnLine(event.text)
      break
    case "error":
      break
    default:
      break
  }
}

/** Explain a provider failure and point at other models that could work. */
async function reportError(error: import("../llm/errors.js").LlmError, deps: AppDeps, model: ModelInfo): Promise<void> {
  errorLine(`${error.title}: ${error.message}`)
  process.stdout.write(`  ${style.gray(error.remedy)}\n`)
  if (error.detail) {
    process.stdout.write(`  ${style.gray(truncateForDetail(error.detail))}\n`)
  }
  if (error.hint) {
    process.stdout.write(`  ${style.gold(error.hint)}\n`)
  }
  const alternatives = await deps.registry.alternatives(model)
  if (alternatives.length > 0) {
    process.stdout.write(`  ${style.gray("try instead:")}\n`)
    for (const alternative of alternatives) {
      const key = modelKey(alternative)
      const price =
        alternative.cost.input === 0 && alternative.cost.output === 0
          ? style.green("free")
          : style.gray(`$${alternative.cost.input}/$${alternative.cost.output} per 1M`)
      process.stdout.write(
        `    ${style.cyan(key)} ${style.gray(`· ${alternative.name}`)} ${price}` +
          `${alternative.toolSupport ? "" : style.yellow(" (no tool support)")}\n`,
      )
    }
    process.stdout.write(`  ${style.gray("switch with:")} ${style.cyan("/model " + modelKey(alternatives[0]!))}\n`)
  }
}

function truncateForDetail(detail: string): string {
  return detail.length > 300 ? `${detail.slice(0, 300)}…` : detail
}

function rest0(argument: string): string[] {
  return argument.split(/\s+/).filter(Boolean)
}

/** Handle a slash command. Returns "exit" to quit. */
async function handleCommand(
  input: string,
  deps: AppDeps,
  session: SessionMeta,
  messages: ChatMessage[],
  permissions: PermissionEngine,
  catalog: string,
  skills: Skill[],
  routes: Route[],
): Promise<"exit" | "handled"> {
  const [command, ...rest] = input.slice(1).split(/\s+/)
  const argument = rest.join(" ")
  const { config, registry, sessions, ask, askSecret } = deps

  switch (command) {
    case "help":
    case "?":
      printHelp()
      return "handled"

    case "exit":
    case "quit":
      return "exit"

    case "models": {
      // "free" filters to zero-cost models; a provider id narrows to one
      // provider; anything else is a substring match on the model.
      const args = argument.split(/\s+/).filter(Boolean)
      let onlyFree = false
      let target: string | undefined
      let substring = ""
      for (const arg of args) {
        if (arg === "free") {
          onlyFree = true
          continue
        }
        const isProvider = registry.providers().some((entry) => entry.id === arg)
        if (isProvider && !target) {
          target = arg
          continue
        }
        substring = substring ? `${substring} ${arg}` : arg
      }

      const providers = target
        ? registry.providers().filter((entry) => entry.id === target)
        : registry.providers()

      const collected: ModelInfo[] = []
      let unavailable = 0
      for (const entry of providers) {
        const { models, error } = await registry.models(entry, true)
        if (error) {
          if (target) warnLine(`${entry.name}: ${error}`)
          continue
        }
        unavailable += models.filter((model) => model.status !== "active").length
        let list = models
        if (onlyFree) list = list.filter((model) => model.cost.input === 0 && model.cost.output === 0)
        if (substring) {
          const needle = substring.toLowerCase()
          list = list.filter(
            (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
          )
        }
        collected.push(...list)
      }
      modelTable(collected, (id) => registry.providers().find((entry) => entry.id === id)?.name ?? id)
      if (collected.length === 0) {
        infoLine("No matching models. Try /models free, or /provider to check your keys.")
      } else if (unavailable > 0) {
        infoLine(`${unavailable} more model(s) in the catalog are currently unavailable`)
      }
      return "handled"
    }

    case "model": {
      if (!argument) {
        const current = config.get().defaultModel
        infoLine(`current default: ${current ?? "(none set)"}`)
        infoLine("set one with: /model <provider>/<model>")
        return "handled"
      }
      const found = await registry.findModel(argument)
      if (!found) {
        errorLine(`model "${argument}" not found. Use /models to list what is available.`)
        return "handled"
      }
      if (!found.toolSupport) {
        warnLine(`${found.name} has no tool support, so it cannot drive the agent.`)
      }
      config.setDefaultModel(argument)
      // Switch the live model for the rest of the session.
      deps.state.model = found
      deps.state.providerName = registry.providers().find((entry) => entry.id === found.providerID)?.name ?? found.providerID
      modelBanner(found, deps.state.providerName)
      successLine(`default model set to ${argument}`)
      return "handled"
    }

    case "provider": {
      const [sub, ...tail] = rest
      const value = tail.join(" ")
      if (!sub) {
        for (const status of await registry.status()) {
          const key = status.hasKey
            ? style.green("key ✔")
            : status.provider.anonymous
              ? style.cyan("local")
              : style.yellow("key ✖")
          const count = style.gray(`${status.models.length} models`)
          process.stdout.write(
            `  ${style.bold(status.provider.id.padEnd(16))} ${status.provider.name.padEnd(18)} ${key} ${count} ` +
              `${style.gray(status.provider.baseURL)}\n`,
          )
        }
        return "handled"
      }
      if (sub === "key") {
        const [providerId, key] = value.split(/\s+/, 2)
        if (!providerId) {
          errorLine("usage: /provider <id> key <value>")
          return "handled"
        }
        const provider = registry.provider(providerId)
        if (!provider) {
          errorLine(`unknown provider "${providerId}". Use /provider to list them.`)
          return "handled"
        }
        if (!key) {
          const existing = config.apiKey(provider)
          if (existing.key) {
            successLine(`a key is already stored for ${providerId} (from ${existing.source}).`)
          } else {
            infoLine(`no key stored for ${providerId}.`)
          }
          return "handled"
        }
        config.setApiKey(providerId, key)
        successLine(`key stored for ${providerId} in ${config.path} (mode 0600)`)
        return "handled"
      }
      if (sub === "url") {
        const [providerId, url] = value.split(/\s+/, 2)
        if (!providerId || !url) {
          errorLine("usage: /provider <id> url <base-url>")
          return "handled"
        }
        const provider = registry.provider(providerId)
        if (!provider) {
          errorLine(`unknown provider "${providerId}".`)
          return "handled"
        }
        registry.config.setProvider({ ...provider, baseURL: url.replace(/\/+$/, "") })
        successLine(`${providerId} baseURL set to ${url}`)
        return "handled"
      }
      if (sub === "add") {
        const [providerId, baseURL] = value.split(/\s+/, 2)
        if (!providerId || !baseURL) {
          errorLine("usage: /provider add <id> <base-url>")
          return "handled"
        }
        registry.config.setProvider({
          id: providerId,
          kind: "openai-compatible",
          name: providerId,
          baseURL: baseURL.replace(/\/+$/, ""),
          env: `${providerId.toUpperCase().replace(/-/g, "_")}_API_KEY`,
          defaultContextWindow: 32_768,
        })
        successLine(`provider "${providerId}" added. Add a key with /provider ${providerId} key <value>`)
        return "handled"
      }
      errorLine("usage: /provider [key <value> | url <url> | add <id> <url> | <id> key <value>]")
      return "handled"
    }

    case "audio": {
      const current = config.audioSettings()
      const [kind, ...rest] = rest0(argument)
      if (!kind) {
        infoLine(`provider: ${current.provider}`)
        if (current.voiceName) infoLine(`voice:    ${current.voiceName} (${current.voiceId})`)
        if (current.model) infoLine(`model:    ${current.model}`)
        if (current.outputFormat) infoLine(`format:   ${current.outputFormat}`)
        infoLine("set it up with: /audio key <elevenlabs-key> then /audio voice")
        return "handled"
      }
      if (kind === "off" || kind === "none") {
        config.setAudioSettings({ ...current, provider: "none" })
        successLine("speech generation is off")
        return "handled"
      }
      if (kind === "key") {
        const value = rest.length
          ? rest.join(" ")
          : (await (askSecret ?? ask)(`${style.green("›")} ElevenLabs API key (not shown): `)).trim()
        if (!value) {
          infoLine("no key entered")
          return "handled"
        }
        config.setAudioSettings({ ...current, provider: "elevenlabs", apiKey: value })
        successLine("key stored in " + config.path + " (mode 0600)")
        // Show the voices so the next step is obvious.
        let voices = [] as Awaited<ReturnType<typeof elevenLabsVoices>>
        try {
          voices = await elevenLabsVoices(value)
        } catch (error) {
          warnLine((error as Error).message)
          voices = await elevenLabsVoices(undefined).catch(() => [])
        }
        if (voices.length > 0) {
          process.stdout.write(`\n  ${style.bold("Voices")} ${style.gray(`(${voices.length} available)`)}\n`)
          voices.slice(0, 12).forEach((voice, index) => {
            process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${voice.name}\n`)
          })
          infoLine("pick one with: /audio voice <number or id>")
        }
        return "handled"
      }
      if (kind === "voice") {
        const voices = await elevenLabsVoices(current.apiKey).catch(async (error) => {
          warnLine((error as Error).message)
          return elevenLabsVoices(undefined).catch(() => [])
        })
        if (voices.length === 0) {
          errorLine("no voices were returned. Set a key first: /audio key <value>")
          return "handled"
        }
        if (!rest.length) {
          process.stdout.write(`\n  ${style.bold("Voices")} ${style.gray(`(${voices.length} available)`)}\n`)
          voices.slice(0, 20).forEach((voice, index) => {
            const mark = voice.voiceId === current.voiceId ? style.green(" ← current") : ""
            process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${voice.name}${mark}\n`)
          })
          infoLine("pick one with: /audio voice <number or id>")
          return "handled"
        }
        const index = Number(rest[0])
        const voice = Number.isInteger(index) && index > 0 ? voices[index - 1] : voices.find((v) => v.voiceId === rest[0])
        if (!voice) {
          errorLine("that voice was not found")
          return "handled"
        }
        config.setAudioSettings({ ...current, provider: "elevenlabs", voiceId: voice.voiceId, voiceName: voice.name })
        successLine(`voice set to ${voice.name}`)
        return "handled"
      }
      if (kind === "model") {
        const models = await elevenLabsModels(current.apiKey)
        if (!rest.length) {
          process.stdout.write(`\n  ${style.bold("Text to speech models")}\n`)
          models.forEach((model, index) => {
            const mark = model.id === current.model ? style.green(" ← current") : ""
            process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${model.id}${mark}\n`)
          })
          infoLine("pick one with: /audio model <number or id>")
          return "handled"
        }
        const index = Number(rest[0])
        const model = Number.isInteger(index) && index > 0 ? models[index - 1] : models.find((m) => m.id === rest[0])
        if (!model) {
          errorLine("that model was not found")
          return "handled"
        }
        config.setAudioSettings({ ...current, provider: "elevenlabs", model: model.id })
        successLine(`model set to ${model.id}`)
        return "handled"
      }
      if (kind === "format") {
        const format = rest[0] ?? "mp3_44100_128"
        config.setAudioSettings({ ...current, outputFormat: format })
        successLine(`output format set to ${format}`)
        return "handled"
      }
      errorLine("usage: /audio [key <value> | voice <n> | model <n> | format <fmt> | off]")
      return "handled"
    }

    case "skill": {
      // The picker: search the library, or show the routing table.
      const [action, ...rest] = rest0(argument)
      if (!action) {
        infoLine(`${skills.length} skill(s) available`)
        infoLine("find one: /skill <words>")
        infoLine("the routing table: /skill routes")
        infoLine("read one: /skill load <name>")
        return "handled"
      }
      if (action === "routes") {
        if (routes.length === 0) {
          infoLine("no routes. Add one to .punani/routes.md:")
          infoLine("  when: the user wants a security review -> naga-review")
          return "handled"
        }
        let source = ""
        for (const route of routes) {
          if (route.source !== source) {
            source = route.source
            process.stdout.write(`\n  ${style.gray(source === "skill" ? "from the skills themselves" : source)}\n`)
          }
          process.stdout.write(
            `    ${style.gold("when")} ${route.when} ${style.gray("->")} ${style.cyan(route.skill)}\n`,
          )
        }
        return "handled"
      }
      if (action === "load") {
        const name = rest.join(" ").trim().toLowerCase()
        const skill = skills.find((entry) => entry.name === name)
        if (!skill) {
          errorLine(`no skill called "${name}". Use /skill <words> to find one.`)
          return "handled"
        }
        process.stdout.write(`\n${style.gray(skill.file)}\n\n`)
        process.stdout.write(`${style.bold(skill.title)}\n${skill.description}\n\n`)
        return "handled"
      }
      const found = searchSkills(skills, action, 10)
      if (found.length === 0) {
        infoLine(`no skill matched "${action}"`)
        return "handled"
      }
      for (const skill of found) {
        const triggers = skill.triggers.length > 0 ? style.gray(` [${skill.triggers[0]}]`) : ""
        process.stdout.write(
          `  ${style.cyan(skill.name.padEnd(34))} ${style.gray(skill.description.slice(0, 90))}${triggers}\n`,
        )
      }
      infoLine("read one with: /skill load <name>")
      return "handled"
    }

    case "skills": {
      const all = discoverSkills(defaultRoots(deps.projectRoot))
      const byGroup = groupSkills(all)
      if (all.length === 0) {
        infoLine("no skills found")
        infoLine("looked in: " + defaultRoots(deps.projectRoot).map((root) => root.path).join(", "))
        return "handled"
      }
      infoLine(`${all.length} skill(s) in ${byGroup.length} group(s)`)
      for (const group of byGroup) {
        process.stdout.write(
          `  ${style.bold(group.id.padEnd(30))} ${style.gray(`${group.count} skill(s)`)}\n`,
        )
      }
      return "handled"
    }

    case "mcp": {
      const servers = config.mcpServers()
      const [action, ...rest] = rest0(argument)
      if (!action) {
        if (servers.length === 0) {
          infoLine("no MCP servers configured")
          infoLine("add one with: /mcp add <name> [path]")
          infoLine("known servers: " + Object.keys(KNOWN_MCP_SERVERS).join(", "))
          return "handled"
        }
        for (const server of servers) {
          const mark = server.enabled === false ? style.yellow("off") : style.green("on")
          const args = (server.args ?? []).join(" ")
          process.stdout.write(
            `  ${style.bold(server.name.padEnd(14))} ${mark}  ${style.gray(server.command + " " + args)}\n`,
          )
        }
        infoLine("remove with: /mcp remove <name>")
        return "handled"
      }
      if (action === "remove" || action === "rm") {
        const name = rest[0]
        const kept = servers.filter((server) => server.name !== name)
        if (kept.length === servers.length) {
          errorLine(`no MCP server called "${name}"`)
          return "handled"
        }
        config.setMcpServers(kept)
        successLine(`removed the ${name} server. Restart to apply.`)
        return "handled"
      }
      if (action === "add") {
        const name = rest[0]
        if (!name) {
          errorLine("usage: /mcp add <name> [path]")
          return "handled"
        }
        const known = KNOWN_MCP_SERVERS[name]
        if (known) {
          const args = [...(known.args ?? [])]
          // The filesystem server takes the folder it is allowed to touch.
          if (name === "filesystem" && rest[1]) args.push(rest[1])
          const env = { ...(known.env ?? {}) }
          if (name === "github") {
            const token = await (askSecret ?? ask)(`${style.green("›")} GitHub token (not shown, blank to skip): `)
            if (token.trim()) env.GITHUB_PERSONAL_ACCESS_TOKEN = token.trim()
          }
          config.setMcpServers([
            ...servers.filter((server) => server.name !== name),
            { name, command: known.command, args, env, enabled: true },
          ])
          successLine(`added the ${name} server: ${known.command} ${args.join(" ")}`)
          infoLine(known.note)
          infoLine("restart to connect it")
          return "handled"
        }
        // Not a known server: ask for the command.
        const command = (await ask(`${style.green("›")} command to run for ${name}: `)).trim()
        if (!command) {
          errorLine("no command given")
          return "handled"
        }
        const [bin, ...args] = command.split(/\s+/)
        if (!bin) {
          errorLine("no command given")
          return "handled"
        }
        config.setMcpServers([
          ...servers.filter((server) => server.name !== name),
          { name, command: bin, args, enabled: true },
        ])
        successLine(`added the ${name} server. Restart to connect it.`)
        return "handled"
      }
      errorLine("usage: /mcp [add <name> [path] | remove <name>]")
      return "handled"
    }

    case "keys": {
      const [providerId, action] = rest
      if (!providerId) {
        for (const provider of config.providers()) {
          const { key, source } = config.apiKey(provider)
          const mark = key
            ? style.green(`key ✔ (${source})`)
            : provider.anonymous
              ? style.cyan("local, no key needed")
              : style.yellow("no key")
          process.stdout.write(
            `  ${style.bold(provider.id.padEnd(16))} ${provider.name.padEnd(18)} ${mark}\n`,
          )
        }
        infoLine("set one with: /keys <provider>")
        infoLine("remove with:  /keys <provider> clear")
        return "handled"
      }
      const provider = config.provider(providerId)
      if (!provider) {
        errorLine(`unknown provider "${providerId}". Use /keys to list them.`)
        return "handled"
      }
      if (action === "clear" || action === "remove") {
        config.clearApiKey(providerId)
        successLine(`key for ${providerId} removed`)
        return "handled"
      }
      let value: string
      if (action) {
        // Given on the command line. It will be visible in the scrollback.
        value = rest.join(" ")
      } else {
        // Typed at the prompt, so it never appears on screen.
        value = await (askSecret ?? ask)(`${style.green("›")} API key for ${providerId} (not shown): `)
      }
      value = value.trim()
      if (!value) {
        infoLine("no key entered")
        return "handled"
      }
      config.setApiKey(providerId, value)
      successLine(`key for ${providerId} stored in ${config.path} (mode 0600)`)
      return "handled"
    }

    case "image": {
      const current = config.imageSettings()
      if (!argument) {
        infoLine(`provider: ${current.provider}`)
        if (current.model) infoLine(`model:    ${current.model}`)
        if (current.baseURL) infoLine(`baseURL:  ${current.baseURL}`)
        if (current.outputDir) infoLine(`output:   ${current.outputDir}`)
        infoLine("set one with: /image kling [model] | /image openai <base-url> [key] | /image off")
        return "handled"
      }
      const [kind, ...rest] = rest0(argument)
      if (kind === "off" || kind === "none") {
        config.setImageSettings({ provider: "none" })
        successLine("image generation is off")
        return "handled"
      }
      if (kind === "kling") {
        const identity = await klingWhoAmI()
        if (!identity.loggedIn) {
          warnLine(identity.error ?? "not signed in to Kling")
          const go = (await ask(`${style.green("›")} sign in to Kling now? (y/n) `)).trim().toLowerCase()
          if (go !== "y" && go !== "yes") {
            infoLine("run `kling login` yourself, then: /image kling <model>")
            return "handled"
          }
          infoLine("a browser window will open for the Kling sign-in.")
          const result = await klingLogin()
          if (!result.ok) {
            errorLine("the Kling sign-in did not complete. Run `kling login` and try again.")
            return "handled"
          }
          successLine("signed in to Kling")
        }
        const identityAfter = identity.loggedIn ? identity : await klingWhoAmI()
        const models = identityAfter.imageModels.length ? identityAfter.imageModels : identityAfter.models
        if (models.length > 0) {
          process.stdout.write(`\n  ${style.bold("Kling models")}\n`)
          models.slice(0, 15).forEach((model, index) => {
            process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${model}\n`)
          })
        }
        const chosen = rest[0] ?? (models.length === 1 ? models[0] : undefined)
        if (!chosen) {
          const picked = (await ask(`${style.green("›")} model number or name (blank to skip): `)).trim()
          const index = Number(picked)
          const model = Number.isInteger(index) && index > 0 ? models[index - 1] : picked || undefined
          if (!model) {
            config.setImageSettings({ ...current, provider: "kling" })
            successLine("images will be generated with the kling CLI")
            infoLine("pick a model later with: /image kling <model>")
            return "handled"
          }
          config.setImageSettings({ ...current, provider: "kling", model })
          successLine(`images will be generated with kling using ${model}`)
          return "handled"
        }
        config.setImageSettings({ ...current, provider: "kling", model: chosen })
        successLine(`images will be generated with kling using ${chosen}`)
        return "handled"
      }
      if (kind === "openai" || kind === "openai-compatible") {
        const [baseURL, key] = rest
        if (!baseURL) {
          errorLine("usage: /image openai <base-url> [api-key]")
          return "handled"
        }
        config.setImageSettings({
          ...current,
          provider: "openai-compatible",
          baseURL: baseURL.replace(/\/+$/, ""),
          apiKey: key ?? current.apiKey,
        })
        successLine(`images will be generated through ${baseURL}`)
        return "handled"
      }
      errorLine("usage: /image [kling [model] | openai <base-url> [key] | off]")
      return "handled"
    }

    case "permissions": {
      if (!argument) {
        for (const action of ["read", "search", "write", "edit", "bash"]) {
          const rules = permissions.effectiveRules(action)
          process.stdout.write(
            `  ${style.bold(action.padEnd(8))} ${rules.map((rule) => `${rule.pattern}=${rule.effect}`).join("  ")}\n`,
          )
        }
        infoLine("change with: /permissions <action> <pattern> <allow|ask|deny>")
        return "handled"
      }
      const [action, pattern, effect] = argument.split(/\s+/)
      if (!action || !pattern || !effect) {
        errorLine("usage: /permissions <action> <pattern> <allow|ask|deny>")
        return "handled"
      }
      if (!["allow", "ask", "deny"].includes(effect)) {
        errorLine("effect must be allow, ask or deny")
        return "handled"
      }
      const current = config.permissions()
      const list = current[action] ?? []
      const existing = list.findIndex((rule) => rule.pattern === pattern)
      if (existing >= 0) list[existing] = { pattern, effect: effect as any }
      else list.push({ pattern, effect: effect as any })
      current[action] = list
      config.setPermissions(current)
      successLine(`${action}: ${pattern} -> ${effect}`)
      return "handled"
    }

    case "history": {
      const stored = sessions.list().slice(0, 15)
      if (stored.length === 0) {
        infoLine("no previous sessions")
        return "handled"
      }
      for (const entry of stored) {
        const when = new Date(entry.updated).toLocaleString()
        process.stdout.write(`  ${style.cyan(entry.id)} ${style.white(entry.title.padEnd(40).slice(0, 40))} ${style.gray(when)}\n`)
      }
      infoLine("resume with: punani resume <id>")
      return "handled"
    }

    case "session": {
      infoLine(`session id: ${session.id}`)
      infoLine(`messages: ${session.messageCount}`)
      infoLine(`project: ${session.projectRoot}`)
      return "handled"
    }

    case "clear": {
      messages.length = 0
      successLine("conversation cleared")
      return "handled"
    }

    case "context": {
      const model = deps.state.model
      const system = buildSystemPrompt(
        deps.projectRoot,
        {
          image: deps.config.imageSettings().provider !== "none",
          audio: deps.config.audioSettings().provider !== "none",
          vision: model.vision,
        },
        deps.promptParts ?? { catalog },
      )
      process.stdout.write(`${style.gray(system)}\n`)
      return "handled"
    }

    case "config": {
      const state = config.permissionsSafe()
      infoLine(`config file: ${config.path}`)
      infoLine(`permissions: ${state.mode ?? "(missing)"} ${state.ok ? style.green("owner-only ✔") : style.yellow("readable by others!")}`)
      infoLine(`data dir: ${paths.dataDir}`)
      return "handled"
    }

    default:
      errorLine(`unknown command "/${command}". Type /help for the list.`)
      return "handled"
  }
}

function printHelp(): void {
  const commands: [string, string][] = [
    ["/help", "show this list"],
    ["/models [filter]", "list models, optionally filtered by a provider or substring"],
    ["/model <provider/model>", "set the default model"],
    ["/provider", "list providers and whether a key is stored"],
    ["/provider <id> key <value>", "store an API key locally (mode 0600)"],
    ["/provider <id> url <url>", "point a provider at a different base URL"],
    ["/provider add <id> <url>", "add an OpenAI-compatible provider"],
    ["/permissions <action> <pattern> <effect>", "set allow | ask | deny for an action"],
    ["/history", "list previous sessions"],
    ["/session", "show the current session"],
    ["/clear", "clear the conversation"],
    ["/context", "show the system prompt"],
    ["/config", "show config paths and permissions"],
    ["/image", "configure image generation (kling or an OpenAI-compatible endpoint)"],
    ["/keys", "store or remove an API key, without typing it on screen"],
    ["/mcp", "add, list or remove MCP servers"],
    ["/skills", "list the skills available to the agent"],
    ["/skill <words>", "find a skill, or read one with /skill load <name>"],
    ["/audio", "configure speech generation with ElevenLabs"],
    ["/exit", "quit"],
  ]
  process.stdout.write("\n")
  for (const [name, description] of commands) {
    process.stdout.write(`  ${style.cyan(name.padEnd(38))} ${style.gray(description)}\n`)
  }
  process.stdout.write("\n")
}

/**
 * Build a readline-based prompter bound to stdin/stdout.
 *
 * `rl.question()` only captures one line. When input is piped, the remaining
 * lines arrive as `line` events with no question pending and are lost. This
 * prompter buffers them instead, so a scripted session works the same as an
 * interactive one.
 */
export function createPrompter(): { ask: Prompter; askSecret: SecretPrompter; close: () => void; echoesInput: boolean } {
  const echoesInput = stdin.isTTY === true
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: echoesInput })
  const queue: string[] = []
  let pending: ((line: string) => void) | undefined

  rl.on("line", (line) => {
    if (pending) {
      const resolve = pending
      pending = undefined
      resolve(line)
      return
    }
    queue.push(line)
  })

  rl.on("SIGINT", () => {
    stdout.write("^C\n")
    if (pending) {
      const resolve = pending
      pending = undefined
      resolve("")
    }
  })

  // readline's promise interface does not expose the output stream, but the
  // underlying interface does. Keep our own handle on it so a secret can be
  // read without echoing.
  const io = rl as unknown as { output: Writable }

  const read = async (question: string, secret: boolean): Promise<string> => {
    if (secret) {
      // Swallow the echo while the line is being typed.
      const real = io.output
      const muted = new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      })
      io.output = muted
      stdout.write(question)
      try {
        const answer = await new Promise<string>((resolve) => {
          pending = resolve
        })
        return answer
      } finally {
        io.output = real
        stdout.write("\n")
      }
    }
    stdout.write(question)
    const buffered = queue.shift()
    if (buffered !== undefined) return buffered
    return await new Promise<string>((resolve) => {
      pending = resolve
    })
  }

  return {
    ask: async (question: string) => read(question, false),
    askSecret: async (question: string) => read(question, true),
    close: () => rl.close(),
    echoesInput,
  }
}
