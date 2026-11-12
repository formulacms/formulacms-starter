import { readSliceDefinition } from "@/convex/lib/slices"

import { type Primitive, type SliceType } from "@/convex/lib/slices"
import manifest from "@/lib/slices/slices.manifest.json"
import type { SliceManifestEntry } from "./registration"
// A JSON import widens `origin` to `string`; a custom slice adds `origin: "user"`.
const manifestEntries = manifest as readonly SliceManifestEntry[]
import {
  primitiveToSpec,
  type FieldSpec,
  type GroupSpec,
  type SliceSpec,
} from "./scaffold"

/** Read a slice's picker metadata from the registration manifest (ADR-0021),
 *  the single source of truth for label/description/icon/group. The icon is
 *  already a lucide export *name*, so no reverse-lookup from the component is
 *  needed. */
function metaFor(type: SliceType): {
  label: string
  description: string
  icon: string
  group: string
} {
  const entry = manifestEntries.find((m) => m.type === type)
  if (!entry) {
    throw new Error(`Slice "${type}" has no manifest entry.`)
  }
  return entry
}

function groupSpecFor(type: SliceType, field: Primitive): GroupSpec {
  const spec = primitiveToSpec(field)
  if (spec.kind !== "group") {
    throw new Error(`Slice "${type}" primary field is not a group.`)
  }
  return spec
}

export function sliceTypeToSpec(type: SliceType): SliceSpec {
  const def = readSliceDefinition(type)
  const meta = metaFor(type)
  let items: SliceSpec["items"]

  if (def.items !== undefined) {
    const item = def.items.config.item as Primitive
    const min = def.items.config.min
    const max = def.items.config.max
    items = {
      item: primitiveToSpec(item) as FieldSpec,
      ...(typeof min === "number" ? { min } : {}),
      ...(typeof max === "number" ? { max } : {}),
    }
  }

  return {
    type,
    label: meta.label,
    description: meta.description,
    icon: meta.icon,
    group: meta.group,
    primary: groupSpecFor(type, def.primary),
    ...(items ? { items } : {}),
    aiHint: {
      purpose: def.aiHint.purpose,
      // Descriptors store hint lines as one string. Round-tripping splits on the
      // writer's separator, so a hand-authored blank line becomes a new entry.
      fields: def.aiHint.fields.split("\n\n"),
    },
  }
}
