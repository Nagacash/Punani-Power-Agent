import { greet, greetAll } from "./greet.js"

const names = process.argv.slice(2)
process.stdout.write(names.length > 0 ? `${greetAll(names)}\n` : `${greet()}\n`)
