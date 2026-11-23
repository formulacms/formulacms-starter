import { ConvexError, v } from "convex/values"
import { nextUpdatedAt } from "../lib/versions"
import { customCtx, customQuery } from "convex-helpers/server/customFunctions"
import { mutation, query, type QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { requireOperationAccess } from "../lib/access/policy"
import { recordPublicChange } from "../lib/language/freshness"
import { REGISTERED_BLOCK_TYPES } from "../lib/blocks"
import { blockAuthoringContractState } from "../lib/blocks/authoringState"
import { requireBlockTypeRetirementPermission } from "../lib/blocks/permissions"
import { readPagePurgeMarker } from "../lib/publishing/pagePurge"
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

// ─── Live block usage (LEGACY-REMOVE L5) ────────────────────────────────────
//
// One function decides what holds a Block Type "now". The count, the usage rows,
// the Delete check and the Update check all read it. "Now" means a row that
// Convex validates against the installed blocks, or that the public site or an
// editor can still bring back:
//   - language drafts (`locale_draft` rows);
//   - the current published version (`current_public` rows);
//   - the draft base of a language with no current version (a withdrawn
//     language: its base is the working copy);
//   - unexpired AI job copies (typed `aiJobs` / `aiJobUnits` fields).
// Superseded publishes are stored as JSON text and never block a schema push, so
// they do not count for Delete (ADR-0045 amendment, 2026-11-22). Pages in Trash
// and pages queued for permanent delete still count until the purge removes them.
//
// Supported input (ADR-0045 amendment): 300 pages, 2 languages, a few AI jobs a
// week. Every read below is capped. A read that would pass its cap marks the
// scan incomplete; the Delete check then refuses instead of reporting 0.

/** Cap for each reference or language-state read: 300 pages x 2 languages = 600. */
export const BLOCK_USAGE_SCAN_CAP = 1000
const AI_JOB_SCAN_CAP = 200
const AI_UNIT_SCAN_CAP = 200
const CANDIDATE_REFERENCE_CAP = 256
// Cap on how many page rows we return for display; the totals below always
// reflect the FULL scan, so the gate never undercounts.
const BLOCK_USAGE_DETAIL_LIMIT = 100
const AI_COPY_STATES = [
  "running",
  "canceling",
  "done",
  "failed",
  "canceled",
  "capped",
] as const

export const blockUseStatusValidator = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("published_version"),
  v.literal("withdrawn"),
  v.literal("archived"),
  v.literal("in_trash"),
  v.literal("being_erased"),
  v.literal("language_off"),
  v.literal("ai_job_running"),
  v.literal("ai_suggestion")
)
type BlockUseStatus = typeof blockUseStatusValidator.type

type LiveUseKind =
  "draft" | "published" | "withdrawn" | "ai_running" | "ai_copy"
type LiveUse = {
  pageId: Id<"pages">
  locale: string
  kind: LiveUseKind
  count: number
}
type LiveScan = { uses: LiveUse[]; complete: boolean }

function safeCount(count: number): number {
  if (!Number.isSafeInteger(count) || count <= 0)
    throw new ConvexError("INVALID_BLOCK_PUBLICATION_USAGE")
  return count
}

function blocksOfType(value: unknown, type: string): number {
  const blocks = (value as { blocks?: unknown } | undefined)?.blocks
  if (!Array.isArray(blocks)) return 0
  return blocks.filter(
    (block) => (block as { type?: unknown } | null)?.type === type
  ).length
}

async function scanAiCopies(
  ctx: QueryCtx,
  type: string,
  push: (use: LiveUse) => boolean
): Promise<boolean> {
  let complete = true
  for (const state of AI_COPY_STATES) {
    const jobs = await ctx.db
      .query("aiJobs")
      .withIndex("by_state", (q) => q.eq("state", state))
      .take(AI_JOB_SCAN_CAP + 1)
    if (jobs.length > AI_JOB_SCAN_CAP) complete = false
    for (const job of jobs.slice(0, AI_JOB_SCAN_CAP)) {
      let count =
        blocksOfType(job.sourcePage, type) +
        blocksOfType(job.suggestion, type) +
        blocksOfType(job.sourcePage?.draft, type) +
        blocksOfType(job.suggestion?.draft, type)
      if (count === 0) {
        const units = await ctx.db
          .query("aiJobUnits")
          .withIndex("by_jobId_and_index", (q) => q.eq("jobId", job._id))
          .take(AI_UNIT_SCAN_CAP + 1)
        if (units.length > AI_UNIT_SCAN_CAP) complete = false
        count = units
          .slice(0, AI_UNIT_SCAN_CAP)
          .filter(
            (unit) =>
              typeof unit.output === "object" && unit.output.type === type
          ).length
      }
      if (count === 0) continue
      const stop = push({
        pageId: job.pageId,
        locale: job.locale,
        kind:
          state === "running" || state === "canceling"
            ? "ai_running"
            : "ai_copy",
        count,
      })
      if (stop) return complete
    }
  }
  return complete
}

