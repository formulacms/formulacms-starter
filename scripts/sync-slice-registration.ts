/**
 * Regenerate the slice-registration projection files from
 * `lib/slices/slices.manifest.json` (ADR-0021).
 *
 *   pnpm slices:sync           # rewrite stale generated regions
 *   pnpm slices:sync --check   # exit 1 if any file would change (CI gate)
 */
import {
  manifestToRegistrations,
  readManifest,
  syncRegistration,
} from "../lib/slices/authoring/registration"

async function main() {
  const check = process.argv.includes("--check")
  const regs = manifestToRegistrations(await readManifest())
  const { files } = await syncRegistration(regs, { dryRun: check })

  if (files.length === 0) {
    console.log("Slice registration is up to date.")
    return
  }

  const list = files.map((f) => `  ${f}`).join("\n")
  if (check) {
    console.error(
      `Slice registration is stale — these files would change:\n${list}\n` +
        "Run `pnpm slices:sync` and commit the result."
    )
    process.exit(1)
  }
  console.log(`Regenerated:\n${list}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
