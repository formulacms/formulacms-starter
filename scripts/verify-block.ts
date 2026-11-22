import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { resolve as resolvePath } from "node:path"
import { markLocalStateInUse } from "@/lib/local-state/directory"
import { parseVerifyBlockArgs } from "./lib/verify-block-options"

// Redirect next/image + next/link to local stubs BEFORE any import pulls
// render-helpers. Without this, Node's CJS↔ESM interop under tsx exposes the
// Next modules as plain objects, and SSR through renderToStaticMarkup throws
// "Element type is invalid". The verify gate only checks the renderer runs
// without throwing — visual fidelity isn't its job — so plain HTML wrappers
// are faithful enough.
const STUBS: Record<string, string> = {
  "next/image": pathToFileURL(
    resolvePath(import.meta.dirname, "verify-block-stubs-image.mjs")
  ).href,
  "next/link": pathToFileURL(
    resolvePath(import.meta.dirname, "verify-block-stubs-link.mjs")
  ).href,
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub) return { url: stub, shortCircuit: true, format: "module" }
    return nextResolve(specifier, context)
  },
})

// First: the server-start move must not rename local state this run uses
// (diffs land in a fidelity run folder inside it).
markLocalStateInUse(process.cwd())

const [
  { INSTALLED_BLOCK_TYPES },
  { verifyBlock },
  { hasBlockReference },
  { loadReferenceContractFile },
  { verifyBlockAccessibility },
] = await Promise.all([
  import("@/convex/lib/blocks"),
  import("@/lib/blocks/authoring/verify"),
  import("@/lib/blocks/authoring/reference"),
  import("@/lib/blocks/authoring/reference-contract"),
  import("./lib/verify-block-accessibility"),
])

const { allReferenced, contracted, requestedType, candidateDir, skipFidelity } =
  parseVerifyBlockArgs(process.argv.slice(2))

if (
  !allReferenced &&
  !contracted &&
  (!requestedType ||
    !(INSTALLED_BLOCK_TYPES as readonly string[]).includes(requestedType))
) {
  console.error(`Unknown block type: ${requestedType ?? "<missing>"}`)
  process.exit(1)
}

/**
 * `--contracted` enumerates the designs that have an accepted width on record,
 * which is the same set the aggregate command captures. `--all-referenced`
 * enumerates committed image files instead, and still includes designs that
 * have not been migrated yet — useful for diagnosis, not for proof.
 */
async function contractedTypes(): Promise<string[]> {
  const contract = await loadReferenceContractFile()
  if (contract.defects.length > 0) {
    console.error(
      `The accepted design widths could not be read:\n${contract.defects
        .map((defect) => `  - ${defect.type}: ${defect.message}`)
        .join("\n")}`
    )
    process.exit(1)
  }
  const types = [
    ...new Set(
      [...contract.entries.keys()].map((key) =>
        key.slice(0, key.lastIndexOf(":"))
      )
    ),
  ].sort()
  if (types.length === 0) {
    // Checking nothing is not the same as everything being fine.
    console.error(
      "No block design has an accepted width on record, so there was nothing to check."
    )
    process.exit(1)
  }
  return types
}

async function referencedTypes(): Promise<string[]> {
  const checked = await Promise.all(
    INSTALLED_BLOCK_TYPES.map(async (type) => ({
      type,
      hasReference: await hasBlockReference(type),
    }))
  )
  return checked.filter((item) => item.hasReference).map((item) => item.type)
}

const types = contracted
  ? await contractedTypes()
  : allReferenced
    ? await referencedTypes()
    : [requestedType as string]

let failed = false
for (const type of types as (typeof INSTALLED_BLOCK_TYPES)[number][]) {
  const result = await verifyBlock(type, { candidateDir, skipFidelity })
  const accessibility = await verifyBlockAccessibility(type)
  result.failures.push(...accessibility.failures)
  result.warnings.push(...accessibility.warnings)
  result.ok = result.failures.length === 0
  for (const locale of accessibility.checkedLocales) {
    console.log(`${type} accessibility(${locale}): passed`)
  }
  if (result.warnings.length > 0) {
    console.warn(`${type} warnings:\n${result.warnings.join("\n")}`)
  }
  if (!result.ok) {
    console.error(`${type} failures:\n${result.failures.join("\n")}`)
    failed = true
  }
}
if (failed) process.exit(1)
