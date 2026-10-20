import { execFileSync } from "node:child_process"

/**
 * Check what the package would publish.
 *
 * npm refuses anything over 100 MB, and it says so in a way that looks like
 * a registry problem rather than a packaging problem. This catches the
 * obvious causes before the publish: a compiled binary, a release archive or
 * a build directory that ended up in the package.
 *
 * The rule is simple: the npm package is the JavaScript CLI. Binaries are
 * for the GitHub release.
 */

/** Anything bigger than this in the package is a mistake. */
const MAX_FILE_BYTES = 5 * 1024 * 1024
/** npm's own limit is 100 MB, but a package that big is never what we meant. */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024

/** Files that are never part of the npm package. */
const FORBIDDEN = [/\.(tgz|tar\.gz|zip|exe|dmg|deb|rpm|appimage)$/i, /(^|\/)pkg\//]

// --ignore-scripts: the build has already run, and the lifecycle script's
// own output would otherwise be mixed into the JSON.
const raw = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
})
const start = raw.indexOf("[")
const report = JSON.parse(raw.slice(start))[0] ?? {}
const files = report.files ?? []
const unpacked = report.unpackedSize ?? 0

const problems = []

for (const file of files) {
  const name = file.path ?? ""
  if (FORBIDDEN.some((pattern) => pattern.test(name))) {
    problems.push(`${name} is a build artifact and does not belong in the npm package`)
  }
  if ((file.size ?? 0) > MAX_FILE_BYTES) {
    problems.push(`${name} is ${(file.size / 1024 / 1024).toFixed(1)} MB, which is too big to be part of the CLI`)
  }
}

if (unpacked > MAX_TOTAL_BYTES) {
  problems.push(
    `the package unpacks to ${(unpacked / 1024 / 1024).toFixed(1)} MB, over the ${MAX_TOTAL_BYTES / 1024 / 1024} MB limit for this package`,
  )
}

if (problems.length > 0) {
  console.error("The package is not ready to publish:")
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error("\nThe npm package is the JavaScript CLI. Binaries belong in the GitHub release.")
  process.exit(1)
}

console.log(`package is fine: ${files.length} files, ${(unpacked / 1024 / 1024).toFixed(1)} MB unpacked`)
