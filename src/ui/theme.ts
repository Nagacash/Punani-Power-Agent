/** Terminal styling. Plain ANSI, no dependencies. */

const enabled = process.stdout.isTTY === true && process.env.NO_COLOR === undefined

function wrap(code: string): (text: string) => string {
  return (text: string) => (enabled ? `[${code}m${text}[0m` : text)
}

/**
 * The palette is the mark's palette: pure black and antique gold.
 * The gold is the accent everywhere; the rest are the functional colours.
 */
export const style = {
  bold: wrap("1"),
  dim: wrap("2"),
  italic: wrap("3"),
  underline: wrap("4"),
  black: wrap("30"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  magenta: wrap("35"),
  cyan: wrap("36"),
  gray: wrap("90"),
  white: wrap("97"),
  bgRed: wrap("41"),
  bgGreen: wrap("42"),
  bgYellow: wrap("43"),
  bgBlue: wrap("44"),
  bgMagenta: wrap("45"),
  bgCyan: wrap("46"),
  /** The brand gold, sampled from the logo. */
  gold: wrap("38;5;180"),
  goldBright: wrap("38;5;222"),
  goldDim: wrap("38;5;137"),
  bgGold: wrap("48;5;180"),
}

export const symbol = {
  arrow: "→",
  bullet: "•",
  check: "✔",
  cross: "✖",
  warn: "!",
  question: "?",
  chevron: "›",
}

/** Visible width, ignoring ANSI escape sequences. */
export function visibleWidth(text: string): number {
  return text.replace(/\[[0-9;]*m/g, "").length
}

/** Truncate to a width, keeping the tail for paths. */
export function truncate(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text
  if (text.length <= width + 1) return text.slice(0, width)
  return `…${text.slice(text.length - width + 1)}`
}

/** Pad to a width, accounting for ANSI sequences. */
export function pad(text: string, width: number): string {
  const padLength = width - visibleWidth(text)
  return padLength > 0 ? text + " ".repeat(padLength) : text
}

export function hr(width = 60, char = "─"): string {
  return style.gray(char.repeat(width))
}
