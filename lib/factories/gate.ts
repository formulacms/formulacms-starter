import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  manifestToRegistrations,
  readManifest,
  syncRegistration,
} from "../blocks/authoring/registration"
import {
  readContentTypeManifest,
  syncContentTypeRegistration,
} from "../content-types/authoring/registration"
import {
  CREATION_RECORD_PATH,
  RECOVER_COMMAND,
  hasCreationRecord,
} from "../content-types/authoring/recovery"
import { definitionProblemLines } from "./definitions"
import {
  findGeneratedFileProblems,
  generatedFilesFailureMessage,
  type GeneratedFileFinding,
} from "../modules/generated-files"

/**
 * The factory gate (ADR-0059, amendment 2026-11-21 (6)). One read-only run of
 * every factory check that ships in the starter: the release-owned generated
 * files, an interrupted content-type creation, the content-type and block
 * definitions, and the block and content-type registrations, which the site
 * owns.
 * It writes nothing, runs every check and reports every failure. It owns the
 * repair text for both file owners. `scripts/check-factories.ts` runs it;
 * the source repository adds the module catalog check
 * (`scripts/check-factories-source.ts`).
 */

/** The shared registries that the site owns (`engine.manifest.json`). */
export type SiteRegistryId = "blocks" | "content-types"

type SiteRegistry = Readonly<{
  id: string
  manifest: string
  regenerate: string
}>

/** One check result; `failure` holds the repair text when the check fails. */
export type FactoryCheck = Readonly<{ name: string; failure?: string }>

const SITE_KINDS: Record<SiteRegistryId, string> = {
  blocks: "block types",
  "content-types": "content types",
}

/** Reads the registry's manifest path and repair command from `engine.manifest.json`. */
export function readSiteRegistry(
  id: SiteRegistryId,
  root = process.cwd()
): SiteRegistry {
  const { sharedRegistries } = JSON.parse(
    readFileSync(join(root, "engine.manifest.json"), "utf8")
  ) as { sharedRegistries?: SiteRegistry[] }
  const registry = sharedRegistries?.find((entry) => entry.id === id)
  if (!registry?.manifest || !registry.regenerate) {
    throw new Error(
      `engine.manifest.json does not name the manifest and the regenerate command of the "${id}" registry.`
    )
  }
  return registry
}

/** What happened to site-owned generated files and what to do, in plain words. */
export function siteFilesFailureMessage(
  id: SiteRegistryId,
  files: readonly string[],
  root = process.cwd()
): string {
  const { manifest, regenerate } = readSiteRegistry(id, root)
  const kinds = SITE_KINDS[id]
  return [
    `These generated files do not match ${manifest}:`,
    ...files.map((file) => `  ${file}`),
    `Your site owns these files. They are generated from your site's ${kinds}.`,
    "To fix it:",
    `  1. Run ${regenerate}.`,
    "  2. Review the changes, then commit them.",
    "  3. Run pnpm check:factories again.",
    `Never restore these files from a release tag. That would remove your site's own ${kinds}.`,
  ].join("\n")
}

/** The release-owned generated files under `root` that are missing or changed. */
export function releaseFileProblems(root = process.cwd()) {
  return findGeneratedFileProblems((file) => {
    const path = join(root, file)
    return existsSync(path) ? readFileSync(path, "utf8") : null
  })
}

/** Gate options; the source repository replaces the release repair text. */
export type FactoryGateOptions = Readonly<{
  releaseFailureMessage?: (findings: readonly GeneratedFileFinding[]) => string
}>

function checkReleaseFiles(
  root: string,
  message = generatedFilesFailureMessage
): string | undefined {
  const findings = releaseFileProblems(root)
  return findings.length > 0 ? message(findings) : undefined
}

// A manifest that does not parse (for example, with merge conflict markers)
// gives an error without a path; name the manifest and its repair.
async function readSiteManifest<T>(
  id: SiteRegistryId,
  root: string,
  read: (root: string) => Promise<T>
): Promise<T> {
  try {
    return await read(root)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const { manifest, regenerate } = readSiteRegistry(id, root)
    throw new Error(
      `Could not read ${manifest}: ${reason}\n  Resolve it, keeping both sides' entries, then run ${regenerate}.`
    )
  }
}

