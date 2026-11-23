import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { REGISTERED_BLOCK_TYPES } from "@/convex/lib/blocks"
import type { BlockUsageDetail } from "./usage-types"
import { assertAuthoringPath, assertAuthoringPaths } from "./paths"
import {
  deleteBlockType,
  parseBlockSpecJson,
  blockDeletionSnapshotPaths,
  updateBlockType,
  type DeletedBlock,
  type UpdatedBlock,
} from "./persist"
import { readBlockModelSourceRevision } from "./model-source-revision"
import { readManifest } from "./registration"
import {
  assertSeedFreeRetirement,
  SeedFreeRetirementError,
} from "./retirement-source"

type FileSnapshot = { path: string; content: Buffer | null }
type BlockDependencyDetail = BlockUsageDetail & {
  /** One entry per language: what holds the block there and how many times. */
  uses: { locale: string; status: string; count: number }[]
}

/** The live uses of a Block Type (drafts, the published version, a withdrawn
 * base, Trash, AI copies). Old publish history is not part of it. */
export type BlockRetirementUsage = {
  archived: boolean
  usageCount: number
  /** False when the backend could not finish its scan; never treat as 0 uses. */
  complete: boolean
  /** Retained publish history still holds the type. Only Update reads it. */
  hasHistory: boolean
  pageCount: number
  deletedPageCount: number
  pages: BlockDependencyDetail[]
}

export type DeleteBlockResult =
  | ({ status: "deleted" } & DeletedBlock)
  | ({ status: "cleanup_pending"; message: string } & DeletedBlock)
  | (BlockRetirementUsage & {
      status: "blocked"
      reason: "active" | "in_use"
      message: string
    })
  | { status: "blocked"; reason: "system"; message: string }

export type ReviewedBlockSource = {
  expectedType: string
  expectedSourceRevision: string
}

/** A block with origin "system" (a shipped reference block, or an entry with no
 * origin) can never be deleted. Server action and CLI map `code`. */
export class SystemBlockDeletionError extends Error {
  readonly code = "BLOCK_TYPE_SYSTEM"
  constructor(type: string) {
    super(
      `"${type}" is a system block. System blocks are never deleted; archive it instead.`
    )
    this.name = "SystemBlockDeletionError"
  }
}

export class BlockSourceConflictError extends Error {
  constructor() {
    super(
      "The Block Type source changed or is unavailable. Review the current source before trying again. No deletion was performed."
    )
    this.name = "BlockSourceConflictError"
  }
}

/** Trusted adapters must use the caller's ordinary authenticated owner policy.
 * Callers enforce local/owner/installation authority before entering this
 * source-only service; these callbacks are not an authorization bypass. */
export type BlockModelAdapters = {
  /** `usageCount` is the live uses; `hasHistory` is retained publish history. */
  readUsage: (
    type: string
  ) => Promise<{ usageCount: number; hasHistory: boolean }>
  runModelGate: (type: string, root: string) => Promise<void>
}

export type BlockRetirementAdapters = {
  assertRetirementAllowed: (type: string) => Promise<unknown>
  /** Must include current owner, publication references, archive and all usage. */
  readRetirementUsage: (type: string) => Promise<BlockRetirementUsage>
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
  source: ReviewedBlockSource,
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
      (await readBlockModelSourceRevision(type, root)) ===
      source.expectedSourceRevision
    )
  } catch {
    return false
  }
}

