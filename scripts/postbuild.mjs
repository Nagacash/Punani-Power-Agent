import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Make the built CLI directly executable, and copy non-TypeScript assets.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const entry = path.join(root, "dist", "main.js")

if (!fs.existsSync(entry)) {
  console.error(`postbuild: ${entry} not found. Run "tsc -p tsconfig.json" first.`)
  process.exit(1)
}

const source = fs.readFileSync(entry, "utf8")
if (!source.startsWith("#!")) {
  fs.writeFileSync(entry, `#!/usr/bin/env node\n${source}`)
}
fs.chmodSync(entry, 0o755)

// Copy static assets (the web UI) next to their compiled modules.
function copyAssets(dir) {
  if (!fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    // Skip macOS AppleDouble sidecar files.
    if (name.startsWith("._")) continue
    const from = path.join(dir, name)
    if (fs.statSync(from).isDirectory()) {
      copyAssets(from)
      continue
    }
    if (!name.endsWith(".html") && !name.endsWith(".png") && !name.endsWith(".svg")) continue
    const to = path.join(root, "dist", path.relative(path.join(root, "src"), from))
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.copyFileSync(from, to)
    console.log(`postbuild: copied ${path.relative(root, from)}`)
  }
}

copyAssets(path.join(root, "src"))

// The skills that ship with the app. They are read from disk at runtime, so
// they have to sit next to the compiled code.
const bundled = path.join(root, "bundled")
if (fs.existsSync(bundled)) {
  const to = path.join(root, "dist", "bundled")
  fs.rmSync(to, { recursive: true, force: true })
  try {
    fs.cpSync(bundled, to, { recursive: true })
    console.log("postbuild: copied bundled")
  } catch (error) {
    if (error?.code !== "ENOSPC") throw error
    fs.rmSync(to, { recursive: true, force: true })
    fs.symlinkSync(bundled, to, "dir")
    console.warn("postbuild: disk full — symlinked bundled/ (use a full copy before npm publish)")
  }
} else {
  console.warn("postbuild: no bundled directory, the app ships without its own skills")
}

// The browser UI imports Zustand's framework-agnostic store. Copy the ESM
// build next to the compiled server so the page can import it from /vendor.
const zustand = path.join(root, "node_modules", "zustand", "esm", "vanilla.mjs")
if (fs.existsSync(zustand)) {
  const to = path.join(root, "dist", "web", "vendor", "zustand.js")
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(zustand, to)
  console.log("postbuild: copied zustand/vanilla")
} else {
  console.warn("postbuild: zustand is not installed, the browser UI will fall back to its own store")
}

console.log(`postbuild: ${entry} is executable`)
