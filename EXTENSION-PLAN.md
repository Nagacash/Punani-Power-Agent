# Hosting the engine in an editor

How to put Punani powerd inside an editor, in a few days. The engine is
already almost ready: `runAgentTurn` is the only public entry point, it takes an
`onEvent` callback, and `ToolContext` is the seam between the agent and
whatever is driving it. The terminal and the browser are two frontends over it;
an editor is a third.

---

## The one thing that has to change

Right now `write`, `edit`, `image` and `audio` write to disk directly
(`src/tool/edit-tools.ts`, `src/tool/image.ts`, `src/tool/audio.ts`). In a
terminal that is right. In an editor it is wrong: the change should appear as a
**reviewable diff in the editor**, which the user can accept, reject, or undo
per hunk. That is most of what makes Cursor feel different from a CLI agent.

So the first task is a file-mutation seam.

```ts
// src/tool/types.ts
export interface FileChange {
  path: string          // absolute
  content: string       // the full new content
  /** What the file looked like before, when known. */
  previous?: string
}

export interface ToolContext {
  // …existing…
  /**
   * Apply a change to a file. The terminal writes it; an editor shows it as a
   * diff and applies it only if the user accepts.
   */
  mutate: (change: FileChange) => Promise<{ applied: boolean; reason?: string }>
}
```

Then:

| Tool | Change |
| --- | --- |
| `write` | `writeTextFile(target, content)` → `await context.mutate({ path, content, previous })` |
| `edit` | same, with `previous` set so the editor can diff it |
| `image` / `audio` | same, with the bytes base64-encoded so a webview can preview them |

A disk-backed default keeps every existing behaviour and every test green:

```ts
// src/tool/disk.ts
export const diskMutator = {
  async mutate(change: FileChange) {
    writeTextFile(change.path, change.content)
    return { applied: true }
  },
}
```

**That is the whole refactor for day one.** It is a few dozen lines and it
changes no agent logic.

One more small thing: `buildSystemPrompt` reads `process.cwd()`
(`src/agent/agent.ts:15`). Make the project root a parameter so the extension
can point it at the workspace folder.

---

## Day 1 — make the core embeddable

**Goal:** a library any host can drive.

1. **Add `mutate` to `ToolContext`** and route the four writing tools through it
   (above). Keep a disk implementation for the terminal and the browser.
2. **Add an engine factory.** Right now the wiring is spread across
   `src/cli/repl.ts` and `src/web/server.ts`. Extract it:

   ```ts
   // src/engine.ts
   export interface EngineOptions {
     projectRoot: string
     config: ConfigStore
     sessionId?: string
   }

   export async function createEngine(options: EngineOptions): Promise<Engine> {
     // provider registry, skills, mcp, session store
     return {
       async turn(input: {
         messages: ChatMessage[]
         signal?: AbortSignal
         onEvent: (event: AgentEvent) => void
         context?: Partial<ToolContext>
       }): Promise<AgentTurnResult> { … }
     }
   }
   ```

   Both frontends then become thin, and the extension gets one clean call.
3. **Run the tests.** They should stay green — the disk mutator preserves the
   old behaviour exactly.

**Done when:** `src/engine.ts` exists, the terminal and the browser both use
it, and `npm test` is still 44/44.

---

## Day 2 — the VS Code extension shell

```
packages/vscode/
├── package.json          the extension manifest
├── src/extension.ts      activate / deactivate
├── src/engine-host.ts    creates the engine, owns the turn
├── src/chat-view.ts      the webview panel
├── src/editor-context.ts the bit that makes it feel native
└── media/                the webview's html, css, js
```

**Manifest** — a view in the activity bar, plus commands:

```json
{
  "contributes": {
    "commands": [
      { "command": "punani.chat",        "title": "Punani: Ask" },
      { "command": "punani.addToChat",   "title": "Punani: Add selection to chat" },
      { "command": "punani.explain",     "title": "Punani: Explain" }
    ],
    "viewsContainers": {
      "activitybar": [{ "id": "punani", "title": "Punani", "icon": "media/logo.png" }]
    }
  }
}
```

**The webview.** Do not write a new UI. `src/web/ui.html` already has the
cards, the diff view, the permission prompt and the model picker — all the
CSS. The only thing to change is the transport: today it calls
`fetch("/api/message")` and listens on an `EventSource`. In the extension,
swap that for a `postMessage` bridge:

```ts
// extension host -> webview
vscode.window.webview.postMessage({ type: "event", event })

// webview -> extension host
webview.onDidReceiveMessage(async (message) => {
  if (message.type === "message") {
    await engine.turn({ messages, onEvent, context: { mutate } })
  }
  if (message.type === "permission") {
    permissionQueue.reply(message.id, message.reply)
  }
})
```

Copy `src/web/ui.html`, keep the styles, replace the two `fetch` call sites and
the `EventSource` with the bridge. That is a couple of hours, not a couple of
days.

**Permission.** The web UI already has the card; the extension host holds the
pending promise, exactly like `src/web/server.ts` does today. Reuse the same
shape — a `Map<id, {resolve}>` and a `/permission` message.

---

## Day 3 — the part that makes it native

This is the day that separates "a chat box in VS Code" from "an agent in your
editor". All of it comes from the extension host, none of it needs an LSP
client — **VS Code already exposes the language server's answers**:

