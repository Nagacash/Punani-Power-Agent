# Punani powerd by Naga Codex

**Repository:** [github.com/Nagacash/Punani-Power-Agent](https://github.com/Nagacash/Punani-Power-Agent) · **Landing:** [Punani-AI](https://github.com/Nagacash/Punani-AI) · **[punani.agency](https://punani.agency)**

> **`main` is protected.** We only merge changes via pull requests — see [CONTRIBUTING.md](./CONTRIBUTING.md).

A terminal-based AI coding agent. It opens a local project, talks to a model, and
runs tools — reading files, searching, editing, and running shell commands — with
your approval before anything risky happens.

**What makes it special:** a **free-first** coding experience for people who live on
free models, local Ollama, or cannot afford expensive subscriptions — without dumbing
down the product (permissions, diffs, MCP, browser UI). **Or** bring your own keys —
OpenAI, Groq, OpenRouter, NVIDIA NIM, and the rest — same engine, your billing, no
token markup from us.

It is written from scratch in TypeScript with no runtime dependencies. Node 20+ is
the only requirement.

```
 Punani powerd by Naga Codex hello-node · session mvgk26mtoyeak8

model Demo Assistant · FreeLLMAPI · ctx 33k · tools ✔ · free
· project /Users/you/code/hello-node
· config /Users/you/.config/punani-powerd/config.json
· Type /help for commands, /exit to quit.
› Add a --loud flag to the greeter, then run the tests.
  • read src/greet.js
  │ src/greet.js (18 lines)
  │ 8  export function greet(name = DEFAULT_NAME) {
  • edit src/greet.js
  src/greet.js +3 -2
  -     7 export function greet(name = DEFAULT_NAME) {
  +     7 export function greet(name = DEFAULT_NAME, loud = false) {
 EDIT  Edit src/greet.js
  ! This action can destroy or overwrite data.
  y once  a always  n reject  (optionally n <reason>)
? y
  │ Edited src/greet.js (+3 -2, 1 replacement)
  • bash npm test
 BASH  Run: npm test
? y
  │ ✔ greet defaults to world (0.41ms)
→ Added a `loud` parameter and ran the suite. Everything passes.
```

## Install

### End users (recommended)

Install once globally. You do **not** need to clone this repository.

```bash
npm i -g punani-powerd
punani --init
```

That puts `punani` on your PATH until you run `npm uninstall -g punani-powerd` or upgrade with `npm i -g punani-powerd@latest`. Config and sessions live under `~/.config/punani-powerd` and `~/.local/share/punani-powerd`.

Requires Node 20 or newer.

### Contributors (from source)

When the public agent repo is on GitHub (`Nagacash/punani-powerd`):

```bash
git clone https://github.com/Nagacash/punani-powerd.git
cd punani-powerd
npm install
npm run build
npm link          # optional: puts `punani` on your PATH
```

The **[Punani-AI](https://github.com/Nagacash/Punani-AI)** repo is only the marketing site — not the CLI.

Without `npm link`, run it as `node dist/main.js`.

## Quick start

```bash
punani --init          # pick a provider, enter a key, pick a model
cd ~/code/my-project
punani                 # open the project and start chatting
```

## Browser interface

Not everyone lives in a terminal. The same agent runs in a browser:

```bash
punani web                    # http://127.0.0.1:4096
punani web --open             # start it and open the browser
punani web --port 5000        # pick a port
punani web -C ~/code/my-app   # pick the project
```

It prints a private link and the token it is made of:

```
  url      http://127.0.0.1:4096
  token    8a808cb3d0e2fa765150fef07d78cf28ceb4ed067e0f0f35ea74ad90030868ba

  Open http://127.0.0.1:4096/?t=8a808cb3d0e2fa765150fef07d78cf28ceb4ed067e0f0f35ea74ad90030868ba
  The token above is the whole sign-in. Paste it into the page if the link does not open.
```

The link signs you in and sets a cookie for a day. If the link is lost — a
landing page cannot know the token — the sign-in page takes a pasted token
instead, so you are never locked out of a server that is already running.

It prints a private link. Open it once and you are signed in; the link
contains a random token that the server swaps for a cookie.

| | |
| --- | --- |
| Chat | The same conversation as the terminal, with streaming replies. |
| Tool calls | Each tool call is a card: the name, the arguments, the output. |
| Reasoning | Models that think show their reasoning in a dimmed block. |
| Approvals | Permission prompts appear as a card with **Allow once**, **Always allow** and **Reject**, plus a free-text reason. |
| Diffs | A file edit shows the red/green diff before the change is written. |
| Model picker | A dropdown in the header, loaded from the live catalogs. |
| Stop | Aborts the running turn. |

It is the same engine, not a reimplementation: the ruleset, the tools, the
session log and the provider layer are shared. A read that the ruleset allows
in the terminal is also allowed in the browser.

### Keeping it safe

The server can run shell commands, so it is locked down:

- **Bound to `127.0.0.1`** by default. `--host` moves it, and the server warns
  you when you do.
- **A 256-bit token** is minted at startup. The link carries it once, then it
  becomes an `HttpOnly; SameSite=Strict` cookie.
- **Origin is checked.** A request from another site is refused, so a page you
  are browsing cannot drive your agent.
- **The page is sandboxed** with a strict `Content-Security-Policy`: no
  scripts from anywhere else, no outbound connections except back to this
  server.

If you did not start the server, you cannot use it. If the link stops working,
the server was restarted and the token changed.

---

## Providers

Three tiers are built in, and each one is a plain OpenAI-compatible endpoint.

| Purpose | Provider | Why |
| --- | --- | --- |
| Fast edits, simple tasks | **FreeLLMAPI** free model | No cost, good for quick iterations. The router picks a model that still has quota. |
| Complex multi-file coding | **A strong tool-calling model** (OpenAI, OpenRouter, or your own endpoint) | Reliable function calling and a long context window. |
| Private / local fallback | **Ollama** or **LM Studio** | Code and prompts never leave the machine. |

FreeLLMAPI is the default experimental provider, but nothing is chosen for you:
you pick the model explicitly, and every shell command is approved by hand. Your
workflow never depends on a free tier being available.

Eight providers ship built in:

| id | Provider | Endpoint | Key env var |
| --- | --- | --- | --- |
| `freellmapi` | FreeLLMAPI (self-hosted router) | `http://localhost:3001/v1` | `FREELLMAPI_API_KEY` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `nvidia` | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `NVIDIA_API_KEY` |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `cerebras` | Cerebras | `https://api.cerebras.ai/v1` | `CEREBRAS_API_KEY` |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `ollama` | Ollama (local) | `http://localhost:11434` | — |
| `lmstudio` | LM Studio (local) | `http://localhost:1234/v1` | — |

### Finding free models

`--models` reads each provider's live catalog, so you can see what is actually
callable right now, with the real price:

```
$ punani --models --free
  minimax/minimax-m3.1-flash:free      OpenRouter  1000k tools ✔ active  free
  poolside/laguna-s-2.1:free           OpenRouter   262k tools ✔ active  free
  cohere/north-mini-code:free          OpenRouter   256k tools ✔ active  free
  nvidia/nemotron-3-super-120b-a12b:free OpenRouter 262k tools ✔ active free
  auto                               FreeLLMAPI    33k tools ✔ active  free
```

Inside the agent, `/models` does the same and adds a substring filter:

```
/models                    every model
/models free               only zero-cost models
/models openrouter         one provider
/models free nemotron      free models matching a substring
```

The `COST/1M` column is read from the provider's own pricing feed, not guessed:
OpenRouter's `"0.00000015"` per token is shown as `$0.15/M`.

### OpenRouter

The quickest way to a working free model. Sign up, create a key, then:

```
/provider openrouter key sk-or-v1-...
/models openrouter free
/model openrouter/poolside/laguna-s-2.1:free
```

OpenRouter currently lists 20 zero-cost models, most with tool support and
256k–1M context. `poolside/*` and `cohere/north-mini-code` are code-specialised.

### NVIDIA NIM

Free API credits on signup at build.nvidia.com. The catalog is public, so you
can browse it before you have a key:

```
$ punani --models nvidia
  nvidia/nemotron-3-super-120b-a12b            NVIDIA NIM  128k tools ✔ active
  deepseek-ai/deepseek-v4.1-flash              NVIDIA NIM  128k tools ✔ active
  mistralai/codestral-22b-instruct-v0.1        NVIDIA NIM  128k tools ✔ active
```

Then store the key:

```
/provider nvidia key nvapi-...
```

### FreeLLMAPI

FreeLLMAPI is a self-hosted, OpenAI-compatible router that fronts many providers
with a real free tier, fails over when one is rate limited, and tracks your usage
against each cap. See <https://freellmapi.co>.

**There is no public hosted endpoint** — `api.freellmapi.co` returns 404. The
router runs on your own machine. Docker is not required; Node 20+ is enough:

```bash
git clone https://github.com/tashfeenahmed/freellmapi
cd freellmapi
npm install
printf "ENCRYPTION_KEY=%s\nPORT=3001\n" \
  "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" > .env
npm run dev
```

It serves the API on `http://localhost:3001` and the dashboard on
`http://localhost:5173` (dev) or `http://localhost:3001` (production build).

Open the dashboard, add your upstream provider keys on the **Keys** page, and
copy the **unified API key** from the page header. That is the key Punani needs:

```
/provider freellmapi key freellmapi-<your-unified-key>
/models freellmapi
/model freellmapi/auto
```

`auto` lets the router choose the best available model. The catalog endpoint
`GET /v1/models` reports `context_window`, `available`, `execution_status` and
`supported_parameters`, so Punani can show you the context window and whether a
model supports tools before you use it.

**The router needs upstream keys of its own.** It is a router, not a model host:
it picks a provider that still has free quota, so at least one upstream
provider key has to be configured in its dashboard. Without one, every request
fails with *"No candidate model has a configured, usable provider key"* — and
Punani says so, with the dashboard address, rather than leaving you guessing.

```
open http://localhost:5173      # the dashboard `npm run dev` printed
→ Keys → add a provider key (Gemini, OpenRouter, Groq, …)
```

Then `freellmapi/auto` routes to whatever still has quota, and falls over to
another model when one is rate limited.

Until you add upstream keys to the router, its catalog still lists the models
but marks them unavailable, and a request comes back with a clear error:

```
✖ Provider error: No candidate model has a configured, usable provider key.
  Add provider API keys in the dashboard.
  try instead:
    openrouter/minimax/minimax-m3.1-flash:free · MiniMax: MiniMax M3.1 Flash (free)
```

To run the router somewhere else:

```
/provider freellmapi url http://192.168.1.10:3001/v1
```

### Ollama

```
ollama serve
/provider ollama
/models ollama
/model ollama/qwen3-coder:30b
```

Ollama does not report a context window, so Punani assumes 32k and you can override
it per model in the config. Tool calling needs a model trained for it; if calls
fail, raise the context with `OLLAMA_CONTEXT_LENGTH=32768` and pick an
instruction-tuned model.

### LM Studio

Start the local server in LM Studio (default port 1234), then:

```
/models lmstudio
/model lmstudio/<model-id>
```

### Any OpenAI-compatible endpoint

```
/provider add my-gateway http://192.168.1.20:8000/v1
/provider my-gateway key sk-...
/models my-gateway
```

### Direct provider keys

OpenAI, OpenRouter, NVIDIA NIM, Groq and Cerebras ship as built-in providers.
Store a key the same way as any other:

```
/provider openai key sk-...
```

A key can also come from the environment (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`NVIDIA_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `FREELLMAPI_API_KEY`,
`OLLAMA_API_KEY`, `LMSTUDIO_API_KEY`). The environment is only read when the
config file has no key for that provider.

## Where your keys live

One file, and only on your machine:

```
~/.config/punani-powerd/config.json     mode 0600, directory 0700
```

The file holds provider definitions, API keys, per-model overrides and the
permission ruleset. It is written atomically with owner-only permissions.

Keys are never written to the session log, never printed, and never sent anywhere
but the provider's own base URL. Every log line and error message passes through
a redactor that scrubs anything shaped like a key.

Override the path with `PUNANI_CONFIG=/path/to/config.json`.

## Before a task runs

Punani shows the model it is about to use:

```
model Claude Sonnet 4.5 · Anthropic · ctx 200k · tools ✔ · $3/M in, $15/M out
```

That is the model name, the provider, the context window, whether the model
supports tool calls, and the estimated cost per million tokens. Cost is tracked
per turn and reported after each one.

## Permissions

Nothing destructive happens without you saying so.

| Action | Default | What it covers |
| --- | --- | --- |
| `read` | allow | reading files |
| `search` | allow | `grep` and `glob` |
| `edit` | ask | changing part of a file |
| `write` | ask | creating or replacing a file |
| `bash` | ask | running a shell command |

Rules are an ordered list and the last match wins:

```
/permissions bash "git status*" allow
/permissions bash "rm -rf*" deny
/permissions edit "src/*" ask
```

When you are asked, you can answer:

- `y` — allow this once
- `a` — allow this pattern for the rest of the session
- `n` — reject
- `n <reason>` — reject, and pass the reason back to the model so it can adapt

Every file edit shows a diff before it is written. Commands that delete or
overwrite data (`rm -rf`, `git reset --hard`, `dd`, piping a download into a
shell) are flagged as destructive in the prompt.

## Tools

| Tool | Purpose |
| --- | --- |
| `read` | read a file, with line numbers, paging for big files |
| `glob` | find files by pattern, newest first, respecting `.gitignore` |
| `grep` | search file contents with a regular expression |
| `edit` | replace an exact string in a file, with a diff preview |
| `write` | create a file or replace its whole content, with a diff preview |
| `bash` | run one shell command, with your approval |
| `image` | generate an image and save it into the project |
| `audio` | turn a script into speech and save it into the project |

Paths are resolved inside the project. A tool call cannot read or write outside it.

## Image generation

The `image` tool is available once you configure a backend.

```
/image                              show the current settings
/image kling [model]                use the kling CLI
/image openai <base-url> [key]      use an OpenAI-compatible images endpoint
/image off                          turn it off
```

### Kling

Kling is driven through its `kling` CLI, which owns authentication, polling and
the regional endpoint. The app never talks to that service directly.

```bash
npm i -g @klingai/cli-global
kling login
kling who_am_i                       # lists the models you can use
```

Then:

```
/image kling kling-v2-1
```

The generated file lands in `assets/generated/` and the path is returned to the
model, so it can look at the result. In the browser the image is shown inline.

### Any OpenAI-compatible images endpoint

```
/image openai https://api.openai.com/v1 sk-...
```

The app posts to `/v1/images/generations` and accepts either `b64_json` or a
`url` in the response.

### In the config file

```json
{
  "image": {
    "provider": "kling",
    "model": "kling-v2-1",
    "outputDir": "assets/generated",
    "timeoutSeconds": 120
  }
}
```

Image generation is never automatic: the tool asks for permission first, and a
declined request writes nothing.

## Speech generation

The `audio` tool turns a script the model writes into a speech file.

```
/audio                        show the current settings
/audio key <elevenlabs-key>  store your key
/audio voice                  list the voices, /audio voice <n> to pick
/audio model                  list the models, /audio model <n> to pick
/audio format mp3_44100_128  choose the output format
/audio off                    turn it off
```

The key is typed at a hidden prompt, so it never appears on screen:

```
› ElevenLabs API key (not shown):
✔ key stored in /Users/you/.config/punani-powerd/config.json (mode 0600)

  Voices (21 available)
    1) Roger - Laid-Back, Casual, Resonant
    2) Sarah - Mature, Reassuring, Confident
    3) Alice - Clear, Engaging Educator
  pick one with: /audio voice <number or id>
