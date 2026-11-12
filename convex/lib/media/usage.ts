import { ConvexError } from "convex/values"
import type { QueryCtx, MutationCtx } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import { getStagingByPageId } from "../publishing/staging"

// Keep usage reads bounded. The deletion guard only needs to know whether a
// reference exists, while the editor-facing error/list only needs a useful
// prefix of the referencing pages.
const MEDIA_USAGE_REFERENCE_LIMIT = 100
const MEDIA_SOFT_DELETE_DETAIL_LIMIT = 3

export type MediaUsage = {
  settings: string[]
  pages: Array<{
    _id: Doc<"pages">["_id"]
    title: string
    slug: string
  }>
}

function pageTitleFromContentOrStaging(
  page: Doc<"pages">,
  staging: Doc<"pageStaging"> | null
): string {
  const first = Object.values(page.content ?? {})[0]
  if (first?.title) return first.title
  if (staging?.effectiveTitles) {
    for (const value of Object.values(staging.effectiveTitles)) {
      if (value && value.length > 0) return value
    }
  }
  return "Untitled"
}

export async function getMediaUsage(
  ctx: QueryCtx | MutationCtx,
  media: Doc<"media">
): Promise<MediaUsage> {
  const settings: string[] = []
  const siteSettings = await ctx.db.query("siteSettings").first()
  if (siteSettings?.logoMediaId === media._id) settings.push("logo")
  if (siteSettings?.faviconMediaId === media._id) settings.push("favicon")
  if (siteSettings?.defaultOgImageMediaId === media._id) {
    settings.push("default OG image")
  }

  const references = await ctx.db
    .query("mediaReferences")
    .withIndex("by_mediaId", (q) => q.eq("mediaId", media._id))
    .take(MEDIA_USAGE_REFERENCE_LIMIT)
  const uniquePageIds: Array<(typeof references)[number]["pageId"]> = []
  const seenPageIds = new Set<string>()
  for (const reference of references) {
    if (seenPageIds.has(reference.pageId)) continue
    seenPageIds.add(reference.pageId)
    uniquePageIds.push(reference.pageId)
  }
  const resolved = await Promise.all(
    uniquePageIds.map(async (pageId) => {
      const page = await ctx.db.get(pageId)
      if (!page || page.deletedAt !== undefined) return null
      const staging =
        page.status === "published"
          ? null
          : await getStagingByPageId(ctx, page._id)
      return {
        _id: page._id,
        title: pageTitleFromContentOrStaging(page, staging),
        slug: page.slug,
      }
    })
  )
  const pages = resolved.filter(
    (row): row is NonNullable<(typeof resolved)[number]> => row !== null
  )

  return { settings, pages }
}

export async function assertMediaUnreferenced(
  ctx: QueryCtx | MutationCtx,
  media: Doc<"media">
): Promise<void> {
  // Snapshot candidates and current projections retain media/storage identity
  // for immutable history. They are independent of the legacy page mirror and
  // therefore must be checked before a physical storage delete.
  const snapshotReferences = await ctx.db
    .query("pagePublicationMediaReferences")
    .withIndex("by_mediaId", (q) => q.eq("mediaId", media._id))
    .take(1)
  if (snapshotReferences.length > 0) {
    throw new ConvexError(
      "This file is retained by an immutable publication snapshot. Withdraw or purge it through a separately reviewed operation first."
    )
  }
  const usage = await getMediaUsage(ctx, media)
  if (usage.settings.length > 0 || usage.pages.length > 0) {
    throw new ConvexError(
      `This file is used by ${formatUsageForError(usage)}. Remove those references first.`
    )
  }
}

export async function assertMediaSoftDeleteAllowed(
  ctx: MutationCtx,
  media: Doc<"media">
): Promise<void> {
  const [snapshotReferencePages, legacyReferenceWindow] = await Promise.all([
    Promise.all(
      (["shared_draft", "locale_draft", "current_public"] as const).map(
        (sourceKind) =>
          ctx.db
            .query("pagePublicationMediaReferences")
            .withIndex("by_mediaId_and_sourceKind", (q) =>
              q.eq("mediaId", media._id).eq("sourceKind", sourceKind)
            )
            .take(MEDIA_SOFT_DELETE_DETAIL_LIMIT + 1)
      )
    ),
    ctx.db
      .query("mediaReferences")
      .withIndex("by_mediaId", (q) => q.eq("mediaId", media._id))
      .take(MEDIA_USAGE_REFERENCE_LIMIT + 1),
  ])
  const snapshotReferences = snapshotReferencePages
    .flat()
    .sort(
      (a, b) =>
        a.sourceKind.localeCompare(b.sourceKind) ||
        String(a.pageId).localeCompare(String(b.pageId)) ||
        ("locale" in a ? a.locale : "").localeCompare(
          "locale" in b ? b.locale : ""
        ) ||
        a.sourcePath.localeCompare(b.sourcePath)
    )
  const usage = await getMediaUsage(ctx, media)
  const legacyReferenceReadTruncated =
    legacyReferenceWindow.length > MEDIA_USAGE_REFERENCE_LIMIT
  if (
    usage.settings.length === 0 &&
    usage.pages.length === 0 &&
    snapshotReferences.length === 0 &&
    !legacyReferenceReadTruncated
  ) {
    return
  }

  throw new ConvexError({
    code: "MEDIA_SOFT_DELETE_REFERENCED",
    settings: usage.settings.slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT),
    pageIds: usage.pages
      .slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT)
      .map((page) => page._id),
    snapshotReferences: snapshotReferences
      .slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT)
      .map((reference) => ({
        pageId: reference.pageId,
        sourceKind: reference.sourceKind,
        ...(reference.sourceKind === "shared_draft"
          ? {}
          : { locale: reference.locale }),
        sourcePath: reference.sourcePath,
      })),
    truncated:
      usage.settings.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      usage.pages.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      snapshotReferences.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      legacyReferenceReadTruncated,
  })
}

export function formatUsageForError(
  usage: Awaited<ReturnType<typeof getMediaUsage>>
) {
  const parts: string[] = []
  if (usage.settings.length > 0) {
    parts.push(`settings: ${usage.settings.join(", ")}`)
  }
  if (usage.pages.length > 0) {
    const titles = usage.pages.slice(0, 3).map((page) => page.title)
    const more =
      usage.pages.length > 3 ? ` and ${usage.pages.length - 3} more` : ""
    parts.push(`pages: ${titles.join(", ")}${more}`)
  }
  return parts.join("; ")
}
