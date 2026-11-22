/**
 * Create a content type from a spec (ADR-0059 amendment (8)).
 *
 *   pnpm content-type:new -- --spec <content-type.json> [--dry-run]
 *   pnpm content-type:new -- --recover
 *
 * The files are written under a recovery record
 * (`.formulacms/local/content-type-new.pending.json`). `--recover` removes a
 * half-created type from an interrupted run and keeps files changed since.
 *
 * Test hook: FORMULACMS_CONTENT_TYPE_NEW_KILL_AFTER_WRITES=<n> kills this
 * process (SIGKILL) after n file writes, to prove recovery from a real
 * interruption. Never set it in normal use.
 */
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { generateContentType } from "../lib/content-types/authoring/generate"
import {
  ContentTypeCreationError,
  RECOVER_COMMAND,
  recoverContentTypeCreation,
  recoveryReport,
} from "../lib/content-types/authoring/recovery"
import { parseContentTypeSpecJson } from "../lib/content-types/authoring/spec"

function usage(): never {
  console.error(
    [
      "Usage: pnpm content-type:new -- --spec <content-type.json> [--dry-run]",
      `       ${RECOVER_COMMAND}`,
    ].join("\n")
  )
  process.exit(1)
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

const args = process.argv.slice(2)
const killAfter = Number(
  process.env.FORMULACMS_CONTENT_TYPE_NEW_KILL_AFTER_WRITES ?? Number.NaN
)

if (args.includes("--recover")) {
  try {
    const result = await recoverContentTypeCreation()
    if (!result) {
      console.log("No interrupted content-type creation was found.")
      process.exit(0)
    }
    const { ok, text } = recoveryReport(result)
    if (!ok) {
      console.error(text)
      process.exit(1)
    }
    console.log(text)
    process.exit(0)
  } catch (error) {
    console.error(message(error))
    process.exit(1)
  }
}

const specIndex = args.indexOf("--spec")
const specPath = specIndex === -1 ? undefined : args[specIndex + 1]
if (!specPath) usage()

try {
  const source = await readFile(resolve(specPath), "utf8")
  const spec = parseContentTypeSpecJson(source)
  const dryRun = args.includes("--dry-run")
  const plan = await generateContentType(spec, {
    dryRun,
    afterWrite: (written) => {
      if (written === killAfter) process.kill(process.pid, "SIGKILL")
    },
  })

  console.log(
    `${dryRun ? "Would create" : "Created"} content type "${plan.type}":`
  )
  for (const file of plan.files) console.log(`- ${file.path}`)
  if (!dryRun) {
    console.log("Next: pnpm exec convex codegen --typecheck disable")
    console.log(`Then: pnpm content-type:verify -- ${plan.type}`)
    console.log("Finally: pnpm typecheck")
  }
} catch (error) {
  console.error(message(error))
  if (error instanceof ContentTypeCreationError) {
    console.error(
      error.recovery
        ? recoveryReport(error.recovery).text
        : `The files could not be restored: ${message(error.recoveryError)}\nRun ${RECOVER_COMMAND}.`
    )
  }
  process.exit(1)
}
