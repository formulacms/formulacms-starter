import { ConvexError, v } from "convex/values"

// @content-type-codegen:page-types:start
export const PAGE_TYPES = [
  "landing-page",
  "page",
  "post",
  "author",
  "testimonial",
  "job",
] as const
// @content-type-codegen:page-types:end
export type PageType = (typeof PAGE_TYPES)[number]

// @content-type-codegen:page-type-validator:start
export const pageTypeValidator = v.union(
  v.literal("landing-page"),
  v.literal("page"),
  v.literal("post"),
  v.literal("author"),
  v.literal("testimonial"),
  v.literal("job")
)
// @content-type-codegen:page-type-validator:end

export function isPageType(value: string): value is PageType {
  return (PAGE_TYPES as readonly string[]).includes(value)
}

/**
 * The most ids one public batch read accepts (VISITOR-LIMITS, 0.5.1).
 *
 * Measured on the cached snapshot reader: about 9 index ranges per id when
 * ids share a parent chain and about 36 per id when each id has its own
 * three-level chain; Convex allows 4,096 per query. 50 keeps pages nested up
 * to about six levels inside one call. The site's own callers split longer
 * lists with `chunkIds` in `lib/cms/batched-read.ts`, so a page with many
 * links or images still resolves fully; the cap only bounds what one
 * anonymous call can cost.
 */
export const ID_BATCH_MAX = 50

/** Refuse a raw id list (counted before duplicates are removed) over the cap. */
export function assertIdBatchSize(ids: readonly unknown[]): void {
  if (ids.length > ID_BATCH_MAX) throw new ConvexError("TOO_MANY_IDS")
}
