/**
 * The mark, coiled.
 *
 * A terminal cannot show a picture, so the emblem is drawn: the gold of the
 * logo on the black of the terminal, a square spiral with one cell of air
 * between the turns, the way the mark coils around itself.
 *
 * Made by scripts/make-logo.mjs. Run `npm run logo` when the mark changes.
 */

export const LOGO: string[] = [
  "┌───────────┐",
  "│           │",
  "│ ┌───────┐ │",
  "│ │       │ │",
  "│ │ ┌───┐ │ │",
  "│ │ │   │ │ │",
  "│ │ │   │ │ │",
  "│ │     │ │ │",
  "│ │ ────┘ │ │",
  "│         │ │",
  "│ ────────┘ │",
  "            │",
  "────────────┘",
]

/** The mark, ready to print. */
export function logoLines(): string[] {
  return LOGO
}
