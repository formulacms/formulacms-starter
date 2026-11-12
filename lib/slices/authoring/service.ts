import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { REGISTERED_SLICE_TYPES } from "@/convex/lib/slices"
import type { SliceUsageDetail } from "./usage-types"
import { assertAuthoringPath, assertAuthoringPaths } from "./paths"
import {
  deleteSliceType,
  parseSliceSpecJson,
  sliceDeletionSnapshotPaths,
  updateSliceType,
  type DeletedSlice,
  type UpdatedSlice,
} from "./persist"
import { readSliceModelSourceRevision } from "./model-source-revision"
import {
  assertSeedFreeRetirement,
  SeedFreeRetirementError,
} from "./retirement-source"

type FileSnapshot = { path: string; content: Buffer | null }
type SliceDependencyDetail = SliceUsageDetail & {
  savedLocales: string[]
  stagedLocales: string[]
  savedCount: number
  stagedCount: number
  publicationCount?: number
  publicationLocales?: string[]
}

export type SliceRetirementUsage = {
  archived: boolean
  usageCount: number
  savedUsageCount: number
  stagedUsageCount: number
  publicationUsageCount?: number
  pageCount: number
  deletedPageCount: number
  pages: SliceDependencyDetail[]
  contentLocations?: { pageId: string; path: string }[]
}

export type DeleteSliceResult =
  | ({ status: "deleted" } & DeletedSlice)
  | ({ status: "cleanup_pending"; message: string } & DeletedSlice)
  | (Omit<SliceRetirementUsage, "contentLocations"> & {
      status: "blocked"
      reason: "active" | "in_use"
      message: string
    })

export type ReviewedSliceSource = {
  expectedType: string
  expectedSourceRevision: string
}

export class SliceSourceConflictError extends Error {
  constructor() {
    super(
      "The Block Type source changed or is unavailable. Review the current source before trying again. No deletion was performed."
    )
    this.name = "SliceSourceConflictError"
  }
}

/** Trusted adapters must use the caller's ordinary authenticated owner policy.
 * Callers enforce local/owner/installation authority before entering this
 * source-only service; these callbacks are not an authorization bypass. */
export type SliceModelAdapters = {
  readUsage: (type: string) => Promise<{ usageCount: number }>
  runModelGate: (type: string, root: string) => Promise<void>
}

export type SliceRetirementAdapters = {
  assertRetirementAllowed: (type: string) => Promise<unknown>
  /** Must include current owner, publication references, archive and all usage. */
  readRetirementUsage: (type: string) => Promise<SliceRetirementUsage>
  cleanupArchive: (type: string) => Promise<unknown>
  runDeletionGate: (root: string) => Promise<void>
  forceGateFailure?: () => boolean
}

async function fileContent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function snapshotFiles(
  root: string,
  paths: string[]
): Promise<FileSnapshot[]> {
  assertAuthoringPaths(root, paths)
  return Promise.all(
    paths.map(async (path) => ({ path, content: await fileContent(path) }))
  )
}

async function restoreFiles(
  root: string,
  snapshots: FileSnapshot[]
): Promise<void> {
  assertAuthoringPaths(
    root,
    snapshots.map(({ path }) => path)
  )
  await Promise.all(
    snapshots.map(async ({ path, content }) => {
      // The ordinary writers only regenerate/delete existing paths. Preserve
      // null entries rather than manufacture files absent at the baseline.
      if (content !== null) {
        assertAuthoringPath(root, path)
        await writeFile(path, content)
      }
    })
  )
}

async function snapshotIsCurrent(snapshots: FileSnapshot[]): Promise<boolean> {
  const current = await Promise.all(
    snapshots.map(({ path }) => fileContent(path))
  )
  return snapshots.every(({ content }, index) => {
    const next = current[index]
    return content === null
      ? next === null
      : next !== null && next !== undefined && content.equals(next)
  })
}

async function reviewedSourceIsCurrent(
  source: ReviewedSliceSource,
  type: string,
  root: string
) {
  if (
    source.expectedType !== type ||
    !/^[a-f0-9]{64}$/.test(source.expectedSourceRevision ?? "")
  )
    return false
  try {
    return (
      (await readSliceModelSourceRevision(type, root)) ===
      source.expectedSourceRevision
    )
  } catch {
    return false
  }
}

