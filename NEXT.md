# What to do next

Ordered by return on time. Each item says what it is, why it matters, how long
it takes, and what to cut if you run short.

```
Repo:   Punani-Power-Agent (agent) · Punani-AI (landing)
Docs:   EXTENSION-PLAN.md — editor plan in detail
        TESTING.md         — runnable test plan
        ROADMAP.md         — product direction
```

**VS Code extension:** start tomorrow (see §3). Repo baseline: **44/44 tests**, typecheck clean.

---

## Done already

- The agent: tool calling, permissions, diffs, sessions, providers, media tools,
  MCP client, browser UI, skills library, npm package `punani-powerd`.
- **File-mutation seam (`ToolContext.mutate`).** Terminal and browser use
  `diskMutate`; an editor can swap in its own mutator so every change is a
  reviewable diff instead of a silent write. Refusal is explicit (`the change
  was not applied: …`). Verified on disk: apply vs reject paths both behave.
- **Streaming replies.** When the host passes `onEvent`, the LLM client uses SSE
  (with JSON fallback for mocks). Terminal, web UI, and agent emit partial
  assistant text as tokens arrive.
- **Safer default model selection.** Registry skips `freellmapi/auto` and
  `fusion` as defaults; prefers OpenRouter free MiniMax when configured.
  `--init` nudges OpenRouter + `minimax/minimax-m3.1-flash:free` when listed.
- **Landing (partial).** Waitlist via `POST /api/waitlist` (Clerk Backend API),
  email-only signup, deployed from [Punani-AI](https://github.com/Nagacash/Punani-AI).
  GitHub CI + **protected `main`** (PR + review + green checks) on both repos.
- 44 automated tests, one runtime dependency (`zustand` for web state).

---

## 1. ~~Stream the response~~ — shipped

Was ~1 hour; now in `src/llm/client.ts`, `src/agent/agent.ts`, REPL, and web UI.

---

## 2. An engine factory — half a day

The wiring is still split across `src/cli/repl.ts` and `src/web/server.ts`. A third
frontend (VS Code) needs one place.

```ts
// src/engine.ts
export async function createEngine(options: {
  projectRoot: string
  config: ConfigStore
  sessionId?: string
}): Promise<Engine>
```

`Engine.turn({ messages, onEvent, context, signal })` wraps `runAgentTurn` with
the provider registry, skills, MCP servers, and session store already resolved.

**Also:** `buildSystemPrompt` should take an explicit project root (not
`process.cwd()` where that still leaks).

---

## 3. The VS Code extension — 3 days (tomorrow)

Detail in `EXTENSION-PLAN.md`. **Day 1 mutate work is done** — start with the
factory + extension shell.

| Day | What |
| --- | --- |
| 1 | Engine factory (`createEngine`). |
| 2 | Extension shell: manifest, activity-bar view, webview reusing `ui.html` patterns, `postMessage` instead of fetch/SSE. |
| 3 | Editor context + native edits. |
| 4 | Settings, model picker, sessions, package. |

**Day 3 is the payoff** — no custom LSP client:

| Context | Source |
| --- | --- |
| Active file, selection, cursor | `vscode.window.activeTextEditor` |
| Open tabs | `vscode.window.tabGroups` |
| Diagnostics | `vscode.languages.getDiagnostics()` |
| Symbols | `executeDocumentSymbolProvider` |
| References | `executeReferenceProvider` |
| Rename | `executeDocumentRenameProvider` |

**Native edits:** `mutate` → `vscode.workspace.applyEdit()` (~20 lines) for
accept/reject diffs.

---

## 4. Real-model regression tests — 1 day

44 unit tests + mock e2e; browser flow still hand-tested.

- Live suite (OpenRouter free): read, approved edit, declined edit, refused bash.
- Playwright on `punani web`: cards, diff, final answer.
- Optional: `punani verify` to run live checks on demand.

---

## 5. Finish the landing page — half a day

Waitlist **works**; legal/copy still lag deployment.

- **Impressum:** real address on [nagacodex.cloud/impressum.html](https://nagacodex.cloud/impressum.html) (no placeholders).
- **Datenschutz:** section naming **Clerk** as processor for waitlist email; remove “no data via forms” once signup is live.
- Vercel prod: `CLERK_SECRET_KEY` + live Clerk keys; Access mode **Waitlist**, email only.

---

## 6. Small things — an afternoon

| Thing | Status / why |
| --- | --- |
| **Default model in old configs** | Code skips bad defaults; users with `freellmapi/auto` in `config.json` should re-run `--init` or pick OpenRouter free MiniMax. |
| **Shell completions** | `punani completion zsh` |
| **`punani doctor`** | Config, keys, providers, skills, disk |
| **Client retry/backoff** | Router has it; HTTP client does not |
| **Session search** | JSONL, no index — fine until hundreds of sessions |

---

## Ops — disk space

Machine disk was ~**3.1 GB free** (Oct 2026). Heavy items:

- `landing/punani-ai/node_modules` + `.next` (landing is **not** in the agent repo; keep it out of Punani-Power-Agent).
- Skills scan reads large trees under `~/.agents` (~74 MB cited in one run).

Before extension work: `npm run clean` where available, prune old `.next`, avoid duplicating full Next installs on a tight volume.

---

## Deliberately not next

- **SCIP / repo-wide code index** — extension cannot borrow this from VS Code; multi-week, after extension ships.
- **VS Code fork**, **Zed extension** (Rust host → TS sidecar), **multi-agent / MCP-as-server / plugins**.

---

## One line

**Engine factory → VS Code extension → live-model tests → landing legal → polish.**

Streaming and `mutate` are done; the extension is what changes what the product *is*.
