import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { readSliceMetadata } from "@/lib/slices/builder"
import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import {
  installedSliceDefs,
  INSTALLED_SLICE_TYPES,
  type Primitive,
  type InstalledSliceType,
} from "@/convex/lib/slices"
import type { Id } from "@/convex/_generated/dataModel"
import { walkDef } from "@/convex/lib/slices/walk"
import { isButtonPrimitive } from "@/lib/slices/authoring/scaffold"
import { type SliceGroup, type SliceOrigin } from "@/lib/slices/builder"
import { humanize } from "@/lib/slices/flatten-content"
import { thumbnailUrl } from "@/lib/slices/thumbnails"
import type { SliceUsageDetail } from "./authoring/usage-types"
export type { SliceUsageDetail } from "./authoring/usage-types"

export type SliceFieldSummary = {
  path: string
  label: string
  kind: string
  scope: "Primary" | "Items"
  depth: number
  optional: boolean
  detail?: string
}

export type SliceCatalogItem = {
  type: InstalledSliceType
  label: string
  description: string
  purpose: string
  group: SliceGroup
  origin: SliceOrigin
  fields: SliceFieldSummary[]
  fieldCount: number
  hasItems: boolean
  thumbnailUrl: string
}

function fieldDetail(def: Primitive): string | undefined {
  if (def.kind === "richText") {
    return resolveFieldContract(def.config).contract
  }
  if (def.kind === "select") {
    const options = def.config.options
    return Array.isArray(options) ? options.join(", ") : undefined
  }
  if (def.kind === "list") {
    const max = def.config.max
    return typeof max === "number" ? `max ${max}` : undefined
  }
  if (def.kind === "relation") {
    const pageTypes = def.config.pageTypes
    return Array.isArray(pageTypes) ? pageTypes.join(", ") : undefined
  }
  if (def.kind === "table") {
    const min = def.config.minColumns
    const max = def.config.maxColumns
    if (typeof min === "number" && typeof max === "number") {
      return `${min}-${max} columns`
    }
    if (typeof max === "number") return `max ${max} columns`
    if (typeof min === "number") return `min ${min} columns`
  }
  return undefined
}

export function collectFields(
  def: Primitive,
  scope: "Primary" | "Items",
  path: string,
  depth: number
): SliceFieldSummary[] {
  const out: SliceFieldSummary[] = []
  walkDef(
    def,
    (node) => {
      // A button is one compact row, not a walk into label/link/variant.
      if (isButtonPrimitive(node.def)) {
        out.push({
          path: node.path,
          label: humanize(node.key),
          kind: "button",
          scope,
          depth: node.depth,
          optional: node.def.validator.isOptional === "optional",
          detail: "label + link + variant",
        })
        return "skip"
      }
      // Groups are pure structure — descend, emit nothing.
      if (node.def.kind === "group") return
      // A list emits its own row, then walkDef descends into the item at
      // depth + 1. Its label is the raw last segment (the list field name);
      // leaves use `node.key` (trailing `[]` stripped).
      const label =
        node.def.kind === "list"
          ? humanize(node.path.split(".").at(-1) ?? node.path)
          : humanize(node.key)
      out.push({
        path: node.path,
        label,
        kind: node.def.kind,
        scope,
        depth: node.depth,
        optional: node.def.validator.isOptional === "optional",
        detail: fieldDetail(node.def),
      })
    },
    { path, depth }
  )
  return out
}

function buildCatalogItem(type: InstalledSliceType): SliceCatalogItem {
  const def = readInstalledSliceDefinition(type)
  // A retired/removed slice type may still be looked up (e.g. stale usage
  // data); fall back to sensible defaults instead of throwing.
  const meta = readSliceMetadata(type) ?? {
    label: type,
    description: "",
    group: "misc" as SliceGroup,
    origin: "system" as SliceOrigin,
  }
  const primaryFields = collectFields(def.primary, "Primary", "", 0)
  const itemFields =
    def.items !== undefined ? collectFields(def.items, "Items", "items", 0) : []
  const fields = [...primaryFields, ...itemFields]
  const leafCount = fields.filter((field) => field.kind !== "list").length

  return {
    type,
    label: meta.label,
    description: meta.description,
    purpose: def.aiHint.purpose,
    group: meta.group,
    origin: meta.origin,
    fields,
    fieldCount: leafCount,
    hasItems: def.items !== undefined,
    thumbnailUrl: thumbnailUrl(type),
  }
}

export function getSliceCatalog(): SliceCatalogItem[] {
  return INSTALLED_SLICE_TYPES.map(buildCatalogItem)
}

/** One catalog entry. Walks only the requested type's field tree — the detail
 *  page and the sim don't pay for the whole registry to read one row. */
export function getSliceCatalogItem(type: string): SliceCatalogItem | null {
  if (!(type in installedSliceDefs)) return null
  return buildCatalogItem(type as InstalledSliceType)
}

