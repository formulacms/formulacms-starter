import { ConvexError, v } from "convex/values"
import { nextUpdatedAt } from "../lib/versions"
import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { recordPublicChange } from "../lib/language/freshness"
import {
  readMultilingualSnapshot,
  readMultilingualToggleBlockers,
} from "../lib/language/multilingual"
import { assertNoPagePurgeInProgress } from "../lib/publishing/pagePurge"
import { untranslatedEntryFor } from "../lib/publishing/translationSwitch"
import { pageTypeValidator } from "../lib/pages/types"
import {
  CONTENT_TYPES,
  isActiveContentType,
  type ContentType,
} from "../lib/contentTypes"

export const CONTENT_TYPE_USAGE_CAP = 25
const CONTENT_TYPE_USAGE_READ_LIMIT = CONTENT_TYPE_USAGE_CAP + 1

const contentTypeUsageValidator = v.object({
  type: v.string(),
  count: v.number(),
  capped: v.boolean(),
})

function sortedActiveArchivedTypes(values: readonly string[]): string[] {
  return [...new Set(values)].filter(isActiveContentType).sort()
}

/** Approximate usage deliberately reads one sentinel row beyond the display cap. */
export const getContentTypeUsage = query({
  args: {},
  returns: v.array(contentTypeUsageValidator),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)

    return Promise.all(
      CONTENT_TYPES.map(async (type) => {
        const rows = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) => q.eq("pageType", type))
          .take(CONTENT_TYPE_USAGE_READ_LIMIT)
        return {
          type,
          count: Math.min(rows.length, CONTENT_TYPE_USAGE_CAP),
          capped: rows.length > CONTENT_TYPE_USAGE_CAP,
        }
      })
    )
  },
})

/** Every owner-authorized creation surface needs this operational metadata. */
export const getArchivedContentTypes = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    return sortedActiveArchivedTypes(settings?.archivedContentTypes ?? [])
  },
})

export const setContentTypeArchived = mutation({
  args: { type: v.string(), archived: v.boolean() },
  returns: v.array(v.string()),
  handler: async (ctx, { type, archived }) => {
    await requireOperationAccess(ctx)
    if (!isActiveContentType(type)) {
      throw new ConvexError(`Unknown active Content Type "${type}".`)
    }
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) {
      throw new ConvexError("Site settings are not initialized yet.")
    }

    const next = new Set(
      sortedActiveArchivedTypes(settings.archivedContentTypes ?? [])
    )
    if (archived) next.add(type)
    else next.delete(type)
    const result = [...next].sort()
    await ctx.db.patch("siteSettings", settings._id, {
      archivedContentTypes: result,
      updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
    })
    await recordPublicChange(ctx, { scopes: [] })
    return result
  },
})

const untranslatedEntryValidator = v.object({
  pageType: pageTypeValidator,
  locale: v.string(),
})

/** The owner-facing list of types switched to one language, sorted by type. */
export const getUntranslatedContentTypes = query({
  args: {},
  returns: v.array(untranslatedEntryValidator),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    const settings = await ctx.db.query("siteSettings").first()
    return sortedEntries(settings?.untranslatedContentTypes ?? [])
  },
})

function sortedEntries<T extends { pageType: string }>(entries: readonly T[]) {
  return [...entries].sort((a, b) => a.pageType.localeCompare(b.pageType))
}

/**
 * ADR-0037 amendment (2026-11-17), clauses 3 and 4: switch a content type to
 * one language or back. Off stores the language that is the default now and
 * hides the type's versions in every other language from public readers;
 * nothing is deleted, and on again restores them without a republish.
 */
