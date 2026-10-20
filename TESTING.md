# Test plan for Punani powerd

Everything below is runnable as written. Work down the list; each step says what
you should see and what breaks if it is wrong.

```
Repo:    /Volumes/MPC_CODE_1/coding/rea ideas/opencode clone/punani-powerd
Config:  ~/.config/punani-powerd/config.json      (mode 0600)
Data:    ~/.local/share/punani-powerd/sessions/    (JSONL)
```

---

## 0. Setup

```bash
cd "/Volumes/MPC_CODE_1/coding/rea ideas/opencode clone/punani-powerd"
npm install
npm run build
npm test          # expect 44 passing
```

**Expect:** `build` clean, `typecheck` clean, `44/44` tests pass.

> **This volume creates AppleDouble `._*` sidecar files.** They break Next's
> Turbopack cache with *"invalid digit found in string"*. Before any dev build
> in `landing/`, run:
> ```bash
> npm run clean:appledouble
> ```

---

## 1. The terminal agent

```bash
node dist/main.js --help
node dist/main.js --version
node dist/main.js --providers
node dist/main.js --models
node dist/main.js --models --free
```

**Expect:** eight providers listed (freellmapi, ollama, lmstudio, openai,
openrouter, nvidia, groq, cerebras), each with a key status and a model count.
`--models` shows live catalogs with context window, tool support and price.

**Breaks if:** a provider shows `0 models` for a remote one that has a key —
the catalog fetch failed. The log is at
`~/.local/state/punani-powerd/punani.log`.

---

## 2. A real turn, end to end

```bash
mkdir -p /tmp/punani-test && cd /tmp/punani-test
echo 'export const answer = 42' > answer.js
node "/Volumes/MPC_CODE_1/coding/rea ideas/opencode clone/punani-powerd/dist/main.js"
```

Then type:

```
What does answer.js contain?
```

**Expect:** the agent calls `read`, the tool output is shown, and the answer
names `42`. The model banner above the prompt shows the name, provider, context
window, tool support and cost.

**Breaks if:** the model answers from memory without calling `read` — the
system prompt is not reaching the provider.

---

## 3. Permissions — the most important behaviour

In the same session:

```
Add a line "// generated" to the end of answer.js
```

**Expect:** a diff appears **before** anything is written, then a permission
card:

```
 EDIT  needs your approval
 ! This action can destroy or overwrite data.
   y once   a always   n reject
```

Type `n`. The file must be **unchanged** and the model must be told it was
declined.

Type `y` on the next attempt. The file changes and the diff shows the `+` line.

**Also test:**

- `a` (always) → the next edit to the same path is **not** asked about
- `n some reason` → the reason reaches the model, which should adapt

**Breaks if:** the file changes before you answer, or `a` still asks.

---

## 4. The shell tool

```
Run: ls -la
```

**Expect:** a permission card for `bash`, then the output.

```
Run: rm -rf /tmp/punani-test
```

**Expect:** the same card **plus** the destructive warning, because the command
matches a destructive pattern.

**Breaks if:** a destructive command runs without the warning.

---

## 5. Skills

```
/skills
```

**Expect:** `926 skill(s) in 108 group(s)`, then the groups, biggest first:
`cloud-security 66`, `threat-hunting 58`, … and `design`.

Then ask the agent:

```
Load the high-end-visual-design skill and follow it
```

**Expect:** a `skill_load` tool call, then a `<skill_content …>` block with the
skill body, and the model behaves differently afterwards.

**Check the prompt cost:** `/context` prints the whole system prompt. The skill
index must be about **1,800 tokens**, not 48,000. If the prompt is enormous,
the grouping is broken.

**Breaks if:** the design skills never appear in the index, or the index carries
every description.

---

## 6. Sessions

```bash
node dist/main.js --resume <id-from-/session>
```

**Expect:** the conversation comes back with its context, and the agent
continues rather than starting over.

Session files are JSONL in `~/.local/share/punani-powerd/sessions/`. Each line
is one message.

**Breaks if:** the resumed session has an empty history.

---

## 7. The browser interface

```bash
node dist/main.js --web
```

**Expect:** the terminal prints a url and a **token on its own line**:

```
  url      http://127.0.0.1:4096
  token    8a808cb3d0e2fa765150fef07d78cf28ceb4ed067e0f0f35ea74ad90030868ba

  Open http://127.0.0.1:4096/?t=8a808cb3…30868ba
```

Open the link. The app loads.

**Then test:**

1. Send a message → the reply streams in
2. Ask for an edit → the diff card and the permission card appear **in the
   browser**, and the same rules apply
3. Click the project pill in the header → the folder browser opens
4. Click **Choose…** → a **native macOS folder dialog** appears. Pick any
   folder, including one on an external drive. The project switches.
