"use server"

import { revalidatePath } from "next/cache"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { requireAuth } from "@/lib/auth-server"
import { requireInstallationOwner } from "@/lib/owner-server"
import type { PersistedSlice } from "@/lib/slices/authoring/persist"
import type { SliceReferenceVariant } from "@/lib/slices/authoring/reference"
import {
  DESIGN_WIDTH_REQUIRED,
  isDesignWidth,
} from "@/lib/slices/authoring/design-width"
import { runSliceGate } from "../gate"

// Deferred on purpose (see the note in ../actions.ts): dev-only authoring code
// stays in a lazy chunk behind the gate. No `turbopackIgnore` — it would leave
// the "@/" alias unresolved for raw Node at call time.
async function loadSlicePersistence() {
  assertLocalDevelopment("Slice creation")
  return import("@/lib/slices/authoring/persist")
}

async function loadRecoverableSliceCreation() {
  assertLocalDevelopment("Slice creation")
  return import("@/lib/slices/authoring/create")
}

async function loadSliceReferences() {
  assertLocalDevelopment("Slice creation")
  return import("@/lib/slices/authoring/reference")
}

/**
 * The design a new slice is created from, carried as `FormData` so the file
 * arrives at full resolution. `cssWidth` is the answer to "How wide was this
 * design made for?" and is required whenever a design is supplied — the
 * comparison baseline is meaningless without it (slice-fidelity plan §5 B2).
 */
function readSourceReference(form: FormData | undefined): {
  file: File
  cssWidth: number
  variant: SliceReferenceVariant
} | null {
  if (!form) return null
  const snapshot = form.get("snapshot")
  if (snapshot == null) return null
  if (!(snapshot instanceof File)) {
    throw new Error("Snapshot file is required.")
  }
  if (!snapshot.type.startsWith("image/")) {
    throw new Error("Snapshot must be an image.")
  }

  const cssWidth = Number(form.get("cssWidth"))
  if (!isDesignWidth(cssWidth)) throw new Error(DESIGN_WIDTH_REQUIRED)

  const variant = form.get("variant")
  if (variant !== "desktop" && variant !== "mobile") {
    throw new Error("Pick either the desktop or the mobile design.")
  }

  return { file: snapshot, cssWidth, variant }
}

export async function persistGeneratedSlice(
  specJson: string,
  sourceReference?: FormData,
  rendererBody?: string | null
): Promise<PersistedSlice> {
  await requireAuth("Sign in to create blocks.")
  assertLocalDevelopment("Slice creation")
  await requireInstallationOwner(
    "Only the installation owner can create blocks."
  )
  const [
    { parseSliceSpecJson },
    { createSliceRecoverably },
    { persistSliceReference },
  ] = await Promise.all([
    loadSlicePersistence(),
    loadRecoverableSliceCreation(),
    loadSliceReferences(),
  ])

  const spec = parseSliceSpecJson(specJson)
  const design = readSourceReference(sourceReference)

  const result = await createSliceRecoverably(spec, {
    rendererBody: rendererBody ?? undefined,
    finalizers: [
      { run: () => runSliceGate(spec.type) },
      ...(design
        ? [
            {
              async run() {
                await persistSliceReference({
                  type: spec.type,
                  variant: design.variant,
                  source: Buffer.from(await design.file.arrayBuffer()),
                  mediaType: design.file.type || "image/png",
                  // A width stated at upload is an accepted baseline;
                  // "recovered" is a reviewed claim about real source
                  // evidence, made when editing the tracked contract.
                  provenance: "accepted-baseline",
                  sectionCropAccepted: true,
                  cssWidth: design.cssWidth,
                  // The new type is not in this running process's registry yet.
                  additionalSliceTypes: [spec.type],
                })
              },
            },
          ]
        : []),
    ],
  })

  revalidatePath("/admin/slices")
  revalidatePath(`/admin/slices/${result.type}`)
  revalidatePath(`/slice-sim/${result.type}`)

  if (design) {
    revalidatePath(`/slice-references/${result.type}`)
  }

  return result
}
