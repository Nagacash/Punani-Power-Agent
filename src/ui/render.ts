import { style, symbol, truncate, visibleWidth } from "./theme.js"
import { logoLines } from "./logo.js"
import type { ModelInfo } from "../provider/types.js"
import { formatCost } from "../provider/types.js"

/**
 * Rendering helpers.
 *
 * Everything here writes plain text with ANSI colour, so the output stays
 * readable when piped to a file.
 */

/**
 * The opening mark.
 *
 * The name sits beside the logo, and the logo is the mark coiled: a spiral of
 * gold, because a terminal cannot show a picture and a word alone does not
 * look like anything.
 */
export function banner(title: string, subtitle: string): void {
  const mark = logoLines()
  const text = [style.bold(style.white(title)), style.gray(subtitle)]
  const top = Math.max(0, Math.floor((mark.length - text.length) / 2))
  const margin = "  "
  const column = mark[0]?.length ?? 17

  process.stdout.write("\n")
  for (let row = 0; row < mark.length; row++) {
    const line = mark[row] ?? ""
    const beside = row === top ? text[0] : row === top + 1 ? text[1] : undefined
    const gap = beside ? " ".repeat(Math.max(3, column + 3 - line.length)) : ""
    process.stdout.write(`${margin}${style.gold(line)}${gap}${beside ?? ""}\n`)
  }
  const rule = margin + " ".repeat(column + 3) + style.gold("═".repeat(Math.max(title.length, 30)))
  process.stdout.write(`${rule}\n\n`)
}

export function userLine(text: string): void {
  process.stdout.write(`\n${style.green(symbol.chevron)} ${text}\n`)
}

export function assistantLine(text: string): void {
  for (const line of text.split("\n")) {
    process.stdout.write(`${style.blue(symbol.arrow)} ${line}\n`)
  }
}

export function infoLine(text: string): void {
  process.stdout.write(`${style.gray("·")} ${style.gray(text)}\n`)
}

export function warnLine(text: string): void {
  process.stdout.write(`${style.yellow(symbol.warn)} ${text}\n`)
}

export function errorLine(text: string): void {
  process.stdout.write(`${style.red(symbol.cross)} ${text}\n`)
}

export function successLine(text: string): void {
  process.stdout.write(`${style.green(symbol.check)} ${text}\n`)
}

/** One-line summary of a tool call. */
export function toolLine(tool: string, args: Record<string, unknown> | undefined): void {
  const detail = summarizeArgs(tool, args)
  process.stdout.write(`  ${style.gold(symbol.bullet)} ${style.bold(tool)}${detail ? ` ${style.gray(detail)}` : ""}\n`)
}

function summarizeArgs(tool: string, args: Record<string, unknown> | undefined): string {
  if (!args) return ""
  const pick = (key: string): string => {
    const value = args[key]
    return value === undefined || value === null ? "" : String(value)
  }
  switch (tool) {
    case "read":
    case "write":
    case "edit":
      return style.gray(truncate(pick("path"), 70))
    case "grep":
      return style.gray(`/${pick("pattern")}/`)
    case "glob":
      return style.gray(pick("pattern"))
    case "bash":
      return style.gray(truncate(pick("command"), 70))
    default:
      return ""
  }
}

/** The result of a tool call, shown after it completes. */
export function toolResultLine(output: string, isError: boolean): void {
  const lines = output.split("\n")
  const preview = lines.slice(0, 6).join("\n")
  const rest = lines.length > 6 ? `\n${style.gray(`… ${lines.length - 6} more lines`)}` : ""
  const body = `${style.gray("  │")} ${preview.replace(/\n/g, `\n${style.gray("  │")} `)}${rest}`
  process.stdout.write(`${isError ? style.red(body) : body}\n`)
}

/** The model banner shown before a task runs. */
export function modelBanner(model: ModelInfo, providerName: string): void {
  const tools = model.toolSupport ? style.green("tools ✔") : style.yellow("tools ✖")
  const ctx = model.contextWindow >= 1_000_000
    ? `${(model.contextWindow / 1_000_000).toFixed(1)}M`
    : `${Math.round(model.contextWindow / 1000)}k`
  process.stdout.write(
    `${style.gray("model")} ${style.bold(style.white(model.name))} ${style.gray("·")} ` +
      `${style.gold(providerName)} ${style.gray("·")} ${style.gray("ctx")} ${ctx} ${style.gray("·")} ` +
      `${tools} ${style.gray("·")} ${style.gray(formatCost(model.cost))}\n`,
  )
}

/** A table of models, used by /models. */
export function modelTable(models: ModelInfo[], providerName: (id: string) => string): void {
  if (models.length === 0) {
    infoLine("No models found.")
    return
  }
  const rows = models.map((model) => [
    model.id,
    providerName(model.providerID),
    model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1000)}k` : String(model.contextWindow),
    model.toolSupport ? "yes" : "no",
    model.status,
    model.cost.input === 0 && model.cost.output === 0
      ? "free"
      : `$${model.cost.input.toFixed(2)}/$${model.cost.output.toFixed(2)}`,
  ])
  const headers = ["MODEL", "PROVIDER", "CTX", "TOOLS", "STATUS", "COST/1M"]
  const widths = headers.map((header, index) =>
    Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ""))),
  )
  process.stdout.write(`  ${style.gray(headers.map((h, i) => h.padEnd(widths[i]!)).join("  "))}\n`)
  for (const row of rows) {
    const status = row[4] === "active" ? style.green(row[4]!) : style.yellow(row[4]!)
    const tools = row[3] === "yes" ? style.green(row[3]!) : style.red(row[3]!)
    const cells = [
      style.white(row[0]!),
      style.gold(row[1]!),
      style.gray(row[2]!),
      tools,
      status,
      style.gray(row[5]!),
    ]
    process.stdout.write(`  ${cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ")}\n`)
  }
}