```

Files land in `assets/audio/`. In the browser they get a player.

The `elevenlabs` voice catalog is public, so you can look at the voices before
you have a key. Speech costs characters on your ElevenLabs account, so the
tool asks for permission before every call.

### In the config file

```json
{
  "audio": {
    "provider": "elevenlabs",
    "apiKey": "sk_...",
    "model": "eleven_multilingual_v2",
    "voiceId": "EXAVITQu4vr4xnSDxMaL",
    "voiceName": "Sarah",
    "outputDir": "assets/audio",
    "outputFormat": "mp3_44100_128"
  }
}
```

## Managing your own credentials

Everything that needs a key has a command, so you never have to edit JSON:

```
/keys                  show every provider and whether a key is stored
/keys <provider>       type a key at a hidden prompt
/keys <provider> clear remove it
```

Keys are written to the one config file with mode 0600, registered with the
redactor so they can never be printed, and sent only to their own provider's
base URL. The environment is used when the file has no key for a provider.

## The interface

The browser interface is built from the mark: pure black, antique gold pulled
straight out of the logo. The palette is sampled from the artwork rather than
guessed, so the two never drift apart.

- A floating header island with the tiger emblem, which lights up while the
  agent is working.
- A right rail with the live model record, the session, every provider and its
  key status, and a gallery of everything the agent has generated.
- Tool calls as nested cards, with the diff inside the card that caused it.
- Permission prompts as the loudest thing on screen, with **Allow once**,
  **Always** and **Reject**, plus a free-text reason.
- Generated images and audio are playable inline.

The terminal is a thin renderer over the same engine. Everything the browser
can do, the terminal can do, and the session log is shared between them.

## Skills

The agent reads a library of instruction folders, the same shape the
[agentskills.io](https://agentskills.io) standard defines: a `SKILL.md` with
`name:` and `description:` in the frontmatter.

Your 926 skills on this machine are already in that format, in
`~/.agents/skills` and `~/.claude/skills`, plus any you drop in
`<project>/.punani/skills`. Nothing is bundled with the app and nothing is
hard-coded — the library stays where it is and keeps updating.

```
/skills                what groups exist
```

Three tools, because a thousand skills cannot go in one prompt:

| Tool | What it does |
| --- | --- |
| `skill_list` | the skills inside one group |
| `skill_search` | find one by name, keyword or tag |
| `skill_load` | read one in full, before doing that kind of work |

The system prompt carries a **table of contents** — 35 groups, about 1,800
tokens — instead of every description, which would cost roughly 48,000. Grouping
comes from the skill's own `subdomain` field where it has one, and otherwise
from the word it shares with its siblings, so the design skills land together
under `design` and the interface ones under `frontend`.

A skill body is a file on disk, so it is treated as untrusted input: names and
descriptions are XML-escaped, and the body cannot close the envelope it is
delivered in.

## Working without a terminal

Everything the terminal can do, the browser can do.

### Where a key lives

Each provider's key can be kept in one of two places, chosen per provider in
**Settings → Providers**:

| | |
| --- | --- |
| **on this machine** | Written to the 0600 config file. The server reads it. The browser never sees it. |
| **in the browser** | Kept in the browser's own storage. It is sent to the local server with each request and used for that call only — **the server never writes it to disk**. |

The browser-held option means the key exists in exactly one place: the browser
that you are using. The server cannot leak it because it does not keep it.

The browser UI is built on [Zustand](https://github.com/pmndrs/zustand)'s
framework-agnostic store (`zustand/vanilla`), served from the install
directory at `/vendor/zustand.js`. It is the one runtime dependency, and it
carries no transitive dependencies.

| | |
| --- | --- |
| **Open a project** | The header has the project name. Click it, or use **Open a project** on the empty screen. A folder browser lists your home folder and every mounted drive, so an external disk works too. |
| **Add a key** | **Settings** in the header. Providers, Media and MCP. A key is typed into a masked field, sent to the local server, and written to the 0600 config file. It is never shown again. |
| **See the result** | **Preview** opens a live pane beside the chat. The project is served from disk and reloads by itself when you change a file. |
| **Point at your dev server** | Type `http://localhost:5173` in the preview bar and the pane frames your running Vite or Next dev server instead. |
| **Approve an action** | The same permission cards as the terminal: Allow once, Always, Reject, with a reason. |
| **Generate media** | The Media tab configures Kling and ElevenLabs. The ElevenLabs voice list is public, so you can pick a voice before you have a key. |

