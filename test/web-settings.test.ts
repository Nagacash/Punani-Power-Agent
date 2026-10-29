import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { ConfigStore } from "../src/config/store.ts"
import { Settings } from "../src/web/settings.ts"

test("saving a speech key turns on ElevenLabs when still off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-settings-"))
  const file = path.join(dir, "config.json")
  const store = new ConfigStore(file)
  store.load()
  const settings = new Settings(store)

  const result = settings.setAudio({ apiKey: "test-eleven-key" })
  assert.equal(result.ok, true)
  const audio = store.audioSettings()
  assert.equal(audio.provider, "elevenlabs")
  assert.equal(audio.apiKey, undefined)
  assert.equal(store.elevenLabsKey(), "test-eleven-key")
  assert.equal(store.get().apiKeys.elevenlabs, "test-eleven-key")
})

test("saving an image key turns on openai-compatible when still off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-settings-"))
  const file = path.join(dir, "config.json")
  const store = new ConfigStore(file)
  store.load()
  const settings = new Settings(store)

  const result = settings.setImage({ apiKey: "test-image-key", baseURL: "https://example.com/v1" })
  assert.equal(result.ok, true)
  const image = store.imageSettings()
  assert.equal(image.provider, "openai-compatible")
  assert.equal(image.apiKey, "test-image-key")
})