5. Click **Settings** → add a key for a provider, save it, reopen Settings.
   The key is stored on disk and **never returned to the browser** — check the
   network response for `/api/settings` and confirm no key value is in it.
6. Switch a key to **"in the browser"** → it goes to `localStorage` under
   `punani.keys`, and the server file does **not** contain it. The request
   still authenticates, because the browser sends it per request.
7. Close Settings → **the cursor must be back in the composer.** Type without
   clicking. (This was a real bug; it is fixed.)
8. Click **Preview** → a live preview pane opens beside the chat, serving the
   project with live reload. Edit a file → the preview reloads by itself.
9. Point the preview bar at `http://localhost:5173` → it frames your dev server.

---

## 8. Media

```bash
node dist/main.js
```
```
Generate an image of a red cube on white
```

**Expect:** a permission card (`image` action), then the file lands in
`assets/generated/` and the model reports the path.

**Kling** needs the `kling` CLI signed in:

```bash
kling login
kling who_am_i
```

**ElevenLabs** needs a key. Set it in the browser under **Settings → Media**,
or:

```
/audio key sk_...
/audio voice
```

**Expect:** the voice catalog loads (it is public, so it works without a key),
and the chosen voice is remembered.

---

## 9. MCP

```
/mcp
```

**Expect:** the configured servers, and how to add one:

```
/mcp add filesystem /Users/you/code
```

Restart and check the tool list. An MCP server's tools appear as
`<server>_<tool>` and are gated by their own `mcp` permission.

**Breaks if:** a server that cannot start stops the agent. It must be reported
and skipped.

---

## 10. The landing page

```bash
cd landing/punani-ai
npm install
npm run clean:appledouble    # see the warning above
npm run dev                  # http://localhost:3000
```

**Expect:** the Punani AI page — cobra **logo** in the header and hero, gold on
black, **Open the app** in the header and hero, **Join the list** (scrolls to
`#join`), the *for-you* / feature / install sections, the **Inner circle** email
waitlist form (Clerk when keys are set), showcase frame under *Built like a paid
product*, and footer **Impressum** / **Datenschutz** → nagacodex.cloud.

**Check the images:** logo and `/media/*.jpg` must render (plain `<img>`, not
Next Image). Showcase uses `/media/showcase-spice.jpg` unless you change it.

**Check the favicon:** layout icons point at `/logo.png` (no separate
`favicon.ico` required).

**Waitlist:** with Clerk keys in `.env.local`, hero **Join the list** → `#join`,
email field + submit → `/thanks`. Without keys, mailto fallback. Google SSO must
stay off in the Clerk dashboard.

`npm run build` must succeed.

---

## 11. Deployment

```bash
npm pack --dry-run     # expect 88 files, no runtime deps beyond zustand
npm publish --dry-run
```

---

## Known issues — expected, not regressions

| Symptom | Cause |
|---|---|
| `freellmapi/auto` errors with *"No candidate model has a configured, usable provider key"* | The router has a key for **Parallel AI**, which serves 0 of its 275 catalog models. Add a key for a platform it does serve: google, openrouter, groq, nvidia, zhipu, mistral. The default is `openrouter/minimax/minimax-m3.1-flash:free`, which works. |
| OpenRouter `:free` models return 429 | The free tier is shared and rate-limited. The alternatives list falls back to paid models for that reason. |
| Waitlist is `mailto:` or submit does nothing | No Clerk keys locally, or **Waitlist** off in Clerk (dev + prod). `npx -y clerk@latest auth login`, `link --app app_3KxiqECH7u1jNM0SF1h9mcckE8K`, `env pull` in `landing/punani-ai`; on Vercel use `pk_live_` / `sk_live_`. |
| Next dev server dies with *"invalid digit found in string"* | AppleDouble files. `npm run clean:appledouble`. |
| `kling` errors with *"Token refresh failed… run `kling login`"* | The Kling CLI session expired. |
| The Impressum shows `[Straße Hausnummer]` | It is a template on nagacodex.cloud and needs a real address. |
| The Datenschutz says no personal data is collected | It is true today, and wrong once Clerk signup is live. It needs a section naming Clerk as the processor. |

---

## Worth checking that is easy to miss

- **Nothing outside the project is readable.** Try to make the agent read
  `/etc/passwd`. It must be refused.
- **A key never lands in a log or a session file.** Search
  `~/.local/state/punani-powerd/punani.log` and
  `~/.local/share/punani-powerd/sessions/` for the key you just typed. It must
  not be there.
- **The web server refuses a foreign origin.** From a page on another site,
  `fetch("http://127.0.0.1:4096/api/state")` must not succeed.
- **Changing the storage dropdown does not wipe what you typed.** Type a key,
  switch the dropdown, and the field must still hold your text.
- **A declined edit writes nothing.** Confirm the file's mtime.
