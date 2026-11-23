import {
  occurrenceUsageWrites,
  occurrenceUsageInternalMutation as internalMutation,
  occurrenceUsageMutation as mutation,
} from "../lib/publishing/staging"
import {
  writePageContent,
  writeLocaleContent,
  writeFieldMap,
  writeBlockFields,
  removedTitleLinksValidator,
  type WriteOptions,
} from "../lib/richtext/write"
import { ConvexError, v } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import type { WithoutSystemFields } from "convex/server"
import { internalQuery, query } from "../_generated/server"
import type { DataModel, Doc, Id } from "../_generated/dataModel"
import { components, internal } from "../_generated/api"
import { Migrations } from "@convex-dev/migrations"
import schema from "../schema"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { OwnerPrincipal } from "../lib/access/owner"
import { requireOperationAccess } from "../lib/access/policy"
import { contentTypeDefs, isActiveContentType } from "../lib/contentTypes"
import type { DescriptorFieldMap } from "../lib/contentTypes/types"
import { contentDraftInputValidator } from "../lib/domains/contentModel"
import {
  validateFieldMapRichText,
  validateBlocksRichText,
  validateUniqueBlockIds,
} from "../lib/blocks/validate"
import type { Block } from "../lib/blocks"
import { findUnavailableBlockLocations } from "../lib/blocks/profile"
import {
  buildLocaleRelativePath,
  isRoutableContentType,
  futurePageAddress,
} from "../lib/contentTypes/routing"
import {
  INSTALLED_PUBLICATION_POLICY,
  runPublicationPolicy,
} from "../lib/publishing/publicationPolicy"
import {
  INSTALLED_PUBLICATION_CONTRIBUTIONS,
  runPublicationContributions,
} from "../lib/publishing/publicationContributions"
import {
  currentSnapshotIndexFields,
  readFrozenSnapshotProjection,
  readHiddenTargetSnapshotProjection,
  readPublicationAuthority,
  readCurrentSnapshotProjection,
  requireSnapshotAuthority,
  type SnapshotPayload,
  checkPageAddress,
  allocatePageAddress,
  refusePageAddress,
  addressDraftRows,
  addressSharedParent,
  addressHomePage,
  readHeldHistoricalRows,
  isPageHiddenInLocaleOrAncestry,
  pageAddressCheckValidator,
  pageAddressNoticeValidator,
  type PageAddressCheck,
  type PageAddressNotice,
} from "../lib/publishing/snapshots"
import { assertPageTypeTranslatedIn } from "../lib/publishing/translationSwitch"
import {
  OPEN_TRANSITION_PHASES,
  assertOrdinaryLocale,
  readAuthorityRows,
  readOpenTransition,
  readSiteLanguageState,
  readTransitionPage,
  recordSharedDraftChange,
  recordTargetDraftWrite,
  resolveDraftLocaleEligibility,
  type Transition,
} from "../lib/language/state"
import {
  BOTH_FRESHNESS_DOMAINS,
  recordPublicChange,
} from "../lib/language/freshness"
import { retireContinuityRowForClaim } from "../lib/language/retirement"
import {
  collectDocumentReferences,
  referrerContentTypes,
} from "../lib/documentReferences"
import {
  collectMediaReferences,
  resolveMediaReference,
} from "../lib/mediaReferences"
import { richTextImagesForSource } from "../lib/media/richTextImages"
import { seoValidator, statusValidator } from "../schema"
import {
  applyPerLanguageInput,
  sharedSeoPatch,
  stripMovedSharedValues,
} from "../lib/contentTypes/perLanguageFields"
import { ensurePageBackfilled } from "../lib/publishing/perLanguageBackfill"
import { pageTypeValidator } from "../lib/pages/types"
import {
  assertBlockMutationIntegrity,
  diffBlockMutations,
  requireBlockMutationsPermitted,
} from "../lib/blocks/permissions"

import {
  digestLocalePublicationCandidate,
  canonicalJson,
  reconstructLocalePublicationCandidate,
  serializeLocalePublicationCandidate,
  type LocalePublicationAncestryItem,
  type LocalePublicationCandidatePayload,
} from "../lib/publishing/localeCandidate"
import {
  PAGE_PURGE_MAX_BATCH_ITEMS,
  PAGE_PURGE_PHASES,
  PAGE_PURGE_MAX_FAILURES,
  PAGE_PURGE_WAIT_MS,
  assertNoPagePurge,
  evaluatePurgeSelection,
  pagePurgeTuning,
  languageOperationOpen,
  readPagePurgeMarker,
  runPurgeBatch,
} from "../lib/publishing/pagePurge"

export const getSnapshotAuthorityForSeed = internalQuery({
  args: {},
  returns: v.union(
    v.literal("legacy"),
    v.literal("snapshot_active"),
    v.literal("invalid")
  ),
  handler: async (ctx) => readPublicationAuthority(ctx),
})

export const adminPageLocaleValidator = v.object({
  locale: v.string(),
  state: v.union(
    v.literal("published"),
    v.literal("draft"),
    v.literal("not_translated")
  ),
  title: v.optional(v.string()),
  slug: v.optional(v.string()),
  // Locale-relative path without the language prefix. "/" is the home page,
  // null is non-routable content, absent means not (yet) knowable.
  path: v.optional(v.union(v.string(), v.null())),
  draftGeneration: v.number(),
  publicGeneration: v.number(),
  releaseGeneration: v.number(),
  currentSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
})

export type AdminPageLocale = {
  locale: string
  state: "published" | "draft" | "not_translated"
  title?: string
  slug?: string
  path?: string | null
  draftGeneration: number
  publicGeneration: number
  releaseGeneration: number
  currentSnapshotId?: Id<"pagePublishedSnapshots">
}

/** What a caller already read for one locale; no extra reads are needed. */
export type AdminLocaleSource = {
  hasWorkingDraft: boolean
  hasVerifiedBase: boolean
  title?: string
  slug?: string
}

/**
 * The single per-language projection behind `listAdminPages`,
 * `pages.listSummaries` and `pages.getForEdit`, so the list and the editor
 * cannot disagree. Lifecycle (archived/trashed) stays a page-level field.
 */
export async function projectAdminPageLocales(
  ctx: PublicationCtx,
  args: {
    page: { _id: Id<"pages">; pageType: Doc<"pages">["pageType"] }
    parentId?: Id<"pages">
    homePageId?: Id<"pages">
    localeStates: Doc<"pageLocalePublicationStates">[]
    sources: Map<string, AdminLocaleSource>
    includeProspectivePaths?: boolean
  }
): Promise<AdminPageLocale[]> {
  const out: AdminPageLocale[] = []
  for (const state of args.localeStates) {
    const source = args.sources.get(state.locale)
    const published = Boolean(state.currentSnapshotId)
    const kind: AdminPageLocale["state"] = published
      ? "published"
      : source?.hasWorkingDraft || source?.hasVerifiedBase
        ? "draft"
        : "not_translated"
    const routable = isRoutableContentType(args.page.pageType)
    let path: string | null | undefined
    if (kind === "published") {
      path = state.currentPath ?? (routable ? undefined : null)
    } else if (kind === "draft" && args.includeProspectivePaths !== false) {
      // Prospective address: same rules as publishLocale.
      if (!routable) path = null
      else if (args.homePageId === args.page._id) path = "/"
      else if (source?.slug) {
        if (!args.parentId) {
          path = buildLocaleRelativePath({
            pageType: args.page.pageType,
            slug: source.slug,
          })
        } else {
          const parentRows = await ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", args.parentId!).eq("locale", state.locale)
            )
            .take(2)
          const parent = parentRows.length === 1 ? parentRows[0]! : null
          // Same rule as publishLocale's ancestry walk: a parent that is not
          // active makes the child unpublishable, so no address is promised.
          const parentPageState = await ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", args.parentId!))
            .take(2)
          const parentActive =
            parentPageState.length === 1 &&
            parentPageState[0]!.lifecycleState === "active"
          if (
            parentActive &&
            parent?.hasCurrentSnapshot &&
            parent.currentPath
          ) {
            path = buildLocaleRelativePath({
              pageType: args.page.pageType,
              slug: source.slug,
              ancestry: parent.currentPath,
            })
          }
        }
      }
    }
    out.push({
      locale: state.locale,
      state: kind,
      ...(kind !== "not_translated" && source?.title
        ? { title: source.title }
        : {}),
      ...(kind !== "not_translated" && source?.slug
        ? { slug: source.slug }
        : {}),
      ...(path === undefined ? {} : { path }),
      draftGeneration: state.draftGeneration,
      publicGeneration: state.publicGeneration,
      releaseGeneration: state.releaseGeneration,
      ...(state.currentSnapshotId
        ? { currentSnapshotId: state.currentSnapshotId }
        : {}),
    })
  }
  return out
}

const snapshotAdminPageRowValidator = v.object({
  _id: v.id("pages"),
  parentId: v.optional(v.id("pages")),
  slug: v.string(),
  localizedSlugs: v.record(v.string(), v.string()),
  localizedTitles: v.record(v.string(), v.string()),
  status: statusValidator,
  pageType: pageTypeValidator,
  lifecycleState: v.union(
    v.literal("active"),
    v.literal("archived"),
    v.literal("trashed")
  ),
  restoreLifecycleState: v.optional(
    v.union(v.literal("active"), v.literal("archived"))
  ),
  lifecycleGeneration: v.number(),
  sharedDraftGeneration: v.number(),
  locales: v.array(adminPageLocaleValidator),
  updatedAt: v.number(),
  // Trash scope only: a permanent purge of this Page is running.
  purging: v.optional(v.boolean()),
  // Trash scope only: the purge stopped before it finished. Delete retries it.
  purgeStalled: v.optional(v.boolean()),
})

export type SnapshotAdminPageRow = {
  _id: Id<"pages">
  parentId?: Id<"pages">
  slug: string
  localizedSlugs: Record<string, string>
  localizedTitles: Record<string, string>
  status: "published" | "draft" | "archived"
  pageType: Doc<"pages">["pageType"]
  lifecycleState: "active" | "archived" | "trashed"
  restoreLifecycleState?: "active" | "archived"
  lifecycleGeneration: number
  sharedDraftGeneration: number
  locales: AdminPageLocale[]
  updatedAt: number
  purging?: boolean
  purgeStalled?: boolean
}

export async function snapshotAdminPageRow(
  ctx: PublicationCtx,
  state: Doc<"pagePublicationPageStates">,
  options: { includeProspectivePaths?: boolean } = {}
): Promise<SnapshotAdminPageRow | null> {
  const page = await ctx.db.get("pages", state.pageId)
  if (!page || !isActiveContentType(page.pageType)) return null
  const [sharedRows, localeStates, settingsRows] = await Promise.all([
    ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
      .take(2),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
      .take(513),
    ctx.db.query("siteSettings").take(2),
  ])
  if (sharedRows.length !== 1 || settingsRows.length > 1) return null
  if (localeStates.length > 512) {
    throw new ConvexError("PUBLICATION_LOCALE_LIMIT")
  }
  const shared = sharedRows[0]!
  const localizedTitles: Record<string, string> = {}
  const localizedSlugs: Record<string, string> = {}
  let updatedAt = Math.max(state.updatedAt, shared.updatedAt)
  let hasCurrentSnapshot = false
  const sources = new Map<string, AdminLocaleSource>()
  for (const localeState of localeStates) {
    let projection: Awaited<ReturnType<typeof readFrozenSnapshotProjection>> =
      null
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", page._id).eq("locale", localeState.locale)
      )
      .take(2)
    if (drafts.length > 1) return null
    const draft = drafts[0]
    if (draft && draft.generation === localeState.draftGeneration) {
      const title =
        isRecord(draft.content) && typeof draft.content.title === "string"
          ? draft.content.title.trim()
          : ""
      if (title) localizedTitles[localeState.locale] = title
      localizedSlugs[localeState.locale] = draft.slug
      sources.set(localeState.locale, {
        hasWorkingDraft: true,
        hasVerifiedBase: false,
        ...(title ? { title } : {}),
        slug: draft.slug,
      })
      updatedAt = Math.max(updatedAt, draft.updatedAt)
    } else {
      const snapshotId =
        localeState.currentSnapshotId ?? localeState.draftBaseSnapshotId
      if (snapshotId) {
        projection = await readFrozenSnapshotProjection(
          ctx,
          snapshotId,
          page._id,
          localeState.locale
        )
      }
      if (projection) {
        const title = titleFromPublicPage(
          projection.publicPage,
          localeState.locale
        ).trim()
        if (title) localizedTitles[localeState.locale] = title
        localizedSlugs[localeState.locale] = projection.payload.localized.slug
        sources.set(localeState.locale, {
          hasWorkingDraft: false,
          hasVerifiedBase: true,
          ...(title ? { title } : {}),
          slug: projection.payload.localized.slug,
        })
      }
    }
    hasCurrentSnapshot ||= Boolean(localeState.currentSnapshotId)
    updatedAt = Math.max(updatedAt, localeState.updatedAt)
  }
  const defaultLocale =
    settingsRows[0]?.defaultLocale ?? localeStates[0]?.locale ?? "en"
  const slug = localizedSlugs[defaultLocale] ?? page.slug
  delete localizedSlugs[defaultLocale]
  const system = isRecord(shared.system) ? shared.system : {}
  const parentId = system.parentId
  const locales = await projectAdminPageLocales(ctx, {
    page,
    ...(typeof parentId === "string"
      ? { parentId: parentId as Id<"pages"> }
      : {}),
    ...(settingsRows[0]?.homePageId
      ? { homePageId: settingsRows[0].homePageId }
      : {}),
    localeStates,
    sources,
    includeProspectivePaths: options.includeProspectivePaths,
  })
  return {
    _id: page._id,
    ...(typeof parentId === "string"
      ? { parentId: parentId as Id<"pages"> }
      : {}),
    slug,
    localizedSlugs,
    localizedTitles,
    status:
      state.lifecycleState === "archived"
        ? "archived"
        : hasCurrentSnapshot
          ? "published"
          : "draft",
    pageType: page.pageType,
    lifecycleState: state.lifecycleState,
    ...(state.restoreLifecycleState
      ? { restoreLifecycleState: state.restoreLifecycleState }
      : {}),
    lifecycleGeneration: state.lifecycleGeneration,
    sharedDraftGeneration: shared.generation,
    locales,
    updatedAt,
  }
}

export const getAdminAuthority = query({
  args: {},
  returns: v.union(v.literal("snapshot_active"), v.literal("invalid")),
  handler: async (ctx) => {
    await requireOperationAccess(ctx)
    // Fresh installs only run the snapshot path. Any other phase, including
    // the old `legacy`, `preparing` and `ready` phases, is not usable.
    return (await readPublicationAuthority(ctx)) === "snapshot_active"
      ? ("snapshot_active" as const)
      : ("invalid" as const)
  },
})

export const listAdminPages = query({
  args: {
    paginationOpts: paginationOptsValidator,
    scope: v.union(
      v.literal("content"),
      v.literal("archive"),
      v.literal("trash")
    ),
  },
  returns: v.object({
    page: v.array(snapshotAdminPageRowValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null()
      )
    ),
  }),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED")
    }
    const lifecycle =
      args.scope === "archive"
        ? "archived"
        : args.scope === "trash"
          ? "trashed"
          : undefined
    const source = lifecycle
      ? ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_lifecycleState", (q) =>
            q.eq("lifecycleState", lifecycle)
          )
      : ctx.db.query("pagePublicationPageStates")
    const result = await source.order("desc").paginate(args.paginationOpts)
    const rows: SnapshotAdminPageRow[] = []
    for (const state of result.page) {
      if (args.scope === "content" && state.lifecycleState === "trashed")
        continue
      const row = await snapshotAdminPageRow(ctx, state)
      if (args.scope !== "trash") {
        if (row) rows.push(row)
        continue
      }
      // An accepted delete is not listed: the owner asked for it and it only
      // waits for the worker. A stalled one stays visible (with the retry
      // action) and keeps its title and address from the marker, because its
      // own drafts may already be gone.
      const marker = await readPagePurgeMarker(ctx, state.pageId)
      if (!marker) {
        if (row) rows.push(row)
        continue
      }
      if (marker.stalledAt === undefined) continue
      const page = await ctx.db.get("pages", state.pageId)
      if (row) {
        rows.push({
          ...row,
          localizedTitles: Object.keys(row.localizedTitles).length
            ? row.localizedTitles
            : marker.localizedTitles,
          purgeStalled: true,
        })
      } else if (page) {
        rows.push({
          _id: state.pageId,
          slug: marker.slug,
          localizedSlugs: {},
          localizedTitles: marker.localizedTitles,
          status: "draft",
          pageType: page.pageType,
          lifecycleState: state.lifecycleState,
          ...(state.restoreLifecycleState
            ? { restoreLifecycleState: state.restoreLifecycleState }
            : {}),
          lifecycleGeneration: state.lifecycleGeneration,
          sharedDraftGeneration: 0,
          locales: [],
          updatedAt: state.updatedAt,
          purgeStalled: true,
        })
      }
    }
    return { ...result, page: rows }
  },
})

type PublicationCtx = QueryCtx | MutationCtx

/** Plan the complete address change before shared or localized writes. */
async function preflightPageDraftAddresses(
  ctx: PublicationCtx,
  input: {
    page: Doc<"pages">
    parentId?: Id<"pages"> | null
    localized?: {
      locale: string
      slug: string
      addressIntent?: "typed" | "generated"
    }
    source?: "transition"
    shared?: Doc<"pageSharedDrafts">
    drafts?: Doc<"pageLocaleDrafts">[]
    localeState?: Doc<"pageLocalePublicationStates">
    homePageId?: Id<"pages">
    cache?: Map<string, Promise<unknown>>
  }
) {
  const cache = input.cache ?? new Map<string, Promise<unknown>>()
  if (input.shared)
    cache.set(
      `parent:${input.page._id}`,
      Promise.resolve(input.shared.system.parentId)
    )
  if (input.homePageId) cache.set("home", Promise.resolve(input.homePageId))
  const parentId = await addressSharedParent(ctx, input.page._id, cache)
  const nextParent =
    input.parentId === undefined ? parentId : (input.parentId ?? undefined)
  if (nextParent && nextParent !== parentId) await assertNoPagePurge(ctx, nextParent)
  const homePageId = await addressHomePage(ctx, cache)
  const drafts =
    parentId !== nextParent
      ? await addressDraftRows(ctx, input.page._id)
      : (input.drafts ??
        (input.localized
          ? await ctx.db
              .query("pageLocaleDrafts")
              .withIndex("by_pageId_and_locale", (q) =>
                q
                  .eq("pageId", input.page._id)
                  .eq("locale", input.localized!.locale)
              )
              .take(2)
          : []))
  if (
    drafts.length > 100 ||
    new Set(drafts.map((d) => d.locale)).size !== drafts.length
  )
    throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
  const proposed = new Map(
    drafts.map((d) => [
      d.locale,
      {
        slug: d.slug,
        addressIntent: undefined as "typed" | "generated" | undefined,
      },
    ])
  )
  if (input.localized)
    proposed.set(input.localized.locale, {
      slug: input.localized.slug,
      addressIntent: input.localized.addressIntent,
    })
  const results = new Map<
    string,
    {
      slug: string
      addressAllocation?: { wantedSlug: string; allocatedSlug: string }
    }
  >()
  for (const [locale, next] of proposed) {
    if (parentId === nextParent && locale !== input.localized?.locale) continue
    const draft = drafts.find((d) => d.locale === locale)
    const args = {
      pageId: input.page._id,
      pageType: input.page.pageType,
      locale,
      slug: next.slug.trim(),
      parentId: nextParent,
      homePageId,
      cache,
    }
    if (!args.slug) throw new ConvexError("SLUG_REQUIRED")
    const path = await futurePageAddress(ctx, args)
    let oldPath: string | null | undefined
    if (draft)
      oldPath = await futurePageAddress(ctx, {
        ...args,
        slug: draft.slug,
        parentId,
      })
    else {
      const states =
        input.localeState?.locale === locale
          ? [input.localeState]
          : await ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_pageId_and_locale", (q) =>
                q.eq("pageId", input.page._id).eq("locale", locale)
              )
              .take(2)
      if (states.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
      oldPath = states[0]?.currentPath
    }
    let result = {
      slug: args.slug,
      addressAllocation:
        next.addressIntent === "typed" &&
        !(
          args.slug === draft?.slug &&
          parentId === nextParent &&
          draft?.addressAllocation?.allocatedSlug === args.slug
        )
          ? undefined
          : draft?.addressAllocation,
    }
    if (path !== oldPath) {
      if (parentId === nextParent && next.addressIntent === "generated") {
        const allocated = await allocatePageAddress(ctx, args)
        result = {
          slug: allocated.slug,
          addressAllocation: allocated.addressAllocation,
        }
      } else
        refusePageAddress(
          await checkPageAddress(ctx, args),
          input.source ?? (parentId !== nextParent ? "parent" : "identifier")
        )
    }
    results.set(locale, result)
  }
  return results
}

export const addressAvailability = query({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    slug: v.optional(v.string()),
    parentId: v.optional(v.union(v.id("pages"), v.null())),
    intent: v.optional(v.union(v.literal("typed"), v.literal("generated"))),
  },
  returns: v.object({
    parentChanged: v.boolean(),
    entries: v.array(
      v.object({
        locale: v.string(),
        changed: v.boolean(),
        check: pageAddressCheckValidator,
        parentTitle: v.optional(v.string()),
        allocation: v.optional(
          v.object({
            wantedSlug: v.string(),
            allocatedSlug: v.string(),
            check: pageAddressCheckValidator,
            newPath: v.union(v.string(), v.null()),
          })
        ),
      })
    ),
  }),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    await requireSnapshotAuthority(ctx)
    await resolveDraftLocaleEligibility(ctx, args.locale)
    const page = await ctx.db.get("pages", args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const cache = new Map<string, Promise<unknown>>()
    const savedParent = await addressSharedParent(ctx, page._id, cache)
    const parentId =
      args.parentId === undefined ? savedParent : (args.parentId ?? undefined)
    const parentChanged = parentId !== savedParent
    const homePageId = await addressHomePage(ctx, cache)
    const drafts = await addressDraftRows(ctx, page._id)
    const states = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", page._id).eq("locale", args.locale)
      )
      .take(2)
    if (states.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    const state = states[0]
    const selected = drafts.find((d) => d.locale === args.locale)
    const selectedSlug =
      args.slug ??
      selected?.slug ??
      state?.currentPath?.split("/").at(-1) ??
      page.slug
    const locales = [
      args.locale,
      ...(parentChanged
        ? drafts.map((d) => d.locale).filter((l) => l !== args.locale)
        : []),
    ]
    const entries = []
    for (const locale of locales) {
      const eligibility = await resolveDraftLocaleEligibility(ctx, locale)
      if (locale !== args.locale && eligibility.kind === "target") continue
      const draft = drafts.find((d) => d.locale === locale)
      const slug = locale === args.locale ? selectedSlug : draft!.slug
      const input = {
        pageId: page._id,
        pageType: page.pageType,
        locale,
        slug,
        parentId,
        homePageId,
        cache,
      }
      const path = await futurePageAddress(ctx, input)
      const oldPath = draft
        ? await futurePageAddress(ctx, {
            ...input,
            parentId: savedParent,
            slug: draft.slug,
          })
        : state?.currentPath
      const changed = path !== oldPath
      const check = changed
        ? await checkPageAddress(ctx, input)
        : { kind: "free" as const, locale, path }
      let parentTitle: string | undefined
      if (parentId) {
        const parent = await readCurrentSnapshotProjection(
          ctx,
          parentId,
          locale
        )
        const title = parent?.payload.localized.content.title
        if (typeof title === "string") parentTitle = title
      }
      const allocation = draft?.addressAllocation
      entries.push({
        locale,
        changed,
        check,
        ...(parentTitle ? { parentTitle } : {}),
        ...(allocation && slug === allocation.allocatedSlug
          ? {
              allocation: {
                ...allocation,
                check: await checkPageAddress(ctx, {
                  ...input,
                  slug: allocation.wantedSlug,
                }),
                newPath: path,
              },
            }
          : {}),
      })
    }
    return { parentChanged, entries }
  },
})

