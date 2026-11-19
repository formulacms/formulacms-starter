import { Migrations } from "@convex-dev/migrations"
import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { components, internal } from "../../_generated/api"
import type { DataModel, Doc, Id } from "../../_generated/dataModel"
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../../_generated/server"
import schema from "../../schema"
import { contentTypeDefs } from "../contentTypes"
import { planDraftBackfill } from "../contentTypes/perLanguageFields"
import { occurrenceUsageWrites } from "./staging"

/**
 * One-time backfill of the per-language search, social and card values
 * (ADR-0037 amendment, 2026-11-17, clause 6).
 *
 * Before the change these values were shared by every language. Now each
 * language owns them. For each page the backfill copies the old shared values
 * into the page's existing Working Drafts:
 * - text values (social title and description, keywords, focus keyword,
 *   structured data, card excerpt, post category, and the legacy meta text where
 *   the draft's own meta is empty) only into the legacy shared language, and
 *   only where the draft's own value is empty;
 * - noindex and nofollow into every existing Working Draft where unset.
 * A language without a Working Draft receives nothing (its frozen snapshot
 * resolves the old values at read time, see `normalizeSnapshotPayload`); the
 * count is kept in the page's marker.
 *
 * It writes Working Drafts only, in place and without a generation bump, so a
 * page never starts to show "Unpublished changes" and no editor loses a draft
 * to a stale-generation error. Published Snapshots, Shared Drafts and Shared
 * Draft generations are never touched.
 *
 * Each page is marked done once (`pagePublicationPageStates.perLanguageFieldsBackfill`).
 * A page with the marker is never filled again, so a value the owner cleared
 * stays cleared. New pages are born with the marker.
 *
 * Starting: the hourly cron `startPerLanguageFieldsBackfillIfNeeded` runs the
 * migration to the end. Saving, restoring or publishing a page runs that one
 * page's backfill first (`ensurePageBackfilled`), so a page is never published
 * without its old values. A deployment administrator can also run:
 *   npx convex run lib/publishing/perLanguageBackfill:startPerLanguageFieldsBackfillIfNeeded
 * and count the pending work, without writing, with:
 *   npx convex run lib/publishing/perLanguageBackfill:countPerLanguageFieldsBackfill \
 *     '{"paginationOpts":{"numItems":50,"cursor":null}}'
 */
const backfillMigrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { internalMutation, schema }
)

type BackfillCtx = QueryCtx | MutationCtx

const LOCALE_LIMIT = 512

export type PageBackfillPlan = {
  /** Working Draft patches, `content` being the full replacement. */
  writes: Array<{
    draftId: Id<"pageLocaleDrafts">
    content: Record<string, unknown>
  }>
  /** Languages with old text to copy and no Working Draft to copy it into. */
  skippedNoDraft: number
}

/**
 * The language the old shared text belongs to: the recorded one, else the
 * default language. Null when the site has no settings row.
 */
export async function legacySharedFieldsLocaleOf(
  ctx: BackfillCtx
): Promise<string | null> {
  const rows = await ctx.db.query("siteSettings").take(2)
  if (rows.length !== 1) return null
  return rows[0]!.legacySharedFieldsLocale ?? rows[0]!.defaultLocale
}

/**
 * Record `legacySharedFieldsLocale` once, from the current default language.
 * It is never overwritten, so a later default-language change never moves old
 * text to another language. Returns the recorded language (null without
 * settings).
 */