/**
 * The one scan. With `stopAtFirst` it returns as soon as one live use is found
 * (the Delete check); otherwise it returns every use (the summary). Counting
 * never depends on a status lookup: a row whose page or language cannot be
 * read still counts. It does not filter on enabled languages, so a hidden
 * language's version stays counted.
 */
async function scanLiveBlockUsage(
  ctx: QueryCtx,
  type: string,
  { stopAtFirst }: { stopAtFirst: boolean }
): Promise<LiveScan> {
  const uses = new Map<string, LiveUse>()
  let complete = true
  const add = (key: string, use: LiveUse): boolean => {
    if (!uses.has(key)) uses.set(key, use)
    return stopAtFirst
  }
  const take = (n: number) => (stopAtFirst ? 1 : n + 1)

  // 1. Language drafts.
  const drafts = await ctx.db
    .query("pagePublicationBlockReferences")
    .withIndex("by_blockType_and_sourceKind", (q) =>
      q.eq("blockType", type).eq("sourceKind", "locale_draft")
    )
    .take(take(BLOCK_USAGE_SCAN_CAP))
  if (!stopAtFirst && drafts.length > BLOCK_USAGE_SCAN_CAP) complete = false
  for (const row of drafts.slice(0, BLOCK_USAGE_SCAN_CAP)) {
    if (
      row.sourceKind === "locale_draft" &&
      add(`${row.pageId}|${row.locale}`, {
        pageId: row.pageId,
        locale: row.locale,
        kind: "draft",
        count: safeCount(row.count),
      })
    )
      return { uses: [...uses.values()], complete }
  }

  // 2. The current published version.
  const published = await ctx.db
    .query("pagePublicationBlockReferences")
    .withIndex("by_blockType_and_sourceKind", (q) =>
      q.eq("blockType", type).eq("sourceKind", "current_public")
    )
    .take(take(BLOCK_USAGE_SCAN_CAP))
  if (!stopAtFirst && published.length > BLOCK_USAGE_SCAN_CAP) complete = false
  for (const row of published.slice(0, BLOCK_USAGE_SCAN_CAP)) {
    if (row.sourceKind !== "current_public") continue
    const key = `${row.pageId}|${row.locale}`
    if (uses.has(key)) {
      safeCount(row.count)
      continue
    }
    if (
      add(key, {
        pageId: row.pageId,
        locale: row.locale,
        kind: "published",
        count: safeCount(row.count),
      })
    )
      return { uses: [...uses.values()], complete }
  }

  // 3. The draft base of each language that has no current version.
  const states = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
      q.eq("hasCurrentSnapshot", false)
    )
    .take(BLOCK_USAGE_SCAN_CAP + 1)
  if (states.length > BLOCK_USAGE_SCAN_CAP) complete = false
  for (const state of states.slice(0, BLOCK_USAGE_SCAN_CAP)) {
    if (!state.draftBaseSnapshotId) continue
    const key = `${state.pageId}|${state.locale}`
    if (uses.has(key)) continue
    const snapshot = await ctx.db.get(
      "pagePublishedSnapshots",
      state.draftBaseSnapshotId
    )
    if (!snapshot) {
      // A draft base that points at a missing snapshot cannot be read, so it
      // could hide a use: fail closed.
      complete = false
      continue
    }
    const references = await ctx.db
      .query("pagePublicationBlockReferences")
      .withIndex("by_sourceKind_and_sourceId", (q) =>
        q.eq("sourceKind", "candidate").eq("sourceId", snapshot.candidateId)
      )
      .take(CANDIDATE_REFERENCE_CAP + 1)
    if (references.length > CANDIDATE_REFERENCE_CAP) complete = false
    let count = 0
    for (const reference of references.slice(0, CANDIDATE_REFERENCE_CAP))
      if (reference.blockType === type) count += safeCount(reference.count)
    if (
      count > 0 &&
      add(key, {
        pageId: state.pageId,
        locale: state.locale,
        kind: "withdrawn",
        count,
      })
    )
      return { uses: [...uses.values()], complete }
  }

  // 4. Unexpired AI job copies.
  const aiComplete = await scanAiCopies(ctx, type, (use) =>
    add(`ai|${uses.size}|${use.pageId}`, use)
  )
  if (!aiComplete) complete = false
  return { uses: [...uses.values()], complete }
}