export async function updateSliceModel(
  request: { specJson: string } & ReviewedSliceSource,
  adapters: SliceModelAdapters,
  root = process.cwd()
): Promise<UpdatedSlice | { status: "refused"; reason: "stale_source" }> {
  const spec = parseSliceSpecJson(request.specJson)
  const camel = spec.type.replace(/-([a-z])/g, (_, char: string) =>
    char.toUpperCase()
  )
  const paths = [
    join(root, "convex/lib/slices", `${camel}.ts`),
    join(root, "components/slices", `${spec.type}.tsx`),
    join(root, "lib/slices/builder.ts"),
    join(root, "lib/slices/slices.manifest.json"),
  ]
  assertAuthoringPaths(root, paths)
  const refusal = { status: "refused", reason: "stale_source" } as const
  if (!(await reviewedSourceIsCurrent(request, spec.type, root))) return refusal
  const { usageCount } = await adapters.readUsage(spec.type)
  const snapshots = await snapshotFiles(
    root,
    paths.filter((path) => !path.endsWith(`/${spec.type}.tsx`))
  )
  // Outside rollback: a stale review must not restore over current owner work.
  // No asynchronous backend operation follows this final source reread.
  if (!(await reviewedSourceIsCurrent(request, spec.type, root))) return refusal
  assertAuthoringPaths(root, paths)
  try {
    const result = await updateSliceType(spec, { usageCount }, root)
    await adapters.runModelGate(spec.type, root)
    return result
  } catch (error) {
    await restoreFiles(root, snapshots)
    throw error
  }
}

/** Developer CLI entry point: a reviewed Type and source revision are required. */
export async function deleteReviewedSliceModel(
  source: ReviewedSliceSource,
  adapters: SliceRetirementAdapters,
  root = process.cwd()
): Promise<DeleteSliceResult> {
  return deleteSliceModelForCurrentRequest(
    { type: source.expectedType },
    adapters,
    root,
    source
  )
}

/** Existing local-owner UI requests bind their complete deletion snapshot.
 * CLI callers use deleteReviewedSliceModel to bind a prior source review too. */
export async function deleteSliceModelForCurrentRequest(
  { type }: { type: string },
  adapters: SliceRetirementAdapters,
  root = process.cwd(),
  reviewedSource?: ReviewedSliceSource
): Promise<DeleteSliceResult> {
  if (!(REGISTERED_SLICE_TYPES as readonly string[]).includes(type))
    throw new Error(`Unknown Block Type "${type}".`)
  if (REGISTERED_SLICE_TYPES.length <= 1)
    throw new Error("Create another block before deleting the last one.")
  if (
    reviewedSource &&
    !(await reviewedSourceIsCurrent(reviewedSource, type, root))
  )
    throw new SliceSourceConflictError()
  await assertSeedFreeRetirement(root)
  await adapters.assertRetirementAllowed(type)
  const paths = sliceDeletionSnapshotPaths(type).map((path) => join(root, path))
  assertAuthoringPaths(root, paths)
  const snapshots = await snapshotFiles(root, paths)
  // This is the final asynchronous backend operation before source deletion.
  const usage = await adapters.readRetirementUsage(type)
  const blockerBase = {
    archived: usage.archived,
    usageCount: usage.usageCount,
    savedUsageCount: usage.savedUsageCount,
    stagedUsageCount: usage.stagedUsageCount,
    publicationUsageCount: usage.publicationUsageCount ?? 0,
    pageCount: usage.pageCount,
    deletedPageCount: usage.deletedPageCount,
    pages: usage.pages,
  }
  if (!usage.archived)
    return {
      ...blockerBase,
      status: "blocked",
      reason: "active",
      message: "Archive this Block Type before deleting it.",
    }
  if (usage.usageCount > 0) {
    const trashedNote =
      usage.deletedPageCount > 0 ? ` (${usage.deletedPageCount} trashed)` : ""
    const locationNote = usage.contentLocations?.length
      ? ` Locations: ${usage.contentLocations.map((location) => `${location.pageId}:${location.path}`).join(", ")}.`
      : ""
    return {
      ...blockerBase,
      status: "blocked",
      reason: "in_use",
      message: `This Block Type has ${usage.savedUsageCount} saved and ${usage.stagedUsageCount} staged instance${usage.usageCount === 1 ? "" : "s"} on ${usage.pageCount} Page${usage.pageCount === 1 ? "" : "s"}${trashedNote}. Remove them in the Page editor before deleting the type.${locationNote}`,
    }
  }
  // Local preflights stay outside rollback and after the final backend read.
  // They may refuse newer source/seed work but may never overwrite it.
  await assertSeedFreeRetirement(root)
  assertAuthoringPaths(root, paths)
  if (
    !(await snapshotIsCurrent(snapshots)) ||
    (reviewedSource &&
      !(await reviewedSourceIsCurrent(reviewedSource, type, root)))
  )
    throw new SliceSourceConflictError()
  let result: DeletedSlice
  try {
    result = await deleteSliceType(type, root)
    if (adapters.forceGateFailure?.())
      throw new Error(
        "Verification fixture forced the post-delete typecheck gate to fail."
      )
    await adapters.runDeletionGate(root)
  } catch (error) {
    if (error instanceof SeedFreeRetirementError) throw error
    await restoreFiles(root, snapshots)
    throw error
  }
  try {
    await adapters.cleanupArchive(type)
  } catch {
    return {
      ...result,
      status: "cleanup_pending",
      message:
        "The Block Type code was deleted, but its archived catalog state still needs cleanup. Retry cleanup to finish.",
    }
  }
  return { ...result, status: "deleted" }
}
