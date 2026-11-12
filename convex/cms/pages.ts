import {
  occurrenceUsageWrites,
  occurrenceUsageInternalMutation as internalMutation,
  occurrenceUsageMutation as mutation,
} from "../lib/publishing/staging"
import { readSlice } from "@/convex/lib/slices/identity"
import type { Infer } from "convex/values"
import {
  writePageContent,
  writeFieldMap,
  writeSliceFields,
  type WriteOptions,
} from "../lib/richtext/write"
import { ConvexError, v } from "convex/values"
import { paginationOptsValidator } from "convex/server"
import type { PaginationResult } from "convex/server"
import { query } from "../_generated/server"
import { api, internal } from "../_generated/api"
import type { QueryCtx, MutationCtx } from "../_generated/server"
import type { Id, Doc } from "../_generated/dataModel"
import { requireOperationAccess } from "../lib/access/policy"
import type { OwnerPrincipal } from "../lib/access/owner"
import type { PageType } from "../lib/pages/types"
import { homeSlugsForLocale } from "../../lib/pages/home-aliases"
import { SUPPORTED_LOCALES } from "../../lib/i18n/config"
import {
  findPublishedLandingPageBySlug,
  resolveEffectiveHomePageId,
} from "../lib/pages/home"
import {
  assertSliceMutationIntegrity,
  diffSliceMutations,
  requireSliceMutationsPermitted,
} from "../lib/slices/permissions"
import { readEffectiveSlicePresentationCatalog } from "../lib/slices/presentations"
import { hasExplicitSlicePresentations } from "../lib/slices/presentationMutations"
import {
  clearPageReferences,
  refreshPageReferences,
} from "../lib/domains/media"
import {
  assertPrePublishAllowed,
  buildPrePublishChecklistWithReferences,
  prePublishChecklistValidator,
  projectPublicPage,
  projectPublicReferenceCard,
  snapshotPrePublishChecklist,
  type PrePublishChecklist,
  type PublicPage,
  type PublicRelationCard,
} from "../lib/domains/publication"
import {
  hasSliceBody,
  type SliceBodyContent,
  assertStagingFresh,
  deleteStagingByPageId,
  enrichWithStagingOverlay,
  getStagingByPageId,
  overlayStagingOnPage,
  pickEffectiveTitles,
  resolvePageDisplayTitle,
  STAGING_ABANDONED_TTL_MS,
  STAGING_SWEEP_BATCH_SIZE,
} from "../lib/domains/contentEditing"
import {
  leavePagePresence as leavePagePresenceRow,
  listActivePagePresence,
  touchPagePresence as touchPagePresenceRow,
} from "../lib/publishing/presence"
import {
  acquirePageEditorLock as acquirePageEditorLockRow,
  getPageEditorLockState,
  releasePageEditorLock as releasePageEditorLockRow,
} from "../lib/publishing/locks"
import { createPageRevision } from "../lib/publishing/revisions"
import { deletePageSearch, syncPageSearch } from "../lib/publishing/search"
import {
  SCHEDULED_TRANSITION_BATCH_SIZE,
  queryDueScheduledExpiries,
  queryDueScheduledPublishes,
} from "../lib/publishing/scheduling"
import {
  assertLegacyPublicationWriterBlocked,
  createPublicSnapshotProjectionReader,
  projectSnapshotReferenceCard,
  type SnapshotPayload,
  readCurrentSnapshotProjection,
  readLiveAddressRows,
  readHeldHistoricalRows,
  readFrozenSnapshotProjection,
  readPublicationAuthority,
  readPublicSnapshotLocaleAlternates,
} from "../lib/publishing/snapshots"
import { assertPublicLanguageVersion } from "../lib/language/state"
import {
  initializeSuccessorPage,
  SITEMAP_PARTITION_CEILING,
  snapshotAdminPageRow,
  adminPageLocaleValidator,
  projectAdminPageLocales,
  type AdminLocaleSource,
} from "./publication"
import { pageTypeValidator } from "../lib/pages/types"
import {
  assertBoundedPilotCanCreate,
  assertBoundedPilotCanPublish,
  canBoundedPilotPublish,
  initializeBoundedPilotEnvelope as reconcileBoundedPilotEnvelope,
  readBoundedPilotEnvelope,
  releaseBoundedPilotPageSlot,
  releaseBoundedPilotPublishedSlot,
} from "../lib/pilotEnvelope"
import {
  buildLocaleRelativePath,
  isRoutableContentType,
  resolveContentTypeByPath,
  slugify,
} from "../lib/contentTypes/routing"
import {
  pageDocValidator,
  pageEditorLockDocValidator,
  pageWithStagedOverlayValidator,
  pagePresenceDocValidator,
  seoValidator,
} from "../schema"
import {
  assertContentTypeAcceptsCreation,
  assertContentTypeIsActive,
} from "./contentTypes"
import {
  assertEditionCanCreatePublished,
  assertEditionCanPublish,
  assertEditionReviewAllowsLifecycleChange,
  canEditionSweepStaging,
  checkEditionScheduledPublish,
  recordEditionDraftDiscard,
  recordEditionDraftEdit,
  recordEditionPublished,
  recordEditionScheduledPublishRejected,
  type EditionPublishApproval,
} from "../edition/workflow"

const childSummaryValidator = v.object({
  _id: v.id("pages"),
  title: v.string(),
  slug: v.string(),
})

const deleteImpactValidator = v.object({
  children: v.array(childSummaryValidator),
  redirects: v.number(),
  menus: v.array(v.string()),
})

const breadcrumbItemValidator = v.object({
  id: v.id("pages"),
  slug: v.string(),
  title: v.string(),
})

const localizedBreadcrumbItemValidator = v.object({
  name: v.string(),
  url: v.string(),
})

const publicRelationCardValidator = v.object({
  pageId: v.id("pages"),
  pageType: pageTypeValidator,
  title: v.string(),
  excerpt: v.optional(v.string()),
  image: v.optional(v.object({ url: v.string() })),
  href: v.optional(v.string()),
})
const boundedPilotEnvelopeValidator = v.object({
  withinEnvelope: v.boolean(),
  totalPagesBelowCap: v.boolean(),
  publishedPagesBelowCap: v.boolean(),
  totalPagesAtOrAboveWarningThreshold: v.boolean(),
  publishedPagesAtOrAboveWarningThreshold: v.boolean(),
})
import { resolveRelations } from "../lib/slices/resolve"
import {
  validateFieldMapRichText,
  validateSlicesRichText,
  validateUniqueSliceIds,
} from "../lib/slices/validate"
import { repairLocalizedSliceIdsForPublish } from "../lib/slices/identity"
import {
  CONTENT_TYPES,
  contentTypeDefs,
  isActiveContentType,
  contentDraftInputValidator,
} from "../lib/domains/contentModel"
import { sliceValidator, type Slice } from "../lib/slices"
import { image as imagePrimitive } from "../lib/slices/primitives"
import {
  buildInitialLocalizedContent,
  copyDescriptorSharedFields,
  descriptorDefaults,
  parseDescriptorSharedFieldPatch,
  SYSTEM_OWNED_SHARED_FIELDS,
} from "../lib/domains/contentModel"
import { ensureTagsForLabels } from "./tags"

// ============================================================
// Validators
// ============================================================

const statusValidator = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("archived")
)

/** Strict system-field allowlist for anonymous page responses. */
const publicSeoValidator = v.object({
  metaTitle: v.optional(v.string()),
  metaDescription: v.optional(v.string()),
  ogImage: v.optional(v.string()),
  ogTitle: v.optional(v.string()),
  ogDescription: v.optional(v.string()),
  twitterCard: v.optional(
    v.union(v.literal("summary"), v.literal("summary_large_image"))
  ),
  noIndex: v.optional(v.boolean()),
  noFollow: v.optional(v.boolean()),
  structuredData: v.optional(v.string()),
})

const publicPageSystemFields = {
  _id: v.id("pages"),
  updatedAt: v.number(),
  publishedAt: v.optional(v.number()),
  seo: v.optional(publicSeoValidator),
} as const

const publicSliceBodyContentValidator = v.object({
  title: v.string(),
  metaTitle: v.optional(v.string()),
  metaDescription: v.optional(v.string()),
  slices: v.array(sliceValidator),
})

/**
 * The response schema for `getPublicPageById`. Keep this separate from the
 * `pages` storage validator: a new storage field must not become public by
 * being added to a union arm.
 */
const publicPageValidator = v.union(
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("landing-page"),
    content: v.record(v.string(), publicSliceBodyContentValidator),
  }),
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("page"),
    content: v.record(v.string(), publicSliceBodyContentValidator),
  }),
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("post"),
    authorIds: v.optional(
      v.array(
        v.object({
          pageId: v.optional(v.id("pages")),
          itemId: v.optional(v.string()),
        })
      )
    ),
    category: v.optional(v.string()),
    featured: v.boolean(),
    promoteToFront: v.boolean(),
    content: v.record(v.string(), publicSliceBodyContentValidator),
  }),
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("author"),
    name: v.string(),
    socials: contentTypeDefs.author.sharedFields.socials.validator,
    content: v.record(
      v.string(),
      v.object({
        title: v.string(),
        metaTitle: v.optional(v.string()),
        metaDescription: v.optional(v.string()),
        roleTitle: v.optional(v.string()),
        slices: v.array(sliceValidator),
      })
    ),
  }),
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("testimonial"),
    personName: v.string(),
    personRole: v.optional(v.string()),
    personCompany: v.optional(v.string()),
    personImage: v.optional(imagePrimitive().validator),
    sourceUrl: v.optional(v.string()),
    content: v.record(v.string(), v.object({ quote: v.string() })),
  }),
  v.object({
    ...publicPageSystemFields,
    pageType: v.literal("job"),
    department: v.optional(v.string()),
    location: v.optional(v.string()),
    remoteType: v.union(
      v.literal("remote"),
      v.literal("hybrid"),
      v.literal("onsite")
    ),
    employmentType: v.union(
      v.literal("full-time"),
      v.literal("part-time"),
      v.literal("contract"),
      v.literal("internship"),
      v.literal("temporary")
    ),
    salaryCurrency: v.union(
      v.literal("USD"),
      v.literal("EUR"),
      v.literal("GBP"),
      v.literal("CAD"),
      v.literal("AUD")
    ),
    salaryMin: v.number(),
    salaryMax: v.number(),
    applyUrl: v.optional(
      v.object({
        type: v.union(
          v.literal("internal"),
          v.literal("external"),
          v.literal("anchor"),
          v.literal("media"),
          v.literal("none")
        ),
        pageId: v.optional(v.id("pages")),
        mediaId: v.optional(v.id("media")),
        storageId: v.optional(v.id("_storage")),
        url: v.optional(v.string()),
        anchor: v.optional(v.string()),
        openInNewTab: v.optional(v.boolean()),
        noFollow: v.optional(v.boolean()),
        sponsored: v.optional(v.boolean()),
        ugc: v.optional(v.boolean()),
      })
    ),
    applyEmail: v.optional(v.string()),
    closingDate: v.optional(v.string()),
    jobStatus: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("filled")
    ),
    content: v.record(
      v.string(),
      v.object({
        title: v.string(),
        summary: v.optional(v.string()),
        slices: v.array(sliceValidator),
      })
    ),
  })
)

const pagePickerRowValidator = v.object({
  _id: v.id("pages"),
  slug: v.string(),
  localizedSlugs: v.optional(v.record(v.string(), v.string())),
  localizedTitles: v.record(v.string(), v.string()),
  localePublicationStates: v.record(
    v.string(),
    v.union(
      v.literal("published"),
      v.literal("draft"),
      v.literal("not_translated")
    )
  ),
  status: statusValidator,
  pageType: pageTypeValidator,
})

const linkablePageSelectionValidator = v.union(
  v.object({
    status: v.literal("available"),
    page: pagePickerRowValidator,
  }),
  v.object({ status: v.literal("missing") }),
  v.object({ status: v.literal("unavailable") })
)

const localizedContentInput = v.object({
  title: v.string(),
  metaTitle: v.optional(v.string()),
  metaDescription: v.optional(v.string()),
  // Accept every registered shape so stored disabled content reaches the
  // located installed-profile guard in the handler instead of failing Convex
  // argument validation without a content path.
  slices: v.optional(v.array(sliceValidator)),
})

const pageEditorLockStateValidator = v.union(
  v.object({
    status: v.literal("available"),
    lock: v.null(),
    isMine: v.boolean(),
  }),
  v.object({
    status: v.literal("locked"),
    lock: pageEditorLockDocValidator,
    isMine: v.boolean(),
  })
)

const acquirePageEditorLockResultValidator = v.union(
  v.object({
    status: v.literal("acquired"),
    lock: pageEditorLockDocValidator,
  }),
  v.object({
    status: v.literal("blocked"),
    lock: pageEditorLockDocValidator,
  })
)

const updateResultValidator = v.object({
  updatedAt: v.number(),
})
const staleSaveMessage =
  "This page changed since you opened it. Reload before saving, or save your current draft as a copy."
const DEFAULT_PAGE_LIST_LIMIT = 500
const MAX_PAGE_LIST_LIMIT = 1000
const DEFAULT_PAGE_PICKER_LIMIT = 50
// At most 100 pages are projected per call. Supported content keeps their
// combined per-locale drafts under Convex's 16 MiB read limit (about 80 KiB
// average per locale draft with two locales, leaving room for metadata).
const MAX_PAGE_PICKER_LIMIT = 100
const PAGE_PICKER_CANDIDATE_LIMIT = 400
const MEDIA_REFERENCE_BACKFILL_BATCH_SIZE = 50

// ============================================================
// Helpers
// ============================================================

function generateSlug(title: string): string {
  return slugify(title)
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}

// ADR-0041 Deploy 2 PR B item 3: `pages.content` is empty for drafts
// whose working copy lives on staging. Callers that need a display
// title for an arbitrary page (child summaries, revision cards, media
// usage) go through `resolvePageDisplayTitle` — it overlays staging's
// denormalized `effectiveTitles` for non-published rows.

function localizedTitlesForPage(page: Doc<"pages">): Record<string, string> {
  return Object.fromEntries(
    Object.entries(page.content ?? {}).map(([locale, content]) => [
      locale,
      content.title,
    ])
  )
}

export type PagePickerRow = Infer<typeof pagePickerRowValidator>

function pagePickerRow(
  page: Doc<"pages"> & { effectiveTitles?: Record<string, string> }
): PagePickerRow {
  const publishedTitles = localizedTitlesForPage(page)
  const localizedTitles = { ...publishedTitles, ...page.effectiveTitles }
  return {
    _id: page._id,
    slug: page.slug,
    localizedTitles,
    // Staged text is an editing source, never proof of publication.
    localePublicationStates: Object.fromEntries(
      Object.keys(localizedTitles).map((locale) => [
        locale,
        page.status === "published" && publishedTitles[locale]?.trim()
          ? ("published" as const)
          : ("draft" as const),
      ])
    ),
    status: page.status,
    pageType: page.pageType,
    ...(page.localizedSlugs !== undefined
      ? { localizedSlugs: page.localizedSlugs }
      : {}),
  }
}

async function snapshotPagePickerRow(
  ctx: QueryCtx,
  state: Doc<"pagePublicationPageStates">
): Promise<PagePickerRow | null> {
  // Pickers need locale text and publication metadata, not prospective paths.
  // Keep frozen-snapshot verification in the shared projection owner.
  const row = await snapshotAdminPageRow(ctx, state, {
    includeProspectivePaths: false,
  })
  if (
    !row ||
    !row.locales.length ||
    new Set(row.locales.map((locale) => locale.locale)).size !==
      row.locales.length
  )
    return null
  const textLocales = row.locales.filter(
    (locale) => locale.title?.trim() && locale.slug !== undefined
  )
  return {
    _id: row._id,
    slug: row.slug,
    localizedSlugs: Object.fromEntries(
      textLocales.map((locale) => [locale.locale, locale.slug!])
    ),
    localizedTitles: Object.fromEntries(
      textLocales.map((locale) => [locale.locale, locale.title!])
    ),
    localePublicationStates: Object.fromEntries(
      row.locales.map((locale) => [locale.locale, locale.state])
    ),
    status: row.status,
    pageType: row.pageType,
  }
}

/**
 * Snapshot-authority picker row for one page, or null when the page has no
 * single lifecycle row, is trashed (or archived unless `includeArchived`), or
 * its projection is unreadable. Reads: one lifecycle row plus the reads of
 * `snapshotPagePickerRow` (about 4 + 2 per language).
 */
export async function snapshotPickerRowForPage(
  ctx: QueryCtx,
  pageId: Id<"pages">,
  options: { includeArchived: boolean }
): Promise<PagePickerRow | null> {
  const states = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (states.length !== 1) return null
  const state = states[0]!
  if (state.lifecycleState === "trashed") return null
  if (state.lifecycleState === "archived" && !options.includeArchived)
    return null
  return snapshotPagePickerRow(ctx, state)
}

function isPubliclyReadablePage(page: Doc<"pages">): boolean {
  return page.deletedAt === undefined && page.status === "published"
}

/**
 * A release-excluded storage arm may be read by explicit migration tooling,
 * but it must not re-enter the ordinary editor lifecycle through an admin's
 * wildcard permission.
 */
export function assertPageIsActiveForOrdinaryOperation(
  page: Doc<"pages">,
  operation: "edit" | "delete" | "publish"
): void {
  assertContentTypeIsActive(page.pageType, operation)
}

/**
 * Resolve the set of `pageType`s the caller can privately (draft/archived)
 * read (ADR-0036). Used by batch-read helpers that would otherwise call
 * `canReadPrivate` once per page — one auth resolve, in-memory filter.
 * Anonymous callers get the empty set (public rows still surface via the
 * `isPubliclyReadablePage` fast path).
 */
async function privateReadablePageTypes(
  ctx: QueryCtx | MutationCtx
): Promise<Set<PageType>> {
  try {
    await requireOperationAccess(ctx)
    return new Set(CONTENT_TYPES as PageType[])
  } catch {
    return new Set()
  }
}

/**
 * Temporary page-operation adapters retain the call-site shape while F03
 * removes Community's legacy role, membership, and permission resolution.
 * Their ignored operation arguments are deliberately not authorization input:
 * the verified installation owner is the sole Community principal.
 */
export async function requirePagePermission(
  ctx: QueryCtx | MutationCtx,
  pageType: PageType,
  _operation: string,
  _scope?: { ownerId?: string | null; prospectiveOwner?: boolean }
): Promise<OwnerPrincipal> {
  // Every ordinary page operation enters through this adapter. Release-excluded
  // storage arms remain available to migrations, but never acquire owner access
  // merely because F01's installation principal is otherwise authorized.
  if (!isActiveContentType(pageType)) {
    throw new ConvexError(
      `Content Type "${pageType}" is not active in this starter.`
    )
  }
  return requireOperationAccess(ctx)
}

export async function requireAnyPageTypePermission(
  ctx: QueryCtx | MutationCtx,
  _operation: string
): Promise<OwnerPrincipal> {
  return requireOperationAccess(ctx)
}

async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  _operation: string,
  _scope?: { ownerId?: string | null; prospectiveOwner?: boolean }
): Promise<OwnerPrincipal> {
  return requireOperationAccess(ctx)
}

async function canReadPrivate(
  ctx: QueryCtx | MutationCtx,
  pageType: PageType,
  _operation: string
): Promise<boolean> {
  // The nullable reader family shares this adapter. Its active-type guard must
  // run before the F01 owner fallback so registered-but-inactive rows cannot
  // reappear in ordinary private reads.
  if (!isActiveContentType(pageType)) return false
  try {
    await requireOperationAccess(ctx)
    return true
  } catch {
    return false
  }
}

function permittedPageTypes(): Set<PageType> {
  return new Set(CONTENT_TYPES as PageType[])
}

/**
 * Legacy page crons are useful only while the explicit legacy epoch owns
 * publication. A fresh install and every successor phase must leave the old
 * workers dormant, while duplicate authority remains an integrity failure.
 *
 * Keep this gate local to the two cron entry points: interactive legacy Page
 * writers continue to use `assertLegacyPublicationWriterBlocked` and stay
 * fail-closed outside the legacy phase.
 */
async function shouldRunLegacyPageCron(ctx: MutationCtx): Promise<boolean> {
  const cutoverRows = await ctx.db
    .query("pagePublicationCutover")
    .withIndex("by_key", (q) => q.eq("key", "published-snapshot-v1"))
    .take(2)
  if (cutoverRows.length > 1) {
    throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
  }
  return cutoverRows[0]?.phase === "legacy"
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number
): number {
  return Math.min(Math.max(Math.floor(value ?? fallback), 1), max)
}

/**
 * Plan 029 C10 task 10 — sticky auto-unset for `post.promoteToFront`.
 *
 * At most one post carries `promoteToFront: true` at a time. When a caller
 * flips a post to sticky, this helper queries the `by_type_promoteToFront`
 * index for every other post already holding the flag and patches each to
 * `false` in the SAME mutation.
 *
 * Concurrency: Convex OCC gives second-wins deterministically. If sessions
 * A and B both stick different posts, both read the same "other stickies"
 * set. When A commits (unstucks the previous holder, sticks A), B's read
 * set now conflicts (the previous holder's row moved out of the sticky
 * set) and B is retried. On retry B reads A as the current sticky,
 * unstucks A, sticks B. Result: whichever commits last wins, exactly one
 * sticky remains.
 *
 * `excludePageId` skips the row being written by the caller — usually the
 * current mutation's own row (update path). Undefined on the create path,
 * where no row exists yet.
 */
async function autoUnsetOtherPromoteToFront(
  ctx: MutationCtx,
  excludePageId: Id<"pages"> | undefined
): Promise<void> {
  const holders = await ctx.db
    .query("pages")
    .withIndex("by_type_promoteToFront", (q) =>
      q.eq("pageType", "post").eq("promoteToFront", true)
    )
    .collect()
  await Promise.all(
    holders
      .filter((holder) => holder._id !== excludePageId)
      .map((holder) =>
        occurrenceUsageWrites(ctx).patch(holder._id, { promoteToFront: false })
      )
  )
}

function sliceLabel(slice: Slice): string {
  return `${readSlice(slice).type}:${readSlice(slice).id}`
}

function summarizePageChange(
  before: Doc<"pages">,
  after: Partial<Doc<"pages">>
): string[] {
  const summary: string[] = []
  const nextContent = after.content ?? before.content
  const nextSeo = after.seo ?? before.seo
  const beforeLocales = Object.keys(before.content ?? {}).sort()
  const afterLocales = Object.keys(nextContent ?? {}).sort()

  for (const locale of Array.from(
    new Set([...beforeLocales, ...afterLocales])
  )) {
    const label = locale.toUpperCase()
    const oldContent = before.content?.[locale]
    const newContent = nextContent?.[locale]
    if (!oldContent && newContent) {
      summary.push(`${label} locale added`)
      continue
    }
    if (oldContent && !newContent) {
      summary.push(`${label} locale removed`)
      continue
    }
    if (!oldContent || !newContent) continue
    if (oldContent.title !== newContent.title) {
      summary.push(`Title changed in ${label}`)
    }
    // Meta/slice-specific summaries only apply to slice-body arms. Pure-
    // form arms (testimonial) don't carry `metaTitle` / `metaDescription`
    // / `slices` — descriptor-field summary would come from the C10
    // descriptor walker if needed; the current revision summary is
    // slice-body-oriented and it's safe to skip here.
    if (hasSliceBody(before)) {
      const oldC = oldContent as SliceBodyContent
      const newC = newContent as SliceBodyContent
      if (oldC.metaTitle !== newC.metaTitle) {
        summary.push(`Meta title changed in ${label}`)
      }
      if (oldC.metaDescription !== newC.metaDescription) {
        summary.push(`Meta description changed in ${label}`)
      }
      const oldSlices = oldC.slices ?? []
      const newSlices = newC.slices ?? []
      const oldLabels = oldSlices.map(sliceLabel)
      const newLabels = newSlices.map(sliceLabel)
      if (oldLabels.join("|") !== newLabels.join("|")) {
        if (oldSlices.length !== newSlices.length) {
          summary.push(
            `${label} blocks changed from ${oldSlices.length} to ${newSlices.length}`
          )
        } else {
          summary.push(`${label} block order changed`)
        }
      } else if (JSON.stringify(oldSlices) !== JSON.stringify(newSlices)) {
        summary.push(`${label} block content changed`)
      }
    }
  }

  if (before.slug !== after.slug && after.slug !== undefined) {
    summary.push("Base slug changed")
  }
  if (
    JSON.stringify(before.localizedSlugs ?? {}) !==
    JSON.stringify(after.localizedSlugs ?? before.localizedSlugs ?? {})
  ) {
    summary.push("Localized slugs changed")
  }
  if (before.status !== after.status && after.status !== undefined) {
    summary.push(`Status changed from ${before.status} to ${after.status}`)
  }
  if (JSON.stringify(before.seo ?? {}) !== JSON.stringify(nextSeo ?? {})) {
    summary.push("Global SEO changed")
  }

  return summary.length > 0 ? summary : ["Saved page snapshot"]
}

function assertFresh(
  page: Doc<"pages">,
  expectedUpdatedAt: number | undefined
) {
  if (expectedUpdatedAt !== undefined && page.updatedAt !== expectedUpdatedAt) {
    throw new ConvexError(staleSaveMessage)
  }
}

async function getChildPageSummaries(
  ctx: QueryCtx | MutationCtx,
  id: Id<"pages">
): Promise<{ _id: Id<"pages">; title: string; slug: string }[]> {
  const children = await ctx.db
    .query("pages")
    .withIndex("by_parent", (q) => q.eq("parentId", id))
    .collect()
  const summaries: { _id: Id<"pages">; title: string; slug: string }[] = []
  for (const child of children) {
    summaries.push({
      _id: child._id,
      title: await resolvePageDisplayTitle(ctx, child),
      slug: child.slug,
    })
  }
  return summaries
}

async function getRedirectsToPage(
  ctx: QueryCtx | MutationCtx,
  id: Id<"pages">
): Promise<Doc<"redirects">[]> {
  return ctx.db
    .query("redirects")
    .withIndex("by_toPageId", (q) => q.eq("toPageId", id))
    .collect()
}

async function getMenuSlugsReferencingPage(
  ctx: QueryCtx | MutationCtx,
  id: Id<"pages">
): Promise<string[]> {
  const menuIds = new Set<Id<"menus">>()
  for await (const reference of ctx.db
    .query("menuReferences")
    .withIndex("by_target", (q) => q.eq("targetId", id))) {
    menuIds.add(reference.menuId)
  }

  const menus = await Promise.all(
    [...menuIds].map((menuId) => ctx.db.get(menuId))
  )
  const slugs = new Set<string>()
  for (const menu of menus) {
    if (!menu || menu.deletedAt !== undefined) continue
    slugs.add(menu.slug)
  }
  return [...slugs].sort()
}

async function getDeleteImpact(ctx: QueryCtx | MutationCtx, id: Id<"pages">) {
  const [children, redirects, menus] = await Promise.all([
    getChildPageSummaries(ctx, id),
    getRedirectsToPage(ctx, id),
    getMenuSlugsReferencingPage(ctx, id),
  ])
  return {
    children,
    redirects: redirects.length,
    menus,
  }
}

/** Run the rich-text write-path gate over every locale's slices (ADR-0009). */
function validateContentRichText(
  content: Record<string, { slices?: Slice[] | undefined }> | undefined
): void {
  if (!content) return
  for (const locale of Object.values(content)) {
    if (locale?.slices) validateSlicesRichText(locale.slices)
  }
}

