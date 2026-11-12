"use server"

import { revalidatePath } from "next/cache"
import { api } from "@/convex/_generated/api"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import {
  fetchAuthMutation,
  fetchAuthQuery,
  requireAuth,
} from "@/lib/auth-server"
import { requireInstallationOwner } from "@/lib/owner-server"
import { REGISTERED_SLICE_TYPES } from "@/convex/lib/slices"
import type { SlicePresentationCatalog } from "@/convex/lib/slices/presentationResolution"
import type { RenamedSlice, UpdatedSlice } from "@/lib/slices/authoring/persist"
import { runSliceGate, runTypecheckGate } from "./gate"
import { shouldForceSliceDeletionGateFailure } from "@/lib/slices/verification"
import { readSliceModelSourceRevision } from "@/lib/slices/authoring/model-source-revision"

function assertLocalSliceWrite(): void {
  assertLocalDevelopment("Slice edits")
}

import type { DeleteSliceResult } from "@/lib/slices/authoring/service"
export type { DeleteSliceResult } from "@/lib/slices/authoring/service"

// Deferred on purpose: the authoring graph is heavy (it pulls in the scaffolder
// and its template fs work) and is only ever reachable in local development, so
// it stays in a lazy chunk behind the gate above rather than loading with this
// action module. It must NOT carry `turbopackIgnore` — that leaves the "@/"
// alias in the emitted chunk for raw Node to resolve, which throws
// "Cannot find package '@/lib'" at call time.
async function loadSliceAuthoring() {
  assertLocalSliceWrite()
  return import("@/lib/slices/authoring/persist")
}

async function loadSliceService() {
  assertLocalSliceWrite()
  return import("@/lib/slices/authoring/service")
}

/**
 * Archive or restore a Slice Type through authorized development tools only.
 * The consolidated implementation plan's R0 record (Type archive/reactivate)
 * makes this unavailable in production in release 1, even when called by ID.
 */
export async function setSliceArchivedAction({
  type,
  archived,
}: {
  type: string
  archived: boolean
}): Promise<void> {
  await requireAuth("Sign in to manage blocks.")
  assertLocalSliceWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  await fetchAuthMutation(api.cms.sliceLibrary.setSliceArchived, {
    type,
    archived,
  })
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${type}`)
}

/** Curate presentation choices through the trusted effective catalog. */
export async function setPresentationArchivedAction(args: {
  type: string
  presentationId: string
  archived: boolean
  expectedCatalogRevision: string
}): Promise<SlicePresentationCatalog> {
  await requireAuth("Sign in to manage blocks.")
  assertLocalSliceWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const catalog = await fetchAuthMutation(
    api.cms.slices.setPresentationArchived,
    args
  )
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${args.type}`)
  return catalog
}

/**
 * Mark or unmark a slice type for shipping to formulacms-starter (engine-only
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
  assertLocalSliceWrite()
  await requireInstallationOwner(
    "Only the installation owner can curate starter Block Types."
  )
  const { setStarterShipped } = await import("@/lib/slices/starter-ship")
  await setStarterShipped(type, shipped)
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${type}`)
}

export async function renameSliceAction({
  type,
  label,
}: {
  type: string
  label: string
}): Promise<RenamedSlice> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalSliceWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { renameSliceMetadata } = await loadSliceAuthoring()

  const result = await renameSliceMetadata(type, label)

  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${result.type}`)

  return result
}

export async function deleteSliceAction({
  type,
}: {
  type: string
}): Promise<DeleteSliceResult> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalSliceWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { deleteSliceModelForCurrentRequest } = await loadSliceService()
  const result = await deleteSliceModelForCurrentRequest(
    { type },
    {
      assertRetirementAllowed: (type) =>
        fetchAuthQuery(api.cms.sliceLibrary.assertSliceTypeRetirementAllowed, {
          type,
        }),
      readRetirementUsage: (type) =>
        fetchAuthQuery(api.cms.sliceLibrary.getSliceUsageSummary, {
          type,
          forRetirement: true,
        }),
      cleanupArchive: (type) =>
        fetchAuthMutation(api.cms.sliceLibrary.cleanupDeletedSliceTypeArchive, {
          type,
        }),
      runDeletionGate: () => runTypecheckGate(),
      forceGateFailure: shouldForceSliceDeletionGateFailure,
    },
    process["cwd"]()
  )
  if (result.status === "blocked") return result
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${result.type}`)
  revalidatePath(`/slice-sim/${result.type}`)
  return result
}

export async function retrySliceDeletionCleanupAction({
  type,
}: {
  type: string
}): Promise<void> {
  await requireAuth("Sign in to finish deleting this Block Type.")
  assertLocalSliceWrite()
  await requireInstallationOwner(
    "Only the installation owner can finish deleting Block Types."
  )
  await fetchAuthMutation(api.cms.sliceLibrary.cleanupDeletedSliceTypeArchive, {
    type,
  })
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${type}`)
  revalidatePath(`/slice-sim/${type}`)
}

/** Validate a manually authored model for review without writing source or content. */
export async function reviewSliceModelAction({
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
  assertLocalSliceWrite()
  await requireInstallationOwner(
    "Only the installation owner can review Block models."
  )
  async function baseIsCurrent() {
    if (
      !new Set<string>(REGISTERED_SLICE_TYPES).has(expectedType) ||
      !/^[a-f0-9]{64}$/.test(expectedSourceRevision ?? "")
    )
      return false
    try {
      return (
        (await readSliceModelSourceRevision(expectedType)) ===
        expectedSourceRevision
      )
    } catch {
      return false
    }
  }
  const stale = { status: "refused", reason: "stale_source" } as const
  if (!(await baseIsCurrent())) return stale
  const { parseSliceSpecJson } = await loadSliceAuthoring()
  let spec
  try {
    spec = parseSliceSpecJson(specJson)
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

export async function updateSliceAction({
  specJson,
  expectedType,
  expectedSourceRevision,
}: {
  specJson: string
  expectedType: string
  expectedSourceRevision: string
}): Promise<UpdatedSlice | { status: "refused"; reason: "stale_source" }> {
  await requireAuth("Sign in to edit blocks.")
  assertLocalSliceWrite()
  await requireInstallationOwner("Only the installation owner can edit blocks.")
  const { updateSliceModel } = await loadSliceService()
  const result = await updateSliceModel(
    { specJson, expectedType, expectedSourceRevision },
    {
      readUsage: (type) =>
        fetchAuthQuery(api.cms.sliceLibrary.getSliceUsageSummary, { type }),
      runModelGate: (type) => runSliceGate(type),
    },
    process["cwd"]()
  )
  if ("status" in result) return result
  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${result.type}`)
  revalidatePath(`/slice-sim/${result.type}`)
  return result
}