async function recheckPublishedChildren(
  ctx: PublicationCtx,
  page: Doc<"pages">,
  locale: string,
  path: string | null,
  oldPath?: string,
  parentTitle?: string,
  cache = new Map<string, Promise<unknown>>()
) {
  if (path === null || path === oldPath) return
  // Only current_public rows in this language matter: the loop below skips
  // every other source kind and language, and old candidate rows pile up.
  const refs = await ctx.db
    .query("pagePublicationDocumentReferences")
    .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
      q
        .eq("targetId", page._id)
        .eq("sourceKind", "current_public")
        .eq("locale", locale)
    )
    .take(513)
  if (refs.length > 512) throw new ConvexError("PAGE_ANCESTRY_REFERENCE_LIMIT")
  const homePageId = await addressHomePage(ctx, cache)
  const proposed = new Map<string, NonNullable<PageAddressCheck["holder"]>>()
  const seen = new Set<string>()
  for (const ref of refs) {
    if (
      ref.referenceKind !== "ancestry" ||
      ref.sourceKind !== "current_public" ||
      ref.locale !== locale ||
      ref.targetLocale !== locale ||
      seen.has(ref.pageId)
    )
      continue
    seen.add(ref.pageId)
    const states = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", ref.pageId).eq("locale", locale)
      )
      .take(2)
    if (states.length !== 1 || states[0]!.currentSnapshotId !== ref.sourceId)
      continue
    if ((await addressSharedParent(ctx, ref.pageId, cache)) !== page._id)
      continue
    const child = await ctx.db.get("pages", ref.pageId)
    const lifecycle = await onePageState(ctx, ref.pageId)
    if (!child || lifecycle.lifecycleState === "trashed") continue
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", child._id).eq("locale", locale)
      )
      .take(2)
    if (drafts.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    const base = drafts[0]
      ? null
      : await verifiedDraftBase(ctx, child, locale, states[0])
    const slug = drafts[0]?.slug ?? base?.payload.localized.slug
    if (!slug) continue
    const check = await checkPageAddress(ctx, {
      pageId: child._id,
      pageType: child.pageType,
      locale,
      slug,
      parentId: page._id,
      parentPathOverride: { pageId: page._id, path },
      homePageId,
      cache,
      proposed,
    })
    const childTitle =
      drafts[0]?.content.title ??
      base?.payload.localized.content.title ??
      child.slug
    if (check.kind !== "free")
      throw new ConvexError({
        code: "PUBLISHED_CHILD_ROUTE_TAKEN",
        source: "publish",
        locale,
        path,
        parentTitle: parentTitle ?? page.slug,
        childTitle: String(childTitle),
        childPath: check.path,
        check,
      })
    if (check.path)
      proposed.set(`${locale}:${check.path}`, {
        pageId: child._id,
        pageType: child.pageType,
        title: String(childTitle),
      })
  }
}

export type LocalePublicationPayload = LocalePublicationCandidatePayload

const publicationResultValidator = v.object({
  pageId: v.id("pages"),
  locale: v.string(),
  snapshotId: v.id("pagePublishedSnapshots"),
  candidateId: v.id("pageLocalePublicationCandidates"),
  publicGeneration: v.number(),
  publishedAt: v.number(),
})

const withdrawalResultValidator = v.object({
  pageId: v.id("pages"),
  locale: v.string(),
  publicGeneration: v.number(),
})

const successorGenerationResultValidator = v.object({
  pageId: v.id("pages"),
  locale: v.optional(v.string()),
  generation: v.number(),
})

function parseObjectJson(
  value: string | undefined,
  label: string
): Record<string, unknown> {
  if (value === undefined || value.trim() === "") return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ConvexError(`${label}_INVALID_JSON`)
  }
  if (!isRecord(parsed)) throw new ConvexError(`${label}_INVALID_OBJECT`)
  return parsed
}

function ownerAttribution(owner: {
  ownerId: Id<"cmsOwner">
  authId: string
  tokenIdentifier: string
}) {
  return {
    kind: "owner" as const,
    ownerId: owner.ownerId,
    authId: owner.authId,
    tokenIdentifier: owner.tokenIdentifier,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Shared descriptor keys that moved into each language (ADR-0037 amendment). */
const MOVED_SHARED_FIELD_KEYS = ["category"] as const

function mergeRecord(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...current, ...patch }
}

/** JSON null clears only declared optional fields; omitted fields keep their value. */
function mergeSharedDescriptor(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: DescriptorFieldMap,
  options: WriteOptions
): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const field = fields[key]
    if (!field) throw new ConvexError("SHARED_FIELD_INVALID")
    if (value === null) {
      if (field.validator.isOptional !== "optional")
        throw new ConvexError("SHARED_FIELD_REQUIRED")
      delete next[key]
    } else {
      values[key] = value
    }
  }
  const written = writeFieldMap(fields, values, options)
  validateFieldMapRichText(fields, written)
  return { ...next, ...written }
}

async function clearSourceReferences(
  ctx: MutationCtx,
  sourceKind: "shared_draft" | "locale_draft" | "candidate" | "current_public",
  sourceId:
    | Id<"pageSharedDrafts">
    | Id<"pageLocaleDrafts">
    | Id<"pageLocalePublicationCandidates">
    | Id<"pagePublishedSnapshots">
): Promise<void> {
  const tables = [
    "pagePublicationDocumentReferences",
    "pagePublicationMediaReferences",
    "pagePublicationBlockReferences",
  ] as const
  for (const table of tables) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_sourceKind_and_sourceId", (q) =>
        q.eq("sourceKind", sourceKind).eq("sourceId", sourceId)
      )
      .take(513)
    if (rows.length > 512) throw new ConvexError("PUBLICATION_REFERENCE_LIMIT")
    // Deletes stay sequential: an unwrapped caller reconciles after each write.
    for (const row of rows) {
      await occurrenceUsageWrites(ctx).delete(table, row._id)
    }
  }
}

async function onePageState(ctx: PublicationCtx, pageId: Id<"pages">) {
  const rows = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (rows.length !== 1)
    throw new ConvexError("PAGE_PUBLICATION_PAGE_STATE_INVALID")
  return rows[0]!
}

async function oneSharedDraft(ctx: PublicationCtx, pageId: Id<"pages">) {
  const rows = await ctx.db
    .query("pageSharedDrafts")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (rows.length !== 1) throw new ConvexError("PAGE_SHARED_DRAFT_INVALID")
  return rows[0]!
}

/** One verified baseline for editor restaging and shared-only publication. */
async function verifiedDraftBase(
  ctx: PublicationCtx,
  page: Doc<"pages">,
  locale: string,
  state: Doc<"pageLocalePublicationStates"> | undefined
) {
  if (!state?.draftBaseSnapshotId) return undefined
  const base = await readFrozenSnapshotProjection(
    ctx,
    state.draftBaseSnapshotId,
    page._id,
    locale
  )
  if (!base || base.payload.page.pageType !== page.pageType)
    throw new ConvexError("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
  return base
}

/** Match the editor's saved baseline even after publication removes its row. */
async function presentationWorkingContent(
  ctx: PublicationCtx,
  page: Doc<"pages">,
  locale: string,
  draft: Doc<"pageLocaleDrafts"> | undefined,
  state: Doc<"pageLocalePublicationStates"> | undefined
): Promise<unknown> {
  return draft
    ? draft.content
    : (await verifiedDraftBase(ctx, page, locale, state))?.payload.localized
        .content
}

export async function initializeSuccessorPage(
  ctx: MutationCtx,
  page: Doc<"pages">,
  owner: OwnerPrincipal | { kind: "migration"; migrationRunId: string },
  content: Record<string, Record<string, unknown>>,
  expectedPresentationCatalogRevision?: string
): Promise<void> {
  const existingState = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
    .take(2)
  if (existingState.length > 0) {
    if (existingState.length !== 1)
      throw new ConvexError("PAGE_PUBLICATION_PAGE_STATE_INVALID")
    return
  }
  const localizedContent = Object.fromEntries(
    Object.entries(content).map(([locale, localeContent]) => [
      locale,
      isRecord(localeContent.content) ? localeContent.content : localeContent,
    ])
  )
  const historical = "kind" in owner && owner.kind === "migration"
  await assertBlockMutationIntegrity(
    ctx,
    diffBlockMutations(
      historical ? (localizedContent as never) : undefined,
      localizedContent as never
    ),
    {
      existingContent: historical ? page.content : undefined,
      content: localizedContent,
      operation: historical ? "restore" : "create",
      expectedPresentationCatalogRevision,
    }
  )
  const addressCache = new Map<string, Promise<unknown>>()
  const addressPlans = new Map<
    string,
    Awaited<ReturnType<typeof allocatePageAddress>>
  >()
  for (const [locale, localeContent] of Object.entries(content)) {
    const slug = typeof localeContent.slug === "string" ? localeContent.slug : page.slug
    const input = {
      pageId: page._id,
      pageType: page.pageType,
      locale,
      slug,
      parentId: page.parentId,
      cache: addressCache,
    }
    if (historical) {
      if (page.deletedAt === undefined)
        refusePageAddress(await checkPageAddress(ctx, input), "migration")
    } else addressPlans.set(locale, await allocatePageAddress(ctx, input))
  }
  const now = Date.now()
  const attribution = "kind" in owner ? owner : ownerAttribution(owner)
  const descriptor = contentTypeDefs[page.pageType]
  if (!descriptor) throw new ConvexError("CONTENT_TYPE_INVALID")
  const source = page as unknown as Record<string, unknown>
  const descriptorFields: Record<string, unknown> = {}
  // The cutover from the legacy Page row keeps the old shared shape (a moved
  // field such as the post category stays readable). A page the owner creates
  // starts in the per-language shape (ADR-0037 amendment, 2026-11-17).
  const cutover = attribution.kind === "migration"
  for (const key of Object.keys(
    cutover ? descriptor.sharedValidator.fields : descriptor.sharedFields
  )) {
    if (source[key] !== undefined) descriptorFields[key] = source[key]
  }
  const system: Record<string, unknown> = {}
  for (const key of [
    "seo",
    "template",
    "parentId",
    "siblingOrder",
    "showOnHomepage",
    "displayMode",
    "cardImageMediaId",
    "cardExcerpt",
  ]) {
    if (source[key] !== undefined) system[key] = source[key]
  }
  if (!cutover) {
    const owned = stripMovedSharedValues({ system, descriptor: {} })
    for (const key of Object.keys(system)) delete system[key]
    Object.assign(system, owned.system)
  }
  const lifecycleState =
    attribution.kind === "migration"
      ? page.deletedAt !== undefined
        ? ("trashed" as const)
        : page.status === "archived"
          ? ("archived" as const)
          : ("active" as const)
      : ("active" as const)
  const restoreLifecycleState =
    lifecycleState === "trashed"
      ? page.status === "archived"
        ? ("archived" as const)
        : ("active" as const)
      : undefined
  await occurrenceUsageWrites(ctx).insert("pagePublicationPageStates", {
    pageId: page._id,
    modelVersion: 1,
    lifecycleState,
    ...(restoreLifecycleState ? { restoreLifecycleState } : {}),
    lifecycleGeneration: 1,
    createdAt: now,
    updatedAt: now,
    // A page the owner creates owns its per-language values from the start.
    ...(cutover
      ? {}
      : {
          perLanguageFieldsBackfill: { at: now, draftsWritten: 0, skippedNoDraft: 0 },
        }),
  })
  const sharedId = await occurrenceUsageWrites(ctx).insert("pageSharedDrafts", {
    pageId: page._id,
    pageType: page.pageType,
    generation: 1,
    system,
    descriptor: descriptorFields,
    updatedBy: attribution,
    createdAt: now,
    updatedAt: now,
  } as Parameters<typeof ctx.db.insert<"pageSharedDrafts">>[1])
  await writeReferences(
    ctx,
    {
      ...page,
      ...descriptorFields,
      ...system,
      content: {},
    } as Doc<"pages">,
    page._id,
    undefined,
    "shared_draft",
    sharedId,
    1,
    undefined,
    now
  )
  const locales = Object.keys(content)
  if (locales.length === 0) {
    throw new ConvexError("PAGE_LOCALE_DRAFT_REQUIRED")
  }
  for (const locale of locales) {
    const localeStateId = await occurrenceUsageWrites(ctx).insert(
      "pageLocalePublicationStates",
      {
        pageId: page._id,
        locale,
        draftGeneration: 1,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: now,
      }
    )
    void localeStateId
    const localeContent = content[locale]
    const slug = typeof localeContent.slug === "string" ? localeContent.slug : page.slug
    const localized = isRecord(localeContent.content) ? localeContent.content : localeContent
    const localeDraftId = await occurrenceUsageWrites(ctx).insert(
      "pageLocaleDrafts",
      {
        pageId: page._id,
        locale,
        pageType: page.pageType,
        generation: 1,
        slug: addressPlans.get(locale)?.slug ?? slug,
        ...(addressPlans.get(locale)?.addressAllocation
          ? { addressAllocation: addressPlans.get(locale)!.addressAllocation }
          : {}),
        content: localized,
        updatedBy: attribution,
        createdAt: now,
        updatedAt: now,
      } as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1]
    )
    await writeReferences(
      ctx,
      {
        ...page,
        content: { [locale]: localized },
      } as Doc<"pages">,
      page._id,
      locale,
      "locale_draft",
      localeDraftId,
      1,
      undefined,
      now
    )
  }
}

async function oneLocaleState(
  ctx: Parameters<typeof requireSnapshotAuthority>[0],
  pageId: Id<"pages">,
  locale: string
) {
  const rows = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    )
    .take(2)
  if (rows.length !== 1) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  return rows[0]!
}

async function clearCurrentReferences(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  locale: string
) {
  const tables = [
    "pagePublicationDocumentReferences",
    "pagePublicationMediaReferences",
    "pagePublicationBlockReferences",
  ] as const
  for (const table of tables) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
        q
          .eq("pageId", pageId)
          .eq("locale", locale)
          .eq("sourceKind", "current_public")
      )
      .take(513)
    if (rows.length > 512) throw new ConvexError("PUBLICATION_REFERENCE_LIMIT")
    // Deletes stay sequential: an unwrapped caller reconciles after each write.
    for (const row of rows) {
      await occurrenceUsageWrites(ctx).delete(table, row._id)
    }
  }
}

type ProjectionReader = (
  ctx: PublicationCtx,
  pageId: Id<"pages">,
  locale: string
) => Promise<SnapshotPayload | null>

/**
 * Where capture reads reference and ancestry targets. Ordinary publication
 * uses the public projection. F09 preparation uses the hidden-target
 * projection and records a document reference to a `target` transition page
 * that is not yet selected (invariant 17); ancestry stays strict.
 */
type ReferenceTargetResolver = {
  project: ProjectionReader
  deferDocumentTarget: (
    ctx: MutationCtx,
    targetId: Id<"pages">
  ) => Promise<boolean>
}

const PUBLIC_REFERENCE_TARGETS: ReferenceTargetResolver = {
  project: readCurrentSnapshotProjection,
  deferDocumentTarget: async () => false,
}

function hiddenTargetReferences(
  transitionId: Id<"siteLanguageTransitions">
): ReferenceTargetResolver {
  return {
    project: readHiddenTargetSnapshotProjection,
    deferDocumentTarget: async (ctx, targetId) =>
      (await readTransitionPage(ctx, transitionId, targetId))?.disposition ===
      "target",
  }
}

