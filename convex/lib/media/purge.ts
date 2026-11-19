/**
 * PERMANENT-DELETE (Module 2): permanent delete of a trashed media file.
 *
 * Interface (small): `purgeMediaBatch` (up to 50 files, one result each) and
 * `purgeOneMedia` (the single-file rule `cms.media.remove` shares). The entry
 * points live in `convex/cms/media.ts`.
 *
 * One file is deleted in ONE transaction: the stored object and the `media`
 * row go together or not at all (`ctx.storage.delete` runs inside the
 * mutation transaction). Nothing else is owned by a media row: every other
 * table only POINTS at it, and `findMediaUses` refuses while one still does.
 */
import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"
import { pageTitle } from "../publishing/pagePurge"
import { readPublicationAuthority } from "../publishing/snapshots"
import {
  richTextImageBackfillState,
  startRichTextImageBackfill,
} from "./richTextBackfill"
import {
  findMediaUses,
  loadMenuImageIndex,
  type MediaUses,
  type MenuImageIndex,
} from "./usage"

export const MEDIA_PURGE_MAX_ITEMS = 50
const NAMED_USES = 3

// ─── Classification (the schema-closure test reads these) ──────────────────

/**
 * How one table relates to a media id or a storage id.
 *  - self:    the media row itself; its `storageId` is the file the purge deletes.
 *  - blocks:  rows of OTHER things that point at the file; `findMediaUses`
 *             refuses while one exists.
 *  - tracked: content that embeds an id inside a larger document. A reference
 *             table mirrors those ids, and that table is the one that blocks.
 *  - kept:    rows that stay on purpose, with the reason.
 */
export type MediaKeyedRole =
  | { role: "self"; reason: string }
  | { role: "blocks"; reason: string }
  | { role: "tracked"; via: string; reason: string }
  | { role: "kept"; reason: string }

/** Every table with a `v.id("media")` or `v.id("_storage")` field, found by walking the schema. */
export const MEDIA_KEYED_TABLES: Record<string, MediaKeyedRole> = {
  media: {
    role: "self",
    reason: "The file's own row; the purge deletes it with the stored object.",
  },
  siteSettings: {
    role: "blocks",
    reason:
      "Logo, favicon and default share image: the `*MediaId` fields and the older `*StorageId` twins are both checked.",
  },
  pagePublicationMediaReferences: {
    role: "blocks",
    reason:
      "Shared draft, locale draft, current published and older published version (candidate) rows, rich-text images included.",
  },
  mediaReferences: {
    role: "blocks",
    reason:
      "Legacy page references; a row only counts while its page is not deleted.",
  },
  menus: {
    role: "blocks",
    reason:
      "Navigation item images, live and in Trash (a trashed menu can be restored). No index: menus are few and are scanned once per request.",
  },
  pages: {
    role: "tracked",
    via: "mediaReferences",
    reason:
      "Legacy page content and card image; mirrored by `mediaReferences`.",
  },
  pageStaging: {
    role: "tracked",
    via: "mediaReferences",
    reason: "Legacy draft overlay; mirrored by `mediaReferences`.",
  },
  pageSharedDrafts: {
    role: "tracked",
    via: "pagePublicationMediaReferences",
    reason: "Shared draft fields (card image, shared image fields).",
  },
  pageLocaleDrafts: {
    role: "tracked",
    via: "pagePublicationMediaReferences",
    reason: "Working drafts (slice and field images).",
  },
  aiJobs: {
    role: "kept",
    reason:
      "Working copy of a page taken when the job started. Applying a job writes through the page writers, which resolve every media id and refuse a missing one (`PUBLICATION_MEDIA_REFERENCE_MISSING`). It is never public output.",
  },
  aiJobUnits: {
    role: "kept",
    reason:
      "Unit outputs of an AI job; same reader as `aiJobs`: applying them goes through the page writers.",
  },
  pageCandidateMediaReferences: {
    role: "kept",
    reason:
      "Legacy-authority candidate rows. They never blocked a delete before this unit and a snapshot-authority site writes none; not read here.",
  },
}

/**
 * Media ids and URLs the schema scan cannot see because they live inside JSON
 * text or inside a rich-text string. Each is declared by hand with the reason
 * it is safe, or says plainly that it is not covered.
 */
