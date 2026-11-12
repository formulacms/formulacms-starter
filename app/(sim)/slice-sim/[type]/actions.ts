"use server"

import { copyFile, stat } from "node:fs/promises"
import { revalidatePath } from "next/cache"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { requireInstallationOwner } from "@/lib/owner-server"
import {
  comparisonSnapshotFile,
  comparisonSnapshotUrl,
  type ThumbnailVariant,
} from "@/lib/slices/thumbnails"
import type { SliceReferenceVariant } from "@/lib/slices/authoring/reference"

export type CaptureResult =
  | {
      ok: true
      before: { desktop: boolean; mobile: boolean }
      version: number
    }
  | { ok: false; error: string }
export type ReplaceSourceImageResult =
  | { ok: true; url: string; note: string | null }
  | {
      ok: false
      error: string
      reason?: "refused" | "rolled-back" | "rollback-failed"
    }

/**
 * Re-capture the catalog thumbnail and full-page comparison snapshots for a
 * single slice type. Dev-only — mirrors the simulator route's own
 * `process.env.NODE_ENV` gate. Returns a structured result so the client can
 * surface success/failure as a toast instead of failing silently.
 */
export async function captureSliceThumbnail(
  type: string
): Promise<CaptureResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Snapshot capture is dev-only" }
  }
  try {
    await requireInstallationOwner(
      "Only the installation owner can update block thumbnails."
    )
    if (!(INSTALLED_SLICE_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: `Unknown block type: ${type}` }
    }
    const { captureMany } = await import("@/scripts/capture-slice-thumbnails")
    const before = await preserveCurrentSnapshots(type)
    await captureMany([type], { viewports: ["desktop", "mobile"] })
    revalidatePath(`/slice-sim/${type}`)
    revalidatePath(`/admin/slices/${type}`)
    // Bust next/image cache for the catalog tiles.
    revalidatePath(`/slice-sim/${type}.png`)
    revalidatePath(`/slice-sim/${type}.mobile.png`)
    revalidatePath(`/slice-sim/${type}.before.png`)
    revalidatePath(`/slice-sim/${type}.mobile.before.png`)
    revalidatePath(comparisonSnapshotUrl(type))
    revalidatePath(comparisonSnapshotUrl(type, "mobile"))
    revalidatePath(comparisonSnapshotUrl(type, "desktop", "before"))
    revalidatePath(comparisonSnapshotUrl(type, "mobile", "before"))
    return { ok: true, before, version: Date.now() }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function preserveCurrentSnapshots(
  type: string
): Promise<{ desktop: boolean; mobile: boolean }> {
  const [desktop, mobile] = await Promise.all([
    preserveCurrentSnapshot(type, "desktop"),
    preserveCurrentSnapshot(type, "mobile"),
  ])
  return { desktop, mobile }
}

async function preserveCurrentSnapshot(
  type: string,
  variant: ThumbnailVariant
): Promise<boolean> {
  const current = comparisonSnapshotFile(type, variant)
  const before = comparisonSnapshotFile(type, variant, "before")
  try {
    const info = await stat(current)
    if (!info.isFile()) return false
    await copyFile(current, before)
    return true
  } catch {
    return false
  }
}

/**
 * Replace the stored design for one slice variant. Dev-only. Goes through the
 * single ingestion path (slice-fidelity plan §5 B2), so the comparison
 * baseline, the preserved upload, and the tracked width contract are replaced
 * together or not at all. The returned URL embeds a cache-buster so the
 * on-page <Image> picks up the new bytes immediately.
 */
export async function replaceSourceImageAction(input: {
  type: string
  variant: SliceReferenceVariant
  dataUrl: string
  mediaType: string
  cssWidth: number
}): Promise<ReplaceSourceImageResult> {
  if (process.env.NODE_ENV === "production") {
    return { ok: false, error: "Source image edits are dev-only" }
  }
  try {
    await requireInstallationOwner(
      "Only the installation owner can update source images."
    )
    if (!(INSTALLED_SLICE_TYPES as readonly string[]).includes(input.type)) {
      return { ok: false, error: `Unknown block type: ${input.type}` }
    }
    if (input.variant !== "desktop" && input.variant !== "mobile") {
      return {
        ok: false,
        error: `Unknown source image variant: ${input.variant}`,
      }
    }
    const [
      {
        decodeSliceReferenceDataUrl,
        persistSliceReference,
        sliceReferenceArtifactPaths,
      },
      { FileRollbackError },
    ] = await Promise.all([
      import("@/lib/slices/authoring/reference"),
      import("@/lib/slices/authoring/file-rollback"),
    ])
    const source = decodeSliceReferenceDataUrl({
      dataUrl: input.dataUrl,
      mediaType: input.mediaType,
    })
    try {
      const result = await persistSliceReference({
        type: input.type,
        variant: input.variant,
        source,
        mediaType: input.mediaType,
        cssWidth: input.cssWidth,
        // Supplying a design through this flow asserts it is the section crop;
        // the width is the one the person just stated, so it is an accepted
        // baseline rather than a recovered historical value.
        provenance: "accepted-baseline",
        sectionCropAccepted: true,
      })
      revalidatePath(`/slice-sim/${input.type}`)
      revalidatePath(`/admin/slices/${input.type}`)
      return {
        ok: true,
        url: `${result.url}?v=${Date.now()}`,
        note: result.warning,
      }
    } catch (err) {
      const artifacts = sliceReferenceArtifactPaths(
        input.type,
        input.variant,
        input.mediaType
      ).join(", ")
      if (err instanceof FileRollbackError) {
        return {
          ok: false,
          reason: "rollback-failed",
          error:
            "The design was not saved, and the earlier versions could not be put back. " +
            `These files may be half-updated, so check them before trying again: ${artifacts}. ` +
            `What went wrong: ${messageOf(err.operationError)}`,
        }
      }
      return {
        ok: false,
        reason: "rolled-back",
        error:
          "The design was not saved. Everything it would have changed was put " +
          `back exactly as it was: ${artifacts}. ` +
          `What went wrong: ${messageOf(err)}`,
      }
    }
  } catch (err) {
    return { ok: false, error: messageOf(err) }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RefineSliceRendererArgs {
  readonly sliceType: string
  readonly rendererSource: string
  readonly imageDataUrl?: string
  readonly imageMediaType?: string
  readonly target?: {
    readonly fieldPath: string
    readonly humanLabel: string
    readonly text?: string
  }
  readonly brief: string
  readonly previousAttempt?: string
  readonly previousError?: string
}

export interface RefineSliceRendererResult {
  readonly proposal: string
  readonly rendererBody: string | null
  readonly modelId: string
}

export async function refineSliceRendererDev(
  _args: RefineSliceRendererArgs
): Promise<RefineSliceRendererResult> {
  void _args
  assertLocalDevelopment("Renderer refine in the slice simulator")
  await requireInstallationOwner(
    "Only the installation owner can refine the renderer."
  )

  throw new Error(
    "Whole-renderer changes are unavailable in the simulator. Structural changes require the reviewed developer workflow planned for Phase 4."
  )
}