export const setContentTypeTranslation = mutation({
  args: { pageType: pageTypeValidator, translated: v.boolean() },
  returns: v.array(untranslatedEntryValidator),
  handler: async (ctx, { pageType, translated }) => {
    await requireOperationAccess(ctx)
    if (!isActiveContentType(pageType)) {
      throw new ConvexError(`Unknown active Content Type "${pageType}".`)
    }
    const settings = await ctx.db.query("siteSettings").first()
    if (!settings) {
      throw new ConvexError("Site settings are not initialized yet.")
    }
    const current = settings.untranslatedContentTypes ?? []
    const existing = untranslatedEntryFor(settings, pageType)

    // Turning on without an entry changes nothing and needs no guard.
    if (translated && !existing) return sortedEntries(current)
    // Either direction changes which versions are public, so both apply the
    // refusals the Multilingual module toggle applies: the module is on, no
    // permanent delete runs and no language operation is open.
    if (!(await readMultilingualSnapshot(ctx)).moduleEnabled) {
      throw new ConvexError("MULTILINGUAL_MODULE_NOT_ENABLED")
    }
    await assertNoPagePurgeInProgress(ctx)
    const blockers = await readMultilingualToggleBlockers(ctx, true)
    if (blockers.length > 0) throw new ConvexError(blockers[0]!.code)
    // Idempotent: a live entry keeps the language it pinned.
    if (
      !translated &&
      existing &&
      settings.enabledLocales?.includes(existing.locale)
    ) {
      return sortedEntries(current)
    }

    const others = current.filter((entry) => entry.pageType !== pageType)
    const next = translated
      ? others
      : [...others, { pageType, locale: settings.defaultLocale }]
    await ctx.db.patch("siteSettings", settings._id, {
      untranslatedContentTypes: next,
      updatedAt: nextUpdatedAt(settings.updatedAt, Date.now()),
    })
    // The set of public pages changes in the other languages.
    await recordPublicChange(ctx, {
      scopes: [{ domains: ["publication_set"] }],
    })
    // Kept-language pages refresh their language alternates, menus and
    // sitemaps; the purge covers the whole public site.
    await ctx.scheduler.runAfter(
      0,
      internal.cms.revalidate.revalidateSettings,
      {}
    )
    return sortedEntries(next)
  },
})

const boundedCountValidator = v.object({
  count: v.number(),
  capped: v.boolean(),
})

/** One bounded counter: distinct keys up to the cap, "N+" beyond it. */
function createBoundedCount() {
  const keys = new Set<string>()
  let exhausted = false
  return {
    add(key: string) {
      keys.add(key)
    },
    /** True once more than the cap is known: stop reading. */
    get full() {
      return keys.size > CONTENT_TYPE_USAGE_CAP
    },
    /** A read budget ran out before the whole set was seen. */
    markExhausted() {
      exhausted = true
    },
    result() {
      return {
        count: Math.min(keys.size, CONTENT_TYPE_USAGE_CAP),
        capped: keys.size > CONTENT_TYPE_USAGE_CAP || exhausted,
      }
    },
  }
}

/** Rows read per source set; a larger set reports "N+" instead of scanning on. */
const IMPACT_SCAN_LIMIT = 100

async function isActivePage(
  ctx: QueryCtx,
  pageId: Id<"pages">
): Promise<boolean> {
  const rows = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  return rows.length === 1 && rows[0]!.lifecycleState === "active"
}

/**
 * What switching a content type to one language hides today, for the owner's
 * confirmation: (a) published versions in other languages, (b) published pages
 * of other types in other languages that link to or credit a page of this
 * type, (c) published pages of other types in other languages below a page of
 * this type (children and deeper descendants).
 * Each count is bounded like the Usage count and carries `capped` for "N+".
 */