export async function recordLegacySharedFieldsLocale(
  ctx: MutationCtx
): Promise<string | null> {
  const rows = await ctx.db.query("siteSettings").take(2)
  if (rows.length !== 1) return null
  const settings = rows[0]!
  if (settings.legacySharedFieldsLocale !== undefined)
    return settings.legacySharedFieldsLocale
  await ctx.db.patch("siteSettings", settings._id, {
    legacySharedFieldsLocale: settings.defaultLocale,
  })
  return settings.defaultLocale
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasText(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ""
}

/** What the backfill of one page would write. Reads only. */
export async function planPageBackfill(
  ctx: BackfillCtx,
  pageId: Id<"pages">,
  legacyLocale: string
): Promise<PageBackfillPlan | null> {
  const [page, sharedRows, drafts, localeStates] = await Promise.all([
    ctx.db.get("pages", pageId),
    ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .take(2),
    ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_updatedAt", (q) => q.eq("pageId", pageId))
      .take(LOCALE_LIMIT + 1),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .take(LOCALE_LIMIT + 1),
  ])
  if (!page || sharedRows.length !== 1) return null
  if (drafts.length > LOCALE_LIMIT || localeStates.length > LOCALE_LIMIT)
    throw new Error("PAGE_LOCALE_LIMIT")
  const shared = sharedRows[0]!
  const descriptor = contentTypeDefs[page.pageType]
  const system = (shared.system ?? {}) as Record<string, unknown>
  const sharedSeo = isRecord(system.seo) ? system.seo : undefined
  const sharedDescriptor = shared.descriptor as unknown as Record<
    string,
    unknown
  >
  const sharedCardExcerpt = system.cardExcerpt
  const sharedCategory = sharedDescriptor.category
  const hasCategoryField = "category" in descriptor.localizedFields
  const liveDrafts = new Map<string, Doc<"pageLocaleDrafts">>()
  for (const state of localeStates) {
    const draft = drafts.find((row) => row.locale === state.locale)
    if (draft && draft.generation === state.draftGeneration)
      liveDrafts.set(state.locale, draft)
  }
  const writes: PageBackfillPlan["writes"] = []
  for (const [locale, draft] of liveDrafts) {
    const content = planDraftBackfill({
      locale,
      legacyLocale,
      content: draft.content as unknown as Record<string, unknown>,
      sharedSeo,
      sharedCardExcerpt,
      sharedCategory,
      hasCategoryField,
    })
    if (content) writes.push({ draftId: draft._id, content })
  }
  const hasLegacyText =
    (sharedSeo !== undefined &&
      [
        "ogTitle",
        "ogDescription",
        "structuredData",
        "keywords",
        "focusKeyword",
        "metaTitle",
        "metaDescription",
      ].some((key) => hasText(sharedSeo[key]))) ||
    hasText(sharedCardExcerpt) ||
    (hasCategoryField && hasText(sharedCategory))
  const skippedNoDraft = hasLegacyText && !liveDrafts.has(legacyLocale) ? 1 : 0
  return { writes, skippedNoDraft }
}

/**
 * Backfill one page, once. A page with the marker is left alone. Returns
 * whether this call did the backfill.
 */
export async function ensurePageBackfilled(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  /** The page state the caller already read: saves one read when marked. */
  known?: Doc<"pagePublicationPageStates">
): Promise<"backfilled" | "already_done" | "no_state"> {
  if (known?.perLanguageFieldsBackfill) return "already_done"
  const states = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (states.length !== 1) return "no_state"
  const state = states[0]!
  if (state.perLanguageFieldsBackfill) return "already_done"
  const legacyLocale = await recordLegacySharedFieldsLocale(ctx)
  const plan =
    legacyLocale === null
      ? null
      : await planPageBackfill(ctx, pageId, legacyLocale)
  const now = Date.now()
  for (const write of plan?.writes ?? []) {
    // In place: no generation, updatedAt or attribution change (status neutral).
    await occurrenceUsageWrites(ctx).patch("pageLocaleDrafts", write.draftId, {
      content: write.content,
    } as never)
  }
  await occurrenceUsageWrites(ctx).patch(
    "pagePublicationPageStates",
    state._id,
    {
      perLanguageFieldsBackfill: {
        at: now,
        draftsWritten: plan?.writes.length ?? 0,
        skippedNoDraft: plan?.skippedNoDraft ?? 0,
      },
    }
  )
  return "backfilled"
}

export const backfillPerLanguageFields = backfillMigrations.define({
  table: "pagePublicationPageStates",
  batchSize: 5,
  migrateOne: async (ctx, state) => {
    await ensurePageBackfilled(ctx, state.pageId)
  },
})

function series() {
  return [internal.lib.publishing.perLanguageBackfill.backfillPerLanguageFields]
}

/** True once the migration reports success to the end. */
export async function perLanguageBackfillIsDone(
  ctx: BackfillCtx
): Promise<boolean> {
  const refs = series()
  const statuses = await backfillMigrations.getStatus(ctx, {
    migrations: refs,
    limit: refs.length,
  })
  return (
    statuses.length === refs.length &&
    statuses.every((s) => s.state === "success" && s.isDone)
  )
}

/**
 * Hourly cron entry (convex/crons.ts). Records the legacy shared language,
 * then starts (or resumes) the migration. One small status read once done.
 */
export const startPerLanguageFieldsBackfillIfNeeded = internalMutation({
  args: {},
  returns: v.union(v.literal("started"), v.literal("done")),
  handler: async (ctx) => {
    await recordLegacySharedFieldsLocale(ctx)
    if (await perLanguageBackfillIsDone(ctx)) return "done"
    await backfillMigrations.runSerially(ctx, series())
    return "started"
  },
})

/**
 * Dry run: what the backfill would do on one page of the page states, with no
 * writes. Sum the pages by following `continueCursor` until `isDone`.
 */
export const countPerLanguageFieldsBackfill = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    pages: v.number(),
    alreadyDone: v.number(),
    pending: v.number(),
    draftsToWrite: v.number(),
    pagesWithOldTextAndNoDraft: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const legacyLocale = await legacySharedFieldsLocaleOf(ctx)
    const result = await ctx.db
      .query("pagePublicationPageStates")
      .paginate(args.paginationOpts)
    let alreadyDone = 0
    let pending = 0
    let draftsToWrite = 0
    let pagesWithOldTextAndNoDraft = 0
    for (const state of result.page) {
      if (state.perLanguageFieldsBackfill) {
        alreadyDone += 1
        continue
      }
      pending += 1
      if (legacyLocale === null) continue
      const plan = await planPageBackfill(ctx, state.pageId, legacyLocale)
      if (!plan) continue
      draftsToWrite += plan.writes.length
      pagesWithOldTextAndNoDraft += plan.skippedNoDraft
    }
    return {
      pages: result.page.length,
      alreadyDone,
      pending,
      draftsToWrite,
      pagesWithOldTextAndNoDraft,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    }
  },
})
