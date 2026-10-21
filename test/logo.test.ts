import assert from "node:assert/strict"
import { test } from "node:test"
import { LOGO, logoLines } from "../src/ui/logo.ts"
import { banner } from "../src/ui/render.ts"

/**
 * The mark.
 *
 * A terminal cannot show a picture, so the logo is drawn. The banner has to
 * carry it, or the app opens without a face.
 */

test("the mark is a square spiral", () => {
  assert.ok(LOGO.length > 0)
  const widths = LOGO.map((row) => row.length)
  const widest = Math.max(...widths)
  assert.equal(widest, LOGO.length, "the mark should be as wide as it is tall")
  assert.ok(LOGO.some((row) => row.includes("─") || row.includes("│")), "the spiral has strokes")
})

test("the banner carries the mark and the name", () => {
  const written: string[] = []
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: any) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    banner("Punani powerd by Naga Codex", "punani-powerd (main) · session abc")
  } finally {
    process.stdout.write = write
  }
  const output = written.join("")
  assert.match(output, /Punani powerd by Naga Codex/)
  assert.match(output, /session abc/)
  assert.ok(output.includes(LOGO[0]!.trim().slice(0, 4)), "the mark should be in the banner")
})

test("the mark comes back the same every time", () => {
  assert.deepEqual(logoLines(), LOGO)
})
