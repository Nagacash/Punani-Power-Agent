import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { createAudioTool } from "../src/tool/audio.ts"
import { extensionFor, listVoices } from "../src/provider/elevenlabs.ts"
import { whoAmI } from "../src/provider/kling.ts"
import { diskMutate } from "../src/tool/fsutil.ts"

/**
 * Speech generation.
 *
 * The ElevenLabs endpoint is mocked so the test never spends a credit. The
 * Kling check is read-only: it only reports whether the CLI is signed in.
 */

let mock: http.Server
let projectRoot: string
const originalFetch = globalThis.fetch

before(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "punani-audio-project-"))

  // A short MP3-ish payload is enough to prove the bytes arrive intact.
  const audio = Buffer.from("ID3fake-audio-bytes", "utf8")
  mock = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      if (request.url?.endsWith("/voices")) {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            voices: [
              { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", category: "premade" },
              { voice_id: "CwhRBWXzGAHq8TQ4Fs17", name: "Roger", category: "premade" },
            ],
          }),
        )
        return
      }
      if (request.url?.includes("/text-to-speech/")) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
        if (!request.headers["xi-api-key"]) {
          response.writeHead(401, { "content-type": "application/json" })
          response.end(JSON.stringify({ detail: { message: "no key" } }))
          return
        }
        response.writeHead(200, { "content-type": "audio/mpeg", "x-request-id": "req_1" })
        response.end(audio)
        void body
        return
      }
      response.writeHead(404)
      response.end("{}")
    })
  })
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve))
  const address = mock.address()
  if (!address || typeof address === "string") throw new Error("mock did not bind")
  const port = address.port

  // Point the ElevenLabs helper at the mock.
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input)
    if (url.includes("api.elevenlabs.io")) {
      return await originalFetch(`http://127.0.0.1:${port}${url.replace("https://api.elevenlabs.io/v1", "/v1")}`, init)
    }
    return await originalFetch(input, init)
  }) as typeof fetch
})

after(async () => {
  globalThis.fetch = originalFetch
  await new Promise<void>((resolve) => mock.close(() => resolve()))
})

test("the audio tool writes the speech into the project", async () => {
  const tool = createAudioTool({
    provider: "elevenlabs",
    apiKey: "test-key",
    model: "eleven_multilingual_v2",
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    voiceName: "Sarah",
  })

  let permission: string | undefined
  const result = await tool.run(
    { text: "The first move is what sets everything in motion." },
    {
      projectRoot,
      requestPermission: async (request: any) => {
        permission = request.action
        return { granted: true }
      },
      notify: () => {},
      previewDiff: () => {},
      mutate: diskMutate,
    },
  )

  assert.equal(permission, "audio")
  assert.equal(result.meta?.provider, "elevenlabs")
  const file = path.join(projectRoot, result.meta!.path)
  assert.ok(fs.existsSync(file), "the audio file should be written into the project")
  assert.match(fs.readFileSync(file, "utf8"), /fake-audio-bytes/)
  assert.match(result.output, /bytes of audio\/mpeg/)
})

test("a declined audio request produces no file", async () => {
  const tool = createAudioTool({ provider: "elevenlabs", apiKey: "test-key", voiceId: "v" })
  const before = fs.readdirSync(projectRoot).length
  const result = await tool.run(
    { text: "declined" },
    {
      projectRoot,
      requestPermission: async () => ({ granted: false, message: "no" }),
      notify: () => {},
      previewDiff: () => {},
      mutate: diskMutate,
    },
  )
  assert.equal(result.isError, true)
  assert.equal(fs.readdirSync(projectRoot).length, before)
})

test("the audio tool explains a missing key and a missing voice", async () => {
  const noKey = createAudioTool({ provider: "elevenlabs" })
  await assert.rejects(
    () =>
      noKey.run(
        { text: "x" },
        {
          projectRoot,
          requestPermission: async () => ({ granted: true }),
          notify: () => {},
          previewDiff: () => {},
          mutate: diskMutate,
        },
      ),
    /no ElevenLabs API key/,
  )

  const noVoice = createAudioTool({ provider: "elevenlabs", apiKey: "k" })
  await assert.rejects(
    () =>
      noVoice.run(
        { text: "x" },
        {
          projectRoot,
          requestPermission: async () => ({ granted: true }),
          notify: () => {},
          previewDiff: () => {},
          mutate: diskMutate,
        },
      ),
    /no ElevenLabs voice is set/,
  )
})

test("output formats map to the right extension", () => {
  assert.equal(extensionFor("mp3_44100_128"), "mp3")
  assert.equal(extensionFor("wav_44100"), "wav")
  assert.equal(extensionFor("pcm_16000"), "pcm")
  assert.equal(extensionFor("opus_48000_128"), "opus")
  assert.equal(extensionFor(undefined), "mp3")
})

test("the public voice catalog is readable", async () => {
  const voices = await listVoices(undefined)
  assert.ok(voices.length > 0, "the public catalog should list voices")
  assert.ok(voices[0]!.voiceId.length > 0)
  assert.equal(voices[0]!.name, "Sarah")
})

test("the kling check reports when the cli is missing or signed out", async () => {
  const identity = await whoAmI()
  // Either the CLI is absent, or it is not signed in. Both are reported
  // clearly rather than throwing.
  if (!identity.loggedIn) {
    assert.ok(identity.error, "a signed-out cli should explain why")
  }
})