async function writeReferences(
  ctx: MutationCtx,
  source: Doc<"pages">,
  pageId: Id<"pages">,
  locale: string | undefined,
  sourceKind: "shared_draft" | "locale_draft" | "candidate" | "current_public",
  sourceId:
    | Id<"pageSharedDrafts">
    | Id<"pageLocaleDrafts">
    | Id<"pageLocalePublicationCandidates">
    | Id<"pagePublishedSnapshots">,
  sourceGeneration: number,
  candidateDigestValue: string | undefined,
  now: number,
  ancestry: LocalePublicationAncestryItem[] = [],
  validatePublicTargets = true,
  resolver: ReferenceTargetResolver = PUBLIC_REFERENCE_TARGETS
) {
  const sourceMetadata =
    sourceKind === "candidate"
      ? { sourceKind, sourceId, candidateDigest: candidateDigestValue! }
      : sourceKind === "current_public"
        ? { sourceKind, sourceId, publicGeneration: sourceGeneration }
        : { sourceKind, sourceId, sourceGeneration }
  const documents = collectDocumentReferences(source).filter((ref) =>
    sourceKind === "shared_draft"
      ? ref.sourceLocale === undefined
      : ref.sourceLocale === locale ||
        ((sourceKind === "candidate" || sourceKind === "current_public") &&
          ref.sourceLocale === undefined)
  )
  const collectedMedia = collectMediaReferences(source).filter((ref) =>
    sourceKind === "shared_draft"
      ? ref.locale === undefined
      : ref.locale === locale ||
        ((sourceKind === "candidate" || sourceKind === "current_public") &&
          ref.locale === undefined)
  )
  const mediaResults = await Promise.all(
    collectedMedia.map((ref) => resolveMediaReference(ctx, ref))
  )
  const media = mediaResults.filter(
    (ref): ref is NonNullable<typeof ref> => ref !== null
  )
  if (media.length !== collectedMedia.length)
    throw new ConvexError("PUBLICATION_MEDIA_REFERENCE_MISSING")
  for (let index = 0; index < media.length; index += 1) {
    const collected = collectedMedia[index]!
    const resolved = media[index]!
    if (collected.mediaId && collected.mediaId !== resolved.mediaId) {
      throw new ConvexError("PUBLICATION_MEDIA_REFERENCE_IDENTITY_MISMATCH")
    }
    if (collected.storageId && collected.storageId !== resolved.storageId) {
      throw new ConvexError("PUBLICATION_MEDIA_REFERENCE_IDENTITY_MISMATCH")
    }
    if (!(await ctx.db.system.get("_storage", resolved.storageId))) {
      throw new ConvexError("PUBLICATION_MEDIA_STORAGE_MISSING")
    }
  }
  // Library images inside rich-text fields carry only their URL. An external
  // src matches no media row and is ignored (never an error).
  const richTextImages = await richTextImagesForSource(
    ctx,
    source,
    locale,
    sourceKind,
    // Draft save, translation apply and publication all pass here: an image
    // deleted for good, or one whose file is gone, never reaches a page.
    { strict: true }
  )
  const blocks = locale
    ? ((
        source.content?.[locale] as
          { blocks?: Array<{ type: string }> } | undefined
      )?.blocks ?? [])
    : []
  const blockCounts = new Map<string, number>()
  for (const block of blocks)
    blockCounts.set(block.type, (blockCounts.get(block.type) ?? 0) + 1)
  if (
    documents.length +
      media.length +
      richTextImages.length +
      blockCounts.size +
      ancestry.length >
    512
  ) {
    throw new ConvexError("PUBLICATION_REFERENCE_LIMIT")
  }
  for (const ref of documents) {
    const target = await ctx.db.get("pages", ref.targetId)
    if (!target) throw new ConvexError("PUBLICATION_REFERENCE_TARGET_MISSING")
    await assertNoPagePurge(ctx, ref.targetId)
    if (
      validatePublicTargets &&
      (sourceKind === "candidate" || sourceKind === "current_public") &&
      (!locale ||
        (!(await resolver.project(ctx, ref.targetId, locale)) &&
          !(await resolver.deferDocumentTarget(ctx, ref.targetId)) &&
          // ADR-0037 amendment (2026-11-17), clause 3: a target whose type is
          // switched to another language is left out of public readers, so
          // linking to it does not block publishing. The row is still written.
          !(await isPageHiddenInLocaleOrAncestry(ctx, ref.targetId, locale))))
    ) {
      throw new ConvexError("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
    }
    await ctx.db.insert("pagePublicationDocumentReferences", {
      pageId,
      ...(locale ? { locale } : {}),
      ...sourceMetadata,
      targetId: ref.targetId,
      targetType: target.pageType,
      sourcePath: ref.path,
      referenceKind: ref.source,
      createdAt: now,
      updatedAt: now,
      ...(sourceKind !== "shared_draft" && locale
        ? { targetLocale: locale }
        : {}),
    } as never)
  }
  for (const ancestor of ancestry) {
    const targetId = ancestor.pageId as Id<"pages">
    const target = await ctx.db.get("pages", targetId)
    if (target) await assertNoPagePurge(ctx, targetId)
    if (
      !target ||
      !locale ||
      (validatePublicTargets &&
        !(await resolver.project(ctx, targetId, locale)))
    ) {
      throw new ConvexError("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
    }
    await ctx.db.insert("pagePublicationDocumentReferences", {
      pageId,
      locale,
      ...sourceMetadata,
      targetId,
      targetType: target.pageType,
      sourcePath: "route.ancestry",
      referenceKind: "ancestry",
      targetLocale: locale,
      createdAt: now,
      updatedAt: now,
    } as never)
  }
  for (const ref of media) {
    await ctx.db.insert("pagePublicationMediaReferences", {
      pageId,
      ...(locale ? { locale } : {}),
      ...sourceMetadata,
      mediaId: ref.mediaId,
      storageId: ref.storageId,
      sourcePath: ref.path,
      referenceKind: ref.source,
      createdAt: now,
      updatedAt: now,
    } as never)
  }
  for (const ref of richTextImages) {
    await ctx.db.insert("pagePublicationMediaReferences", {
      pageId,
      ...(locale ? { locale } : {}),
      ...sourceMetadata,
      mediaId: ref.mediaId,
      storageId: ref.storageId,
      sourcePath: ref.path,
      referenceKind: "rich-text-image",
      createdAt: now,
      updatedAt: now,
    } as never)
  }
  for (const [blockType, count] of blockCounts) {
    await occurrenceUsageWrites(ctx).insert("pagePublicationBlockReferences", {
      pageId,
      ...(locale ? { locale } : {}),
      ...sourceMetadata,
      blockType,
      count,
      createdAt: now,
      updatedAt: now,
    } as never)
  }
}

function titleFromPublicPage(value: unknown, locale: string): string {
  if (!isRecord(value)) return ""
  if (typeof value.name === "string" && value.name.length > 0) return value.name
  const content = value.content
  if (isRecord(content) && isRecord(content[locale])) {
    const title = content[locale].title
    if (typeof title === "string") return title
  }
  return ""
}

async function captureAncestry(
  ctx: PublicationCtx,
  publishingPageId: Id<"pages">,
  parentId: Id<"pages"> | undefined,
  locale: string,
  project: ProjectionReader = readCurrentSnapshotProjection
): Promise<
  Array<{
    pageId: string
    snapshotId: string
    publicGeneration: number
    title: string
    canonicalPath: string
  }>
> {
  const ancestry: Array<{
    pageId: string
    snapshotId: string
    publicGeneration: number
    title: string
    canonicalPath: string
  }> = []
  let cursor = parentId
  // Same proposed-parent walk as legacy pages.update: reaching the publishing
  // Page means self-parenting or a descendant move, even through old snapshots.
  const seen = new Set<string>([publishingPageId])
  while (cursor) {
    if (seen.has(cursor)) throw new ConvexError("PAGE_ANCESTRY_CYCLE")
    seen.add(cursor)
    const parentState = await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", cursor!))
      .take(2)
    const parent = await ctx.db.get("pages", cursor)
    if (
      parentState.length !== 1 ||
      !parent ||
      parentState[0]!.lifecycleState !== "active"
    ) {
      throw new ConvexError("PAGE_ANCESTRY_UNAVAILABLE")
    }
    const parentLocaleRows = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", cursor!).eq("locale", locale)
      )
      .take(2)
    const parentLocale =
      parentLocaleRows.length === 1 ? parentLocaleRows[0]! : null
    if (!parentLocale?.currentSnapshotId || !parentLocale.hasCurrentSnapshot) {
      throw new ConvexError("PAGE_ANCESTRY_UNAVAILABLE")
    }
    const projection = await project(ctx, cursor, locale)
    if (!projection?.path) throw new ConvexError("PAGE_ANCESTRY_UNAVAILABLE")
    ancestry.unshift({
      pageId: String(cursor),
      snapshotId: String(parentLocale.currentSnapshotId),
      publicGeneration: parentLocale.publicGeneration,
      title: titleFromPublicPage(projection.publicPage, locale),
      canonicalPath: projection.path,
    })
    const parentShared = projection.payload.shared
    const parentSystem =
      parentShared &&
      typeof parentShared === "object" &&
      !Array.isArray(parentShared)
        ? (parentShared as Record<string, unknown>).system
        : undefined
    const nextParentId =
      parentSystem &&
      typeof parentSystem === "object" &&
      !Array.isArray(parentSystem)
        ? (parentSystem as Record<string, unknown>).parentId
        : undefined
    if (nextParentId !== undefined && typeof nextParentId !== "string") {
      throw new ConvexError("PAGE_ANCESTRY_UNAVAILABLE")
    }
    cursor = nextParentId as Id<"pages"> | undefined
  }
  return ancestry
}

/** Preserve the first departure evidence; indexes do not make claims unique. */
async function historicalPathNeedsReservation(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  locale: string,
  fromPath: string,
  cache?: Map<string, Promise<unknown>>
): Promise<boolean> {
  const rows = await readHeldHistoricalRows(ctx, locale, fromPath, cache)
  if (!rows) throw new ConvexError("PAGE_ADDRESS_LOOKUP_LIMIT")
  // Existing duplicates/cross-owner claims stay fail closed; no backfill here.
  if (rows.length > 1 || rows.some((row) => row.pageId !== pageId)) {
    throw new ConvexError("PUBLISHED_LOCALE_ROUTE_RESERVED")
  }
  return rows.length === 0
}

function buildPayload(
  page: Doc<"pages">,
  shared: Record<string, unknown>,
  locale: string,
  slug: string,
  content: Record<string, unknown>,
  path: string | null,
  ancestry: Array<{
    pageId: string
    snapshotId: string
    publicGeneration: number
    title: string
    canonicalPath: string
  }>,
  // The cutover from the legacy Page row keeps the old shared shape: the
  // frozen snapshot resolves it at read time. Every owner publication writes
  // the per-language values in the Localized Content only (ADR-0037
  // amendment, 2026-11-17), so their absence from the shared blocks marks a
  // snapshot that owns them.
  options: { keepLegacyShared?: boolean } = {}
): LocalePublicationPayload {
  const descriptor: Record<string, unknown> = {}
  const typeDef = contentTypeDefs[page.pageType]
  const descriptorShape = options.keepLegacyShared
    ? typeDef?.sharedValidator.fields
    : typeDef?.sharedFields
  if (descriptorShape) {
    const sharedDescriptor = isRecord(shared.descriptor)
      ? shared.descriptor
      : {}
    for (const key of Object.keys(descriptorShape)) {
      const value = sharedDescriptor[key]
      if (value !== undefined) descriptor[key] = value
    }
  }
  const sharedBlocks = {
    system: isRecord(shared.system) ? { ...shared.system } : {},
    descriptor,
  }
  const finalShared = options.keepLegacyShared
    ? sharedBlocks
    : stripMovedSharedValues(sharedBlocks)
  const localized = { slug, content }
  return {
    page: { id: String(page._id), pageType: page.pageType },
    locale,
    localized,
    shared: finalShared,
    route:
      path === null
        ? { kind: "non_routable" }
        : { kind: "routable", canonicalPath: path, ancestry },
  }
}

/**
 * Clean-install seam for the cutover singleton. It can only activate the
 * successor when no legacy content or publication artifacts exist, so a
 * migration cannot be accidentally skipped by an operator or fixture.
 */
export async function initializeEmptySnapshotAuthorityForOwner(
  ctx: MutationCtx,
  options: { requireEmptyInstall?: boolean } = {}
): Promise<{ phase: "snapshot_active"; revision: number }> {
  const cutoverRows = await ctx.db
    .query("pagePublicationCutover")
    .withIndex("by_key", (q) => q.eq("key", "published-snapshot-v1"))
    .take(2)
  if (cutoverRows.length > 1)
    throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
  const emptyClosureDigest = await digestLocalePublicationCandidate("[]")
  const existing = cutoverRows[0]
  if (existing) {
    if (existing.phase !== "snapshot_active")
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_NOT_EMPTY_INSTALL")
    if (!options.requireEmptyInstall)
      return { phase: existing.phase, revision: existing.revision }
    // A clean bootstrap may reuse only the exact zero-count epoch this helper
    // creates. A migrated or already-authored epoch is never "empty" again.
    if (
      existing.migrationRunId !== undefined ||
      existing.expectedPageCount !== 0 ||
      existing.preparedPageCount !== 0 ||
      existing.closurePageCount !== 0 ||
      existing.closureRollingDigest !== emptyClosureDigest ||
      existing.closureDigest !== emptyClosureDigest
    )
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_NOT_EMPTY_INSTALL")
  }
  const retainedFamilies = await Promise.all([
    ctx.db.query("pages").take(1),
    ctx.db.query("pageStaging").take(1),
    ctx.db.query("pageSearch").take(1),
    ctx.db.query("pageRevisions").take(1),
    ctx.db.query("pagePresence").take(1),
    ctx.db.query("pageEditorLocks").take(1),
    ctx.db.query("documentReferences").take(1),
    ctx.db.query("mediaReferences").take(1),
    ctx.db.query("pagePublicationPageStates").take(1),
    ctx.db.query("pageSharedDrafts").take(1),
    ctx.db.query("pageLocaleDrafts").take(1),
    ctx.db.query("pageLocalePublicationStates").take(1),
    ctx.db.query("pageLocalePublicationCandidates").take(1),
    ctx.db.query("pageLocalePublicationReleases").take(1),
    ctx.db.query("pagePublishedSnapshots").take(1),
    ctx.db.query("pagePublicationDocumentReferences").take(1),
    ctx.db.query("pagePublicationMediaReferences").take(1),
    ctx.db.query("pagePublicationBlockReferences").take(1),
    ctx.db.query("pageHistoricalLocaleRoutes").take(1),
    ctx.db.query("pagePublicationRevalidationIntents").take(1),
    ctx.db.query("pagePublicationPreviewSessions").take(1),
  ])
  if (retainedFamilies.some((rows) => rows.length > 0)) {
    throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_REQUIRES_MIGRATION")
  }
  if (existing)
    return { phase: "snapshot_active" as const, revision: existing.revision }
  await ctx.db.insert("pagePublicationCutover", {
    key: "published-snapshot-v1",
    phase: "snapshot_active",
    revision: 1,
    expectedPageCount: 0,
    preparedPageCount: 0,
    closurePageCount: 0,
    closureRollingDigest: emptyClosureDigest,
    closureDigest: emptyClosureDigest,
    updatedAt: Date.now(),
  })
  return { phase: "snapshot_active" as const, revision: 1 }
}

export const initializeEmptySnapshotAuthority = mutation({
  args: {},
  returns: v.object({
    phase: v.literal("snapshot_active"),
    revision: v.number(),
  }),
  handler: async (ctx) => {
    const owner = await requireOperationAccess(ctx)
    void owner
    return initializeEmptySnapshotAuthorityForOwner(ctx)
  },
})

/** Immutable locale history, including unsupported content for inspection. */
export const listSnapshotHistory = query({
  args: { pageId: v.id("pages"), locale: v.string() },
  returns: v.array(
    v.object({
      snapshotId: v.id("pagePublishedSnapshots"),
      generation: v.number(),
      publishedAt: v.number(),
      payloadJson: v.string(),
      unavailablePaths: v.array(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active")
      throw new ConvexError("PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED")
    await requireOperationAccess(ctx)
    const snapshots = await ctx.db
      .query("pagePublishedSnapshots")
      .withIndex("by_pageId_and_locale_and_generation", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .order("desc")
      .take(20)
    return Promise.all(
      snapshots.map(async (snapshot) => {
        const frozen = await readFrozenSnapshotProjection(
          ctx,
          snapshot._id,
          args.pageId,
          args.locale
        )
        if (!frozen) throw new ConvexError("PUBLISHED_SNAPSHOT_INVALID")
        return {
          snapshotId: snapshot._id,
          generation: snapshot.generation,
          publishedAt: snapshot.publishedAt,
          payloadJson: canonicalJson(frozen.payload),
          unavailablePaths: findUnavailableBlockLocations({
            [args.locale]: frozen.payload.localized.content,
          }).map((location) => location.path),
        }
      })
    )
  },
})

/** Replace complete drafts from history; never select or rewrite public history. */
export const restoreSnapshotAsDraft = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    snapshotId: v.id("pagePublishedSnapshots"),
    expectedDraftGeneration: v.number(),
    expectedSharedDraftGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
    expectedPublicGeneration: v.number(),
    expectedReleaseGeneration: v.number(),
  },
  returns: v.object({
    pageId: v.id("pages"),
    locale: v.string(),
    draftGeneration: v.number(),
    sharedDraftGeneration: v.number(),
    updatedAt: v.number(),
    removedTitleLinks: removedTitleLinksValidator,
    addressNotices: v.optional(v.array(pageAddressNoticeValidator)),
  }),
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    const { settings } = await assertOrdinaryLocale(ctx, args.locale)
    const page = await ctx.db.get("pages", args.pageId)
    if (!page || !isActiveContentType(page.pageType))
      throw new ConvexError("PAGE_NOT_FOUND")
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    const shared = await oneSharedDraft(ctx, args.pageId)
    if (
      shared.pageType !== page.pageType ||
      shared.generation !== args.expectedSharedDraftGeneration
    )
      throw new ConvexError("PAGE_SHARED_DRAFT_STALE")
    const state = await oneLocaleState(ctx, args.pageId, args.locale)
    if (state.draftGeneration !== args.expectedDraftGeneration)
      throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    if (
      state.publicGeneration !== args.expectedPublicGeneration ||
      state.releaseGeneration !== args.expectedReleaseGeneration
    )
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
    // The restore replaces the Shared Draft's system block: copy its old
    // values into the page's Working Drafts first (once per page).
    await ensurePageBackfilled(ctx, args.pageId, pageState)
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (
      drafts.length > 1 ||
      (drafts[0] &&
        (drafts[0].generation !== state.draftGeneration ||
          drafts[0].pageType !== page.pageType))
    )
      throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
    const frozen = await readFrozenSnapshotProjection(
      ctx,
      args.snapshotId,
      args.pageId,
      args.locale
    )
    if (!frozen || frozen.payload.page.pageType !== page.pageType)
      throw new ConvexError("PUBLISHED_SNAPSHOT_INVALID")
    const { shared: historicalShared } = frozen.payload
    const restoredSharedDescriptor = writeFieldMap(
      contentTypeDefs[page.pageType].sharedFields,
      historicalShared.descriptor
    )
    const copyOptions: WriteOptions = {
      readLegacyShapes: true,
      trustedSource: {
        recordId: args.snapshotId,
        version: (await ctx.db.get("pagePublishedSnapshots", args.snapshotId))!.candidateDigest,
        content: { [args.locale]: frozen.payload.localized.content },
      },
    }
    const converted = writePageContent(
      page.pageType,
      { [args.locale]: frozen.payload.localized.content },
      copyOptions
    )
    const localized = {
      ...frozen.payload.localized,
      content: converted.value[args.locale],
    }
    const content = converted.value
    const presentationBaseline = await presentationWorkingContent(
      ctx,
      page,
      args.locale,
      drafts[0],
      state
    )
    // The profile check precedes all writes and inspects both whole bags.
    await requireBlockMutationsPermitted(
      ctx,
      diffBlockMutations(
        (presentationBaseline !== undefined
          ? { [args.locale]: presentationBaseline }
          : undefined) as Parameters<typeof diffBlockMutations>[0],
        content
      ),
      {
        existingContent:
          presentationBaseline !== undefined
            ? { [args.locale]: presentationBaseline }
            : undefined,
        content,
        operation: "restore",
      }
    )
    const descriptor = contentTypeDefs[page.pageType]
    validateFieldMapRichText(
      descriptor.localizedFields,
      localized.content,
      "legacy"
    )
    validateFieldMapRichText(
      descriptor.sharedFields,
      restoredSharedDescriptor,
      "legacy"
    )
    if (descriptor.capabilities.blockBody) {
      validateUniqueBlockIds(localized.content.blocks as Block[])
      validateBlocksRichText(localized.content.blocks as Block[], "write", {
        options: copyOptions,
        locale: args.locale,
      })
    }
    if (!localized.slug.trim()) throw new ConvexError("SLUG_REQUIRED")
    let restoredSlug = localized.slug
    const restoredSystem = { ...historicalShared.system }
    const addressNotices: PageAddressNotice[] = []
    try {
      await preflightPageDraftAddresses(ctx, {
        page,
        shared,
        drafts,
        localeState: state,
        homePageId: settings.homePageId,
        parentId: (restoredSystem.parentId as Id<"pages"> | undefined) ?? null,
        localized: { locale: args.locale, slug: restoredSlug },
      })
    } catch (error) {
      if (
        !(error instanceof ConvexError) ||
        typeof error.data !== "object" ||
        error.data === null ||
        !("source" in error.data) ||
        !("kind" in error.data)
      )
        throw error
      const { code, source, ...checkPayload } = error.data
      void code
      void source
      const check = checkPayload as unknown as PageAddressCheck
      const current =
        drafts[0]?.slug ??
        (await verifiedDraftBase(ctx, page, args.locale, state))?.payload
          .localized.slug
      if (!current) throw error
      restoredSlug = current
      if (shared.system.parentId)
        restoredSystem.parentId = shared.system.parentId
      else delete restoredSystem.parentId
      const currentPath = await futurePageAddress(ctx, {
        pageId: page._id,
        pageType: page.pageType,
        locale: args.locale,
        slug: current,
        parentId: shared.system.parentId,
        homePageId: await addressHomePage(ctx),
      })
      if (check.locale === args.locale && check.path && currentPath)
        addressNotices.push({
          locale: args.locale,
          oldPath: check.path,
          newPath: currentPath,
          check,
        })
    }
    const now = Date.now()
    const draftGeneration = state.draftGeneration + 1
    const sharedDraftGeneration = shared.generation + 1
    await occurrenceUsageWrites(ctx).patch("pageSharedDrafts", shared._id, {
      generation: sharedDraftGeneration,
      system: restoredSystem,
      descriptor: restoredSharedDescriptor,
      updatedBy: ownerAttribution(owner),
      updatedAt: now,
    } as never)
    const row = {
      pageId: args.pageId,
      locale: args.locale,
      pageType: page.pageType,
      generation: draftGeneration,
      slug: restoredSlug,
      content: localized.content,
      updatedBy: ownerAttribution(owner),
      createdAt: drafts[0]?.createdAt ?? now,
      updatedAt: now,
    }
    const draftId = drafts[0]
      ? (await occurrenceUsageWrites(ctx).patch("pageLocaleDrafts", drafts[0]._id, row as never),
        drafts[0]._id)
      : await occurrenceUsageWrites(ctx).insert(
          "pageLocaleDrafts",
          row as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1]
        )
    // Construct from the complete snapshot, without residual legacy shared fields.
    const source = {
      _id: page._id,
      _creationTime: page._creationTime,
      pageType: page.pageType,
      slug: restoredSlug,
      status: "draft",
      createdAt: page.createdAt,
      updatedAt: now,
      ...restoredSystem,
      ...restoredSharedDescriptor,
      content,
    } as Doc<"pages">
    await clearSourceReferences(ctx, "shared_draft", shared._id)
    await clearSourceReferences(ctx, "locale_draft", draftId)
    await writeReferences(
      ctx,
      { ...source, content: {} } as Doc<"pages">,
      page._id,
      undefined,
      "shared_draft",
      shared._id,
      sharedDraftGeneration,
      undefined,
      now
    )
    await writeReferences(
      ctx,
      source,
      page._id,
      args.locale,
      "locale_draft",
      draftId,
      draftGeneration,
      undefined,
      now
    )
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
      draftGeneration,
      updatedAt: now,
    })
    await recordSharedDraftChange(ctx, args.pageId)
    await recordPublicChange(ctx, { pageId: args.pageId, scopes: [] })
    return {
      pageId: args.pageId,
      locale: args.locale,
      draftGeneration,
      sharedDraftGeneration,
      updatedAt: now,
      removedTitleLinks: converted.reports,
      ...(addressNotices.length ? { addressNotices } : {}),
    }
  },
})