/** Enforce Slice identity independently within each Localized Content. */
function validateContentSliceIds(
  content: Record<string, { slices?: readonly Slice[] | undefined }> | undefined
): void {
  if (!content) return
  for (const locale of Object.values(content)) {
    if (locale?.slices) validateUniqueSliceIds(locale.slices)
  }
}

/** Build a transition-safe staging view without mutating the stored document. */
function withRepairedStagingSliceIds(
  staging: Doc<"pageStaging">
): Doc<"pageStaging"> {
  const content = repairLocalizedSliceIdsForPublish(
    staging.content as
      Record<string, { slices?: Slice[]; [key: string]: unknown }> | undefined
  )
  if (content === staging.content) return staging
  return { ...staging, content } as Doc<"pageStaging">
}

/** Build a transition-safe live-row view while preserving revision history. */
function withRepairedPageSliceIds(page: Doc<"pages">): Doc<"pages"> {
  const content = repairLocalizedSliceIdsForPublish(
    page.content as
      Record<string, { slices?: Slice[]; [key: string]: unknown }> | undefined
  )
  if (content === page.content) return page
  return { ...page, content } as Doc<"pages">
}

async function isSlugTaken(
  ctx: QueryCtx | MutationCtx,
  slug: string,
  excludePageId?: Id<"pages">
): Promise<boolean> {
  // A slug must be unique across every page's base `slug` AND every locale's
  // `localizedSlugs` value. Routing resolves a leaf either by base slug
  // (default locale) or by `localizedSlugs[locale]`, so any duplicate value —
  // base-vs-base, base-vs-localized, or localized-vs-localized — is ambiguous.
  // The base-slug `by_slug` index can't cover record values, so we scan.
  const pages = await ctx.db.query("pages").collect()
  for (const p of pages) {
    if (p.deletedAt !== undefined) continue
    if (excludePageId && p._id === excludePageId) continue
    if (p.slug === slug) return true
    if (p.localizedSlugs && Object.values(p.localizedSlugs).includes(slug)) {
      return true
    }
  }
  return false
}

async function ensureSlugUnique(
  ctx: QueryCtx | MutationCtx,
  slug: string,
  excludePageId?: Id<"pages">
): Promise<void> {
  if (await isSlugTaken(ctx, slug, excludePageId)) {
    throw new ConvexError({
      code: "SLUG_TAKEN",
      message: `Slug "${slug}" is already taken. Please choose a different slug.`,
    })
  }
}

/**
 * Check several slugs against the live tree in ONE pass.
 *
 * `isSlugTaken` scans the whole `pages` table (see its comment for why
 * `localizedSlugs` can't be indexed). Publish used to call it once per changed
 * slug — a three-locale publish meant four full scans of the heaviest table in
 * the schema. The candidates are known up front, so one scan answers all of
 * them. Same validation, same error message, ~Nx less database I/O.
 *
 * Duplicates *within* `slugs` are also rejected: two locales staging the same
 * slug is just as ambiguous as colliding with another page.
 */
async function ensureSlugsUnique(
  ctx: QueryCtx | MutationCtx,
  slugs: string[],
  excludePageId?: Id<"pages">
): Promise<void> {
  if (slugs.length === 0) return

  const seen = new Set<string>()
  for (const slug of slugs) {
    if (seen.has(slug)) {
      throw new ConvexError({
        code: "SLUG_TAKEN",
        message: `Slug "${slug}" is already taken. Please choose a different slug.`,
      })
    }
    seen.add(slug)
  }

  const pages = await ctx.db.query("pages").collect()
  for (const p of pages) {
    if (p.deletedAt !== undefined) continue
    if (excludePageId && p._id === excludePageId) continue
    if (seen.has(p.slug)) {
      throw new ConvexError({
        code: "SLUG_TAKEN",
        message: `Slug "${p.slug}" is already taken. Please choose a different slug.`,
      })
    }
    if (p.localizedSlugs) {
      for (const value of Object.values(p.localizedSlugs)) {
        if (seen.has(value)) {
          throw new ConvexError({
            code: "SLUG_TAKEN",
            message: `Slug "${value}" is already taken. Please choose a different slug.`,
          })
        }
      }
    }
  }
}

/**
 * Normalize a `relation()` input into the primitive's stored shape.
 *
 * Callers pass a raw `Id<"pages">` (or `undefined` to clear) plus the
 * descriptor field's `pageTypes` allowlist; we confirm the target exists,
 * isn't soft-deleted, and matches one of the allowed types before wrapping
 * into `{ pageId }`. The client-side `RelationPicker` filters by the same
 * allowlist — the mutation guards the seam.
 *
 * C7 generalized this from the C5 `resolveAuthorRelation` (which hardcoded
 * `pageType !== "author"`) so the next sharedField relation drops in with no
 * new helper: pass its `pageTypes` config, done.
 */
async function resolvePageRelation(
  ctx: MutationCtx,
  targetPageId: Id<"pages"> | undefined,
  allowedPageTypes: readonly string[]
): Promise<{ pageId: Id<"pages"> } | undefined> {
  if (!targetPageId) return undefined
  const target = await ctx.db.get(targetPageId)
  if (!target || target.deletedAt !== undefined) {
    throw new ConvexError("Selected relation target no longer exists")
  }
  if (!allowedPageTypes.includes(target.pageType)) {
    throw new ConvexError(
      `Relation target must be one of [${allowedPageTypes.join(", ")}] (got '${target.pageType}')`
    )
  }
  return { pageId: targetPageId }
}

/**
 * Plural version — resolves a list of page ids to a list of relation objects.
 * Used for `post.authorIds` (plan 029 C10) and any future list-of-relation
 * shared field. Empty input returns `undefined` so the stored row omits the
 * field entirely rather than carrying an empty array.
 */
async function resolvePageRelations(
  ctx: MutationCtx,
  targetPageIds: Id<"pages">[] | undefined,
  allowedPageTypes: readonly string[],
  previous?: readonly { pageId?: Id<"pages">; itemId?: string }[]
): Promise<Array<{ pageId: Id<"pages">; itemId?: string }> | undefined> {
  if (!targetPageIds || targetPageIds.length === 0) return undefined
  // De-dup defensively — the admin picker already prevents duplicate adds,
  // but a direct/racy caller must not be able to persist the same target
  // twice (doubled byline name, duplicate documentReferences row).
  const uniqueIds = [...new Set(targetPageIds)]
  const resolvedAll = await Promise.all(
    uniqueIds.map((id) => resolvePageRelation(ctx, id, allowedPageTypes))
  )
  const previousByPageId = new Map<Id<"pages">, string>()
  for (const row of previous ?? []) {
    if (
      row.pageId !== undefined &&
      typeof row.itemId === "string" &&
      row.itemId.trim()
    ) {
      previousByPageId.set(row.pageId, row.itemId)
    }
  }
  const results = resolvedAll.flatMap((row) => {
    if (!row) return []
    const itemId = previousByPageId.get(row.pageId) ?? crypto.randomUUID()
    return [itemId !== undefined ? { ...row, itemId } : row]
  })
  return results.length > 0 ? results : undefined
}

/** Allowed target types for `post.sharedFields.authorIds`, per descriptor. */
const POST_BYLINE_ALLOWED_TYPES: readonly string[] = ["author"]

/**
 * Find a free slug for a copy of `baseSlug`: `<base>-copy`, then `<base>-copy-2`,
 * `<base>-copy-3`, … — the first that isn't taken across base or localized slugs.
 */
async function nextAvailableSlug(
  ctx: QueryCtx | MutationCtx,
  baseSlug: string
): Promise<string> {
  let candidate = `${baseSlug}-copy`
  let n = 2
  while (await isSlugTaken(ctx, candidate)) {
    candidate = `${baseSlug}-copy-${n++}`
  }
  return candidate
}

type LocaleConfig = {
  defaultLocale: string
  enabledLocales: string[]
  homePageId: Id<"pages"> | null
}
type LocalizedPageUrlRow = {
  pageId: Id<"pages">
  locale: string
  url: string
}

const LOCALIZED_PAGE_URL_BATCH_SIZE = 500

function isHomeSlugForLocale(
  page: Pick<Doc<"pages">, "slug" | "localizedSlugs">,
  locale: string,
  defaultLocale: string
): boolean {
  const slugs = homeSlugsForLocale(locale, defaultLocale)
  return (
    slugs.includes(page.slug) ||
    (locale !== defaultLocale &&
      page.localizedSlugs?.[locale] !== undefined &&
      slugs.includes(page.localizedSlugs[locale]))
  )
}

async function resolveHomePageIdForLocale(
  ctx: QueryCtx | MutationCtx,
  locale: string | undefined,
  allowDefaultLocaleFallback: boolean
): Promise<Id<"pages"> | null> {
  const cfg = await getLocaleConfig(ctx)
  const requestedLocale = locale ?? cfg.defaultLocale
  if (
    !allowDefaultLocaleFallback &&
    !cfg.enabledLocales.includes(requestedLocale)
  ) {
    return null
  }

  for (const slug of homeSlugsForLocale(requestedLocale, cfg.defaultLocale)) {
    const page = await findPublishedLandingPageBySlug(ctx, slug)
    if (
      page &&
      (page.content?.[requestedLocale] ||
        (allowDefaultLocaleFallback && page.content?.[cfg.defaultLocale]))
    ) {
      return page._id
    }
  }

  if (!cfg.homePageId) return null
  const explicitHome = await ctx.db.get(cfg.homePageId)
  if (
    explicitHome &&
    explicitHome.deletedAt === undefined &&
    isActiveContentType(explicitHome.pageType) &&
    explicitHome.status === "published" &&
    (explicitHome.content?.[requestedLocale] ||
      (allowDefaultLocaleFallback && explicitHome.content?.[cfg.defaultLocale]))
  ) {
    return explicitHome._id
  }

  return null
}

async function getLocaleConfig(
  ctx: QueryCtx | MutationCtx
): Promise<LocaleConfig> {
  const settings = await ctx.db.query("siteSettings").first()
  const authority = await readPublicationAuthority(ctx)
  const homePageId =
    authority === "snapshot_active"
      ? (settings?.homePageId ?? null)
      : authority === "legacy"
        ? await resolveEffectiveHomePageId(ctx, settings?.homePageId)
        : null
  return {
    defaultLocale: settings?.defaultLocale ?? "en",
    enabledLocales:
      authority !== "invalid" &&
      settings?.enabledLocales &&
      settings.enabledLocales.length > 0
        ? settings.enabledLocales
        : authority === "invalid"
          ? []
          : ["en"],
    homePageId,
  }
}

/**
 * Build the per-locale public URLs for a page (locale-prefixed, fully
 * ancestored). Single source of truth shared by the URL queries and the
 * revalidation hook so they can't drift. Only locales the page is translated
 * into are included.
 */
function localizedUrlsForPage(
  page: Doc<"pages">,
  cfg: LocaleConfig
): Record<string, string> {
  if (!isRoutableContentType(page.pageType)) return {}
  const urls: Record<string, string> = {}
  for (const locale of cfg.enabledLocales) {
    if (!page.content?.[locale]) continue
    const localePrefix = locale === cfg.defaultLocale ? "" : `/${locale}`
    if (
      page._id === cfg.homePageId ||
      isHomeSlugForLocale(page, locale, cfg.defaultLocale)
    ) {
      urls[locale] = localePrefix || "/"
      continue
    }
    const slug =
      (locale !== cfg.defaultLocale && page.localizedSlugs?.[locale]) ||
      page.slug
    const ancestry =
      (locale !== cfg.defaultLocale && page.localizedAncestryPaths?.[locale]) ||
      page.ancestryPath ||
      ""
    const body = buildLocaleRelativePath({
      pageType: page.pageType,
      slug,
      ancestry,
    })
    // Non-routable content types are absent from the sitemap and public URL
    // maps entirely — the descriptor decides, not the caller.
    if (body === null) continue
    urls[locale] = `${localePrefix}${body}`
  }
  return urls
}

function snapshotPublicPage(value: unknown): PublicPage | null {
  if (!value || typeof value !== "object") return null
  const page = value as Partial<PublicPage>
  return page._id && page.pageType && page.content ? (page as PublicPage) : null
}

function prefixedSnapshotPath(
  path: string | null,
  locale: string,
  defaultLocale: string
): string | null {
  if (path === null) return null
  if (locale === defaultLocale) return path
  // A non-default home is the bare prefix (`/fr`), never `/fr/`: the public
  // route and the proxy use no trailing slash (M05 C5).
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}

/** Narrow card owner for both recent-menu and by-ID snapshot consumers. */
async function snapshotRelationCard(
  ctx: QueryCtx,
  projection: SnapshotPayload,
  cfg: LocaleConfig
): Promise<PublicRelationCard | null> {
  const card = projectSnapshotReferenceCard(projection)
  if (!card) return null
  const locale = projection.payload.locale
  const href = prefixedSnapshotPath(projection.path, locale, cfg.defaultLocale)
  if (isRoutableContentType(card.pageType) && href === null) return null
  const imageUrl = card.imageMediaId
    ? await snapshotCardImageUrl(ctx, projection, card.imageMediaId)
    : undefined
  return {
    pageId: card.pageId,
    pageType: card.pageType,
    title: card.title,
    ...(card.excerpt ? { excerpt: card.excerpt } : {}),
    ...(imageUrl ? { image: { url: imageUrl } } : {}),
    ...(href ? { href } : {}),
  }
}

async function snapshotCardImageUrl(
  ctx: QueryCtx,
  projection: SnapshotPayload,
  imageMediaId: Id<"media">
): Promise<string | undefined> {
  const refs = await ctx.db
    .query("pagePublicationMediaReferences")
    .withIndex("by_sourceKind_and_sourceId", (q) =>
      q.eq("sourceKind", "current_public").eq("sourceId", projection.snapshotId)
    )
    .take(513)
  if (refs.length > 512) return undefined
  const cardRefs = refs.filter(
    (ref) =>
      ref.sourceKind === "current_public" &&
      ref.referenceKind === "card-image" &&
      ref.pageId === projection.publicPage._id &&
      ref.locale === projection.payload.locale &&
      ref.mediaId === imageMediaId
  )
  if (cardRefs.length !== 1) return undefined
  const ref = cardRefs[0]!
  const media = await ctx.db.get(ref.mediaId)
  if (!media || media.storageId !== ref.storageId) return undefined
  return (await ctx.storage.getUrl(ref.storageId)) ?? undefined
}

/** The index supplies order; eligibility is the full selected-snapshot check.
 * Check the shared reserve before reading the next index candidate, returning
 * the correct newest-first prefix if a long ineligible prefix consumes it.
 */
export async function readRecentSnapshotRelationCards(
  ctx: QueryCtx,
  pageType: PageType,
  locale: string,
  limit: number,
  cfg: LocaleConfig
): Promise<PublicRelationCard[]> {
  const project = await createPublicSnapshotProjectionReader(ctx)
  if (!project) return []
  const candidates = ctx.db
    .query("pageLocalePublicationStates")
    .withIndex(
      "by_hasCurrentSnapshot_and_locale_and_pageType_and_publicSince",
      (q) =>
        q
          .eq("hasCurrentSnapshot", true)
          .eq("locale", locale)
          .eq("pageType", pageType)
          .gt("publicSince", undefined)
    )
    .order("desc")
    [Symbol.asyncIterator]()
  const cards: PublicRelationCard[] = []
  let examined = 0
  while (cards.length < limit) {
    if (await sitemapReadBudgetCrossed(ctx)) {
      console.warn("Recent snapshot cards read budget crossed", {
        examined,
        returned: cards.length,
      })
      break
    }
    const next = await candidates.next()
    if (next.done) break
    examined += 1
    const projection = await project(next.value.pageId, locale)
    if (!projection || projection.publicPage.pageType !== pageType) continue
    const card = await snapshotRelationCard(ctx, projection, cfg)
    if (card) cards.push(card)
  }
  return cards
}

async function buildAncestryPath(
  ctx: QueryCtx | MutationCtx,
  parentId: Id<"pages">,
  cfg: LocaleConfig
): Promise<{
  ancestryPath: string
  hierarchyDepth: number
  localizedAncestryPaths: Record<string, string>
}> {
  const { defaultLocale, enabledLocales } = cfg
  // Per-locale ancestry only differs for non-default locales (the default
  // locale's path is the base `ancestryPath`).
  const nonDefaultLocales = enabledLocales.filter((l) => l !== defaultLocale)

  const baseSegments: string[] = []
  const localizedSegments: Record<string, string[]> = {}
  for (const l of nonDefaultLocales) localizedSegments[l] = []

  let currentId: Id<"pages"> | undefined = parentId
  let depth = 0

  while (currentId && depth < 10) {
    const parent: Doc<"pages"> | null = await ctx.db.get(currentId)
    if (!parent) break
    baseSegments.unshift(parent.slug)
    for (const l of nonDefaultLocales) {
      // Each ancestor contributes its localized slug, falling back to base.
      localizedSegments[l].unshift(parent.localizedSlugs?.[l] ?? parent.slug)
    }
    currentId = parent.parentId
    depth++
  }

  const localizedAncestryPaths: Record<string, string> = {}
  for (const l of nonDefaultLocales) {
    localizedAncestryPaths[l] = "/" + localizedSegments[l].join("/")
  }

  return {
    ancestryPath: "/" + baseSegments.join("/"),
    hierarchyDepth: depth,
    localizedAncestryPaths,
  }
}

/**
 * Recompute `ancestryPath`/`hierarchyDepth` for every descendant of `parentId`.
 * Descendants encode each ancestor's base slug in their path, so after a page's
 * slug or parent changes the subtree below it must be rebuilt or it goes stale.
 * Call this *after* patching the page itself (it re-reads parents from the db).
 */
async function rebuildDescendantAncestry(
  ctx: MutationCtx,
  parentId: Id<"pages">,
  cfg: LocaleConfig
): Promise<void> {
  const children = await ctx.db
    .query("pages")
    .withIndex("by_parent", (q) => q.eq("parentId", parentId))
    .collect()
  if (children.length === 0) return
  // All direct children share the same ancestry (their parent is `parentId`).
  const { ancestryPath, hierarchyDepth, localizedAncestryPaths } =
    await buildAncestryPath(ctx, parentId, cfg)
  for (const child of children) {
    if (child.deletedAt !== undefined) continue
    await occurrenceUsageWrites(ctx).patch(child._id, {
      ancestryPath,
      hierarchyDepth,
      localizedAncestryPaths,
      updatedAt: Date.now(),
    })
    await rebuildDescendantAncestry(ctx, child._id, cfg)
  }
}

// ============================================================
// Queries
// ============================================================

export const getById = query({
  args: { id: v.id("pages") },
  returns: v.union(pageDocValidator, v.null()),
  handler: async (ctx, { id }) => {
    // The legacy full Page document is not a publication read once the
    // snapshot authority is active. Returning it here would let callers
    // observe mutable fields alongside the immutable public boundary.
    if ((await readPublicationAuthority(ctx)) !== "legacy") return null
    const page = await ctx.db.get(id)
    if (!page) return null
    if (
      await canReadPrivate(ctx, page.pageType, `pages.${page.pageType}:list`)
    ) {
      return page
    }
    return null
  },
})

/**
 * Legacy full-document published reader. This remains for authenticated
 * internal/admin flows only; anonymous rendering must use `getPublicPageById`.
 */
export const getPublishedById = query({
  args: {
    id: v.id("pages"),
  },
  returns: v.union(pageDocValidator, v.null()),
  handler: async (ctx, { id }) => {
    const page = await ctx.db.get(id)
    if (
      !page ||
      !isPubliclyReadablePage(page) ||
      !(await canReadPrivate(ctx, page.pageType, `pages.${page.pageType}:list`))
    ) {
      return null
    }
    return page
  },
})

/**
 * Anonymous page reader: one Published Snapshot-shaped, requested-locale
 * projection. It never shares the full `pageDocValidator` response contract.
 */
export const getPublicPageById = query({
  args: {
    id: v.id("pages"),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.union(publicPageValidator, v.null()),
  handler: async (ctx, { id, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      const cfg = await getLocaleConfig(ctx)
      if (!cfg.enabledLocales.includes(locale)) return null
      const projection = await readCurrentSnapshotProjection(ctx, id, locale)
      return (projection?.publicPage ?? null) as never
    }
    if (authority === "invalid") return null
    const page = await ctx.db.get(id)
    if (!page || !isPubliclyReadablePage(page)) return null
    const cfg = await getLocaleConfig(ctx)
    if (!cfg.enabledLocales.includes(locale)) return null
    if (!isRoutableContentType(page.pageType)) return null
    return projectPublicPage(page, locale)
  },
})

/**
 * ADR-0041 §5 — admin-only staged preview projection.
 *
 * With snapshot authority, uses the editor's current Shared/Working Draft
 * projection. Legacy authority retains the `pageStaging` overlay. Consumed by
 * `/admin/pages/[id]/preview` (the primary preview affordance per §5),
 * where the same public renderer components are reused with staging
 * injected as the data source. No public read of `pageStaging` — this
 * query is gated on the same permission the editor uses.
 *
 * `hasStaging` lets the preview UI badge staged vs. live-only rows
 * without a second round-trip.
 */
export const getStagedPreviewById = query({
  args: { id: v.id("pages") },
  returns: v.union(
    v.object({
      page: pageDocValidator,
      hasStaging: v.boolean(),
      stagingUpdatedAt: v.optional(v.number()),
    }),
    v.null()
  ),
  handler: async (
    ctx,
    { id }
  ): Promise<{
    page: Doc<"pages">
    hasStaging: boolean
    stagingUpdatedAt?: number
  } | null> => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(id)
    if (!page) return null
    if (!isActiveContentType(page.pageType)) return null
    await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return null
    if (authority === "snapshot_active") {
      const draft: {
        page: Doc<"pages">
        hasStaging: boolean
        stagingUpdatedAt?: number
      } | null = await ctx.runQuery(api.cms.pages.getForEdit, { id })
      if (!draft) return null
      return {
        page: draft.page,
        hasStaging: draft.hasStaging,
        ...(draft.stagingUpdatedAt === undefined
          ? {}
          : { stagingUpdatedAt: draft.stagingUpdatedAt }),
      }
    }
    const staging = await getStagingByPageId(ctx, id)
    const overlaid = overlayStagingOnPage(page, staging)
    return {
      page: overlaid,
      hasStaging: staging !== null,
      ...(staging ? { stagingUpdatedAt: staging.updatedAt } : {}),
    }
  },
})

/**
 * ADR-0041 §5 + §Migration step 2 (item 1) — editor reader overlay.
 *
 * Same overlay shape as `getStagedPreviewById`, but permission-gated at
 * list scope via `canReadPrivate`. Unlike `getById`, this editor projection
 * has no published-page fast path: a public live row never authorizes a read
 * of its Working Draft or Shared Draft. The editor page needs a reader that
 * (a) surfaces staged content — so the operator doesn't see phantom "changes
 * not persisting" post-save — and (b) does not raise the permission bar above
 * what the pre-ADR editor page read required, so viewer/list-only roles can
 * still open a page in the editor without a thrown error (they can view but
 * not save).
 *
 * Kept separate from `getStagedPreviewById` because the admin preview
 * route legitimately gates on `update` (only editors preview) — sharing
 * one query would either regress that gate or double-widen this one.
 * `hasStaging` + `stagingUpdatedAt` are the client's OCC token + badge
 * inputs; missing `stagingUpdatedAt` = lazy-create semantics for the
 * first `updateDraft` call.
 */
function localeTitle(localized: Record<string, unknown>): {
  title?: string
} {
  const title =
    typeof localized.title === "string" ? localized.title.trim() : ""
  return title ? { title } : {}
}

export const getForEdit = query({
  args: { id: v.id("pages") },
  returns: v.union(
    v.object({
      // ADR-0041 Deploy 2 PR B — `pageWithStagedOverlayValidator` admits
      // the staged `scheduledAt` that `overlayStagingOnPage` folds into
      // the returned page. The editor reads `page.scheduledAt` for its
      // schedule input + header badge; without the overlay the schema
      // arm no longer carries the field.
      page: pageWithStagedOverlayValidator,
      hasStaging: v.boolean(),
      stagingUpdatedAt: v.optional(v.number()),
      publication: v.optional(
        v.object({
          authority: v.literal("snapshot_active"),
          lifecycleGeneration: v.number(),
          sharedDraftGeneration: v.number(),
          locales: v.array(adminPageLocaleValidator),
        })
      ),
    }),
    v.null()
  ),
  handler: async (ctx, { id }) => {
    const page = await ctx.db.get(id)
    if (!page) return null
    if (!isActiveContentType(page.pageType)) return null
    if (
      !(await canReadPrivate(ctx, page.pageType, `pages.${page.pageType}:list`))
    ) {
      return null
    }
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      const [pageStates, sharedRows, localeStates, settings] =
        await Promise.all([
          ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", id))
            .take(2),
          ctx.db
            .query("pageSharedDrafts")
            .withIndex("by_pageId", (q) => q.eq("pageId", id))
            .take(2),
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", id))
            .take(513),
          ctx.db.query("siteSettings").first(),
        ])
      if (localeStates.length > 512)
        throw new ConvexError("PUBLICATION_LOCALE_LIMIT")
      if (pageStates.length !== 1 || sharedRows.length !== 1) return null
      const pageState = pageStates[0]!
      if (pageState.lifecycleState === "trashed") return null
      const shared = sharedRows[0]!
      if (shared.pageType !== page.pageType) return null
      const content: Record<string, unknown> = {}
      const localizedSlugs: Record<string, string> = {}
      let hasLocaleDraft = false
      const sources = new Map<string, AdminLocaleSource>()
      let updatedAt = Math.max(pageState.updatedAt, shared.updatedAt)
      for (const state of localeStates) {
        const drafts = await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", id).eq("locale", state.locale)
          )
          .take(2)
        if (drafts.length > 1) return null
        let slug: string | undefined
        let localized: Record<string, unknown> | undefined
        if (
          drafts.length === 1 &&
          drafts[0]!.generation === state.draftGeneration
        ) {
          hasLocaleDraft = true
          updatedAt = Math.max(updatedAt, drafts[0]!.updatedAt)
          slug = drafts[0]!.slug
          localized = drafts[0]!.content as unknown as Record<string, unknown>
          sources.set(state.locale, {
            hasWorkingDraft: true,
            hasVerifiedBase: false,
            ...localeTitle(localized),
            slug,
          })
        } else if (state.draftBaseSnapshotId) {
          const base = await readFrozenSnapshotProjection(
            ctx,
            state.draftBaseSnapshotId,
            id,
            state.locale
          )
          if (base) {
            slug = base.payload.localized.slug
            localized = base.payload.localized.content
            sources.set(state.locale, {
              hasWorkingDraft: false,
              hasVerifiedBase: true,
              ...localeTitle(localized),
              slug,
            })
          }
        }
        if (localized) content[state.locale] = localized
        if (slug) localizedSlugs[state.locale] = slug
      }
      const defaultLocale =
        settings?.defaultLocale ?? localeStates[0]?.locale ?? "en"
      const defaultSlug = localizedSlugs[defaultLocale] ?? page.slug
      delete localizedSlugs[defaultLocale]
      const publishedAt = localeStates.reduce<number | undefined>(
        (latest, state) =>
          state.currentPublishedAt !== undefined &&
          (latest === undefined || state.currentPublishedAt > latest)
            ? state.currentPublishedAt
            : latest,
        undefined
      )
      // Identity shell only: every authored field comes from successor drafts,
      // so a value cleared there (e.g. `parentId`) cannot reappear from the
      // retained legacy Page row.
      const projected = {
        _id: page._id,
        _creationTime: page._creationTime,
        pageType: page.pageType,
        createdAt: page.createdAt,
        ...(page.createdBy === undefined ? {} : { createdBy: page.createdBy }),
        ...shared.descriptor,
        ...shared.system,
        updatedAt,
        slug: defaultSlug,
        localizedSlugs,
        content,
        status:
          pageState.lifecycleState === "archived"
            ? "archived"
            : publishedAt !== undefined
              ? "published"
              : "draft",
        ...(publishedAt === undefined ? {} : { publishedAt }),
      } as Doc<"pages">
      const sharedParentId = (shared.system as { parentId?: Id<"pages"> })
        .parentId
      const locales = await projectAdminPageLocales(ctx, {
        page,
        ...(sharedParentId ? { parentId: sharedParentId } : {}),
        ...(settings?.homePageId ? { homePageId: settings.homePageId } : {}),
        localeStates,
        sources,
      })
      return {
        page: projected,
        hasStaging: hasLocaleDraft,
        publication: {
          authority: "snapshot_active" as const,
          lifecycleGeneration: pageState.lifecycleGeneration,
          sharedDraftGeneration: shared.generation,
          locales,
        },
      }
    }
    if (authority === "invalid") return null
    const staging = await getStagingByPageId(ctx, id)
    const overlaid = overlayStagingOnPage(page, staging)
    return {
      page: overlaid,
      hasStaging: staging !== null,
      ...(staging ? { stagingUpdatedAt: staging.updatedAt } : {}),
    }
  },
})

