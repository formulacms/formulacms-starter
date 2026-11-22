import { ConvexError, v } from "convex/values"
import { nextUpdatedAt } from "../lib/versions"
import {
  paginationOptsValidator,
  paginationResultValidator,
  type PaginationResult,
} from "convex/server"
import { paginator } from "convex-helpers/server/pagination"
import { customCtx, customQuery } from "convex-helpers/server/customFunctions"
import schema from "../schema"
import {
  internalQuery,
  mutation,
  query,
  type QueryCtx,
} from "../_generated/server"
import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { requireOperationAccess } from "../lib/access/policy"
import { hasBlockBody } from "../lib/domains/contentEditing"
import { recordPublicChange } from "../lib/language/freshness"
import { REGISTERED_BLOCK_TYPES } from "../lib/blocks"
import { blockAuthoringContractState } from "../lib/blocks/authoringState"
import { requireBlockTypeRetirementPermission } from "../lib/blocks/permissions"
import { requireAnyPageTypePermission } from "./pages"
import {
  readBlockOccurrenceCounter,
  readBlockOccurrenceState,
  BLOCK_OCCURRENCE_EPOCH,
} from "../lib/publishing/staging"
import { occurrencePresentationId } from "../lib/blocks/occurrencePresentation"

const occurrenceOwnerQuery = customQuery(
  query,
  customCtx(async (ctx) => ({ owner: await requireOperationAccess(ctx) }))
)

/** Reads only initialized namespace totals; never walks retained source history. */
export const getBlockPresentationUsageSummary = occurrenceOwnerQuery({
  args: { type: v.string(), presentationIds: v.array(v.string()) },
  returns: v.union(
    v.object({
      status: v.literal("ready"),
      counts: v.record(v.string(), v.number()),
    }),
    v.object({ status: v.literal("unavailable") })
  ),
  handler: async (ctx, { type, presentationIds }) => {
    const unavailable = { status: "unavailable" as const }
    if (
      !(REGISTERED_BLOCK_TYPES as readonly string[]).includes(type) ||
      presentationIds.length > 3 ||
      presentationIds.some((id) => occurrencePresentationId(id) !== id)
    )
      return unavailable
    const state = await readBlockOccurrenceState(ctx)
    if (
      !state ||
      state.status !== "ready" ||
      state.epoch !== BLOCK_OCCURRENCE_EPOCH ||
      state.unknownInvalidSources !== 0 ||
      state.verificationFailed
    )
      return unavailable
    const integrity = await readBlockOccurrenceCounter(ctx, type, "default")
    if (
      !integrity ||
      integrity.epoch !== state.epoch ||
      integrity.invalidSources !== 0
    )
      return unavailable
    const counts: Record<string, number> = {}
    for (const id of new Set(presentationIds)) {
      const counter =
        id === "default"
          ? integrity
          : await readBlockOccurrenceCounter(ctx, type, id)
      if (
        !counter ||
        counter.epoch !== state.epoch ||
        !Number.isSafeInteger(counter.count) ||
        counter.count < 0
      )
        return unavailable
      counts[id] = counter.count
    }
    return { status: "ready" as const, counts }
  },
})

/**
 * Block library authoring: archive curation and the block-usage report behind
 * retirement. The local developer CLI and excluded block-library tools call it;
 * `getArchivedBlockTypes` stays core in `./blocks` for the editor picker.
 * This module imports `./pages`; `./pages` never imports it.
 */

export const setBlockArchived = mutation({
  args: {
    type: v.string(),
    archived: v.boolean(),
    /** Optional for retained UI callers; developer CLI binds both values. */
    expectedState: v.optional(
      v.object({ contracts: v.string(), archived: v.boolean() })
    ),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { type, archived, expectedState }) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) {
      throw new ConvexError("Site settings are not initialized yet.")
    }
    const registeredTypes = new Set<string>(REGISTERED_BLOCK_TYPES)
    if (!registeredTypes.has(type)) {
      throw new ConvexError(`Unknown Block Type "${type}".`)
    }
    if (
      expectedState &&
      (expectedState.contracts !== blockAuthoringContractState().contracts ||
        expectedState.archived !==
          (settings.archivedBlockTypes ?? []).includes(type))
    )
      throw new ConvexError("BLOCK_AUTHORING_STATE_CHANGED")
    const set = new Set(
      (settings.archivedBlockTypes ?? []).filter((storedType) =>
        registeredTypes.has(storedType)
      )
    )
    if (archived) set.add(type)
    else set.delete(type)
    const next = [...set].sort()
    await ctx.db.patch("siteSettings", settings._id, {
      archivedBlockTypes: next,
      updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
    })
    await recordPublicChange(ctx, { scopes: [] })
    return next
  },
})

