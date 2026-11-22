import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { readBlockMetadata } from "@/lib/blocks/builder"
import { readInstalledBlockDefinition } from "@/convex/lib/blocks"
import {
  installedBlockDefs,
  INSTALLED_BLOCK_TYPES,
  type Primitive,
  type InstalledBlockType,
} from "@/convex/lib/blocks"
import type { Id } from "@/convex/_generated/dataModel"
import { walkDef } from "@/convex/lib/blocks/walk"
import { isButtonPrimitive } from "@/lib/blocks/authoring/scaffold"
import { type BlockGroup, type BlockOrigin } from "@/lib/blocks/builder"
import { humanize } from "@/lib/blocks/flatten-content"
import { thumbnailUrl } from "@/lib/blocks/thumbnails"
import type { BlockUsageDetail } from "./authoring/usage-types"
export type { BlockUsageDetail } from "./authoring/usage-types"

export type BlockFieldSummary = {
  path: string
  label: string
  kind: string
  scope: "Primary" | "Items"
  depth: number
  optional: boolean
  detail?: string
}

export type BlockCatalogItem = {
  type: InstalledBlockType
  label: string
  description: string
  purpose: string
  group: BlockGroup
  origin: BlockOrigin
  fields: BlockFieldSummary[]
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
): BlockFieldSummary[] {
  const out: BlockFieldSummary[] = []
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

function buildCatalogItem(type: InstalledBlockType): BlockCatalogItem {
  const def = readInstalledBlockDefinition(type)
  // A retired/removed block type may still be looked up (e.g. stale usage
  // data); fall back to sensible defaults instead of throwing.
  const meta = readBlockMetadata(type) ?? {
    label: type,
    description: "",
    group: "misc" as BlockGroup,
    origin: "system" as BlockOrigin,
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

export function getBlockCatalog(): BlockCatalogItem[] {
  return INSTALLED_BLOCK_TYPES.map(buildCatalogItem)
}

/** One catalog entry. Walks only the requested type's field tree — the detail
 *  page and the sim don't pay for the whole registry to read one row. */
export function getBlockCatalogItem(type: string): BlockCatalogItem | null {
  if (!(type in installedBlockDefs)) return null
  return buildCatalogItem(type as InstalledBlockType)
}

export function countBlockUsage(
  pages: {
    content?: Record<string, { blocks?: { type: string }[] | undefined }>
  }[]
): Record<InstalledBlockType, number> {
  const counts = Object.fromEntries(
    INSTALLED_BLOCK_TYPES.map((type) => [type, 0])
  ) as Record<InstalledBlockType, number>

  const accumulator: Record<string, number> = counts
  for (const page of pages) {
    for (const locale of Object.values(page.content ?? {})) {
      for (const block of locale.blocks ?? []) {
        if ((INSTALLED_BLOCK_TYPES as readonly string[]).includes(block.type)) {
          accumulator[block.type] += 1
        }
      }
    }
  }

  return counts
}

// --- Deletion impact analysis -----------------------------------------------

export type BlockPageUsageDetail = {
  pageId?: string
  title: string
  slug: string
  status?: string
  deleted: boolean
  locales: string[]
  occurrences: number
}

export type BlockDeletionImpact = {
  type: string
  pageCount: number
  activePageCount: number
  deletedPageCount: number
  localeCount: number
  occurrenceCount: number
  relationFieldPaths: string[]
  pages: BlockPageUsageDetail[]
}

type BlockUsagePage = {
  _id?: unknown
  slug?: string
  status?: string
  deletedAt?: number
  content?: Record<
    string,
    { title?: string | undefined; blocks?: { type: string }[] | undefined }
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

export function getBlockRelationFieldPaths(type: string): string[] {
  if (!(type in installedBlockDefs)) return []
  const def = readInstalledBlockDefinition(type as InstalledBlockType)
  const paths: string[] = []
  collectRelationFieldPaths(def.primary, "primary", paths)
  if (def.items !== undefined)
    collectRelationFieldPaths(def.items, "items", paths)
  return paths
}

/** Which locales of one page carry `type`, and how many times in total. Shared
 *  by the two usage readers below so "does this page use this block" is counted
 *  one way; each caller still shapes its own row (they disagree on how a page
 *  title is chosen). */
function tallyPageUsage(
  page: {
    content?: Record<string, { blocks?: { type: string }[] | undefined }>
  },
  type: string
): { locales: string[]; occurrences: number } {
  const locales: string[] = []
  let occurrences = 0
  for (const [locale, content] of Object.entries(page.content ?? {})) {
    const localeOccurrences =
      content.blocks?.filter((block) => block.type === type).length ?? 0
    if (localeOccurrences === 0) continue
    locales.push(locale)
    occurrences += localeOccurrences
  }
  return { locales, occurrences }
}

export function getBlockDeletionImpact(
  type: string,
  pages: BlockUsagePage[]
): BlockDeletionImpact {
  const details: BlockPageUsageDetail[] = []
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
    relationFieldPaths: getBlockRelationFieldPaths(type),
    pages: details,
  }
}

// ---------------------------------------------------------------------------

export function getBlockUsageDetails(
  pages: {
    _id: Id<"pages">
    slug: string
    content?: Record<
      string,
      { title?: string; blocks?: { type: string }[] | undefined }
    >
  }[],
  type: string
): BlockUsageDetail[] {
  const details: BlockUsageDetail[] = []

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
