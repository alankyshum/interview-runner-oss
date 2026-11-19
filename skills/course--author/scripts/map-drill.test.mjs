import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./map-drill.mjs", import.meta.url))
const args = [
  "--course",
  "example",
  "--id",
  "chapter-one",
  "--title",
  "Chapter One",
  "--minutes",
  "15",
  "--instructions",
  "Explore the map.",
]
const run = (...extra) =>
  spawnSync(process.execPath, [script, ...args, ...extra], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  })

test("defaults to a map drill with the exact chapter map path", () => {
  const result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    id: "chapter-one",
    title: "Chapter One",
    contentType: "map",
    kind: "scratch",
    estMinutes: 15,
    sourcePath: "mindmaps/example/chapter-one.md",
    instructions: "Explore the map.",
  })
})

test("rejects a request for a reading drill without emitting output", () => {
  const result = run("--content-type", "reading")
  assert.notEqual(result.status, 0)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /reading drills are deprecated.*map/i)
})

test("rejects malformed course and duration without emitting output", () => {
  for (const extra of [
    ["--course", "../bad"],
    ["--minutes", "Infinity"],
  ]) {
    const result = run(...extra)
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, "")
  }
})
