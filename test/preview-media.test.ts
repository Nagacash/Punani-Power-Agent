import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { PreviewServer } from "../src/web/preview.ts"

/**
 * What the agent made.
 *
 * A picture or a clip the turn produced is the thing the user wants to see,
 * so the pane shows it. The file is found by what changed, so it does not
 * matter which tool made it.
 */

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-media-"))
  fs.mkdirSync(path.join(root, "public", "media"), { recursive: true })
  fs.mkdirSync(path.join(root, "node_modules", "junk"), { recursive: true })
  return root
}

test("the newest picture or clip the project grew is found", () => {
  const root = project()
  const preview = new PreviewServer(root)
  const before = Date.now() - 5000

  fs.writeFileSync(path.join(root, "public", "media", "old.png"), "png")
  const older = new Date(before - 5000)
  fs.utimesSync(path.join(root, "public", "media", "old.png"), older, older)

  // Nothing new yet.
  assert.equal(preview.newestMedia(before), undefined)

  const clip = path.join(root, "public", "media", "clip.mp4")
  fs.writeFileSync(clip, "mp4")
  const found = preview.newestMedia(before)
  assert.ok(found, "the clip should be found")
  assert.equal(found.path, "public/media/clip.mp4")
  assert.equal(found.kind, "video")
})

test("the noise in a project is not mistaken for media", () => {
  const root = project()
  const preview = new PreviewServer(root)
  const before = Date.now() - 5000

  fs.writeFileSync(path.join(root, "public", "media", "page.html"), "<html>")
  fs.writeFileSync(path.join(root, "node_modules", "junk", "thing.mp4"), "mp4")
  fs.writeFileSync(path.join(root, "src.ts"), "code")

  assert.equal(preview.newestMedia(before), undefined)
})

test("the pane can be pointed at a file", (t) => {
  const root = project()
  const preview = new PreviewServer(root)
  // The watcher keeps the process alive, so it is stopped at the end.
  t.after(() => preview.disable())

  preview.showFile("public/media/clip.mp4")

  const state = preview.state()
  assert.equal(state.mode, "file")
  assert.equal(state.file, "public/media/clip.mp4")
})
