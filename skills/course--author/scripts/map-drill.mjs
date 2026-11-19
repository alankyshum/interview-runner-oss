import { parseArgs } from "node:util"

try {
  const { values } = parseArgs({
    options: {
      course: { type: "string" },
      id: { type: "string" },
      title: { type: "string" },
      minutes: { type: "string" },
      instructions: { type: "string" },
      "content-type": { type: "string", default: "map" },
    },
    strict: true,
  })
  if (values["content-type"] !== "map")
    throw new Error('New reading drills are deprecated; use contentType: "map".')
  if (
    !/^[a-z0-9][a-z0-9-]*$/.test(values.course ?? "") ||
    !/^[a-z0-9][a-z0-9-]*$/.test(values.id ?? "")
  )
    throw new Error("--course and --id must be lowercase alphanumeric/hyphen slugs")
  if (!values.title?.trim() || !values.instructions?.trim())
    throw new Error("--title and --instructions must be non-empty")
  if (
    values.minutes === undefined ||
    !values.minutes.trim() ||
    !Number.isFinite(Number(values.minutes)) ||
    Number(values.minutes) < 0
  )
    throw new Error("--minutes must be a finite non-negative number")
  const drill = {
    id: values.id,
    title: values.title,
    contentType: "map",
    kind: "scratch",
    estMinutes: Number(values.minutes),
    sourcePath: `mindmaps/${values.course}/${values.id}.md`,
    instructions: values.instructions,
  }
  process.stdout.write(`${JSON.stringify(drill, null, 2)}\n`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
