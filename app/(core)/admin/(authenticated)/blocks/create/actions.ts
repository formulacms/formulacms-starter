"use server"

import { revalidatePath } from "next/cache"
import { assertLocalDevelopment } from "@/lib/assert-local-dev"
import { requireAuth } from "@/lib/auth/server"
import { requireInstallationOwner } from "@/lib/owner-server"
import type { PersistedBlock } from "@/lib/blocks/authoring/persist"
import type { BlockReferenceVariant } from "@/lib/blocks/authoring/reference"
import {
  DESIGN_WIDTH_REQUIRED,
  isDesignWidth,
} from "@/lib/blocks/authoring/design-width"
import { runBlockGate } from "../gate"

// Deferred on purpose (see the note in ../actions.ts): dev-only authoring code
// stays in a lazy chunk behind the gate. No `turbopackIgnore` — it would leave
// the "@/" alias unresolved for raw Node at call time.
async function loadBlockPersistence() {
  assertLocalDevelopment("Block creation")
  return import("@/lib/blocks/authoring/persist")
}

async function loadRecoverableBlockCreation() {
  assertLocalDevelopment("Block creation")
  return import("@/lib/blocks/authoring/create")
}

async function loadBlockReferences() {
  assertLocalDevelopment("Block creation")
  return import("@/lib/blocks/authoring/reference")
}

/**
 * The design a new block is created from, carried as `FormData` so the file
 * arrives at full resolution. `cssWidth` is the answer to "How wide was this
 * design made for?" and is required whenever a design is supplied — the
 * comparison baseline is meaningless without it (block-fidelity plan §5 B2).
 */
function readSourceReference(form: FormData | undefined): {
  file: File
  cssWidth: number
  variant: BlockReferenceVariant
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

export async function persistGeneratedBlock(
  specJson: string,
  sourceReference?: FormData,
  rendererBody?: string | null
): Promise<PersistedBlock> {
  await requireAuth("Sign in to create blocks.")
  assertLocalDevelopment("Block creation")
  await requireInstallationOwner(
    "Only the installation owner can create blocks."
  )
  const [
    { parseBlockSpecJson },
    { createBlockRecoverably },
    { persistBlockReference },
  ] = await Promise.all([
    loadBlockPersistence(),
    loadRecoverableBlockCreation(),
    loadBlockReferences(),
  ])

  const spec = parseBlockSpecJson(specJson)
  const design = readSourceReference(sourceReference)

  const result = await createBlockRecoverably(spec, {
    rendererBody: rendererBody ?? undefined,
    finalizers: [
      { run: () => runBlockGate(spec.type) },
      ...(design
        ? [
            {
              async run() {
                await persistBlockReference({
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
                  additionalBlockTypes: [spec.type],
                })
              },
            },
          ]
        : []),
    ],
  })

  revalidatePath("/admin/blocks")
  revalidatePath(`/admin/blocks/${result.type}`)
  revalidatePath(`/block-sim/${result.type}`)

  if (design) {
    revalidatePath(`/block-references/${result.type}`)
  }

  return result
}