/**
 * PUBLIC — post byline resolver. Routes through the C2 central resolver
 * (`resolveReferenceCardForDoc`) for the display name/subtitle/href seat,
 * then resolves the card's `imageMediaId` to a URL for the avatar. Draft /
 * archived / soft-deleted / non-author rows resolve to `null` via the
 * central resolver's "no href on non-published or non-routable" invariant
 * combined with `isPubliclyReadablePage` (ADR-0037 §4). No permission gate;
 * this is what a public post page consumes.
 *
 * The requested locale is strict: an author lacking that locale is absent
 * rather than borrowing a default-locale title or role.
 */
export const getPublicByline = query({
  args: {
    authorPageId: v.id("pages"),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.union(
    v.object({
      name: v.string(),
      roleTitle: v.optional(v.string()),
      avatarUrl: v.union(v.string(), v.null()),
    }),
    v.null()
  ),
  handler: async (ctx, { authorPageId, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return null
    if (authority === "snapshot_active") {
      const snapshot = await readCurrentSnapshotProjection(
        ctx,
        authorPageId,
        locale
      )
      const page = snapshotPublicPage(snapshot?.publicPage)
      if (!snapshot || !page || page.pageType !== "author") return null
      const card = projectSnapshotReferenceCard(snapshot)
      const localized = page.content[locale]
      const roleTitle =
        localized &&
        typeof localized === "object" &&
        "roleTitle" in localized &&
        typeof localized.roleTitle === "string"
          ? localized.roleTitle
          : undefined
      return {
        name: page.name,
        ...(roleTitle ? { roleTitle } : {}),
        avatarUrl:
          (card?.imageMediaId
            ? await snapshotCardImageUrl(ctx, snapshot, card.imageMediaId)
            : undefined) ?? null,
      }
    }
    const page = await ctx.db.get(authorPageId)
    const cfg = await getLocaleConfig(ctx)
    if (
      !page ||
      page.pageType !== "author" ||
      !isActiveContentType(page.pageType) ||
      !cfg.enabledLocales.includes(locale)
    ) {
      return null
    }
    const card = projectPublicReferenceCard(page, locale)
    if (!card) return null

    let avatarUrl: string | null = null
    if (card.imageMediaId) {
      const media = await ctx.db.get(card.imageMediaId)
      if (media && media.deletedAt === undefined) {
        avatarUrl = media.url
      }
    }

    return {
      name: card.title,
      ...(card.excerpt ? { roleTitle: card.excerpt } : {}),
      avatarUrl,
    }
  },
})

export const getPrePublishChecklist = query({
  args: { pageId: v.id("pages"), locale: v.optional(v.string()) },
  returns: prePublishChecklistValidator,
  handler: async (ctx, { pageId, locale }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    if ((await readPublicationAuthority(ctx)) === "snapshot_active") {
      const cfg = await getLocaleConfig(ctx)
      const requestedLocale = locale ?? cfg.defaultLocale
      if (!cfg.enabledLocales.includes(requestedLocale)) {
        throw new ConvexError("LOCALE_NOT_ENABLED")
      }
      const [sharedRows, stateRows, draftRows] = await Promise.all([
        ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .take(2),
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", requestedLocale)
          )
          .take(2),
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", requestedLocale)
          )
          .take(2),
      ])
      if (
        sharedRows.length !== 1 ||
        stateRows.length > 1 ||
        draftRows.length > 1
      ) {
        throw new ConvexError("PAGE_PUBLICATION_DRAFT_INVALID")
      }
      let slug: string | undefined
      let content: Record<string, unknown> | undefined
      if (draftRows.length === 1) {
        slug = draftRows[0]!.slug
        content = draftRows[0]!.content as unknown as Record<string, unknown>
      } else if (stateRows[0]?.draftBaseSnapshotId) {
        const base = await readFrozenSnapshotProjection(
          ctx,
          stateRows[0].draftBaseSnapshotId,
          pageId,
          requestedLocale
        )
        slug = base?.payload.localized.slug
        content = base?.payload.localized.content
      }
      if (!slug || !content) throw new ConvexError("PAGE_LOCALE_DRAFT_REQUIRED")
      const shared = sharedRows[0]!
      const shape = {
        ...page,
        ...shared.descriptor,
        ...shared.system,
        slug,
        content: { [requestedLocale]: content },
      } as Doc<"pages">
      return buildPrePublishChecklistWithReferences(
        ctx,
        shape,
        {
          ...cfg,
          defaultLocale: requestedLocale,
          enabledLocales: [requestedLocale],
        },
        "readiness"
      )
    }
    // Readiness always describes the saved Working Draft. Published pages can
    // also have staging changes. Reference targets are checked against public
    // availability here so the editor blocks a publish the server is certain
    // to refuse.
    const shape = overlayStagingOnPage(
      page,
      await getStagingByPageId(ctx, pageId)
    )
    return await buildPrePublishChecklistWithReferences(
      ctx,
      shape,
      await getLocaleConfig(ctx),
      "readiness"
    )
  },
})

export const listActiveEditors = query({
  args: {
    pageId: v.id("pages"),
    now: v.optional(v.number()),
  },
  returns: v.array(pagePresenceDocValidator),
  handler: async (ctx, { pageId, now }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    return await listActivePagePresence(ctx, pageId, now)
  },
})

export const getPageEditorLock = query({
  args: {
    pageId: v.id("pages"),
    now: v.optional(v.number()),
  },
  returns: pageEditorLockStateValidator,
  handler: async (ctx, { pageId, now }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    return await getPageEditorLockState(ctx, pageId, auth.tokenIdentifier, now)
  },
})

export const getBySlug = query({
  args: {
    slug: v.string(),
  },
  returns: v.union(pageDocValidator, v.null()),
  handler: async (ctx, { slug }) => {
    const page = await ctx.db
      .query("pages")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first()
    if (!page || page.deletedAt !== undefined) return null
    if (
      !(await canReadPrivate(ctx, page.pageType, `pages.${page.pageType}:list`))
    ) {
      return null
    }
    return page
  },
})

export const isSlugAvailable = query({
  args: {
    slug: v.string(),
    excludePageId: v.optional(v.id("pages")),
  },
  returns: v.object({ available: v.boolean(), slug: v.string() }),
  handler: async (ctx, { slug, excludePageId }) => {
    await requireAnyPageTypePermission(ctx, "create")
    // Legacy slugs carry no successor meaning, and the scan is unbounded;
    // under snapshot authority the route claim is checked at publish.
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_USE_PUBLISH_LOCALE")
    }
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const taken = await isSlugTaken(ctx, slug, excludePageId)
    return { available: !taken, slug }
  },
})

export const list = query({
  args: {
    status: v.optional(statusValidator),
    pageType: v.optional(pageTypeValidator),
    includeDeleted: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(pageWithStagedOverlayValidator),
  handler: async (ctx, args) => {
    await requireAnyPageTypePermission(ctx, "list")
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      throw new ConvexError("SNAPSHOT_ADMIN_PROJECTION_REQUIRED")
    }
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const allowedTypes = permittedPageTypes()
    // If the caller asked for a specific type they can't list, fall back to
    // requirePagePermission so they get UNAUTHORIZED (matches admin/editor
    // regression: passing a type is a targeted read).
    if (args.pageType && !allowedTypes.has(args.pageType)) {
      await requirePagePermission(ctx, args.pageType, "list")
    }
    let dbQuery

    if (args.pageType && args.status) {
      dbQuery = ctx.db
        .query("pages")
        .withIndex("by_pageType_status", (q) =>
          q.eq("pageType", args.pageType!).eq("status", args.status!)
        )
    } else if (args.status) {
      dbQuery = ctx.db
        .query("pages")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
    } else {
      dbQuery = ctx.db.query("pages")
    }

    const limit = clampLimit(
      args.limit,
      DEFAULT_PAGE_LIST_LIMIT,
      MAX_PAGE_LIST_LIMIT
    )
    let results = await dbQuery.take(limit)

    if (!args.includeDeleted) {
      results = results.filter((p) => p.deletedAt === undefined)
    }
    // The Community owner may list every active type, but never a
    // registered-only storage arm that this release excludes.
    results = results.filter((p) => allowedTypes.has(p.pageType))

    return await enrichWithStagingOverlay(ctx, results)
  },
})

/**
 * Row shape for the parent picker and the command palette.
 *
 * IMPORTANT — what this does and does not save. Convex has no projection
 * pushdown: the handler below still reads full `pages` documents, so this
 * validator does NOT reduce database I/O. What it reduces is the payload
 * streamed to the client, which bills against the separate data-egress limit
 * (also 1 GB/mo on the free plan). A full page document carries every slice
 * body for every locale; these six fields are a fraction of that.
 *
 * Reducing the *database* I/O of these callers is a separate lever, applied at
 * the callsites: the parent picker reads once at mount instead of holding a
 * subscription that re-executes on every save, and the command palette does
 * not query at all until it is opened.
 */
const pageSummaryRowValidator = v.object({
  _id: v.id("pages"),
  parentId: v.optional(v.id("pages")),
  slug: v.string(),
  localizedSlugs: v.optional(v.record(v.string(), v.string())),
  // Staging-overlaid, so never-published drafts (whose `content` is still
  // empty) resolve to their staged title rather than falling back to the slug.
  localizedTitles: v.record(v.string(), v.string()),
  status: statusValidator,
  pageType: pageTypeValidator,
  updatedAt: v.number(),
})

/**
 * Lightweight sibling of `list` for the parent picker and command palette.
 *
 * Same permission model and same staging overlay as `list` — only the returned
 * shape differs (see `pageSummaryRowValidator` for what that does and does not
 * save). Callers that need slice bodies must keep using `list`.
 */
export const listSummaries = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(pageSummaryRowValidator),
  handler: async (ctx, args) => {
    await requireAnyPageTypePermission(ctx, "list")
    const allowedTypes = permittedPageTypes()

    const limit = clampLimit(
      args.limit,
      DEFAULT_PAGE_LIST_LIMIT,
      MAX_PAGE_LIST_LIMIT
    )
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      const states = await ctx.db.query("pagePublicationPageStates").take(limit)
      const rows = []
      for (const state of states) {
        if (state.lifecycleState === "trashed") continue
        const row = await snapshotAdminPageRow(ctx, state)
        if (!row || !allowedTypes.has(row.pageType)) continue
        rows.push({
          _id: row._id,
          ...(row.parentId ? { parentId: row.parentId } : {}),
          slug: row.slug,
          localizedSlugs: row.localizedSlugs,
          localizedTitles: row.localizedTitles,
          status: row.status,
          pageType: row.pageType,
          updatedAt: row.updatedAt,
        })
      }
      return rows
    }
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const results = (await ctx.db.query("pages").take(limit)).filter(
      (page) => page.deletedAt === undefined && allowedTypes.has(page.pageType)
    )

    const enriched = await enrichWithStagingOverlay(ctx, results)
    return enriched.map((page) => ({
      _id: page._id,
      ...(page.parentId !== undefined ? { parentId: page.parentId } : {}),
      slug: page.slug,
      ...(page.localizedSlugs !== undefined
        ? { localizedSlugs: page.localizedSlugs }
        : {}),
      // Prefer real content titles; fall back to the staged denormalized ones
      // so a never-published draft shows its title instead of its slug.
      localizedTitles: {
        ...(page.effectiveTitles ?? {}),
        ...localizedTitlesForPage(page),
      },
      status: page.status,
      pageType: page.pageType,
      updatedAt: page.updatedAt,
    }))
  },
})

/** Shape of a `.paginate()` result for `returns:` validators. */
const paginatedPagesValidator = v.object({
  page: v.array(pageWithStagedOverlayValidator),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null())
  ),
})

/**
 * Cursor-paginated admin pages list (plan 023 Phase 4 #2) for
 * `usePaginatedQuery`, newest first. Soft-deleted pages are filtered out of
 * each page of results (never surfaced here — the trash view asks for them
 * explicitly via `list`).
 */
export const listPaginated = query({
  args: {
    paginationOpts: paginationOptsValidator,
    status: v.optional(statusValidator),
    pageType: v.optional(pageTypeValidator),
  },
  returns: paginatedPagesValidator,
  handler: async (ctx, args) => {
    await requireAnyPageTypePermission(ctx, "list")
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      throw new ConvexError("SNAPSHOT_ADMIN_PROJECTION_REQUIRED")
    }
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const allowedTypes = permittedPageTypes()
    if (args.pageType && !allowedTypes.has(args.pageType)) {
      await requirePagePermission(ctx, args.pageType, "list")
    }
    let dbQuery
    if (args.pageType && args.status) {
      dbQuery = ctx.db
        .query("pages")
        .withIndex("by_pageType_status", (q) =>
          q.eq("pageType", args.pageType!).eq("status", args.status!)
        )
    } else if (args.pageType) {
      // Prefix-only lookup on `by_pageType_status` so a `pageType` filter
      // WITHOUT a status filter still exercises the index instead of falling
      // through to a full-table scan. C4's URL-driven Content sidebar lands
      // on `?type=<slug>` with status = "all", so this branch is the hot
      // path for per-type navigation.
      dbQuery = ctx.db
        .query("pages")
        .withIndex("by_pageType_status", (q) =>
          q.eq("pageType", args.pageType!)
        )
    } else if (args.status) {
      dbQuery = ctx.db
        .query("pages")
        .withIndex("by_status", (q) => q.eq("status", args.status!))
    } else {
      dbQuery = ctx.db.query("pages")
    }
    const result = await dbQuery.order("desc").paginate(args.paginationOpts)
    const filtered = result.page.filter(
      (p) => p.deletedAt === undefined && allowedTypes.has(p.pageType)
    )
    return {
      ...result,
      page: await enrichWithStagingOverlay(ctx, filtered),
    }
  },
})

export const listLinkablePages = query({
  args: {
    locale: v.optional(v.string()),
    search: v.optional(v.string()),
    includeDrafts: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(pagePickerRowValidator),
  handler: async (ctx, { locale, search, includeDrafts = true, limit }) => {
    await requireAnyPageTypePermission(ctx, "list")
    const allowedTypes = permittedPageTypes()
    const rowLimit = clampLimit(
      limit,
      DEFAULT_PAGE_PICKER_LIMIT,
      MAX_PAGE_PICKER_LIMIT
    )
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const rows: PagePickerRow[] = []
    if (authority === "snapshot_active") {
      const states: Doc<"pagePublicationPageStates">[] = []
      if (!includeDrafts && locale) {
        const published = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
            q.eq("hasCurrentSnapshot", true).eq("locale", locale)
          )
          .take(rowLimit)
        for (const entry of published) {
          const matches = await ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", entry.pageId))
            .take(2)
          if (matches.length === 1 && matches[0]!.lifecycleState === "active") {
            states.push(matches[0]!)
          }
        }
      } else {
        states.push(
          ...(await ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_lifecycleState", (q) =>
              q.eq("lifecycleState", "active")
            )
            .take(rowLimit))
        )
      }
      for (const state of states) {
        const row = await snapshotPagePickerRow(ctx, state)
        if (row) rows.push(row)
      }
    } else {
      const candidateLimit = Math.min(rowLimit * 4, PAGE_PICKER_CANDIDATE_LIMIT)
      const candidates = includeDrafts
        ? await ctx.db.query("pages").take(candidateLimit)
        : await ctx.db
            .query("pages")
            .withIndex("by_status", (q) => q.eq("status", "published"))
            .take(candidateLimit)
      const active = candidates.filter(
        (page) =>
          page.deletedAt === undefined &&
          page.status !== "archived" &&
          allowedTypes.has(page.pageType)
      )
      rows.push(
        ...(await enrichWithStagingOverlay(ctx, active)).map(pagePickerRow)
      )
    }
    const normalizedSearch = search?.trim().toLowerCase()
    return rows
      .filter((row) => {
        if (!allowedTypes.has(row.pageType)) return false
        if (locale && !row.localizedTitles[locale]?.trim()) return false
        if (
          !includeDrafts &&
          (locale
            ? row.localePublicationStates[locale] !== "published"
            : !Object.values(row.localePublicationStates).includes("published"))
        )
          return false
        if (!normalizedSearch) return true
        const text = locale
          ? [
              row.localizedTitles[locale],
              row.localizedSlugs?.[locale] ?? row.slug,
            ]
          : [
              ...Object.values(row.localizedTitles),
              row.slug,
              ...Object.values(row.localizedSlugs ?? {}),
            ]
        return text.some((value) =>
          value?.toLowerCase().includes(normalizedSearch)
        )
      })
      .slice(0, rowLimit)
  },
})

/**
 * Resolve an already-selected page independently from the bounded picker
 * result. A picker omission is not evidence that its stored page id was
 * deleted: a valid target may fall after either picker window. The response
 * deliberately withholds title, slug, and type when the actor cannot list the
 * target's page type.
 */
export const getLinkablePageSelection = query({
  args: { pageId: v.id("pages") },
  returns: linkablePageSelectionValidator,
  handler: async (ctx, { pageId }) => {
    await requireAnyPageTypePermission(ctx, "list")
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const page = await ctx.db.get("pages", pageId)
    if (!page || page.deletedAt !== undefined) {
      return { status: "missing" as const }
    }
    const allowedTypes = permittedPageTypes()
    if (!allowedTypes.has(page.pageType)) {
      return { status: "unavailable" as const }
    }
    if (authority === "snapshot_active") {
      const states = await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .take(2)
      if (states.length !== 1) return { status: "unavailable" as const }
      if (states[0]!.lifecycleState === "trashed")
        return { status: "missing" as const }
      const row = await snapshotPagePickerRow(ctx, states[0]!)
      return row
        ? { status: "available" as const, page: row }
        : { status: "unavailable" as const }
    }
    const [enriched] = await enrichWithStagingOverlay(ctx, [page])
    return { status: "available" as const, page: pagePickerRow(enriched!) }
  },
})

// ─── Sitemap readers (M05 C5a) ──────────────────────────────────────────────
//
// Contract "Sitemap partitions": the index lists the children of the one
// `ready` manifest built for the pinned language version, or one version-0
// child per enabled locale while none exists. A child reads its partition's
// half-open `_creationTime` range with `take(CEILING + 1)`, never a cursor,
// and emits SEO alternates only (M21): a verified current URL that is not
// `noIndex`. An overflow is never silent: it is `unavailable` (no-store 503).

const sitemapAlternateValidator = v.object({
  locale: v.string(),
  url: v.string(),
})
const sitemapEntryValidator = v.object({
  url: v.string(),
  lastModified: v.number(),
  priority: v.number(),
  alternates: v.array(sitemapAlternateValidator),
})
const sitemapChildValidator = v.union(
  v.object({
    status: v.literal("ok"),
    entries: v.array(sitemapEntryValidator),
  }),
  v.object({ status: v.literal("not_found") }),
  v.object({
    status: v.literal("unavailable"),
    reason: v.union(
      v.literal("overflow"),
      v.literal("oversized"),
      v.literal("read_budget")
    ),
  })
)
const sitemapIndexValidator = v.object({
  manifestVersion: v.number(),
  locales: v.array(v.object({ locale: v.string(), partitions: v.number() })),
})

export type SitemapEntry = Infer<typeof sitemapEntryValidator>
export type SitemapChild = Infer<typeof sitemapChildValidator>

/** No more alternates than supported locales can exist (contract ≤ 16). */
const SITEMAP_MAX_ALTERNATES = SUPPORTED_LOCALES.length

/**
 * Half of every read limit, the M23 reserve (contract "Worker transaction
 * ceilings"). `SITEMAP_PARTITION_CEILING` is measured to fit inside it; a
 * heavier partition stops here and reports `read_budget` instead of hitting
 * the hard limit.
 */
async function sitemapReadBudgetCrossed(ctx: QueryCtx): Promise<boolean> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return (
    [metrics.documentsRead, metrics.bytesRead, metrics.databaseQueries] as const
  ).some(({ used, remaining }) => remaining < (used + remaining) / 2)
}

/**
 * Renders one locale's state rows as sitemap entries with reachable SEO
 * alternates (M21). Every URL uses the public page's full current-snapshot
 * projection, including same-locale ancestry. Returns `read_budget` when the
 * M23 reserve is crossed, so a child never emits a partial page.
 */
export async function renderSitemapRows(
  ctx: QueryCtx,
  rows: readonly Doc<"pageLocalePublicationStates">[],
  locale: string,
  cfg: LocaleConfig
): Promise<SitemapEntry[] | "read_budget"> {
  if (cfg.enabledLocales.length > SITEMAP_MAX_ALTERNATES) {
    throw new ConvexError("SITEMAP_LOCALE_BOUND_EXCEEDED")
  }
  const project = await createPublicSnapshotProjectionReader(ctx)
  if (!project) return []
  const entries: SitemapEntry[] = []
  for (const row of rows) {
    const projection = await project(row.pageId, locale)
    const page = snapshotPublicPage(projection?.publicPage)
    const url =
      projection && page && page.seo?.noIndex !== true
        ? prefixedSnapshotPath(projection.path, locale, cfg.defaultLocale)
        : null
    if (url !== null) {
      const alternates: SitemapEntry["alternates"] = []
      if (cfg.enabledLocales.length > 1) {
        for (const target of cfg.enabledLocales) {
          if (target === locale) {
            alternates.push({ locale, url })
            continue
          }
          const alternate = await project(row.pageId, target)
          const alternatePage = snapshotPublicPage(alternate?.publicPage)
          if (
            !alternate ||
            !alternatePage ||
            alternatePage.seo?.noIndex === true
          )
            continue
          alternates.push({
            locale: target,
            url: prefixedSnapshotPath(
              alternate.path,
              target,
              cfg.defaultLocale
            )!,
          })
        }
      }
      entries.push({
        url,
        lastModified: row.currentPublishedAt ?? 0,
        priority: cfg.homePageId === row.pageId ? 1.0 : 0.5,
        alternates,
      })
    }
    if (await sitemapReadBudgetCrossed(ctx)) return "read_budget"
  }
  return entries
}

/** One locale's rows in `[low, high)`; a null bound is left out. */
export function readSitemapRange(
  ctx: QueryCtx,
  locale: string,
  low: number | null,
  high: number | null,
  limit: number
): Promise<Doc<"pageLocalePublicationStates">[]> {
  return ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_hasCurrentSnapshot_and_locale", (q) => {
      const prefix = q.eq("hasCurrentSnapshot", true).eq("locale", locale)
      if (low !== null && high !== null)
        return prefix.gte("_creationTime", low).lt("_creationTime", high)
      if (low !== null) return prefix.gte("_creationTime", low)
      if (high !== null) return prefix.lt("_creationTime", high)
      return prefix
    })
    .take(limit)
}

/**
 * Legacy publication authority has no partition keyspace: its one version-0
 * child per locale lists the published Page rows, bounded like every child.
 */
async function readLegacySitemapChild(
  ctx: QueryCtx,
  locale: string,
  cfg: LocaleConfig
): Promise<SitemapChild> {
  const pages = await ctx.db
    .query("pages")
    .withIndex("by_status", (q) => q.eq("status", "published"))
    .take(SITEMAP_PARTITION_CEILING + 1)
  if (pages.length > SITEMAP_PARTITION_CEILING) {
    return { status: "unavailable", reason: "overflow" }
  }
  const entries: SitemapEntry[] = []
  for (const page of pages) {
    if (page.deletedAt !== undefined || !isRoutableContentType(page.pageType))
      continue
    const urls = localizedUrlsForPage(page, cfg)
    const url = urls[locale]
    if (url === undefined) continue
    entries.push({
      url,
      lastModified: page.updatedAt,
      priority: cfg.homePageId === page._id ? 1.0 : 0.5,
      alternates:
        cfg.enabledLocales.length > 1
          ? cfg.enabledLocales.flatMap((target) =>
              urls[target] === undefined
                ? []
                : [{ locale: target, url: urls[target]! }]
            )
          : [],
    })
  }
  return { status: "ok", entries }
}

/** The one `ready` manifest built for `languageVersion`, or null. */
async function readReadySitemapManifest(
  ctx: QueryCtx,
  languageVersion: number
): Promise<Doc<"siteSitemapManifests"> | null> {
  const rows = await ctx.db
    .query("siteSitemapManifests")
    .withIndex("by_status_and_languageVersion", (q) =>
      q.eq("status", "ready").eq("languageVersion", languageVersion)
    )
    .take(2)
  return rows.length === 1 ? rows[0]! : null
}

/**
 * The sitemap index for one pinned language version: the ready manifest's
 * partition count per enabled locale, or manifest version 0 with one child
 * per enabled locale. Ordinals are contiguous, so one descending read per
 * locale counts its partitions.
 */
