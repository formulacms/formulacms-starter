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
  const settings = await settingsUsingMedia(ctx, media)

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
      const page = await ctx.db.get("pages", pageId)
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

/**
 * Site settings that show this media. The `*MediaId` fields are current. The
 * `*StorageId` twins are older rows that stored only the file, so the twin
 * counts as a use too.
 */
async function settingsUsingMedia(
  ctx: QueryCtx | MutationCtx,
  media: Doc<"media">
): Promise<string[]> {
  const settings: string[] = []
  const site = await ctx.db.query("siteSettings").first()
  if (!site) return settings
  if (
    site.logoMediaId === media._id ||
    site.logoStorageId === media.storageId
  )
    settings.push("logo")
  if (
    site.faviconMediaId === media._id ||
    site.faviconStorageId === media.storageId
  )
    settings.push("favicon")
  if (
    site.defaultOgImageMediaId === media._id ||
    site.defaultOgImageStorageId === media.storageId
  )
    settings.push("default OG image")
  return settings
}

// ─── Menu images ────────────────────────────────────────────────────────────

export type MenuImageIndex = Map<string, Array<{ slug: string; trashed: boolean }>>

function collectMenuImages(node: unknown, found: Set<string>): void {
  if (!node || typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const child of node) collectMenuImages(child, found)
    return
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "image" && child && typeof child === "object") {
      const image = child as { storageId?: unknown; url?: unknown }
      if (typeof image.storageId === "string")
        found.add(`storage:${image.storageId}`)
      if (typeof image.url === "string") found.add(`url:${image.url}`)
    }
    collectMenuImages(child, found)
  }
}

/**
 * Every image a menu shows, live or in Trash (a trashed menu can be restored).
 * Menus are few, so one scan serves a whole batch of media.
 */
export async function loadMenuImageIndex(
  ctx: QueryCtx | MutationCtx
): Promise<MenuImageIndex> {
  const index: MenuImageIndex = new Map()
  for await (const menu of ctx.db.query("menus")) {
    const found = new Set<string>()
    collectMenuImages(menu.nav, found)
    for (const key of found) {
      const list = index.get(key) ?? []
      list.push({ slug: menu.slug, trashed: menu.deletedAt !== undefined })
      index.set(key, list)
    }
  }
  return index
}

// ─── One answer to "what still shows this image?" ───────────────────────────

export type PublicationUse = {
  pageId: Doc<"pagePublicationMediaReferences">["pageId"]
  sourceKind: Doc<"pagePublicationMediaReferences">["sourceKind"]
  locale?: string
  sourcePath: string
  referenceKind: Doc<"pagePublicationMediaReferences">["referenceKind"]
}

export type MediaUses = {
  settings: string[]
  /** Legacy `mediaReferences` pages that are not deleted. */
  pages: MediaUsage["pages"]
  /** Draft, published and (when asked) older-version reference rows. */
  publication: PublicationUse[]
  menus: Array<{ slug: string; trashed: boolean }>
  /** Uses found within the read caps (a lower bound when `truncated`). */
  count: number
  truncated: boolean
  /** Every use is an older published version (candidate rows). */
  olderVersionsOnly: boolean
}

const PUBLICATION_LIVE_KINDS = [
  "shared_draft",
  "locale_draft",
  "current_public",
] as const
const PUBLICATION_HISTORY_KINDS = [...PUBLICATION_LIVE_KINDS, "candidate"] as const

/**
 * Everything that still shows this media: site settings (id and storage twin),
 * draft/published/older-version publication rows (rich-text images included),
 * menus (live and in Trash) and legacy page references. Move to Trash and
 * permanent delete both use it.
 *
 * `history` adds `candidate` rows, the older published versions. F08 clause 15
 * says they block permanent deletion. Move to Trash never blocked on them and
 * keeps that behavior (an old version alone does not stop the owner from
 * moving a file to Trash).
 */
export async function findMediaUses(
  ctx: QueryCtx | MutationCtx,
  media: Doc<"media">,
  options: { history: boolean; menuImages?: MenuImageIndex }
): Promise<MediaUses> {
  const kinds = options.history
    ? PUBLICATION_HISTORY_KINDS
    : PUBLICATION_LIVE_KINDS
  const [rowsByKind, legacyWindow, usage, menuImages] = await Promise.all([
    Promise.all(
      kinds.map((sourceKind) =>
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
    getMediaUsage(ctx, media),
    options.menuImages ? Promise.resolve(options.menuImages) : loadMenuImageIndex(ctx),
  ])
  const rows = rowsByKind
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
  const publication: PublicationUse[] = rows.map((row) => ({
    pageId: row.pageId,
    sourceKind: row.sourceKind,
    ...(row.sourceKind === "shared_draft" ? {} : { locale: row.locale }),
    sourcePath: row.sourcePath,
    referenceKind: row.referenceKind,
  }))
  const menuSeen = new Set<string>()
  const menus: Array<{ slug: string; trashed: boolean }> = []
  for (const key of [`storage:${media.storageId}`, `url:${media.url}`]) {
    for (const hit of menuImages.get(key) ?? []) {
      if (menuSeen.has(hit.slug)) continue
      menuSeen.add(hit.slug)
      menus.push(hit)
    }
  }
  const legacyTruncated = legacyWindow.length > MEDIA_USAGE_REFERENCE_LIMIT
  const count =
    usage.settings.length +
    usage.pages.length +
    publication.length +
    menus.length +
    (legacyTruncated && usage.pages.length === 0 ? 1 : 0)
  return {
    settings: usage.settings,
    pages: usage.pages,
    publication,
    menus,
    count,
    truncated:
      usage.settings.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      usage.pages.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      publication.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT ||
      legacyTruncated,
    olderVersionsOnly:
      count > 0 &&
      usage.settings.length === 0 &&
      usage.pages.length === 0 &&
      menus.length === 0 &&
      publication.every((row) => row.sourceKind === "candidate"),
  }
}

export async function assertMediaSoftDeleteAllowed(
  ctx: MutationCtx,
  media: Doc<"media">
): Promise<void> {
  const uses = await findMediaUses(ctx, media, { history: false })
  if (uses.count === 0) return

  throw new ConvexError({
    code: "MEDIA_SOFT_DELETE_REFERENCED",
    settings: uses.settings.slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT),
    pageIds: uses.pages
      .slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT)
      .map((page) => page._id),
    snapshotReferences: uses.publication
      .slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT)
      .map((reference) => ({
        pageId: reference.pageId,
        sourceKind: reference.sourceKind,
        ...(reference.locale === undefined ? {} : { locale: reference.locale }),
        sourcePath: reference.sourcePath,
      })),
    ...(uses.menus.length > 0
      ? { menus: uses.menus.slice(0, MEDIA_SOFT_DELETE_DETAIL_LIMIT).map((m) => m.slug) }
      : {}),
    truncated: uses.truncated || uses.menus.length > MEDIA_SOFT_DELETE_DETAIL_LIMIT,
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