async function assertRetirementAllowed(ctx: QueryCtx, type: string) {
  await requireBlockTypeRetirementPermission(ctx, type)
  const scan = await scanLiveBlockUsage(ctx, type, { stopAtFirst: true })
  if (scan.uses.length > 0) {
    throw new ConvexError("BLOCK_TYPE_REFERENCED_BY_PUBLICATION")
  }
  if (!scan.complete) throw new ConvexError("BLOCK_USAGE_CHECK_INCOMPLETE")
}

export const assertBlockTypeRetirementAllowed = query({
  args: { type: v.string() },
  returns: v.null(),
  handler: async (ctx, { type }) => {
    await assertRetirementAllowed(ctx, type)
    return null
  },
})

type BlockUsageSummary = {
  archived: boolean
  complete: boolean
  hasHistory: boolean
  pageCount: number
  deletedPageCount: number
  usageCount: number
  pages: Array<{
    pageId: Id<"pages">
    title: string
    slug: string
    locales: string[]
    count: number
    deleted: boolean
    uses: Array<{ locale: string; status: BlockUseStatus; count: number }>
  }>
}

type PageContext = {
  page: Doc<"pages"> | null
  lifecycle: "active" | "archived" | "trashed" | null
  marker: Doc<"pagePurges"> | null
}

async function readPageContext(
  ctx: QueryCtx,
  pageId: Id<"pages">
): Promise<PageContext> {
  const [page, state, marker] = await Promise.all([
    ctx.db.get("pages", pageId),
    ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .first(),
    readPagePurgeMarker(ctx, pageId),
  ])
  return { page, lifecycle: state?.lifecycleState ?? null, marker }
}

