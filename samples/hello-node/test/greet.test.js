import assert from "node:assert/strict"
import { test } from "node:test"
import { greet, greetAll } from "../src/greet.js"

test("greet defaults to world", () => {
  assert.equal(greet(), "Hello, world!")
})

test("greet takes a name", () => {
  assert.equal(greet("Punani"), "Hello, Punani!")
})

test("greetAll joins one line per name", () => {
  assert.equal(greetAll(["a", "b"]), "Hello, a!\nHello, b!")
})
