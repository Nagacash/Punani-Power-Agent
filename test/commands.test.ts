import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { initProjectFiles } from "../src/cli/commands/project.ts"
import { collectReviewDiff, reviewPrompt } from "../src/cli/commands/review.ts"
import { SessionStore } from "../src/session/store.ts"

/**
 * The session and project commands.
 *
 * A session can be named, copied and moved. A project can be given the files
 * the agent reads. A review knows what it is looking at.
 */

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test("/init writes the project files, and never overwrites one", () => {
  const root = tempDir("punani-init-")
  const first = initProjectFiles(root)
  assert.deepEqual(first.written, ["guardrails.md", "tool_guidance.md", "memory.md"])
  assert.deepEqual(first.kept, [])

  // The agent reads these on every turn, so they have to be there.
  for (const name of first.written) {
    const file = path.join(root, ".punani", name)
    assert.ok(fs.existsSync(file), `${name} should be written`)
    assert.match(fs.readFileSync(file, "utf8"), /the agent reads this on every turn/i)
  }

  // A second run keeps what is there.
  fs.writeFileSync(path.join(root, ".punani", "memory.md"), "mine\n")
  const second = initProjectFiles(root)
  assert.deepEqual(second.written, [])
  assert.deepEqual(second.kept, ["guardrails.md", "tool_guidance.md", "memory.md"])
  assert.equal(fs.readFileSync(path.join(root, ".punani", "memory.md"), "utf8"), "mine\n")
})

test("a session can be named", () => {
  const sessions = new SessionStore(tempDir("punani-name-"))
  const meta = sessions.create("/tmp/project", "mock", "mock")
  assert.equal(meta.title, "New session")

  sessions.rename(meta, "the sounddrop work")
  assert.equal(meta.title, "the sounddrop work")

  // The name is what the session list shows.
  const listed = sessions.list().find((entry) => entry.id === meta.id)
  assert.equal(listed?.title, "the sounddrop work")
})

test("a session can be forked, with the conversation it had", () => {
  const sessions = new SessionStore(tempDir("punani-fork-"))
  const meta = sessions.create("/tmp/project", "mock", "mock")
  sessions.append(meta, { role: "user", content: "the first question", timestamp: Date.now() })
  sessions.append(meta, { role: "assistant", content: "the first answer", timestamp: Date.now() })

  const fork = sessions.fork(meta)
  assert.notEqual(fork.id, meta.id)
  assert.match(fork.title, /\(fork\)$/)

  const stored = sessions.read(fork.id)!
  assert.equal(stored.messages.length, 2)
  assert.equal(stored.messages[0]!.content, "the first question")
  assert.equal(stored.messages[1]!.content, "the first answer")

  // The fork is a session of its own from now on.
  sessions.append(fork, { role: "user", content: "something else", timestamp: Date.now() })
  assert.equal(sessions.read(meta.id)!.messages.length, 2)
  assert.equal(sessions.read(fork.id)!.messages.length, 3)
})

/** A repository with one commit and one uncommitted change. */
function repoWithChange(): string {
  const root = tempDir("punani-review-")
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "ignore" })
  }
  git(["init", "-q"])
  git(["config", "user.email", "test@example.com"])
  git(["config", "user.name", "Test"])
  fs.writeFileSync(path.join(root, "app.txt"), "first\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "the first commit"])
  fs.writeFileSync(path.join(root, "app.txt"), "second\n")
  return root
}

test("/review looks at the uncommitted changes by default", () => {
  const root = repoWithChange()
  const target = collectReviewDiff(root, "")
  assert.equal(target.label, "the uncommitted changes")
  assert.match(target.diff, /second/)
  assert.equal(target.error, undefined)
})

test("/review can look at a commit", () => {
  const root = repoWithChange()
  const target = collectReviewDiff(root, "commit HEAD")
  assert.equal(target.label, "commit HEAD")
  assert.match(target.diff, /first/)
})

test("/review says what is wrong with the request", () => {
  const root = repoWithChange()
  const unknown = collectReviewDiff(root, "nonsense")
  assert.match(unknown.error ?? "", /unknown target/)

  const missing = collectReviewDiff(root, "commit")
  assert.match(missing.error ?? "", /which commit/)

  // A repository with a commit and nothing changed since.
  const clean = tempDir("punani-clean-")
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: clean, stdio: "ignore" })
  }
  git(["init", "-q"])
  git(["config", "user.email", "test@example.com"])
  git(["config", "user.name", "Test"])
  fs.writeFileSync(path.join(clean, "app.txt"), "as it is\n")
  git(["add", "."])
  git(["commit", "-q", "-m", "the only commit"])
  const empty = collectReviewDiff(clean, "")
  assert.match(empty.error ?? "", /nothing to review/)
})

test("the review prompt carries the diff and asks for findings", () => {
  const root = repoWithChange()
  const target = collectReviewDiff(root, "")
  const prompt = reviewPrompt(target)
  assert.match(prompt, /Review the uncommitted changes/)
  assert.match(prompt, /the file and the line/)
  assert.match(prompt, /second/)
})
