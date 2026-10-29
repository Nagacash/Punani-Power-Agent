import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"

test("legacy audio.apiKey migrates to apiKeys.elevenlabs on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-media-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      permissionsVersion: 2,
      apiKeys: {},
      audio: { provider: "elevenlabs", apiKey: "sk-eleven-test" },
      image: { provider: "kling", apiKey: "sk-eleven-test" },
    }),
  )
  const store = new ConfigStore(file)
  store.load()
  assert.equal(store.elevenLabsKey(), "sk-eleven-test")
  assert.equal(store.audioSettings().apiKey, undefined)
  assert.equal(store.imageSettings().apiKey, undefined)
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.apiKeys.elevenlabs, "sk-eleven-test")
  assert.equal(onDisk.audio.apiKey, undefined)
  assert.equal(onDisk.image.apiKey, undefined)
})