export const saveSharedDraft = mutation({
  args: {
    pageId: v.id("pages"),
    expectedSharedDraftGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
    sharedFieldsJson: v.optional(v.string()),
    seo: v.optional(seoValidator),
    template: v.optional(v.string()),
    parentId: v.optional(v.id("pages")),
    clearParent: v.optional(v.boolean()),
    siblingOrder: v.optional(v.number()),
    showOnHomepage: v.optional(v.boolean()),
    displayMode: v.optional(
      v.union(v.literal("card"), v.literal("full"), v.literal("both"))
    ),
    cardImageMediaId: v.optional(v.id("media")),
    cardExcerpt: v.optional(v.string()),
    authorIds: v.optional(v.array(v.id("pages"))),
    tags: v.optional(v.array(v.string())),
  },
  returns: successorGenerationResultValidator,
  handler: async (ctx, args) => {
    const writeOptions: WriteOptions = {}
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    const page = await ctx.db.get("pages", args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    const shared = await oneSharedDraft(ctx, args.pageId)
    if (
      shared.pageType !== page.pageType ||
      shared.generation !== args.expectedSharedDraftGeneration
    ) {
      throw new ConvexError("PAGE_SHARED_DRAFT_STALE")
    }
    // This save rewrites the Shared Draft's old values: copy them into the
    // page's Working Drafts first (once per page).
    await ensurePageBackfilled(ctx, args.pageId, pageState)
    const descriptor = contentTypeDefs[page.pageType]
    const descriptorPatch = parseObjectJson(
      args.sharedFieldsJson,
      "SHARED_FIELDS"
    )
    // A client from before the change may still send the moved category.
    for (const key of MOVED_SHARED_FIELD_KEYS) delete descriptorPatch[key]
    if (args.authorIds !== undefined) {
      descriptorPatch.authorIds = args.authorIds.map((pageId) => ({ pageId }))
    }
    if (args.tags !== undefined) descriptorPatch.tags = args.tags
    const nextDescriptor = mergeSharedDescriptor(
      shared.descriptor as unknown as Record<string, unknown>,
      descriptorPatch,
      descriptor.sharedFields,
      writeOptions
    )
    const systemPatch: Record<string, unknown> = {}
    // The per-language seo values and the card excerpt are no longer shared
    // (ADR-0037 amendment, 2026-11-17); an old client's copies are ignored.
    for (const [key, value] of Object.entries({
      seo: sharedSeoPatch(args.seo as Record<string, unknown> | undefined),
      template: args.template,
      parentId: args.clearParent ? undefined : args.parentId,
      siblingOrder: args.siblingOrder,
      showOnHomepage: args.showOnHomepage,
      displayMode: args.displayMode,
      cardImageMediaId: args.cardImageMediaId,
    }))
      if (value !== undefined) systemPatch[key] = value
    const nextSystem = mergeRecord(
      (shared.system as unknown as Record<string, unknown>) ?? {},
      systemPatch
    )
    if (args.clearParent) delete nextSystem.parentId
    await preflightPageDraftAddresses(ctx, {
      page,
      parentId: (nextSystem.parentId as Id<"pages"> | undefined) ?? null,
    })
    const now = Date.now()
    await occurrenceUsageWrites(ctx).patch("pageSharedDrafts", shared._id, {
      generation: shared.generation + 1,
      system: nextSystem,
      descriptor: nextDescriptor,
      updatedBy: ownerAttribution(owner),
      updatedAt: now,
    } as never)
    await clearSourceReferences(ctx, "shared_draft", shared._id)
    await writeReferences(
      ctx,
      {
        ...page,
        ...Object.fromEntries(
          Object.keys(descriptor.sharedFields).map((key) => [
            key,
            nextDescriptor[key],
          ])
        ),
        ...nextSystem,
        content: {},
      } as Doc<"pages">,
      page._id,
      undefined,
      "shared_draft",
      shared._id,
      shared.generation + 1,
      undefined,
      now
    )
    await recordSharedDraftChange(ctx, args.pageId)
    return { pageId: args.pageId, generation: shared.generation + 1 }
  },
})

export const saveLocaleDraft = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    slug: v.string(),
    addressIntent: v.optional(
      v.union(v.literal("typed"), v.literal("generated"))
    ),
    draft: contentDraftInputValidator,
    expectedDraftGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
    expectedPresentationCatalogRevision: v.optional(v.string()),
  },
  returns: successorGenerationResultValidator,
  handler: async (ctx, args) => {
    const writeOptions: WriteOptions = {}
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    const page = await ctx.db.get("pages", args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    const eligibility = await resolveDraftLocaleEligibility(ctx, args.locale)
    const stateRows = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (stateRows.length > 1) {
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
    }
    if ((stateRows[0]?.draftGeneration ?? 0) !== args.expectedDraftGeneration) {
      throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    }
    if (args.draft.pageType !== page.pageType)
      throw new ConvexError("PAGE_TYPE_MISMATCH")
    // Copy the page's old shared values into its Working Drafts first (once).
    await ensurePageBackfilled(ctx, args.pageId, pageState)
    const descriptor = contentTypeDefs[page.pageType]
    const localized = writeFieldMap(
      descriptor.localizedFields,
      args.draft.localized as unknown as Record<string, unknown>,
      writeOptions
    )
    validateFieldMapRichText(descriptor.localizedFields, localized)
    const hasBlocks = descriptor.capabilities.blockBody
    const incomingBlocks =
      hasBlocks && "blocks" in args.draft
        ? args.draft.blocks.map(
            (block) => writeBlockFields(block, args.locale, writeOptions).value
          )
        : undefined
    if (incomingBlocks) {
      validateUniqueBlockIds(incomingBlocks as readonly Block[])
      validateBlocksRichText(incomingBlocks as readonly Block[])
    }
    const localizedContent: Record<string, unknown> = {}
    for (const key of Object.keys(descriptor.localizedFields)) {
      if (localized[key] !== undefined) localizedContent[key] = localized[key]
    }
    if (incomingBlocks !== undefined) localizedContent.blocks = incomingBlocks
    const existingRows = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (existingRows.length > 1)
      throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
    const presentationBaseline = await presentationWorkingContent(
      ctx,
      page,
      args.locale,
      existingRows[0],
      stateRows[0]
    )
    // The language's own search, social and card values: a save that does not
    // send them keeps the stored ones.
    const content = applyPerLanguageInput(
      localizedContent,
      { seo: args.draft.seo, cardExcerpt: args.draft.cardExcerpt },
      presentationBaseline as Record<string, unknown> | undefined
    )
    const addressPlans = await preflightPageDraftAddresses(ctx, {
      page,
      ...(eligibility.kind === "target"
        ? { source: "transition" as const }
        : {}),
      localized: {
        locale: args.locale,
        slug: args.slug,
        addressIntent:
          eligibility.kind === "target" ? "typed" : args.addressIntent,
      },
    })
    const addressPlan = addressPlans.get(args.locale)!
    const now = Date.now()
    const state =
      stateRows[0] ??
      (await (async () => {
        const stateId = await occurrenceUsageWrites(ctx).insert(
          "pageLocalePublicationStates",
          {
            pageId: args.pageId,
            locale: args.locale,
            draftGeneration: 0,
            publicGeneration: 0,
            releaseGeneration: 0,
            hasCurrentSnapshot: false,
            updatedAt: now,
          }
        )
        const created = await ctx.db.get("pageLocalePublicationStates", stateId)
        if (!created)
          throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
        return created
      })())
    const row = {
      pageId: args.pageId,
      locale: args.locale,
      pageType: page.pageType,
      generation: state.draftGeneration + 1,
      slug: addressPlan.slug,
      addressAllocation: addressPlan.addressAllocation,
      content,
      updatedBy: ownerAttribution(owner),
      createdAt: existingRows[0]?.createdAt ?? now,
      updatedAt: now,
    }
    if (!row.slug) throw new ConvexError("SLUG_REQUIRED")
    await requireBlockMutationsPermitted(
      ctx,
      diffBlockMutations(
        (presentationBaseline !== undefined
          ? { [args.locale]: presentationBaseline }
          : undefined) as Parameters<typeof diffBlockMutations>[0],
        { [args.locale]: content }
      ),
      {
        existingContent:
          presentationBaseline !== undefined
            ? { [args.locale]: presentationBaseline }
            : undefined,
        content: { [args.locale]: content },
        operation: "edit",
        expectedPresentationCatalogRevision:
          args.expectedPresentationCatalogRevision,
      }
    )
    const localeDraftId = existingRows[0]
      ? (await occurrenceUsageWrites(ctx).patch(
          "pageLocaleDrafts", existingRows[0]._id,
          row as never
        ),
        existingRows[0]._id)
      : await occurrenceUsageWrites(ctx).insert(
          "pageLocaleDrafts",
          row as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1]
        )
    await clearSourceReferences(ctx, "locale_draft", localeDraftId)
    await writeReferences(
      ctx,
      { ...page, content: { [args.locale]: content } } as Doc<"pages">,
      page._id,
      args.locale,
      "locale_draft",
      localeDraftId,
      state.draftGeneration + 1,
      undefined,
      now
    )
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
      draftGeneration: state.draftGeneration + 1,
      updatedAt: now,
    })
    if (eligibility.kind === "target") {
      await recordTargetDraftWrite(ctx, eligibility.transition, args.pageId, {
        draftGeneration: state.draftGeneration + 1,
        created: !existingRows[0],
      })
    } else {
      await recordPublicChange(ctx, { pageId: args.pageId, scopes: [] })
    }
    return {
      pageId: args.pageId,
      locale: args.locale,
      generation: state.draftGeneration + 1,
    }
  },
})

/**
 * Real editor transaction: validate and persist the addressed locale Working
 * Draft together with an optional Shared Draft patch. Any reference or media
 * failure rolls the whole form save back.
 */
export const saveEditorDraft = mutation({
  args: {
    pageId: v.id("pages"),
    expectedLifecycleGeneration: v.number(),
    expectedPresentationCatalogRevision: v.optional(v.string()),
    shared: v.optional(
      v.object({
        expectedGeneration: v.number(),
        sharedFieldsJson: v.optional(v.string()),
        seo: v.optional(seoValidator),
        parentId: v.optional(v.id("pages")),
        clearParent: v.optional(v.boolean()),
        authorIds: v.optional(v.array(v.id("pages"))),
        tags: v.optional(v.array(v.string())),
      })
    ),
    localized: v.optional(
      v.object({
        locale: v.string(),
        slug: v.string(),
        addressIntent: v.optional(
          v.union(v.literal("typed"), v.literal("generated"))
        ),
        draft: contentDraftInputValidator,
        expectedGeneration: v.number(),
      })
    ),
  },
  returns: v.object({
    pageId: v.id("pages"),
    locale: v.optional(v.string()),
    draftGeneration: v.optional(v.number()),
    sharedDraftGeneration: v.optional(v.number()),
    updatedAt: v.number(),
    slug: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const writeOptions: WriteOptions = {}
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    if (!args.shared && !args.localized) {
      throw new ConvexError("EDITOR_DRAFT_PATCH_REQUIRED")
    }
    const page = await ctx.db.get("pages", args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    ) {
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    }
    const addressPlans = await preflightPageDraftAddresses(ctx, {
      page,
      ...(args.shared?.clearParent
        ? { parentId: null }
        : args.shared?.parentId
          ? { parentId: args.shared.parentId }
          : {}),
      ...(args.localized ? { localized: args.localized } : {}),
    })
    const descriptor = contentTypeDefs[page.pageType]
    // Copy the page's old shared values into its Working Drafts first (once).
    await ensurePageBackfilled(ctx, args.pageId, pageState)
    const now = Date.now()
    let sharedDraftGeneration: number | undefined
    if (args.shared) {
      const shared = await oneSharedDraft(ctx, args.pageId)
      if (
        shared.pageType !== page.pageType ||
        shared.generation !== args.shared.expectedGeneration
      ) {
        throw new ConvexError("PAGE_SHARED_DRAFT_STALE")
      }
      const descriptorPatch = parseObjectJson(
        args.shared.sharedFieldsJson,
        "SHARED_FIELDS"
      )
      // A client from before the change may still send the moved category.
      for (const key of MOVED_SHARED_FIELD_KEYS) delete descriptorPatch[key]
      if (args.shared.authorIds !== undefined) {
        descriptorPatch.authorIds = args.shared.authorIds.map((pageId) => ({
          pageId,
        }))
      }
      if (args.shared.tags !== undefined)
        descriptorPatch.tags = args.shared.tags
      const nextDescriptor = mergeSharedDescriptor(
        shared.descriptor as unknown as Record<string, unknown>,
        descriptorPatch,
        descriptor.sharedFields,
        writeOptions
      )
      const nextSystem = mergeRecord(
        (shared.system as unknown as Record<string, unknown>) ?? {},
        Object.fromEntries(
          Object.entries({
            // The moved per-language seo values are ignored here.
            seo: sharedSeoPatch(
              args.shared.seo as Record<string, unknown> | undefined
            ),
            parentId: args.shared.clearParent
              ? undefined
              : args.shared.parentId,
          }).filter(([, value]) => value !== undefined)
        )
      )
      if (args.shared.clearParent) delete nextSystem.parentId
      sharedDraftGeneration = shared.generation + 1
      await occurrenceUsageWrites(ctx).patch("pageSharedDrafts", shared._id, {
        generation: sharedDraftGeneration,
        descriptor: nextDescriptor,
        system: nextSystem,
        updatedBy: ownerAttribution(owner),
        updatedAt: now,
      } as never)
      await clearSourceReferences(ctx, "shared_draft", shared._id)
      await writeReferences(
        ctx,
        {
          ...page,
          ...Object.fromEntries(
            Object.keys(descriptor.sharedFields).map((key) => [
              key,
              nextDescriptor[key],
            ])
          ),
          ...nextSystem,
          content: {},
        } as Doc<"pages">,
        page._id,
        undefined,
        "shared_draft",
        shared._id,
        sharedDraftGeneration,
        undefined,
        now
      )
      await recordSharedDraftChange(ctx, args.pageId)
    }

    let locale: string | undefined
    let draftGeneration: number | undefined
    if (args.localized) {
      locale = args.localized.locale
      await assertOrdinaryLocale(ctx, locale)
      const [stateRows, existingRows] = await Promise.all([
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", args.pageId).eq("locale", args.localized!.locale)
          )
          .take(2),
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", args.pageId).eq("locale", args.localized!.locale)
          )
          .take(2),
      ])
      if (stateRows.length > 1 || existingRows.length > 1) {
        throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
      }
      if (
        (stateRows[0]?.draftGeneration ?? 0) !==
        args.localized.expectedGeneration
      ) {
        throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
      }
      if (args.localized.draft.pageType !== page.pageType) {
        throw new ConvexError("PAGE_TYPE_MISMATCH")
      }
      const localized = writeFieldMap(
        descriptor.localizedFields,
        args.localized.draft.localized as unknown as Record<string, unknown>,
        writeOptions
      )
      validateFieldMapRichText(descriptor.localizedFields, localized)
      const incomingBlocks =
        descriptor.capabilities.blockBody && "blocks" in args.localized.draft
          ? args.localized.draft.blocks.map(
              (block) =>
                writeBlockFields(block, args.localized!.locale, writeOptions)
                  .value
            )
          : undefined
      if (incomingBlocks) {
        validateUniqueBlockIds(incomingBlocks as readonly Block[])
        validateBlocksRichText(incomingBlocks as readonly Block[])
      }
      const localizedContent: Record<string, unknown> = {}
      for (const key of Object.keys(descriptor.localizedFields)) {
        if (localized[key] !== undefined) localizedContent[key] = localized[key]
      }
      if (incomingBlocks !== undefined) localizedContent.blocks = incomingBlocks
      const slug = addressPlans.get(locale)?.slug ?? args.localized.slug.trim()
      if (!slug) throw new ConvexError("SLUG_REQUIRED")
      const presentationBaseline = await presentationWorkingContent(
        ctx,
        page,
        locale,
        existingRows[0],
        stateRows[0]
      )
      // The language's own search, social and card values: a save that does
      // not send them keeps the stored ones.
      const content = applyPerLanguageInput(
        localizedContent,
        {
          seo: args.localized.draft.seo,
          cardExcerpt: args.localized.draft.cardExcerpt,
        },
        presentationBaseline as Record<string, unknown> | undefined
      )
      await requireBlockMutationsPermitted(
        ctx,
        diffBlockMutations(
          (presentationBaseline !== undefined
            ? { [locale]: presentationBaseline }
            : undefined) as Parameters<typeof diffBlockMutations>[0],
          { [locale]: content }
        ),
        {
          existingContent:
            presentationBaseline !== undefined
              ? { [locale]: presentationBaseline }
              : undefined,
          content: { [locale]: content },
          operation: "edit",
          expectedPresentationCatalogRevision:
            args.expectedPresentationCatalogRevision,
        }
      )
      const state =
        stateRows[0] ??
        (await (async () => {
          const stateId = await occurrenceUsageWrites(ctx).insert(
            "pageLocalePublicationStates",
            {
              pageId: args.pageId,
              locale,
              draftGeneration: 0,
              publicGeneration: 0,
              releaseGeneration: 0,
              hasCurrentSnapshot: false,
              updatedAt: now,
            }
          )
          const created = await ctx.db.get("pageLocalePublicationStates", stateId)
          if (!created)
            throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
          return created
        })())
      draftGeneration = state.draftGeneration + 1
      const row = {
        pageId: args.pageId,
        locale,
        pageType: page.pageType,
        generation: draftGeneration,
        slug,
        addressAllocation: addressPlans.get(locale)?.addressAllocation,
        content,
        updatedBy: ownerAttribution(owner),
        createdAt: existingRows[0]?.createdAt ?? now,
        updatedAt: now,
      }
      const localeDraftId = existingRows[0]
        ? (await occurrenceUsageWrites(ctx).patch(
            "pageLocaleDrafts", existingRows[0]._id,
            row as never
          ),
          existingRows[0]._id)
        : await occurrenceUsageWrites(ctx).insert(
            "pageLocaleDrafts",
            row as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1]
          )
      await clearSourceReferences(ctx, "locale_draft", localeDraftId)
      await writeReferences(
        ctx,
        { ...page, content: { [locale]: content } } as Doc<"pages">,
        page._id,
        locale,
        "locale_draft",
        localeDraftId,
        draftGeneration,
        undefined,
        now
      )
      await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
        draftGeneration,
        updatedAt: now,
      })
      await recordPublicChange(ctx, { pageId: args.pageId, scopes: [] })
    }
    return {
      pageId: args.pageId,
      ...(locale ? { locale } : {}),
      ...(draftGeneration !== undefined ? { draftGeneration } : {}),
      ...(sharedDraftGeneration !== undefined ? { sharedDraftGeneration } : {}),
      updatedAt: now,
      ...(args.localized &&
      addressPlans.get(args.localized.locale)?.slug !==
        args.localized.slug.trim()
        ? { slug: addressPlans.get(args.localized.locale)!.slug }
        : {}),
    }
  },
})

export const discardLocaleDraft = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    expectedDraftGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
  },
  returns: successorGenerationResultValidator,
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    await requireOperationAccess(ctx)
    const eligibility = await resolveDraftLocaleEligibility(ctx, args.locale)
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    const state = await oneLocaleState(ctx, args.pageId, args.locale)
    if (state.draftGeneration !== args.expectedDraftGeneration)
      throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    const rows = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (rows.length > 1) throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
    if (rows[0] && state.draftBaseSnapshotId) {
      const page = await ctx.db.get("pages", args.pageId)
      const base = page
        ? await verifiedDraftBase(ctx, page, args.locale, state)
        : undefined
      if (page && base)
        await preflightPageDraftAddresses(ctx, {
          page,
          localized: { locale: args.locale, slug: base.payload.localized.slug },
        })
    }
    if (rows[0]) {
      await clearSourceReferences(ctx, "locale_draft", rows[0]._id)
      await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", rows[0]._id)
    }
    const now = Date.now()
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
      draftGeneration: state.draftGeneration + 1,
      updatedAt: now,
    })
    if (eligibility.kind === "target") {
      await recordTargetDraftWrite(ctx, eligibility.transition, args.pageId, {
        draftGeneration: state.draftGeneration + 1,
        created: false,
      })
    } else {
      await recordPublicChange(ctx, { pageId: args.pageId, scopes: [] })
    }
    return {
      pageId: args.pageId,
      locale: args.locale,
      generation: state.draftGeneration + 1,
    }
  },
})

export const deleteLocaleContent = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    expectedDraftGeneration: v.number(),
    expectedPublicGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
  },
  returns: successorGenerationResultValidator,
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    await requireOperationAccess(ctx)
    const pageState = await onePageState(ctx, args.pageId)
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    // F09 invariant 3: the open target locale is never accepted here.
    await assertOrdinaryLocale(ctx, args.locale)
    const state = await oneLocaleState(ctx, args.pageId, args.locale)
    if (
      state.draftGeneration !== args.expectedDraftGeneration ||
      state.publicGeneration !== args.expectedPublicGeneration
    )
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
    if (state.hasCurrentSnapshot || state.currentSnapshotId)
      throw new ConvexError("LOCALE_MUST_BE_WITHDRAWN")
    const openReleases = await Promise.all(
      (["pending", "held"] as const).map((status) =>
        ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_pageId_and_locale_and_status", (q) =>
            q
              .eq("pageId", args.pageId)
              .eq("locale", args.locale)
              .eq("status", status)
          )
          .take(1)
      )
    )
    if (openReleases.some((rows) => rows.length > 0))
      throw new ConvexError("LOCALE_HAS_PENDING_RELEASE")
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (drafts.length > 1) throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
    if (drafts[0]) {
      await clearSourceReferences(ctx, "locale_draft", drafts[0]._id)
      await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", drafts[0]._id)
    }
    const now = Date.now()
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
      draftBaseSnapshotId: undefined,
      draftGeneration: state.draftGeneration + 1,
      updatedAt: now,
    })
    // No M05 domain: the locale must already be withdrawn, so this never clears
    // a selection (ledger C2b.1).
    await recordPublicChange(ctx, { pageId: args.pageId, scopes: [] })
    return {
      pageId: args.pageId,
      locale: args.locale,
      generation: state.draftGeneration + 1,
    }
  },
})

/**
 * Atomically captures one Working Draft + Shared Draft and advances exactly
 * one Page+locale selector. This path deliberately has no Team import or
 * Team-table read: Community publication is a zero-participant policy path.
 */