export const getSitemapIndex = query({
  args: { languageVersion: v.number() },
  returns: sitemapIndexValidator,
  handler: async (ctx, { languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const authority = await readPublicationAuthority(ctx)
    const cfg = await getLocaleConfig(ctx)
    const versionZero = {
      manifestVersion: 0,
      locales: cfg.enabledLocales.map((locale) => ({ locale, partitions: 1 })),
    }
    if (authority === "invalid") return { manifestVersion: 0, locales: [] }
    if (authority !== "snapshot_active") return versionZero
    const manifest = await readReadySitemapManifest(ctx, languageVersion)
    if (!manifest) return versionZero
    const locales = []
    for (const locale of cfg.enabledLocales) {
      const last = await ctx.db
        .query("siteSitemapPartitions")
        .withIndex("by_manifestVersion_and_locale_and_ordinal", (q) =>
          q.eq("manifestVersion", manifest.manifestVersion).eq("locale", locale)
        )
        .order("desc")
        .take(1)
      // A ready manifest closes every locale enabled at its version, and
      // snapshot authority refuses locale edits outside a language operation,
      // so a missing locale is corrupt state: fail loudly, never omit it.
      if (last.length !== 1) {
        throw new ConvexError("SITEMAP_MANIFEST_INCOMPLETE")
      }
      locales.push({ locale, partitions: last[0]!.ordinal + 1 })
    }
    return { manifestVersion: manifest.manifestVersion, locales }
  },
})

/**
 * One sitemap child (contract "Child handler"). `not_found` covers a locale
 * not enabled at the pinned version, version 0 once a ready manifest exists,
 * and a collected or unknown manifest or partition; the route answers each
 * with a no-store 404 so the crawler refetches the index.
 */
export const getSitemapChild = query({
  args: {
    languageVersion: v.number(),
    manifestVersion: v.number(),
    locale: v.string(),
    ordinal: v.number(),
  },
  returns: sitemapChildValidator,
  handler: async (
    ctx,
    { languageVersion, manifestVersion, locale, ordinal }
  ): Promise<SitemapChild> => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const notFound = { status: "not_found" } as const
    const cfg = await getLocaleConfig(ctx)
    if (!cfg.enabledLocales.includes(locale)) return notFound
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) return notFound
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return notFound
    if (authority !== "snapshot_active") {
      return manifestVersion === 0 && ordinal === 0
        ? readLegacySitemapChild(ctx, locale, cfg)
        : notFound
    }
    let low: number | null = null
    let high: number | null = null
    if (manifestVersion === 0) {
      if (ordinal !== 0) return notFound
      if (await readReadySitemapManifest(ctx, languageVersion)) return notFound
    } else {
      const manifests = await ctx.db
        .query("siteSitemapManifests")
        .withIndex("by_manifestVersion", (q) =>
          q.eq("manifestVersion", manifestVersion)
        )
        .take(2)
      const manifest = manifests.length === 1 ? manifests[0]! : null
      if (
        !manifest ||
        (manifest.status !== "ready" && manifest.status !== "superseded")
      ) {
        return notFound
      }
      const partitions = await ctx.db
        .query("siteSitemapPartitions")
        .withIndex("by_manifestVersion_and_locale_and_ordinal", (q) =>
          q
            .eq("manifestVersion", manifestVersion)
            .eq("locale", locale)
            .eq("ordinal", ordinal)
        )
        .take(2)
      if (partitions.length !== 1) return notFound
      const partition = partitions[0]!
      if (partition.oversized) {
        return { status: "unavailable", reason: "oversized" }
      }
      low = partition.lowCreationTime
      high = partition.highCreationTime
    }
    const rows = await readSitemapRange(
      ctx,
      locale,
      low,
      high,
      SITEMAP_PARTITION_CEILING + 1
    )
    if (rows.length > SITEMAP_PARTITION_CEILING) {
      return { status: "unavailable", reason: "overflow" }
    }
    const entries = await renderSitemapRows(ctx, rows, locale, cfg)
    if (entries === "read_budget") {
      return { status: "unavailable", reason: "read_budget" }
    }
    return { status: "ok", entries }
  },
})

/**
 * Public, count-free release gate for the bounded-pilot period. The mutation
 * guards below enforce the same envelope during ordinary creation/promotion;
 * deployment automation can call this query to reject a legacy/imported tree
 * that already violates it before ROUTE-04 is complete.
 */
export const getBoundedPilotEnvelope = query({
  args: {},
  returns: boundedPilotEnvelopeValidator,
  handler: async (ctx) => {
    const envelope = await readBoundedPilotEnvelope(ctx)
    return {
      withinEnvelope:
        envelope.totalPagesBelowCap && envelope.publishedPagesBelowCap,
      totalPagesBelowCap: envelope.totalPagesBelowCap,
      publishedPagesBelowCap: envelope.publishedPagesBelowCap,
      totalPagesAtOrAboveWarningThreshold:
        envelope.totalPagesAtOrAboveWarningThreshold,
      publishedPagesAtOrAboveWarningThreshold:
        envelope.publishedPagesAtOrAboveWarningThreshold,
    }
  },
})

/** Reconcile the write ledger after an approved import or migration. */
export const initializeBoundedPilotEnvelope = mutation({
  args: {},
  returns: boundedPilotEnvelopeValidator,
  handler: async (ctx) => {
    await requirePermission(ctx, "settings:update")
    const envelope = await reconcileBoundedPilotEnvelope(ctx)
    return {
      withinEnvelope:
        envelope.totalPagesBelowCap && envelope.publishedPagesBelowCap,
      totalPagesBelowCap: envelope.totalPagesBelowCap,
      publishedPagesBelowCap: envelope.publishedPagesBelowCap,
      totalPagesAtOrAboveWarningThreshold:
        envelope.totalPagesAtOrAboveWarningThreshold,
      publishedPagesAtOrAboveWarningThreshold:
        envelope.publishedPagesAtOrAboveWarningThreshold,
    }
  },
})

export const deleteImpact = query({
  args: { id: v.id("pages") },
  returns: deleteImpactValidator,
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "snapshot_active") {
      throw new ConvexError("PERMANENT_PAGE_PURGE_NOT_IMPLEMENTED")
    }
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const page = await ctx.db.get(id)
    if (!page) throw new ConvexError("Page not found")
    await requirePagePermission(ctx, page.pageType, "delete", {
      ownerId: page.createdBy,
    })
    return getDeleteImpact(ctx, id)
  },
})

export const listByPageType = query({
  args: {
    pageType: pageTypeValidator,
    status: v.optional(statusValidator),
    hasLocale: v.optional(v.string()),
  },
  returns: v.array(pageDocValidator),
  handler: async (ctx, { pageType, status, hasLocale }) => {
    if (!isActiveContentType(pageType)) return []
    await requirePagePermission(ctx, pageType, "list")
    // Bounded: this returns full page documents (every slice body, every
    // locale), so an unbounded `.collect()` grew without limit as a type
    // filled up — a few hundred posts is tens of MB of database I/O per call.
    // `MAX_PAGE_LIST_LIMIT` matches the ceiling the other list endpoints use.
    let pages = await ctx.db
      .query("pages")
      .withIndex("by_pageType_status", (q) => {
        if (status) return q.eq("pageType", pageType).eq("status", status)
        return q.eq("pageType", pageType)
      })
      .take(MAX_PAGE_LIST_LIMIT)

    pages = pages.filter((p) => p.deletedAt === undefined)

    if (hasLocale) {
      pages = pages.filter((p) => p.content?.[hasLocale])
    }

    return pages
  },
})

export const listRelationCandidates = query({
  args: {
    pageTypes: v.array(pageTypeValidator),
    tag: v.optional(v.string()),
    includeDrafts: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(pagePickerRowValidator),
  handler: async (ctx, { pageTypes, tag, includeDrafts, limit }) => {
    await requireAnyPageTypePermission(ctx, "list")
    const allowedTypes = permittedPageTypes()
    const max = clampLimit(
      limit,
      MAX_PAGE_PICKER_LIMIT,
      MAX_PAGE_PICKER_LIMIT
    )
    // Restrict to types the caller can list (ADR-0036) — a "post editor" asking
    // for relation candidates of type `page` gets an empty result set, not
    // UNAUTHORIZED, because this is a picker helper (a broader query, not a
    // targeted read).
    const types = [...new Set(pageTypes)].filter((t) => allowedTypes.has(t))
    if (types.length === 0) return []
    const hasTag = (page: Doc<"pages">) =>
      !tag ||
      ((page.pageType === "post" ? page.tags : undefined) ?? []).includes(tag)
    const seen = new Set<string>()

    if ((await readPublicationAuthority(ctx)) === "snapshot_active") {
      // Titles and publication state live in per-language drafts and
      // Published Snapshots; the `pages` row only locates candidates. At most
      // MAX_PAGE_PICKER_LIMIT candidates are projected per call, shared fairly
      // between the requested types.
      const scan = Math.ceil(MAX_PAGE_PICKER_LIMIT / types.length)
      const found: { row: PagePickerRow; order: number }[] = []
      for (const pageType of types) {
        const pages = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) => q.eq("pageType", pageType))
          .order("desc")
          .take(scan)
        for (const page of pages) {
          if (seen.has(page._id) || page.deletedAt !== undefined) continue
          if (!hasTag(page)) continue
          const row = await snapshotPickerRowForPage(ctx, page._id, {
            includeArchived: false,
          })
          if (!row) continue
          if (
            !includeDrafts &&
            !Object.values(row.localePublicationStates).includes("published")
          )
            continue
          seen.add(page._id)
          found.push({ row, order: page._creationTime })
        }
      }
      return found
        .sort((a, b) => b.order - a.order)
        .slice(0, max)
        .map(({ row }) => row)
    }

    const statuses = includeDrafts
      ? (["published", "draft"] as const)
      : (["published"] as const)
    const results: Doc<"pages">[] = []
    for (const pageType of types) {
      for (const status of statuses) {
        const pages = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) =>
            q.eq("pageType", pageType).eq("status", status)
          )
          .take(max)
        for (const page of pages) {
          if (seen.has(page._id)) continue
          if (page.deletedAt !== undefined) continue
          if (!hasTag(page)) continue
          seen.add(page._id)
          results.push(page)
        }
      }
    }
    return results
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max)
      .map(pagePickerRow)
  },
})

export const getByIds = query({
  args: { ids: v.array(v.id("pages")) },
  returns: v.array(pageDocValidator),
  handler: async (ctx, { ids }) => {
    const pages = await Promise.all(ids.map((id) => ctx.db.get(id)))
    const allowedPrivateTypes = await privateReadablePageTypes(ctx)
    return pages.filter(
      (p): p is Doc<"pages"> =>
        p !== null && allowedPrivateTypes.has(p.pageType)
    )
  },
})

/**
 * Resolve a batch of page ids to their full, locale-prefixed public paths for
 * one render locale — `/<locale?>/<localized-ancestry>/<localized-leaf>`. The
 * public renderer uses this to build internal-link hrefs that point straight at
 * the canonical URL (no 308 hop). Targets without content in the requested
 * locale are omitted so public links never advertise an unavailable locale.
 */
export const getLocalizedPathsByIds = query({
  args: {
    ids: v.array(v.id("pages")),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { ids, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const { defaultLocale, enabledLocales, homePageId } =
      await getLocaleConfig(ctx)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return {}
    if (authority === "snapshot_active") {
      if (!enabledLocales.includes(locale)) return {}
      const result: Record<string, string> = {}
      for (const id of ids) {
        const projection = await readCurrentSnapshotProjection(ctx, id, locale)
        const path = prefixedSnapshotPath(
          projection?.path ?? null,
          locale,
          defaultLocale
        )
        if (path) result[id] = path
      }
      return result
    }
    const allowedPrivateTypes = await privateReadablePageTypes(ctx)
    const enabledLocaleSet = new Set(enabledLocales)
    const localePrefix = locale === defaultLocale ? "" : `/${locale}`
    const result: Record<string, string> = {}
    const pages = await Promise.all(ids.map((id) => ctx.db.get(id)))
    for (const page of pages) {
      if (!page || page.deletedAt !== undefined) continue
      // A selected starter's route space contains only active routable types.
      // This check intentionally precedes the configured-home shortcut, which
      // otherwise could make a legacy inactive row routable at "/".
      if (!isRoutableContentType(page.pageType)) continue
      const isPublic = isPubliclyReadablePage(page)
      if (!isPublic && !allowedPrivateTypes.has(page.pageType)) continue
      // Published links are locale-strict. Authorized draft helpers retain
      // their existing path projection because their working content may live
      // only in pageStaging until publish.
      if (
        isPublic &&
        (!enabledLocaleSet.has(locale) || !page.content?.[locale])
      ) {
        continue
      }
      if (page._id === homePageId) {
        result[page._id] = localePrefix || "/"
        continue
      }
      const slug =
        (locale !== defaultLocale && page.localizedSlugs?.[locale]) || page.slug
      const ancestry =
        (locale !== defaultLocale && page.localizedAncestryPaths?.[locale]) ||
        page.ancestryPath ||
        ""
      const body = buildLocaleRelativePath({
        pageType: page.pageType,
        slug,
        ancestry,
      })
      if (body === null) continue
      result[page._id] = `${localePrefix}${body}`
    }
    return result
  },
})

/**
 * Anonymous relation-card reader. It does not reuse the editor/preview
 * resolver: every target is projected through its descriptor's public field
 * allowlist and must exist in the requested enabled locale.
 */
export const getPublicRelationCardsByIds = query({
  args: {
    ids: v.array(v.id("pages")),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.record(v.string(), v.union(publicRelationCardValidator, v.null())),
  handler: async (ctx, { ids, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const cfg = await getLocaleConfig(ctx)
    const uniqueIds = [...new Set(ids)]
    const result: Record<string, PublicRelationCard | null> = {}
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") {
      for (const id of uniqueIds) result[id] = null
      return result
    }
    if (authority === "snapshot_active") {
      if (!cfg.enabledLocales.includes(locale)) {
        for (const id of uniqueIds) result[id] = null
        return result
      }
      const project = await createPublicSnapshotProjectionReader(ctx)
      for (const id of uniqueIds) {
        const projection = project ? await project(id, locale) : null
        result[id] = projection
          ? await snapshotRelationCard(ctx, projection, cfg)
          : null
      }
      return result
    }
    if (!cfg.enabledLocales.includes(locale)) {
      for (const id of uniqueIds) result[id] = null
      return result
    }

    const pages = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)))
    const cards = pages.map((page) =>
      page && isActiveContentType(page.pageType)
        ? projectPublicReferenceCard(page, locale)
        : null
    )
    const mediaIds = [
      ...new Set(
        cards
          .map((card) => card?.imageMediaId)
          .filter((id): id is Id<"media"> => id !== undefined)
      ),
    ]
    const mediaRows = await Promise.all(mediaIds.map((id) => ctx.db.get(id)))
    const mediaUrlById = new Map<string, string>()
    for (const media of mediaRows) {
      if (media && media.deletedAt === undefined) {
        mediaUrlById.set(media._id, media.url)
      }
    }

    for (let index = 0; index < uniqueIds.length; index++) {
      const id = uniqueIds[index]!
      const page = pages[index]
      const card = cards[index]
      if (!page || !card) {
        result[id] = null
        continue
      }
      const href = localizedUrlsForPage(page, cfg)[locale]
      if (isRoutableContentType(page.pageType) && !href) {
        result[id] = null
        continue
      }
      result[id] = {
        pageId: card.pageId,
        pageType: card.pageType,
        title: card.title,
        ...(card.excerpt ? { excerpt: card.excerpt } : {}),
        ...(card.imageMediaId && mediaUrlById.get(card.imageMediaId)
          ? { image: { url: mediaUrlById.get(card.imageMediaId)! } }
          : {}),
        ...(href ? { href } : {}),
      }
    }
    return result
  },
})

/**
 * Anonymous bounded dynamic-menu source. The index owns newest-first ordering;
 * locale projection may remove rows that have no public snapshot in the
 * requested locale, but never substitutes another locale.
 */
export const listRecentPublicRelationCards = query({
  args: {
    pageType: v.string(),
    limit: v.number(),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.array(publicRelationCardValidator),
  handler: async (ctx, { pageType, limit, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    if (!Number.isInteger(limit) || limit < 1 || limit > 12) {
      throw new ConvexError(
        "Dynamic list limit must be an integer from 1 to 12"
      )
    }
    if (!isActiveContentType(pageType)) return []
    const activePageType = pageType as PageType

    const cfg = await getLocaleConfig(ctx)
    if (!cfg.enabledLocales.includes(locale)) return []
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return []
    if (authority === "snapshot_active") {
      return readRecentSnapshotRelationCards(
        ctx,
        activePageType,
        locale,
        limit,
        cfg
      )
    }
    const pages = await ctx.db
      .query("pages")
      .withIndex("by_pageType_and_status_and_publishedAt", (q) =>
        q.eq("pageType", activePageType).eq("status", "published")
      )
      .order("desc")
      .take(limit)
    const projected = pages.map((page) =>
      projectPublicReferenceCard(page, locale)
    )
    const mediaIds = [
      ...new Set(
        projected
          .map((card) => card?.imageMediaId)
          .filter((id): id is Id<"media"> => id !== undefined)
      ),
    ]
    const mediaRows = await Promise.all(mediaIds.map((id) => ctx.db.get(id)))
    const mediaUrlById = new Map<string, string>()
    for (const media of mediaRows) {
      if (media && media.deletedAt === undefined) {
        mediaUrlById.set(media._id, media.url)
      }
    }

    const result: PublicRelationCard[] = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]!
      const card = projected[index]
      if (!card) continue
      const href = localizedUrlsForPage(page, cfg)[locale]
      if (isRoutableContentType(page.pageType) && !href) continue
      result.push({
        pageId: card.pageId,
        pageType: card.pageType,
        title: card.title,
        ...(card.excerpt ? { excerpt: card.excerpt } : {}),
        ...(card.imageMediaId && mediaUrlById.get(card.imageMediaId)
          ? { image: { url: mediaUrlById.get(card.imageMediaId)! } }
          : {}),
        ...(href ? { href } : {}),
      })
    }
    return result
  },
})

/**
 * Authenticated preview/editor card reader. Anonymous public rendering uses
 * `getPublicRelationCardsByIds` above instead of this draft-aware helper.
 */
export const getRelationCardsByIds = query({
  args: {
    ids: v.array(v.id("pages")),
    locale: v.string(),
    includeDrafts: v.optional(v.boolean()),
  },
  returns: v.record(v.string(), v.union(publicRelationCardValidator, v.null())),
  handler: async (ctx, { ids, locale, includeDrafts }) => {
    const shouldIncludeDrafts = includeDrafts ?? false
    await requireAnyPageTypePermission(ctx, "list")
    // ADR-0036: when draft mode is on, restrict which draft ids the caller can
    // resolve to their private-readable page types — otherwise a caller with
    // `pages.post:list:all` could pass landing-page draft ids and receive full
    // draft cards. The non-draft path relies on `resolveRelations` returning
    // null for drafts (existing behavior), so it doesn't need filtering here.
    let effectiveIds: Id<"pages">[] = ids
    const forbiddenIds = new Set<string>()
    const allowedPrivateTypes = shouldIncludeDrafts
      ? await privateReadablePageTypes(ctx)
      : new Set<PageType>()
    const fetched = await Promise.all(
      ids.map(async (id) => ({ id, page: await ctx.db.get(id) }))
    )
    const kept: Id<"pages">[] = []
    for (const { id, page } of fetched) {
      if (!page || !isActiveContentType(page.pageType)) {
        forbiddenIds.add(id)
        continue
      }
      if (
        shouldIncludeDrafts &&
        !isPubliclyReadablePage(page) &&
        !allowedPrivateTypes.has(page.pageType)
      ) {
        forbiddenIds.add(id)
        continue
      }
      kept.push(id)
    }
    effectiveIds = kept
    const { defaultLocale } = await getLocaleConfig(ctx)
    const cards = await resolveRelations(ctx, effectiveIds, {
      includeDrafts: shouldIncludeDrafts,
      locale,
      defaultLocale,
    })
    // Preserve the "one entry per requested id" contract — filtered ids come
    // back as null (same as an unresolvable/hidden draft on the public path).
    for (const id of forbiddenIds) {
      cards[id] = null
    }
    return cards
  },
})

export const getBreadcrumb = query({
  args: { pageId: v.id("pages") },
  returns: v.array(breadcrumbItemValidator),
  handler: async (ctx, { pageId }) => {
    const rootPage = await ctx.db.get(pageId)
    if (
      !rootPage ||
      !isActiveContentType(rootPage.pageType) ||
      !(await canReadPrivate(
        ctx,
        rootPage.pageType,
        `pages.${rootPage.pageType}:list`
      ))
    ) {
      return []
    }
    const crumbs: { id: Id<"pages">; slug: string; title: string }[] = []
    let currentId: Id<"pages"> | undefined = pageId

    while (currentId) {
      const page: Doc<"pages"> | null = await ctx.db.get(currentId)
      if (!page) break
      // Gate each ancestor by per-type private read grants — this full-document
      // helper is never an anonymous metadata surface.
      if (
        !isActiveContentType(page.pageType) ||
        !(await canReadPrivate(
          ctx,
          page.pageType,
          `pages.${page.pageType}:list`
        ))
      ) {
        break
      }
      crumbs.unshift({
        id: page._id,
        slug: page.slug,
        title: page.content?.en?.title ?? page.content?.fr?.title ?? page.slug,
      })
      currentId = page.parentId
    }

    return crumbs
  },
})

/**
 * Breadcrumb chain (root → page) with localized titles and full localized
 * public paths, for JSON-LD `BreadcrumbList`. Same per-locale URL rule as
 * `getLocalizedPathsByIds`.
 */
export const getLocalizedBreadcrumb = query({
  args: {
    pageId: v.id("pages"),
    locale: v.string(),
    languageVersion: v.number(),
  },
  returns: v.array(localizedBreadcrumbItemValidator),
  handler: async (ctx, { pageId, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return []
    if (authority === "snapshot_active") {
      const cfg = await getLocaleConfig(ctx)
      if (!cfg.enabledLocales.includes(locale)) return []
      const projection = await readCurrentSnapshotProjection(
        ctx,
        pageId,
        locale
      )
      if (!projection?.path) return []
      const payloadRoute = projection.payload.route
      if (
        !payloadRoute ||
        typeof payloadRoute !== "object" ||
        (payloadRoute as { kind?: unknown }).kind !== "routable"
      )
        return []
      const route = payloadRoute as {
        ancestry?: unknown
        canonicalPath?: unknown
      }
      if (typeof route.canonicalPath !== "string") return []
      const publicPage = projection.publicPage
      const localized =
        publicPage &&
        typeof publicPage === "object" &&
        !Array.isArray(publicPage) &&
        "content" in publicPage &&
        typeof (publicPage as { content?: unknown }).content === "object"
          ? (publicPage as { content: Record<string, unknown> }).content[locale]
          : undefined
      const localizedRecord =
        localized && typeof localized === "object" && !Array.isArray(localized)
          ? (localized as Record<string, unknown>)
          : {}
      const pageRecord =
        publicPage &&
        typeof publicPage === "object" &&
        !Array.isArray(publicPage)
          ? (publicPage as Record<string, unknown>)
          : {}
      const leafName =
        (typeof localizedRecord.title === "string" && localizedRecord.title) ||
        (typeof pageRecord.name === "string" && pageRecord.name) ||
        (typeof pageRecord.personName === "string" && pageRecord.personName) ||
        (typeof localizedRecord.quote === "string" && localizedRecord.quote) ||
        projection.path.split("/").filter(Boolean).at(-1) ||
        ""
      if (!leafName) return []
      const ancestry = Array.isArray(route.ancestry) ? route.ancestry : []
      const crumbs: { name: string; url: string }[] = []
      for (const item of ancestry) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return []
        const ancestor = item as Record<string, unknown>
        if (
          typeof ancestor.title !== "string" ||
          typeof ancestor.canonicalPath !== "string"
        )
          return []
        const url = prefixedSnapshotPath(
          ancestor.canonicalPath,
          locale,
          cfg.defaultLocale
        )
        if (!url) return []
        crumbs.push({ name: ancestor.title, url })
      }
      const leafUrl = prefixedSnapshotPath(
        route.canonicalPath,
        locale,
        cfg.defaultLocale
      )
      if (!leafUrl) return []
      crumbs.push({ name: leafName, url: leafUrl })
      return crumbs
    }
    const rootPage = await ctx.db.get(pageId)
    if (
      !rootPage ||
      !isPubliclyReadablePage(rootPage) ||
      !isRoutableContentType(rootPage.pageType)
    ) {
      return []
    }
    const { defaultLocale, enabledLocales, homePageId } =
      await getLocaleConfig(ctx)
    if (!enabledLocales.includes(locale)) return []
    const localePrefix = locale === defaultLocale ? "" : `/${locale}`
    const crumbs: { name: string; url: string }[] = []
    let currentId: Id<"pages"> | undefined = pageId
    let depth = 0
    let isLeaf = true

    while (currentId && depth < 10) {
      const page: Doc<"pages"> | null = await ctx.db.get(currentId)
      if (!page) break
      // Public JSON-LD must not borrow a title or path from another locale.
      // Missing localized ancestry is a missing public breadcrumb, not a
      // fallback opportunity.
      if (
        !isPubliclyReadablePage(page) ||
        !isRoutableContentType(page.pageType) ||
        !page.content?.[locale]
      ) {
        return []
      }
      // Keep JSON-LD on the same descriptor allowlist as page rendering. A
      // future routable type can mark its editor title private without that
      // title becoming visible through this otherwise narrow metadata query.
      const projected = projectPublicPage(page, locale)
      const localized = projected?.content[locale] as
        { title?: string } | undefined
      if (!localized?.title) return []
      const name = localized.title
      let url: string | null
      if (page._id === homePageId) {
        url = localePrefix || "/"
      } else {
        const slug =
          (locale !== defaultLocale && page.localizedSlugs?.[locale]) ||
          page.slug
        const ancestry =
          (locale !== defaultLocale && page.localizedAncestryPaths?.[locale]) ||
          page.ancestryPath ||
          ""
        const body = buildLocaleRelativePath({
          pageType: page.pageType,
          slug,
          ancestry,
        })
        url = body === null ? null : `${localePrefix}${body}`
      }
      if (url === null) {
        // Non-routable leaf → no meaningful breadcrumb (mirrors the caller's
        // routability 404 at the wildcard). Non-routable ancestor → skip its
        // crumb but keep climbing so routable grand-ancestors + the home
        // crumb still appear.
        if (isLeaf) return []
      } else {
        crumbs.unshift({ name, url })
      }
      currentId = page.parentId
      depth++
      isLeaf = false
    }

    return crumbs
  },
})

export const getLocalizedPageUrls = query({
  args: {
    pageId: v.id("pages"),
  },
  returns: v.union(v.record(v.string(), v.string()), v.null()),
  handler: async (ctx, { pageId }) => {
    const page = await ctx.db.get(pageId)
    if (!page || !isActiveContentType(page.pageType)) return null
    if (
      !(await canReadPrivate(ctx, page.pageType, `pages.${page.pageType}:list`))
    ) {
      return null
    }
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return null
    if (authority === "snapshot_active") {
      // One point-read projection per enabled locale (M05 C5): no locale is
      // dropped by a row cap.
      const cfg = await getLocaleConfig(ctx)
      const urls: Record<string, string> = {}
      for (const locale of cfg.enabledLocales) {
        const projection = await readCurrentSnapshotProjection(
          ctx,
          pageId,
          locale
        )
        const path = prefixedSnapshotPath(
          projection?.path ?? null,
          locale,
          cfg.defaultLocale
        )
        if (path) urls[locale] = path
      }
      return Object.keys(urls).length > 0 ? urls : null
    }
    const cfg = await getLocaleConfig(ctx)
    return localizedUrlsForPage(page, cfg)
  },
})

const publicLocaleAlternateValidator = v.object({
  locale: v.string(),
  url: v.string(),
  indexable: v.boolean(),
})

export type PublicLocaleAlternate = Infer<typeof publicLocaleAlternateValidator>

/** Enabled locales are a subset of the catalog, so this bounds the reader. */
const PUBLIC_LOCALE_ALTERNATE_LIMIT = SUPPORTED_LOCALES.length

async function readPublicLocaleAlternates(
  ctx: QueryCtx,
  pageId: Id<"pages">
): Promise<PublicLocaleAlternate[]> {
  const authority = await readPublicationAuthority(ctx)
  if (authority === "invalid") return []
  const cfg = await getLocaleConfig(ctx)
  if (cfg.enabledLocales.length > PUBLIC_LOCALE_ALTERNATE_LIMIT) {
    throw new ConvexError("PUBLIC_LOCALE_ALTERNATE_BOUND_EXCEEDED")
  }
  if (authority === "snapshot_active") {
    const alternates = await readPublicSnapshotLocaleAlternates(
      ctx,
      pageId,
      cfg.enabledLocales
    )
    return alternates.map(({ locale, path, noIndex }) => ({
      locale,
      url: prefixedSnapshotPath(path, locale, cfg.defaultLocale)!,
      indexable: !noIndex,
    }))
  }
  const page = await ctx.db.get(pageId)
  if (!page || !isPubliclyReadablePage(page)) return []
  if (!isRoutableContentType(page.pageType)) return []
  const urls = localizedUrlsForPage(page, cfg)
  const indexable = page.seo?.noIndex !== true
  return cfg.enabledLocales.flatMap((locale) => {
    const url = urls[locale]
    return url ? [{ locale, url, indexable }] : []
  })
}

