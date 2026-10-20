import fs from "node:fs"
import path from "node:path"
import { APP_TITLE, paths } from "./core/paths.js"
import { log } from "./core/logger.js"
import { redactError } from "./core/redact.js"
import { ConfigStore } from "./config/store.js"
import { ProviderRegistry } from "./provider/registry.js"
import { SessionStore, toChatMessages, type SessionMeta } from "./session/store.js"
import { startApp, createPrompter, type AppDeps, type Prompter, type SecretPrompter } from "./cli/repl.js"
import { errorLine, infoLine, successLine, warnLine } from "./ui/render.js"
import { style } from "./ui/theme.js"
import type { ModelInfo } from "./provider/types.js"
import type { ChatMessage } from "./llm/client.js"

interface CliOptions {
  project?: string
  resume?: string
  model?: string
  provider?: string
  listModels?: boolean
  freeOnly?: boolean
  listProviders?: boolean
  init?: boolean
  web?: boolean
  port?: number
  host?: string
  open?: boolean
  preview?: boolean
  json?: boolean
  token?: string
  spawned?: boolean
  taskLabel?: string
  help?: boolean
  version?: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {}
  // `punani web` is what the docs and landing page say; treat it like --web.
  if (argv[0] === "web") {
    options.web = true
    argv = argv.slice(1)
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case "-h":
      case "--help":
        options.help = true
        break
      case "-v":
      case "--version":
        options.version = true
        break
      case "-m":
      case "--model":
        options.model = argv[++i]
        break
      case "-p":
      case "--provider":
        options.provider = argv[++i]
        break
      case "-C":
      case "--project":
        options.project = argv[++i]
        break
      case "-r":
      case "--resume":
        options.resume = argv[++i]
        break
      case "--models":
        options.listModels = true
        break
      case "--free":
        options.freeOnly = true
        break
      case "--providers":
        options.listProviders = true
        break
      case "--init":
        options.init = true
        break
      case "--web":
        options.web = true
        break
      case "--port":
        options.port = Number(argv[++i])
        break
      case "--host":
        options.host = argv[++i]
        break
      case "--open":
        options.open = true
        break
      case "--preview":
        options.preview = true
        break
      case "--json":
        options.json = true
        break
      case "--token":
        options.token = argv[++i]
        break
      case "--spawned":
        options.spawned = true
        break
      case "--task-label":
        options.taskLabel = argv[++i]
        break
      default:
        if (arg.startsWith("-")) {
          warnLine(`unknown flag ${arg}`)
        } else if (!options.project) {
          // `punani /path/to/project` without -C
          options.project = arg
        } else {
          warnLine(`unknown argument ${arg}`)
        }
    }
  }
  return options
}

/**
 * Every mounted volume, so the folder browser can offer an external drive
 * without the user having to type its path.
 */
function mountedVolumes(): string[] {
  const volumes = "/Volumes"
  try {
    return fs
      .readdirSync(volumes, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => path.join(volumes, entry.name))
      .filter((dir) => {
        try {
          return fs.statSync(dir).isDirectory()
        } catch {
          return false
        }
      })
  } catch {
    return []
  }
}

function printHelp(): void {
  process.stdout.write(`
${style.bold(APP_TITLE)}

  ${style.cyan("punani")} [options] [project-dir]
  ${style.cyan("punani web")} [--open] [options]   ${style.gray("same as --web")}

Options:
  -C, --project <dir>    project directory to open (default: current directory)
  -m, --model <ref>      model to use, as provider/model
  -p, --provider <id>    provider to prefer when picking a model
  -r, --resume <id>      resume a previous session
      --models           list every configured model and exit
      --free             with --models, only zero-cost models
      --providers        list every configured provider and exit
      --init             run the setup wizard
      --web              start the browser interface
      --port <n>         port for --web (default 4096)
      --host <addr>      address for --web (default 127.0.0.1)
      --open             open the browser when --web starts
      --preview          start with the live preview pane turned on
      --json             machine readable output for --models and --providers
  -v, --version          print the version
  -h, --help             show this help

Config:  ${paths.configFile}
Data:    ${paths.dataDir}
`)
}

