import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { findSourceRepositoryAtOrAbove } from "./source-repository"

/**
 * Upgrade preflight: names each module id that the backend stores as enabled
 * but this release's catalog does not have. One such id makes the backend
 * refuse the whole module state (CMS_MODULE_STATE_INVALID), so the admin and
 * every module stop working. Reads only; it never writes.
 */

/** The Convex table that holds the owner's module choices. */
export const MODULE_STATE_TABLE = "cmsModuleState"

export type ConvexDataResult =
  | Readonly<{ ok: true; stdout: string }>
  | Readonly<{ ok: false; reason: string }>

/**
 * `convex data cmsModuleState` in this folder. It passes no deployment name,
 * URL, `--prod` flag or key: the CLI reads the backend that this site already
 * configures, as `convex env list` does in the same preflight. The command
 * reads stored rows whatever code that backend runs.
 */
export function readModuleStateWithConvexCli(): ConvexDataResult {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "convex",
      "data",
      MODULE_STATE_TABLE,
      "--format",
      "jsonLines",
      "--limit",
      "2",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }
  )
  if (result.error) {
    return {
      ok: false,
      reason: "the Convex CLI did not run (it is not installed, or it timed out)",
    }
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason:
        'the Convex CLI could not read your backend (run "pnpm dev" once, and sign in if it asks)',
    }
  }
  return { ok: true, stdout: result.stdout }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const ROW_FIELDS = new Set(["key", "configurationVersion", "enabledModules"])
const ROW_METADATA = new Set(["_id", "_creationTime"])
const ENTRY_FIELDS = new Set(["moduleId", "configVersion"])

/**
 * The enabled module ids of one stored row, or undefined when the row does not
 * have exactly the stored shape (convex/schema.ts `cmsModuleState`): `key`
 * "owner", a finite `configurationVersion`, and `enabledModules` entries of
 * `{ moduleId: string, configVersion: number }`. Only the system fields `_id`
 * and `_creationTime` may be added.
 */
function storedModuleIds(row: unknown): string[] | undefined {
  if (!isRecord(row)) return undefined
  const keys = Object.keys(row)
  if (
    keys.some((key) => !ROW_FIELDS.has(key) && !ROW_METADATA.has(key)) ||
    ![...ROW_FIELDS].every((key) => keys.includes(key)) ||
    row.key !== "owner" ||
    !isFiniteNumber(row.configurationVersion) ||
    !Array.isArray(row.enabledModules) ||
    ("_id" in row && typeof row._id !== "string") ||
    ("_creationTime" in row && !isFiniteNumber(row._creationTime))
  )
    return undefined
  const ids: string[] = []
  for (const entry of row.enabledModules as unknown[]) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).length !== ENTRY_FIELDS.size ||
      !Object.keys(entry).every((key) => ENTRY_FIELDS.has(key)) ||
      typeof entry.moduleId !== "string" ||
      !isFiniteNumber(entry.configVersion)
    )
      return undefined
    ids.push(entry.moduleId)
  }
  return ids
}

/**
 * Enabled module ids in the stored state that `knownIds` lacks, each once, in
 * stored order. Undefined when there is more than one row, or when a row does
 * not have the stored shape: the check then could not check, never passes.
 */
export function unknownStoredModuleIds(
  rows: readonly unknown[],
  knownIds: ReadonlySet<string>
): string[] | undefined {
  if (rows.length > 1) return undefined
  const unknown: string[] = []
  for (const row of rows) {
    const ids = storedModuleIds(row)
    if (ids === undefined) return undefined
    for (const id of ids) {
      if (!knownIds.has(id) && !unknown.includes(id)) unknown.push(id)
    }
  }
  return unknown
}

/** One JSON object per line; an empty output means no stored row. */
function parseJsonLines(stdout: string): unknown[] | undefined {
  try {
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as unknown)
  } catch {
    return undefined
  }
}

export type StoredModuleCheck = Readonly<{
  status: "passed" | "warning" | "failed"
  message: string
  /** Set when the check could not run; such a result is never a pass. */
  inconclusive?: true
}>

function couldNotCheck(reason: string): StoredModuleCheck {
  return {
    status: "warning",
    inconclusive: true,
    message: `Could not check the modules that your backend stores: ${reason}. Start your backend with "pnpm dev", then run this check again.`,
  }
}

export function checkStoredModuleIds(options: {
  /** The site folder; the check refuses to run in the formulacms source repository. */
  root: string
  /** Module ids in this release's catalog; undefined when the catalog could not be loaded. */
  knownIds: Iterable<string> | undefined
  /** Tests inject the CLI call. */
  read?: () => ConvexDataResult
}): StoredModuleCheck {
  let sourceRepository: string | null
  try {
    sourceRepository = findSourceRepositoryAtOrAbove(
      realpathSync(resolve(options.root))
    )
  } catch {
    return couldNotCheck("this folder could not be read")
  }
  if (sourceRepository !== null) {
    return {
      status: "failed",
      message:
        "This folder is inside the formulacms source repository. The stored-module check reads a site's own backend, so it runs only in your site's folder. Run it there.",
    }
  }
  if (options.knownIds === undefined) {
    return couldNotCheck(
      "the module list in lib/modules/catalog.generated.ts could not be loaded"
    )
  }

  const result = (options.read ?? readModuleStateWithConvexCli)()
  if (!result.ok) return couldNotCheck(result.reason)
  const rows = parseJsonLines(result.stdout)
  if (rows !== undefined && rows.length > 1) {
    return couldNotCheck("your backend stores more than one module settings record")
  }
  const unknown =
    rows && unknownStoredModuleIds(rows, new Set(options.knownIds))
  if (rows === undefined || unknown === undefined) {
    return couldNotCheck(
      "the Convex CLI printed the stored modules in a form this check does not understand"
    )
  }
  if (rows.length === 0) {
    return { status: "passed", message: "No module choices are stored yet." }
  }
  if (unknown.length === 0) {
    return {
      status: "passed",
      message: "Every module that your backend stores as enabled is in this release.",
    }
  }

  const ids = unknown.join(", ")
  return {
    status: "failed",
    message: [
      `Your backend stores modules that this release does not have: ${ids}.`,
      "If you run this release, the site cannot read any module setting, and the admin stops working.",
      "To fix it:",
      '  1. Go back to the code that your site ran before (for example "git merge --abort", or check out your previous commit).',
      `  2. Run "pnpm dev". On Settings › Modules, disable ${ids}, then select Apply.`,
      '  3. Merge the release again, then run "pnpm check:preflight" again.',
      "Build your site's own feature as ordinary application code. Never add a module id to the catalog.",
    ].join("\n"),
  }
}