export const MEDIA_STRING_KEYED: Array<{ where: string; safe: string }> = [
  {
    where:
      "pageLocalePublicationCandidates.payloadJson, pagePublishedSnapshots (through candidateId)",
    safe: "Frozen page content as JSON text. Every candidate has `candidate` rows in pagePublicationMediaReferences, and the current one `current_public` rows. `findMediaUses` blocks on both (F08 clause 15). Rich-text images inside old candidates have rows only after the rich-text backfill, which purge waits for.",
  },
  {
    where:
      "rich-text `image` node `src` inside drafts, candidates and snapshots",
    safe: "The library URL equals `media.url`. Publication writes a `rich-text-image` row per image (resolved through `media.by_url`); the backfill adds them for older sources.",
  },
  {
    where: "pageRevisions content JSON",
    safe: "Legacy revision history, never public output. Restoring a revision writes through the page writers, which refuse a missing media id.",
  },
  {
    where:
      "pages.content and pageStaging.content rich-text `src` on a legacy-authority site",
    safe: "NOT covered: `mediaReferences` never tracked rich-text images and the backfill only reaches snapshot-authority sources. Permanent media delete on a legacy-authority site can therefore break a rich-text image. Legacy authority is not the shipped path; reported to the seat.",
  },
]

// ─── The shape the entry points return ─────────────────────────────────────

export type MediaUseDetail = {
  count: number
  uses: Array<{
    kind: "setting" | "page" | "menu"
    name: string
    /** Where a page use lives. */
    where?: "draft" | "published" | "older_version" | "legacy"
    /** A menu use that sits in Trash. */
    inTrash?: boolean
  }>
  /** Every use is an older published version of a page. */
  olderVersionsOnly: boolean
}

export type MediaPurgeResult = {
  id: Id<"media">
  status: "purged" | "refused"
  reason?: "not_found" | "not_trashed" | "in_use" | "index_pending"
  /**
   * Set for `index_pending`: `MEDIA_USAGE_INDEX_PENDING` while the usage
   * backfill runs, `MEDIA_USAGE_INDEX_FAILED` when it failed (each new call
   * resumes it).
   */
  code?: "MEDIA_USAGE_INDEX_PENDING" | "MEDIA_USAGE_INDEX_FAILED"
  detail?: MediaUseDetail
}

/** Plain names for the first three uses, with the total count. */
export async function describeMediaUses(
  ctx: MutationCtx,
  uses: MediaUses
): Promise<MediaUseDetail> {
  const named: MediaUseDetail["uses"] = []
  for (const name of uses.settings) {
    if (named.length >= NAMED_USES) break
    named.push({ kind: "setting", name })
  }
  const seen = new Set<string>()
  for (const page of uses.pages) {
    if (named.length >= NAMED_USES) break
    if (seen.has(`${page._id}:legacy`)) continue
    seen.add(`${page._id}:legacy`)
    named.push({ kind: "page", name: page.title, where: "legacy" })
  }
  // Live uses first: an older version is the least useful thing to name.
  const publication = [...uses.publication].sort(
    (a, b) =>
      Number(a.sourceKind === "candidate") -
      Number(b.sourceKind === "candidate")
  )
  for (const row of publication) {
    if (named.length >= NAMED_USES) break
    const where =
      row.sourceKind === "candidate"
        ? ("older_version" as const)
        : row.sourceKind === "current_public"
          ? ("published" as const)
          : ("draft" as const)
    if (seen.has(`${row.pageId}:${where}`)) continue
    seen.add(`${row.pageId}:${where}`)
    named.push({
      kind: "page",
      name: await pageTitle(ctx, row.pageId),
      where,
    })
  }
  for (const menu of uses.menus) {
    if (named.length >= NAMED_USES) break
    named.push({
      kind: "menu",
      name: menu.slug,
      ...(menu.trashed ? { inTrash: true } : {}),
    })
  }
  return {
    count: uses.count,
    uses: named,
    olderVersionsOnly: uses.olderVersionsOnly,
  }
}

// ─── Purge ──────────────────────────────────────────────────────────────────

