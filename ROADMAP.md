# Where this goes next

Research notes for the direction after the current release.

**Recent papercuts (agent):** streaming replies in terminal and web; default model
skips `freellmapi/auto` when OpenRouter free is available; landing waitlist uses
`POST /api/waitlist` (Clerk Backend API). The landing site is a separate Next app —
not part of the npm package footprint.
 Every repository
below was checked against GitHub for existence, stars, license, language and
last activity. Where a claim could not be verified it says so.

The goal is to be **different** from OpenCode, Gemini CLI, Claude Code and
Cursor — not a worse copy of them. The gap that matters is not more tools; it
is that this agent lives in a terminal and a browser, while those live inside
an editor and therefore see the cursor, the selection, the open tabs, the
language server and the semantic shape of the code.

---

## 1. Semantic code navigation — the biggest gap

Today `grep` finds text. Cursor finds *symbols*. This is the single biggest
difference in capability.

| Project | Stars | License | What it is |
| --- | --- | --- | --- |
| [ast-grep/ast-grep](https://github.com/ast-grep/ast-grep) | 16.3k | MIT | Structural search/lint/rewrite in Rust, ~50 languages, JSON/YAML rules |
| [tree-sitter/tree-sitter](https://github.com/tree-sitter/tree-sitter) | 27.2k | MIT | Incremental parser runtime; grammars are MIT sibling repos |
| [tree-sitter/node-tree-sitter](https://github.com/tree-sitter/node-tree-sitter) | 879 | MIT | Node native bindings (needs a node-gyp build) |
| [oraios/serena](https://github.com/oraios/serena) | 30.4k | **GPL-3.0** (app) | MCP server over SolidLSP: `find_symbol`, `replace_symbol`, `find_referencing_symbols` |
| [isaacphi/mcp-language-server](https://github.com/isaacphi/mcp-language-server) | 1.6k | BSD-3 | Bridges real LSP servers (typescript-language-server, pyright) to MCP |
| [CodeGraphContext/CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext) | 4.3k | MIT | Indexes a codebase into a Neo4j graph: call graphs, "who calls this" |
| [mixedbread-ai/mgrep](https://github.com/mixedbread-ai/mgrep) | 4.4k | Apache-2.0 | Embedding-based "semantic grep" over code |
| [Aider-AI/aider](https://github.com/Aider-AI/aider) | 49.7k | Apache-2.0 | Its repo-map (tree-sitter → ranked symbol graph → token budget) is the canonical implementation |

**Plan.** Ship `ast-grep` as a structural-search backend first. It is one
static binary, MIT, and it can be shelled out to — zero new dependencies in
this repo. It replaces the `grep` tool with something that understands
`parseArgs("2")` as a call rather than a string, and it adds *rewrite*, not just
search.

Then add a symbol index over tree-sitter for the "who calls this" questions.
`web-tree-sitter` (WASM) is the only way to get parsing in-process from
TypeScript without a native build — that is the one dependency worth taking,
and it should be taken deliberately rather than by accident.

Serena's **tool API** is the design to copy even though its code cannot be
embedded (GPL-3.0). `find_symbol` / `replace_symbol` /
`find_referencing_symbols` are the right vocabulary: symbol-level, not
line-number-level.

---

## 2. Local-first speech — making ElevenLabs optional

Today speech needs a key. It should not.

| Project | Stars | License | Apple Silicon | Notes |
| --- | --- | --- | --- | --- |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 9.5k | **Apache-2.0 (code and weights)** | CPU, and `kokoro-js` runs in-browser via WebGPU | 82M params. Repo quiet since Aug 2025, but the PyPI/npm artifacts are current |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 54.5k | MIT | **Metal + CoreML, first-class** | Ships `whisper-server` speaking OpenAI's `/v1/audio/transcriptions` |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 26.0k | MIT | CPU int8, no Metal path | Faster, but no GPU on a Mac |
| [resemble-ai/chatterbox](https://github.com/resemble-ai/chatterbox) | 27.1k | MIT | CPU and MPS | Chatterbox-Nano is 110M |
| [speaches-ai/speaches](https://github.com/speaches-ai/speaches) | 3.7k | MIT | Docker/CPU | Self-hosted OpenAI-compatible STT API |
| [OHF-Voice/piper1-gpl](https://github.com/OHF-Voice/piper1-gpl) | 5.9k | **GPL-3.0** | CPU | Very fast, but copyleft |

**Plan.** Kokoro is the answer: Apache-2.0 on the weights, so no commercial
restriction, small enough for CPU, and `kokoro-js` puts local TTS *inside the
browser frontend* — which already knows how to play an audio file. The ElevenLabs
path stays as the good-sounding option.

For speech *input*, `whisper.cpp --server` is the piece: MIT, Metal-native,
and it already speaks the OpenAI-compatible transcription shape, so the
existing client abstraction covers it with no new client code.

**Avoid:** `rhasspy/piper` (archived), `coqui-ai/TTS` (2 years stale, XTTS
weights are non-commercial), `myshell-ai/MeloTTS` (stale),
`fishaudio/fish-speech` (custom community licence, research-only weights).

---

## 3. Local image generation

Kling is a closed cloud service, so local generation is the way to make images
available without an account.

| Project | Stars | License | Notes |
| --- | --- | --- | --- |
| [Comfy-Org/ComfyUI](https://github.com/Comfy-Org/ComfyUI) | 140.4k | **GPL-3.0** | Node-graph diffusion engine with an HTTP API and native Apple Silicon support |
| [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | 4.2k | Apache-2.0 | GGUF quantized models, so FLUX runs on unified memory |
| [black-forest-labs/flux](https://github.com/black-forest-labs/flux) | 26.0k | Apache-2.0 (code) | **FLUX.1-schnell is Apache-2.0**; every `-dev`/`-fill`/`-canny` variant is the non-commercial licence |
| [Stability-AI/generative-models](https://github.com/Stability-AI/generative-models) | 27.3k | MIT | Reference SD3/SDXL implementation, older |

**Plan.** ComfyUI as a subprocess, never embedded — GPL-3.0 rules out
in-process, but `python main.py --listen 127.0.0.1:8188` plus
`POST /prompt` is a perfectly good backend, and it has first-class Apple
Silicon support. FLUX.1-schnell (Apache-2.0) via ComfyUI-GGUF is the only
top-tier image model with a permissive licence.

**Avoid:** `AUTOMATIC1111/stable-diffusion-webui` (AGPL-3.0, slower, worse
API), any FLUX `-dev` variant commercially, and any `-fill`/`-canny`/`-redux`/
`-kontext` variant.

---

## 4. Sandboxed command execution

The agent runs shell commands as the user. That is the sharpest edge in the
whole design.

| Project | Stars | License | Notes |
| --- | --- | --- | --- |
| macOS `sandbox-exec` / Seatbelt | — | built in | Per-process profile sandbox, already on every Mac |
| [apple/container](https://github.com/apple/container) | 50.8k | Apache-2.0 | Apple's own Linux-container runtime for Apple Silicon, VM-grade isolation |
| [e2b-dev/E2B](https://github.com/e2b-dev/E2B) | 14.5k | Apache-2.0 | Cloud sandboxes, per-sandbox billing. Wrong for a local-first tool |
| [daytonaio/daytona](https://github.com/daytonaio/daytona) | 71.5k | **none in repo** | **Archived** — its own README says core development moved to a private codebase in June 2026 |

**Plan.** Seatbelt is the pragmatic answer and it costs nothing: pair it with
the permission engine already in this codebase. `allow` rules run in a narrow
profile, `ask` and `deny` run under a profile with the network disabled. The
permission ruleset becomes a sandbox profile, which is a much stronger story
than "we asked the user".

**Avoid:** Daytona. 71.5k stars is historical vanity — the repo is archived,
unmaintained since June 2026, and ships no licence file.

---

## 5. A canvas instead of a chat box

The browser frontend is already a second frontend over the same engine. The
next step is a workspace the agent renders into, not a list of messages.

| Project | Stars | License | Notes |
| --- | --- | --- | --- |
| [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy) | 20.0k | MIT | **The reference architecture**: WebContainer runtime, live iframe preview, file-tree diff panel, any LLM |
| [dyad-sh/dyad](https://github.com/dyad-sh/dyad) | 22.0k | Apache-2.0 (outside `src/pro`) | Local-first app builder, live preview, edits your real project |
| [onlook-dev/onlook](https://github.com/onlook-dev/onlook) | 27.0k | Apache-2.0 | Click an element in the live preview → the agent edits the source. The most Cursor-like idea here. Last push 2 months ago |
| v0 | — | closed | The `v0-dev` GitHub org has zero public repos |

**Plan.** bolt.diy's stack maps one-to-one onto what already exists: a browser
frontend over SSE, a file tree, and a diff panel. Add a live preview pane
beside the chat, and the agent gets a canvas. Onlook's "click the element,
edit the source" loop is the part worth stealing — it needs the preview to
report a DOM path back to the agent.

---

## 6. Terminal UI framework — the answer is no

| Project | Stars | License | Language |
| --- | --- | --- | --- |
| [charmbracelet/bubbletea](https://github.com/charmbracelet/bubbletea) | 45.5k | MIT | Go |
| [charmbracelet/lipgloss](https://github.com/charmbracelet/lipgloss) | 11.9k | MIT | Go |
| [vadimdemedes/ink](https://github.com/vadimdemedes/ink) | 40.1k | MIT | TypeScript (React for CLIs) |
| [ratatui/ratatui](https://github.com/ratatui/ratatui) | 23.0k | MIT | Rust |

**Plan.** Do not adopt one. Bubbletea and ratatui are the best-in-class
architectures but they mean the TUI is a second language, a second build system
and an IPC boundary. Ink is the only one that fits the stack, and it drags in
React plus a dozen transitive dependencies, which contradicts the zero-runtime-
dependency rule that makes this project installable with `npm i -g` and nothing
else.

The terminal here is deliberately a thin renderer over the same engine that
drives the browser. That is a feature, not a limitation: the browser frontend
is where the rich UI belongs.

---

## 7. The Kling integration, and the pattern to copy

Kling is a closed cloud service — there is no local Kling.

| Project | Stars | License | Notes |
| --- | --- | --- | --- |
| [199-mcp/mcp-kling](https://github.com/199-mcp/mcp-kling) | 44 | MIT | The most complete Kling MCP server: 13+ tools, official API, auto-downloads results. Last push June 2025, so it predates Kling 2.x/3.x/Omni |
| [maciejdzierzek/kling-ai-prompt-generator](https://github.com/maciejdzierzek/kling-ai-prompt-generator) | 33 | MIT | A Claude Code plugin that teaches prompt structure for I2V/T2V. Prompt knowledge only |
| [AceDataCloud/KlingMCP](https://github.com/AceDataCloud/KlingMCP) | 1 | MIT | Routes through a third-party reseller, not the official API |
| [runapi-ai/kling-mcp](https://github.com/runapi-ai/kling-mcp) | 0 | Apache-2.0 | Same reseller problem |
| [black-forest-labs/skills](https://github.com/black-forest-labs/skills) | 134 | MIT | **The pattern**: a vendor shipping an agentskills.io-spec skill bundle |

**Plan.** This codebase already integrates Kling through the `kling` CLI, which
is better than every repo above: the CLI owns authentication, the regional
endpoint and the polling, and it is current. What is missing is the *prompt
knowledge* — `mcp-kling` and the prompt-generator plugin are references for
how to structure a Kling prompt, and that is worth porting into this app's own
image tool as prompt guidance.

The pattern worth copying is `black-forest-labs/skills`: a small, MIT,
agentskills.io-spec skill bundle that teaches prompt structure and correct API
call shapes. That is the shape of a first-party Kling skill for this project.

**Avoid:** `AceDataCloud/KlingMCP` and `runapi-ai/kling-mcp`. Both add a
reseller hop with different billing and no SLA.

---

## 7b. Browsing and video — what the research actually said

Two questions came up: whether `browser-use` is a good fit, and what
"video-use" is. Both were checked against GitHub, PyPI and npm.

### Browsing

| Project | Stars | Licence | Verdict |
| --- | --- | --- | --- |
| [browser-use/browser-use](https://github.com/browser-use/browser-use) | 118.6k | MIT | **Avoid as a dependency.** Python, 61 transitive deps, an optional 118 MB Rust wheel, and its own LLM key for the interesting tools. It does ship an MCP server whose primitives (`browser_navigate`, `browser_get_state`, `browser_click`) need **no** LLM — but that is the thin path. |
| [browser-use/browser-harness](https://github.com/browser-use/browser-harness) | 18.5k | MIT | **Use it.** Four dependencies, no LLM key, no browser download, drives the Chrome you are already signed into over CDP, and ships `browser-harness-mcp` over stdio. |
| [browser-use/cdp-use](https://github.com/browser-use/cdp-use) | 325 | MIT | Worth learning from: a typed CDP wrapper. Python only. |
| [browser-use/fetch-use](https://pypi.org/project/fetch-use/) | — | MIT | **Trap.** It is a client for Browser Use's *hosted* service, not a local fetch library. The GitHub repo 404s. |
| npm `browser-use` | 15 | MIT | **Trap.** An unofficial 15★ community port that pulls in Playwright, canvas and the AWS SDK. |

**Plan.** The MCP client in this codebase already speaks the stdio protocol, so
`browser-harness` is a configuration line, not an integration project:

```
/mcp add browser
```

`browser_get_state` returns a serialised DOM with element indices rather than
screenshots — a few hundred tokens instead of 1,500 per frame. That is the
pattern worth adopting generally: replace a high-dimensional signal with a
compact structured surrogate the model can read directly.

The one thing to get right is the consent moment. `browser-harness` needs
Chrome's remote debugging enabled, and it will drive a browser that is logged
into your accounts. The permission engine should own that gate, and the
warning about "this tab contains your session" should be explicit.

### Video

"video-use" is [browser-use/video-use](https://github.com/browser-use/video-use)
— 29.4k★, MIT, Python. It is a **video editor**, not a video-understanding API,
and it hard-requires `ELEVENLABS_API_KEY`.

But its core idea is the best thing in either repo:

> The LLM never watches the video. It *reads* it.

- Layer 1: a timestamped transcript with speaker diarization and audio events,
  packed into a ~12 KB markdown file. Always loaded.
- Layer 2: a filmstrip + waveform image for a time range, fetched only at
  decision points. "Not a scan tool — use it at decision points."

The alternative is 30,000 frames × 1,500 tokens = **45M tokens of noise**.

| Project | Stars | Licence | Verdict |
| --- | --- | --- | --- |
| [SylphxAI/anymd](https://github.com/SylphxAI/anymd) | 1.0k | MIT | **Use it.** `npx @sylphx/anymd` — one native binary, zero JS dependencies, local Qwen3-ASR, no API key. Frame-level video is a paid Pro feature, but transcript, subtitles and metadata are free. |
| [browser-use/video-use](https://github.com/browser-use/video-use) | 29.4k | MIT | Use as a subprocess for the read-side helpers. Do not embed: it is a script collection, not a library. |
| [kajisho5/ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) | 2.0k | MIT | Editing only, not understanding. Its **SPEC pattern** is worth stealing: the tool schema is derived from the same parser that defines the CLI, and CI fails if they drift. |
| [JazerJu/video-miner](https://github.com/JazerJu/video-miner) | 33 | **none** | **Avoid.** No licence file. Read it for the design; do not ship it. |
| [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut) | 2.5k | **AGPL-3.0** | **Avoid.** Network copyleft. |
| [hypit-ai/hypit](https://github.com/hypit-ai/hypit) | 24.2k | Modified Apache-2.0 | **Avoid.** The modification bans multi-tenant and hosted use — exactly this product's shape. |

**There is no official MCP video server.** The official servers tree has zero
matches for "video"; the ecosystem only has YouTube-transcript wrappers and
video *generation*.

**Plan.** Wire `anymd` in as an MCP server (one config line, like the browser
one) for transcript and subtitle extraction. Then hand-roll the `timeline_view`
equivalent — ffmpeg frame extraction plus a contact sheet and waveform, about
200 lines — so the agent can drill into a moment on demand. Take the
transcript-as-primary-interface principle from `video-use` and drop its
ElevenLabs dependency.

---

## 8. Licence landmines

Embeddable, permissive, safe:

`ast-grep` · `tree-sitter` · `web-tree-sitter` · `node-tree-sitter` ·
`whisper.cpp` · `faster-whisper` · `Kokoro` · `chatterbox` · `speaches` ·
`CodeGraphContext` · `mgrep` · `bolt.diy` · `dyad` (outside `src/pro`) ·
`onlook` · `ink` · `bubbletea` · `lipgloss` · `ratatui` · `apple/container` ·
`E2B` · `mcp-kling` · `black-forest-labs/skills`

Do not embed:

| Project | Why |
| --- | --- |
| `oraios/serena` | GPL-3.0 for the app (the SolidLSP core is MIT, but do not assume) |
| `ComfyUI` | GPL-3.0 — run it as a subprocess instead |
| `AUTOMATIC1111/stable-diffusion-webui` | AGPL-3.0 |
| `piper1-gpl` | GPL-3.0 (the original MIT piper is archived) |
| `fish-speech` | Custom community licence, research-only weights |
| FLUX.1-**dev** and friends | Non-commercial licence |
| `coqui-ai/TTS` | MPL-2.0 code but non-commercial weights, and 2 years stale |
| `daytonaio/daytona` | No licence file in the repo, and it is archived |

---

## 9. Dead or moved — save yourself the search

Several well-known repositories have been renamed, moved, or do not exist at
the paths people quote:

| Quoted path | Reality |
| --- | --- |
| `comfyanonymous/ComfyUI` | → `Comfy-Org/ComfyUI` |
| `ggerganov/whisper.cpp` | → `ggml-org/whisper.cpp` |
| `vadimdenis/ink` | → `vadimdemedes/ink` |
| `tui-rs/ratatui` | → `ratatui/ratatui` |
| `Sourcegraph/scip` | → `scip-code/scip` |
| `black-forest-labs/FLUX.1-schnell` | Does not exist. Weights are on HuggingFace; the licence table is in `black-forest-labs/flux` |
| `Stability-AI/stable-diffusion` | Does not exist. Use `Stability-AI/generative-models` |
| `v0-dev/v0` | Does not exist. The org has zero public repos |
| `tree-sitter/tree-sitter-wasm` | Does not exist. The package is `web-tree-sitter` |

Dead or dormant: `rhasspy/piper` (archived) · `coqui-ai/TTS` ·
`myshell-ai/MeloTTS` · `stackblitz/bolt.new` · `Stability-AI/StableStudio` ·
`daytonaio/daytona` · `199-mcp/mcp-kling` (16 months, predates current models)

---

## Order of work

Ranked by capability gained per unit of risk:

1. **`ast-grep` behind the existing `grep` tool.** One binary, no dependency,
   immediately better than text search. Ships in a day.
2. **Seatbelt sandboxing keyed to the permission ruleset.** The permission
   engine already exists; a profile per rule is a small change and it changes
   the security story completely.
3. **A live preview pane in the browser frontend.** bolt.diy's architecture,
   applied to the frontend that already exists.
4. **Symbol-level navigation** over tree-sitter, with Serena's tool vocabulary.
   This is the real answer to the Cursor gap, and it is the largest piece.
5. **Kokoro for local speech**, so the audio tool works with no account.
6. **ComfyUI + FLUX.1-schnell for local images**, so the image tool works with
   no account.
7. **A first-party Kling skill** in the `black-forest-labs/skills` shape:
   prompt structure plus the correct API call shapes.
8. **`browser-harness` as the browser tool**, and `anymd` plus a hand-rolled
   timeline view for video. Both are configuration lines against the MCP client
   that already exists.

Items 1 and 2 are cheap and change how the agent feels. Item 4 is the one that
makes this competitive with an editor.