async function hasDraftRow(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<boolean> {
  return (
    (await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .first()) !== null
  )
}

async function statusOf(
  ctx: QueryCtx,
  use: LiveUse,
  context: PageContext,
  enabledLocales: ReadonlySet<string>
): Promise<BlockUseStatus> {
  if (use.kind === "ai_running") return "ai_job_running"
  if (use.kind === "ai_copy") return "ai_suggestion"
  if (context.marker) return "being_erased"
  if (!context.page || context.lifecycle === "trashed") return "in_trash"
  if (context.lifecycle === "archived") return "archived"
  if (!enabledLocales.has(use.locale)) return "language_off"
  if (use.kind === "withdrawn") return "withdrawn"
  if (use.kind === "draft") return "draft"
  // The current published version holds the block. With no language draft row
  // the working copy is that version, so the page shows as "Published"; with a
  // draft row that no longer holds the block, only a publish removes it.
  return (await hasDraftRow(ctx, use.pageId, use.locale))
    ? "published_version"
    : "published"
}

function titleFromContent(content: unknown): string {
  const title = (content as { title?: unknown } | null)?.title
  return typeof title === "string" ? title.trim() : ""
}

/** Real page title and address, read for one language at a time and only for the
 * displayed pages: the language draft, else the draft base or current version. */
async function pageTitleAndSlug(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  context: PageContext,
  locales: string[]
): Promise<{ title: string; slug: string }> {
  if (!context.page && !context.marker)
    return { title: "Unavailable Page", slug: "" }
  if (context.marker) {
    const titles = context.marker.localizedTitles
    const title =
      locales.map((locale) => titles[locale]).find(Boolean) ??
      Object.values(titles).find(Boolean) ??
      context.marker.slug
    return { title: title || "Untitled", slug: context.marker.slug }
  }
  const fallbackSlug = context.page?.slug ?? ""
  for (const locale of locales) {
    const draft = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .first()
    if (draft) {
      const title = titleFromContent(draft.content)
      if (title) return { title, slug: draft.slug }
      continue
    }
    const state = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .first()
    const snapshotId = state?.currentSnapshotId ?? state?.draftBaseSnapshotId
    const snapshot = snapshotId
      ? await ctx.db.get("pagePublishedSnapshots", snapshotId)
      : null
    const candidate = snapshot
      ? await ctx.db.get(
          "pageLocalePublicationCandidates",
          snapshot.candidateId
        )
      : null
    if (!candidate) continue
    try {
      const localized = (
        JSON.parse(candidate.payloadJson) as {
          localized?: { slug?: unknown; content?: unknown }
        }
      ).localized
      const title = titleFromContent(localized?.content)
      if (title)
        return {
          title,
          slug:
            typeof localized?.slug === "string" ? localized.slug : fallbackSlug,
        }
    } catch {
      // An unreadable payload only loses the title; the use still counts.
    }
  }
  return { title: fallbackSlug || "Untitled", slug: fallbackSlug }
}

export const getBlockUsageSummary = query({
  args: {
    type: v.string(),
    // The delete consumer binds this final read to the current retirement
    // authority: the guard runs first and refuses on any live use.
    forRetirement: v.optional(v.literal(true)),
    // Deprecated/ignored: the scan always covers every live use.
    // Kept optional so existing callers compile.
    limit: v.optional(v.number()),
  },
  returns: v.object({
    archived: v.boolean(),
    // False when a read passed its cap: the counts below are then a lower
    // bound and `usageCount` is never 0.
    complete: v.boolean(),
    // Retained publish history still holds this type. It does not block
    // Delete; a breaking Update still reads it (decision U).
    hasHistory: v.boolean(),
    pageCount: v.number(),
    // Pages in Trash, including pages queued for permanent delete.
    deletedPageCount: v.number(),
    usageCount: v.number(),
    pages: v.array(
      v.object({
        pageId: v.id("pages"),
        title: v.string(),
        slug: v.string(),
        locales: v.array(v.string()),
        count: v.number(),
        deleted: v.boolean(),
        uses: v.array(
          v.object({
            locale: v.string(),
            status: blockUseStatusValidator,
            count: v.number(),
          })
        ),
      })
    ),
  }),
  handler: async (ctx, { type, forRetirement }): Promise<BlockUsageSummary> => {
    // Block-usage report is an owner-only settings surface.
    await requireOperationAccess(ctx)
    if (forRetirement) await assertRetirementAllowed(ctx, type)
    const [scan, settings, history] = await Promise.all([
      scanLiveBlockUsage(ctx, type, { stopAtFirst: false }),
      ctx.db.query("siteSettings").first(),
      ctx.db
        .query("pagePublicationBlockReferences")
        .withIndex("by_blockType_and_sourceKind", (q) =>
          q.eq("blockType", type).eq("sourceKind", "candidate")
        )
        .first(),
    ])
    const enabledLocales = new Set(
      settings?.enabledLocales ??
        (settings?.defaultLocale ? [settings.defaultLocale] : [])
    )
    const byPage = new Map<Id<"pages">, LiveUse[]>()
    for (const use of scan.uses) {
      byPage.set(use.pageId, [...(byPage.get(use.pageId) ?? []), use])
    }
    let usageCount = 0
    for (const use of scan.uses) usageCount += use.count
    if (!Number.isSafeInteger(usageCount))
      throw new ConvexError("INVALID_BLOCK_PUBLICATION_USAGE")
    let deletedPageCount = 0
    const pages: BlockUsageSummary["pages"] = []
    for (const [pageId, pageUses] of byPage) {
      const context = await readPageContext(ctx, pageId)
      // Page-level state only: AI copies are never "in Trash" even when their
      // page is. The Trash tile counts every page, the rows only the first 100.
      const deleted =
        (context.marker !== null ||
          !context.page ||
          context.lifecycle === "trashed") &&
        pageUses.some(({ kind }) => kind !== "ai_running" && kind !== "ai_copy")
      if (deleted) deletedPageCount++
      if (pages.length >= BLOCK_USAGE_DETAIL_LIMIT) continue
      const rows = await Promise.all(
        pageUses.map(async (use) => ({
          locale: use.locale,
          status: await statusOf(ctx, use, context, enabledLocales),
          count: use.count,
        }))
      )
      const locales = [...new Set(rows.map(({ locale }) => locale))].sort()
      pages.push({
        pageId,
        ...(await pageTitleAndSlug(ctx, pageId, context, locales)),
        locales,
        count: rows.reduce((sum, row) => sum + row.count, 0),
        deleted,
        uses: rows,
      })
    }
    return {
      archived: (settings?.archivedBlockTypes ?? []).includes(type),
      complete: scan.complete,
      hasHistory: history !== null,
      pageCount: byPage.size,
      deletedPageCount,
      // An unfinished scan never reports 0.
      usageCount: scan.complete ? usageCount : Math.max(usageCount, 1),
      pages,
    }
  },
})