/**
 * Anonymous per-locale alternates of one routable Page (M05 C5, N11). One
 * entry per enabled locale whose current Published Snapshot is routable, in
 * configured locale order. Every entry is a navigation alternate (switcher,
 * revalidation); `indexable` entries are the SEO alternates (hreflang,
 * `x-default`). Drafts and non-routable records are invisible.
 */
export const getPublicLocaleAlternates = query({
  args: { pageId: v.id("pages"), languageVersion: v.number() },
  returns: v.array(publicLocaleAlternateValidator),
  handler: async (ctx, { pageId, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    return readPublicLocaleAlternates(ctx, pageId)
  },
})

/** Published Home URLs for the switcher on a non-Page route. */
export const getPublicHomeLocaleAlternates = query({
  args: { languageVersion: v.number() },
  returns: v.array(publicLocaleAlternateValidator),
  handler: async (ctx, { languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const cfg = await getLocaleConfig(ctx)
    if (!cfg.homePageId) return []
    return readPublicLocaleAlternates(ctx, cfg.homePageId)
  },
})

export const getAllLocalizedPageUrls = query({
  args: { languageVersion: v.number() },
  returns: v.array(
    v.object({
      pageId: v.id("pages"),
      locale: v.string(),
      url: v.string(),
    })
  ),
  handler: async (ctx, { languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return []
    if (authority === "snapshot_active") {
      const cfg = await getLocaleConfig(ctx)
      const entries: LocalizedPageUrlRow[] = []
      for (const locale of cfg.enabledLocales) {
        const states = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
            q.eq("hasCurrentSnapshot", true).eq("locale", locale)
          )
          .take(LOCALIZED_PAGE_URL_BATCH_SIZE)
        for (const state of states) {
          const projection = await readCurrentSnapshotProjection(
            ctx,
            state.pageId,
            locale
          )
          const path = prefixedSnapshotPath(
            projection?.path ?? null,
            locale,
            cfg.defaultLocale
          )
          if (path) entries.push({ pageId: state.pageId, locale, url: path })
        }
      }
      return entries
    }
    // Returns lightweight route rows, paginating so the whole catalog is never
    // held in memory at once.
    //
    // Be precise about what that does and does not buy: `.paginate()` yields
    // full `Doc<"pages">` values, and Convex has no projection pushdown, so
    // this DOES read every published page document in full. Batching bounds
    // memory; the narrow return shape bounds egress. Neither bounds database
    // I/O — that is the dominant cost here and it scales with the catalog.
    // Removing it needs an indexed route projection (a `pageRoutes` table),
    // which is a migration-sensitive change deliberately not taken yet.
    // See docs/audit/convex-free-plan-quota-2026-07-20.md, finding 0b.
    let cursor: string | null = null
    const entries: LocalizedPageUrlRow[] = []
    const cfg = await getLocaleConfig(ctx)
    const addBatch = (pageDocs: Array<Doc<"pages">>) => {
      for (const pageDoc of pageDocs) {
        if (pageDoc.deletedAt !== undefined) {
          continue
        }
        if (pageDoc.status !== "published") {
          continue
        }
        for (const [locale, url] of Object.entries(
          localizedUrlsForPage(pageDoc, cfg)
        )) {
          entries.push({ pageId: pageDoc._id, locale, url })
        }
      }
    }

    while (true) {
      const pageBatch: PaginationResult<Doc<"pages">> = await ctx.db
        .query("pages")
        .withIndex("by_status", (q) => q.eq("status", "published"))
        .paginate({ numItems: LOCALIZED_PAGE_URL_BATCH_SIZE, cursor })

      addBatch(pageBatch.page)
      if (pageBatch.isDone) break
      cursor = pageBatch.continueCursor
    }

    return entries
  },
})

const historicalPublishedPathResultValidator = v.union(
  v.object({ authority: v.literal("legacy") }),
  v.object({
    authority: v.literal("snapshot_active"),
    disposition: v.literal("current"),
    pageId: v.id("pages"),
    locale: v.string(),
    snapshotId: v.id("pagePublishedSnapshots"),
    publicGeneration: v.number(),
  }),
  v.object({
    authority: v.literal("snapshot_active"),
    disposition: v.literal("historical_redirect"),
    pageId: v.id("pages"),
    locale: v.string(),
    snapshotId: v.id("pagePublishedSnapshots"),
    publicGeneration: v.number(),
    destinationPath: v.string(),
    statusCode: v.literal(307),
  }),
  v.object({
    authority: v.literal("snapshot_active"),
    disposition: v.literal("historical_unavailable"),
  }),
  // U3: `selfHeal` is a deferred candidate: the path is a current or F08
  // historical path of a page in another enabled language. The proxy uses it
  // only after the manual Redirects lookup misses.
  v.object({
    authority: v.literal("snapshot_active"),
    disposition: v.literal("unclaimed"),
    selfHeal: v.optional(
      v.object({
        pageId: v.id("pages"),
        locale: v.string(),
        destinationPath: v.string(),
        snapshotId: v.id("pagePublishedSnapshots"),
        publicGeneration: v.number(),
      })
    ),
  })
)

type HistoricalPublishedPathResult = Infer<
  typeof historicalPublishedPathResultValidator
>
type PublishedDestination = {
  path: string
  snapshotId: Id<"pagePublishedSnapshots">
  publicGeneration: number
}

/** The page's validated current public projection in one enabled language. */
async function readPublishedDestination(
  ctx: QueryCtx,
  enabledLocales: readonly string[],
  pageId: Id<"pages">,
  locale: string
): Promise<PublishedDestination | null> {
  if (!enabledLocales.includes(locale)) return null
  const [projection, stateRows] = await Promise.all([
    readCurrentSnapshotProjection(ctx, pageId, locale),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .take(2),
  ])
  const state = stateRows.length === 1 ? stateRows[0]! : null
  if (!projection?.path || !state?.hasCurrentSnapshot) return null
  if (!state.currentSnapshotId) return null
  return {
    path: projection.path,
    snapshotId: state.currentSnapshotId,
    publicGeneration: state.publicGeneration,
  }
}

/** An F08 historical row is valid when its frozen path still matches it. */
async function isValidHistoricalRow(
  ctx: QueryCtx,
  historical: Doc<"pageHistoricalLocaleRoutes">,
  locale: string
): Promise<boolean> {
  const captured = await readFrozenSnapshotProjection(
    ctx,
    historical.createdFromSnapshotId,
    historical.pageId,
    locale
  )
  if (!captured) return false
  const capturedPath = captured.path ?? null
  const settingsRows = await ctx.db.query("siteSettings").take(2)
  const settings = settingsRows.length === 1 ? settingsRows[0]! : null
  const isFrozenHomeAlias =
    capturedPath === "/" &&
    settings?.homePageId === historical.pageId &&
    settings.enabledLocales?.includes(locale) === true &&
    // U2: a stored alias stays valid whatever the default is now, so the
    // alias set does not depend on `settings.defaultLocale`. An empty
    // default selects the locale's own aliases plus the shared ones.
    homeSlugsForLocale(locale, "").some(
      (slug) => historical.fromPath === `/${slug}`
    )
  return capturedPath === historical.fromPath || isFrozenHomeAlias
}

/**
 * U3 self-heal candidate for a path no page claims in the request locale.
 * The PAGE is chosen first: enabled locales in settings order, a validated
 * current path before F08 history within a locale. Only then its translation
 * (D3a): the request locale, else the matched locale. Translation availability never changes which page wins.
 */
async function findSelfHealCandidate(
  ctx: QueryCtx,
  siteLocales: readonly string[],
  requestLocale: string,
  path: string
) {
  const addressCache = new Map<string, Promise<unknown>>()
  let match: { pageId: Id<"pages">; locale: string } | null = null
  for (const locale of siteLocales) {
    if (locale === requestLocale) continue
    const currentRows = await readLiveAddressRows(
      ctx,
      locale,
      path,
      addressCache
    )
    if (!currentRows) continue
    if (currentRows.length === 1) {
      const state = currentRows[0]!
      const projection = await readCurrentSnapshotProjection(
        ctx,
        state.pageId,
        locale,
        addressCache
      )
      if (
        projection?.path === path &&
        state.hasCurrentSnapshot &&
        state.currentSnapshotId
      ) {
        match = { pageId: state.pageId, locale }
        break
      }
    }
    if (currentRows.length > 0) continue
    const historicalRows = await readHeldHistoricalRows(
      ctx,
      locale,
      path,
      addressCache
    )
    if (!historicalRows) continue
    if (
      historicalRows.length === 1 &&
      (await isValidHistoricalRow(ctx, historicalRows[0]!, locale))
    ) {
      match = { pageId: historicalRows[0]!.pageId, locale }
      break
    }
  }
  if (!match) return undefined
  const order = [requestLocale, match.locale]
  for (const locale of [...new Set(order)]) {
    const destination = await readPublishedDestination(
      ctx,
      siteLocales,
      match.pageId,
      locale
    )
    if (destination) {
      return {
        pageId: match.pageId,
        locale,
        destinationPath: destination.path,
        snapshotId: destination.snapshotId,
        publicGeneration: destination.publicGeneration,
      }
    }
  }
  return undefined
}

/**
 * Classifies required Publication route ownership before optional Redirects.
 * In snapshot authority a malformed/current/historical reservation is never
 * delegated to a manual rule, cache, or legacy home alias.
 */
export const resolveHistoricalPublishedPath = query({
  args: {
    locale: v.string(),
    path: v.string(),
    languageVersion: v.number(),
  },
  returns: historicalPublishedPathResultValidator,
  handler: async (
    ctx,
    { locale, path, languageVersion }
  ): Promise<HistoricalPublishedPathResult> => {
    const languageState = await assertPublicLanguageVersion(
      ctx,
      languageVersion
    )
    // The settings order of the enabled languages, from the state this query
    // already read (the tie-break order of the self-heal candidate).
    const siteLocales: readonly string[] =
      "settings" in languageState
        ? (languageState.settings.enabledLocales ?? [])
        : []
    const authority = await readPublicationAuthority(ctx)
    if (authority === "legacy") return { authority: "legacy" as const }
    if (authority !== "snapshot_active") {
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    }
    const addressCache = new Map<string, Promise<unknown>>()
    const normalizedPath = path.startsWith("/") ? path : `/${path}`
    const currentRows = await readLiveAddressRows(
      ctx,
      locale,
      normalizedPath,
      addressCache
    )
    if (!currentRows)
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    if (currentRows.length > 1) {
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    }
    if (currentRows.length === 1) {
      const state = currentRows[0]!
      const projection = await readCurrentSnapshotProjection(
        ctx,
        state.pageId,
        locale,
        addressCache
      )
      if (
        !projection ||
        projection.path !== normalizedPath ||
        !state.hasCurrentSnapshot ||
        !state.currentSnapshotId
      ) {
        return {
          authority: "snapshot_active" as const,
          disposition: "historical_unavailable" as const,
        }
      }
      return {
        authority: "snapshot_active" as const,
        disposition: "current" as const,
        pageId: state.pageId,
        locale,
        snapshotId: state.currentSnapshotId,
        publicGeneration: state.publicGeneration,
      }
    }
    const historicalRows = await readHeldHistoricalRows(
      ctx,
      locale,
      normalizedPath,
      addressCache
    )
    if (!historicalRows)
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    if (historicalRows.length === 0) {
      // M05 continuity sets answer only requests in the default URL space,
      // after current and same-locale F08 history (M11).
      const continuityAuthority =
        (languageState.kind === "current" ||
          languageState.kind === "multilingual") &&
        languageState.locale === locale
          ? languageState.authority
          : null
      const pointer = continuityAuthority?.continuityPointer
      if (pointer) {
        // Whatever the authority mode, a pointer names the only set that is
        // read (M2 exception 1, M12): its generation, never F09's routes.
        const continuityRows = await ctx.db
          .query("siteDefaultLanguageRoutes")
          .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
            q
              .eq("migrationId", pointer.migrationId)
              .eq("generation", pointer.generation)
              .eq("fromPath", normalizedPath)
          )
          .take(2)
        if (continuityRows.length > 1) {
          return {
            authority: "snapshot_active" as const,
            disposition: "historical_unavailable" as const,
          }
        }
        const continuity = continuityRows[0]
        // A shadowed or retired row is absent, so the path is unclaimed (M24).
        if (
          continuity &&
          continuity.shadow === undefined &&
          continuity.retiredAt === undefined
        ) {
          // U3 (D3a): the same Page in the request language when it is
          // current there, else in the row's own language (M11), each
          // revalidated: enabled, active, routable and currently selected
          // (ledger C3d.1). The proxy prefixes the destination with the
          // returned locale.
          for (const candidate of new Set([locale, continuity.locale])) {
            const destination = await readPublishedDestination(
              ctx,
              siteLocales,
              continuity.pageId,
              candidate
            )
            if (!destination) continue
            return {
              authority: "snapshot_active" as const,
              disposition: "historical_redirect" as const,
              pageId: continuity.pageId,
              locale: candidate,
              snapshotId: destination.snapshotId,
              publicGeneration: destination.publicGeneration,
              destinationPath: destination.path,
              statusCode: 307 as const,
            }
          }
          return {
            authority: "snapshot_active" as const,
            disposition: "historical_unavailable" as const,
          }
        }
      } else if (continuityAuthority?.lastCommittedTransitionId) {
        // With no pointer, adoption keeps F09 continuity.
        const transitionId = continuityAuthority.lastCommittedTransitionId
        const continuityRows = await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId).eq("fromPath", normalizedPath)
          )
          .take(2)
        if (continuityRows.length > 1) {
          return {
            authority: "snapshot_active" as const,
            disposition: "historical_unavailable" as const,
          }
        }
        const continuity = continuityRows[0]
        if (continuity) {
          // U2 (D3a): the page's projection in the request locale when it is
          // current there; otherwise its validated projection in the
          // transition's target language (a silent default change can move
          // the default away from it). Locale, path, snapshot and generation
          // all come from the same selection.
          const transition = await ctx.db.get(transitionId)
          const candidates = [
            locale,
            ...(transition && transition.targetLocale !== locale
              ? [transition.targetLocale]
              : []),
          ]
          for (const candidate of candidates) {
            const [projection, stateRows] = await Promise.all([
              readCurrentSnapshotProjection(
                ctx,
                continuity.pageId,
                candidate,
                addressCache
              ),
              ctx.db
                .query("pageLocalePublicationStates")
                .withIndex("by_pageId_and_locale", (q) =>
                  q.eq("pageId", continuity.pageId).eq("locale", candidate)
                )
                .take(2),
            ])
            const currentState = stateRows.length === 1 ? stateRows[0]! : null
            if (
              !projection?.path ||
              !currentState?.hasCurrentSnapshot ||
              !currentState.currentSnapshotId
            ) {
              continue
            }
            return {
              authority: "snapshot_active" as const,
              disposition: "historical_redirect" as const,
              pageId: continuity.pageId,
              locale: candidate,
              snapshotId: currentState.currentSnapshotId,
              publicGeneration: currentState.publicGeneration,
              destinationPath: projection.path,
              statusCode: 307 as const,
            }
          }
          return {
            authority: "snapshot_active" as const,
            disposition: "historical_unavailable" as const,
          }
        }
      }
      const selfHeal = await findSelfHealCandidate(
        ctx,
        siteLocales,
        locale,
        normalizedPath
      )
      return {
        authority: "snapshot_active" as const,
        disposition: "unclaimed" as const,
        ...(selfHeal ? { selfHeal } : {}),
      }
    }
    if (historicalRows.length !== 1) {
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    }
    const historical = historicalRows[0]!
    if (!(await isValidHistoricalRow(ctx, historical, locale))) {
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    }
    const projection = await readCurrentSnapshotProjection(
      ctx,
      historical.pageId,
      locale,
      addressCache
    )
    const currentStateRows = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", historical.pageId).eq("locale", locale)
      )
      .take(2)
    const currentState =
      currentStateRows.length === 1 ? currentStateRows[0]! : null
    if (
      !projection?.path ||
      !currentState?.hasCurrentSnapshot ||
      !currentState.currentSnapshotId
    ) {
      return {
        authority: "snapshot_active" as const,
        disposition: "historical_unavailable" as const,
      }
    }
    return {
      authority: "snapshot_active" as const,
      disposition: "historical_redirect" as const,
      pageId: historical.pageId,
      locale,
      snapshotId: currentState.currentSnapshotId,
      publicGeneration: currentState.publicGeneration,
      destinationPath: projection.path,
      statusCode: 307 as const,
    }
  },
})

export const resolveLocalizedPathQuery = query({
  args: {
    path: v.string(),
    locale: v.optional(v.string()),
    languageVersion: v.number(),
  },
  returns: v.union(v.id("pages"), v.null()),
  handler: async (ctx, { path, locale, languageVersion }) => {
    await assertPublicLanguageVersion(ctx, languageVersion)
    const publicationAuthority = await readPublicationAuthority(ctx)
    // This public resolver has no draft-selection argument. Authenticated,
    // owner-bound preview path resolution is a separate mutation boundary.
    if (publicationAuthority === "snapshot_active") {
      const cfg = await getLocaleConfig(ctx)
      if (!locale) return null
      const requestedLocale = locale
      if (!cfg.enabledLocales.includes(requestedLocale)) return null
      const addressCache = new Map<string, Promise<unknown>>()
      const normalizedPath = path.startsWith("/") ? path : `/${path}`
      if (normalizedPath === "/" && cfg.homePageId) {
        const homeRows = await readLiveAddressRows(
          ctx,
          requestedLocale,
          normalizedPath,
          addressCache
        )
        if (
          !homeRows ||
          homeRows.length !== 1 ||
          homeRows[0]!.pageId !== cfg.homePageId
        )
          return null
        const homeProjection = await readCurrentSnapshotProjection(
          ctx,
          cfg.homePageId,
          requestedLocale,
          addressCache
        )
        return homeProjection?.path === "/" ? cfg.homePageId : null
      }
      const routeRows = await readLiveAddressRows(
        ctx,
        requestedLocale,
        normalizedPath,
        addressCache
      )
      if (!routeRows) return null
      if (routeRows.length !== 1) return null
      const projection = await readCurrentSnapshotProjection(
        ctx,
        routeRows[0]!.pageId,
        requestedLocale,
        addressCache
      )
      return projection?.path === normalizedPath ? routeRows[0]!.pageId : null
    }
    if (publicationAuthority === "invalid") return null
    const publishedOnly = true

    // Extract the leaf slug from the path (last segment)
    const segments = path.split("/").filter((s) => s.length > 0)
    if (segments.length === 0) {
      return resolveHomePageIdForLocale(ctx, locale, false)
    }

    const { defaultLocale, enabledLocales } = await getLocaleConfig(ctx)
    const requestedLocale = locale ?? defaultLocale
    if (publishedOnly && !enabledLocales.includes(requestedLocale)) return null

    // Plan 028 C3 — routing generalization:
    //   If the first segment matches a non-empty `descriptor.routing.pathPrefix`
    //   (e.g. `/authors/<slug>` when the C5 `author` descriptor lands), scope
    //   the slug lookup to that descriptor's type. Cross-prefix collisions are
    //   impossible (duplicate-prefix guard in `contentTypes/index.ts`). Today
    //   no shipped descriptor uses a non-empty prefix, so this branch is
    //   forward defense — it fires the moment C5+ registers one.
    //
    //   No non-empty prefix match → fall through to the root-mount slug lookup
    //   below, where `page` / `landing-page` / `post` all share the `""`
    //   prefix and the doc's stored `pageType` decides the type (global slug
    //   uniqueness guarantees at most one match).
    const routed = resolveContentTypeByPath(segments)
    if (routed) {
      const targetType = routed.descriptor.type
      // Non-default locales may carry a per-locale slug — same rule as the
      // root-mount branch below. Scan first because `localizedSlugs` isn't
      // indexable per key; scope the scan to the routed target type + this
      // locale so it stays cheap even after many descriptors register.
      if (locale && locale !== defaultLocale) {
        const scoped = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) =>
            q.eq("pageType", targetType as PageType)
          )
          .take(LOCALIZED_PAGE_URL_BATCH_SIZE)
        const localized = scoped.find(
          (p) =>
            p.deletedAt === undefined &&
            (!publishedOnly || p.status === "published") &&
            p.localizedSlugs?.[locale] === routed.slug
        )
        if (
          localized &&
          (!publishedOnly || localized.content?.[requestedLocale])
        ) {
          return localized._id
        }
      }
      // Global slug uniqueness (kept in C3 — the plan's per-prefix scoping is
      // a future migration). Type filter after fetch is trivially bounded by
      // `.take(10)` and avoids an extra `by_pageType_slug` index for a branch
      // no shipped descriptor exercises today.
      const matches = await ctx.db
        .query("pages")
        .withIndex("by_slug", (q) => q.eq("slug", routed.slug))
        .take(10)
      const page = matches.find(
        (p) =>
          p.deletedAt === undefined &&
          p.pageType === targetType &&
          (!publishedOnly || p.status === "published") &&
          (!publishedOnly || p.content?.[requestedLocale])
      )
      return page?._id ?? null
    }

    const leafSlug = segments[segments.length - 1]

    // Non-default locales may carry a per-locale slug (`localizedSlugs[locale]`).
    // That record isn't indexable per key, so scan for a localized match first;
    // a page whose locale slug was never overridden falls through to the base
    // slug lookup below (its localized URL reuses the base slug).
    if (locale && locale !== defaultLocale) {
      const pages = await ctx.db
        .query("pages")
        .take(LOCALIZED_PAGE_URL_BATCH_SIZE)
      const localized = pages.find(
        (p) =>
          p.deletedAt === undefined &&
          (!publishedOnly || p.status === "published") &&
          p.localizedSlugs?.[locale] === leafSlug &&
          isRoutableContentType(p.pageType)
      )
      if (
        localized &&
        (!publishedOnly || localized.content?.[requestedLocale])
      ) {
        return localized._id
      }
    }

    const matches = await ctx.db
      .query("pages")
      .withIndex("by_slug", (q) => q.eq("slug", leafSlug))
      .take(10)
    const page = matches.find(
      (p) =>
        p.deletedAt === undefined &&
        (!publishedOnly || p.status === "published") &&
        (!publishedOnly || p.content?.[requestedLocale]) &&
        // Plan 028 C3: non-routable content types have no public URL — refuse
        // to resolve their slug at the wildcard even though the slug is
        // globally unique. C5's faq-item / testimonial types depend on this
        // to stay off the public web.
        isRoutableContentType(p.pageType)
    )

    return page?._id ?? null
  },
})

// ============================================================
// Mutations
// ============================================================

