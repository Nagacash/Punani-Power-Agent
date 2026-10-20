import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

/**
 * The preview pane has to fill the space it is given.
 *
 * The chain is: the shell is a grid, the pane is a grid item, the frame is a
 * flex item of the pane, the core is a flex item of the frame, and the iframe
 * is a flex item of the core. Every link in that chain has to be a flex or
 * grid layout with a definite height, or the iframe falls back to the 150px
 * default an iframe gets when nobody tells it how tall to be.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.join(HERE, "..", "src", "web", "ui.html")

const css = (): string => fs.readFileSync(UI, "utf8")

/** The declaration block for one selector. */
function rule(selector: string): string {
  const html = css()
  const index = html.indexOf(selector)
  assert.ok(index !== -1, `ui.html must have a rule for ${selector}`)
  const open = html.indexOf("{", index)
  let depth = 0
  for (let i = open; i < html.length; i++) {
    if (html[i] === "{") depth++
    else if (html[i] === "}") {
      depth--
      if (depth === 0) return html.slice(open, i + 1)
    }
  }
  return html.slice(open)
}

test("the shell grid row has a definite height", () => {
  const block = rule(".shell {")
  assert.match(block, /grid-template-rows:\s*minmax\(0,\s*1fr\)/)
})

test("the pane is a column flex container", () => {
  const block = rule(".pane {")
  assert.match(block, /flex-direction:\s*column/)
})

test("the frame is a column flex container, so the core can grow inside it", () => {
  const block = rule(".pane .frame {")
  assert.match(block, /display:\s*flex/)
  assert.match(block, /flex-direction:\s*column/)
})

test("the core and the iframe both grow", () => {
  assert.match(rule(".pane .frame > .core {"), /flex:\s*1/)
  assert.match(rule(".pane iframe {"), /flex:\s*1/)
  // And they are allowed to shrink, or a long page cannot be scrolled.
  assert.match(rule(".pane .frame > .core {"), /min-height:\s*0/)
  assert.match(rule(".pane iframe {"), /min-height:\s*0/)
})
