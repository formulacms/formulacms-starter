import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { type Primitive, type Slice } from "./slices"
import { walkFieldMap, walkValue } from "./slices/walk"
import { contentTypeDefs, type ContentType } from "./contentTypes"
import { hasSliceBody } from "./pages/sliceBodyContent"

/**
 * Document-reference scanner (plan 028 C2, ADR-0037 §4).
 *
 * Every `relation()` primitive value stored on a `pages` document produces one
 * row in `documentReferences`. The scanner walks three surfaces per save:
 *   1. The content-type descriptor's `sharedFields` (row-level, locale-agnostic).
 *   2. The content-type descriptor's `localizedFields` (one visit per locale).
 *   3. Slice content on locale bodies (`content[locale].slices[]`) — the same
 *      walker path `mediaReferences` uses for image fields.
 *
 * `parentId` is deliberately NOT tracked here: it is a first-class hierarchy
 * column with its own indexes + cycle semantics, not a descriptor-declared
 * `relation()` field. Routing hierarchy stays a distinct concern.
 *
 * Today none of the three registered descriptors (`page`, `landing-page`,
 * `post`) declares a `relation()` field, so this scanner is dormant on
 * existing content. It becomes load-bearing when C5 wires post's byline as
 * `relation({ pageTypes: ["author"] })` (and other C5 types add their own
 * pickers). The write-path still calls it every save so a future descriptor
 * that opts into `relation()` gets fan-out maintained automatically.
 */

export type DocumentReferenceSource =
  "shared-field" | "localized-field" | "slice-body"

export interface CollectedDocumentReference {
  targetId: Id<"pages">
  sourceLocale?: string
  path: string
  source: DocumentReferenceSource
}

function relationTargetId(value: unknown): Id<"pages"> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined
  const maybe = value as { pageId?: Id<"pages"> }
  return maybe.pageId ?? undefined
}

function collectFromFieldMap(
  fields: Record<string, Primitive>,
  values: Record<string, unknown> | undefined,
  opts: {
    sourceLocale?: string
    pathPrefix: string
    source: DocumentReferenceSource
  },
  collected: CollectedDocumentReference[]
): void {
  walkFieldMap(fields, values, (leaf) => {
    if (leaf.def.kind !== "relation") return
    const targetId = relationTargetId(leaf.value)
    if (!targetId) return
    const absolutePath = opts.pathPrefix
      ? `${opts.pathPrefix}.${leaf.path || leaf.fieldKey}`
      : leaf.path || leaf.fieldKey
    collected.push({
      targetId,
      sourceLocale: opts.sourceLocale,
      path: absolutePath,
      source: opts.source,
    })
  })
}

export function collectDocumentReferences(
  page: Doc<"pages">
): CollectedDocumentReference[] {
  const refs: CollectedDocumentReference[] = []
  const descriptor = contentTypeDefs[page.pageType as ContentType]
  if (!descriptor) return refs

  // 1. Shared (row-level) fields.
  collectFromFieldMap(
    descriptor.sharedFields as Record<string, Primitive>,
    page as unknown as Record<string, unknown>,
    { pathPrefix: "", source: "shared-field" },
    refs
  )

  // 2. Localized fields — one pass per locale.
  const content = (page.content ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >
  const localizedFields = descriptor.localizedFields as Record<
    string,
    Primitive
  >
  for (const [locale, bag] of Object.entries(content)) {
    collectFromFieldMap(
      localizedFields,
      bag,
      {
        sourceLocale: locale,
        pathPrefix: `content.${locale}`,
        source: "localized-field",
      },
      refs
    )
  }

  // 3. Slice content — mirrors mediaReferences.ts. Walks both `primary` and
  //    `items` primitive trees for `relation` leaves. Pure-form arms
  //    (`sliceBody: false`) have no slice canvas — skip the walk.
  if (!hasSliceBody(page)) return refs

  for (const [locale, localeContent] of Object.entries(page.content ?? {})) {
    const slices = localeContent.slices ?? []
    slices.forEach((slice: Slice, sliceIndex) => {
      const def = readSliceDefinition(readSlice(slice).type)
      if (!def) return
      const slicePath = `content.${locale}.slices[${sliceIndex}]`
      const emitSliceLeaf = (root: "primary" | "items", leafPath: string) => {
        // walkValue emits `path === ""` when descriptor is a bare leaf primitive
        // (no group/list wrapping), and paths for list rows start with `[…]`.
        // Compose: `<slicePath>.<root>` when leafPath is empty or begins with
        // `[`; otherwise separate with `.` — either the descriptor is a group
        // ("primary.title") or a list-of-groups ("items[0].title").
        const needsDot = leafPath.length > 0 && !leafPath.startsWith("[")
        return `${slicePath}.${root}${needsDot ? "." : ""}${leafPath}`
      }
      walkValue(def.primary, readSlice(slice).primary, (leaf) => {
        if (leaf.def.kind !== "relation") return
        const targetId = relationTargetId(leaf.value)
        if (!targetId) return
        refs.push({
          targetId,
          sourceLocale: locale,
          path: emitSliceLeaf("primary", leaf.path),
          source: "slice-body",
        })
      })

      if (!def.items || !("items" in slice)) return
      walkValue(def.items as Primitive, readSlice(slice).items, (leaf) => {
        if (leaf.def.kind !== "relation") return
        const targetId = relationTargetId(leaf.value)
        if (!targetId) return
        refs.push({
          targetId,
          sourceLocale: locale,
          path: emitSliceLeaf("items", leaf.path),
          source: "slice-body",
        })
      })
    })
  }

  return refs
}

function referenceKey(ref: CollectedDocumentReference): string {
  return [ref.targetId, ref.sourceLocale ?? "", ref.path, ref.source].join("\0")
}

export async function clearDocumentReferencesForPage(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<void> {
  const existing = await ctx.db
    .query("documentReferences")
    .withIndex("by_source", (q) => q.eq("sourceId", pageId))
    .take(1000)
  await Promise.all(existing.map((row) => ctx.db.delete(row._id)))
}

export async function refreshDocumentReferencesForPage(
  ctx: MutationCtx,
  page: Doc<"pages">
): Promise<void> {
  await clearDocumentReferencesForPage(ctx, page._id)

  const collected = collectDocumentReferences(page)
  if (collected.length === 0) return

  // Dedup target IDs before fetching — a "featured picks" slice can reference
  // the same author across 20 items in 5 locales, and we want one db.get per
  // unique target, not 100.
  const uniqueTargetIds = Array.from(new Set(collected.map((r) => r.targetId)))
  const fetched = await Promise.all(uniqueTargetIds.map((id) => ctx.db.get(id)))
  const targetsById = new Map(
    uniqueTargetIds.map((id, i) => [id, fetched[i]] as const)
  )

  const now = Date.now()
  const seen = new Set<string>()
  const toInsert: Array<{
    sourceId: Id<"pages">
    sourceLocale: string | undefined
    targetId: Id<"pages">
    targetType: Doc<"pages">["pageType"]
    path: string
    source: CollectedDocumentReference["source"]
    updatedAt: number
  }> = []
  for (const ref of collected) {
    const target = targetsById.get(ref.targetId)
    if (!target) continue
    const key = referenceKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    toInsert.push({
      sourceId: page._id,
      sourceLocale: ref.sourceLocale,
      targetId: ref.targetId,
      targetType: target.pageType,
      path: ref.path,
      source: ref.source,
      updatedAt: now,
    })
  }
  await Promise.all(
    toInsert.map((row) => ctx.db.insert("documentReferences", row))
  )
}