// A half-created content type: the registration advice (content-types:sync)
// would register it, so this row comes first and names the recovery.
function checkInterruptedCreation(root: string): string | undefined {
  if (!hasCreationRecord(root)) return undefined
  return [
    `An earlier pnpm content-type:new run did not finish. Its record is ${CREATION_RECORD_PATH}.`,
    "To fix it:",
    `  1. Run ${RECOVER_COMMAND}. It removes the half-created content type and keeps files you changed since.`,
    "  2. Run pnpm check:factories again.",
    "Do not run pnpm content-types:sync for this: it would register the half-created type.",
  ].join("\n")
}

// The registries' load-time definition check, with the manifest rows. A
// registry that throws while loading fails this row only.
async function checkDefinitions(root: string): Promise<string | undefined> {
  const lines = await definitionProblemLines(root)
  if (lines.length === 0) return undefined
  return [
    "The content-type and block definitions have problems:",
    ...lines,
    "Each line names the type, the field and the rule. To fix it:",
    "  1. Fix the descriptor in convex/lib/contentTypes/ or convex/lib/blocks/, or remove the extra manifest row.",
    "  2. Run pnpm check:factories again.",
  ].join("\n")
}

async function checkBlockFiles(root: string): Promise<string | undefined> {
  const regs = manifestToRegistrations(
    await readSiteManifest("blocks", root, readManifest)
  )
  const { files } = await syncRegistration(regs, { root, dryRun: true })
  return files.length > 0
    ? siteFilesFailureMessage("blocks", files, root)
    : undefined
}

async function checkContentTypeFiles(
  root: string
): Promise<string | undefined> {
  const entries = await readSiteManifest(
    "content-types",
    root,
    readContentTypeManifest
  )
  const { files } = await syncContentTypeRegistration(entries, {
    root,
    dryRun: true,
  })
  return files.length > 0
    ? siteFilesFailureMessage("content-types", files, root)
    : undefined
}

/** Runs one check; a check that cannot run is a failure, not a crash. */
export async function runFactoryCheck(
  name: string,
  run: () => string | undefined | Promise<string | undefined>
): Promise<FactoryCheck> {
  try {
    return { name, failure: await run() }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return {
      name,
      failure: `${name}: the check could not run.\n  ${reason}\nFix the file named above, then run pnpm check:factories again.`,
    }
  }
}

/** Every shipped factory check, in a fixed order. Writes nothing. */
export async function runFactoryChecks(
  root = process.cwd(),
  options: FactoryGateOptions = {}
): Promise<FactoryCheck[]> {
  return [
    await runFactoryCheck("Release-owned generated files", () =>
      checkReleaseFiles(root, options.releaseFailureMessage)
    ),
    await runFactoryCheck("Interrupted content-type creation", () =>
      checkInterruptedCreation(root)
    ),
    await runFactoryCheck("Content-type and block definitions", () =>
      checkDefinitions(root)
    ),
    await runFactoryCheck("Block registration", () => checkBlockFiles(root)),
    await runFactoryCheck("Content-type registration", () =>
      checkContentTypeFiles(root)
    ),
  ]
}

/** The terminal text for a gate run, and whether it passed. */
export function factoryChecksReport(checks: readonly FactoryCheck[]): {
  passed: boolean
  text: string
} {
  const failed = checks.filter((check) => check.failure !== undefined)
  if (failed.length === 0) {
    return {
      passed: true,
      text: `Factory checks passed: ${checks.map(({ name }) => name).join(", ")}.`,
    }
  }
  return {
    passed: false,
    text: [
      ...failed.map(({ failure }) => failure),
      `${failed.length} of ${checks.length} factory checks failed: ${failed.map(({ name }) => name).join(", ")}.`,
    ].join("\n\n"),
  }
}
