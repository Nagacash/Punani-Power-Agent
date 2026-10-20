import fs from "node:fs"
import { diffStats, diffLines } from "./diff.js"
import { ToolError, ensureInsideProject, readTextFile } from "./fsutil.js"
import type { Tool, ToolContext, ToolResult } from "./types.js"

/** Create a file or replace its whole content. */
export const writeTool: Tool = {
  name: "write",
  description:
    "Create a new file or replace the entire content of an existing file. " +
    "For small changes to an existing file prefer `edit`.",
  permissionAction: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root." },
      content: { type: "string", description: "The full new content of the file." },
    },
    required: ["path", "content"],
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    const target = ensureInsideProject(context.projectRoot, String(args.path))
    const content = String(args.content ?? "")
    const existed = fs.existsSync(target.absolute)
    const previous = existed ? readTextFile(target.absolute) : ""

    // Show the user the exact change before anything is written.
    context.previewDiff(target.relative, previous, content)

    const outcome = await context.requestPermission({
      action: "write",
      resource: target.relative,
      summary: existed ? `Replace ${target.relative}` : `Create ${target.relative}`,
      detail: existed
        ? `Overwrites ${previous.split("\n").length} lines with ${content.split("\n").length} lines.`
        : `Creates a new file with ${content.split("\n").length} lines.`,
      destructive: existed,
      alwaysPatterns: [target.relative],
    })
    if (!outcome.granted) {
      return {
        output: `The user declined to write ${target.relative}.${outcome.message ? ` Feedback: ${outcome.message}` : ""}`,
        isError: true,
      }
    }

    const applied = await context.mutate({
      path: target.absolute,
      content,
      previous: existed ? previous : undefined,
      reason: existed ? "update" : "create",
    })
    if (!applied.applied) {
      return {
        output: `The change to ${target.relative} was not applied${applied.reason ? `: ${applied.reason}` : "."}`,
        isError: true,
      }
    }
    const stats = diffStats(previous, content)
    return {
      output: `${existed ? "Updated" : "Created"} ${target.relative} (+${stats.additions} -${stats.deletions})`,
      meta: { path: target.relative, additions: stats.additions, deletions: stats.deletions },
    }
  },
}

/** Replace an exact string inside an existing file. */
export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. The oldString must match the file exactly, " +
    "including whitespace. The user reviews a diff before the change is written.",
  permissionAction: "edit",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project root." },
      oldString: { type: "string", description: "Exact text to replace." },
      newString: { type: "string", description: "Replacement text." },
      replaceAll: { type: "boolean", description: "Replace every occurrence instead of the first." },
    },
    required: ["path", "oldString", "newString"],
  },
  async run(args: any, context: ToolContext): Promise<ToolResult> {
    const target = ensureInsideProject(context.projectRoot, String(args.path))
    if (!fs.existsSync(target.absolute)) {
      throw new ToolError(`file not found: ${target.relative}. Use write to create it.`)
    }
    const oldString = String(args.oldString ?? "")
    const newString = String(args.newString ?? "")
    if (oldString === newString) {
      throw new ToolError("oldString and newString are identical, so there is nothing to change.")
    }
    if (oldString === "") {
      throw new ToolError("oldString must not be empty. Use write to create or replace a file.")
    }

    const content = readTextFile(target.absolute)
    const occurrences = countOccurrences(content, oldString)
    if (occurrences === 0) {
      throw new ToolError(
        `oldString was not found in ${target.relative}. It must match exactly, including whitespace and indentation.`,
      )
    }
    if (occurrences > 1 && args.replaceAll !== true) {
      throw new ToolError(
        `oldString appears ${occurrences} times in ${target.relative}. Add more surrounding context, or set replaceAll to true.`,
      )
    }

    const updated =
      args.replaceAll === true
        ? content.split(oldString).join(newString)
        : content.slice(0, content.indexOf(oldString)) + newString + content.slice(content.indexOf(oldString) + oldString.length)

    // Show the user the exact change before anything is written.
    context.previewDiff(target.relative, content, updated)

    const outcome = await context.requestPermission({
      action: "edit",
      resource: target.relative,
      summary: `Edit ${target.relative}`,
      detail: describeEdit(target.relative, content, updated, occurrences),
      destructive: true,
      alwaysPatterns: [target.relative],
    })
    if (!outcome.granted) {
      return {
        output: `The user declined the edit to ${target.relative}.${outcome.message ? ` Feedback: ${outcome.message}` : ""}`,
        isError: true,
      }
    }

    const applied = await context.mutate({
      path: target.absolute,
      content: updated,
      previous: content,
      reason: "edit",
    })
    if (!applied.applied) {
      return {
        output: `The change to ${target.relative} was not applied${applied.reason ? `: ${applied.reason}` : "."}`,
        isError: true,
      }
    }
    const stats = diffStats(content, updated)
    return {
      output: `Edited ${target.relative} (+${stats.additions} -${stats.deletions}, ${occurrences} replacement${occurrences === 1 ? "" : "s"})`,
      meta: { path: target.relative, additions: stats.additions, deletions: stats.deletions },
    }
  },
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/**
 * A one-line summary of an edit.
 *
 * The full diff is already shown on the tool card, so the permission prompt
 * only needs the shape of the change, not a second copy of it.
 */
export function describeEdit(_relative: string, before: string, after: string, occurrences: number): string {
  const { additions, deletions } = diffLines(before, after)
  const scope = occurrences > 1 ? ` in ${occurrences} places` : ""
  return `${additions} line${additions === 1 ? "" : "s"} added, ${deletions} removed${scope}. The diff is shown above.`
}