export const publishLocale = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    expectedDraftGeneration: v.number(),
    expectedSharedDraftGeneration: v.number(),
    expectedPublicGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
    expectedReleaseGeneration: v.number(),
  },
  returns: publicationResultValidator,
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    // F09 invariant 3: the locale gate runs before any draft or generation
    // check, so a hidden target is refused even when a target draft exists.
    const { settings } = await assertOrdinaryLocale(
      ctx,
      args.locale,
      "PUBLICATION_LOCALE_CONFIG_INVALID"
    )

    const page = await ctx.db.get("pages", args.pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    // ADR-0037 amendment (2026-11-17): a content type switched to one
    // language is not published into another language. Withdraw, delete and
    // draft saves stay allowed.
    await assertPageTypeTranslatedIn(
      ctx,
      { pageId: page._id, pageType: page.pageType },
      args.locale,
      settings
    )

    const pageStateRows = await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
      .take(2)
    if (
      pageStateRows.length !== 1 ||
      pageStateRows[0]!.lifecycleState !== "active" ||
      pageStateRows[0]!.lifecycleGeneration !== args.expectedLifecycleGeneration
    ) {
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    }
    const pageState = pageStateRows[0]!
    // Publication writes the new snapshot without the old shared values:
    // copy them into the page's Working Drafts first (once per page).
    await ensurePageBackfilled(ctx, args.pageId, pageState)

    const sharedRows = await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
      .take(2)
    if (
      sharedRows.length !== 1 ||
      sharedRows[0]!.pageType !== page.pageType ||
      sharedRows[0]!.generation !== args.expectedSharedDraftGeneration
    ) {
      throw new ConvexError("PAGE_SHARED_DRAFT_STALE")
    }
    const shared = sharedRows[0]!
    const localeState = await oneLocaleState(ctx, args.pageId, args.locale)
    if (
      localeState.hasCurrentSnapshot !==
      (localeState.currentSnapshotId !== undefined)
    )
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
    if (
      localeState.draftGeneration !== args.expectedDraftGeneration ||
      localeState.publicGeneration !== args.expectedPublicGeneration ||
      localeState.releaseGeneration !== args.expectedReleaseGeneration
    ) {
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
    }
    if (localeState.currentReleaseId) {
      const currentRelease = await ctx.db.get("pageLocalePublicationReleases", localeState.currentReleaseId)
      if (
        currentRelease &&
        (currentRelease.status === "pending" ||
          currentRelease.status === "held")
      ) {
        throw new ConvexError("PAGE_LOCALE_RELEASE_REPLACEMENT_REQUIRED")
      }
    }
    const draftRows = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (
      draftRows.length > 1 ||
      (draftRows[0] &&
        (draftRows[0].pageType !== page.pageType ||
          draftRows[0].generation !== localeState.draftGeneration))
    ) {
      throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    }
    // Publication removes the exact Working Draft. Shared-only editor saves
    // leave its verified base intact; consume that same baseline without a
    // second persistent restaging path or a change to the locale's clock.
    const base = draftRows[0]
      ? undefined
      : await verifiedDraftBase(ctx, page, args.locale, localeState)
    if (!draftRows[0] && !base) throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    const sourceDraft = draftRows[0] ?? {
      _id: localeState.draftBaseSnapshotId!,
      generation: localeState.draftGeneration,
      slug: base!.payload.localized.slug,
      content: base!.payload.localized
        .content as Doc<"pageLocaleDrafts">["content"],
    }
    const sourceVersion = draftRows[0]
      ? sourceDraft.generation
      : (await ctx.db.get("pagePublishedSnapshots", localeState.draftBaseSnapshotId!))!.candidateDigest
    const draft = {
      ...sourceDraft,
      content: writeLocaleContent(
        page.pageType,
        sourceDraft.content as unknown as Record<string, unknown>,
        args.locale,
        {
          readLegacyShapes: true,
          trustedSource: {
            recordId: sourceDraft._id,
            version: sourceVersion,
            content: { [args.locale]: sourceDraft.content },
          },
        }
      ).value as typeof sourceDraft.content,
    }

    await requireBlockMutationsPermitted(
      ctx,
      diffBlockMutations(
        { [args.locale]: sourceDraft.content },
        { [args.locale]: draft.content }
      ),
      {
        existingContent: { [args.locale]: draft.content },
        content: { [args.locale]: draft.content },
        operation: "publish",
      }
    )
    if (!settings.homePageId) {
      throw new ConvexError("PUBLICATION_LOCALE_CONFIG_INVALID")
    }
    const ancestry = await captureAncestry(
      ctx,
      args.pageId,
      (shared.system as { parentId?: Id<"pages"> }).parentId,
      args.locale
    )
    if (
      settings.homePageId === page._id &&
      ((shared.system as { parentId?: Id<"pages"> }).parentId ||
        ancestry.length > 0)
    ) {
      throw new ConvexError("PUBLICATION_HOME_MUST_BE_ROOT")
    }
    const path = await futurePageAddress(ctx, {
      pageId: args.pageId,
      pageType: page.pageType,
      locale: args.locale,
      slug: draft.slug,
      parentId: shared.system.parentId,
      homePageId: settings.homePageId,
    })
    const addressCache = new Map<string, Promise<unknown>>([
      ["home", Promise.resolve(settings.homePageId)],
      [`lifecycle:${page._id}`, Promise.resolve(pageState)],
      [`parent:${page._id}`, Promise.resolve(shared.system.parentId)],
    ])
    refusePageAddress(
      await checkPageAddress(ctx, {
        pageId: args.pageId,
        pageType: page.pageType,
        locale: args.locale,
        slug: draft.slug,
        parentId: shared.system.parentId,
        homePageId: settings.homePageId,
        path: path ?? undefined,
        cache: addressCache,
      }),
      "publish"
    )
    if (path !== null)
      await historicalPathNeedsReservation(
        ctx,
        args.pageId,
        args.locale,
        path,
        addressCache
      )
    await recheckPublishedChildren(
      ctx,
      page,
      args.locale,
      path,
      localeState.currentPath,
      String(draft.content.title ?? page.slug),
      addressCache
    )

    const publishedAt = Date.now()
    const snapshotSource = {
      _id: page._id,
      _creationTime: page._creationTime,
      pageType: page.pageType,
      ...shared.descriptor,
      ...shared.system,
      status: "published" as const,
      slug: draft.slug,
      content: { [args.locale]: draft.content },
      updatedAt: publishedAt,
      publishedAt,
    }
    const payload = buildPayload(
      page,
      shared as unknown as Record<string, unknown>,
      args.locale,
      draft.slug,
      draft.content as unknown as Record<string, unknown>,
      path,
      ancestry
    )
    const { payloadJson, payloadBytes } =
      serializeLocalePublicationCandidate(payload)
    const candidateDigestValue =
      await digestLocalePublicationCandidate(payloadJson)
    const attribution = ownerAttribution(owner)
    const candidateId = await occurrenceUsageWrites(ctx).insert(
      "pageLocalePublicationCandidates",
      {
        pageId: args.pageId,
        locale: args.locale,
        pageType: page.pageType,
        sourceDraftGeneration: draft.generation,
        sourceSharedDraftGeneration: shared.generation,
        sourcePublicGeneration: localeState.publicGeneration,
        sourceLifecycleGeneration: pageState.lifecycleGeneration,
        attribution,
        formatVersion: 1,
        payloadJson,
        payloadBytes,
        digest: candidateDigestValue,
        createdAt: publishedAt,
      }
    )
    const persistedCandidate = await ctx.db.get("pageLocalePublicationCandidates", candidateId)
    const frozenPayload = persistedCandidate
      ? await reconstructLocalePublicationCandidate(persistedCandidate)
      : null
    if (
      !persistedCandidate ||
      persistedCandidate.digest !== candidateDigestValue ||
      !frozenPayload
    )
      throw new ConvexError("PUBLISHED_SNAPSHOT_CANDIDATE_INTEGRITY_INVALID")
    await writeReferences(
      ctx,
      snapshotSource as unknown as Doc<"pages">,
      args.pageId,
      args.locale,
      "candidate",
      candidateId,
      draft.generation,
      candidateDigestValue,
      publishedAt,
      payload.route.kind === "routable" ? payload.route.ancestry : []
    )
    const releaseId = await ctx.db.insert("pageLocalePublicationReleases", {
      pageId: args.pageId,
      locale: args.locale,
      candidateId,
      generation: localeState.releaseGeneration + 1,
      expectedPublicGeneration: localeState.publicGeneration,
      expectedLifecycleGeneration: pageState.lifecycleGeneration,
      status: "published",
      executeAt: publishedAt,
      attribution,
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    await runPublicationPolicy(ctx, INSTALLED_PUBLICATION_POLICY, {
      pageId: args.pageId,
      locale: args.locale,
      pageType: page.pageType,
      candidateId,
      candidateDigest: candidateDigestValue,
      releaseId,
      sourceDraftGeneration: draft.generation,
      sourceSharedDraftGeneration: shared.generation,
      sourcePublicGeneration: localeState.publicGeneration,
      sourceLifecycleGeneration: pageState.lifecycleGeneration,
      payload: frozenPayload,
      attribution,
      requestedAt: publishedAt,
    })
    const snapshotId = await occurrenceUsageWrites(ctx).insert(
      "pagePublishedSnapshots",
      {
        pageId: args.pageId,
        locale: args.locale,
        generation: localeState.publicGeneration + 1,
        candidateId,
        candidateDigest: candidateDigestValue,
        sourceDraftGeneration: draft.generation,
        sourceSharedDraftGeneration: shared.generation,
        sourcePublicGeneration: localeState.publicGeneration,
        sourceLifecycleGeneration: pageState.lifecycleGeneration,
        releaseId,
        publishedAt,
        attribution,
      }
    )
    await ctx.db.patch("pageLocalePublicationReleases", releaseId, {
      publishedSnapshotId: snapshotId,
      publishedAt,
      updatedAt: publishedAt,
    })
    await clearCurrentReferences(ctx, args.pageId, args.locale)
    await writeReferences(
      ctx,
      snapshotSource as unknown as Doc<"pages">,
      args.pageId,
      args.locale,
      "current_public",
      snapshotId,
      localeState.publicGeneration + 1,
      candidateDigestValue,
      publishedAt,
      payload.route.kind === "routable" ? payload.route.ancestry : []
    )
    if (
      localeState.currentPath &&
      localeState.currentPath !== path &&
      localeState.currentSnapshotId
    ) {
      if (
        await historicalPathNeedsReservation(
          ctx,
          args.pageId,
          args.locale,
          localeState.currentPath,
          addressCache
        )
      ) {
        await ctx.db.insert("pageHistoricalLocaleRoutes", {
          pageId: args.pageId,
          locale: args.locale,
          fromPath: localeState.currentPath,
          createdFromSnapshotId: localeState.currentSnapshotId,
          createdAt: publishedAt,
        })
      }
    }
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", localeState._id, {
      draftBaseSnapshotId: snapshotId,
      publicGeneration: localeState.publicGeneration + 1,
      releaseGeneration: localeState.releaseGeneration + 1,
      // This pointer is reserved for a pending/held scheduled release. The
      // immutable snapshot already owns the terminal release linkage.
      currentReleaseId: undefined,
      currentSnapshotId: snapshotId,
      hasCurrentSnapshot: true,
      ...currentSnapshotIndexFields(localeState, {
        pageType: payload.page.pageType,
        firstPublicAt: localeState.hasCurrentSnapshot
          ? (page.publishedAt ?? localeState.currentPublishedAt ?? publishedAt)
          : publishedAt,
      }),
      ...(path === null ? { currentPath: undefined } : { currentPath: path }),
      currentPublishedAt: publishedAt,
      updatedAt: publishedAt,
    })
    await insertRevalidationIntent(ctx, {
      operationId: `publish:${snapshotId}`,
      operationKind: localeState.hasCurrentSnapshot ? "republish" : "publish",
      pageId: args.pageId,
      locale: args.locale,
      ...(localeState.currentSnapshotId
        ? { oldSnapshotId: localeState.currentSnapshotId }
        : {}),
      newSnapshotId: snapshotId,
      oldPublicGeneration: localeState.publicGeneration,
      newPublicGeneration: localeState.publicGeneration + 1,
      ...(localeState.currentPath ? { oldPath: localeState.currentPath } : {}),
      ...(path ? { newPath: path } : {}),
      phase: "self",
      status: "pending",
      attempts: 0,
      createdAt: publishedAt,
      updatedAt: publishedAt,
    })
    // The source draft is the exact candidate generation, so this cleanup
    // cannot touch another locale or a later save.
    if (draftRows[0]) {
      await clearSourceReferences(ctx, "locale_draft", draftRows[0]._id)
      await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", draftRows[0]._id)
    }
    // Step 10: optional History/Search run last; a throw rolls back all of it.
    await runPublicationContributions(
      ctx,
      INSTALLED_PUBLICATION_CONTRIBUTIONS,
      {
        kind: "publish",
        pageId: args.pageId,
        locale: args.locale,
        snapshotId,
        ...(localeState.currentSnapshotId
          ? { previousSnapshotId: localeState.currentSnapshotId }
          : {}),
        publicGeneration: localeState.publicGeneration + 1,
        path,
        ...(localeState.currentPath
          ? { previousPath: localeState.currentPath }
          : {}),
        payload: frozenPayload,
        attribution,
        occurredAt: publishedAt,
      }
    )
    const authorityRows = await recordPublicChange(ctx, {
      pageId: args.pageId,
      scopes: [{ locale: args.locale, domains: BOTH_FRESHNESS_DOMAINS }],
    })
    if (path !== null && path !== localeState.currentPath) {
      await retireContinuityRowForClaim(ctx, authorityRows, {
        locale: args.locale,
        path,
        retiredAt: publishedAt,
        retiredReason: "to_current",
      })
    }
    if (
      localeState.currentPath &&
      localeState.currentPath !== path &&
      localeState.currentSnapshotId
    ) {
      await retireContinuityRowForClaim(ctx, authorityRows, {
        locale: args.locale,
        path: localeState.currentPath,
        retiredAt: publishedAt,
        retiredReason: "to_historical",
      })
    }
    return {
      pageId: args.pageId,
      locale: args.locale,
      snapshotId,
      candidateId,
      publicGeneration: localeState.publicGeneration + 1,
      publishedAt,
    }
  },
})

export const withdrawLocale = mutation({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    expectedSnapshotId: v.id("pagePublishedSnapshots"),
    expectedPublicGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
  },
  returns: withdrawalResultValidator,
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    const owner = await requireOperationAccess(ctx)
    // F09 invariant 3: a hidden prepared target is withdrawn only through
    // `withdrawPreparedTargetLocale`, never here.
    const { settings } = await assertOrdinaryLocale(ctx, args.locale)
    const pageStateRows = await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
      .take(2)
    if (
      pageStateRows.length !== 1 ||
      pageStateRows[0]!.lifecycleGeneration !== args.expectedLifecycleGeneration
    ) {
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    }
    // A trashed Page being purged must not gain a new revalidation intent.
    await assertNoPagePurge(ctx, args.pageId)
    const state = await oneLocaleState(ctx, args.pageId, args.locale)
    if (
      !state.hasCurrentSnapshot ||
      state.currentSnapshotId !== args.expectedSnapshotId ||
      state.publicGeneration !== args.expectedPublicGeneration
    ) {
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
    }
    // Only current_public rows in this language matter: the loop below skips
    // every other source kind and language, and old candidate rows pile up.
    const inbound = await ctx.db
      .query("pagePublicationDocumentReferences")
      .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
        q
          .eq("targetId", args.pageId)
          .eq("sourceKind", "current_public")
          .eq("locale", args.locale)
      )
      .take(513)
    if (inbound.length > 512) {
      throw new ConvexError("PAGE_ANCESTRY_REFERENCE_LIMIT")
    }
    for (const ref of inbound) {
      if (
        ref.sourceKind !== "current_public" ||
        ref.referenceKind !== "ancestry" ||
        ref.targetLocale !== args.locale ||
        ref.locale !== args.locale
      )
        continue
      const sourceState = await oneLocaleState(ctx, ref.pageId, args.locale)
      if (
        sourceState.hasCurrentSnapshot &&
        sourceState.currentSnapshotId === ref.sourceId
      ) {
        throw new ConvexError("PAGE_ANCESTRY_IN_USE")
      }
    }
    const page = await ctx.db.get("pages", args.pageId)
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", args.pageId).eq("locale", args.locale)
      )
      .take(2)
    if (drafts.length > 1) throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
    if (page && !drafts.some((row) => row.locale === args.locale)) {
      const base = await verifiedDraftBase(ctx, page, args.locale, state)
      if (base)
        await preflightPageDraftAddresses(ctx, {
          page,
          drafts,
          localeState: state,
          homePageId: settings.homePageId,
          cache: new Map([
            [`lifecycle:${args.pageId}`, Promise.resolve(pageStateRows[0]!)],
          ]),
          localized: { locale: args.locale, slug: base.payload.localized.slug },
        })
    }
    const now = Date.now()
    await clearCurrentReferences(ctx, args.pageId, args.locale)
    await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
      publicGeneration: state.publicGeneration + 1,
      currentSnapshotId: undefined,
      currentReleaseId: undefined,
      hasCurrentSnapshot: false,
      ...currentSnapshotIndexFields(state, null),
      currentPath: undefined,
      currentPublishedAt: undefined,
      updatedAt: now,
    })
    await insertRevalidationIntent(ctx, {
      operationId: `withdraw:${args.expectedSnapshotId}`,
      operationKind: "withdraw",
      pageId: args.pageId,
      locale: args.locale,
      oldSnapshotId: args.expectedSnapshotId,
      oldPublicGeneration: state.publicGeneration,
      newPublicGeneration: state.publicGeneration + 1,
      ...(state.currentPath ? { oldPath: state.currentPath } : {}),
      phase: "self",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
    await runPublicationContributions(
      ctx,
      INSTALLED_PUBLICATION_CONTRIBUTIONS,
      {
        kind: "withdraw",
        pageId: args.pageId,
        locale: args.locale,
        withdrawnSnapshotId: args.expectedSnapshotId,
        publicGeneration: state.publicGeneration + 1,
        ...(state.currentPath ? { previousPath: state.currentPath } : {}),
        attribution: ownerAttribution(owner),
        occurredAt: now,
      }
    )
    await recordPublicChange(ctx, {
      pageId: args.pageId,
      scopes: [{ locale: args.locale, domains: BOTH_FRESHNESS_DOMAINS }],
    })
    return {
      pageId: args.pageId,
      locale: args.locale,
      publicGeneration: state.publicGeneration + 1,
    }
  },
})

// One mutation may insert several revalidation intents (every locale of a
// lifecycle change). Schedule the immediate drain once per mutation context so
// the public site refreshes now instead of at the next cron tick. Scheduling
// commits with the insert, so a rolled-back mutation schedules nothing. The
// 1-minute cron stays as the safety net.
const drainScheduledFor = new WeakSet<object>()

async function insertRevalidationIntent(
  ctx: MutationCtx,
  intent: WithoutSystemFields<Doc<"pagePublicationRevalidationIntents">>
): Promise<void> {
  await ctx.db.insert("pagePublicationRevalidationIntents", intent)
  if (drainScheduledFor.has(ctx)) return
  drainScheduledFor.add(ctx)
  await ctx.scheduler.runAfter(
    0,
    internal.cms.revalidate.drainPublicationRevalidationIntents,
    {}
  )
}

async function recordLifecycleIntents(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  operationKind: "archive" | "restore" | "soft_delete" | "restore_soft_deleted",
  states: Array<Doc<"pageLocalePublicationStates">>,
  now: number
): Promise<void> {
  for (const state of states) {
    const operationId = `${operationKind}:${pageId}:${state.locale}:${state.publicGeneration}:${now}`
    await insertRevalidationIntent(ctx, {
      operationId,
      operationKind,
      pageId,
      locale: state.locale,
      ...(state.currentSnapshotId
        ? { oldSnapshotId: state.currentSnapshotId }
        : {}),
      oldPublicGeneration: state.publicGeneration,
      newPublicGeneration: state.publicGeneration,
      ...(state.currentPath ? { oldPath: state.currentPath } : {}),
      phase: "self",
      status: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    })
  }
}

const PAGE_SOFT_DELETE_DETAIL_LIMIT = 3
const PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT = 512

export async function assertSnapshotPageSoftDeleteAllowed(
  ctx: PublicationCtx,
  pageId: Id<"pages">
): Promise<void> {
  const menuReferences = await ctx.db
    .query("menuReferences")
    .withIndex("by_target", (q) => q.eq("targetId", pageId))
    .take(PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT + 1)
  const menuIds = Array.from(
    new Set(
      menuReferences
        .slice(0, PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT)
        .map((reference) => reference.menuId)
    )
  )
  const liveMenus = (await Promise.all(menuIds.map((id) => ctx.db.get("menus", id))))
    .filter(
      (menu): menu is Doc<"menus"> =>
        menu !== null && menu.deletedAt === undefined
    )
    .sort((a, b) => a.slug.localeCompare(b.slug) || a._id.localeCompare(b._id))
  const menuReadTruncated =
    menuReferences.length > PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT
  if (liveMenus.length > 0 || menuReadTruncated) {
    throw new ConvexError({
      code: "PAGE_SOFT_DELETE_MENU_REFERENCE",
      menus: liveMenus
        .slice(0, PAGE_SOFT_DELETE_DETAIL_LIMIT)
        .map((menu) => ({ menuId: menu._id, slug: menu.slug })),
      truncated:
        liveMenus.length > PAGE_SOFT_DELETE_DETAIL_LIMIT || menuReadTruncated,
    })
  }

  const target = await ctx.db.get("pages", pageId)
  if (!target) return
  // The pages whose descriptor relates to this page's type (a post's byline
  // points at an author). The error code and `posts` key keep their original
  // names: the admin messages read them.
  const referrerTypes = referrerContentTypes(target.pageType)
  if (referrerTypes.size === 0) return
  const currentReferences = await ctx.db
    .query("pagePublicationDocumentReferences")
    .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
      q.eq("targetId", pageId).eq("sourceKind", "current_public")
    )
    .take(PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT + 1)
  // A page that references itself (a self-relation) goes away with its own
  // references, so its own rows never block it.
  const boundedCurrentReferences = currentReferences
    .slice(0, PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT)
    .filter((reference) => reference.sourceKind === "current_public")
    .filter((reference) => reference.pageId !== pageId)
  const sourceIds = Array.from(
    new Set(boundedCurrentReferences.map((reference) => reference.pageId))
  )
  const sourcePages = await Promise.all(sourceIds.map((id) => ctx.db.get("pages", id)))
  const publishedReferrerIds = new Set(
    sourcePages
      .filter(
        (page): page is Doc<"pages"> =>
          page !== null && referrerTypes.has(page.pageType)
      )
      .map((page) => page._id)
  )
  const postReferences = boundedCurrentReferences
    .filter((reference) => publishedReferrerIds.has(reference.pageId))
    .map((reference) => ({
      pageId: reference.pageId,
      locale: reference.locale,
      sourcePath: reference.sourcePath,
    }))
    .sort(
      (a, b) =>
        String(a.pageId).localeCompare(String(b.pageId)) ||
        a.locale.localeCompare(b.locale) ||
        a.sourcePath.localeCompare(b.sourcePath)
    )
  const postReferenceReadTruncated =
    currentReferences.length > PAGE_SOFT_DELETE_REFERENCE_READ_LIMIT
  if (postReferences.length > 0 || postReferenceReadTruncated) {
    throw new ConvexError({
      code: "PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE",
      posts: postReferences.slice(0, PAGE_SOFT_DELETE_DETAIL_LIMIT),
      truncated:
        postReferences.length > PAGE_SOFT_DELETE_DETAIL_LIMIT ||
        postReferenceReadTruncated,
    })
  }
}

