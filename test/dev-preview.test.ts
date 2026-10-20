import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { devPreviewTargets } from "../src/web/dev-preview.js"

test("devPreviewTargets detects Next.js", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-dev-"))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "next dev" }, dependencies: { next: "16.0.0" } }),
  )
  const targets = devPreviewTargets(root)
  assert.equal(targets.length, 1)
  assert.equal(targets[0]!.url, "http://localhost:3000")
})

test("devPreviewTargets detects Vite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "punani-dev-"))
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6.0.0" } }),
  )
  const targets = devPreviewTargets(root)
  assert.equal(targets[0]!.url, "http://localhost:5173")
})
