import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { type Primitive, type Block } from "./blocks"
import { type LeafVisit, walkFieldMap, walkValue } from "./blocks/walk"
import { hasBlockBody } from "./pages/blockBodyContent"
import { contentTypeDefs, type ContentType } from "./contentTypes"

export type MediaReferenceSource =
  "block-image" | "block-media-link" | "card-image" | "descriptor-image"

export type CollectedMediaReference = {
  mediaId?: Id<"media">
  storageId?: Id<"_storage">
  locale?: string
  path: string
  source: MediaReferenceSource
}

export type ResolvedMediaReference = {
  mediaId: Id<"media">
  storageId: Id<"_storage">
  locale?: string
  path: string
  source: MediaReferenceSource
}

function mediaLikeValue(value: unknown):
  | {
      mediaId?: Id<"media">
      storageId?: Id<"_storage">
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const maybe = value as { mediaId?: Id<"media">; storageId?: Id<"_storage"> }
  if (!maybe.mediaId && !maybe.storageId) return undefined
  return maybe
}

/** Primary fields, named lists, items and descriptor fields retain the same leaves. */
function mediaLeafValue(leaf: LeafVisit) {
  if (leaf.def.kind !== "image" && leaf.def.kind !== "link") return undefined
  return mediaLikeValue(leaf.value)
}

/** One field leaf of a page, with the locale and path the reference rows use. */
export type PageLeaf = {
  leaf: LeafVisit
  locale?: string
  path: string
  /** Descriptor (shared or localized) field, or a block field. */
  area: "descriptor" | "block"
}

/**
 * Walk every field leaf of a page in the order the reference writers rely on:
 * descriptor shared fields, descriptor localized fields per locale, then block
 * primary and item fields. Image/link collection and rich-text image
 * collection share this walk so their paths cannot drift apart.
 */
export function visitPageLeaves(
  page: Doc<"pages">,
  visit: (entry: PageLeaf) => void
): void {
  // Plan 029 C10 — descriptor field-map walk. Runs on EVERY arm, including
  // pure-form (`blockBody: false`) types like testimonial whose descriptor-
  // level `image()` fields (e.g. `personImage`) are the first non-card,
  // non-block image source in the system. Unknown pageType silently no-ops,
  // matching the doc-refs scanner + search extractor fallthrough. No
  // `publicFieldsOf` gate — media references track storage usage / GC /
  // deletion; admin-only media still needs a reference row so it isn't
  // orphan-swept.
  const descriptor = contentTypeDefs[page.pageType as ContentType]
  if (descriptor) {
    const sharedFields = descriptor.sharedFields as Record<string, Primitive>
    walkFieldMap(
      sharedFields,
      page as unknown as Record<string, unknown>,
      (leaf) => visit({ leaf, path: leaf.path, area: "descriptor" })
    )

    const localizedFields = descriptor.localizedFields as Record<
      string,
      Primitive
    >
    for (const [locale, localeContent] of Object.entries(page.content ?? {})) {
      walkFieldMap(
        localizedFields,
        localeContent as unknown as Record<string, unknown>,
        (leaf) =>
          visit({
            leaf,
            locale,
            path: `content.${locale}.${leaf.path}`,
            area: "descriptor",
          })
      )
    }
  }

  // Pure-form arms (`blockBody: false`) have no block canvas — skip the
  // block walk. Card-image + descriptor references still apply.
  if (!hasBlockBody(page)) return

  for (const [locale, localeContent] of Object.entries(page.content ?? {})) {
    const blocks = localeContent.blocks ?? []
    blocks.forEach((block: Block, blockIndex) => {
      const def = readBlockDefinition(readBlock(block).type)
      if (!def) return

      walkValue(def.primary, readBlock(block).primary, (leaf) =>
        visit({
          leaf,
          locale,
          path: `content.${locale}.blocks[${blockIndex}].primary.${leaf.path}`,
          area: "block",
        })
      )

      if (!def.items || !("items" in block)) return
      walkValue(def.items as Primitive, readBlock(block).items, (leaf) =>
        visit({
          leaf,
          locale,
          path: `content.${locale}.blocks[${blockIndex}].items${leaf.path}`,
          area: "block",
        })
      )
    })
  }
}

export function collectMediaReferences(
  page: Doc<"pages">
): CollectedMediaReference[] {
  const refs: CollectedMediaReference[] = []
  if (page.cardImageMediaId) {
    refs.push({
      mediaId: page.cardImageMediaId,
      path: "cardImageMediaId",
      source: "card-image",
    })
  }
  // Descriptor media links use the existing block-media-link discriminator;
  // their path identifies the descriptor field.
  visitPageLeaves(page, ({ leaf, locale, path, area }) => {
    const media = mediaLeafValue(leaf)
    if (!media) return
    refs.push({
      ...media,
      ...(locale === undefined ? {} : { locale }),
      path,
      source:
        leaf.def.kind === "link"
          ? "block-media-link"
          : area === "descriptor"
            ? "descriptor-image"
            : "block-image",
    })
  })
  return refs
}

async function mediaByStorageId(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">
): Promise<Doc<"media"> | null> {
  return await ctx.db
    .query("media")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    // Two media rows can share one stored file (two `media.create` calls);
    // either alias names the same object.
    .first()
}

export async function resolveMediaReference(
  ctx: QueryCtx | MutationCtx,
  ref: CollectedMediaReference
): Promise<ResolvedMediaReference | null> {
  if (ref.mediaId) {
    const media = await ctx.db.get("media", ref.mediaId)
    if (!media) return null
    return {
      mediaId: media._id,
      storageId: media.storageId,
      locale: ref.locale,
      path: ref.path,
      source: ref.source,
    }
  }

  if (!ref.storageId) return null
  const media = await mediaByStorageId(ctx, ref.storageId)
  if (!media) return null
  return {
    mediaId: media._id,
    storageId: media.storageId,
    locale: ref.locale,
    path: ref.path,
    source: ref.source,
  }
}

function referenceKey(ref: ResolvedMediaReference): string {
  return [
    ref.mediaId,
    ref.storageId,
    ref.locale ?? "",
    ref.path,
    ref.source,
  ].join("\0")
}

export async function clearMediaReferencesForPage(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<void> {
  const existing = await ctx.db
    .query("mediaReferences")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(1000)
  await Promise.all(existing.map((ref) => ctx.db.delete("mediaReferences", ref._id)))
}

export async function refreshMediaReferencesForPage(
  ctx: MutationCtx,
  page: Doc<"pages">
): Promise<void> {
  await clearMediaReferencesForPage(ctx, page._id)

  const now = Date.now()
  const resolved = await Promise.all(
    collectMediaReferences(page).map((ref) => resolveMediaReference(ctx, ref))
  )
  const seen = new Set<string>()
  const toInsert: Array<{
    mediaId: Id<"media">
    storageId: Id<"_storage">
    pageId: Id<"pages">
    locale: NonNullable<(typeof resolved)[number]>["locale"]
    path: string
    source: NonNullable<(typeof resolved)[number]>["source"]
    updatedAt: number
  }> = []
  for (const ref of resolved) {
    if (!ref) continue
    const key = referenceKey(ref)
    if (seen.has(key)) continue
    seen.add(key)
    toInsert.push({
      mediaId: ref.mediaId,
      storageId: ref.storageId,
      pageId: page._id,
      locale: ref.locale,
      path: ref.path,
      source: ref.source,
      updatedAt: now,
    })
  }
  await Promise.all(
    toInsert.map((row) => ctx.db.insert("mediaReferences", row))
  )
}