async function transitionLifecycle(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  expectedLifecycleGeneration: number,
  next: "archived" | "active" | "trashed",
  expectedCurrent: "active" | "archived" | "trashed",
  operationKind: "archive" | "restore" | "soft_delete" | "restore_soft_deleted"
): Promise<{
  pageId: Id<"pages">
  lifecycleGeneration: number
  addressNotices?: PageAddressNotice[]
}> {
  await requireSnapshotAuthority(ctx)
  const owner = await requireOperationAccess(ctx)
  if (next !== "active") {
    // Raw setting on purpose: resolveEffectiveHomePageId reads stale legacy
    // status. Restoring to active stays allowed.
    const settingsRows = await ctx.db.query("siteSettings").take(2)
    if (settingsRows.length === 1 && settingsRows[0]!.homePageId === pageId) {
      throw new ConvexError("PAGE_HOME_LIFECYCLE_REFUSED")
    }
  }
  const state = await onePageState(ctx, pageId)
  // A Page being permanently deleted never changes lifecycle again.
  await assertNoPagePurge(ctx, pageId)
  if (
    state.lifecycleState !== expectedCurrent ||
    state.lifecycleGeneration !== expectedLifecycleGeneration
  ) {
    throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
  }
  if (operationKind === "soft_delete") {
    await assertSnapshotPageSoftDeleteAllowed(ctx, pageId)
  }
  const localeStates = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(513)
  if (localeStates.length > 512)
    throw new ConvexError("PUBLICATION_LOCALE_LIMIT")
  const addressNotices: PageAddressNotice[] = []
  const restorePlans: Array<{
    state: Doc<"pageLocalePublicationStates">
    draft?: Doc<"pageLocaleDrafts">
    slug: string
    content: Record<string, unknown>
    addressAllocation?: { wantedSlug: string; allocatedSlug: string }
    // Only the draft address was reused; the live address is free, so the
    // language stays published (a draft-only change must not reach public).
    keepLive?: boolean
  }> = []
  const retireHistory: Array<Id<"pageHistoricalLocaleRoutes">> = []
  const releasedLocales = new Set<string>()
  const reactivated: Array<{
    locale: string
    path: string
    retiredReason: "to_current" | "to_historical"
  }> = []
  const cache = new Map<string, Promise<unknown>>([
    [`lifecycle:${pageId}`, Promise.resolve(state)],
  ])
  if (operationKind === "restore_soft_deleted") {
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("PAGE_NOT_FOUND")
    const parentId = await addressSharedParent(ctx, pageId, cache)
    const homePageId = await addressHomePage(ctx, cache)
    const drafts = await addressDraftRows(ctx, pageId)
    for (const localeState of localeStates) {
      const draft = drafts.find((row) => row.locale === localeState.locale)
      const base =
        !draft && localeState.draftBaseSnapshotId
          ? await readFrozenSnapshotProjection(
              ctx,
              localeState.draftBaseSnapshotId,
              pageId,
              localeState.locale
            )
          : null
      const slug = draft?.slug ?? base?.payload.localized.slug
      const input = {
        pageId,
        pageType: page.pageType,
        locale: localeState.locale,
        slug: slug ?? "",
        cache,
        parentId,
        homePageId,
      }
      if (slug) {
        const future = await checkPageAddress(ctx, input)
        const live = localeState.currentPath
          ? await checkPageAddress(ctx, {
              ...input,
              path: localeState.currentPath,
            })
          : future
        const conflict = future.kind !== "free" ? future : live
        if (conflict.kind !== "free") {
          const keepLive =
            live.kind === "free" &&
            Boolean(localeState.currentPath) &&
            localeState.hasCurrentSnapshot
          const allocated = await allocatePageAddress(ctx, input)
          restorePlans.push({
            state: localeState,
            draft,
            slug: allocated.slug,
            content: (draft?.content ??
              base!.payload.localized.content) as Record<string, unknown>,
            ...(allocated.addressAllocation
              ? { addressAllocation: allocated.addressAllocation }
              : {}),
            ...(keepLive ? { keepLive: true } : {}),
          })
          if (conflict.path && allocated.check.path)
            addressNotices.push({
              locale: localeState.locale,
              oldPath: conflict.path,
              newPath: allocated.check.path,
              check: conflict,
              ...(keepLive
                ? { kept: next === "active" ? "published" : "archived" }
                : {}),
            })
        }
        if (
          !restorePlans.some(
            (plan) => plan.state._id === localeState._id && !plan.keepLive
          ) &&
          localeState.currentPath &&
          localeState.hasCurrentSnapshot
        )
          reactivated.push({
            locale: localeState.locale,
            path: localeState.currentPath,
            retiredReason: "to_current",
          })
      }
      const history = ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", localeState.locale)
        )
      for await (const route of history) {
        if (route.releasedAt !== undefined) continue
        if (
          (await checkPageAddress(ctx, { ...input, path: route.fromPath }))
            .kind !== "free"
        ) {
          retireHistory.push(route._id)
          releasedLocales.add(localeState.locale)
        } else
          reactivated.push({
            locale: localeState.locale,
            path: route.fromPath,
            retiredReason: "to_historical",
          })
      }
    }
  }
  const now = Date.now()
  for (const routeId of retireHistory)
    await ctx.db.patch("pageHistoricalLocaleRoutes", routeId, {
      releasedAt: now,
    })
  for (const plan of restorePlans) {
    const generation = plan.state.draftGeneration + 1
    const row = {
      pageId,
      locale: plan.state.locale,
      pageType: (await ctx.db.get("pages", pageId))!.pageType,
      generation,
      slug: plan.slug,
      content: plan.content,
      addressAllocation: plan.addressAllocation,
      updatedBy: ownerAttribution(owner),
      createdAt: plan.draft?.createdAt ?? now,
      updatedAt: now,
    }
    if (plan.draft)
      await clearSourceReferences(ctx, "locale_draft", plan.draft._id)
    const draftId = plan.draft
      ? (await occurrenceUsageWrites(ctx).patch(
          "pageLocaleDrafts",
          plan.draft._id,
          row as never
        ),
        plan.draft._id)
      : await occurrenceUsageWrites(ctx).insert(
          "pageLocaleDrafts",
          row as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1]
        )
    const page = (await ctx.db.get("pages", pageId))!
    await writeReferences(
      ctx,
      {
        ...page,
        content: { [plan.state.locale]: plan.content },
      } as Doc<"pages">,
      pageId,
      plan.state.locale,
      "locale_draft",
      draftId,
      generation,
      undefined,
      now
    )
    if (plan.keepLive) {
      await occurrenceUsageWrites(ctx).patch(
        "pageLocalePublicationStates",
        plan.state._id,
        { draftGeneration: generation, updatedAt: now }
      )
      continue
    }
    await clearCurrentReferences(ctx, pageId, plan.state.locale)
    await occurrenceUsageWrites(ctx).patch(
      "pageLocalePublicationStates",
      plan.state._id,
      {
        draftGeneration: generation,
        publicGeneration: plan.state.publicGeneration + 1,
        currentSnapshotId: undefined,
        currentReleaseId: undefined,
        hasCurrentSnapshot: false,
        currentPath: undefined,
        currentPublishedAt: undefined,
        ...currentSnapshotIndexFields(plan.state, null),
        updatedAt: now,
      }
    )
  }
  const patch: Record<string, unknown> = {
    lifecycleState: next,
    lifecycleGeneration: state.lifecycleGeneration + 1,
    updatedAt: now,
  }
  if (next === "trashed")
    patch.restoreLifecycleState =
      expectedCurrent === "archived" ? "archived" : "active"
  else patch.restoreLifecycleState = undefined
  await occurrenceUsageWrites(ctx).patch("pagePublicationPageStates", state._id, patch)
  const cancelledReleaseLocales = new Set<string>()
  if (next === "trashed") {
    for (const localeState of localeStates) {
      for (const status of ["pending", "held"] as const) {
        const releases = await ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_pageId_and_locale_and_status", (q) =>
            q
              .eq("pageId", pageId)
              .eq("locale", localeState.locale)
              .eq("status", status)
          )
          .take(513)
        if (releases.length > 512)
          throw new ConvexError("PUBLICATION_RELEASE_LIMIT")
        for (const release of releases) {
          cancelledReleaseLocales.add(localeState.locale)
          await ctx.db.patch("pageLocalePublicationReleases", release._id, {
            status: "cancelled",
            cancelledAt: now,
            cancelReason: "PAGE_SOFT_DELETED",
            updatedAt: now,
          })
        }
      }
    }
  }
  await recordLifecycleIntents(ctx, pageId, operationKind, localeStates, now)
  await runPublicationContributions(ctx, INSTALLED_PUBLICATION_CONTRIBUTIONS, {
    kind: "lifecycle",
    pageId,
    operation: operationKind,
    lifecycleGeneration: state.lifecycleGeneration + 1,
    locales: localeStates.map((localeState) => localeState.locale),
    attribution: ownerAttribution(owner),
    occurredAt: now,
  })
  // M05 domains A and B: every locale with a selection, plus publication-set
  // for every locale whose pending or held release was cancelled.
  const authorityRows = await recordPublicChange(ctx, {
    pageId,
    scopes: [
      ...localeStates
        .filter((localeState) => localeState.hasCurrentSnapshot)
        .map((localeState) => ({
          locale: localeState.locale,
          domains: BOTH_FRESHNESS_DOMAINS,
        })),
      ...[...releasedLocales].map((locale) => ({
        locale,
        domains: ["route_claims"] as const,
      })),
      ...[...cancelledReleaseLocales].map((locale) => ({
        locale,
        domains: ["publication_set"] as const,
      })),
    ],
  })
  for (const claim of reactivated) {
    await retireContinuityRowForClaim(ctx, authorityRows, {
      ...claim,
      retiredAt: now,
    })
  }
  return {
    pageId,
    lifecycleGeneration: state.lifecycleGeneration + 1,
    ...(addressNotices.length ? { addressNotices } : {}),
  }
}

export const archivePage = mutation({
  args: { pageId: v.id("pages"), expectedLifecycleGeneration: v.number() },
  returns: v.object({
    pageId: v.id("pages"),
    lifecycleGeneration: v.number(),
    addressNotices: v.optional(v.array(pageAddressNoticeValidator)),
  }),
  handler: (ctx, args) =>
    transitionLifecycle(
      ctx,
      args.pageId,
      args.expectedLifecycleGeneration,
      "archived",
      "active",
      "archive"
    ),
})

export const restorePage = mutation({
  args: { pageId: v.id("pages"), expectedLifecycleGeneration: v.number() },
  returns: v.object({
    pageId: v.id("pages"),
    lifecycleGeneration: v.number(),
    addressNotices: v.optional(v.array(pageAddressNoticeValidator)),
  }),
  handler: (ctx, args) =>
    transitionLifecycle(
      ctx,
      args.pageId,
      args.expectedLifecycleGeneration,
      "active",
      "archived",
      "restore"
    ),
})

export const softDeletePage = mutation({
  args: { pageId: v.id("pages"), expectedLifecycleGeneration: v.number() },
  returns: v.object({
    pageId: v.id("pages"),
    lifecycleGeneration: v.number(),
    addressNotices: v.optional(v.array(pageAddressNoticeValidator)),
  }),
  handler: async (ctx, args) => {
    // Authenticate before reading lifecycle state. Only a live or archived
    // Page may be trashed; re-trashing would overwrite its restore target.
    await requireOperationAccess(ctx)
    await requireSnapshotAuthority(ctx)
    const state = await onePageState(ctx, args.pageId)
    if (
      state.lifecycleState !== "active" &&
      state.lifecycleState !== "archived"
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    return transitionLifecycle(
      ctx,
      args.pageId,
      args.expectedLifecycleGeneration,
      "trashed",
      state.lifecycleState,
      "soft_delete"
    )
  },
})

export const restoreSoftDeletedPage = mutation({
  args: { pageId: v.id("pages"), expectedLifecycleGeneration: v.number() },
  returns: v.object({
    pageId: v.id("pages"),
    lifecycleGeneration: v.number(),
    addressNotices: v.optional(v.array(pageAddressNoticeValidator)),
  }),
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    await requireOperationAccess(ctx)
    const state = await onePageState(ctx, args.pageId)
    if (
      state.lifecycleState !== "trashed" ||
      state.lifecycleGeneration !== args.expectedLifecycleGeneration ||
      !state.restoreLifecycleState
    )
      throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
    return transitionLifecycle(
      ctx,
      args.pageId,
      args.expectedLifecycleGeneration,
      state.restoreLifecycleState,
      "trashed",
      "restore_soft_deleted"
    )
  },
})

// ─── PERMANENT-DELETE: purge of trashed Pages ──────────────────────────────
//
// `purgeTrashedPages` proves the closure for every selected Page and queues the
// ones that pass. One serial worker (`runPagePurgeStep`) then removes the rows
// in bounded batches (`purgePageBatch`). The rules and the phase order live in
// `lib/publishing/pagePurge.ts`.

const purgeReasonValidator = v.union(
  v.literal("children"),
  v.literal("incoming_links"),
  v.literal("menus"),
  v.literal("language_operation"),
  v.literal("not_trashed"),
  v.literal("stale"),
  v.literal("home")
)
const purgeDetailValidator = v.object({
  count: v.optional(v.number()),
  titles: v.optional(v.array(v.string())),
  menus: v.optional(v.array(v.string())),
})

const PURGE_NESTED_LIMITS = {
  bytesRead: 12 * 1024 * 1024,
  bytesWritten: 12 * 1024 * 1024,
  documentsRead: 24_000,
  documentsWritten: 12_000,
  databaseQueries: 3_000,
}

function uniquePurgeEntries<T extends { pageId: Id<"pages"> }>(items: T[]): T[] {
  const seen = new Set<Id<"pages">>()
  return items.filter((item) => !seen.has(item.pageId) && seen.add(item.pageId))
}

export const pagePurgeImpact = query({
  args: { pageIds: v.array(v.id("pages")) },
  returns: v.array(
    v.object({
      pageId: v.id("pages"),
      canPurge: v.boolean(),
      reason: v.optional(purgeReasonValidator),
      detail: v.optional(purgeDetailValidator),
      redirects: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active")
      throw new ConvexError("PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED")
    if (args.pageIds.length > PAGE_PURGE_MAX_BATCH_ITEMS)
      throw new ConvexError("PAGE_PURGE_BATCH_TOO_LARGE")
    const ids = uniquePurgeEntries(args.pageIds.map((pageId) => ({ pageId })))
    const verdicts = await evaluatePurgeSelection(ctx, ids)
    const out = []
    for (const { pageId } of ids) {
      const refusal = verdicts.get(pageId) ?? null
      const redirects = await ctx.db
        .query("redirects")
        .withIndex("by_toPageId", (q) => q.eq("toPageId", pageId))
        .take(1001)
      out.push({
        pageId,
        canPurge: refusal === null,
        ...(refusal
          ? {
              reason: refusal.reason,
              ...(refusal.detail ? { detail: refusal.detail } : {}),
            }
          : {}),
        redirects: Math.min(redirects.length, 1000),
      })
    }
    return out
  },
})

export const purgeTrashedPages = mutation({
  args: {
    items: v.array(
      v.object({
        pageId: v.id("pages"),
        expectedLifecycleGeneration: v.number(),
      })
    ),
  },
  returns: v.array(
    v.object({
      pageId: v.id("pages"),
      status: v.union(v.literal("started"), v.literal("refused")),
      reason: v.optional(purgeReasonValidator),
      detail: v.optional(purgeDetailValidator),
    })
  ),
  handler: async (ctx, args) => {
    await requireSnapshotAuthority(ctx)
    await requireOperationAccess(ctx)
    if (args.items.length > PAGE_PURGE_MAX_BATCH_ITEMS)
      throw new ConvexError("PAGE_PURGE_BATCH_TOO_LARGE")
    const items = uniquePurgeEntries(args.items)
    const now = Date.now()

    // Every read happens before the first write.
    const verdicts = await evaluatePurgeSelection(
      ctx,
      items.map((item) => ({
        pageId: item.pageId,
        expectedGeneration: item.expectedLifecycleGeneration,
      }))
    )
    const existing = new Map<Id<"pages">, Doc<"pagePurges">>()
    for (const item of items) {
      const marker = await readPagePurgeMarker(ctx, item.pageId)
      if (marker) existing.set(item.pageId, marker)
    }
    const fresh = items.filter(
      (item) => !existing.has(item.pageId) && verdicts.get(item.pageId) === null
    )
    const freshIds = new Set(fresh.map((item) => item.pageId))
    // Children first: a deeper Page is queued before its parent.
    const parentOf = new Map<Id<"pages">, Id<"pages"> | undefined>()
    const prepared = new Map<
      Id<"pages">,
      { slug: string; localizedTitles: Record<string, string> }
    >()
    for (const item of fresh) {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", item.pageId))
        .first()
      const page = await ctx.db.get("pages", item.pageId)
      // The same check `assertActivePageType` makes for ordinary page access.
      if (page && !isActiveContentType(page.pageType))
        throw new ConvexError(
          `Content Type "${page.pageType}" is not active in this starter.`
        )
      parentOf.set(
        item.pageId,
        shared?.system.parentId ?? page?.parentId ?? undefined
      )
      const state = await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", item.pageId))
        .first()
      const row = state ? await snapshotAdminPageRow(ctx, state) : null
      prepared.set(item.pageId, {
        slug: row?.slug ?? page?.slug ?? "",
        localizedTitles: row?.localizedTitles ?? {},
      })
    }
    const depth = (id: Id<"pages">): number => {
      let d = 0
      let cursor = parentOf.get(id)
      const seen = new Set<Id<"pages">>([id])
      while (cursor && freshIds.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor)
        d += 1
        cursor = parentOf.get(cursor)
      }
      return d
    }
    const ordered = fresh
      .map((item, index) => ({ item, index, depth: depth(item.pageId) }))
      .sort((a, b) => b.depth - a.depth || a.index - b.index)
      .map((entry) => entry.item)

    // Markers only: redirects and every other owned row go in worker batches,
    // so a 25-page selection never nears a transaction limit.
    for (const item of ordered) {
      const info = prepared.get(item.pageId)!
      await ctx.db.insert("pagePurges", {
        pageId: item.pageId,
        requestedAt: now,
        phase: PAGE_PURGE_PHASES[0],
        updatedAt: now,
        attempts: 0,
        slug: info.slug,
        localizedTitles: info.localizedTitles,
      })
    }
    // A second call re-queues a purge that stopped after repeated failures.
    // Delete is a request only: no worker starts here. The daily batch
    // (`startQueuedPagePurges`) picks every queued marker up.
    for (const marker of existing.values()) {
      if (marker.stalledAt === undefined) continue
      await ctx.db.patch("pagePurges", marker._id, {
        stalledAt: undefined,
        attempts: 0,
        lastError: undefined,
        waitUntil: undefined,
        updatedAt: now,
      })
    }
    return items.map((item) => {
      if (existing.has(item.pageId))
        return { pageId: item.pageId, status: "started" as const }
      const refusal = verdicts.get(item.pageId)
      if (refusal)
        return {
          pageId: item.pageId,
          status: "refused" as const,
          reason: refusal.reason,
          ...(refusal.detail ? { detail: refusal.detail } : {}),
        }
      return { pageId: item.pageId, status: "started" as const }
    })
  },
})

/** One bounded batch for one Page. Runs nested inside `runPagePurgeStep`. */
export const purgePageBatch = internalMutation({
  args: { pageId: v.id("pages"), phase: v.string(), maxSources: v.number() },
  returns: v.object({
    phase: v.string(),
    finished: v.boolean(),
    hold: v.optional(
      v.object({
        kind: v.union(v.literal("wait"), v.literal("stop")),
        reason: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    if (!(await readPagePurgeMarker(ctx, args.pageId)))
      return { phase: "final", finished: true }
    return runPurgeBatch(ctx, args.pageId, args.phase, args.maxSources)
  },
})

function purgeErrorText(error: unknown): string {
  const raw =
    error instanceof ConvexError
      ? typeof error.data === "string"
        ? error.data
        : JSON.stringify(error.data)
      : error instanceof Error
        ? error.message
        : String(error)
  // Production prefixes a per-request id; identical failures must compare equal.
  return raw.replace(/^\[Request ID: [^\]]+\]\s*/, "").slice(0, 300)
}

async function pickPurgeRow(ctx: MutationCtx, now: number) {
  let nextWaitUntil: number | undefined
  for await (const row of ctx.db
    .query("pagePurges")
    .withIndex("by_requestedAt")) {
    if (row.stalledAt !== undefined) continue
    if (row.waitUntil !== undefined && row.waitUntil > now) {
      nextWaitUntil = Math.min(nextWaitUntil ?? row.waitUntil, row.waitUntil)
      continue
    }
    return { row, nextWaitUntil }
  }
  return { row: null, nextWaitUntil }
}

async function schedulePurgeStep(ctx: MutationCtx) {
  const now = Date.now()
  const { row, nextWaitUntil } = await pickPurgeRow(ctx, now)
  if (row)
    await ctx.scheduler.runAfter(0, internal.cms.publication.runPagePurgeStep, {})
  else if (nextWaitUntil !== undefined)
    await ctx.scheduler.runAfter(
      Math.max(0, nextWaitUntil - now),
      internal.cms.publication.runPagePurgeStep,
      {}
    )
}

/**
 * The single worker chain. It always takes the oldest queued Page that is not
 * stalled or waiting, so purges drain one after another (the block-occurrence
 * counts they share are never written by two purges at once).
 */
export const runPagePurgeStep = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    const { row, nextWaitUntil } = await pickPurgeRow(ctx, now)
    if (!row) {
      if (nextWaitUntil !== undefined)
        await ctx.scheduler.runAfter(
          Math.max(0, nextWaitUntil - now),
          internal.cms.publication.runPagePurgeStep,
          {}
        )
      return null
    }
    // A queued request becomes a started purge only while no language
    // operation is open; from then on new operations are refused. Waiting here
    // never touches `attempts`.
    if (row.startedAt === undefined) {
      if (await languageOperationOpen(ctx)) {
        await ctx.db.patch("pagePurges", row._id, {
          waitUntil: now + PAGE_PURGE_WAIT_MS,
        })
        await schedulePurgeStep(ctx)
        return null
      }
      await ctx.db.patch("pagePurges", row._id, {
        startedAt: now,
        waitUntil: undefined,
      })
    }
    // A failed batch is retried with a smaller one.
    const maxSources = Math.max(
      1,
      Math.floor(pagePurgeTuning.maxSourcesPerBatch / 2 ** row.attempts)
    )
    let result: {
      phase: string
      finished: boolean
      hold?: { kind: "wait" | "stop"; reason: string }
    }
    try {
      result = await ctx.runMutation(
        internal.cms.publication.purgePageBatch,
        { pageId: row.pageId, phase: row.phase, maxSources },
        { transactionLimits: PURGE_NESTED_LIMITS }
      )
    } catch (error) {
      const text = purgeErrorText(error)
      const attempts = row.lastError === text ? row.attempts + 1 : 1
      await ctx.db.patch("pagePurges", row._id, {
        attempts,
        lastError: text,
        updatedAt: now,
        ...(attempts >= PAGE_PURGE_MAX_FAILURES ? { stalledAt: now } : {}),
      })
      await schedulePurgeStep(ctx)
      return null
    }
    if (!result.finished) {
      const hold = result.hold
      await ctx.db.patch("pagePurges", row._id, {
        phase: result.phase,
        attempts: 0,
        lastError: hold?.kind === "stop" ? `closure:${hold.reason}` : undefined,
        updatedAt: now,
        waitUntil: hold?.kind === "wait" ? now + PAGE_PURGE_WAIT_MS : undefined,
        ...(hold?.kind === "stop" ? { stalledAt: now } : {}),
      })
    }
    await schedulePurgeStep(ctx)
    return null
  },
})

/**
 * Daily batch (cron "page purge daily batch"). Permanent deletes are requests:
 * `purgeTrashedPages` only queues a marker. This starts the single worker
 * chain when any queued marker is not stalled; `runPagePurgeStep` then
 * reschedules itself batch by batch until none is left. It also covers a lost
 * chain, so it replaces the former stale-queue sweep. Internal only; tests and
 * the seat call it to run the batch now.
 */
export const startQueuedPagePurges = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    for await (const row of ctx.db
      .query("pagePurges")
      .withIndex("by_requestedAt")) {
      if (row.stalledAt !== undefined) continue
      await ctx.scheduler.runAfter(
        0,
        internal.cms.publication.runPagePurgeStep,
        {}
      )
      return true
    }
    return false
  },
})

// ─── F09 Publication direct functions for the Language domain ──────────────
//
// Typed domain functions, not registered endpoints. The Language domain changes
// publication state only through these. Each one re-reads the language
// authority and binds to the open transition, so a stale cursor can never
// touch a later transition's target state.

async function requireOpenTransitionById(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  phases: ReadonlySet<Transition["phase"]>
): Promise<{ transition: Transition; settings: Doc<"siteSettings"> }> {
  await requireSnapshotAuthority(ctx)
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "multilingual") {
    // M05: a multilingual authority never holds an F09 transition.
    throw new ConvexError("LANGUAGE_TRANSITION_PHASE_INVALID")
  }
  if (state.kind !== "current") {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  const transition = await readOpenTransition(ctx, state)
  if (
    !transition ||
    transition._id !== transitionId ||
    !phases.has(transition.phase)
  ) {
    throw new ConvexError("LANGUAGE_TRANSITION_PHASE_INVALID")
  }
  return { transition, settings: state.settings }
}

const PREPARING_PHASE: ReadonlySet<Transition["phase"]> = new Set(["preparing"])

export type PreparedTargetSelection = {
  snapshotId: Id<"pagePublishedSnapshots">
  candidateId: Id<"pageLocalePublicationCandidates">
  publicGeneration: number
  path: string | null
  publishedAt: number
}

export type PreparedTargetInput = {
  transitionId: Id<"siteLanguageTransitions">
  pageId: Id<"pages">
  expectedTargetPublicGeneration: number
  expectedLifecycleGeneration: number
  expectedReleaseGeneration: number
} & (
  | {
      arm: "draft"
      expectedTargetDraftGeneration: number
      expectedSharedDraftGeneration: number
      preserveDraft?: boolean
    }
  | {
      arm: "frozen"
      sourceSnapshotId: Id<"pagePublishedSnapshots">
      sourcePublicGeneration: number
    }
)

/**
 * F08 immediate publication for the hidden target locale. The `draft` arm
 * (replacement) captures the target Working Draft plus the current Shared
 * Draft and normally deletes it (step 9); retained-target adoption preserves
 * the exact reviewed draft. The `frozen` arm (correction) rebuilds
 * the candidate from the source snapshot's frozen localized and shared payload
 * and never reads a Working or Shared Draft. Both replace the enabled-locale
 * check with "locale is the open transition's target and phase is
 * `preparing`", read ancestry and references through the hidden-target
 * projection, and defer document references to `target` pages (invariant 17).
 */