export async function updateBlockModel(
  request: { specJson: string } & ReviewedBlockSource,
  adapters: BlockModelAdapters,
  root = process.cwd()
): Promise<UpdatedBlock | { status: "refused"; reason: "stale_source" }> {
  const spec = parseBlockSpecJson(request.specJson)
  const camel = spec.type.replace(/-([a-z])/g, (_, char: string) =>
    char.toUpperCase()
  )
  const paths = [
    join(root, "convex/lib/blocks", `${camel}.ts`),
    join(root, "components/blocks", `${spec.type}.tsx`),
    join(root, "lib/blocks/builder.ts"),
    join(root, "lib/blocks/blocks.manifest.json"),
  ]
  assertAuthoringPaths(root, paths)
  const refusal = { status: "refused", reason: "stale_source" } as const
  if (!(await reviewedSourceIsCurrent(request, spec.type, root))) return refusal
  // Decision U: a breaking change needs no live use AND no retained history.
  const { usageCount: liveCount, hasHistory } = await adapters.readUsage(
    spec.type
  )
  const usageCount = liveCount + (hasHistory ? 1 : 0)
  const snapshots = await snapshotFiles(
    root,
    paths.filter((path) => !path.endsWith(`/${spec.type}.tsx`))
  )
  // Outside rollback: a stale review must not restore over current owner work.
  // No asynchronous backend operation follows this final source reread.
  if (!(await reviewedSourceIsCurrent(request, spec.type, root))) return refusal
  assertAuthoringPaths(root, paths)
  try {
    const result = await updateBlockType(spec, { usageCount }, root)
    await adapters.runModelGate(spec.type, root)
    return result
  } catch (error) {
    await restoreFiles(root, snapshots)
    throw error
  }
}

/** Developer CLI entry point: a reviewed Type and source revision are required. */
export async function deleteReviewedBlockModel(
  source: ReviewedBlockSource,
  adapters: BlockRetirementAdapters,
  root = process.cwd()
): Promise<DeleteBlockResult> {
  return deleteBlockModelForCurrentRequest(
    { type: source.expectedType },
    adapters,
    root,
    source
  )
}

/** Existing local-owner UI requests bind their complete deletion snapshot.
 * CLI callers use deleteReviewedBlockModel to bind a prior source review too. */
export async function deleteBlockModelForCurrentRequest(
  { type }: { type: string },
  adapters: BlockRetirementAdapters,
  root = process.cwd(),
  reviewedSource?: ReviewedBlockSource
): Promise<DeleteBlockResult> {
  if (!(REGISTERED_BLOCK_TYPES as readonly string[]).includes(type))
    throw new Error(`Unknown Block Type "${type}".`)
  if (REGISTERED_BLOCK_TYPES.length <= 1)
    throw new Error("Create another block before deleting the last one.")
  // Before any backend call or file work: an absent origin means "system".
  const entry = (await readManifest(root)).find((e) => e.type === type)
  if ((entry?.origin ?? "system") === "system")
    throw new SystemBlockDeletionError(type)
  if (
    reviewedSource &&
    !(await reviewedSourceIsCurrent(reviewedSource, type, root))
  )
    throw new BlockSourceConflictError()
  await assertSeedFreeRetirement(root)
  await adapters.assertRetirementAllowed(type)
  const paths = blockDeletionSnapshotPaths(type).map((path) => join(root, path))
  assertAuthoringPaths(root, paths)
  const snapshots = await snapshotFiles(root, paths)
  // This is the final asynchronous backend operation before source deletion.
  const usage = await adapters.readRetirementUsage(type)
  const blockerBase = {
    archived: usage.archived,
    usageCount: usage.usageCount,
    complete: usage.complete,
    hasHistory: usage.hasHistory,
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
  if (!usage.complete)
    return {
      ...blockerBase,
      status: "blocked",
      reason: "in_use",
      message:
        "The backend could not finish checking where this Block Type is used (too many pages or AI jobs). Nothing was deleted.",
    }
  if (usage.usageCount > 0) {
    const trashedNote =
      usage.deletedPageCount > 0
        ? ` (${usage.deletedPageCount} in Trash or being erased)`
        : ""
    return {
      ...blockerBase,
      status: "blocked",
      reason: "in_use",
      message: `This Block Type is still used ${usage.usageCount} time${usage.usageCount === 1 ? "" : "s"} on ${usage.pageCount} Page${usage.pageCount === 1 ? "" : "s"}${trashedNote}: in drafts, published versions, withdrawn versions, Trash or unreviewed AI suggestions. Remove each use before deleting the type.`,
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
    throw new BlockSourceConflictError()
  let result: DeletedBlock
  try {
    result = await deleteBlockType(type, root)
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
