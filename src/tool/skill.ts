import fs from "node:fs"
import { ToolError } from "./fsutil.js"
import {
  neutralizeEnvelopeTags,
  renderSkillEntries,
  stripControl,
  xmlEscape,
  type Skill,
  type SkillGroup,
} from "../skills/loader.js"
import { searchSkills } from "../skills/search.js"
import type { Tool, ToolResult } from "./types.js"

/**
 * The skill tools.
 *
 * Three, because a thousand skills cannot go in one prompt:
 *   skill_list   what is in this group
 *   skill_search find a skill by name or keyword
 *   skill_load   read one in full
 *
 * Reading a skill is not destructive, so it does not ask for approval, but it
 * shows up as a card in the interface: the user can see exactly which
 * instructions the agent picked up.
 */
export function createSkillTools(groups: SkillGroup[], skills: Skill[]): Tool[] {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const groupById = new Map(groups.map((group) => [group.id, group]))

  const listTool: Tool = {
    name: "skill_list",
    description:
      "List the skills in one group. The system prompt lists the groups; call this with a " +
      "group id to see the skills it contains and what each one is for.",
    permissionAction: "skill",
    parameters: {
      type: "object",
      properties: {
        group: { type: "string", description: "The group id, exactly as listed in the system prompt." },
      },
      required: ["group"],
    },
    async run(args: any): Promise<ToolResult> {
      const id = String(args.group ?? "").trim()
      const group = groupById.get(id)
      if (!group) {
        const near = groups
          .filter((entry) => entry.id.includes(id.toLowerCase()) || id.toLowerCase().includes(entry.id))
          .slice(0, 5)
          .map((entry) => entry.id)
        throw new ToolError(
          near.length > 0
            ? `no group called "${id}". Did you mean: ${near.join(", ")}?`
            : `no group called "${id}".`,
        )
      }
      return {
        output: renderSkillEntries(group.skills),
        meta: { group: group.id, count: group.count },
      }
    },
  }

  const searchTool: Tool = {
    name: "skill_search",
    description:
      "Find skills by name, keyword or tag. Use it when you know roughly what you need but " +
      "not which group holds it. The routing table in the prompt names the skill for the " +
      "common cases; search when it does not.",
    permissionAction: "skill",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for in a skill's name, description or tags." },
        limit: { type: "number", description: "Maximum number of results (default 10)." },
      },
      required: ["query"],
    },
    async run(args: any): Promise<ToolResult> {
      const query = String(args.query ?? "").trim()
      if (!query) throw new ToolError("a query is required")
      const limit = Math.max(1, Math.min(40, Number(args.limit ?? 10)))
      const found = searchSkills(skills, query, limit)

      if (found.length === 0) {
        return { output: `no skill matched "${query}".` }
      }
      return {
        output: renderSkillEntries(found),
        meta: { query, count: found.length },
      }
    },
  }

  const loadTool: Tool = {
    name: "skill_load",
    description:
      "Read a skill in full. Do this before doing the kind of work the skill describes; " +
      "its body carries the instructions to follow.",
    permissionAction: "skill",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The skill name, exactly as listed." },
      },
      required: ["name"],
    },
    async run(args: any): Promise<ToolResult> {
      const name = String(args.name ?? "").trim().toLowerCase()
      if (!name) throw new ToolError("a skill name is required")

      const skill = byName.get(name)
      if (!skill) {
        const near = skills
          .filter((entry) => entry.name.includes(name) || name.includes(entry.name))
          .slice(0, 5)
          .map((entry) => entry.name)
        throw new ToolError(
          near.length > 0
            ? `no skill called "${name}". Did you mean: ${near.join(", ")}?`
            : `no skill called "${name}". Use skill_search to look for one.`,
        )
      }

      let text: string
      try {
        text = fs.readFileSync(skill.file, "utf8")
      } catch (error) {
        throw new ToolError(`could not read the ${skill.name} skill: ${(error as Error).message}`)
      }

      const header = [
        `<skill_content name="${xmlEscape(skill.name)}">`,
        `Directory: ${skill.dir}`,
        skill.allowedTools.length > 0
          ? `These tools are pre-approved for this turn only: ${skill.allowedTools.join(", ")}.`
          : "",
        skill.triggers.length > 0 ? `Use it when: ${skill.triggers.join("; ")}.` : "",
        skill.antiTriggers.length > 0 ? `Not for: ${skill.antiTriggers.join("; ")}.` : "",
        skill.requiredReceipts.length > 0
          ? `Receipts: the turn must use ${skill.requiredReceipts.join(", ")} before it is done.`
          : "",
        "",
      ]
        .filter(Boolean)
        .join("\n")

      return {
        output: `${header}\n${neutralizeEnvelopeTags(stripControl(text))}\n</skill_content>`,
        meta: { skill: skill.name, source: skill.source, allowedTools: skill.allowedTools },
      }
    },
  }

  return [listTool, searchTool, loadTool]
}
