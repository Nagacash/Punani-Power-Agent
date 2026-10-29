import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { Settings } from "../src/web/settings.ts"

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
  assert.equal(store.mediaKey("kling"), undefined)
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"))
  assert.equal(onDisk.apiKeys.elevenlabs, "sk-eleven-test")
  assert.equal(onDisk.audio.apiKey, undefined)
  assert.equal(onDisk.image.apiKey, undefined)
  assert.equal(onDisk.apiKeys.kling, undefined)
})

test("elevenlabs key is never copied into kling or fal slots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-media-"))
  const file = path.join(dir, "config.json")
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      permissionsVersion: 2,
      apiKeys: { elevenlabs: "sk-eleven", kling: "sk-eleven", fal: "sk-eleven" },
      audio: { provider: "elevenlabs" },
      image: { provider: "kling" },
    }),
  )
  const store = new ConfigStore(file)
  store.load()
  assert.equal(store.mediaKey("kling"), undefined)
  assert.equal(store.mediaKey("fal"), undefined)
})

test("kling and fal keys are stored separately", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-media-"))
  const store = new ConfigStore(path.join(dir, "config.json"))
  store.load()
  const settings = new Settings(store)
  settings.setMediaKey("kling", "kling-only")
  settings.setMediaKey("fal", "fal-only")
  settings.setAudio({ apiKey: "eleven-only" })
  assert.equal(store.mediaKey("kling"), "kling-only")
  assert.equal(store.mediaKey("fal"), "fal-only")
  assert.equal(store.elevenLabsKey(), "eleven-only")
})
