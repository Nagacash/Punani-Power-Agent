# Deploying Punani powerd

Three ways to ship it, from simplest to most involved. All three run the same
binary; the difference is who installs it and where the config lives.

---

## 1. npm (easiest)

```bash
npm publish          # builds and tests first
```

Then anyone can install it:

```bash
npm install -g punani-powerd
punani --init
```

The package is ~80 kB. It has **no runtime dependencies** — only `typescript`,
`tsx` and `@types/node` for building. `prepublishOnly` runs the build and the
test suite, so a broken publish cannot ship.

To try it without publishing:

```bash
npm pack
npm install -g ./punani-powerd-1.0.0.tgz
```

### Verifying a publish

```bash
npm pack --dry-run     # what would be in the tarball
npm publish --dry-run  # everything npm will check
```

---

## 2. GitHub Releases (binaries, no Node required)

Add a workflow that builds a standalone binary per platform. Bun compiles
TypeScript to a single executable, which is the easiest route:

```yaml
# .github/workflows/release.yml
name: release
on:
  push:
    tags: ["v*"]
jobs:
  build:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build:bun
      - uses: actions/upload-artifact@v4
        with:
          name: punani-${{ matrix.os }}
          path: dist/punani
```

The build step is a one-liner on top of the existing build:

```json
"build:bun": "bun build --compile --outfile dist/punani src/main.ts"
```

Users then download one file:

```bash
curl -fsSL https://github.com/<org>/punani-powerd/releases/latest/download/punani-darwin-arm64 -o punani
chmod +x punani
```

---

## 3. Docker (a shared server)

```bash
docker build -t punani-powerd .
docker run --rm -it \
  -p 127.0.0.1:4096:4096 \
  -v "$HOME/.config/punani-powerd:/config" \
  -v "$HOME/.local/share/punani-powerd:/data" \
  punani-powerd
```

The image is small — the CLI is plain Node with no native modules.

---

## The config file

One file holds provider settings, API keys, the permission ruleset and the
image settings:

```
~/.config/punani-powerd/config.json     mode 0600, directory 0700
```

Override the location with `PUNANI_CONFIG`. In Docker that is `/config/config.json`.

### Example

```json
{
  "version": 1,
  "defaultModel": "openrouter/nvidia/nemotron-3.5-super-vl:free",
  "providers": {
    "freellmapi": {
      "id": "freellmapi",
      "kind": "freellmapi",
      "name": "FreeLLMAPI",
      "baseURL": "http://localhost:3001/v1"
    }
  },
  "apiKeys": {
    "openrouter": "sk-or-v1-..."
  },
  "permissions": {
    "read":  [{ "pattern": "*", "effect": "allow" }],
    "search":[{ "pattern": "*", "effect": "allow" }],
    "write": [{ "pattern": "*", "effect": "ask" }],
    "edit":  [{ "pattern": "*", "effect": "ask" }],
    "bash":  [
      { "pattern": "*",          "effect": "ask"  },
      { "pattern": "git status*","effect": "allow" },
      { "pattern": "git diff*",  "effect": "allow" }
    ]
  },
  "image": {
    "provider": "kling",
    "model": "<a model name from `kling who_am_i`>"
  }
}
```

Keys are also read from the environment when the file has none:
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GROQ_API_KEY`,
`CEREBRAS_API_KEY`, `FREELLMAPI_API_KEY`.

---

## Running the browser interface on a server

`punani web` is safe on your own machine. On a shared server, put it behind
your own authentication and TLS — the built-in token is a second lock, not the
only one.

```bash
punani web --host 127.0.0.1 --port 4096
```

```nginx
server {
  listen 443 ssl;
  server_name code.example.com;

  auth_basic           "Punani";
  auth_basic_user_file /etc/nginx/punani.htpasswd;

  location / {
    proxy_pass         http://127.0.0.1:4096;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;

    # The event stream must not be buffered.
    proxy_buffering    off;
    proxy_read_timeout 1h;
  }
}
```

Then open `https://code.example.com/?t=<token>` once to sign in.

**Be deliberate about this.** The agent can run shell commands as the user
that owns the process. Give it a dedicated, unprivileged account with a
container or a VM around it, and never run it as root.

---

## What this is, next to Cursor and Antigravity

Honest answer: it is not an IDE, and it is not trying to be one.

**What it is** — a coding *agent*: a loop that reads, searches, edits, runs
commands and answers, with permission gates and diffs. That is the same shape
as Aider, Cline, Continue, Claude Code and the Codex CLI.

**What it is not** — an editor:

| | Punani powerd | Cursor | Antigravity |
| --- | --- | --- | --- |
| Where it lives | terminal + browser | a VS Code fork | Google's agent-first IDE |
| Inline autocomplete | no | yes | yes |
| Edits inside your editor | no | yes | yes |
| Semantic codebase index | no — it greps | yes | yes |
| `@file` references | no | yes | yes |
| Agent tools + permissions | yes | yes | yes |
| Multi-provider | yes, eight built in | yes | yes |
| Diff before applying | yes | yes | yes |
| Approval gates | yes, per action | yes | yes |
| Sessions you can resume | yes | yes | yes |

The gap is real and it is the interesting one: an agent that lives in your
editor can use the cursor position, the selection, the open tabs, the LSP
diagnostics and the language server's semantic view of the code. A terminal
agent cannot, because none of that is in the terminal.

**Closing that gap** means an editor extension, not more features in the CLI.
The pieces are already in place for it: the agent loop, the tool contract and
the permission engine are all transport-agnostic, so an LSP server or a
VS Code extension could drive the same engine the terminal and the browser do.

Where it already stands on its own terms:

- eight providers, live catalogs, real pricing
- tool calling with a permission gate and a diff preview
- resumable sessions, JSONL, no database to migrate
- a browser frontend over the same engine
- no runtime dependencies