export const create = mutation({
  args: {
    slug: v.optional(v.string()),
    pageType: pageTypeValidator,
    status: statusValidator,
    title: v.optional(v.string()),
    content: v.optional(v.record(v.string(), localizedContentInput)),
    expectedPresentationCatalogRevision: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    category: v.optional(v.string()),
    // Author-arm-only proper noun. Required at runtime when
    // `pageType === "author"`; rejected for other types.
    name: v.optional(v.string()),
    socials: contentTypeDefs.author.sharedFields.socials.validator,
    template: v.optional(v.string()),
    showOnHomepage: v.optional(v.boolean()),
    displayMode: v.optional(
      v.union(v.literal("card"), v.literal("full"), v.literal("both"))
    ),
    cardImageMediaId: v.optional(v.id("media")),
    cardExcerpt: v.optional(v.string()),
    // Post byline — a list of page ids pointing at `author`-typed rows.
    // Position = byline order; first = lead author. Server wraps each into
    // `{ pageId }` for the relation() storage shape. Plan 029 C10 renamed
    // the singular `authorId` to plural `authorIds`.
    authorIds: v.optional(v.array(v.id("pages"))),
    // Post editorial flags (plan 029 C10). Server writes them onto the post
    // arm only; passing them for a non-post pageType is rejected.
    featured: v.optional(v.boolean()),
    promoteToFront: v.optional(v.boolean()),
    parentId: v.optional(v.id("pages")),
    siblingOrder: v.optional(v.number()),
    seo: v.optional(seoValidator),
    defaultLocale: v.optional(v.string()),
  },
  returns: v.id("pages"),
  handler: async (ctx, args) => {
    const writeOptions: WriteOptions = {}
    args = {
      ...args,
      content: writePageContent(args.pageType, args.content, writeOptions)
        .value,
    }
    const auth = await requireOperationAccess(ctx)
    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    if (publicationAuthority !== "snapshot_active") {
      await assertLegacyPublicationWriterBlocked(ctx, "pages.create")
    }
    if (
      publicationAuthority === "snapshot_active" &&
      args.status === "published"
    ) {
      throw new ConvexError("PUBLISHED_SNAPSHOT_USE_PUBLISH_LOCALE")
    }
    assertEditionCanCreatePublished(args.status)
    await assertContentTypeAcceptsCreation(ctx, args.pageType)
    await assertBoundedPilotCanCreate(ctx, args.status === "published")
    if (args.pageType === "author") {
      if (args.status !== "draft") {
        throw new ConvexError("New Authors must be created as drafts.")
      }
    }
    await requireSliceMutationsPermitted(
      ctx,
      diffSliceMutations(undefined, args.content),
      {
        content: args.content,
        operation: "create",
        expectedPresentationCatalogRevision:
          args.expectedPresentationCatalogRevision,
      }
    )
    validateContentSliceIds(args.content)
    validateContentRichText(args.content)
    const now = Date.now()
    const defaultLocale = args.defaultLocale ?? "en"

    // Resolve title from args or content
    let title = args.title
    if (!title && args.content) {
      const localeContent =
        args.content[defaultLocale] ?? Object.values(args.content)[0]
      title = localeContent?.title
    }
    if (!title) {
      throw new ConvexError("Title is required")
    }

    const slug = args.slug ?? generateSlug(title)
    // Successor draft addresses are allocated by initializeSuccessorPage in
    // this transaction. Retained Page slugs are not the route authority; never
    // run the legacy whole-table slug scan after snapshot cutover.
    if (publicationAuthority !== "snapshot_active") {
      await ensureSlugUnique(ctx, slug)
    }

    // Seed every descriptor-declared localized field from its primitive
    // default, then overlay the universal create-dialog fields. This keeps
    // creation schema-valid for a newly generated type without teaching this
    // mutation its field names.
    const descriptor = contentTypeDefs[args.pageType]
    const initialContent = buildInitialLocalizedContent(
      descriptor,
      args.content,
      defaultLocale,
      title
    )

    const { ancestryPath, hierarchyDepth, localizedAncestryPaths } =
      args.parentId
        ? await buildAncestryPath(
            ctx,
            args.parentId,
            await getLocaleConfig(ctx)
          )
        : {
            ancestryPath: undefined,
            hierarchyDepth: 0,
            localizedAncestryPaths: undefined,
          }

    const tags = args.tags
      ? await ensureTagsForLabels(ctx, args.tags)
      : undefined

    // Post-only structural fields (byline + classification + editorial
    // flags) live on the `post` arm of the pages union only (plan 028 C1 /
    // ADR-0037 §4). A non-post caller passing them gets a typed rejection
    // here rather than a downstream schema-validator throw.
    if (args.pageType !== "post") {
      if (args.authorIds !== undefined && args.authorIds.length > 0) {
        throw new ConvexError(
          `authorIds is only valid on pageType='post' (got '${args.pageType}')`
        )
      }
      if (args.tags !== undefined && args.tags.length > 0) {
        throw new ConvexError(
          `tags is only valid on pageType='post' (got '${args.pageType}')`
        )
      }
      if (args.category !== undefined && args.category.length > 0) {
        throw new ConvexError(
          `category is only valid on pageType='post' (got '${args.pageType}')`
        )
      }
      if (args.featured !== undefined) {
        throw new ConvexError(
          `featured is only valid on pageType='post' (got '${args.pageType}')`
        )
      }
      if (args.promoteToFront !== undefined) {
        throw new ConvexError(
          `promoteToFront is only valid on pageType='post' (got '${args.pageType}')`
        )
      }
    }
    // Author-arm-only proper noun. Symmetric with the post-only gate above.
    if (args.pageType !== "author") {
      if (args.name !== undefined) {
        throw new ConvexError(
          `name is only valid on pageType='author' (got '${args.pageType}')`
        )
      }
      if (args.socials !== undefined && args.socials.length > 0) {
        throw new ConvexError(
          `socials is only valid on pageType='author' (got '${args.pageType}')`
        )
      }
    }
    // Author-arm name defaults from the title if not explicitly supplied —
    // lets the shared New-Page dialog (which only prompts for a title) create
    // authors without a bespoke form. Editors can rename the row-level
    // `name` later via `pages.update`.
    const resolvedAuthorName =
      args.pageType === "author" ? args.name?.trim() || title.trim() : undefined
    if (args.pageType === "author" && !resolvedAuthorName) {
      throw new ConvexError("Author name is required")
    }
    // Post's `authorIds` is a list of `relation()` primitives per the
    // descriptor — stored as `{ pageId }[]`, not a bare id array. Empty
    // list means undefined (row omits the field entirely).
    const resolvedAuthorIds = args.authorIds
    const authorRelations = await resolvePageRelations(
      ctx,
      resolvedAuthorIds,
      POST_BYLINE_ALLOWED_TYPES
    )

    // Row-level fields shared across every arm of the pages union. The
    // per-arm extras (author `name`/`socials`, post `authorIds`/`tags`/
    // `featured`/`promoteToFront`) are added inside the pageType branch
    // below so TS sees a concrete arm at each `ctx.db.insert` call — no
    // cast needed.
    // `content` is added per-arm below (its shape differs between
    // sliceBody arms and pure-form arms); everything else stays common.
    const commonInsertFields = {
      slug,
      status: args.status,
      createdAt: now,
      updatedAt: now,
      template: args.template,
      showOnHomepage: args.showOnHomepage,
      displayMode: args.displayMode,
      cardImageMediaId: args.cardImageMediaId,
      cardExcerpt: args.cardExcerpt ? stripHtml(args.cardExcerpt) : undefined,
      parentId: args.parentId,
      siblingOrder: args.siblingOrder,
      ancestryPath,
      hierarchyDepth,
      localizedAncestryPaths,
      seo: args.seo,
      createdBy: auth.tokenIdentifier,
      publishedAt: args.status === "published" ? now : undefined,
    }
    // Sticky auto-unset (plan 029 C10 task 10) on create too — a new post
    // that comes in already-sticky demotes every prior holder. No
    // `excludePageId` here (the new row doesn't exist yet), so every
    // other sticky post is a legitimate demotion target.
    if (
      publicationAuthority === "legacy" &&
      args.pageType === "post" &&
      args.promoteToFront === true
    ) {
      await autoUnsetOtherPromoteToFront(ctx, undefined)
    }
    // ADR-0041 Deploy 2 PR B item 3 — new drafts seed staging, not
    // `pages.content`. Insert the page with `content: {}`, then fan the
    // seed content into a fresh `pageStaging` row below. Publishing on
    // create (first-publish path) is the exception: skip staging and
    // write directly to `pages.content` so the checklist walks the
    // to-be-published shape.
    const publishOnCreate = args.status === "published"
    const contentForLiveRow = publishOnCreate ? initialContent : undefined
    const sharedInsertFields = descriptorDefaults(descriptor.sharedFields, {
      includeOptional: false,
    })
    if (args.pageType === "post") {
      sharedInsertFields.authorIds = authorRelations
      sharedInsertFields.tags = tags
      sharedInsertFields.category = args.category
      sharedInsertFields.featured = args.featured ?? false
      sharedInsertFields.promoteToFront = args.promoteToFront ?? false
    }
    if (args.pageType === "author") {
      sharedInsertFields.name = resolvedAuthorName
      if (args.socials !== undefined) sharedInsertFields.socials = args.socials
    }
    if (args.pageType === "testimonial") {
      // The universal create dialog only prompts for a title. Preserve the
      // built-in testimonial's friendlier identity seed while every other
      // descriptor-required field uses its primitive default.
      sharedInsertFields.personName = title.trim()
    }
    Object.assign(
      sharedInsertFields,
      writeFieldMap(descriptor.sharedFields, sharedInsertFields, writeOptions)
    )
    const pageId = await occurrenceUsageWrites(ctx).insert("pages", {
      ...commonInsertFields,
      ...sharedInsertFields,
      content: contentForLiveRow,
      pageType: args.pageType,
    } as Parameters<typeof ctx.db.insert<"pages">>[1])
    if (publicationAuthority === "snapshot_active") {
      const created = await ctx.db.get(pageId)
      if (!created) throw new ConvexError("PAGE_NOT_FOUND")
      await initializeSuccessorPage(
        ctx,
        created,
        auth,
        initialContent as Record<string, Record<string, unknown>>,
        args.expectedPresentationCatalogRevision
      )
      return pageId
    }
    // Seed staging when the row is not being published on create. The
    // §8 denormalized `effectiveTitles` mirrors what `updateDraft` writes
    // so the admin list + palette can render a title before the first
    // autosave (see `enrichWithStagingOverlay`).
    if (!publishOnCreate) {
      const effectiveTitles = pickEffectiveTitles(
        initialContent as Record<string, { title?: string }>
      )
      await occurrenceUsageWrites(ctx).insert("pageStaging", {
        pageId,
        pageType: args.pageType,
        createdBy: auth.tokenIdentifier,
        updatedAt: now,
        content: initialContent,
        ...(effectiveTitles !== undefined ? { effectiveTitles } : {}),
      } as Parameters<typeof ctx.db.insert<"pageStaging">>[1])
    }
    const page = await ctx.db.get(pageId)
    if (page) {
      await refreshPageReferences(ctx, page)
      await syncPageSearch(ctx, page)
    }
    return pageId
  },
})

/**
 * Clone a single page (all locales + slices) into a new **draft** with a fresh,
 * unique base slug (`<slug>-copy`). Child pages are not recursively copied, and
 * `localizedSlugs` are dropped (they'd collide) — localized URLs fall back to
 * the unique base slug until the editor re-sets per-locale slugs.
 */
export const duplicate = mutation({
  args: { id: v.id("pages"), title: v.string() },
  returns: v.id("pages"),
  handler: async (ctx, args) => {
    const { id, title } = args
    const writeOptions: WriteOptions = {}
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.duplicate")
    const confirmedTitle = title.trim()
    if (!confirmedTitle) {
      throw new ConvexError("Title is required")
    }
    const rawSrc = await ctx.db.get(id)
    if (!rawSrc || rawSrc.deletedAt !== undefined) {
      throw new ConvexError("Page not found")
    }
    if (rawSrc.pageType === "author") {
      throw new ConvexError(
        "Authors cannot be duplicated. Create another Author from the New Page flow."
      )
    }
    // ADR-0036: duplicate gates on the source row's type — a post-only role
    // can duplicate posts, not landing pages.
    const auth = await requirePagePermission(ctx, rawSrc.pageType, "create", {
      prospectiveOwner: true,
    })
    await assertContentTypeAcceptsCreation(ctx, rawSrc.pageType)
    await assertBoundedPilotCanCreate(ctx, false)
    // ADR-0041 ⚑5 — "Duplicate copies what you see." Overlay staging
    // onto the source so the copy carries the editor's current view (not
    // the last-published snapshot). `overlayStagingOnPage` handles the
    // null-staging case as a pass-through.
    //
    // Deploy 2 PR B item 3: the duplicate lands as a draft, so its
    // content seed goes onto a fresh `pageStaging` row and the live
    // `pages.content` starts empty — same shape as `create` above.
    const srcStaging = await getStagingByPageId(ctx, id)
    const source = overlayStagingOnPage(rawSrc, srcStaging)
    const src = {
      ...source,
      content: writePageContent(source.pageType, source.content, {
        ...writeOptions,
        duplicate: true,
        readLegacyShapes: true,
        trustedSource: {
          recordId: srcStaging?._id ?? rawSrc._id,
          version: srcStaging?.updatedAt ?? rawSrc.updatedAt,
          content: source.content,
        },
      }).value,
    }
    const { defaultLocale } = await getLocaleConfig(ctx)
    const titleLocale = src.content?.[defaultLocale]
      ? defaultLocale
      : Object.keys(src.content ?? {})[0]
    if (!titleLocale) {
      throw new ConvexError("Page has no localized content to duplicate")
    }
    await assertSliceMutationIntegrity(
      ctx,
      diffSliceMutations(rawSrc.content, rawSrc.content),
      { existingContent: rawSrc.content, operation: "duplicate" }
    )
    await requireSliceMutationsPermitted(
      ctx,
      diffSliceMutations(undefined, src.content),
      {
        content: src.content,
        operation: "duplicate",
        // Entirely server-copied source content: new Page assignments still
        // require active eligibility, using the transaction-effective revision.
        expectedPresentationCatalogRevision: hasExplicitSlicePresentations([
          src.content,
        ])
          ? (await readEffectiveSlicePresentationCatalog(ctx)).revision
          : undefined,
      }
    )
    const now = Date.now()
    const newSlug = await nextAvailableSlug(ctx, src.slug)

    // Per-arm extras — post carries byline/tags/category/flags; author
    // carries proper noun + socials. Card surface stays shared per
    // ADR-0037 §4. Revalidate the source bylines through
    // `resolvePageRelations` so a duplicate never inherits a dangling /
    // retyped / soft-deleted target. Plan 029 C10: `authorIds` plural.
    const carriedAuthorIds =
      src.pageType === "post"
        ? await resolvePageRelations(
            ctx,
            (src.authorIds ?? [])
              .map((r: { pageId?: Id<"pages"> }) => r.pageId)
              .filter((id): id is Id<"pages"> => id !== undefined),
            POST_BYLINE_ALLOWED_TYPES,
            src.authorIds
          )
        : undefined

    const commonInsertFields = {
      slug: newSlug,
      status: "draft" as const,
      createdAt: now,
      updatedAt: now,
      parentId: src.parentId,
      ancestryPath: src.ancestryPath,
      localizedAncestryPaths: src.localizedAncestryPaths,
      hierarchyDepth: src.hierarchyDepth,
      siblingOrder: src.siblingOrder,
      template: src.template,
      showOnHomepage: false,
      displayMode: src.displayMode,
      cardImageMediaId: src.cardImageMediaId,
      cardExcerpt: src.cardExcerpt,
      seo: src.seo,
      createdBy: auth.tokenIdentifier,
    }

    // Deep-copy content (JSON round-trip detaches slices from the source), use
    // the confirmed title for the default (or first available) locale, and
    // append " (Copy)" to the remaining locale titles.
    const copyContentWithSuffix = <T>(
      content: T | undefined
    ): T | undefined => {
      if (!content) return undefined
      return Object.fromEntries(
        Object.entries(content as Record<string, { title: string }>).map(
          ([locale, c]) => [
            locale,
            {
              ...JSON.parse(JSON.stringify(c)),
              title:
                locale === titleLocale ? confirmedTitle : `${c.title} (Copy)`,
            },
          ]
        )
      ) as T
    }

    // Deploy 2 PR B item 3: duplicates always land as drafts, so the
    // copied content bag seeds staging rather than `pages.content`. The
    // duplicate row's `content` starts empty; publish promotes it as
    // normal. `copyContentWithSuffix` applies the confirmed primary title and
    // copy suffixes so effectiveTitles / the editor distinguish the new draft.
    const stagedContent = copyContentWithSuffix(src.content)
    const sourceDescriptor = contentTypeDefs[src.pageType]
    const copiedSharedFields = copyDescriptorSharedFields(
      sourceDescriptor,
      src as unknown as Record<string, unknown>
    )
    if (src.pageType === "post") {
      copiedSharedFields.authorIds = writeFieldMap(
        sourceDescriptor.sharedFields,
        { authorIds: carriedAuthorIds },
        { duplicate: true }
      ).authorIds
      // Editorial flags are per-post editorial choice, not row shape.
      copiedSharedFields.featured = false
      copiedSharedFields.promoteToFront = false
    }
    if (src.pageType === "author") {
      copiedSharedFields.name = `${src.name} (Copy)`
    }
    if (src.pageType === "testimonial") {
      copiedSharedFields.personName = `${src.personName} (Copy)`
    }
    const pageId = await occurrenceUsageWrites(ctx).insert("pages", {
      ...commonInsertFields,
      ...copiedSharedFields,
      content: undefined,
      pageType: src.pageType,
    } as Parameters<typeof ctx.db.insert<"pages">>[1])
    // Seed staging on the duplicate. `effectiveTitles` denormalization
    // matches `create` and `updateDraft` so the list/palette overlay has
    // the (Copy) title immediately.
    const effectiveTitles = pickEffectiveTitles(
      stagedContent as Record<string, { title?: string }> | undefined
    )
    await occurrenceUsageWrites(ctx).insert("pageStaging", {
      pageId,
      pageType: src.pageType,
      createdBy: auth.tokenIdentifier,
      updatedAt: now,
      content: stagedContent,
      ...(effectiveTitles !== undefined ? { effectiveTitles } : {}),
    } as Parameters<typeof ctx.db.insert<"pageStaging">>[1])
    void auth
    const page = await ctx.db.get(pageId)
    if (page) {
      await refreshPageReferences(ctx, page)
      await syncPageSearch(ctx, page)
    }
    return pageId
  },
})

