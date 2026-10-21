/**
 * A spinner for the terminal.
 *
 * The agent is often quiet for a while: a model that thinks, a tool that
 * runs, a provider that queues. Silence reads as a hang, so the spinner
 * says the turn is still alive.
 */

import { style, visibleWidth } from "./theme.js"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const INTERVAL_MS = 80

/** Only an interactive terminal gets a spinner. Piped output stays clean. */
const enabled = process.stdout.isTTY === true

let timer: NodeJS.Timeout | undefined
let label = ""
let width = 0

/** Draw one frame of the spinner. */
function render(frame: number): void {
  const text = `${style.gold(FRAMES[frame]!)} ${style.gray(label)}`
  process.stdout.write(`\r${text}`)
  width = visibleWidth(text)
}

/** Start the spinner. Starting an already running one just changes the label. */
export function startSpinner(text: string): void {
  if (!enabled) return
  label = text
  if (timer) return
  render(0)
  let frame = 0
  timer = setInterval(() => {
    frame = (frame + 1) % FRAMES.length
    render(frame)
  }, INTERVAL_MS)
  timer.unref?.()
}

/** Change what the spinner says, without interrupting it. */
export function setSpinnerLabel(text: string): void {
  if (!enabled) return
  label = text
}

/** Stop the spinner and clear the line it drew. */
export function stopSpinner(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  if (!enabled) return
  if (width > 0) {
    process.stdout.write(`\r${" ".repeat(width)}\r`)
    width = 0
  }
  label = ""
}