export async function publishPreparedTargetLocale(
  ctx: MutationCtx,
  input: PreparedTargetInput
): Promise<PreparedTargetSelection> {
  const { transition, settings } = await requireOpenTransitionById(
    ctx,
    input.transitionId,
    PREPARING_PHASE
  )
  const locale = transition.targetLocale
  const attribution = transition.attribution
  const page = await ctx.db.get("pages", input.pageId)
  if (!page) throw new ConvexError("PAGE_NOT_FOUND")
  const pageState = await onePageState(ctx, input.pageId)
  if (
    pageState.lifecycleState !== "active" ||
    pageState.lifecycleGeneration !== input.expectedLifecycleGeneration
  ) {
    throw new ConvexError("PAGE_PUBLICATION_LIFECYCLE_STALE")
  }
  if (!settings.homePageId) {
    throw new ConvexError("PUBLICATION_LOCALE_CONFIG_INVALID")
  }
  const publishedAt = Date.now()
  const targetRows = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", locale)
    )
    .take(2)
  if (targetRows.length > 1) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  let localeState: Doc<"pageLocalePublicationStates"> | null =
    targetRows[0] ?? null
  if (!localeState) {
    if (input.arm === "draft") throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    const stateId = await occurrenceUsageWrites(ctx).insert(
      "pageLocalePublicationStates",
      {
        pageId: input.pageId,
        locale,
        draftGeneration: 0,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: publishedAt,
      }
    )
    localeState = await ctx.db.get("pageLocalePublicationStates", stateId)
    if (!localeState) {
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
    }
  }
  if (
    localeState.hasCurrentSnapshot !==
    (localeState.currentSnapshotId !== undefined)
  ) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  if (
    localeState.publicGeneration !== input.expectedTargetPublicGeneration ||
    localeState.releaseGeneration !== input.expectedReleaseGeneration
  ) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
  }
  if (localeState.currentReleaseId) {
    const currentRelease = await ctx.db.get("pageLocalePublicationReleases", localeState.currentReleaseId)
    if (
      currentRelease &&
      (currentRelease.status === "pending" || currentRelease.status === "held")
    ) {
      throw new ConvexError("PAGE_LOCALE_RELEASE_REPLACEMENT_REQUIRED")
    }
  }

  let slug: string
  let content: Record<string, unknown>
  let sharedRecord: Record<string, unknown>
  let sourceSharedDraftGeneration: number
  let sourceDraftGeneration: number
  let draftId: Id<"pageLocaleDrafts"> | undefined
  let admittedContent: Parameters<typeof diffBlockMutations>[0]
  let titleSource: WriteOptions["trustedSource"]
  if (input.arm === "draft") {
    const shared = await oneSharedDraft(ctx, input.pageId)
    if (
      shared.pageType !== page.pageType ||
      shared.generation !== input.expectedSharedDraftGeneration
    ) {
      throw new ConvexError("PAGE_SHARED_DRAFT_STALE")
    }
    // A target Working Draft from before the change gets the page's old
    // shared values first (once per page); the snapshot below carries none.
    await ensurePageBackfilled(ctx, input.pageId, pageState)
    const draftRows = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", input.pageId).eq("locale", locale)
      )
      .take(2)
    if (
      draftRows.length !== 1 ||
      draftRows[0]!.pageType !== page.pageType ||
      draftRows[0]!.generation !== localeState.draftGeneration ||
      localeState.draftGeneration !== input.expectedTargetDraftGeneration
    ) {
      throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
    }
    const draft = draftRows[0]!
    admittedContent = { [locale]: draft.content }
    slug = draft.slug
    content = draft.content as unknown as Record<string, unknown>
    titleSource = {
      recordId: draft._id,
      version: draft.generation,
      content: { [locale]: draft.content },
    }
    sharedRecord = shared as unknown as Record<string, unknown>
    sourceSharedDraftGeneration = shared.generation
    sourceDraftGeneration = draft.generation
    draftId = draft._id
  } else {
    const sourceStates = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", input.pageId).eq("locale", transition.sourceLocale)
      )
      .take(2)
    const sourceState = sourceStates.length === 1 ? sourceStates[0]! : null
    if (
      !sourceState?.hasCurrentSnapshot ||
      sourceState.currentSnapshotId !== input.sourceSnapshotId ||
      sourceState.publicGeneration !== input.sourcePublicGeneration
    ) {
      throw new ConvexError("LANGUAGE_TRANSITION_SOURCE_STALE")
    }
    const [frozen, sourceSnapshot] = await Promise.all([
      readFrozenSnapshotProjection(
        ctx,
        input.sourceSnapshotId,
        input.pageId,
        transition.sourceLocale
      ),
      ctx.db.get("pagePublishedSnapshots", input.sourceSnapshotId),
    ])
    if (
      !frozen ||
      !sourceSnapshot ||
      frozen.payload.page.pageType !== page.pageType
    ) {
      throw new ConvexError("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
    }
    slug = frozen.payload.localized.slug
    content = frozen.payload.localized.content
    titleSource = {
      recordId: sourceSnapshot._id,
      version: sourceSnapshot.candidateDigest,
      sourceLocale: transition.sourceLocale,
      destinationLocale: locale,
      content: { [transition.sourceLocale]: content },
    }
    sharedRecord = frozen.payload.shared
    sourceSharedDraftGeneration = sourceSnapshot.sourceSharedDraftGeneration
    sourceDraftGeneration = localeState.draftGeneration
  }

  content = writeLocaleContent(page.pageType, content, locale, {
    readLegacyShapes: true,
    trustedSource: titleSource,
  }).value
  // Callers authenticate; workers act under the transition's owner attribution.
  await assertBlockMutationIntegrity(
    ctx,
    diffBlockMutations(admittedContent, { [locale]: content } as never),
    {
      existingContent: { [locale]: content },
      content: { [locale]: content },
      operation: "publish",
    }
  )
  const resolver = hiddenTargetReferences(transition._id)
  const sharedSystem = isRecord(sharedRecord.system) ? sharedRecord.system : {}
  const sharedDescriptor = writeFieldMap(
    contentTypeDefs[page.pageType].sharedFields,
    isRecord(sharedRecord.descriptor) ? sharedRecord.descriptor : {}
  )
  const parentId = sharedSystem.parentId as Id<"pages"> | undefined
  const ancestry = await captureAncestry(
    ctx,
    input.pageId,
    parentId,
    locale,
    resolver.project
  )
  if (settings.homePageId === page._id && (parentId || ancestry.length > 0)) {
    throw new ConvexError("PUBLICATION_HOME_MUST_BE_ROOT")
  }
  const path = await futurePageAddress(ctx, {
    pageId: input.pageId,
    pageType: page.pageType,
    locale: locale,
    slug: slug,
    parentId: parentId,
    homePageId: settings.homePageId,
  })
  const addressCache = new Map<string, Promise<unknown>>([
    ["home", Promise.resolve(settings.homePageId)],
  ])
  refusePageAddress(
    await checkPageAddress(ctx, {
      pageId: input.pageId,
      pageType: page.pageType,
      locale: locale,
      slug: slug,
      parentId: parentId,
      homePageId: settings.homePageId,
      path: path ?? undefined,
      cache: addressCache,
    }),
    "transition"
  )
  if (path !== null)
    await historicalPathNeedsReservation(
      ctx,
      input.pageId,
      locale,
      path,
      addressCache
    )
  await recheckPublishedChildren(
    ctx,
    page,
    locale,
    path,
    localeState.currentPath,
    String(content.title ?? page.slug),
    addressCache
  )

  const snapshotSource = {
    _id: page._id,
    _creationTime: page._creationTime,
    pageType: page.pageType,
    ...sharedDescriptor,
    ...sharedSystem,
    status: "published" as const,
    slug,
    content: { [locale]: content },
    updatedAt: publishedAt,
    publishedAt,
  }
  const payload = buildPayload(
    page,
    sharedRecord,
    locale,
    slug,
    content,
    path,
    ancestry
  )
  const { payloadJson, payloadBytes } =
    serializeLocalePublicationCandidate(payload)
  const candidateDigestValue =
    await digestLocalePublicationCandidate(payloadJson)
  const candidateId = await occurrenceUsageWrites(ctx).insert(
    "pageLocalePublicationCandidates",
    {
      pageId: input.pageId,
      locale,
      pageType: page.pageType,
      sourceDraftGeneration,
      sourceSharedDraftGeneration,
      sourcePublicGeneration: localeState.publicGeneration,
      sourceLifecycleGeneration: pageState.lifecycleGeneration,
      attribution,
      formatVersion: 1,
      payloadJson,
      payloadBytes,
      digest: candidateDigestValue,
      createdAt: publishedAt,
    }
  )
  const persistedCandidate = await ctx.db.get("pageLocalePublicationCandidates", candidateId)
  const frozenPayload = persistedCandidate
    ? await reconstructLocalePublicationCandidate(persistedCandidate)
    : null
  if (
    !persistedCandidate ||
    persistedCandidate.digest !== candidateDigestValue ||
    !frozenPayload
  ) {
    throw new ConvexError("PUBLISHED_SNAPSHOT_CANDIDATE_INTEGRITY_INVALID")
  }
  const routeAncestry =
    payload.route.kind === "routable" ? payload.route.ancestry : []
  await writeReferences(
    ctx,
    snapshotSource as unknown as Doc<"pages">,
    input.pageId,
    locale,
    "candidate",
    candidateId,
    sourceDraftGeneration,
    candidateDigestValue,
    publishedAt,
    routeAncestry,
    true,
    resolver
  )
  const releaseId = await ctx.db.insert("pageLocalePublicationReleases", {
    pageId: input.pageId,
    locale,
    candidateId,
    generation: localeState.releaseGeneration + 1,
    expectedPublicGeneration: localeState.publicGeneration,
    expectedLifecycleGeneration: pageState.lifecycleGeneration,
    status: "published",
    executeAt: publishedAt,
    attribution,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  })
  await runPublicationPolicy(ctx, INSTALLED_PUBLICATION_POLICY, {
    pageId: input.pageId,
    locale,
    pageType: page.pageType,
    candidateId,
    candidateDigest: candidateDigestValue,
    releaseId,
    sourceDraftGeneration,
    sourceSharedDraftGeneration,
    sourcePublicGeneration: localeState.publicGeneration,
    sourceLifecycleGeneration: pageState.lifecycleGeneration,
    payload: frozenPayload,
    attribution,
    requestedAt: publishedAt,
  })
  const snapshotId = await occurrenceUsageWrites(ctx).insert(
    "pagePublishedSnapshots",
    {
      pageId: input.pageId,
      locale,
      generation: localeState.publicGeneration + 1,
      candidateId,
      candidateDigest: candidateDigestValue,
      sourceDraftGeneration,
      sourceSharedDraftGeneration,
      sourcePublicGeneration: localeState.publicGeneration,
      sourceLifecycleGeneration: pageState.lifecycleGeneration,
      releaseId,
      publishedAt,
      attribution,
    }
  )
  await ctx.db.patch("pageLocalePublicationReleases", releaseId, {
    publishedSnapshotId: snapshotId,
    publishedAt,
    updatedAt: publishedAt,
  })
  await clearCurrentReferences(ctx, input.pageId, locale)
  await writeReferences(
    ctx,
    snapshotSource as unknown as Doc<"pages">,
    input.pageId,
    locale,
    "current_public",
    snapshotId,
    localeState.publicGeneration + 1,
    candidateDigestValue,
    publishedAt,
    routeAncestry,
    true,
    resolver
  )
  if (
    localeState.currentPath &&
    localeState.currentPath !== path &&
    localeState.currentSnapshotId
  ) {
    if (
      await historicalPathNeedsReservation(
        ctx,
        input.pageId,
        locale,
        localeState.currentPath
      )
    ) {
      await ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: input.pageId,
        locale,
        fromPath: localeState.currentPath,
        createdFromSnapshotId: localeState.currentSnapshotId,
        createdAt: publishedAt,
      })
    }
  }
  await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", localeState._id, {
    draftBaseSnapshotId: snapshotId,
    publicGeneration: localeState.publicGeneration + 1,
    releaseGeneration: localeState.releaseGeneration + 1,
    currentReleaseId: undefined,
    currentSnapshotId: snapshotId,
    hasCurrentSnapshot: true,
    ...currentSnapshotIndexFields(localeState, {
      pageType: payload.page.pageType,
      firstPublicAt: localeState.hasCurrentSnapshot
        ? (page.publishedAt ?? localeState.currentPublishedAt ?? publishedAt)
        : publishedAt,
    }),
    ...(path === null ? { currentPath: undefined } : { currentPath: path }),
    currentPublishedAt: publishedAt,
    updatedAt: publishedAt,
  })
  await insertRevalidationIntent(ctx, {
    operationId: `publish:${snapshotId}`,
    operationKind: localeState.hasCurrentSnapshot ? "republish" : "publish",
    pageId: input.pageId,
    locale,
    ...(localeState.currentSnapshotId
      ? { oldSnapshotId: localeState.currentSnapshotId }
      : {}),
    newSnapshotId: snapshotId,
    oldPublicGeneration: localeState.publicGeneration,
    newPublicGeneration: localeState.publicGeneration + 1,
    ...(localeState.currentPath ? { oldPath: localeState.currentPath } : {}),
    ...(path ? { newPath: path } : {}),
    phase: "self",
    status: "pending",
    attempts: 0,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  })
  if (draftId && !(input.arm === "draft" && input.preserveDraft)) {
    await clearSourceReferences(ctx, "locale_draft", draftId)
    await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", draftId)
  }
  await runPublicationContributions(ctx, INSTALLED_PUBLICATION_CONTRIBUTIONS, {
    kind: "publish",
    pageId: input.pageId,
    locale,
    snapshotId,
    ...(localeState.currentSnapshotId
      ? { previousSnapshotId: localeState.currentSnapshotId }
      : {}),
    publicGeneration: localeState.publicGeneration + 1,
    path,
    ...(localeState.currentPath
      ? { previousPath: localeState.currentPath }
      : {}),
    payload: frozenPayload,
    attribution,
    occurredAt: publishedAt,
  })
  return {
    snapshotId,
    candidateId,
    publicGeneration: localeState.publicGeneration + 1,
    path,
    publishedAt,
  }
}

/**
 * F08 withdrawal for the hidden target locale, bound to the exact snapshot so
 * an older cursor can never withdraw a later transition's selection. Accepted
 * in any open phase, including `cancelling`.
 */
export async function withdrawPreparedTargetLocale(
  ctx: MutationCtx,
  input: {
    transitionId: Id<"siteLanguageTransitions">
    pageId: Id<"pages">
    expectedSnapshotId: Id<"pagePublishedSnapshots">
    expectedPublicGeneration: number
  }
): Promise<{ publicGeneration: number }> {
  const { transition } = await requireOpenTransitionById(
    ctx,
    input.transitionId,
    OPEN_TRANSITION_PHASES
  )
  const locale = transition.targetLocale
  const state = await oneLocaleState(ctx, input.pageId, locale)
  if (
    !state.hasCurrentSnapshot ||
    state.currentSnapshotId !== input.expectedSnapshotId ||
    state.publicGeneration !== input.expectedPublicGeneration
  ) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STALE")
  }
  // Only current_public rows in this language matter: the loop below skips
  // every other source kind and language, and old candidate rows pile up.
  const inbound = await ctx.db
    .query("pagePublicationDocumentReferences")
    .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
      q
        .eq("targetId", input.pageId)
        .eq("sourceKind", "current_public")
        .eq("locale", locale)
    )
    .take(513)
  if (inbound.length > 512) {
    throw new ConvexError("PAGE_ANCESTRY_REFERENCE_LIMIT")
  }
  for (const ref of inbound) {
    if (
      ref.sourceKind !== "current_public" ||
      ref.referenceKind !== "ancestry" ||
      ref.targetLocale !== locale ||
      ref.locale !== locale
    )
      continue
    const sourceState = await oneLocaleState(ctx, ref.pageId, locale)
    if (
      sourceState.hasCurrentSnapshot &&
      sourceState.currentSnapshotId === ref.sourceId
    ) {
      throw new ConvexError("PAGE_ANCESTRY_IN_USE")
    }
  }
  const now = Date.now()
  await clearCurrentReferences(ctx, input.pageId, locale)
  await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
    publicGeneration: state.publicGeneration + 1,
    currentSnapshotId: undefined,
    currentReleaseId: undefined,
    hasCurrentSnapshot: false,
    ...currentSnapshotIndexFields(state, null),
    currentPath: undefined,
    currentPublishedAt: undefined,
    updatedAt: now,
  })
  await insertRevalidationIntent(ctx, {
    operationId: `withdraw:${input.expectedSnapshotId}`,
    operationKind: "withdraw",
    pageId: input.pageId,
    locale,
    oldSnapshotId: input.expectedSnapshotId,
    oldPublicGeneration: state.publicGeneration,
    newPublicGeneration: state.publicGeneration + 1,
    ...(state.currentPath ? { oldPath: state.currentPath } : {}),
    phase: "self",
    status: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  })
  await runPublicationContributions(ctx, INSTALLED_PUBLICATION_CONTRIBUTIONS, {
    kind: "withdraw",
    pageId: input.pageId,
    locale,
    withdrawnSnapshotId: input.expectedSnapshotId,
    publicGeneration: state.publicGeneration + 1,
    ...(state.currentPath ? { previousPath: state.currentPath } : {}),
    attribution: transition.attribution,
    occurredAt: now,
  })
  return { publicGeneration: state.publicGeneration + 1 }
}

/**
 * Creates a transition-owned target Working Draft (correction copy after
 * selection, private-draft copy, or replacement copy). Refuses to overwrite an
 * existing target draft.
 */
export async function createTransitionTargetDraft(
  ctx: MutationCtx,
  input: {
    transitionId: Id<"siteLanguageTransitions">
    pageId: Id<"pages">
    slug: string
    content: Record<string, unknown>
  }
): Promise<{ draftGeneration: number }> {
  const { transition } = await requireOpenTransitionById(
    ctx,
    input.transitionId,
    new Set(["enumerating", "preparing", "validating", "ready"])
  )
  const locale = transition.targetLocale
  const page = await ctx.db.get("pages", input.pageId)
  if (!page) throw new ConvexError("PAGE_NOT_FOUND")
  const [stateRows, draftRows] = await Promise.all([
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", input.pageId).eq("locale", locale)
      )
      .take(2),
    ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", input.pageId).eq("locale", locale)
      )
      .take(2),
  ])
  if (stateRows.length > 1) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  if (draftRows.length > 0) throw new ConvexError("TARGET_DRAFT_EXISTS")
  const slug = input.slug.trim()
  if (!slug) throw new ConvexError("SLUG_REQUIRED")
  // A same-Page language copy retains occurrence metadata only when it
  // matches the actual stored source draft (or its recorded base snapshot).
  const sourceDrafts = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", transition.sourceLocale)
    )
    .take(2)
  if (sourceDrafts.length > 1)
    throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
  let sourceState: Doc<"pageLocalePublicationStates"> | undefined
  if (!sourceDrafts[0]) {
    const sourceStates = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", input.pageId).eq("locale", transition.sourceLocale)
      )
      .take(2)
    if (sourceStates.length > 1)
      throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
    sourceState = sourceStates[0]
  }
  const sourceContent = await presentationWorkingContent(
    ctx,
    page,
    transition.sourceLocale,
    sourceDrafts[0],
    sourceState
  )
  await assertBlockMutationIntegrity(
    ctx,
    diffBlockMutations(undefined, { [locale]: input.content } as never),
    {
      existingContent:
        sourceContent === undefined ? undefined : { [locale]: sourceContent },
      content: { [locale]: input.content },
      operation: "edit",
    }
  )
  input = {
    ...input,
    content: writeLocaleContent(page.pageType, input.content, locale, {
      readLegacyShapes: true,
      trustedSource: {
        recordId: sourceDrafts[0]?._id ?? sourceState?.currentSnapshotId ?? "",
        version:
          sourceDrafts[0]?.generation ?? sourceState?.publicGeneration ?? "",
        sourceLocale: transition.sourceLocale,
        destinationLocale: locale,
        content: { [transition.sourceLocale]: sourceContent },
      },
    }).value,
  }
  refusePageAddress(
    await checkPageAddress(ctx, {
      pageId: page._id,
      pageType: page.pageType,
      locale,
      slug,
      parentId: await addressSharedParent(ctx, page._id),
    }),
    "transition"
  )
  const now = Date.now()
  let state: Doc<"pageLocalePublicationStates"> | null = stateRows[0] ?? null
  if (!state) {
    const stateId = await occurrenceUsageWrites(ctx).insert(
      "pageLocalePublicationStates",
      {
        pageId: input.pageId,
        locale,
        draftGeneration: 0,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: now,
      }
    )
    state = await ctx.db.get("pageLocalePublicationStates", stateId)
    if (!state) throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  const draftGeneration = state.draftGeneration + 1
  const draftId = await occurrenceUsageWrites(ctx).insert("pageLocaleDrafts", {
    pageId: input.pageId,
    locale,
    pageType: page.pageType,
    generation: draftGeneration,
    slug,
    content: input.content,
    updatedBy: transition.attribution,
    createdAt: now,
    updatedAt: now,
  } as Parameters<typeof ctx.db.insert<"pageLocaleDrafts">>[1])
  await writeReferences(
    ctx,
    { ...page, content: { [locale]: input.content } } as Doc<"pages">,
    page._id,
    locale,
    "locale_draft",
    draftId,
    draftGeneration,
    undefined,
    now
  )
  await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
    draftGeneration,
    updatedAt: now,
  })
  return { draftGeneration }
}

/**
 * Cancellation discard: F08 `deleteLocaleContent` semantics for one
 * transition-created target draft. The caller has already withdrawn any
 * prepared selection.
 */
export async function deleteTransitionTargetDraft(
  ctx: MutationCtx,
  input: {
    transitionId: Id<"siteLanguageTransitions">
    pageId: Id<"pages">
    /** An adopted selection that stays current; it must match exactly. */
    preserved?: {
      snapshotId: Id<"pagePublishedSnapshots">
      publicGeneration: number
    }
  }
): Promise<void> {
  const { transition } = await requireOpenTransitionById(
    ctx,
    input.transitionId,
    new Set(["cancelling"])
  )
  const locale = transition.targetLocale
  const stateRows = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", locale)
    )
    .take(2)
  if (stateRows.length > 1) {
    throw new ConvexError("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  }
  const state = stateRows[0]
  if (!state) return
  if (state.hasCurrentSnapshot || state.currentSnapshotId) {
    // A current selection normally has to be withdrawn first. The only
    // exception is the exact adopted pre-existing selection the caller
    // preserves; any other pointer is a successor and is never touched.
    const { preserved } = input
    if (
      !preserved ||
      !state.hasCurrentSnapshot ||
      state.currentSnapshotId !== preserved.snapshotId ||
      state.publicGeneration !== preserved.publicGeneration
    ) {
      throw new ConvexError("LOCALE_MUST_BE_WITHDRAWN")
    }
  }
  const openReleases = await Promise.all(
    (["pending", "held"] as const).map((status) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_pageId_and_locale_and_status", (q) =>
          q.eq("pageId", input.pageId).eq("locale", locale).eq("status", status)
        )
        .take(1)
    )
  )
  if (openReleases.some((rows) => rows.length > 0)) {
    throw new ConvexError("LOCALE_HAS_PENDING_RELEASE")
  }
  const drafts = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", locale)
    )
    .take(2)
  if (drafts.length > 1) throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
  if (drafts[0]) {
    await clearSourceReferences(ctx, "locale_draft", drafts[0]._id)
    await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", drafts[0]._id)
  }
  await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
    draftBaseSnapshotId: undefined,
    draftGeneration: state.draftGeneration + 1,
    updatedAt: Date.now(),
  })
}

