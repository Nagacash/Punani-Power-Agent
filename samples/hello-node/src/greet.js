/**
 * A small greeter used by the Punani powerd sample project.
 */

const DEFAULT_NAME = "world"

export function greet(name = DEFAULT_NAME) {
  return `Hello, ${name}!`
}

export function greetAll(names) {
  return names.map((name) => greet(name)).join("\n")
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${greet(process.argv[2])}\n`)
}
