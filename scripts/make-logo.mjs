import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Make the mark for the terminal.
 *
 * A terminal cannot show a picture, so the logo is drawn: a square spiral
 * with one cell of air between the turns, the way the mark coils around
 * itself. Run this when the mark changes:
 *
 *   npm run logo
 */

const WIDTH = 13
const HEIGHT = 13

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const target = path.join(root, "src", "ui", "logo.ts")

/** The spiral, as the cells it passes through. */
function spiral(width, height) {
  const taken = new Set()
  const key = (x, y) => `${x},${y}`
  let left = 0
  let right = width - 1
  let top = 0
  let bottom = height - 1

  const run = (x0, y0, x1, y1) => {
    const dx = Math.sign(x1 - x0)
    const dy = Math.sign(y1 - y0)
    let x = x0
    let y = y0
    for (;;) {
      taken.add(key(x, y))
      if (x === x1 && y === y1) break
      x += dx
      y += dy
    }
  }

  while (left <= right && top <= bottom) {
    // A ring needs room for the next turn, or the middle comes out broken.
    if (right - left < 2 || bottom - top < 2) break
    run(left, bottom, right, bottom)
    if (top > bottom) break
    run(right, bottom - 1, right, top)
    if (left > right) break
    run(right - 1, top, left, top)
    if (bottom - 2 < top) break
    run(left, top + 1, left, bottom - 2)
    left += 2
    right -= 2
    top += 2
    bottom -= 2
  }
  return taken
}

/** The character for a cell, from the neighbours it connects to. */
function character(taken, x, y) {
  const key = (a, b) => `${a},${b}`
  const has = (dx, dy) => taken.has(key(x + dx, y + dy))
  const right = has(1, 0)
  const left = has(-1, 0)
  const up = has(0, -1)
  const down = has(0, 1)
  if (right && down) return "┌"
  if (left && down) return "┐"
  if (left && up) return "└"
  if (right && up) return "┘"
  if (right || left) return "─"
  return "│"
}

const taken = spiral(WIDTH, HEIGHT)
const grid = Array.from({ length: HEIGHT }, () => new Array(WIDTH).fill(" "))
for (const cell of taken) {
  const [x, y] = cell.split(",").map(Number)
  grid[y][x] = character(taken, x, y)
}

const lines = grid.map((row) => row.join("").replace(/\s+$/, ""))
const module = `/**
 * The mark, coiled.
 *
 * A terminal cannot show a picture, so the emblem is drawn: the gold of the
 * logo on the black of the terminal, a square spiral with one cell of air
 * between the turns, the way the mark coils around itself.
 *
 * Made by scripts/make-logo.mjs. Run \`npm run logo\` when the mark changes.
 */

export const LOGO: string[] = [
${lines.map((line) => `  "${line}",`).join("\n")}
]

/** The mark, ready to print. */
export function logoLines(): string[] {
  return LOGO
}
`

fs.writeFileSync(target, module)
console.log(`wrote ${path.relative(root, target)} (${WIDTH}x${HEIGHT})`)
