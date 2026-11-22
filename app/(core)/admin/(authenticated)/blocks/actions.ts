"use server"

import { revalidatePath } from "next/cache"
import { api } from "@/convex/_generated/api"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import {
  fetchAuthMutation,
  fetchAuthQuery,
  requireAuth,
} from "@/lib/auth/server"
import { requireInstallationOwner } from "@/lib/owner-server"
import { REGISTERED_BLOCK_TYPES } from "@/convex/lib/blocks"
import type { BlockPresentationCatalog } from "@/convex/lib/blocks/presentationResolution"
import type { RenamedBlock, UpdatedBlock } from "@/lib/blocks/authoring/persist"
import { runBlockGate, runTypecheckGate } from "./gate"
import { shouldForceBlockDeletionGateFailure } from "@/lib/blocks/verification"
import { readBlockModelSourceRevision } from "@/lib/blocks/authoring/model-source-revision"

function assertLocalBlockWrite(): void {
  assertLocalDevelopment("Block edits")
}

import type { DeleteBlockResult } from "@/lib/blocks/authoring/service"
export type { DeleteBlockResult } from "@/lib/blocks/authoring/service"

// Deferred on purpose: the authoring graph is heavy (it pulls in the scaffolder
// and its template fs work) and is only ever reachable in local development, so
// it stays in a lazy chunk behind the gate above rather than loading with this
// action module. It must NOT carry `turbopackIgnore` — that leaves the "@/"
// alias in the emitted chunk for raw Node to resolve, which throws
// "Cannot find package '@/lib'" at call time.
async function loadBlockAuthoring() {
  assertLocalBlockWrite()
  return import("@/lib/blocks/authoring/persist")
}

async function loadBlockService() {
  assertLocalBlockWrite()
  return import("@/lib/blocks/authoring/service")
}

/**
 * Archive or restore a Block Type through authorized development tools only.
 * The consolidated implementation plan's R0 record (Type archive/reactivate)
 * makes this unavailable in production in release 1, even when called by ID.
 */
export async function setBlockArchivedAction({
  type,
  archived,
}: {
  type: string
  archived: boolean
}): Promise<void> {
  await requireAuth("Sign in to manage blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  await fetchAuthMutation(api.cms.blockLibrary.setBlockArchived, {
    type,
    archived,
  })
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${type}`)
}

/** Curate presentation choices through the trusted effective catalog. */
export async function setPresentationArchivedAction(args: {
  type: string
  presentationId: string
  archived: boolean
  expectedCatalogRevision: string
}): Promise<BlockPresentationCatalog> {
  await requireAuth("Sign in to manage blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const catalog = await fetchAuthMutation(
    api.cms.blocks.setPresentationArchived,
    args
  )
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${args.type}`)
  return catalog
}

/**
 * Mark or unmark a block type for shipping to formulacms-starter (engine-only
 * curation). Writes the committed `scripts/starter/ship-list.json` selection —
 * a release-generation input, deliberately kept out of the starter (ADR-0025),
 * so this is a local-development file write like rename/delete, but without the
 * typecheck/rollback gates since it only edits a string array.
 */
export async function setStarterShippedAction({
  type,
  shipped,
}: {
  type: string
  shipped: boolean
}): Promise<void> {
  await requireAuth("Sign in to manage blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner(
    "Only the installation owner can curate starter Block Types."
  )
  const { setStarterShipped } = await import("@/lib/blocks/starter-ship")
  await setStarterShipped(type, shipped)
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${type}`)
}

export async function renameBlockAction({
  type,
  label,
}: {
  type: string
  label: string
}): Promise<RenamedBlock> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { renameBlockMetadata } = await loadBlockAuthoring()

  const result = await renameBlockMetadata(type, label)

  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${result.type}`)

  return result
}

export async function deleteBlockAction({
  type,
}: {
  type: string
}): Promise<DeleteBlockResult> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { deleteBlockModelForCurrentRequest } = await loadBlockService()
  const result = await deleteBlockModelForCurrentRequest(
    { type },
    {
      assertRetirementAllowed: (type) =>
        fetchAuthQuery(api.cms.blockLibrary.assertBlockTypeRetirementAllowed, {
          type,
        }),
      readRetirementUsage: (type) =>
        fetchAuthQuery(api.cms.blockLibrary.getBlockUsageSummary, {
          type,
          forRetirement: true,
        }),
      cleanupArchive: (type) =>
        fetchAuthMutation(api.cms.blockLibrary.cleanupDeletedBlockTypeArchive, {
          type,
        }),
      runDeletionGate: () => runTypecheckGate(),
      forceGateFailure: shouldForceBlockDeletionGateFailure,
    },
    process["cwd"]()
  )
  if (result.status === "blocked") return result
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${result.type}`)
  revalidatePath(`/block-sim/${result.type}`)
  return result
}

export async function retryBlockDeletionCleanupAction({
  type,
}: {
  type: string
}): Promise<void> {
  await requireAuth("Sign in to finish deleting this Block Type.")
  assertLocalBlockWrite()
  await requireInstallationOwner(
    "Only the installation owner can finish deleting Block Types."
  )
  await fetchAuthMutation(api.cms.blockLibrary.cleanupDeletedBlockTypeArchive, {
    type,
  })
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${type}`)
  revalidatePath(`/block-sim/${type}`)
}

/** Validate a manually authored model for review without writing source or content. */
export async function reviewBlockModelAction({
  specJson,
  expectedType,
  expectedSourceRevision,
}: {
  specJson: string
  expectedType: string
  expectedSourceRevision: string
}): Promise<
  | { status: "reviewed"; specJson: string }
  | {
      status: "refused"
      reason: "stale_source" | "wrong_type" | "invalid_spec"
    }
> {
  await requireAuth("Sign in to review Block models.")
  assertLocalBlockWrite()
  await requireInstallationOwner(
    "Only the installation owner can review Block models."
  )
  async function baseIsCurrent() {
    if (
      !new Set<string>(REGISTERED_BLOCK_TYPES).has(expectedType) ||
      !/^[a-f0-9]{64}$/.test(expectedSourceRevision ?? "")
    )
      return false
    try {
      return (
        (await readBlockModelSourceRevision(expectedType)) ===
        expectedSourceRevision
      )
    } catch {
      return false
    }
  }
  const stale = { status: "refused", reason: "stale_source" } as const
  if (!(await baseIsCurrent())) return stale
  const { parseBlockSpecJson } = await loadBlockAuthoring()
  let spec
  try {
    spec = parseBlockSpecJson(specJson)
  } catch {
    return (await baseIsCurrent())
      ? { status: "refused", reason: "invalid_spec" }
      : stale
  }
  if (!(await baseIsCurrent())) return stale
  if (spec.type !== expectedType)
    return { status: "refused", reason: "wrong_type" }
  return { status: "reviewed", specJson: JSON.stringify(spec) }
}

export async function updateBlockAction({
  specJson,
  expectedType,
  expectedSourceRevision,
}: {
  specJson: string
  expectedType: string
  expectedSourceRevision: string
}): Promise<UpdatedBlock | { status: "refused"; reason: "stale_source" }> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalBlockWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { updateBlockModel } = await loadBlockService()
  const result = await updateBlockModel(
    { specJson, expectedType, expectedSourceRevision },
    {
      readUsage: (type) =>
        fetchAuthQuery(api.cms.blockLibrary.getBlockUsageSummary, { type }),
      runModelGate: (type) => runBlockGate(type),
    },
    process["cwd"]()
  )
  if ("status" in result) return result
  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${result.type}`)
  revalidatePath(`/block-sim/${result.type}`)
  return result
}
