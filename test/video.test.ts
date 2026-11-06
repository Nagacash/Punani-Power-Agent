import assert from "node:assert/strict"
import { test } from "node:test"
import { createVideoTool, resolveVideoOutputPath } from "../src/tool/video.ts"
import type { ToolContext } from "../src/tool/types.ts"

test("resolveVideoOutputPath nests under output dir", () => {
  assert.equal(resolveVideoOutputPath("assets/generated", undefined, "x.mp4"), "assets/generated/x.mp4")
  assert.equal(resolveVideoOutputPath("assets/generated", "custom.mp4", "x.mp4"), "assets/generated/custom.mp4")
})

test("video tool is not configured without provider", async () => {
  const tool = createVideoTool(() => ({ provider: "none" }))
  await assert.rejects(
    () =>
      tool.run(
        { prompt: "a cat" },
        {
          projectRoot: "/tmp/p",
          requestPermission: async () => ({ granted: true }),
          notify: () => {},
          previewDiff: () => {},
          mutate: async () => ({ applied: true }),
        } as ToolContext,
      ),
    /not configured/,
  )
})
