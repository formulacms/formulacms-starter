/**
 * Regenerate the block-registration projection files from
 * `lib/blocks/blocks.manifest.json` (ADR-0021).
 *
 *   pnpm blocks:sync           # rewrite stale generated regions
 *   pnpm blocks:sync --check   # exit 1 if any file would change (CI gate)
 */
import {
  manifestToRegistrations,
  readManifest,
  syncRegistration,
} from "../lib/blocks/authoring/registration"
import { siteFilesFailureMessage } from "../lib/factories/gate"

async function main() {
  const check = process.argv.includes("--check")
  const regs = manifestToRegistrations(await readManifest())
  const { files } = await syncRegistration(regs, { dryRun: check })

  if (files.length === 0) {
    console.log("Block registration is up to date.")
    return
  }

  if (check) {
    console.error(siteFilesFailureMessage("blocks", files))
    process.exit(1)
  }
  console.log(`Regenerated:\n${files.map((f) => `  ${f}`).join("\n")}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
