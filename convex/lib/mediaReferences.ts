import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { type Primitive, type Slice } from "./slices"
import { type LeafVisit, walkFieldMap, walkValue } from "./slices/walk"
import { hasSliceBody } from "./pages/sliceBodyContent"
import { contentTypeDefs, type ContentType } from "./contentTypes"

export type MediaReferenceSource =
  "slice-image" | "slice-media-link" | "card-image" | "descriptor-image"

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

  // Plan 029 C10 — descriptor field-map walk. Runs on EVERY arm, including
  // pure-form (`sliceBody: false`) types like testimonial whose descriptor-
  // level `image()` fields (e.g. `personImage`) are the first non-card,
  // non-slice image source in the system. Unknown pageType silently no-ops,
  // matching the doc-refs scanner + search extractor fallthrough. No
  // `publicFieldsOf` gate — media references track storage usage / GC /
  // deletion; admin-only media still needs a reference row so it isn't
  // orphan-swept. Descriptor media links use the existing slice-media-link
  // discriminator; their path identifies the descriptor field.
  const descriptor = contentTypeDefs[page.pageType as ContentType]
  if (descriptor) {
    const sharedFields = descriptor.sharedFields as Record<string, Primitive>
    walkFieldMap(
      sharedFields,
      page as unknown as Record<string, unknown>,
      (leaf) => {
        const media = mediaLeafValue(leaf)
        if (!media) return
        refs.push({
          ...media,
          path: leaf.path,
          source: leaf.def.kind === "link" ? "slice-media-link" : "descriptor-image",
        })
      }
    )

    const localizedFields = descriptor.localizedFields as Record<
      string,
      Primitive
    >
    for (const [locale, localeContent] of Object.entries(page.content ?? {})) {
      walkFieldMap(
        localizedFields,
        localeContent as unknown as Record<string, unknown>,
        (leaf) => {
          const media = mediaLeafValue(leaf)
          if (!media) return
          refs.push({
            ...media,
            locale,
            path: `content.${locale}.${leaf.path}`,
            source: leaf.def.kind === "link" ? "slice-media-link" : "descriptor-image",
          })
        }
      )
    }
  }

  // Pure-form arms (`sliceBody: false`) have no slice canvas — skip the
  // slice-media walk. Card-image + descriptor-image references above still apply.
  if (!hasSliceBody(page)) return refs

  for (const [locale, localeContent] of Object.entries(page.content ?? {})) {
    const slices = localeContent.slices ?? []
    slices.forEach((slice: Slice, sliceIndex) => {
      const def = readSliceDefinition(readSlice(slice).type)
      if (!def) return

      walkValue(def.primary, readSlice(slice).primary, (leaf) => {
        const media = mediaLeafValue(leaf)
        if (!media) return
        refs.push({
          ...media,
          locale,
          path: `content.${locale}.slices[${sliceIndex}].primary.${leaf.path}`,
          source: leaf.def.kind === "link" ? "slice-media-link" : "slice-image",
        })
      })

      if (!def.items || !("items" in slice)) return
      walkValue(def.items as Primitive, readSlice(slice).items, (leaf) => {
        const media = mediaLeafValue(leaf)
        if (!media) return
        refs.push({
          ...media,
          locale,
          path: `content.${locale}.slices[${sliceIndex}].items${leaf.path}`,
          source: leaf.def.kind === "link" ? "slice-media-link" : "slice-image",
        })
      })
    })
  }

  return refs
}

async function mediaByStorageId(
  ctx: QueryCtx | MutationCtx,
  storageId: Id<"_storage">
): Promise<Doc<"media"> | null> {
  return await ctx.db
    .query("media")
    .withIndex("by_storageId", (q) => q.eq("storageId", storageId))
    .unique()
}

export async function resolveMediaReference(
  ctx: QueryCtx | MutationCtx,
  ref: CollectedMediaReference
): Promise<ResolvedMediaReference | null> {
  if (ref.mediaId) {
    const media = await ctx.db.get(ref.mediaId)
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
  await Promise.all(existing.map((ref) => ctx.db.delete(ref._id)))
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
