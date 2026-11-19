import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { visitPageLeaves } from "../mediaReferences"

/**
 * Rich-text images (PERMANENT-DELETE).
 *
 * The rich-text editor inserts a library image as a TipTap `image` node whose
 * `src` is the media row's `url`. The value is stored as a PM-JSON string
 * (ADR-0009), so the id-based collectors never see it. This module finds those
 * nodes and resolves each `src` to its media row through `media.by_url`, so
 * deleting an image that a rich-text field still shows is refused.
 *
 * A `src` that matches no media row is an external image. It is ignored. It is
 * never an error, and nothing here throws on malformed content.
 */

export type CollectedRichTextImage = {
  locale?: string
  /** Field path, the same path the other media reference rows use. */
  path: string
  src: string
}

export type ResolvedRichTextImage = {
  mediaId: Id<"media">
  storageId: Id<"_storage">
  locale?: string
  path: string
}

function parseRichText(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

function imageSources(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return
  const record = node as {
    type?: unknown
    attrs?: { src?: unknown }
    content?: unknown
  }
  if (record.type === "image" && typeof record.attrs?.src === "string") {
    out.push(record.attrs.src)
  }
  if (Array.isArray(record.content))
    for (const child of record.content) imageSources(child, out)
}

export function collectRichTextImages(
  page: Doc<"pages">
): CollectedRichTextImage[] {
  const found: CollectedRichTextImage[] = []
  const seen = new Set<string>()
  visitPageLeaves(page, ({ leaf, locale, path }) => {
    if (leaf.def.kind !== "richText") return
    const sources: string[] = []
    imageSources(parseRichText(leaf.value), sources)
    for (const src of sources) {
      const key = `${locale ?? ""}\0${path}\0${src}`
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ ...(locale === undefined ? {} : { locale }), path, src })
    }
  })
  return found
}

/**
 * Resolve collected sources to media rows. One result per media row and field
 * path, so an image repeated inside one field costs one reference row.
 */
export async function resolveRichTextImages(
  ctx: QueryCtx | MutationCtx,
  collected: readonly CollectedRichTextImage[],
  options: { strict?: boolean } = {}
): Promise<ResolvedRichTextImage[]> {
  const byUrl = new Map<string, Doc<"media"> | null>()
  const resolved: ResolvedRichTextImage[] = []
  const seen = new Set<string>()
  for (const item of collected) {
    if (!byUrl.has(item.src)) {
      byUrl.set(
        item.src,
        await ctx.db
          .query("media")
          .withIndex("by_url", (q) => q.eq("url", item.src))
          .first()
      )
    }
    const media = byUrl.get(item.src)
    if (options.strict) {
      if (!media) {
        // A library image that was deleted for good is not an external image.
        const gone = await ctx.db
          .query("purgedMediaUrls")
          .withIndex("by_url", (q) => q.eq("url", item.src))
          .first()
        if (gone) throw new ConvexError("PUBLICATION_MEDIA_REFERENCE_MISSING")
      } else if (!(await ctx.db.system.get("_storage", media.storageId))) {
        throw new ConvexError("PUBLICATION_MEDIA_STORAGE_MISSING")
      }
    }
    if (!media) continue
    const key = `${media._id}\0${item.locale ?? ""}\0${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    resolved.push({
      mediaId: media._id,
      storageId: media.storageId,
      ...(item.locale === undefined ? {} : { locale: item.locale }),
      path: item.path,
    })
  }
  return resolved
}

export type PublicationSourceKind =
  "shared_draft" | "locale_draft" | "candidate" | "current_public"

/**
 * Rich-text images that belong to one reference source. A Shared Draft owns
 * the locale-less (shared descriptor) fields. A locale draft owns its own
 * locale. Candidates and the current projection also carry the shared fields
 * (same rule as the other media rows in `writeReferences`).
 */
export async function richTextImagesForSource(
  ctx: QueryCtx | MutationCtx,
  source: Doc<"pages">,
  locale: string | undefined,
  sourceKind: PublicationSourceKind,
  options: { strict?: boolean } = {}
): Promise<ResolvedRichTextImage[]> {
  return resolveRichTextImages(
    ctx,
    collectRichTextImages(source).filter((ref) =>
      sourceKind === "shared_draft"
        ? ref.locale === undefined
        : ref.locale === locale ||
          ((sourceKind === "candidate" || sourceKind === "current_public") &&
            ref.locale === undefined)
    ),
    options
  )
}