export const getContentTypeTranslationImpact = query({
  args: { pageType: pageTypeValidator },
  returns: v.object({
    keptLocale: v.string(),
    hiddenVersions: boundedCountValidator,
    linkingPages: boundedCountValidator,
    childPages: boundedCountValidator,
  }),
  handler: async (ctx, { pageType }) => {
    await requireOperationAccess(ctx)
    const settings: Doc<"siteSettings"> | null = await ctx.db
      .query("siteSettings")
      .first()
    const enabled = settings?.enabledLocales ?? []
    const existing = untranslatedEntryFor(settings, pageType)
    const keptLocale =
      existing && enabled.includes(existing.locale)
        ? existing.locale
        : (settings?.defaultLocale ?? "")
    const otherLocales = enabled.filter((locale) => locale !== keptLocale)
    const hidden = createBoundedCount()
    const linking = createBoundedCount()
    const children = createBoundedCount()
    const result = () => ({
      keptLocale,
      hiddenVersions: hidden.result(),
      linkingPages: linking.result(),
      childPages: children.result(),
    })
    if (!settings || otherLocales.length === 0) return result()
    const homeId = settings.homePageId

    // (a) Published versions in the other languages.
    for (const locale of otherLocales) {
      if (hidden.full) break
      const rows = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_hasCurrentSnapshot_and_locale_and_pageType_and_publicSince", (q) =>
          q
            .eq("hasCurrentSnapshot", true)
            .eq("locale", locale)
            .eq("pageType", pageType)
        )
        .take(IMPACT_SCAN_LIMIT + 1)
      if (rows.length > IMPACT_SCAN_LIMIT) hidden.markExhausted()
      for (const row of rows.slice(0, IMPACT_SCAN_LIMIT)) {
        if (hidden.full) break
        if (row.pageId === homeId) continue
        if (await isActivePage(ctx, row.pageId)) {
          hidden.add(`${row.pageId}|${locale}`)
        }
      }
    }

    // (b) and (c) walk the pages of this type, bounded.
    const typed = await ctx.db
      .query("pages")
      .withIndex("by_pageType_status", (q) => q.eq("pageType", pageType))
      .take(IMPACT_SCAN_LIMIT + 1)
    if (typed.length > IMPACT_SCAN_LIMIT) {
      linking.markExhausted()
      children.markExhausted()
    }
    for (const target of typed.slice(0, IMPACT_SCAN_LIMIT)) {
      if (linking.full && children.full) break
      if (target.deletedAt !== undefined) continue
      // The current public references into this page, per other language:
      // a link or credit (relation, byline, block body) or an ancestry row
      // (the source is a descendant).
      for (const locale of otherLocales) {
        const references = await ctx.db
          .query("pagePublicationDocumentReferences")
          .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
            q
              .eq("targetId", target._id)
              .eq("sourceKind", "current_public")
              .eq("locale", locale)
          )
          .take(IMPACT_SCAN_LIMIT + 1)
        if (references.length > IMPACT_SCAN_LIMIT) {
          linking.markExhausted()
          children.markExhausted()
        }
        for (const reference of references.slice(0, IMPACT_SCAN_LIMIT)) {
          const bucket =
            reference.referenceKind === "ancestry" ? children : linking
          if (bucket.full || reference.pageId === target._id) continue
          const source = await ctx.db.get("pages", reference.pageId)
          if (!source || source.deletedAt !== undefined) continue
          // Pages of this type are hidden anyway; only other types count.
          if (source.pageType === pageType || source._id === homeId) continue
          if (await isActivePage(ctx, source._id)) bucket.add(source._id)
        }
      }
    }
    return result()
  },
})

/**
 * Shared backend guard for ordinary editor-facing creation paths. System seed,
 * migration, and fixture code writes directly through their explicit internal
 * paths and never calls this helper.
 */
export async function assertContentTypeAcceptsCreation(
  ctx: MutationCtx,
  type: ContentType
): Promise<void> {
  assertContentTypeIsActive(type, "create")
  const settings = await ctx.db.query("siteSettings").first()
  if (settings?.archivedContentTypes?.includes(type)) {
    throw new ConvexError(
      `Content Type "${type}" is archived and cannot be used for new documents. Restore it before creating or duplicating documents.`
    )
  }
}

/**
 * Selection is a lifecycle boundary, not merely an admin-menu filter. Keep
 * stored inactive arms available for explicit migrations, but reject them at
 * every ordinary create/publish entry point.
 */
export function assertContentTypeIsActive(
  type: ContentType,
  operation: "create" | "publish" | "edit" | "delete"
): void {
  if (isActiveContentType(type)) return
  throw new ConvexError(
    `Content Type "${type}" is not active in this starter and cannot be used to ${operation} documents.`
  )
}