/**
 * Remove the archive marker after local source deletion. This deliberately
 * does not validate against `REGISTERED_BLOCK_TYPES`: the successful filesystem step has
 * already removed the type from the generated registry, and a retry must still
 * be able to clean the stale curation value.
 */
export const cleanupDeletedBlockTypeArchive = mutation({
  args: { type: v.string() },
  returns: v.array(v.string()),
  handler: async (ctx, { type }) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) {
      throw new ConvexError("Site settings are not initialized yet.")
    }
    const current = settings.archivedBlockTypes ?? []
    const next = [
      ...new Set(current.filter((storedType) => storedType !== type)),
    ].sort()
    if (
      next.length !== current.length ||
      next.some((storedType, index) => storedType !== current[index])
    ) {
      await ctx.db.patch("siteSettings", settings._id, {
        archivedBlockTypes: next,
        updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
      })
      await recordPublicChange(ctx, { scopes: [] })
    }
    return next
  },
})

function pageTitle(page: Doc<"pages">): string {
  const first = Object.values(page.content ?? {})[0]
  return first?.title || "Untitled"
}

async function assertRetirementAllowed(ctx: QueryCtx, type: string) {
  await requireBlockTypeRetirementPermission(ctx, type)
  const successorReference = await ctx.db
    .query("pagePublicationBlockReferences")
    .withIndex("by_blockType", (q) => q.eq("blockType", type))
    .first()
  if (successorReference) {
    throw new ConvexError("BLOCK_TYPE_REFERENCED_BY_PUBLICATION")
  }
}

export const assertBlockTypeRetirementAllowed = query({
  args: { type: v.string() },
  returns: v.null(),
  handler: async (ctx, { type }) => {
    await assertRetirementAllowed(ctx, type)
    return null
  },
})

// Cap on how many usage rows we return for display; counts below reflect the
// FULL table scan regardless, so the gate never undercounts (F4).
const BLOCK_USAGE_DETAIL_LIMIT = 100

type BlockContentUsage = {
  count: number
  locales: string[]
}

type BlockContentLocationSummary = {
  pageId: Id<"pages">
  locale: string
  index: number
  path: string
}

function countBlockContentUsage(
  content:
    | Record<
        string,
        { readonly blocks?: readonly { readonly type: string }[] } | undefined
      >
    | undefined,
  type: string
): BlockContentUsage {
  let count = 0
  const locales: string[] = []
  for (const [locale, localeContent] of Object.entries(content ?? {})) {
    const localeCount = (localeContent?.blocks ?? []).filter(
      (block) => block.type === type
    ).length
    if (localeCount === 0) continue
    locales.push(locale)
    count += localeCount
  }
  return { count, locales }
}

function blockContentLocations(
  content:
    | Record<
        string,
        { readonly blocks?: readonly { readonly type: string }[] } | undefined
      >
    | undefined,
  type: string,
  pageId: Id<"pages">
): BlockContentLocationSummary[] {
  const locations: BlockContentLocationSummary[] = []
  for (const [locale, localeContent] of Object.entries(content ?? {})) {
    for (const [index, block] of (localeContent?.blocks ?? []).entries()) {
      if (block.type !== type) continue
      locations.push({
        pageId,
        locale,
        index,
        path: `content.${locale}.blocks[${index}]`,
      })
    }
  }
  return locations
}

type BlockUsageBatch =
  | { domain: "saved"; result: PaginationResult<Doc<"pages">> }
  | { domain: "staged"; result: PaginationResult<Doc<"pageStaging">> }
  | {
      domain: "publication"
      result: PaginationResult<Doc<"pagePublicationBlockReferences">>
    }