/** First-run wizard: pick a provider, enter a key, pick a model. */
async function runSetup(
  config: ConfigStore,
  registry: ProviderRegistry,
  ask: Prompter,
  askSecret: SecretPrompter,
): Promise<boolean> {
  process.stdout.write(`\n${style.bold("Setup")} ${style.gray("· one-time configuration")}\n\n`)
  infoLine(`config file: ${config.path}`)

  const providers = registry.providers()
  process.stdout.write(`\n  ${style.bold("Providers")}\n`)
  providers.forEach((provider, index) => {
    const { key } = registry.keyFor(provider)
    const mark = key ? style.green("✔ key") : style.gray("  –")
    process.stdout.write(`   ${style.cyan(String(index + 1))}) ${provider.id.padEnd(16)} ${provider.name.padEnd(18)} ${mark}\n`)
  })

  const openRouterIndex = providers.findIndex((p) => p.id === "openrouter" && registry.keyFor(p).key)
  const suggested = openRouterIndex >= 0 ? openRouterIndex + 1 : 1
  const answer = (await ask(`${style.green("›")} provider number (default ${suggested}): `)).trim()
  const index = Number(answer || String(suggested))
  const provider = providers[index - 1]
  if (!provider) {
    errorLine("that is not a provider number")
    return false
  }

  const { key } = registry.keyFor(provider)
  if (!key && !provider.anonymous) {
    const entered = (await ask(`${style.green("›")} API key for ${provider.id}: `)).trim()
    if (!entered) {
      warnLine("no key entered. You can add one later with: punani --provider " + provider.id)
    } else {
      config.setApiKey(provider.id, entered)
      successLine(`key stored in ${config.path} (mode 0600, never sent anywhere but ${provider.baseURL})`)
    }
  } else if (provider.anonymous) {
    infoLine(`${provider.name} runs locally, so no API key is needed.`)
  }

  const baseUrl = (await ask(`${style.green("›")} base URL for ${provider.id} [${provider.baseURL}]: `)).trim()
  if (baseUrl && baseUrl !== provider.baseURL) {
    config.setProvider({ ...provider, baseURL: baseUrl.replace(/\/+$/, "") })
  }

  const chosen = registry.provider(provider.id)!
  const { models, error } = await registry.models(chosen, true)
  if (error) {
    warnLine(`could not fetch the model catalog: ${error}`)
    warnLine(`You can still set a model id by hand: punani --model ${provider.id}/<model-id>`)
    return true
  }

  const usable = models.filter((model) => model.status === "active")
  process.stdout.write(`\n  ${style.bold(`Models on ${provider.name}`)}\n`)
  usable.slice(0, 20).forEach((model, modelIndex) => {
    const tools = model.toolSupport ? style.green("tools ✔") : style.yellow("tools ✖")
    const ctx = Math.round(model.contextWindow / 1000)
    process.stdout.write(
      `   ${style.cyan(String(modelIndex + 1).padStart(2))}) ${model.id.padEnd(34)} ctx ${String(ctx).padStart(4)}k  ${tools}\n`,
    )
  })
  if (usable.length === 0) {
    warnLine("no active models reported by this provider")
    return true
  }

  const preferred = usable.findIndex((m) => m.id === "minimax/minimax-m3.1-flash:free")
  const defaultModelNum = preferred >= 0 ? preferred + 1 : 1
  const pick = (await ask(`${style.green("›")} model number (default ${defaultModelNum}): `)).trim()
  const chosenIndex = Number(pick || String(defaultModelNum))
  const model = usable[chosenIndex - 1]
  if (!model) {
    warnLine("that is not a model number, keeping the default")
    return true
  }
  config.setDefaultModel(`${provider.id}/${model.id}`)
  successLine(`default model: ${provider.id}/${model.id}`)

  // Optional extras. Both can be set later with /image and /audio.
  const extras = (await ask(`${style.green("›")} set up image or speech generation? (y/n) `)).trim().toLowerCase()
  if (extras === "y" || extras === "yes") {
    const which = (await ask(`${style.green("›")} which? (1 image, 2 speech, 3 both) `)).trim()
    if (which === "1" || which === "3") {
      const backend = (await ask(`${style.green("›")} image backend (1 kling, 2 openai-compatible) [1]: `)).trim()
      if (backend === "2") {
        const url = (await ask(`${style.green("›")} images base URL: `)).trim()
        if (url) {
          const key = await askSecret(`${style.green("›")} API key (not shown, blank to skip): `)
          config.setImageSettings({
            provider: "openai-compatible",
            baseURL: url.replace(/\/+$/, ""),
            apiKey: key.trim() || undefined,
          })
          successLine("image generation configured")
        }
      } else {
        const { whoAmI } = await import("./provider/kling.js")
        const identity = await whoAmI()
        if (!identity.loggedIn) {
          warnLine(identity.error ?? "not signed in to Kling")
          infoLine("run `kling login` in a terminal, then: /image kling <model>")
        } else {
          const models = identity.imageModels.length ? identity.imageModels : identity.models
          if (models.length > 0) {
            process.stdout.write(`\n  ${style.bold("Kling models")}\n`)
            models.slice(0, 12).forEach((model, index) => {
              process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${model}\n`)
            })
          }
          const chosen = (await ask(`${style.green("›")} model number or name (blank to skip): `)).trim()
          const index = Number(chosen)
          const model = Number.isInteger(index) && index > 0 ? models[index - 1] : chosen || undefined
          config.setImageSettings({ provider: "kling", model })
          successLine("image generation configured")
        }
      }
    }
    if (which === "2" || which === "3") {
      const { listVoices } = await import("./provider/elevenlabs.js")
      const key = await askSecret(`${style.green("›")} ElevenLabs API key (not shown): `)
      if (key.trim()) {
        config.setAudioSettings({ provider: "elevenlabs", apiKey: key.trim() })
        const voices = await listVoices(key.trim())
        if (voices.length > 0) {
          process.stdout.write(`\n  ${style.bold("Voices")}\n`)
          voices.slice(0, 12).forEach((voice, index) => {
            process.stdout.write(`   ${style.cyan(String(index + 1).padStart(2))}) ${voice.name}\n`)
          })
          const chosen = (await ask(`${style.green("›")} voice number (blank to skip): `)).trim()
          const index = Number(chosen)
          const voice = Number.isInteger(index) && index > 0 ? voices[index - 1] : undefined
          if (voice) {
            config.setAudioSettings({
              provider: "elevenlabs",
              apiKey: key.trim(),
              voiceId: voice.voiceId,
              voiceName: voice.name,
              model: "eleven_multilingual_v2",
            })
          }
        }
        successLine("speech generation configured")
      }
    }
  }

  infoLine("Run `punani` in a project directory to start.")
  return true
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return 0
  }
  if (options.version) {
    const { version } = await import("./core/version.js")
    process.stdout.write(`${version}\n`)
    return 0
  }

  const projectRoot = path.resolve(options.project ?? process.cwd())
  if (!fs.existsSync(projectRoot)) {
    errorLine(`project directory does not exist: ${projectRoot}`)
    return 1
  }

  const config = new ConfigStore()
  const registry = new ProviderRegistry(config)
  const sessions = new SessionStore()

  const { ask, askSecret, close } = createPrompter()

  try {
    if (options.listProviders) {
      const status = await registry.status()
      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            status.map((entry) => ({
              id: entry.provider.id,
              name: entry.provider.name,
              kind: entry.provider.kind,
              baseURL: entry.provider.baseURL,
              hasKey: entry.hasKey,
              keySource: entry.keySource,
              models: entry.models.length,
              error: entry.error,
            })),
            null,
            2,
          )}\n`,
        )
      } else {
        for (const entry of status) {
          const mark = entry.hasKey
            ? style.green("key ✔")
            : entry.provider.anonymous
              ? style.cyan("local")
              : style.yellow("key ✖")
          process.stdout.write(
            `  ${style.bold(entry.provider.id.padEnd(16))} ${entry.provider.name.padEnd(18)} ${mark} ` +
              `${style.gray(`${entry.models.length} models`)} ${style.gray(entry.provider.baseURL)}\n`,
          )
          if (entry.error) process.stdout.write(`      ${style.gray(entry.error)}\n`)
        }
      }
      return 0
    }

    if (options.listModels) {
      const all = await registry.allModels()
      const models = options.freeOnly
        ? all.filter((model) => model.cost.input === 0 && model.cost.output === 0)
        : all
      if (options.json) {
        process.stdout.write(`${JSON.stringify(models, null, 2)}\n`)
      } else {
        for (const model of models) {
          const provider = registry.providers().find((entry) => entry.id === model.providerID)
          const tools = model.toolSupport ? "tools ✔" : "tools ✖"
          process.stdout.write(
            `  ${style.bold(model.id.padEnd(36))} ${style.cyan((provider?.name ?? model.providerID).padEnd(18))} ` +
              `${style.gray(`${Math.round(model.contextWindow / 1000)}k`)} ${tools} ${style.gray(model.status)}\n`,
          )
        }
      }
      return 0
    }

    if (options.init) {
      await runSetup(config, registry, ask, askSecret)
      return 0
    }

    if (options.web) {
      const { WebServer } = await import("./web/server.js")
      const host = options.host ?? "127.0.0.1"
      const port = options.port ?? 4096
      const server = new WebServer(config, {
        projectRoot,
        port,
        host,
        extraRoots: mountedVolumes(),
        token: options.token,
        taskLabel: options.taskLabel,
      })
      if (options.preview) {
        server.preview.enable("static")
        infoLine("preview pane is on")
      }
      try {
        await server.start()
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === "EADDRINUSE") {
          errorLine(`port ${port} is already in use (${host}:${port}).`)
          infoLine(`Another punani web may still be running — open ${style.cyan(`http://${host}:${port}`)} or stop the old process:`)
          infoLine(`  lsof -iTCP:${port} -sTCP:LISTEN   then   kill <pid>`)
          infoLine(`Or use a different port: ${style.cyan(`punani web --port ${port + 1}`)}`)
          return 1
        }
        throw error
      }
      if (!options.spawned) {
        process.stdout.write(`\n${style.bold("Punani powerd")} ${style.gray("· browser interface")}\n\n`)
        process.stdout.write(`  ${style.gray("task")}    ${server.taskLabel}\n`)
        process.stdout.write(`  ${style.gray("project")}  ${projectRoot}\n`)
        process.stdout.write(`  ${style.gray("url")}      ${style.cyan(`http://${host}:${port}`)}\n`)
        process.stdout.write(`  ${style.gray("token")}    ${style.bold(style.gold(server.token))}\n\n`)
        process.stdout.write(
          `  ${style.gray("Open")} ${style.cyan(server.loginUrl)}\n` +
            `  ${style.gray("The token above is the whole sign-in. Paste it into the page if the link does not open.")}\n\n`,
        )
      }
      if (host !== "127.0.0.1" && host !== "localhost") {
        warnLine(
          `bound to ${host}. Anyone who can reach this address can run commands as you. ` +
            "Use a token-protected tunnel or bind to 127.0.0.1 instead.",
        )
      }
      if (options.open) {
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
        const { spawn } = await import("node:child_process")
        spawn(opener, [server.loginUrl], { detached: true, stdio: "ignore" }).unref()
        infoLine("opened in your browser")
      }
      const shutdown = async (): Promise<void> => {
        await server.stop()
        process.exit(0)
      }
      process.on("SIGINT", shutdown)
      process.on("SIGTERM", shutdown)
      await new Promise<never>(() => {})
      return 0
    }

    // Pick the model to start with.
    let model: ModelInfo | undefined
    if (options.model) {
      model = await registry.findModel(options.model)
      if (!model) {
        errorLine(`model "${options.model}" is not available. Run \`punani --models\` to see what is configured.`)
        return 1
      }
    } else {
      model = await registry.defaultModel()
    }

    if (!model) {
      warnLine("no model is configured yet.")
      infoLine("Run `punani --init` to set up a provider, or `punani --providers` to see the options.")
      infoLine("The fastest start: point FreeLLMAPI at a local router, or use Ollama or LM Studio.")
      return 1
    }

    if (!model.toolSupport) {
      warnLine(`${model.name} has no tool support. The agent will not be able to use its tools.`)
    }

    // Resume a previous session if asked.
    let resume: { meta: SessionMeta; messages: ChatMessage[] } | undefined
    if (options.resume) {
      const stored = sessions.read(options.resume)
      if (!stored) {
        errorLine(`no session with id "${options.resume}". Use \`punani --history\` to list them.`)
        return 1
      }
      resume = { meta: stored.meta, messages: toChatMessages(stored.messages) }
      infoLine(`resuming session ${stored.meta.id} (${stored.messages.length} messages)`)
    }

    const provider = registry.providers().find((entry) => entry.id === model.providerID)
    const providerName = provider?.name ?? model.providerID

    const deps: AppDeps = {
      config,
      registry,
      sessions,
      projectRoot,
      ask,
      state: { model, providerName },
      resume,
      askSecret,
    }

    await startApp(deps)
    return 0
  } catch (error) {
    const message = redactError(error)
    errorLine(message)
    log.error(`fatal: ${message}`)
    return 1
  } finally {
    close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    errorLine(redactError(error))
    process.exitCode = 1
  })