The two frontends share one engine, one config file and one session log. A
session opened in the browser is the same session in the terminal.

## MCP servers

The agent speaks MCP over stdio, so any stdio MCP server becomes a set of
tools the model can call.

```
/mcp                          list the configured servers
/mcp add filesystem /Users/you/code
/mcp add browser              the browser-harness MCP server
/mcp remove filesystem
```

Or from the browser: **Settings → MCP**.

Well-known servers are one click. `browser` is
[browser-use/browser-harness](https://github.com/browser-use/browser-harness) —
MIT, four dependencies, no LLM key, no browser download: it drives the Chrome
you are already signed into. `video` is
[SylphxAI/anymd](https://github.com/SylphxAI/anymd) — MIT, a single native
binary, local transcription, no API key.

MCP tools are named `<server>_<tool>` and are gated by their own permission
action, so a tool from a third-party server still has to be approved.

## Deploying

See [DEPLOY.md](DEPLOY.md) for npm publishing, GitHub Releases, Docker, and
running the browser interface behind your own authentication.

[ROADMAP.md](ROADMAP.md) records where this goes next: structural search with
ast-grep, Seatbelt sandboxing keyed to the permission ruleset, a live preview
canvas, symbol-level navigation, and local image and speech models so neither
Kling nor ElevenLabs is required. Every repository there was checked against
GitHub for stars, licence and activity.

```bash
npm publish          # for others to install with npm i -g punani-powerd
```

## Sessions

Every session is a JSONL file under `~/.local/share/punani-powerd/sessions/`. A
session can be listed and reopened:

```
/history                 # list previous sessions
punani --resume <id>     # reopen one
```

`/session` shows the current session id and message count.

Resuming restores the earlier messages into the conversation, so the model keeps
the context of what it already did:

```
$ punani --resume ses_mvgkk6lnikjk51
· resuming session ses_mvgkk6lnikjk51 (10 messages)
· resumed 10 earlier messages
```

## Commands

| Command | Effect |
| --- | --- |
| `/help` | list every command |
| `/models [filter]` | list models, optionally by provider or substring |
| `/model <provider/model>` | set the default model |
| `/provider` | list providers and whether a key is stored |
| `/provider <id> key <value>` | store a key locally |
| `/provider <id> url <url>` | point a provider at a different base URL |
| `/provider add <id> <url>` | add an OpenAI-compatible provider |
| `/permissions <action> <pattern> <effect>` | set `allow`, `ask` or `deny` |
| `/history` | list previous sessions |
| `/session` | show the current session |
| `/clear` | clear the conversation |
| `/context` | show the system prompt |
| `/config` | show config paths and file permissions |
| `/keys` | store or remove an API key, without typing it on screen |
| `/image` | configure image generation |
| `/audio` | configure speech generation |
| `/exit` | quit |

In the browser, the same session is stored the same way, so `punani --resume
<id>` reopens it in the terminal and vice versa.

## When a model fails

Failures are classified, explained, and paired with alternatives:

```
✖ Rate limited: Too Many Requests
  The provider is throttling. Wait, or switch to another configured model.
  try instead:
    ollama/qwen3-coder:30b · Qwen3 Coder (local)
    lmstudio/qwen2.5-coder-14b · Qwen2.5 Coder
  switch with: /model ollama/qwen3-coder:30b
```

Punani distinguishes authentication failures, rate limits, exhausted quotas,
unknown models, models that do not support tool calls, context-length overflow,
bad requests, network failures and provider errors — and points at the other
models you have configured.

## Demo

The demo runs the whole loop offline, with no API key and no network:

```bash
npm run demo
```

It starts a mock OpenAI-compatible server, points Punani at it, and drives a
scripted task against the `hello-node` sample: glob, read, edit with a diff
preview, then `npm test` behind a permission prompt.

## Samples

- `samples/hello-node` — a tiny Node project with tests
- `samples/python-todo` — a small Python project with tests

## Development

```bash
npm run build       # compile to dist/
npm run typecheck   # type check without emitting
npm test            # unit and end-to-end tests
npm run demo        # the offline demo
```

The end-to-end test spins up a mock provider and asserts the full loop: catalog
fetch, model selection, tool call, permission gate, tool execution, result fed
back to the model, and the session written to disk.

## Contributing

Do **not** push directly to `main`. Fork the repo, open a pull request, and keep CI green. Details: [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) · Copyright (c) 2026 Maurice Holda