export function countSliceUsage(
  pages: {
    content?: Record<string, { slices?: { type: string }[] | undefined }>
  }[]
): Record<InstalledSliceType, number> {
  const counts = Object.fromEntries(
    INSTALLED_SLICE_TYPES.map((type) => [type, 0])
  ) as Record<InstalledSliceType, number>

  const accumulator: Record<string, number> = counts
  for (const page of pages) {
    for (const locale of Object.values(page.content ?? {})) {
      for (const slice of locale.slices ?? []) {
        if ((INSTALLED_SLICE_TYPES as readonly string[]).includes(slice.type)) {
          accumulator[slice.type] += 1
        }
      }
    }
  }

  return counts
}

// --- Deletion impact analysis -----------------------------------------------

export type SlicePageUsageDetail = {
  pageId?: string
  title: string
  slug: string
  status?: string
  deleted: boolean
  locales: string[]
  occurrences: number
}

export type SliceDeletionImpact = {
  type: string
  pageCount: number
  activePageCount: number
  deletedPageCount: number
  localeCount: number
  occurrenceCount: number
  relationFieldPaths: string[]
  pages: SlicePageUsageDetail[]
}

type SliceUsagePage = {
  _id?: unknown
  slug?: string
  status?: string
  deletedAt?: number
  content?: Record<
    string,
    { title?: string | undefined; slices?: { type: string }[] | undefined }
  >
}

function collectRelationFieldPaths(
  def: Primitive,
  path: string,
  out: string[]
): void {
  if (def.kind === "relation") {
    out.push(path)
    return
  }
  if (def.kind === "group") {
    const fields = def.config.fields as Record<string, Primitive>
    for (const [key, child] of Object.entries(fields)) {
      collectRelationFieldPaths(child, path ? `${path}.${key}` : key, out)
    }
    return
  }
  if (def.kind === "list") {
    const item = def.config.item as Primitive
    collectRelationFieldPaths(item, path ? `${path}[]` : "items[]", out)
  }
}

export function getSliceRelationFieldPaths(type: string): string[] {
  if (!(type in installedSliceDefs)) return []
  const def = readInstalledSliceDefinition(type as InstalledSliceType)
  const paths: string[] = []
  collectRelationFieldPaths(def.primary, "primary", paths)
  if (def.items !== undefined)
    collectRelationFieldPaths(def.items, "items", paths)
  return paths
}

/** Which locales of one page carry `type`, and how many times in total. Shared
 *  by the two usage readers below so "does this page use this slice" is counted
 *  one way; each caller still shapes its own row (they disagree on how a page
 *  title is chosen). */
function tallyPageUsage(
  page: {
    content?: Record<string, { slices?: { type: string }[] | undefined }>
  },
  type: string
): { locales: string[]; occurrences: number } {
  const locales: string[] = []
  let occurrences = 0
  for (const [locale, content] of Object.entries(page.content ?? {})) {
    const localeOccurrences =
      content.slices?.filter((slice) => slice.type === type).length ?? 0
    if (localeOccurrences === 0) continue
    locales.push(locale)
    occurrences += localeOccurrences
  }
  return { locales, occurrences }
}

export function getSliceDeletionImpact(
  type: string,
  pages: SliceUsagePage[]
): SliceDeletionImpact {
  const details: SlicePageUsageDetail[] = []
  const locales = new Set<string>()
  let occurrences = 0

  for (const page of pages) {
    const { locales: pageLocales, occurrences: pageOccurrences } =
      tallyPageUsage(page, type)
    if (pageOccurrences === 0) continue
    for (const locale of pageLocales) locales.add(locale)
    occurrences += pageOccurrences
    const firstContent = Object.values(page.content ?? {})[0]
    details.push({
      pageId: typeof page._id === "string" ? page._id : undefined,
      title: firstContent?.title || "Untitled",
      slug: page.slug || "",
      status: page.status,
      deleted: page.deletedAt !== undefined,
      locales: pageLocales,
      occurrences: pageOccurrences,
    })
  }

  return {
    type,
    pageCount: details.length,
    activePageCount: details.filter((page) => !page.deleted).length,
    deletedPageCount: details.filter((page) => page.deleted).length,
    localeCount: locales.size,
    occurrenceCount: occurrences,
    relationFieldPaths: getSliceRelationFieldPaths(type),
    pages: details,
  }
}

// ---------------------------------------------------------------------------

export function getSliceUsageDetails(
  pages: {
    _id: Id<"pages">
    slug: string
    content?: Record<
      string,
      { title?: string; slices?: { type: string }[] | undefined }
    >
  }[],
  type: string
): SliceUsageDetail[] {
  const details: SliceUsageDetail[] = []

  for (const page of pages) {
    const { locales, occurrences: count } = tallyPageUsage(page, type)
    // First locale that carries a title wins — unlike the deletion impact,
    // which reads the first locale's title whether or not it is set.
    const title =
      Object.values(page.content ?? {}).find((content) => content.title)
        ?.title ?? "Untitled"

    if (count > 0) {
      details.push({
        pageId: page._id,
        title,
        slug: page.slug,
        locales,
        count,
      })
    }
  }

  return details
}
