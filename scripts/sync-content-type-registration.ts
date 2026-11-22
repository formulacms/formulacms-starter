import {
  readContentTypeManifest,
  syncContentTypeRegistration,
} from "../lib/content-types/authoring/registration"
import { siteFilesFailureMessage } from "../lib/factories/gate"

const check = process.argv.slice(2).includes("--check")

try {
  const entries = await readContentTypeManifest()
  const result = await syncContentTypeRegistration(entries, {
    dryRun: check,
  })
  if (check && result.files.length > 0) {
    console.error(siteFilesFailureMessage("content-types", result.files))
    process.exit(1)
  }
  console.log(
    result.files.length === 0
      ? "Content-type registration is current."
      : `Updated content-type registration: ${result.files.join(", ")}`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