async function purgeLoaded(
  ctx: MutationCtx,
  media: Doc<"media"> | null,
  id: Id<"media">,
  menuImages: MenuImageIndex
): Promise<MediaPurgeResult> {
  if (!media) return { id, status: "refused", reason: "not_found" }
  if (media.deletedAt === undefined)
    return { id, status: "refused", reason: "not_trashed" }
  const uses = await findMediaUses(ctx, media, { history: true, menuImages })
  if (uses.count > 0)
    return {
      id,
      status: "refused",
      reason: "in_use",
      detail: await describeMediaUses(ctx, uses),
    }
  // Two rows can name one stored file (two `media.create` calls). The object
  // goes only with its last row; the row always goes.
  const aliases = await ctx.db
    .query("media")
    .withIndex("by_storageId", (q) => q.eq("storageId", media.storageId))
    .take(2)
  const sharedFile = aliases.some((row) => row._id !== id)
  // The stored object can be gone already (corruption, an earlier partial
  // cleanup). The row must still be deletable then.
  if (!sharedFile && (await ctx.db.system.get("_storage", media.storageId)))
    await ctx.storage.delete(media.storageId)
  await ctx.db.delete("media", id)
  // Remember the URL: kept copies of old content must not show it as external.
  await ctx.db.insert("purgedMediaUrls", {
    url: media.url,
    purgedAt: Date.now(),
  })
  return { id, status: "purged" }
}

/**
 * Permanently delete trashed files, one result per id. A refused file never
 * blocks the others. While the rich-text backfill has not finished, no file is
 * deleted: the first call starts the backfill and every item answers
 * `index_pending`; the owner tries again when it has finished.
 */
/**
 * The usage index (reference rows, rich-text backfill) covers snapshot
 * authority only. Legacy content, restorable trashed content and retained
 * candidates are not indexed there, so a permanent delete is not available.
 */
async function requireSnapshotAuthorityForPurge(ctx: MutationCtx) {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active")
    throw new ConvexError("MEDIA_PURGE_NOT_AVAILABLE")
}

export async function purgeMediaBatch(
  ctx: MutationCtx,
  ids: readonly Id<"media">[]
): Promise<MediaPurgeResult[]> {
  await requireSnapshotAuthorityForPurge(ctx)
  if (ids.length > MEDIA_PURGE_MAX_ITEMS)
    throw new ConvexError({
      code: "MEDIA_PURGE_BATCH_TOO_LARGE",
      limit: MEDIA_PURGE_MAX_ITEMS,
    })
  if (ids.length === 0) return []
  const backfill = await richTextImageBackfillState(ctx)
  if (backfill !== "done") {
    await startRichTextImageBackfill(ctx)
    return ids.map((id) => ({
      id,
      status: "refused" as const,
      reason: "index_pending" as const,
      code:
        backfill === "failed"
          ? ("MEDIA_USAGE_INDEX_FAILED" as const)
          : ("MEDIA_USAGE_INDEX_PENDING" as const),
    }))
  }
  const menuImages = await loadMenuImageIndex(ctx)
  const results: MediaPurgeResult[] = []
  const seen = new Set<Id<"media">>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    results.push(
      await purgeLoaded(ctx, await ctx.db.get("media", id), id, menuImages)
    )
  }
  return results
}

/** `cms.media.remove`: same rules, errors instead of results. */
export async function purgeOneMedia(
  ctx: MutationCtx,
  id: Id<"media">
): Promise<void> {
  await requireSnapshotAuthorityForPurge(ctx)
  const media = await ctx.db.get("media", id)
  if (!media) return
  if (media.deletedAt === undefined)
    throw new ConvexError({
      code: "MEDIA_NOT_TRASHED",
      message: "Move this file to Trash before deleting it for good.",
    })
  const backfill = await richTextImageBackfillState(ctx)
  if (backfill !== "done")
    throw new ConvexError({
      code:
        backfill === "failed"
          ? "MEDIA_USAGE_INDEX_FAILED"
          : "MEDIA_USAGE_INDEX_PENDING",
      message:
        "The image usage index is still being prepared. Try again in a moment.",
    })
  const result = await purgeLoaded(
    ctx,
    media,
    id,
    await loadMenuImageIndex(ctx)
  )
  if (result.status === "purged") return
  const names = (result.detail?.uses ?? []).map((use) => use.name).join(", ")
  throw new ConvexError({
    code: "MEDIA_IN_USE",
    message: `This file is used by ${names || "other content"}${
      (result.detail?.count ?? 0) > NAMED_USES ? " and more" : ""
    }. Remove those references first.`,
  })
}