export const update = mutation({
  args: {
    id: v.id("pages"),
    slug: v.optional(v.string()),
    pageType: v.optional(pageTypeValidator),
    // ADR-0041 Deploy 3 (Narrow) — `pages.update` no longer accepts
    // `status: "published"`. Publish is `pages.publish` exclusively
    // (staging → live, checklist gate, single `"publish"` revision
    // writer). Callers use this mutation for the remaining transitions:
    // `draft` (unpublish / unarchive) and `archived` (archive). The
    // scheduled-publish cron uses `performPublish` directly.
    status: v.optional(v.union(v.literal("draft"), v.literal("archived"))),
    title: v.optional(v.string()),
    content: v.optional(v.record(v.string(), localizedContentInput)),
    expectedPresentationCatalogRevision: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    // Plan 029 C9a — optional descriptor shared fields accept `null` as a
    // clear signal. Convex serializes `undefined` as omitted, so `updatePage({
    // ...changedSharedFields, id })` with a bag key that transitioned to
    // `undefined` never reached the `!== undefined` branch below and the DB
    // silently didn't change. The client now sends `null` for cleared values
    // and the handler translates that back to `undefined` on the patch
    // (Convex's "remove field" signal).
    category: v.optional(v.union(v.string(), v.null())),
    template: v.optional(v.string()),
    showOnHomepage: v.optional(v.boolean()),
    displayMode: v.optional(
      v.union(v.literal("card"), v.literal("full"), v.literal("both"))
    ),
    cardImageMediaId: v.optional(v.id("media")),
    cardExcerpt: v.optional(v.string()),
    // Byline references — page ids pointing at `author`-typed rows.
    // Position = byline order; first = lead. An empty array clears the
    // byline entirely (`undefined` is "not touched"). Server wraps each
    // id into `{ pageId }` for the relation() storage shape. Plan 029
    // C10 renamed the singular `authorId` to plural `authorIds`.
    authorIds: v.optional(v.array(v.id("pages"))),
    // Editorial flags (plan 029 C10). Non-null booleans replace the stored
    // value; `undefined` = untouched. `promoteToFront: true` auto-unsets
    // any other post carrying the flag in the same mutation (task 10).
    featured: v.optional(v.boolean()),
    promoteToFront: v.optional(v.boolean()),
    parentId: v.optional(v.id("pages")),
    // Explicit "make this a root page" signal — `parentId: undefined` is
    // ambiguous (it's also the JSON encoding of "field omitted = no change").
    clearParent: v.optional(v.boolean()),
    siblingOrder: v.optional(v.number()),
    seo: v.optional(seoValidator),
    // ADR-0041 Deploy 2 PR B — `scheduledAt` has moved from `pages` to
    // `pageStaging`. It's staged through `pages.updateDraft` and promoted
    // by `pages.publish` (or by the scheduled-publish cron via the shared
    // `performPublish` helper). The arg is deliberately gone from this
    // legacy update surface so callers can't drift back to writing it on
    // the live row.
    expiresAt: v.optional(v.union(v.number(), v.null())),
    // Author-arm-only fields — proper noun + social profile links. Rejected
    // for non-author rows.
    name: v.optional(v.string()),
    // Plan 029 C9a — `null` clears the author's `socials` list; empty array
    // stays empty array. Same null-as-clear convention as `category` above.
    socials: v.optional(
      v.union(
        v.array(contentTypeDefs.author.sharedFields.socials.validator.element),
        v.null()
      )
    ),
    // Testimonial-arm-only shared fields (plan 029 C10 task 13). Rejected for
    // non-testimonial rows. `personName` is required per descriptor and
    // mirrors author `name` (reject-empty, no null-as-clear). The rest are
    // optional and follow the null-as-clear pattern established by
    // `category` / `socials`.
    personName: v.optional(v.string()),
    personRole: v.optional(v.union(v.string(), v.null())),
    personCompany: v.optional(v.union(v.string(), v.null())),
    // `image().validator` is the same object shape the testimonial descriptor
    // stores; the descriptor's `personImage.validator` is `.optional()`-
    // wrapped which `v.union` won't accept as an arm — so we thread the
    // required-shape base directly.
    personImage: v.optional(v.union(imagePrimitive().validator, v.null())),
    sourceUrl: v.optional(v.union(v.string(), v.null())),
    expectedUpdatedAt: v.optional(v.number()),
  },
  returns: updateResultValidator,
  handler: async (ctx, args) => {
    const {
      id,
      expectedUpdatedAt,
      expectedPresentationCatalogRevision,
      ...updates
    } = args
    const writeOptions: WriteOptions = {}
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.update")
    validateContentSliceIds(updates.content)
    const existing = await ctx.db.get(id)
    if (!existing) throw new ConvexError("Page not found")
    updates.content = writePageContent(
      existing.pageType,
      updates.content,
      writeOptions
    ).value
    validateContentRichText(updates.content)
    assertPageIsActiveForOrdinaryOperation(existing, "edit")
    const auth = await requirePagePermission(ctx, existing.pageType, "update", {
      ownerId: existing.createdBy,
    })
    // Plan 028 C1 + ADR-0037 §3 — `pageType` is immutable after creation.
    // Typed union arms carry per-type fields that cannot survive a flip, so
    // reject it here rather than silently corrupt the row at patch time.
    // (Prior ADR-0036 TRAP 2 — the double-gate permission check on flip —
    // is now unreachable and has been removed.)
    if (
      updates.pageType !== undefined &&
      updates.pageType !== existing.pageType
    ) {
      throw new ConvexError(
        "pageType is immutable; duplicate the page as the new type instead"
      )
    }
    if (updates.content !== undefined) {
      await requireSliceMutationsPermitted(
        ctx,
        diffSliceMutations(existing.content, updates.content),
        {
          // Deliberately retain cross-locale strictness: a disabled slice in
          // any stored locale blocks an ordinary Page edit until its code is
          // restored or the content is migrated.
          content: { ...(existing.content ?? {}), ...(updates.content ?? {}) },
          existingContent: existing.content,
          operation: "edit",
          expectedPresentationCatalogRevision,
        }
      )
    }
    assertFresh(existing, expectedUpdatedAt)

    if (updates.status !== undefined && updates.status !== existing.status) {
      await assertEditionReviewAllowsLifecycleChange(ctx, id)
    }

    // Resolve locale config once for the whole mutation — it feeds the old-URL
    // capture, ancestry rebuild, and descendant rebuild below (which would
    // otherwise re-read siteSettings at every level of the subtree).
    const cfg = await getLocaleConfig(ctx)

    // Capture the page's current public URLs before mutating, so a slug/parent
    // change can purge the old locations too.
    const oldPublicUrls = Object.values(localizedUrlsForPage(existing, cfg))

    if (updates.slug && updates.slug !== existing.slug) {
      await ensureSlugUnique(ctx, updates.slug, id)
    }

    const now = Date.now()
    const patch: Record<string, unknown> = { updatedAt: now }

    if (updates.slug !== undefined) patch.slug = updates.slug
    if (updates.pageType !== undefined) patch.pageType = updates.pageType
    if (updates.status !== undefined) {
      patch.status = updates.status
    }
    if (updates.content !== undefined) patch.content = updates.content
    // Post-only structural fields (byline + classification) live on the
    // `post` arm only (plan 028 C1 / ADR-0037 §4). Reject an attempt to set
    // them on a non-post row with a typed error rather than a downstream
    // schema-validator throw.
    const targetingPost = existing.pageType === "post"
    if (updates.tags !== undefined) {
      if (!targetingPost && updates.tags.length > 0) {
        throw new ConvexError(
          `tags is only valid on pageType='post' (row is '${existing.pageType}')`
        )
      }
      if (targetingPost) {
        patch.tags = await ensureTagsForLabels(ctx, updates.tags)
      }
    }
    if (updates.category !== undefined) {
      // `null` clears the field (`patch.<key> = undefined` is Convex's remove
      // signal). Non-empty strings on a non-post row still throw; a null on a
      // non-post row is a no-op clear.
      if (!targetingPost) {
        if (updates.category !== null && updates.category.length > 0) {
          throw new ConvexError(
            `category is only valid on pageType='post' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.category = updates.category ?? undefined
      }
    }
    if (updates.authorIds !== undefined) {
      if (!targetingPost && updates.authorIds.length > 0) {
        throw new ConvexError(
          `authorIds is only valid on pageType='post' (row is '${existing.pageType}')`
        )
      }
      if (targetingPost) {
        // Empty array → `undefined` (clears the field). `resolvePageRelations`
        // returns `undefined` for empty input; Convex reads `patch.<key> =
        // undefined` as "remove this field".
        patch.authorIds = await resolvePageRelations(
          ctx,
          updates.authorIds,
          POST_BYLINE_ALLOWED_TYPES,
          existing.authorIds
        )
      }
    }
    if (updates.featured !== undefined) {
      if (!targetingPost) {
        throw new ConvexError(
          `featured is only valid on pageType='post' (row is '${existing.pageType}')`
        )
      }
      patch.featured = updates.featured
    }
    if (updates.promoteToFront !== undefined) {
      if (!targetingPost) {
        throw new ConvexError(
          `promoteToFront is only valid on pageType='post' (row is '${existing.pageType}')`
        )
      }
      // Sticky auto-unset (plan 029 C10 task 10). Only fires when the
      // caller is flipping the flag ON — clearing the flag doesn't need
      // to touch anything else, and the auto-unset writes below would
      // just no-op. Ordering matters: unset OTHER holders first, then
      // patch the current row (the patch itself lands at
      // `ctx.db.patch(id, patch)` below).
      if (updates.promoteToFront === true) {
        await autoUnsetOtherPromoteToFront(ctx, id)
      }
      patch.promoteToFront = updates.promoteToFront
    }
    if (updates.template !== undefined) patch.template = updates.template
    if (updates.showOnHomepage !== undefined)
      patch.showOnHomepage = updates.showOnHomepage
    if (updates.displayMode !== undefined)
      patch.displayMode = updates.displayMode
    if (updates.cardImageMediaId !== undefined)
      patch.cardImageMediaId = updates.cardImageMediaId
    if (updates.cardExcerpt !== undefined)
      patch.cardExcerpt = stripHtml(updates.cardExcerpt)
    if (updates.seo !== undefined) patch.seo = updates.seo
    if (updates.expiresAt !== undefined) {
      patch.expiresAt = updates.expiresAt ?? undefined
    }
    // Author-arm-only fields — symmetric with the post-only gate above.
    const targetingAuthor = existing.pageType === "author"
    if (updates.name !== undefined) {
      if (!targetingAuthor) {
        throw new ConvexError(
          `name is only valid on pageType='author' (row is '${existing.pageType}')`
        )
      }
      const trimmed = updates.name.trim()
      if (trimmed.length === 0) {
        throw new ConvexError("Author name cannot be empty")
      }
      patch.name = trimmed
    }
    if (updates.socials !== undefined) {
      if (!targetingAuthor) {
        if (updates.socials !== null && updates.socials.length > 0) {
          throw new ConvexError(
            `socials is only valid on pageType='author' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.socials = updates.socials ?? undefined
      }
    }
    // Testimonial-arm-only shared fields (plan 029 C10 task 13). Mirrors the
    // author-arm block above: reject non-null non-empty writes on other
    // rows; on the testimonial row, `personName` is required (reject-empty),
    // the rest use null-as-clear via `?? undefined`.
    const targetingTestimonial = existing.pageType === "testimonial"
    if (updates.personName !== undefined) {
      if (!targetingTestimonial) {
        throw new ConvexError(
          `personName is only valid on pageType='testimonial' (row is '${existing.pageType}')`
        )
      }
      const trimmed = updates.personName.trim()
      if (trimmed.length === 0) {
        throw new ConvexError("Testimonial personName cannot be empty")
      }
      patch.personName = trimmed
    }
    if (updates.personRole !== undefined) {
      if (!targetingTestimonial) {
        if (updates.personRole !== null && updates.personRole.length > 0) {
          throw new ConvexError(
            `personRole is only valid on pageType='testimonial' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.personRole = updates.personRole ?? undefined
      }
    }
    if (updates.personCompany !== undefined) {
      if (!targetingTestimonial) {
        if (
          updates.personCompany !== null &&
          updates.personCompany.length > 0
        ) {
          throw new ConvexError(
            `personCompany is only valid on pageType='testimonial' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.personCompany = updates.personCompany ?? undefined
      }
    }
    if (updates.personImage !== undefined) {
      if (!targetingTestimonial) {
        if (updates.personImage !== null) {
          throw new ConvexError(
            `personImage is only valid on pageType='testimonial' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.personImage = updates.personImage ?? undefined
      }
    }
    if (updates.sourceUrl !== undefined) {
      if (!targetingTestimonial) {
        if (updates.sourceUrl !== null && updates.sourceUrl.length > 0) {
          throw new ConvexError(
            `sourceUrl is only valid on pageType='testimonial' (row is '${existing.pageType}')`
          )
        }
      } else {
        patch.sourceUrl = updates.sourceUrl ?? undefined
      }
    }

    const slugChanged =
      updates.slug !== undefined && updates.slug !== existing.slug
    let positionChanged = false

    if (updates.parentId !== undefined || updates.clearParent) {
      if (updates.parentId === id) {
        throw new ConvexError("A page cannot be its own parent.")
      }
      const nextParent = updates.clearParent ? undefined : updates.parentId
      // Cycle guard: walk the proposed parent's ancestry; if we hit `id`,
      // the move would create a loop.
      if (nextParent) {
        let cursor: Id<"pages"> | undefined = nextParent
        const seen = new Set<string>()
        while (cursor) {
          if (cursor === id) {
            throw new ConvexError(
              "Cannot move a page under one of its descendants."
            )
          }
          if (seen.has(cursor)) break
          seen.add(cursor)
          const node: Doc<"pages"> | null = await ctx.db.get(cursor)
          cursor = node?.parentId
        }
      }
      const { ancestryPath, hierarchyDepth, localizedAncestryPaths } =
        nextParent
          ? await buildAncestryPath(ctx, nextParent, cfg)
          : {
              ancestryPath: undefined,
              hierarchyDepth: 0,
              localizedAncestryPaths: undefined,
            }
      patch.parentId = nextParent
      patch.ancestryPath = ancestryPath
      patch.hierarchyDepth = hierarchyDepth
      patch.localizedAncestryPaths = localizedAncestryPaths
      positionChanged = true
    }

    if (updates.siblingOrder !== undefined)
      patch.siblingOrder = updates.siblingOrder

    if (updates.status === "archived") {
      // ADR-0041 Deploy 2 PR B — scheduledAt lives on staging now.
      // Archiving a page tears down its expiry; the scheduled-publish
      // side has nothing to unwind here (a staged scheduledAt only
      // fires against draft pages per cron parity).
      patch.expiresAt = undefined
    }

    // ADR-0041 Deploy 3 (Narrow) — `pages.update` no longer publishes;
    // `status: "published"` is rejected at the args validator. The
    // publish gate (`pages.<type>:publish`), the pre-publish checklist,
    // and the `"publish"` revision reason all live on `pages.publish`
    // and `processScheduledTransitions` (both routed through
    // `performPublish`). What remains here is the plain edit path with
    // a single `"manual_save"` revision writer.
    Object.assign(
      patch,
      writeFieldMap(contentTypeDefs[existing.pageType].sharedFields, patch)
    )
    const nextPageForSummary = { ...existing, ...patch } as Doc<"pages">
    const revisionSummary = summarizePageChange(existing, nextPageForSummary)
    const shouldCreateRevision =
      updates.status !== undefined ||
      updates.content !== undefined ||
      updates.seo !== undefined
    if (shouldCreateRevision) {
      await createPageRevision(
        ctx,
        existing,
        "manual_save",
        auth.tokenIdentifier,
        revisionSummary
      )
    }

    if (existing.status === "published" && updates.status !== undefined) {
      await releaseBoundedPilotPublishedSlot(ctx)
    }
    await occurrenceUsageWrites(ctx).patch(id, patch)
    // Refresh the C2 `documentReferences` fan-out unconditionally — matching
    // every other refresh call site. C5 wired an early attempt at a
    // field-name-coupled guard, but the next sharedField `relation()` would
    // fall into the same trap (C6's authorId fix was symptomatic). Scanning
    // a relation-free row is a single indexed clear + early `.length === 0`
    // return in `refreshDocumentReferencesForPage`, so unconditional refresh
    // is the honest cost.
    await refreshPageReferences(ctx, nextPageForSummary)
    await syncPageSearch(ctx, nextPageForSummary)
    // A changed base slug or new position invalidates every descendant's path.
    if (slugChanged || positionChanged) {
      await rebuildDescendantAncestry(ctx, id, cfg)
    }

    // Purge the ISR cache for anything that changed the public surface. (Old
    // URLs come from `oldPublicUrls`; the action adds the current ones.)
    const publicChanged =
      updates.status !== undefined ||
      slugChanged ||
      positionChanged ||
      updates.content !== undefined ||
      updates.seo !== undefined ||
      updates.showOnHomepage !== undefined
    if (publicChanged) {
      await ctx.scheduler.runAfter(0, internal.cms.revalidate.revalidatePage, {
        pageId: id,
        extraPaths: oldPublicUrls,
      })
    }
    return { updatedAt: now }
  },
})

export const processScheduledTransitions = internalMutation({
  args: {},
  returns: v.object({
    published: v.number(),
    expired: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    if (!(await shouldRunLegacyPageCron(ctx))) {
      return { published: 0, expired: 0, hasMore: false }
    }
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "pages.processScheduledTransitions"
    )
    const now = Date.now()
    // ADR-0041 Deploy 2 PR B — scheduledAt now lives on `pageStaging`.
    // `queryDueScheduledPublishes` returns staging rows; the caller
    // resolves the page via `staging.pageId`. `by_scheduledAt` carries
    // no status filter, so preserve draft-only auto-publish here.
    const dueStaging = await queryDueScheduledPublishes(ctx, now)
    const dueExpiries = await queryDueScheduledExpiries(ctx, now)

    // Idle-tick guard. This cron fires every minute — 43,200 times a month —
    // and both queries above are `.take(1)` on an index, so a tick with no due
    // work has read almost nothing at this point. `getLocaleConfig` is what
    // makes an idle tick expensive: it reads `siteSettings` and then, when no
    // valid `homePageId` is configured (the default state), scans
    // `DEFAULT_HOME_SLUGS` with `by_slug .take(10)` per slug — up to ~20 FULL
    // page documents, every minute, forever. On Convex's free plan database
    // I/O (1 GB/mo) is the binding constraint, not function calls, so leaving
    // this above the guard could consume the entire monthly budget doing
    // nothing. Returning early keeps an idle tick at ~2 index reads.
    //
    // Safe because `cfg` is only consumed inside the two loops below, both of
    // which this guard proves empty.
    if (dueStaging.length === 0 && dueExpiries.length === 0) {
      return { published: 0, expired: 0, hasMore: false }
    }

    let published = 0
    let expired = 0
    const cfg = await getLocaleConfig(ctx)

    for (const storedStaging of dueStaging) {
      const staging = withRepairedStagingSliceIds(storedStaging)
      const page = await ctx.db.get(staging.pageId)
      // Orphaned staging (page hard-deleted between queue and here) — drop
      // the row so the abandoned sweep doesn't have to chase it and the
      // cron doesn't rediscover it next tick.
      if (!page) {
        await occurrenceUsageWrites(ctx).delete(staging._id)
        continue
      }
      // Preserve the pre-PR-B draft-only semantics. A future feature can
      // decide to auto-publish scheduled edits on an already-published or
      // archived page, but item 5 explicitly ships behavioural parity.
      //
      // CRITICAL: this skip path must ALSO clear `staging.scheduledAt`,
      // not just `continue`. `by_scheduledAt` carries no status filter
      // (unlike the retired `by_status_and_scheduledAt`), and the batch
      // is `take(1)` — so a match that gets skipped without clearing
      // returns the same smallest-`scheduledAt` row next tick, `published`
      // stays 0, `hasMore` stays true, and the cron reschedules itself
      // immediately forever. Runaway. Reachable when a user schedules a
      // draft then archives it, or edits a schedule on an already-
      // published page. The clear is semantically correct too — a
      // schedule on a non-draft page is void.
      if (
        page.deletedAt !== undefined ||
        page.status !== "draft" ||
        !isActiveContentType(page.pageType)
      ) {
        await occurrenceUsageWrites(ctx).patch(staging._id, {
          scheduledAt: undefined,
          updatedAt: now,
        })
        continue
      }
      if (!(await canBoundedPilotPublish(ctx, false))) {
        await occurrenceUsageWrites(ctx).patch(staging._id, {
          scheduledAt: undefined,
          updatedAt: now,
        })
        continue
      }
      if (staging.scheduledAt === undefined || staging.scheduledAt > now) {
        // Defensive — the index range already scopes `.lte(now)`, but a
        // patch race could shift the value under us. `scheduledAt` future
        // is not runaway (index range excludes it); `undefined` shouldn't
        // be in the range at all (`.gte(0)`).
        continue
      }

      const nextPage = overlayStagingOnPage(page, staging)

      // Slug uniqueness pre-check: two pages can concurrently stage the
      // same slug per ADR Consequences. First-to-publish wins — the
      // loser can't publish and we don't want to hot-loop the cron on
      // it. Clear the scheduledAt on failure and continue.
      let slugOk = true
      if (nextPage.slug !== page.slug) {
        if (await isSlugTaken(ctx, nextPage.slug, page._id)) slugOk = false
      }
      if (slugOk && nextPage.localizedSlugs) {
        for (const [locale, ls] of Object.entries(nextPage.localizedSlugs)) {
          const before = page.localizedSlugs?.[locale]
          if (ls && ls !== before && (await isSlugTaken(ctx, ls, page._id))) {
            slugOk = false
            break
          }
        }
      }

      // Plan 029 C9a — scheduled-publish worker runs against a page whose
      // status is about to flip to `published`. Pass the `"publish"`
      // intent so descriptor-relation target checks fire; otherwise a
      // scheduled post could auto-publish with a draft-author byline.
      const checklist = await buildPrePublishChecklistWithReferences(
        ctx,
        nextPage,
        cfg,
        "publish"
      )
      if (!slugOk || !checklist.canPublish) {
        // Clear the staged scheduledAt so we don't hot-loop the cron on a
        // permanently unpublishable row every minute. The staging row
        // itself lives — the editor can still fix the blockers and
        // reschedule.
        await occurrenceUsageWrites(ctx).patch(staging._id, {
          scheduledAt: undefined,
          updatedAt: now,
        })
        continue
      }

      const workflowCheck = await checkEditionScheduledPublish(ctx, {
        page,
        staging,
      })
      if (!workflowCheck.ok) {
        await occurrenceUsageWrites(ctx).patch(staging._id, {
          scheduledAt: undefined,
          updatedAt: now,
        })
        await recordEditionScheduledPublishRejected(ctx, {
          pageId: page._id,
          reason: workflowCheck.reason,
        })
        continue
      }

      await performPublish(ctx, {
        page,
        staging,
        storedStaging,
        checklist,
        reason: "scheduled_publish",
        actorUserId: undefined,
        cfg,
        workflowApproval: workflowCheck.approval,
      })
      published += 1
    }

    for (const page of dueExpiries) {
      if (page.deletedAt !== undefined || page.expiresAt === undefined) {
        continue
      }
      const patch = {
        status: "archived" as const,
        expiresAt: undefined,
        updatedAt: now,
      }
      await createPageRevision(ctx, page, "scheduled_expiry", undefined, [
        "Archived automatically from expiry time",
      ])
      await releaseBoundedPilotPublishedSlot(ctx)
      await occurrenceUsageWrites(ctx).patch(page._id, patch)
      await syncPageSearch(ctx, { ...page, ...patch })
      await ctx.scheduler.runAfter(0, internal.cms.revalidate.revalidatePage, {
        pageId: page._id,
        extraPaths: [],
      })
      expired += 1
    }

    const hasMore =
      dueStaging.length === SCHEDULED_TRANSITION_BATCH_SIZE ||
      dueExpiries.length === SCHEDULED_TRANSITION_BATCH_SIZE
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.pages.processScheduledTransitions,
        {}
      )
    }

    return { published, expired, hasMore }
  },
})

export const softDelete = mutation({
  args: { id: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.softDelete")
    const page = await ctx.db.get(id)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "delete")
    await requirePagePermission(ctx, page.pageType, "delete", {
      ownerId: page.createdBy,
    })
    await assertEditionReviewAllowsLifecycleChange(ctx, id)
    // Only archived pages can be moved to trash — forces an explicit
    // archive step before anything is removed.
    if (page.status !== "archived") {
      throw new ConvexError(
        "Only archived pages can be moved to trash. Archive it first."
      )
    }
    await occurrenceUsageWrites(ctx).patch(id, { deletedAt: Date.now() })
    // Plan 028 C5 — a trashed row must not hold live fan-out; otherwise
    // `pages.remove` on a still-referenced target refuses to delete because
    // of a source the operator can no longer reach through the UI.
    await clearPageReferences(ctx, id)
    await deletePageSearch(ctx, id)
    return null
  },
})

export const restore = mutation({
  args: { id: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.restore")
    const page = await ctx.db.get(id)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    // Patch using db.patch with explicit undefined — removes the field
    await occurrenceUsageWrites(ctx).patch(id, { deletedAt: undefined })
    // Restore the row's fan-out mirror to softDelete's clear above.
    await refreshPageReferences(ctx, { ...page, deletedAt: undefined })
    await syncPageSearch(ctx, { ...page, deletedAt: undefined })
    return null
  },
})

export const remove = mutation({
  args: { id: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    await requireOperationAccess(ctx)
    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "snapshot_active") {
      throw new ConvexError("PERMANENT_PAGE_PURGE_NOT_IMPLEMENTED")
    }
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    await assertLegacyPublicationWriterBlocked(ctx, "pages.remove")
    const page = await ctx.db.get(id)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "delete")
    await requirePagePermission(ctx, page.pageType, "delete", {
      ownerId: page.createdBy,
    })
    await assertEditionReviewAllowsLifecycleChange(ctx, id)
    const children = await getChildPageSummaries(ctx, id)
    if (children.length > 0) {
      throw new ConvexError(
        `This page has ${children.length} child page(s). Re-parent or delete them first.`
      )
    }
    // Plan 028 C5 + Plan 035 A1c — refuse deletion when another page or a
    // live menu still points at this page. The document guard short-circuits
    // at one row; the menu guard returns sorted, unique slugs so direct
    // mutation callers get the same actionable detail as `deleteImpact`.
    const [firstIncoming, menuSlugs] = await Promise.all([
      ctx.db
        .query("documentReferences")
        .withIndex("by_target", (q) => q.eq("targetId", id))
        .first(),
      getMenuSlugsReferencingPage(ctx, id),
    ])
    if (firstIncoming && menuSlugs.length > 0) {
      throw new ConvexError(
        "Cannot delete: this page is still referenced by another page and " +
          `linked from menu(s): ${menuSlugs.join(", ")}. ` +
          "Reassign or remove the page reference and remove the menu links first."
      )
    }
    if (firstIncoming) {
      throw new ConvexError(
        "Cannot delete: this page is still referenced by another page. " +
          "Reassign or remove the reference first."
      )
    }
    if (menuSlugs.length > 0) {
      throw new ConvexError(
        `Cannot delete: this page is still linked from menu(s): ${menuSlugs.join(", ")}. ` +
          "Remove those links or delete the menus first."
      )
    }
    const redirects = await getRedirectsToPage(ctx, id)
    await Promise.all(redirects.map((redirect) => ctx.db.delete(redirect._id)))
    await clearPageReferences(ctx, id)
    // Cascade the page's revision history (F6) — otherwise revisions are
    // orphaned forever and, once they hold a retired slice type, become
    // unreachable by any cleanup. The index makes this a bounded scan.
    const revisions = await ctx.db
      .query("pageRevisions")
      .withIndex("by_pageId_and_revisionNumber", (q) => q.eq("pageId", id))
      .collect()
    await Promise.all(revisions.map((revision) => ctx.db.delete(revision._id)))
    await deleteStagingByPageId(ctx, id)
    await deletePageSearch(ctx, id)
    await releaseBoundedPilotPageSlot(ctx, page.status === "published")
    await occurrenceUsageWrites(ctx).delete(id)
    return null
  },
})

const mediaReferenceBackfillResultValidator = v.object({
  pagesScanned: v.number(),
  pagesRefreshed: v.number(),
  isDone: v.boolean(),
})

async function backfillMediaReferencesBatchImpl(
  ctx: MutationCtx,
  cursor: string | null
): Promise<{
  pagesScanned: number
  pagesRefreshed: number
  isDone: boolean
  continueCursor: string
}> {
  const pageBatch: PaginationResult<Doc<"pages">> = await ctx.db
    .query("pages")
    .paginate({ numItems: MEDIA_REFERENCE_BACKFILL_BATCH_SIZE, cursor })
  let pagesRefreshed = 0

  for (const page of pageBatch.page) {
    if (page.deletedAt !== undefined) {
      await clearPageReferences(ctx, page._id)
      continue
    }
    await refreshPageReferences(ctx, page)
    pagesRefreshed++
  }

  return {
    pagesScanned: pageBatch.page.length,
    pagesRefreshed,
    isDone: pageBatch.isDone,
    continueCursor: pageBatch.continueCursor,
  }
}

export const backfillMediaReferences = mutation({
  args: {},
  returns: mediaReferenceBackfillResultValidator,
  handler: async (ctx) => {
    // Whole-table backfill — requires ability to update at least one page type.
    // Rows of forbidden types are still refreshed (this is a maintenance op the
    // admin/editor triggers, not a per-row write against the caller's grants).
    await requireAnyPageTypePermission(ctx, "update")
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "pages.backfillMediaReferences"
    )
    const result = await backfillMediaReferencesBatchImpl(ctx, null)
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.pages.backfillMediaReferencesBatch,
        { cursor: result.continueCursor }
      )
    }
    return {
      pagesScanned: result.pagesScanned,
      pagesRefreshed: result.pagesRefreshed,
      isDone: result.isDone,
    }
  },
})

export const backfillMediaReferencesBatch = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: mediaReferenceBackfillResultValidator,
  handler: async (ctx, { cursor }) => {
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "pages.backfillMediaReferencesBatch"
    )
    const result = await backfillMediaReferencesBatchImpl(ctx, cursor)
    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.pages.backfillMediaReferencesBatch,
        { cursor: result.continueCursor }
      )
    }
    return {
      pagesScanned: result.pagesScanned,
      pagesRefreshed: result.pagesRefreshed,
      isDone: result.isDone,
    }
  },
})

export const touchPagePresence = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    await touchPagePresenceRow(ctx, pageId, {
      userId: auth.tokenIdentifier,
      email: auth.email,
    })
    return null
  },
})

export const leavePagePresence = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    await leavePagePresenceRow(ctx, pageId, {
      userId: auth.tokenIdentifier,
      email: auth.email,
    })
    return null
  },
})

export const acquirePageEditorLock = mutation({
  args: {
    pageId: v.id("pages"),
    force: v.optional(v.boolean()),
  },
  returns: acquirePageEditorLockResultValidator,
  handler: async (ctx, { pageId, force }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    return await acquirePageEditorLockRow(
      ctx,
      pageId,
      { userId: auth.tokenIdentifier, email: auth.email },
      force ?? false
    )
  },
})

export const releasePageEditorLock = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    await releasePageEditorLockRow(ctx, pageId, {
      userId: auth.tokenIdentifier,
      email: auth.email,
    })
    return null
  },
})

/**
 * One editor heartbeat = one page read.
 *
 * The editor previously beat `touchPagePresence` AND `acquirePageEditorLock`
 * on every tick. Each did its own `ctx.db.get(pageId)`, and a `pages` document
 * carries every slice body for every locale — so a beat read the full page
 * twice just to reach `pageType` and `createdBy` for the permission check.
 * Convex has no projection on `db.get`, so the only levers are reading less
 * often (the client raised the interval and now skips hidden tabs) and reading
 * once instead of twice — this mutation.
 *
 * The granular `touchPagePresence` / `acquirePageEditorLock` mutations remain:
 * the latter still serves the explicit take-over flow, which needs `force`.
 */
export const heartbeatPageEditor = mutation({
  args: { pageId: v.id("pages") },
  returns: acquirePageEditorLockResultValidator,
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    const identity = { userId: auth.tokenIdentifier, email: auth.email }

    await touchPagePresenceRow(ctx, pageId, identity)
    // `force: false` — a heartbeat must never displace another editor's lock.
    // Taking over is an explicit user action routed through
    // `acquirePageEditorLock`.
    return await acquirePageEditorLockRow(ctx, pageId, identity, false)
  },
})

// ============================================================
// ADR-0041 — Per-page atomic staging (Deploy 1: Widen ⇒ Deploy 3: Narrow)
//
// The three mutations below are the staging-aware write surface. Deploy
// 3 (Narrow) retired the legacy `pages.updateLocaleContent`; the editor
// now writes via `updateDraft` and promotes via `pages.publish` — the
// row-level `pages.update` handles the remaining live-immediate fields
// (hierarchy, `status: "draft" | "archived"`, `expiresAt`).
// ============================================================

/**
 * Assert that the caller holds the editor lock on `pageId`. ADR-0041 §4
 * promotes the previously-advisory lock to a hard save-time gate for
 * `updateDraft` / `discardDraft`. Publish deliberately does NOT require
 * the lock — a reviewer must be able to promote without displacing the
 * editor.
 *
 * The active-holder check reuses `getPageEditorLockState`, which returns
 * `status: "available"` when no holder is inside `PAGE_LOCK_ACTIVE_MS`
 * — the ADR's "heartbeat lapse mid-session → autosave hard-fails on the
 * next mutation" failure mode. The client re-acquires on autosave when
 * available; if someone else has taken over, the client surfaces the
 * take-over prompt described in §4.
 */
async function requireHeldPageEditorLock(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  userId: string
): Promise<void> {
  const state = await getPageEditorLockState(ctx, pageId, userId)
  if (state.status === "available") {
    throw new ConvexError(
      "Reacquire the editor lock before saving — it lapsed while idle."
    )
  }
  if (!state.isMine) {
    throw new ConvexError(
      "Someone else is editing this page. Reload to keep your changes as a new staging revision."
    )
  }
}

/**
 * Build a fresh per-locale content block using the descriptor's declared
 * shape. Optional fields with an empty-string / undefined value are
 * omitted so the stored bag stays in the pre-C8 "no empty meta" shape
 * and clearing round-trips correctly.
 */
function buildLocaleBlockFromDraft(
  descriptor: (typeof contentTypeDefs)[keyof typeof contentTypeDefs],
  localizedBag: Record<string, unknown>,
  nextSlices: readonly Slice[] | undefined
): Record<string, unknown> {
  const localeBlock: Record<string, unknown> = {}
  for (const [key, def] of Object.entries(descriptor.localizedFields)) {
    const value = localizedBag[key]
    const isOptional = def.validator.isOptional === "optional"
    if (isOptional && (value === undefined || value === "")) continue
    localeBlock[key] = value
  }
  if (nextSlices !== undefined) {
    localeBlock.slices = nextSlices
  }
  return localeBlock
}

/**
 * Save fields into a page's staging row (ADR-0041 §3). Lazy-creates the
 * row on first call. Every field is optional so the same mutation covers
 * partial autosaves (a single title tweak) and full multi-locale writes
 * (an AI translation of EN into FR + AR shipping together).
 *
 * Args mirror the STAGED subset of `pages.update` — hierarchy fields
 * (`parentId`/`siblingOrder`), `status`, and `expiresAt` are intentionally
 * absent; those bypass staging per ADR §1 / §7.
 *
 * Content is a `Record<locale, contentDraftInput>` where every arm's
 * `pageType` must equal the page's live pageType (cross-arm probe guard
 * — a stale editor can't smuggle post-shaped content onto an author
 * row). Each entry replaces the corresponding locale's stored content
 * atomically.
 *
 * Slug uniqueness is intentionally NOT enforced here — the ADR
 * (Consequences → "Slug uniqueness re-validates at publish") allows two
 * pages to concurrently stage the same slug; publish rejects the second.
 */
