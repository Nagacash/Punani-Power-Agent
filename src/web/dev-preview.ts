import fs from "node:fs"
import path from "node:path"

export interface DevPreviewTarget {
  url: string
  label: string
  /** Hint shown when the dev server is not running yet. */
  startCommand: string
}

/**
 * Guess which local dev URL fits this project (Next, Vite, etc.).
 * Used for "Open dev tab" like Cursor's browser preview pop-out.
 */
export function devPreviewTargets(projectRoot: string): DevPreviewTarget[] {
  const pkgPath = path.join(projectRoot, "package.json")
  if (!fs.existsSync(pkgPath)) return []

  let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
  } catch {
    return []
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const devScript = String(pkg.scripts?.dev ?? "")
  const targets: DevPreviewTarget[] = []

  const hasNext = Boolean(deps.next) || devScript.includes("next")
  const hasVite = Boolean(deps.vite) || devScript.includes("vite")
  const hasAstro = Boolean(deps.astro) || devScript.includes("astro")

  if (hasNext) {
    targets.push({
      url: "http://localhost:3000",
      label: "Next.js",
      startCommand: "npm run dev",
    })
  }
  if (hasVite && !hasNext) {
    targets.push({
      url: "http://localhost:5173",
      label: "Vite",
      startCommand: "npm run dev",
    })
  }
  if (hasAstro) {
    targets.push({
      url: "http://localhost:4321",
      label: "Astro",
      startCommand: "npm run dev",
    })
  }

  if (targets.length === 0 && devScript) {
    targets.push({
      url: "http://localhost:3000",
      label: "Dev server",
      startCommand: "npm run dev",
    })
  }

  return targets
}
