/**
 * Refuses a hand-edited generated file that the formulacms release owns
 * (ADR-0059). The starter `build` runs it before `next build`, and
 * `check:preflight` runs the same check.
 *
 *   pnpm exec tsx scripts/check-generated-files.ts
 */
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  findGeneratedFileProblems,
  generatedFilesFailureMessage,
} from "../lib/modules/generated-files"

const findings = findGeneratedFileProblems((file) => {
  const path = join(process.cwd(), file)
  return existsSync(path) ? readFileSync(path, "utf8") : null
})
if (findings.length > 0) {
  console.error(generatedFilesFailureMessage(findings))
  process.exit(1)
}
console.log("Generated files match the formulacms release.")
