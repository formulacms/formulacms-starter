import type { Page } from "./types"
import type { DescriptorFieldMap } from "@/convex/lib/contentTypes"
import type { Primitive } from "@/convex/lib/slices"
import { walkFieldMap } from "@/convex/lib/slices/walk"
import {
  SYSTEM_OWNED_LOCALIZED_FIELDS,
  SYSTEM_OWNED_SHARED_FIELDS,
} from "./system-owned-fields"

/**
 * Descriptor-generic value extractors (plan 029 C8 Phase 3).
 *
 * The generic Content panel reads a bag keyed by descriptor field name;
 * these helpers project a `Page` document into that shape and fill any
 * missing required fields from primitive defaults. Extracted here (rather
 * than inline in `page-editor.tsx`) so component tests and the recovery
 * layer share one code path.
 *
 * Immutability contract: the projectors never mutate the source doc — a
 * deep-cloned default fills missing keys. Reload semantics stay exact:
 * the editor state at open == the stored doc (plus canonical defaults for
 * required fields that happened to be absent).
 */

function cloneDefault(def: Primitive): unknown {
  const d = def.default
  if (d === undefined || d === null) return d
  return typeof d === "object" ? structuredClone(d) : d
}

/**
 * Extract the shared-field bag from a Page doc, filling in primitive
 * defaults for any missing required key. System-owned shared fields (e.g.
 * `post.tags` → Internal Labels) are excluded because the generic panel
 * doesn't render them; they save via their existing system paths.
 */
export function extractSharedFieldValues(
  page: Page,
  sharedFields: DescriptorFieldMap,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const doc = page as unknown as Record<string, unknown>
  for (const [key, def] of Object.entries(sharedFields)) {
    if (SYSTEM_OWNED_SHARED_FIELDS.has(key)) continue
    const stored = doc[key]
    if (stored !== undefined) {
      out[key] = stored
      continue
    }
    const isOptional = def.validator.isOptional === "optional"
    if (isOptional) {
      // Optional + absent = undefined; the panel treats it as unset.
      out[key] = undefined
      continue
    }
    out[key] = cloneDefault(def)
  }
  return out
}

/**
 * Extract the localized-field bag for a given locale. System-owned
 * localized fields (title/metaTitle/metaDescription) are excluded — those
 * live on their own editor-state slots and are merged back in at save
 * time by `use-page-save`.
 */
export type TranslatableLeaf = {
  path: string
  kind: "text" | "richText"
  value: string
}

/**
 * Collect the descriptor localized text/richText leaves that should be
 * routed through the `localizePage` action (plan 029 C9a). Skips
 * system-owned localized fields (title/meta already flow through explicit
 * action args) and non-translatable primitives (image, relation, select,
 * boolean, date, …). Empty values pass through so a targeted translation
 * of an empty field is a no-op rather than a schema violation.
 *
 * Kept in lockstep with `summarizeLocaleContent`'s `hasTranslatable`
 * filter — both must agree on which leaves count as translatable content.
 */
export function collectTranslatableLeaves(
  localizedFields: DescriptorFieldMap,
  values: Record<string, unknown> | undefined,
): TranslatableLeaf[] {
  const translatableOnly: Record<string, Primitive> = {}
  for (const [key, def] of Object.entries(localizedFields)) {
    if (SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)) continue
    translatableOnly[key] = def
  }
  const out: TranslatableLeaf[] = []
  walkFieldMap(translatableOnly, values, (leaf) => {
    if (leaf.def.kind !== "text" && leaf.def.kind !== "richText") return
    const value = typeof leaf.value === "string" ? leaf.value : ""
    if (!value) return
    out.push({ path: leaf.path, kind: leaf.def.kind, value })
  })
  return out
}

export function extractLocalizedFieldValues(
  page: Page,
  localizedFields: DescriptorFieldMap,
  locale: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const bag =
    (page.content?.[locale] as Record<string, unknown> | undefined) ?? {}
  for (const [key, def] of Object.entries(localizedFields)) {
    if (SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)) continue
    const stored = bag[key]
    if (stored !== undefined) {
      out[key] = stored
      continue
    }
    const isOptional = def.validator.isOptional === "optional"
    if (isOptional) {
      out[key] = undefined
      continue
    }
    out[key] = cloneDefault(def)
  }
  return out
}