// ─── Sitemap partitions (M05 C5a) ───────────────────────────────────────────
//
// Contract "Sitemap partitions" and "Worker transaction ceilings". A manifest
// splits each enabled locale's `by_hasCurrentSnapshot_and_locale` keyspace
// into half-open `_creationTime` ranges, one partition per builder step. Every
// row has one `_creationTime`, so it falls in exactly one partition: a
// manifest neither omits nor duplicates a row, only partition sizes drift.

/**
 * F09 F01 post-cancellation remedy for one retained target-locale Working
 * Draft. Language owns eligibility; Publication rechecks every destructive
 * precondition and deletes only the exact generation the owner confirmed.
 */
export async function deleteCancelledRetainedTargetDraft(
  ctx: MutationCtx,
  input: {
    pageId: Id<"pages">
    locale: string
    expectedDraftGeneration: number
    expectedLifecycleGeneration: number
  }
): Promise<number> {
  const page = await ctx.db.get("pages", input.pageId)
  if (!page) throw new ConvexError("PAGE_NOT_FOUND")

  const pageState = await onePageState(ctx, input.pageId)
  if (
    pageState.lifecycleState !== "active" ||
    pageState.lifecycleGeneration !== input.expectedLifecycleGeneration
  ) {
    throw new ConvexError("PAGE_LIFECYCLE_STALE")
  }

  const state = await oneLocaleState(ctx, input.pageId, input.locale)
  if (state.hasCurrentSnapshot || state.currentSnapshotId) {
    throw new ConvexError("LOCALE_MUST_BE_WITHDRAWN")
  }
  if (state.draftGeneration !== input.expectedDraftGeneration) {
    throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
  }

  const openReleases = await Promise.all(
    (["pending", "held"] as const).map((status) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_pageId_and_locale_and_status", (q) =>
          q
            .eq("pageId", input.pageId)
            .eq("locale", input.locale)
            .eq("status", status)
        )
        .take(1)
    )
  )
  if (openReleases.some((rows) => rows.length > 0)) {
    throw new ConvexError("LOCALE_HAS_PENDING_RELEASE")
  }

  const drafts = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", input.pageId).eq("locale", input.locale)
    )
    .take(2)
  if (drafts.length !== 1) {
    throw new ConvexError("PAGE_LOCALE_DRAFT_INVALID")
  }
  const draft = drafts[0]!
  if (
    draft.generation !== input.expectedDraftGeneration ||
    draft.pageType !== page.pageType
  ) {
    throw new ConvexError("PAGE_LOCALE_DRAFT_STALE")
  }

  await clearSourceReferences(ctx, "locale_draft", draft._id)
  await occurrenceUsageWrites(ctx).delete("pageLocaleDrafts", draft._id)
  const draftGeneration = state.draftGeneration + 1
  await occurrenceUsageWrites(ctx).patch("pageLocalePublicationStates", state._id, {
    draftBaseSnapshotId: undefined,
    draftGeneration,
    updatedAt: Date.now(),
  })
  return draftGeneration
}

/**
 * Rows one sitemap child may serve: the largest count for which `CEILING + 1`
 * rows, their SEO alternates and snapshot verification fit the M23 reserve
 * under the P22 measurement profile (16 enabled locales, every row current in
 * all of them, ancestry depth 2, 22 KiB candidates). Bytes bind first: such a
 * row reads about 583 KB, and 14 of them 7.9 MB of the 8 MiB reserve. A child
 * above it answers a no-store 503; a heavier partition stops at the reserve
 * with the same answer.
 */
export const SITEMAP_PARTITION_CEILING = 13
/** Rows the builder aims to close into one partition (`CEILING / 4`). */
export const SITEMAP_PARTITION_TARGET = Math.floor(
  SITEMAP_PARTITION_CEILING / 4
)
/** A superseded manifest stays servable for 24 hours, then is collected. */
export const SITEMAP_MANIFEST_RETENTION_MS = 24 * 60 * 60 * 1000
/** A building manifest untouched this long is abandoned by the sweep. */
export const SITEMAP_BUILD_STALL_MS = 60 * 60 * 1000
/** Partitions the nightly sweep checks for drift per step (one page). */
export const SITEMAP_SWEEP_PARTITION_PAGE = 8
/** Partition rows the nightly sweep deletes per collection step. */
export const SITEMAP_COLLECT_BATCH = 128

export type SitemapPartitionReaders = {
  /** Ascending `_creationTime` of up to `limit` rows at or above the low bound. */
  fromLow(limit: number): Promise<number[]>
  /** The first `_creationTime` strictly above `value`, or null. */
  after(value: number): Promise<number | null>
}

export type SitemapPartitionClose = {
  highCreationTime: number | null
  rowsAtBuild: number
  oversized: boolean
  /** Range queries issued: 1 without a tie, at most 3 with one (R6-H2). */
  ranges: number
}

/**
 * Closes one partition from its low bound. Without a tie it reads
 * `TARGET + 1` rows and closes at the last one's `_creationTime`. When the
 * whole batch shares one `_creationTime`, an index range cannot split the
 * group, so it is resolved without enumerating it: one extension of
 * `CEILING` rows and, when those still share the value, one strict probe for
 * the next greater value. That probed value is also the next partition's low
 * bound, so `high(k) = low(k + 1)` holds across an oversized partition.
 */
export async function closeSitemapPartition(
  readers: SitemapPartitionReaders,
  target: number,
  ceiling: number
): Promise<SitemapPartitionClose> {
  const batch = await readers.fromLow(target + 1)
  if (batch.length <= target) {
    return {
      highCreationTime: null,
      rowsAtBuild: batch.length,
      oversized: false,
      ranges: 1,
    }
  }
  const first = batch[0]!
  const closing = batch[target]!
  if (closing !== first) {
    return {
      highCreationTime: closing,
      rowsAtBuild: batch.indexOf(closing),
      oversized: false,
      ranges: 1,
    }
  }
  // Rows below `first` do not exist above the low bound, so the extension
  // starts with the tie group itself.
  const extension = await readers.fromLow(ceiling)
  const next = extension.find((time) => time !== first)
  if (next !== undefined) {
    return {
      highCreationTime: next,
      rowsAtBuild: extension.indexOf(next),
      oversized: false,
      ranges: 2,
    }
  }
  if (extension.length < ceiling) {
    return {
      highCreationTime: null,
      rowsAtBuild: extension.length,
      oversized: false,
      ranges: 2,
    }
  }
  return {
    highCreationTime: await readers.after(first),
    rowsAtBuild: extension.length,
    oversized: true,
    ranges: 3,
  }
}

/** Range readers over one locale's current-snapshot keyspace. */
export function sitemapPartitionReaders(
  ctx: QueryCtx,
  locale: string,
  low: number | null
): SitemapPartitionReaders {
  return {
    fromLow: async (limit) => {
      const rows = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_hasCurrentSnapshot_and_locale", (q) => {
          const prefix = q.eq("hasCurrentSnapshot", true).eq("locale", locale)
          return low === null ? prefix : prefix.gte("_creationTime", low)
        })
        .take(limit)
      return rows.map((row) => row._creationTime)
    },
    after: async (value) => {
      const rows = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
          q
            .eq("hasCurrentSnapshot", true)
            .eq("locale", locale)
            .gt("_creationTime", value)
        )
        .take(1)
      return rows[0]?._creationTime ?? null
    },
  }
}

/**
 * The live language version: the authority row's, or 0 without one. Every
 * enabled-locale change advances it (contract "Build"), so a build that still
 * matches it still has its locales. Null on a duplicated authority row.
 */
async function readLiveLanguageVersion(ctx: QueryCtx): Promise<number | null> {
  const authorityRows = await readAuthorityRows(ctx)
  if (authorityRows.length > 1) return null
  return authorityRows[0]?.version ?? 0
}

/** The live enabled locales, in settings order, or null when unreadable. */
async function readLiveEnabledLocales(ctx: QueryCtx): Promise<string[] | null> {
  const settingsRows = await ctx.db.query("siteSettings").take(2)
  if (settingsRows.length !== 1) return null
  const locales = settingsRows[0]!.enabledLocales ?? []
  return locales.length > 0 ? locales : null
}

async function readSitemapManifestsWithStatus(
  ctx: QueryCtx,
  status: Doc<"siteSitemapManifests">["status"],
  languageVersion: number
): Promise<Doc<"siteSitemapManifests">[]> {
  return ctx.db
    .query("siteSitemapManifests")
    .withIndex("by_status_and_languageVersion", (q) =>
      q.eq("status", status).eq("languageVersion", languageVersion)
    )
    .take(1)
}

/**
 * `requestSitemapManifestBuild`: allocates the next manifest version and
 * schedules its first step. Idempotent: nothing happens while a manifest is
 * `building` for the live language version, and, unless `rebuild`, while one
 * is already `ready` for it, so each language version is built once (P19d).
 * Only the nightly sweep's drift and oversized checks rebuild. Two
 * concurrent requests read the same highest version and conflict.
 */
export async function requestSitemapManifestBuildInTransaction(
  ctx: MutationCtx,
  options: { rebuild: boolean }
): Promise<number | null> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return null
  const [version, locales] = await Promise.all([
    readLiveLanguageVersion(ctx),
    readLiveEnabledLocales(ctx),
  ])
  if (version === null || locales === null) return null
  const building = await readSitemapManifestsWithStatus(
    ctx,
    "building",
    version
  )
  if (building.length > 0) return null
  if (!options.rebuild) {
    const ready = await readSitemapManifestsWithStatus(ctx, "ready", version)
    if (ready.length > 0) return null
  }
  const latest = await ctx.db
    .query("siteSitemapManifests")
    .withIndex("by_manifestVersion")
    .order("desc")
    .take(1)
  const manifestVersion = (latest[0]?.manifestVersion ?? 0) + 1
  const now = Date.now()
  await ctx.db.insert("siteSitemapManifests", {
    manifestVersion,
    languageVersion: version,
    status: "building",
    buildLocale: locales[0]!,
    buildOrdinal: 0,
    createdAt: now,
    updatedAt: now,
  })
  await ctx.scheduler.runAfter(
    0,
    internal.cms.publication.stepSitemapManifestBuild,
    { manifestVersion }
  )
  return manifestVersion
}

export type SitemapBuildStep = "noop" | "abandoned" | "closed" | "published"

/**
 * `stepSitemapManifestBuild`: closes one partition, or publishes the manifest
 * once every locale is closed. Each step compares the live language version
 * with the manifest's and abandons the build on a difference. Publication
 * supersedes every ready manifest in the same mutation, so at most one is
 * ever `ready`.
 */
export async function stepSitemapManifestBuildInTransaction(
  ctx: MutationCtx,
  manifestVersion: number,
  readers: typeof sitemapPartitionReaders = sitemapPartitionReaders
): Promise<SitemapBuildStep> {
  const manifests = await ctx.db
    .query("siteSitemapManifests")
    .withIndex("by_manifestVersion", (q) =>
      q.eq("manifestVersion", manifestVersion)
    )
    .take(2)
  if (manifests.length !== 1) return "noop"
  const manifest = manifests[0]!
  if (manifest.status !== "building") return "noop"
  const now = Date.now()
  const abandon = async (): Promise<SitemapBuildStep> => {
    await ctx.db.patch("siteSitemapManifests", manifest._id, { status: "abandoned", updatedAt: now })
    return "abandoned"
  }
  if ((await readLiveLanguageVersion(ctx)) !== manifest.languageVersion) {
    return abandon()
  }

  const locale = manifest.buildLocale
  if (locale === undefined) {
    const ready = await ctx.db
      .query("siteSitemapManifests")
      .withIndex("by_status_and_languageVersion", (q) =>
        q.eq("status", "ready")
      )
      .take(2)
    for (const previous of ready) {
      await ctx.db.patch("siteSitemapManifests", previous._id, {
        status: "superseded",
        supersededAt: now,
        updatedAt: now,
      })
    }
    await ctx.db.patch("siteSitemapManifests", manifest._id, { status: "ready", updatedAt: now })
    return "published"
  }

  const low = manifest.buildLowCreationTime ?? null
  const ordinal = manifest.buildOrdinal ?? 0
  const close = await closeSitemapPartition(
    readers(ctx, locale, low),
    SITEMAP_PARTITION_TARGET,
    SITEMAP_PARTITION_CEILING
  )
  let nextLocale: string | undefined
  if (close.highCreationTime === null) {
    // Settings are read only where the next locale is needed; a matching
    // language version guarantees the build's locales are still enabled.
    const locales = await readLiveEnabledLocales(ctx)
    const localeIndex = locales?.indexOf(locale) ?? -1
    if (!locales || localeIndex < 0) return abandon()
    nextLocale = locales[localeIndex + 1]
  }
  await ctx.db.insert("siteSitemapPartitions", {
    manifestVersion,
    locale,
    ordinal,
    lowCreationTime: low,
    highCreationTime: close.highCreationTime,
    rowsAtBuild: close.rowsAtBuild,
    oversized: close.oversized,
  })
  await ctx.db.patch(
    "siteSitemapManifests", manifest._id,
    close.highCreationTime === null
      ? {
          buildLocale: nextLocale,
          buildLowCreationTime: undefined,
          buildOrdinal: nextLocale === undefined ? undefined : 0,
          updatedAt: now,
        }
      : {
          buildLowCreationTime: close.highCreationTime,
          buildOrdinal: ordinal + 1,
          updatedAt: now,
        }
  )
  await ctx.scheduler.runAfter(
    0,
    internal.cms.publication.stepSitemapManifestBuild,
    { manifestVersion }
  )
  return "closed"
}

export const requestSitemapManifestBuild = internalMutation({
  args: {},
  returns: v.union(v.number(), v.null()),
  handler: (ctx) =>
    requestSitemapManifestBuildInTransaction(ctx, { rebuild: false }),
})

export const stepSitemapManifestBuild = internalMutation({
  args: { manifestVersion: v.number() },
  returns: v.null(),
  handler: async (ctx, { manifestVersion }) => {
    await stepSitemapManifestBuildInTransaction(ctx, manifestVersion)
    return null
  },
})

const sitemapSweepPhaseValidator = v.union(
  v.literal("converge"),
  v.literal("drift"),
  v.literal("collect")
)
export type SitemapSweepPhase = "converge" | "drift" | "collect"

async function scheduleSitemapSweep(
  ctx: MutationCtx,
  phase: SitemapSweepPhase,
  cursor: string | null = null
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    internal.cms.publication.sweepSitemapManifests,
    { phase, cursor }
  )
}

/**
 * The nightly sitemap sweep (contract "Convergence" and "Retention"), in
 * three bounded phases:
 * - `converge` abandons a stalled build and requests a build when the live
 *   language version has neither a ready nor a building manifest;
 * - `drift` pages the ready manifest's partitions and requests a rebuild
 *   when one holds more than `2 × TARGET` rows or is oversized;
 * - `collect` deletes abandoned manifests, and superseded ones after their
 *   retention, one partition batch per step.
 */
export async function runSitemapSweepStep(
  ctx: MutationCtx,
  phase: SitemapSweepPhase,
  cursor: string | null
): Promise<void> {
  const now = Date.now()
  if (phase === "converge") {
    const version = await readLiveLanguageVersion(ctx)
    if (version !== null) {
      const building = await readSitemapManifestsWithStatus(
        ctx,
        "building",
        version
      )
      const stalled = building[0]
      if (stalled && stalled.updatedAt < now - SITEMAP_BUILD_STALL_MS) {
        await ctx.db.patch("siteSitemapManifests", stalled._id, {
          status: "abandoned",
          updatedAt: now,
        })
      }
      await requestSitemapManifestBuildInTransaction(ctx, { rebuild: false })
    }
    await scheduleSitemapSweep(ctx, "drift")
    return
  }

  if (phase === "drift") {
    const version = await readLiveLanguageVersion(ctx)
    const ready =
      version === null
        ? []
        : await readSitemapManifestsWithStatus(ctx, "ready", version)
    const manifest = ready[0]
    if (!manifest) {
      await scheduleSitemapSweep(ctx, "collect")
      return
    }
    let page
    try {
      page = await ctx.db
        .query("siteSitemapPartitions")
        .withIndex("by_manifestVersion_and_locale_and_ordinal", (q) =>
          q.eq("manifestVersion", manifest.manifestVersion)
        )
        .paginate({ numItems: SITEMAP_SWEEP_PARTITION_PAGE, cursor })
    } catch (error) {
      // Only a stored cursor can be unresumable; restart the phase.
      if (cursor === null) throw error
      await scheduleSitemapSweep(ctx, "drift")
      return
    }
    for (const partition of page.page) {
      let drifted = partition.oversized
      if (!drifted) {
        const rows = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_hasCurrentSnapshot_and_locale", (q) => {
            const prefix = q
              .eq("hasCurrentSnapshot", true)
              .eq("locale", partition.locale)
            const low = partition.lowCreationTime
            const high = partition.highCreationTime
            if (low !== null && high !== null)
              return prefix.gte("_creationTime", low).lt("_creationTime", high)
            if (low !== null) return prefix.gte("_creationTime", low)
            if (high !== null) return prefix.lt("_creationTime", high)
            return prefix
          })
          .take(2 * SITEMAP_PARTITION_TARGET + 1)
        drifted = rows.length > 2 * SITEMAP_PARTITION_TARGET
      }
      if (drifted) {
        await requestSitemapManifestBuildInTransaction(ctx, { rebuild: true })
        await scheduleSitemapSweep(ctx, "collect")
        return
      }
    }
    if (page.isDone) await scheduleSitemapSweep(ctx, "collect")
    else await scheduleSitemapSweep(ctx, "drift", page.continueCursor)
    return
  }

  const abandoned = await ctx.db
    .query("siteSitemapManifests")
    .withIndex("by_status_and_languageVersion", (q) =>
      q.eq("status", "abandoned")
    )
    .take(1)
  const superseded = abandoned.length
    ? []
    : await ctx.db
        .query("siteSitemapManifests")
        .withIndex("by_status_and_languageVersion", (q) =>
          q.eq("status", "superseded")
        )
        .take(16)
  const collectable =
    abandoned[0] ??
    superseded.find(
      (row) =>
        row.supersededAt !== undefined &&
        row.supersededAt <= now - SITEMAP_MANIFEST_RETENTION_MS
    )
  if (!collectable) return
  const partitions = await ctx.db
    .query("siteSitemapPartitions")
    .withIndex("by_manifestVersion_and_locale_and_ordinal", (q) =>
      q.eq("manifestVersion", collectable.manifestVersion)
    )
    .take(SITEMAP_COLLECT_BATCH)
  for (const partition of partitions) await ctx.db.delete("siteSitemapPartitions", partition._id)
  if (partitions.length < SITEMAP_COLLECT_BATCH) {
    await ctx.db.delete("siteSitemapManifests", collectable._id)
  }
  await scheduleSitemapSweep(ctx, "collect")
}

/** Nightly cron entry point; runs with every module off (core sitemap). */
export const sweepSitemapManifests = internalMutation({
  args: {
    phase: v.optional(sitemapSweepPhaseValidator),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await runSitemapSweepStep(
      ctx,
      args.phase ?? "converge",
      args.cursor ?? null
    )
    return null
  },
})

const currentSnapshotMigrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { internalMutation, schema }
)

/** Backfill a fresh selection, never a captured stale Page or draft projection.
 * Reading the selection and immutable sources in this mutation preserves the
 * ordinary publication transaction's ownership of concurrent changes.
 * A newly prepared legacy cutover selection without either Page publishedAt or
 * currentPublishedAt stays unkeyed: never invent a cutover timestamp. Legacy
 * published Pages have publishedAt; release-1 starters disable the legacy seam.
 */
export async function backfillCurrentSnapshotIndexRow(
  ctx: MutationCtx,
  stateId: Id<"pageLocalePublicationStates">
): Promise<"keyed" | "unchanged" | "missing_source"> {
  await requireSnapshotAuthority(ctx)
  const state = await ctx.db.get("pageLocalePublicationStates", stateId)
  if (!state?.hasCurrentSnapshot || !state.currentSnapshotId) return "unchanged"
  if (state.pageType !== undefined && state.publicSince !== undefined)
    return "unchanged"
  const snapshot = await ctx.db.get(
    "pagePublishedSnapshots",
    state.currentSnapshotId
  )
  const [candidate, page] = await Promise.all([
    snapshot
      ? ctx.db.get("pageLocalePublicationCandidates", snapshot.candidateId)
      : null,
    ctx.db.get("pages", state.pageId),
  ])
  if (
    !snapshot ||
    !candidate ||
    !page ||
    snapshot.pageId !== state.pageId ||
    snapshot.locale !== state.locale ||
    candidate.pageId !== state.pageId ||
    candidate.locale !== state.locale ||
    (page.publishedAt ?? state.currentPublishedAt) === undefined
  ) {
    // One counted event per skipped selection; aggregate these counts in the
    // migration logs. Leave it unkeyed rather than invent a cutover timestamp.
    console.warn("Recent snapshot index missing source", { count: 1, stateId })
    return "missing_source"
  }
  await occurrenceUsageWrites(ctx).patch(
    "pageLocalePublicationStates",
    state._id,
    currentSnapshotIndexFields(state, {
      pageType: candidate.pageType ?? page.pageType,
      firstPublicAt: page.publishedAt ?? state.currentPublishedAt,
    })
  )
  return "keyed"
}

export const backfillCurrentSnapshotIndex = currentSnapshotMigrations.define({
  table: "pageLocalePublicationStates",
  batchSize: 50,
  migrateOne: async (ctx, state) => {
    await backfillCurrentSnapshotIndexRow(ctx, state._id)
  },
})

/** Serial finalizer: only after all batches, purge existing pages/menu caches. */
export const revalidateCurrentSnapshotIndex = currentSnapshotMigrations.define({
  table: "pagePublicationCutover",
  customRange: (query) =>
    query.withIndex("by_key", (q) => q.eq("key", "published-snapshot-v1")),
  migrateOne: async (ctx) => {
    await requireSnapshotAuthority(ctx)
    await ctx.scheduler.runAfter(
      0,
      internal.cms.revalidate.revalidateSettings,
      {}
    )
  },
})

export const runCurrentSnapshotIndexBackfill = currentSnapshotMigrations.runner(
  [
    internal.cms.publication.backfillCurrentSnapshotIndex,
    internal.cms.publication.revalidateCurrentSnapshotIndex,
  ]
)