| Context | How to get it |
| --- | --- |
| The active file | `vscode.window.activeTextEditor.document` |
| The selection | `editor.selection` |
| The cursor line | `editor.selection.active.line` |
| The open tabs | `vscode.window.tabGroups` |
| **Diagnostics** | `vscode.languages.getDiagnostics()` — free, no LSP client |
| **Symbols in a file** | `vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", uri)` — free |
| **References** | `vscode.commands.executeCommand("vscode.executeReferenceProvider", uri, position)` — free |
| **Rename** | `vscode.commands.executeCommand("vscode.executeDocumentRenameProvider", …)` — free |

That last four are the Cursor gap, and VS Code hands them to you without you
writing an LSP client at all. You can add them as tools:

```ts
// src/tools/vscode-tools.ts
export function createVscodeTools(): Tool[] {
  return [{
    name: "symbols",
    description: "List the symbols in a file, with their line numbers.",
    permissionAction: "read",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async run(args) {
      const uri = vscode.Uri.file(path)
      const symbols = await vscode.commands.executeCommand(
        "vscode.executeDocumentSymbolProvider", uri,
      )
      return { output: JSON.stringify(symbols, null, 2) }
    },
  }]
}
```

The agent then stops grepping and starts *navigating*. It can find the
definition of a symbol, list what a file defines, and see the errors the
compiler already reported.

**Native edits.** Route `mutate` through VS Code:

```ts
const mutate = async (change: FileChange) => {
  const uri = vscode.Uri.file(change.path)
  const edit = new vscode.WorkspaceEdit()
  const doc = await vscode.workspace.openTextDocument(uri)
  const range = new vscode.Range(0, 0, doc.lineCount, 0)
  edit.replace(uri, range, change.content)
  const ok = await vscode.workspace.applyEdit(edit)
  return { applied: ok }
}
```

The user sees the change as a git-style diff in the editor, with **Accept** and
**Reject** on the file. That is the single most Cursor-like thing in the whole
plan, and it is about twenty lines.

---

## Day 4 — polish and ship

- **Settings panel.** Reuse `src/web/settings.ts` — it is already a clean
  service. Swap the HTTP calls for direct calls. Keys stay out of the webview:
  the extension keeps them in the same 0600 file, or in VS Code's
  `SecretStorage`, which is better still.
- **Model picker** from the live catalogs — `src/provider/catalog.ts` is
  transport-free.
- **Session list and resume** — `src/session/store.ts` is already JSONL.
- **Attach to the current selection** (`punani.addToChat`) and
  `punani.explain` as one-shot commands.
- **Package it.** `vsce package`, publish to the marketplace, or ship a `.vsix`
  for your own machine.

---

## What to cut if you run out of time

In priority order, because each one is worth more than the sum of the ones below
it:

1. **Native edits through `mutate`** — without it the agent writes files behind
   the editor's back and it feels like the CLI in a panel.
2. **Editor context injection** — active file, selection, diagnostics. This is
   what stops the agent asking you to paste a file.
3. **The webview chat** — reuse the existing UI; do not design a new one.
4. **The model picker and settings** — can live in the CLI for now.
5. **Session resume in the editor** — the CLI already does it.

---

## The alternatives, and why this order

| Host | Days | Verdict |
| --- | --- | --- |
| **VS Code extension** | 3–4 | **Do this one.** Biggest audience, no fork to maintain, and VS Code gives you the language server's answers for free. |
| **Desktop shell (Tauri/Electron)** | 1–2 | Cheap, and it is just the browser UI in a window. It is *not* an editor, so it does not close the Cursor gap. Worth doing after, not before. |
| **A VS Code fork (Void, PearAI)** | weeks | You would be maintaining a fork. Do not. |
| **Zed extension** | 5+ | Rust host, so the TypeScript engine would have to run as a sidecar over JSON-RPC — a second process, a second protocol, and a port to get wrong. |

**The honest caveat.** An extension in VS Code gets you most of the way to
Cursor, because Cursor's advantage *is* the editor surface — the cursor, the
selection, the diff view, the language server. Get those and the gap is largely
closed. What you will not have is Cursor's index over the whole repository:
that is a code-intelligence index (SCIP or similar), not an editor feature.
Until that exists, the agent navigates the file it is looking at and the
workspace you point it at, rather than the whole graph.

---

## A rough shape of the extension host

```ts
// packages/vscode/src/engine-host.ts
export class EngineHost {
  private engine?: Engine
  private permissions = new Map<string, (r: { granted: boolean }) => void>()

  async activate(context: vscode.ExtensionContext) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) return
    this.engine = await createEngine({ projectRoot: root, config: new ConfigStore() })
    this.context = context
  }

  /** The mutator that turns the agent's writes into editor diffs. */
  readonly mutate = async (change: FileChange) => {
    const uri = vscode.Uri.file(change.path)
    const edit = new vscode.WorkspaceEdit()
    const doc = await vscode.workspace.openTextDocument(uri)
    edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), change.content)
    return { applied: await vscode.workspace.applyEdit(edit) }
  }

  askPermission(id: string, request: PermissionRequest) {
    return new Promise<{ granted: boolean }>((resolve) => {
      this.permissions.set(id, resolve)
      this.post({ type: "permission", id, request })
    })
  }
}
```

The permission, the diff, the tools, the providers, the skills and the sessions
are all reused. The extension is a new frontend, not a new agent.
