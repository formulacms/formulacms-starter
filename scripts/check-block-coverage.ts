/**
 * Block field coverage (ADR-0059, amendment 2026-11-21 (7)). Read-only: it
 * renders each registered block presentation once with populated sample
 * content and checks that every text, rich text and image field carries its
 * page-editor click marker. `pnpm build` runs it after `pnpm check:factories`
 * and before `next build`.
 *
 * Exit 1 only when a completed render shows a field without its marker. A
 * block that cannot load or render is reported as unverified and the build
 * continues; `next build` fails only on an error that it also hits.
 *
 *   pnpm check:blocks:coverage
 */
import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import { resolve as resolvePath } from "node:path"
import { coverageReport } from "../lib/blocks/authoring/coverage-report"

// Same stubs as scripts/verify-block.ts, registered before any renderer
// import: under tsx the Next modules otherwise load as plain objects and
// renderToStaticMarkup throws "Element type is invalid". Next supplies
// `server-only` at build time; here it is an empty module.
const STUBS: Record<string, string> = {
  "next/image": pathToFileURL(
    resolvePath(import.meta.dirname, "verify-block-stubs-image.mjs")
  ).href,
  "next/link": pathToFileURL(
    resolvePath(import.meta.dirname, "verify-block-stubs-link.mjs")
  ).href,
  "server-only": "data:text/javascript,export{}",
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier]
    if (stub) return { url: stub, shortCircuit: true, format: "module" }
    return nextResolve(specifier, context)
  },
})

let report: ReturnType<typeof coverageReport>
try {
  const { checkBlockFieldCoverage } =
    await import("../lib/blocks/authoring/verify-coverage")
  report = coverageReport(await checkBlockFieldCoverage())
} catch (error) {
  report = coverageReport({
    catalogError: error instanceof Error ? error.message : String(error),
  })
}
if (report.passed) {
  console.log(report.text)
} else {
  console.error(report.text)
  process.exit(1)
}