/** Native pagination's one-call limit is shared across nested queries. The
 * helper supports multiple finite scans in the parent's read snapshot, with
 * cursors consumed only by the internal scan loops below. */
export const scanBlockUsageBatch = internalQuery({
  args: {
    domain: v.union(
      v.literal("saved"),
      v.literal("staged"),
      v.literal("publication")
    ),
    type: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.union(
    v.object({
      domain: v.literal("saved"),
      result: paginationResultValidator(schema.doc("pages")),
    }),
    v.object({
      domain: v.literal("staged"),
      result: paginationResultValidator(schema.doc("pageStaging")),
    }),
    v.object({
      domain: v.literal("publication"),
      result: paginationResultValidator(
        schema.doc("pagePublicationBlockReferences")
      ),
    })
  ),
  handler: async (
    ctx,
    { domain, type, paginationOpts }
  ): Promise<BlockUsageBatch> => {
    const db = paginator(ctx.db, schema)
    if (domain === "saved")
      return {
        domain,
        result: await db.query("pages").paginate(paginationOpts),
      }
    if (domain === "staged")
      return {
        domain,
        result: await db.query("pageStaging").paginate(paginationOpts),
      }
    return {
      domain,
      result: await db
        .query("pagePublicationBlockReferences")
        .withIndex("by_blockType", (q) => q.eq("blockType", type))
        .paginate(paginationOpts),
    }
  },
})

async function pageIsDeleted(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  page: Doc<"pages"> | null
): Promise<boolean> {
  if (!page || page.deletedAt !== undefined) return true
  const state = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .unique()
  return state?.lifecycleState === "trashed"
}

const savedBlockUsageScanValidator = v.object({
  usageCount: v.number(),
  pageCount: v.number(),
  deletedPageCount: v.number(),
  detailPageIds: v.array(v.id("pages")),
})

type SavedBlockUsageScan = {
  usageCount: number
  pageCount: number
  deletedPageCount: number
  detailPageIds: Id<"pages">[]
}

export const scanSavedBlockUsage = internalQuery({
  args: { type: v.string() },
  returns: savedBlockUsageScanValidator,
  handler: async (ctx, { type }): Promise<SavedBlockUsageScan> => {
    let usageCount = 0
    let pageCount = 0
    let deletedPageCount = 0
    const detailPageIds: Id<"pages">[] = []
    let cursor: string | null = null

    for (;;) {
      const response: BlockUsageBatch = await ctx.runQuery(
        internal.cms.blockLibrary.scanBlockUsageBatch,
        { domain: "saved", type, paginationOpts: { numItems: 200, cursor } }
      )
      if (response.domain !== "saved")
        throw new ConvexError("BLOCK_USAGE_BATCH_INVALID")
      const batch: PaginationResult<Doc<"pages">> = response.result
      for (const page of batch.page) {
        if (!page.content || !hasBlockBody(page)) continue
        const usage = countBlockContentUsage(page.content, type)
        if (usage.count === 0) continue
        usageCount += usage.count
        pageCount++
        if (await pageIsDeleted(ctx, page._id, page)) deletedPageCount++
        if (detailPageIds.length < BLOCK_USAGE_DETAIL_LIMIT) {
          detailPageIds.push(page._id)
        }
      }
      if (batch.isDone) break
      cursor = batch.continueCursor
    }

    return { usageCount, pageCount, deletedPageCount, detailPageIds }
  },
})

const stagedBlockUsageScanValidator = v.object({
  usageCount: v.number(),
  pageCount: v.number(),
  stagingOnlyPageCount: v.number(),
  stagingOnlyDeletedPageCount: v.number(),
  detailPageIds: v.array(v.id("pages")),
})

type StagedBlockUsageScan = {
  usageCount: number
  pageCount: number
  stagingOnlyPageCount: number
  stagingOnlyDeletedPageCount: number
  detailPageIds: Id<"pages">[]
}

type BlockUsageSummary = {
  archived: boolean
  pageCount: number
  deletedPageCount: number
  usageCount: number
  savedUsageCount: number
  stagedUsageCount: number
  publicationUsageCount: number
  pages: Array<{
    pageId: Id<"pages">
    title: string
    slug: string
    locales: string[]
    savedLocales: string[]
    stagedLocales: string[]
    publicationLocales: string[]
    count: number
    savedCount: number
    stagedCount: number
    publicationCount: number
    deleted: boolean
  }>
  contentLocations?: BlockContentLocationSummary[]
}

export const scanStagedBlockUsage = internalQuery({
  args: { type: v.string() },
  returns: stagedBlockUsageScanValidator,
  handler: async (ctx, { type }): Promise<StagedBlockUsageScan> => {
    let usageCount = 0
    let pageCount = 0
    let stagingOnlyPageCount = 0
    let stagingOnlyDeletedPageCount = 0
    const detailPageIds: Id<"pages">[] = []
    let cursor: string | null = null

    for (;;) {
      const response: BlockUsageBatch = await ctx.runQuery(
        internal.cms.blockLibrary.scanBlockUsageBatch,
        { domain: "staged", type, paginationOpts: { numItems: 200, cursor } }
      )
      if (response.domain !== "staged")
        throw new ConvexError("BLOCK_USAGE_BATCH_INVALID")
      const batch: PaginationResult<Doc<"pageStaging">> = response.result
      const batchUsage = await Promise.all(
        batch.page.map(async (staging) => {
          const stagedUsage = countBlockContentUsage(
            staging.content as
              | Record<
                  string,
                  {
                    readonly blocks?: readonly { readonly type: string }[]
                  }
                >
              | undefined,
            type
          )
          if (stagedUsage.count === 0) return null

          const page = await ctx.db.get("pages", staging.pageId)
          const savedUsage =
            page?.content && hasBlockBody(page)
              ? countBlockContentUsage(page.content, type).count
              : 0
          return {
            pageId: staging.pageId,
            usageCount: stagedUsage.count,
            stagingOnly: savedUsage === 0,
            stagingOnlyDeleted:
              savedUsage === 0 &&
              (await pageIsDeleted(ctx, staging.pageId, page)),
          }
        })
      )
      for (const usage of batchUsage) {
        if (!usage) continue
        usageCount += usage.usageCount
        pageCount++
        if (detailPageIds.length < BLOCK_USAGE_DETAIL_LIMIT) {
          detailPageIds.push(usage.pageId)
        }
        if (usage.stagingOnly) stagingOnlyPageCount++
        if (usage.stagingOnlyDeleted) stagingOnlyDeletedPageCount++
      }
      if (batch.isDone) break
      cursor = batch.continueCursor
    }

    return {
      usageCount,
      pageCount,
      stagingOnlyPageCount,
      stagingOnlyDeletedPageCount,
      detailPageIds,
    }
  },
})

type PublicationBlockUsageScan = {
  usageCount: number
  publicationOnlyPageCount: number
  publicationOnlyDeletedPageCount: number
  details: Array<{ pageId: Id<"pages">; count: number; locales: string[] }>
}

/** Every retained source copy can constrain a model update, including historical
 * candidates/snapshots and orphan references. Display bounds never truncate
 * these authority totals. The platform's transaction limits fail the query
 * rather than returning a partial count. */
async function scanPublicationBlockUsage(
  ctx: QueryCtx,
  type: string,
  detailPageIds: Id<"pages">[]
): Promise<PublicationBlockUsageScan> {
  if (detailPageIds.length > BLOCK_USAGE_DETAIL_LIMIT)
    throw new ConvexError("BLOCK_USAGE_DETAIL_LIMIT")
  // Reserve legacy-selected rows before scanning: a displayed legacy Page
  // must receive all its publication counts even when its references occur
  // after the first 100 publication Pages.
  const details = new Map<Id<"pages">, { count: number; locales: Set<string> }>(
    detailPageIds.map((pageId) => [
      pageId,
      { count: 0, locales: new Set<string>() },
    ])
  )
  const seenPages = new Set<Id<"pages">>()
  let usageCount = 0
  let publicationOnlyPageCount = 0
  let publicationOnlyDeletedPageCount = 0
  let cursor: string | null = null
  for (;;) {
    const response: BlockUsageBatch = await ctx.runQuery(
      internal.cms.blockLibrary.scanBlockUsageBatch,
      { domain: "publication", type, paginationOpts: { numItems: 200, cursor } }
    )
    if (response.domain !== "publication")
      throw new ConvexError("BLOCK_USAGE_BATCH_INVALID")
    const batch: PaginationResult<Doc<"pagePublicationBlockReferences">> =
      response.result
    for (const reference of batch.page) {
      if (
        !Number.isSafeInteger(reference.count) ||
        reference.count <= 0 ||
        !Number.isSafeInteger(usageCount + reference.count)
      )
        throw new ConvexError("INVALID_BLOCK_PUBLICATION_USAGE")
      usageCount += reference.count
      if (!seenPages.has(reference.pageId)) {
        seenPages.add(reference.pageId)
        const [page, staging] = await Promise.all([
          ctx.db.get("pages", reference.pageId),
          ctx.db
            .query("pageStaging")
            .withIndex("by_pageId", (q) => q.eq("pageId", reference.pageId))
            .unique(),
        ])
        const savedCount =
          page?.content && hasBlockBody(page)
            ? countBlockContentUsage(page.content, type).count
            : 0
        const stagedCount = countBlockContentUsage(
          staging?.content as
            | Record<
                string,
                { readonly blocks?: readonly { readonly type: string }[] }
              >
            | undefined,
          type
        ).count
        if (savedCount === 0 && stagedCount === 0) {
          publicationOnlyPageCount++
          if (await pageIsDeleted(ctx, reference.pageId, page))
            publicationOnlyDeletedPageCount++
        }
        if (
          !details.has(reference.pageId) &&
          details.size < BLOCK_USAGE_DETAIL_LIMIT
        )
          details.set(reference.pageId, {
            count: 0,
            locales: new Set<string>(),
          })
      }
      const detail = details.get(reference.pageId)
      if (detail) {
        detail.count += reference.count
        if ("locale" in reference) detail.locales.add(reference.locale)
      }
    }
    if (batch.isDone) break
    cursor = batch.continueCursor
  }
  return {
    usageCount,
    publicationOnlyPageCount,
    publicationOnlyDeletedPageCount,
    details: [...details].map(([pageId, detail]) => ({
      pageId,
      count: detail.count,
      locales: [...detail.locales].sort(),
    })),
  }
}

export const getBlockUsageSummary = query({
  args: {
    type: v.string(),
    // The delete consumer binds this final read to current retirement authority
    // and publication references as well as the archive/combined-usage state.
    forRetirement: v.optional(v.literal(true)),
    // Deprecated/ignored: usage is now counted across the whole `pages` table
    // (see below). Kept optional so existing callers compile.
    limit: v.optional(v.number()),
  },
  returns: v.object({
    archived: v.boolean(),
    pageCount: v.number(),
    // Trashed (soft-deleted) pages that still hold the type — reported
    // separately so the gate can warn instead of silently reading 0 (F2). They
    // are still included in pageCount/usageCount because they still block a
    // union shrink until stripped.
    deletedPageCount: v.number(),
    usageCount: v.number(),
    savedUsageCount: v.number(),
    stagedUsageCount: v.number(),
    publicationUsageCount: v.number(),
    pages: v.array(
      v.object({
        pageId: v.id("pages"),
        title: v.string(),
        slug: v.string(),
        locales: v.array(v.string()),
        savedLocales: v.array(v.string()),
        stagedLocales: v.array(v.string()),
        publicationLocales: v.array(v.string()),
        count: v.number(),
        savedCount: v.number(),
        stagedCount: v.number(),
        publicationCount: v.number(),
        deleted: v.boolean(),
      })
    ),
    contentLocations: v.optional(
      v.array(
        v.object({
          pageId: v.id("pages"),
          locale: v.string(),
          index: v.number(),
          path: v.string(),
        })
      )
    ),
  }),
  handler: async (ctx, { type, forRetirement }): Promise<BlockUsageSummary> => {
    // Block-usage report is a settings surface — any per-type list grant unlocks
    // it (rows aren't filtered by type; the report needs the full count to gate
    // the block retirement).
    await requireAnyPageTypePermission(ctx, "list")
    if (forRetirement) await assertRetirementAllowed(ctx, type)
    const [saved, staged, settings]: [
      SavedBlockUsageScan,
      StagedBlockUsageScan,
      Doc<"siteSettings"> | null,
    ] = await Promise.all([
      ctx.runQuery(internal.cms.blockLibrary.scanSavedBlockUsage, { type }),
      ctx.runQuery(internal.cms.blockLibrary.scanStagedBlockUsage, { type }),
      ctx.db.query("siteSettings").first(),
    ])
    const archived = (settings?.archivedBlockTypes ?? []).includes(type)

    const legacyDetailPageIds = [
      ...new Set([...saved.detailPageIds, ...staged.detailPageIds]),
    ].slice(0, BLOCK_USAGE_DETAIL_LIMIT)
    const publication = await scanPublicationBlockUsage(
      ctx,
      type,
      legacyDetailPageIds
    )
    const publicationDetails = new Map(
      publication.details.map((detail) => [detail.pageId, detail])
    )
    const selectedPageIds = [
      ...new Set([
        ...legacyDetailPageIds,
        ...publication.details.map(({ pageId }) => pageId),
      ]),
    ].slice(0, BLOCK_USAGE_DETAIL_LIMIT)
    const savedUsageCount = saved.usageCount
    const stagedUsageCount = staged.usageCount
    const publicationUsageCount = publication.usageCount
    const usageCount =
      savedUsageCount + stagedUsageCount + publicationUsageCount
    if (!Number.isSafeInteger(usageCount))
      throw new ConvexError("INVALID_BLOCK_PUBLICATION_USAGE")
    const pageCount =
      saved.pageCount +
      staged.stagingOnlyPageCount +
      publication.publicationOnlyPageCount
    const deletedPageCount =
      saved.deletedPageCount +
      staged.stagingOnlyDeletedPageCount +
      publication.publicationOnlyDeletedPageCount
    const usageRows = await Promise.all(
      selectedPageIds.map(async (pageId) => {
        const [page, staging] = await Promise.all([
          ctx.db.get("pages", pageId),
          ctx.db
            .query("pageStaging")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .unique(),
        ])
        const savedUsage =
          page?.content && hasBlockBody(page)
            ? countBlockContentUsage(page.content, type)
            : { count: 0, locales: [] }
        const stagedUsage = countBlockContentUsage(
          staging?.content as
            | Record<
                string,
                { readonly blocks?: readonly { readonly type: string }[] }
              >
            | undefined,
          type
        )
        const publicationUsage = publicationDetails.get(pageId) ?? {
          count: 0,
          locales: [],
        }
        return {
          row: {
            pageId,
            title: page ? pageTitle(page) : "Unavailable Page",
            slug: page?.slug ?? "",
            locales: [
              ...new Set([
                ...savedUsage.locales,
                ...stagedUsage.locales,
                ...publicationUsage.locales,
              ]),
            ].sort(),
            savedLocales: savedUsage.locales.sort(),
            stagedLocales: stagedUsage.locales.sort(),
            publicationLocales: publicationUsage.locales,
            count:
              savedUsage.count + stagedUsage.count + publicationUsage.count,
            savedCount: savedUsage.count,
            stagedCount: stagedUsage.count,
            publicationCount: publicationUsage.count,
            deleted: await pageIsDeleted(ctx, pageId, page),
          },
          locations: [
            ...(page?.content && hasBlockBody(page)
              ? blockContentLocations(page.content, type, pageId)
              : []),
            ...blockContentLocations(
              staging?.content as
                | Record<
                    string,
                    {
                      readonly blocks?: readonly { readonly type: string }[]
                    }
                  >
                | undefined,
              type,
              pageId
            ),
          ],
        }
      })
    )
    const usagePages = usageRows.map(({ row }) => row)
    const contentLocations = usageRows.flatMap(({ locations }) => locations)

    return {
      archived,
      pageCount,
      deletedPageCount,
      usageCount,
      savedUsageCount,
      stagedUsageCount,
      publicationUsageCount,
      pages: usagePages,
      ...(contentLocations.length > 0 ? { contentLocations } : {}),
    }
  },
})