export const updateDraft = mutation({
  args: {
    pageId: v.id("pages"),
    // Full staged content bag, one entry per locale being written. A locale
    // omitted from the record leaves that locale's currently-staged (or
    // currently-live) content untouched.
    content: v.optional(v.record(v.string(), contentDraftInputValidator)),
    expectedPresentationCatalogRevision: v.optional(v.string()),
    slug: v.optional(v.string()),
    localizedSlugs: v.optional(v.record(v.string(), v.string())),
    seo: v.optional(seoValidator),
    scheduledAt: v.optional(v.union(v.number(), v.null())),
    template: v.optional(v.string()),
    // Post-listing card surface (shared across arms per ADR-0037 §4).
    showOnHomepage: v.optional(v.boolean()),
    displayMode: v.optional(
      v.union(v.literal("card"), v.literal("full"), v.literal("both"))
    ),
    cardImageMediaId: v.optional(v.id("media")),
    cardExcerpt: v.optional(v.string()),
    // Descriptor-generic shared fields. JSON is an explicit transport
    // envelope rather than `v.any()`: the handler parses it, rejects keys
    // outside the active descriptor, and lets the generated staging union
    // validate the resulting values at the database boundary.
    sharedFieldsJson: v.optional(v.string()),
    // Post-arm descriptor sharedFields.
    tags: v.optional(v.array(v.string())),
    category: v.optional(v.union(v.string(), v.null())),
    authorIds: v.optional(v.array(v.id("pages"))),
    featured: v.optional(v.boolean()),
    promoteToFront: v.optional(v.boolean()),
    // Author-arm descriptor sharedFields.
    name: v.optional(v.string()),
    socials: v.optional(
      v.union(
        v.array(contentTypeDefs.author.sharedFields.socials.validator.element),
        v.null()
      )
    ),
    // Testimonial-arm descriptor sharedFields.
    personName: v.optional(v.string()),
    personRole: v.optional(v.union(v.string(), v.null())),
    personCompany: v.optional(v.union(v.string(), v.null())),
    personImage: v.optional(v.union(imagePrimitive().validator, v.null())),
    sourceUrl: v.optional(v.union(v.string(), v.null())),
    // Freshness token — references the current staging row's `updatedAt`.
    // Lazy-create semantics: a token against a no-longer-existing staging
    // row (post-promote) is treated as fresh so autosave can rebuild on
    // top of the newly-live content (ADR-0041 §4).
    expectedUpdatedAt: v.optional(v.number()),
  },
  returns: v.object({ updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const writeOptions: WriteOptions = {}
    await assertLegacyPublicationWriterBlocked(ctx, "pages.updateDraft")
    await requireOperationAccess(ctx)
    const page = await ctx.db.get(args.pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    await requireHeldPageEditorLock(ctx, args.pageId, auth.tokenIdentifier)

    // Cross-arm probe guard — a stale editor cannot smuggle post-shaped
    // content onto an author row.
    if (args.content !== undefined) {
      for (const [locale, draft] of Object.entries(args.content)) {
        if (draft.pageType !== page.pageType) {
          throw new ConvexError(
            `Cannot save ${draft.pageType} content on a ${page.pageType} page (locale '${locale}')`
          )
        }
      }
    }

    const descriptor = contentTypeDefs[page.pageType]
    const sliceBody = descriptor.capabilities.sliceBody
    const staging = await getStagingByPageId(ctx, args.pageId)
    assertStagingFresh(staging, args.expectedUpdatedAt)
    const changesWorkingDraft = Object.entries(args).some(
      ([key, value]) =>
        key !== "pageId" && key !== "expectedUpdatedAt" && value !== undefined
    )
    if (changesWorkingDraft) {
      await recordEditionDraftEdit(ctx, {
        pageId: args.pageId,
        actorId: auth.tokenIdentifier,
      })
    }

    // ADR-0041 Deploy 3 (Narrow) — carry forward the `translation:manual`
    // gate the retired `updateLocaleContent` enforced on new-locale
    // creation. A custom role with `pages.<type>:update` but without
    // `translation:manual` (reachable under ADR-0035/0036) must still be
    // blocked from seeding a brand-new locale. Existing locales already
    // present on either the live row or the staging working copy are
    // treated as "editing", not creation, so no translation gate fires
    // for them.
    if (args.content !== undefined) {
      const existingLive = page.content ?? {}
      const existingStaging = (staging?.content ?? {}) as Record<
        string,
        unknown
      >
      for (const locale of Object.keys(args.content)) {
        const isNewLocale =
          existingLive[locale] === undefined &&
          existingStaging[locale] === undefined
        if (isNewLocale) {
          await requirePermission(ctx, "translation:manual", {
            ownerId: page.createdBy,
          })
          break
        }
      }
    }

    // ADR-0041 §7 ⚑4 — scheduling AND cancel-schedule both require
    // `publish`. Scheduling is a delayed publish decision; cancelling
    // undoes one — gated symmetrically. Detect either transition by
    // comparing the incoming `scheduledAt` against the current staged
    // value (staging is authoritative — a running staging row shadows
    // the page's scheduledAt at Deploy 1's widening boundary too).
    if (args.scheduledAt !== undefined) {
      const currentStagedSchedule = staging?.scheduledAt
      const nextSchedule = args.scheduledAt ?? undefined
      const settingSchedule =
        nextSchedule !== undefined && nextSchedule !== currentStagedSchedule
      const cancellingSchedule =
        nextSchedule === undefined && currentStagedSchedule !== undefined
      if (settingSchedule || cancellingSchedule) {
        await requirePagePermission(ctx, page.pageType, "publish", {
          ownerId: page.createdBy,
        })
      }
    }

    // Rich-text and slice-identity validation run per locale. The full slice
    // diff remains necessary to reject archived types from a draft save.
    const nextContentByLocale: Record<string, Record<string, unknown>> = {}
    let anyContentWrite = false
    if (args.content !== undefined) {
      const priorContent = (staging?.content ?? page.content ?? {}) as Record<
        string,
        unknown
      >
      const nextContentForDiff: Record<string, { slices: readonly Slice[] }> =
        {}
      const priorContentForDiff: Record<string, unknown> = {}
      for (const [locale, draft] of Object.entries(args.content)) {
        anyContentWrite = true
        const localizedBag = writeFieldMap(
          descriptor.localizedFields,
          draft.localized as Record<string, unknown>,
          writeOptions
        )
        validateFieldMapRichText(descriptor.localizedFields, localizedBag)
        const nextSlices: readonly Slice[] | undefined =
          sliceBody && "slices" in draft
            ? draft.slices.map(
                (slice) => writeSliceFields(slice, locale, writeOptions).value
              )
            : undefined
        if (nextSlices !== undefined) {
          validateUniqueSliceIds(nextSlices)
          validateSlicesRichText(nextSlices)
        }
        nextContentByLocale[locale] = buildLocaleBlockFromDraft(
          descriptor,
          localizedBag,
          nextSlices
        )
        if (nextSlices !== undefined) {
          nextContentForDiff[locale] = { slices: nextSlices }
          priorContentForDiff[locale] = priorContent[locale]
        }
      }
      if (Object.keys(nextContentForDiff).length > 0) {
        await requireSliceMutationsPermitted(
          ctx,
          diffSliceMutations(
            priorContentForDiff as Record<
              string,
              { slices?: readonly Slice[] } | undefined
            >,
            nextContentForDiff
          ),
          {
            // Keep the same cross-locale rule as pages.update. A save cannot
            // bypass an unavailable slice by addressing a different locale.
            content: { ...priorContent, ...nextContentByLocale },
            existingContent: priorContent,
            operation: "edit",
            expectedPresentationCatalogRevision:
              args.expectedPresentationCatalogRevision,
          }
        )
      }
    }

    // Compose the staging patch. Each optional arg follows the
    // pages.update convention: `undefined` = untouched, `null` = clear.
    const now = Date.now()
    const stagingPatch: Record<string, unknown> = { updatedAt: now }

    if (args.slug !== undefined) stagingPatch.slug = args.slug
    if (args.localizedSlugs !== undefined)
      stagingPatch.localizedSlugs = args.localizedSlugs
    if (args.seo !== undefined) stagingPatch.seo = args.seo
    if (args.scheduledAt !== undefined)
      stagingPatch.scheduledAt = args.scheduledAt ?? undefined
    if (args.template !== undefined) stagingPatch.template = args.template
    if (args.showOnHomepage !== undefined)
      stagingPatch.showOnHomepage = args.showOnHomepage
    if (args.displayMode !== undefined)
      stagingPatch.displayMode = args.displayMode
    if (args.cardImageMediaId !== undefined)
      stagingPatch.cardImageMediaId = args.cardImageMediaId
    if (args.cardExcerpt !== undefined)
      stagingPatch.cardExcerpt = stripHtml(args.cardExcerpt)

    if (args.sharedFieldsJson !== undefined) {
      let genericSharedPatch: Record<string, unknown>
      try {
        genericSharedPatch = parseDescriptorSharedFieldPatch(
          descriptor,
          args.sharedFieldsJson,
          SYSTEM_OWNED_SHARED_FIELDS
        )
      } catch (error) {
        throw new ConvexError(
          error instanceof Error ? error.message : "Invalid shared fields"
        )
      }
      Object.assign(
        genericSharedPatch,
        writeFieldMap(descriptor.sharedFields, genericSharedPatch, writeOptions)
      )
      validateFieldMapRichText(descriptor.sharedFields, genericSharedPatch)
      Object.assign(stagingPatch, genericSharedPatch)
    }

    // Dedicated sharedFields retain their existing business rules and
    // relationship normalization. Generic descriptor fields use the envelope
    // above, so adding one no longer requires another mutation argument.
    const targetingPost = page.pageType === "post"
    if (args.tags !== undefined) {
      if (!targetingPost && args.tags.length > 0) {
        throw new ConvexError(
          `tags is only valid on pageType='post' (row is '${page.pageType}')`
        )
      }
      if (targetingPost) {
        stagingPatch.tags = await ensureTagsForLabels(ctx, args.tags)
      }
    }
    if (args.category !== undefined) {
      if (!targetingPost) {
        if (args.category !== null && args.category.length > 0) {
          throw new ConvexError(
            `category is only valid on pageType='post' (row is '${page.pageType}')`
          )
        }
      } else {
        // Preserve `null` verbatim on staging — it is the "clear at
        // publish" signal per the null-preservation rule. Publish
        // + `overlayStagingOnPage` translate `null` → field-removal;
        // collapsing to `undefined` here would silently drop the clear
        // intent so the value would spring back after Save.
        stagingPatch.category = args.category
      }
    }
    if (args.authorIds !== undefined) {
      if (!targetingPost && args.authorIds.length > 0) {
        throw new ConvexError(
          `authorIds is only valid on pageType='post' (row is '${page.pageType}')`
        )
      }
      if (targetingPost) {
        const effectivePage = overlayStagingOnPage(page, staging)
        stagingPatch.authorIds =
          (await resolvePageRelations(
            ctx,
            args.authorIds,
            POST_BYLINE_ALLOWED_TYPES,
            effectivePage.pageType === "post"
              ? effectivePage.authorIds
              : undefined
          )) ?? null
      }
    }
    if (args.featured !== undefined) {
      if (!targetingPost) {
        throw new ConvexError(
          `featured is only valid on pageType='post' (row is '${page.pageType}')`
        )
      }
      stagingPatch.featured = args.featured
    }
    if (args.promoteToFront !== undefined) {
      if (!targetingPost) {
        throw new ConvexError(
          `promoteToFront is only valid on pageType='post' (row is '${page.pageType}')`
        )
      }
      // Note: `autoUnsetOtherPromoteToFront` fires at publish time (§1
      // Cross-row side effects) — not on save. Staging can hold the flag
      // without unsetting other posts yet.
      stagingPatch.promoteToFront = args.promoteToFront
    }
    const targetingAuthor = page.pageType === "author"
    if (args.name !== undefined) {
      if (!targetingAuthor) {
        throw new ConvexError(
          `name is only valid on pageType='author' (row is '${page.pageType}')`
        )
      }
      const trimmed = args.name.trim()
      if (trimmed.length === 0) {
        throw new ConvexError("Author name cannot be empty")
      }
      stagingPatch.name = trimmed
    }
    if (args.socials !== undefined) {
      if (!targetingAuthor) {
        if (args.socials !== null && args.socials.length > 0) {
          throw new ConvexError(
            `socials is only valid on pageType='author' (row is '${page.pageType}')`
          )
        }
      } else {
        stagingPatch.socials =
          args.socials === null
            ? null
            : writeFieldMap(descriptor.sharedFields, { socials: args.socials })
                .socials
      }
    }
    const targetingTestimonial = page.pageType === "testimonial"
    if (args.personName !== undefined) {
      if (!targetingTestimonial) {
        throw new ConvexError(
          `personName is only valid on pageType='testimonial' (row is '${page.pageType}')`
        )
      }
      const trimmed = args.personName.trim()
      if (trimmed.length === 0) {
        throw new ConvexError("Testimonial personName cannot be empty")
      }
      stagingPatch.personName = trimmed
    }
    if (args.personRole !== undefined) {
      if (!targetingTestimonial) {
        if (args.personRole !== null && args.personRole.length > 0) {
          throw new ConvexError(
            `personRole is only valid on pageType='testimonial' (row is '${page.pageType}')`
          )
        }
      } else {
        stagingPatch.personRole = args.personRole
      }
    }
    if (args.personCompany !== undefined) {
      if (!targetingTestimonial) {
        if (args.personCompany !== null && args.personCompany.length > 0) {
          throw new ConvexError(
            `personCompany is only valid on pageType='testimonial' (row is '${page.pageType}')`
          )
        }
      } else {
        stagingPatch.personCompany = args.personCompany
      }
    }
    if (args.personImage !== undefined) {
      if (!targetingTestimonial) {
        if (args.personImage !== null) {
          throw new ConvexError(
            `personImage is only valid on pageType='testimonial' (row is '${page.pageType}')`
          )
        }
      } else {
        stagingPatch.personImage = args.personImage
      }
    }
    if (args.sourceUrl !== undefined) {
      if (!targetingTestimonial) {
        if (args.sourceUrl !== null && args.sourceUrl.length > 0) {
          throw new ConvexError(
            `sourceUrl is only valid on pageType='testimonial' (row is '${page.pageType}')`
          )
        }
      } else {
        stagingPatch.sourceUrl = args.sourceUrl
      }
    }

    // Merge the incoming content bags on top of prior staging content
    // (per-locale overlay — an unedited locale keeps its prior bag). The
    // arm-shape cast mirrors the pattern used in `restoreRevisionAsDraft`
    // — pageType has been gated above so the merged record is arm-safe.
    //
    // Critical: on LAZY-CREATE (no staging row yet), the prior side must
    // come from `page.content`, not `{}`. Publish does a wholesale
    // `pages.content = staging.content` promote, and staging is the
    // complete working copy — so an EN-only first-save on a live
    // `{en, fr}` page must carry FR through untouched. Without this
    // seed, publish would silently drop FR. Only `content` needs
    // seeding; the other staged fields are individually optional and
    // publish only promotes those explicitly present in staging.
    let mergedContent: Record<string, unknown> | undefined
    if (anyContentWrite) {
      const priorSource =
        staging?.content !== undefined ? staging.content : page.content
      const prior = (priorSource ?? {}) as Record<string, unknown>
      mergedContent = { ...prior }
      for (const [locale, block] of Object.entries(nextContentByLocale)) {
        mergedContent[locale] = block
      }
      stagingPatch.content = mergedContent
    }

    // §8 option (b) — denormalized effective titles for admin overlay.
    // Rebuild from whatever content the row will hold after this patch
    // (prior staging content overlaid with the incoming bags, or, on a
    // fresh row with no content write, the live page's titles as a
    // best-effort seed so the admin list has something to show).
    const effectiveContentForTitles =
      (mergedContent as Record<string, { title?: string }> | undefined) ??
      (staging?.content as Record<string, { title?: string }> | undefined) ??
      (page.content as Record<string, { title?: string }> | undefined)
    const effectiveTitles = pickEffectiveTitles(effectiveContentForTitles)
    if (effectiveTitles !== undefined) {
      stagingPatch.effectiveTitles = effectiveTitles
    }

    if (staging) {
      await occurrenceUsageWrites(ctx).patch(staging._id, stagingPatch)
    } else {
      // Lazy-create: seed the row with the page's arm + createdBy, then
      // apply the patch on top. The `pageType` literal locks the arm at
      // insert time so subsequent patches stay type-safe.
      await occurrenceUsageWrites(ctx).insert("pageStaging", {
        pageId: args.pageId,
        pageType: page.pageType,
        createdBy: auth.tokenIdentifier,
        updatedAt: now,
        ...stagingPatch,
      } as Parameters<typeof ctx.db.insert<"pageStaging">>[1])
    }

    // No revision creation (§6 — rollback lands at PUBLISH time), no
    // `refreshPageReferences` / `syncPageSearch` /
    // `revalidatePage` — those are publish-time fan-out (§Consequences)
    // and staging edits do not touch them. `create` / `duplicate` /
    // `publish` seed the reference + search tables with the correct
    // staging overlay; `updateDraft` autosaves ride that seed until
    // publish. This keeps autosave cheap (no O(locales) writes per
    // save) and preserves PR A's decision.

    return { updatedAt: now }
  },
})

/**
 * The promote body shared by the public `publish` mutation and the
 * scheduled-publish cron (ADR-0041 Deploy 2 PR B). Given a page + its
 * staging row + the merged nextPage (per `overlayStagingOnPage`) + a
 * validated pre-publish checklist, this compose-and-write helper:
 *
 *   1. Re-checks slug uniqueness against the live tree (two pages can
 *      concurrently stage the same slug — first-to-publish wins).
 *   2. Composes the promote patch (status/publishedAt + every staging
 *      field, with descriptor sharedField null-preservation).
 *   3. Runs the sticky auto-unset for `promoteToFront`.
 *   4. Archives the outgoing snapshot as a revision (`reason` + actor).
 *   5. Patches the page, refreshes references + search,
 *      rebuilds descendant ancestry if the slug changed, schedules a
 *      revalidate, and deletes the staging row.
 *
 * The caller is responsible for auth and for pre-computing checklist
 * (throwing / graceful-clearing scheduledAt is the caller's policy).
 *
 * Split point rationale: the public `publish` throws on a failed checklist;
 * the cron catches it and clears `staging.scheduledAt` so a permanently
 * unpublishable page doesn't hot-loop the cron every minute (advisor
 * caught this class of bug in Deploy 1). Keeping the checklist call OUT
 * of this helper lets each caller apply its own recovery policy.
 */
async function performPublish(
  ctx: MutationCtx,
  args: {
    page: Doc<"pages">
    staging: Doc<"pageStaging">
    storedStaging: Doc<"pageStaging">
    checklist: PrePublishChecklist
    reason: "publish" | "scheduled_publish"
    actorUserId: string | undefined
    cfg: LocaleConfig
    workflowApproval?: EditionPublishApproval
  },
  writeOptions: WriteOptions = {}
): Promise<{ updatedAt: number }> {
  const { page, checklist, reason, actorUserId, cfg } = args
  assertContentTypeIsActive(page.pageType, "publish")
  await assertBoundedPilotCanPublish(ctx, page.status === "published")
  const repairedStaging = withRepairedStagingSliceIds(args.staging)
  const staging = {
    ...repairedStaging,
    ...(repairedStaging.content
      ? {
          content: writePageContent(page.pageType, repairedStaging.content, {
            ...writeOptions,
            readLegacyShapes: true,
            trustedSource: {
              recordId: args.staging._id,
              version: args.staging.updatedAt,
              content: args.storedStaging.content,
              repairedIdentityContent: repairedStaging.content,
            },
          }).value,
        }
      : {}),
  } as Doc<"pageStaging">
  const workflowApproval =
    args.workflowApproval ??
    (await assertEditionCanPublish(ctx, {
      page,
      staging: args.staging,
    }))
  const repairedSourcePage = withRepairedPageSliceIds(page)
  const repairedPage = {
    ...repairedSourcePage,
    content: writePageContent(page.pageType, repairedSourcePage.content, {
      ...writeOptions,
      readLegacyShapes: true,
      trustedSource: {
        recordId: page._id,
        version: page.updatedAt,
        content: page.content,
        repairedIdentityContent: repairedSourcePage.content,
      },
    }).value,
  } as Doc<"pages">
  const nextPage = overlayStagingOnPage(repairedPage, staging)
  // Existing legacy publication retains stored Working Draft choices. Inspect
  // the live bag too so a draft cannot hide malformed or absent-Type content.
  await assertSliceMutationIntegrity(
    ctx,
    diffSliceMutations(page.content, page.content),
    { existingContent: page.content, operation: "publish" }
  )
  await assertSliceMutationIntegrity(
    ctx,
    diffSliceMutations(nextPage.content, nextPage.content),
    {
      existingContent: nextPage.content,
      content: nextPage.content,
      operation: "publish",
    }
  )
  const pageId = page._id

  // URLs before this publish, so a slug/parent change purges the old
  // locations too.
  const oldPublicUrls = Object.values(localizedUrlsForPage(page, cfg))

  // Re-run slug uniqueness against the LIVE tree — two pages can
  // concurrently stage the same slug per ADR Consequences; the first
  // to publish wins.
  //
  // Collect every changed slug first, then validate them in a single table
  // scan. This previously ran one full scan per changed slug, so publishing a
  // three-locale page scanned the `pages` table four times.
  const changedSlugs: string[] = []
  if (nextPage.slug !== page.slug) {
    changedSlugs.push(nextPage.slug)
  }
  if (nextPage.localizedSlugs) {
    for (const [locale, ls] of Object.entries(nextPage.localizedSlugs)) {
      const before = page.localizedSlugs?.[locale]
      if (ls && ls !== before) {
        changedSlugs.push(ls)
      }
    }
  }
  await ensureSlugsUnique(ctx, changedSlugs, pageId)

  // Publish is universally the make-live verb — flip status regardless
  // of prior draft/archived state (§7).
  const now = Date.now()
  const wasPublished = page.status === "published"
  const patch: Record<string, unknown> = {
    updatedAt: now,
    status: "published",
    publishedAt: wasPublished ? page.publishedAt : now,
  }
  // Fold every staging field into the live-row patch. `overlayStagingOnPage`
  // already computed the merged shape; re-derive the patch diff so we only
  // send the actual overrides to `ctx.db.patch`.
  if (staging.content !== undefined) {
    patch.content = staging.content
  } else if (repairedPage.content !== page.content) {
    patch.content = repairedPage.content
  }
  if (staging.slug !== undefined) patch.slug = staging.slug
  if (staging.localizedSlugs !== undefined)
    patch.localizedSlugs = staging.localizedSlugs
  if (staging.seo !== undefined) patch.seo = staging.seo
  if (staging.template !== undefined) patch.template = staging.template
  if (staging.showOnHomepage !== undefined)
    patch.showOnHomepage = staging.showOnHomepage
  if (staging.displayMode !== undefined) patch.displayMode = staging.displayMode
  if (staging.cardImageMediaId !== undefined)
    patch.cardImageMediaId = staging.cardImageMediaId
  if (staging.cardExcerpt !== undefined) patch.cardExcerpt = staging.cardExcerpt

  // Null-preservation rule (ADR-0041 shared-field clear semantics):
  // `null` on staging is the "clear this field at publish" signal —
  // translate to `undefined` so Convex actually removes the field
  // from the row. `undefined` on staging = "no change". Any other
  // value replaces. Matches `overlayStagingOnPage` — the two must
  // agree.
  const descriptor = contentTypeDefs[page.pageType]
  for (const key of Object.keys(descriptor.sharedFields)) {
    const value = (staging as unknown as Record<string, unknown>)[key]
    if (value === undefined) continue
    patch[key] = value === null ? undefined : value
  }

  Object.assign(
    patch,
    writeFieldMap(descriptor.sharedFields, patch, writeOptions)
  )

  // Sticky auto-unset (plan 029 C10 task 10) — same discipline as
  // `pages.update`: run when the promoted staging flag is `true` and
  // the row previously did not hold it.
  if (
    page.pageType === "post" &&
    (staging as unknown as { promoteToFront?: boolean }).promoteToFront === true
  ) {
    await autoUnsetOtherPromoteToFront(ctx, pageId)
  }

  // ADR §6 — publish archives the OUTGOING live snapshot. First
  // publish (never-published) archives the empty row per §6 (revisions
  // UI may hide it). Scheduled publishes get the cron-canonical summary
  // instead of the interactive diff.
  const summary =
    reason === "scheduled_publish"
      ? ["Published automatically from scheduled publish time"]
      : summarizePageChange(page, nextPage as Doc<"pages">)
  await createPageRevision(
    ctx,
    page,
    reason,
    actorUserId,
    summary,
    snapshotPrePublishChecklist(checklist)
  )

  await occurrenceUsageWrites(ctx).patch(pageId, patch as Partial<Doc<"pages">>)
  const finalPage = { ...page, ...patch } as Doc<"pages">
  await refreshPageReferences(ctx, finalPage)
  await syncPageSearch(ctx, finalPage)

  // Deploy 1: publish + `update` are additive siblings; if publish
  // changes the base slug (rare here since it's the same slug moving
  // from staging to live), rebuild descendant ancestry to match.
  // Deploy 3 (Narrow): also rebuild when the localizedSlugs bag
  // changes shape or value — the retired `updateLocaleContent` did
  // both, and the ancestry cascade for a parent's per-locale slug
  // override belongs here now that publish is the only writer.
  const baseSlugChanged = page.slug !== finalPage.slug
  const localizedSlugsChanged =
    JSON.stringify(page.localizedSlugs ?? {}) !==
    JSON.stringify(finalPage.localizedSlugs ?? {})
  if (baseSlugChanged || localizedSlugsChanged) {
    await rebuildDescendantAncestry(ctx, pageId, cfg)
  }

  await ctx.scheduler.runAfter(0, internal.cms.revalidate.revalidatePage, {
    pageId,
    extraPaths: oldPublicUrls,
  })

  await recordEditionPublished(ctx, {
    pageId,
    approval: workflowApproval,
    actorId: actorUserId,
    origin: reason === "scheduled_publish" ? "scheduled" : "interactive",
  })

  // Clear the staging row — atomic per §9 (publish is one of the three
  // deterministic deletion paths).
  await occurrenceUsageWrites(ctx).delete(staging._id)

  return { updatedAt: now }
}

/**
 * Promote a page's staging row to live (ADR-0041 §3). Publish is
 * ALWAYS the make-live verb — on an archived page, it also returns
 * `status` to `published` (§7). Deletes the staging row on success.
 *
 * Not gated by the editor lock: a reviewer must be able to publish
 * without displacing the editor holding it.
 */
export const publish = mutation({
  args: {
    pageId: v.id("pages"),
    // No `expectedUpdatedAt` — publish is not a save. Reviewers may
    // publish out from under an in-flight editor; the ADR spells out the
    // subsequent autosave-rebuilds-fresh-staging semantics in §4.
  },
  returns: v.object({ updatedAt: v.number() }),
  handler: async (ctx, args) => {
    const { pageId } = args
    const writeOptions: WriteOptions = {}
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.publish")
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "publish")
    const auth = await requirePagePermission(ctx, page.pageType, "publish", {
      ownerId: page.createdBy,
    })
    const storedStaging = await getStagingByPageId(ctx, pageId)
    if (!storedStaging) {
      throw new ConvexError(
        "Nothing to publish — no staged changes for this page."
      )
    }
    const staging = withRepairedStagingSliceIds(storedStaging)

    const cfg = await getLocaleConfig(ctx)
    const nextPage = overlayStagingOnPage(page, staging)

    // Pre-publish checklist walks the merged staged content so a broken
    // relation or missing required field surfaces here (mid-mutation
    // reject with clean error) instead of after the publish landed.
    const checklist = await assertPrePublishAllowed(ctx, nextPage, cfg)

    return await performPublish(
      ctx,
      {
        page,
        staging,
        storedStaging,
        checklist,
        reason: "publish",
        actorUserId: auth.tokenIdentifier,
        cfg,
      },
      writeOptions
    )
  },
})

/**
 * Discard a page's staging row (ADR-0041 §9 path 2). Reverts to the
 * live snapshot on a published page; on a never-published page it
 * deletes the only copy of the content — the confirmation UX has to
 * carry that distinction ("Delete all content for this page?", not
 * "Discard changes?"), enforced in the client per ADR §9.
 *
 * Gated by `update` + hard lock (§4). Discard follows update rather
 * than a new `discard` permission per ADR §4 ("anyone who could have
 * made the changes can revert them").
 */
export const discardDraft = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    await assertLegacyPublicationWriterBlocked(ctx, "pages.discardDraft")
    const page = await ctx.db.get(pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    const auth = await requirePagePermission(ctx, page.pageType, "update", {
      ownerId: page.createdBy,
    })
    await requireHeldPageEditorLock(ctx, pageId, auth.tokenIdentifier)
    await recordEditionDraftDiscard(ctx, {
      pageId,
      actorId: auth.tokenIdentifier,
    })
    await deleteStagingByPageId(ctx, pageId)
    // No fan-out here — matches PR A's decision that staging edits stay
    // off the reference / search path. For a never-published
    // draft this leaves stale rows behind from `create`'s seed; those
    // are picked up on next save or on hard delete via
    // `deletePageSearch` + `clearPageReferences`. Cleanup can move here
    // in a follow-up if needed (owner call — the alternative "fan out
    // on discard" adds O(locales) writes to a rare action).
    return null
  },
})

/**
 * ADR-0041 §9 path 4 — abandoned-staging TTL sweep. One batch of at
 * most `STAGING_SWEEP_BATCH_SIZE` candidates per tick; reschedules
 * itself when more work may be queued (same discipline as
 * `processScheduledTransitions`).
 *
 * Two ADR-mandated exemptions:
 *
 *   (a) **Future `scheduledAt`** — a staging row scheduled 90 days out
 *       and never re-edited must NOT be swept, or the scheduled publish
 *       silently disappears.
 *   (b) **Never-published pages** — after the Deploy 2 hoist runs, a
 *       never-published page's `pages.content` is empty and no revision
 *       exists; the staging row is the sole copy of the content. In
 *       Deploy 1 the hoist has not run yet, so most never-published
 *       pages still have their content on `pages`, but the exemption is
 *       still correct: for pages that WERE staged post-Deploy-1 without
 *       ever being published, staging holds work the live row does not.
 */
export const sweepAbandonedStaging = internalMutation({
  args: {
    // Pagination cursor threaded across reschedules so exempt rows are
    // STEPPED PAST rather than re-fetched. Without this, a wall of
    // never-published staging rows (all exempt per ⚑2, all clustered
    // at the front of `by_updatedAt` because they're the oldest) would
    // starve the sweep: `.take(N)` returns the same 25 exempt rows every
    // reschedule, `deleted = 0`, `hasMore` stays true, loop forever.
    // First call passes no cursor; each self-reschedule advances it.
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, { cursor }) => {
    if (!(await shouldRunLegacyPageCron(ctx))) {
      return { scanned: 0, deleted: 0, hasMore: false }
    }
    await assertLegacyPublicationWriterBlocked(
      ctx,
      "pages.sweepAbandonedStaging"
    )
    const now = Date.now()
    const cutoff = now - STAGING_ABANDONED_TTL_MS
    const result = await ctx.db
      .query("pageStaging")
      .withIndex("by_updatedAt", (q) => q.lte("updatedAt", cutoff))
      .paginate({
        numItems: STAGING_SWEEP_BATCH_SIZE,
        cursor: cursor ?? null,
      })
    let deleted = 0
    for (const staging of result.page) {
      // Exemption (a): a future scheduledAt keeps the row alive.
      if (staging.scheduledAt !== undefined && staging.scheduledAt > now) {
        continue
      }
      // Exemption (b): never-published pages keep their staging row
      // indefinitely — page.publishedAt undefined AND status !== "published"
      // (a page whose status was archived after being published still
      // has publishedAt set, so this catches only the never-published
      // case per ADR §9 ⚑2).
      const page = await ctx.db.get(staging.pageId)
      if (!(await canEditionSweepStaging(ctx, staging.pageId))) {
        continue
      }
      if (
        page &&
        page.publishedAt === undefined &&
        page.status !== "published"
      ) {
        continue
      }
      await occurrenceUsageWrites(ctx).delete(staging._id)
      deleted += 1
    }
    const hasMore = !result.isDone
    if (hasMore) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.pages.sweepAbandonedStaging,
        { cursor: result.continueCursor }
      )
    }
    return { scanned: result.page.length, deleted, hasMore }
  },
})
