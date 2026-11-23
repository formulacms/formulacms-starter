import {
  occurrenceUsageWrites,
  occurrenceUsageMutation as mutation,
} from "../lib/publishing/staging"
import type { Infer } from "convex/values"
import {
  writePageContent,
  writeFieldMap,
  type WriteOptions,
} from "../lib/richtext/write"
import { ConvexError, v } from "convex/values"
import type { PaginationResult } from "convex/server"
import { query } from "../_generated/server"
import { api, } from "../_generated/api"
import type { QueryCtx, MutationCtx } from "../_generated/server"
import type { Id, Doc } from "../_generated/dataModel"
import { requireOperationAccess } from "../lib/access/policy"
import { getOwnerIdentity, ownerDisplayName } from "../lib/access/owner"
import type { OwnerPrincipal } from "../lib/access/owner"
import type { PageType } from "../lib/pages/types"
import { homeSlugsForLocale } from "../../lib/pages/home-aliases"
import { SUPPORTED_LOCALES } from "../../lib/i18n/config"
import {
  findPublishedLandingPageBySlug,
  resolveEffectiveHomePageId,
} from "../lib/pages/home"
import {
  diffBlockMutations,
  requireBlockMutationsPermitted,
} from "../lib/blocks/permissions"
import {
  buildPrePublishChecklistWithReferences,
  languageChecklistShape,
  prePublishChecklistValidator,
  projectPublicPage,
  projectPublicReferenceCard,
  type PublicPage,
  type PublicRelationCard,
} from "../lib/domains/publication"
import {
  enrichWithStagingOverlay,
  getStagingByPageId,
  overlayStagingOnPage,
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
import {
  createPublicSnapshotProjectionReader,
  projectSnapshotReferenceCard,
  type SnapshotPayload,
  readCurrentSnapshotProjection,
  readLiveAddressRows,
  readHeldHistoricalRows,
  readFrozenSnapshotProjection,
  isPageHiddenInLocaleOrAncestry,
  readPublicationAuthority,
  readPublicSnapshotLocaleAlternates,
  requireSnapshotAuthority,
} from "../lib/publishing/snapshots"
import { assertPublicLanguageVersion } from "../lib/language/state"
import { recordPublicChange } from "../lib/language/freshness"
import {
  initializeSuccessorPage,
  SITEMAP_PARTITION_CEILING,
  snapshotAdminPageRow,
  adminPageLocaleValidator,
  projectAdminPageLocales,
  type AdminLocaleSource,
} from "./publication"
import { assertIdBatchSize, pageTypeValidator } from "../lib/pages/types"
import { assertNoPagePurge } from "../lib/publishing/pagePurge"
import {
  assertBoundedPilotCanCreate,
  initializeBoundedPilotEnvelope as reconcileBoundedPilotEnvelope,
  readBoundedPilotEnvelope,
} from "../lib/pilotEnvelope"
import {
  buildLocaleRelativePath,
  isRoutableContentType,
  pathPrefixForContentType,
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
} from "../edition/workflow"

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
import { resolveRelations } from "../lib/blocks/resolve"
import {
  validateBlocksRichText,
  validateUniqueBlockIds,
} from "../lib/blocks/validate"
import {
  CONTENT_TYPES,
  contentTypeDefs,
  isActiveContentType,
} from "../lib/domains/contentModel"
import { blockValidator, type Block } from "../lib/blocks"
import {
  buildInitialLocalizedContent,
  descriptorDefaults,
} from "../lib/domains/contentModel"
import { ensureTagsForLabels } from "./tags"
import { publicPageValidator } from "../lib/contentTypes/publicValidator"
import {
  planDraftBackfill,
  sanitizeLocalizedSeo,
  stripMovedSharedValues,
} from "../lib/contentTypes/perLanguageFields"

// ============================================================
// Validators
// ============================================================

const statusValidator = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("archived")
)

const pagePickerRowValidator = v.object({
  _id: v.id("pages"),
  path: v.optional(v.string()),
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
  blocks: v.optional(v.array(blockValidator)),
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
const DEFAULT_PAGE_LIST_LIMIT = 500
const MAX_PAGE_LIST_LIMIT = 1000
const DEFAULT_PAGE_PICKER_LIMIT = 50
// At most 100 pages are projected per call. Supported content keeps their
// combined per-locale drafts under Convex's 16 MiB read limit (about 80 KiB
// average per locale draft with two locales, leaving room for metadata).
const MAX_PAGE_PICKER_LIMIT = 100
const PAGE_PICKER_CANDIDATE_LIMIT = 400

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
  state: Doc<"pagePublicationPageStates">,
  locale?: string
): Promise<PagePickerRow | null> {
  // Published paths are already projected. Draft ancestry below needs at most
  // one extra read for the requested language, never a parent-chain walk.
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
  const selected = textLocales.find((entry) => entry.locale === locale)
  let path = selected?.path
  if (selected && (path === "/" || selected.state === "draft")) {
    // Keep the home's human slug words; the picker address is a locale-relative
    // label, while actual link resolution continues to own the home alias.
    if (
      path === "/" ||
      !row.parentId ||
      pathPrefixForContentType(row.pageType) !== ""
    ) {
      path = buildLocaleRelativePath({
        pageType: row.pageType,
        slug: selected.slug!,
      })
    } else {
      const parents = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", row.parentId!).eq("locale", selected.locale)
        )
        .take(2)
      const parent = parents.length === 1 ? parents[0] : undefined
      if (
        parent?.hasCurrentSnapshot &&
        parent.currentSnapshotId &&
        parent.currentPath
      ) {
        path = buildLocaleRelativePath({
          pageType: row.pageType,
          slug: selected.slug!,
          ancestry: parent.currentPath === "/" ? "" : parent.currentPath,
        })
      }
    }
  }
  return {
    _id: row._id,
    ...(typeof path === "string" ? { path } : {}),
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
function assertPageIsActiveForOrdinaryOperation(
  page: Doc<"pages">,
  operation: "edit" | "delete" | "publish"
): void {
  assertContentTypeIsActive(page.pageType, operation)
}

/**
 * Resolve the set of `pageType`s the caller can privately (draft/archived)
 * read (ADR-0036). Used by batch-read helpers that would otherwise resolve
 * owner access once per page — one auth resolve, in-memory filter.
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

function assertActivePageType(pageType: PageType): void {
  // Release-excluded storage arms remain available to migrations, but never
  // acquire owner access merely because F01's installation principal is
  // otherwise authorized.
  if (!isActiveContentType(pageType)) {
    throw new ConvexError(
      `Content Type "${pageType}" is not active in this starter.`
    )
  }
}

function clampLimit(
  value: number | undefined,
  fallback: number,
  max: number
): number {
  return Math.min(Math.max(Math.floor(value ?? fallback), 1), max)
}

/** Run the rich-text write-path gate over every locale's blocks (ADR-0009). */
function validateContentRichText(
  content: Record<string, { blocks?: Block[] | undefined }> | undefined
): void {
  if (!content) return
  for (const locale of Object.values(content)) {
    if (locale?.blocks) validateBlocksRichText(locale.blocks)
  }
}

/** Enforce Block identity independently within each Localized Content. */
function validateContentBlockIds(
  content: Record<string, { blocks?: readonly Block[] | undefined }> | undefined
): void {
  if (!content) return
  for (const locale of Object.values(content)) {
    if (locale?.blocks) validateUniqueBlockIds(locale.blocks)
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
  const target = await ctx.db.get("pages", targetPageId)
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
  const explicitHome = await ctx.db.get("pages", cfg.homePageId)
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
  const media = await ctx.db.get("media", ref.mediaId)
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
    const parent: Doc<"pages"> | null = await ctx.db.get("pages", currentId)
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
      return projection?.publicPage ?? null
    }
    if (authority === "invalid") return null
    const page = await ctx.db.get("pages", id)
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
    const page = await ctx.db.get("pages", id)
    if (!page) return null
    if (!isActiveContentType(page.pageType)) return null
    assertActivePageType(page.pageType)
    await requireOperationAccess(ctx)
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
 * Same overlay shape as `getStagedPreviewById`, with a nullable owner-access
 * refusal. Unlike `getById`, this editor projection
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
    const page = await ctx.db.get("pages", id)
    if (!page) return null
    if (!isActiveContentType(page.pageType)) return null
    try {
      await requireOperationAccess(ctx)
    } catch {
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
          // A page the one-time backfill has not reached yet shows the old
          // shared values the way the backfill will write them.
          if (!pageState.perLanguageFieldsBackfill) {
            localized =
              planDraftBackfill({
                locale: state.locale,
                legacyLocale:
                  settings?.legacySharedFieldsLocale ??
                  settings?.defaultLocale ??
                  "",
                content: localized,
                sharedSeo: (shared.system as { seo?: Record<string, unknown> })
                  .seo,
                sharedCardExcerpt: (
                  shared.system as { cardExcerpt?: unknown }
                ).cardExcerpt,
                sharedCategory: (
                  shared.descriptor as unknown as { category?: unknown }
                ).category,
                hasCategoryField:
                  "category" in contentTypeDefs[page.pageType].localizedFields,
              }) ?? localized
          }
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
      // The values that moved into each language (ADR-0037 amendment,
      // 2026-11-17) are read from `content[locale]`, never from the shared blocks.
      const ownedShared = stripMovedSharedValues({
        system: shared.system as unknown as Record<string, unknown>,
        descriptor: shared.descriptor as unknown as Record<string, unknown>,
      })
      // Identity shell only: every authored field comes from successor drafts,
      // so a value cleared there (e.g. `parentId`) cannot reappear from the
      // retained legacy Page row.
      const projected = {
        _id: page._id,
        _creationTime: page._creationTime,
        pageType: page.pageType,
        createdAt: page.createdAt,
        ...(page.createdBy === undefined ? {} : { createdBy: page.createdBy }),
        ...ownedShared.descriptor,
        ...ownedShared.system,
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
    return null
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
    const page = await ctx.db.get("pages", authorPageId)
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
      const media = await ctx.db.get("media", card.imageMediaId)
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
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    await requireOperationAccess(ctx)
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
      const shape = await languageChecklistShape(ctx, {
        page,
        shared: sharedRows[0]!,
        locale: requestedLocale,
        slug,
        content,
        workingDraft: draftRows.length === 1,
      })
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
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    await requireOperationAccess(ctx)
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
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    return await getPageEditorLockState(ctx, pageId, auth.tokenIdentifier, now)
  },
})

/**
 * Row shape for the parent picker and the command palette.
 *
 * IMPORTANT — what this does and does not save. Convex has no projection
 * pushdown: the handler below still reads full `pages` documents, so this
 * validator does NOT reduce database I/O. What it reduces is the payload
 * streamed to the client, which bills against the separate data-egress limit
 * (also 1 GB/mo on the free plan). A full page document carries every block
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
 * save). Callers that need block bodies must keep using `list`.
 */
export const listSummaries = query({
  args: {
    limit: v.optional(v.number()),
  },
  returns: v.array(pageSummaryRowValidator),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    const allowedTypes = new Set(CONTENT_TYPES as PageType[])

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

export const listLinkablePages = query({
  args: {
    locale: v.optional(v.string()),
    search: v.optional(v.string()),
    includeDrafts: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(pagePickerRowValidator),
  handler: async (ctx, { locale, search, includeDrafts = true, limit }) => {
    await requireOperationAccess(ctx)
    const allowedTypes = new Set(CONTENT_TYPES as PageType[])
    const rowLimit = clampLimit(
      limit,
      DEFAULT_PAGE_PICKER_LIMIT,
      MAX_PAGE_PICKER_LIMIT
    )
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const pathLocale = locale ?? (await getLocaleConfig(ctx)).defaultLocale
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
        const row = await snapshotPagePickerRow(ctx, state, pathLocale)
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
        ...(await enrichWithStagingOverlay(ctx, active)).map((page) => {
          const path = buildLocaleRelativePath({
            pageType: page.pageType,
            slug: page.localizedSlugs?.[pathLocale] ?? page.slug,
            ancestry: page.localizedAncestryPaths?.[pathLocale] ?? page.ancestryPath,
          })
          return { ...pagePickerRow(page), ...(path === null ? {} : { path }) }
        })
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
              row.path,
              row.localizedTitles[locale],
              row.localizedSlugs?.[locale] ?? row.slug,
            ]
          : [
              row.path,
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
    await requireOperationAccess(ctx)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    const page = await ctx.db.get("pages", pageId)
    if (!page || page.deletedAt !== undefined) {
      return { status: "missing" as const }
    }
    const allowedTypes = new Set(CONTENT_TYPES as PageType[])
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
    await requireOperationAccess(ctx)
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

export const listRelationCandidates = query({
  args: {
    pageTypes: v.array(pageTypeValidator),
    tag: v.optional(v.string()),
    includeDrafts: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(pagePickerRowValidator),
  handler: async (ctx, { pageTypes, tag, includeDrafts, limit }) => {
    await requireOperationAccess(ctx)
    const allowedTypes = new Set(CONTENT_TYPES as PageType[])
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
    assertIdBatchSize(ids)
    await assertPublicLanguageVersion(ctx, languageVersion)
    const uniqueIds = [...new Set(ids)]
    const { defaultLocale, enabledLocales, homePageId } =
      await getLocaleConfig(ctx)
    const authority = await readPublicationAuthority(ctx)
    if (authority === "invalid") return {}
    if (authority === "snapshot_active") {
      if (!enabledLocales.includes(locale)) return {}
      const result: Record<string, string> = {}
      // One cached reader for the whole call: ancestors shared between ids
      // are verified once. It returns what readCurrentSnapshotProjection
      // returns for the same id and locale, and null when a gate is closed.
      const project = await createPublicSnapshotProjectionReader(ctx)
      for (const id of uniqueIds) {
        const projection = project ? await project(id, locale) : null
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
    const pages = await Promise.all(
      uniqueIds.map((id) => ctx.db.get("pages", id))
    )
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
    assertIdBatchSize(ids)
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

    const pages = await Promise.all(uniqueIds.map((id) => ctx.db.get("pages", id)))
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
    const mediaRows = await Promise.all(mediaIds.map((id) => ctx.db.get("media", id)))
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
    const mediaRows = await Promise.all(mediaIds.map((id) => ctx.db.get("media", id)))
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
    await requireOperationAccess(ctx)
    assertIdBatchSize(ids)
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
      ids.map(async (id) => ({ id, page: await ctx.db.get("pages", id) }))
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
    const rootPage = await ctx.db.get("pages", pageId)
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
      const page: Doc<"pages"> | null = await ctx.db.get("pages", currentId)
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
  const page = await ctx.db.get("pages", pageId)
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
      (await isValidHistoricalRow(ctx, historicalRows[0]!, locale)) &&
      // ADR-0037 amendment (2026-11-17): an old address of a version the
      // translation switch hides (its own type or an ancestor's, from its
      // frozen publication ancestry) is not a match.
      !(await isPageHiddenInLocaleOrAncestry(ctx, historicalRows[0]!.pageId, locale))
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
          //
          // ADR-0037 amendment (2026-11-17): an old address whose own
          // language version is hidden by the translation switch answers
          // not found, never a redirect into another language.
          if (
            await isPageHiddenInLocaleOrAncestry(
              ctx,
              continuity.pageId,
              continuity.locale
            )
          ) {
            return {
              authority: "snapshot_active" as const,
              disposition: "historical_unavailable" as const,
            }
          }
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
          const transition = await ctx.db.get("siteLanguageTransitions", transitionId)
          // ADR-0037 amendment (2026-11-17): same rule as the M05 set above;
          // the old address belongs to the transition's source language.
          if (
            transition &&
            (await isPageHiddenInLocaleOrAncestry(
              ctx,
              continuity.pageId,
              transition.sourceLocale
            ))
          ) {
            return {
              authority: "snapshot_active" as const,
              disposition: "historical_unavailable" as const,
            }
          }
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
    // Access first: a caller without it never reaches content validation.
    const auth = await requireOperationAccess(ctx)
    const writeOptions: WriteOptions = {}
    args = {
      ...args,
      content: writePageContent(args.pageType, args.content, writeOptions)
        .value,
    }
    const publicationAuthority = await readPublicationAuthority(ctx)
    if (publicationAuthority === "invalid") {
      throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    }
    if (publicationAuthority !== "snapshot_active") {
      // Pages are created only on the snapshot path.
      await requireSnapshotAuthority(ctx)
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
    await requireBlockMutationsPermitted(
      ctx,
      diffBlockMutations(undefined, args.content),
      {
        content: args.content,
        operation: "create",
        expectedPresentationCatalogRevision:
          args.expectedPresentationCatalogRevision,
      }
    )
    validateContentBlockIds(args.content)
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
    // this transaction. Retained Page slugs are not the route authority.

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
    // ADR-0037 amendment (2026-11-17): the search, social and card values and
    // the post category belong to each language. A new page keeps the ones the
    // caller sent in every language it is created with.
    if (publicationAuthority === "snapshot_active") {
      const seoValues = sanitizeLocalizedSeo(args.seo)
      const excerpt = args.cardExcerpt ? stripHtml(args.cardExcerpt) : undefined
      for (const localeContent of Object.values(initialContent)) {
        if (seoValues) localeContent.seo = { ...seoValues }
        if (excerpt) localeContent.cardExcerpt = excerpt
        if (args.pageType === "post" && args.category)
          localeContent.category = args.category
        // The legacy shared meta text fills the language's empty meta.
        for (const key of ["metaTitle", "metaDescription"] as const) {
          const legacy = args.seo?.[key]
          if (
            legacy &&
            !localeContent[key] &&
            Object.prototype.hasOwnProperty.call(descriptor.localizedFields, key)
          )
            localeContent[key] = legacy
        }
      }
    }

    if (args.parentId) await assertNoPagePurge(ctx, args.parentId)
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
    // blockBody arms and pure-form arms); everything else stays common.
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
    // The retained Pages row keeps no language content: the draft lives in the
    // snapshot-path records that `initializeSuccessorPage` creates below.
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
      pageType: args.pageType,
    } as Parameters<typeof ctx.db.insert<"pages">>[1])
    // The guard above refuses every phase but the snapshot one.
    const created = await ctx.db.get("pages", pageId)
    if (!created) throw new ConvexError("PAGE_NOT_FOUND")
    await initializeSuccessorPage(
      ctx,
      created,
      auth,
      initialContent as Record<string, Record<string, unknown>>,
      args.expectedPresentationCatalogRevision
    )
    // An open language change must give this new Page a row (and stale a
    // ready change). With no open change this is one read.
    await recordPublicChange(ctx, { pageId, scopes: [] })
    return pageId
  },
})

/** Presence and lock identity: the user ID and the display name (never an email or username). */
async function editorIdentity(
  ctx: MutationCtx,
  auth: Pick<OwnerPrincipal, "tokenIdentifier" | "authId">
) {
  return {
    userId: auth.tokenIdentifier,
    name: await ownerDisplayName(ctx, auth.authId),
  }
}

export const touchPagePresence = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    await requireOperationAccess(ctx)
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    await touchPagePresenceRow(ctx, pageId, await editorIdentity(ctx, auth))
    return null
  },
})

export const leavePagePresence = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    // Editor teardown may arrive after sign-out. No identity means no lease
    // to release; acknowledge without reading page or presence/lock rows.
    // An authenticated non-owner still goes through the ordinary denial.
    if (!(await getOwnerIdentity(ctx))) return null
    await requireOperationAccess(ctx)
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    await leavePagePresenceRow(ctx, pageId, await editorIdentity(ctx, auth))
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
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    return await acquirePageEditorLockRow(
      ctx,
      pageId,
      await editorIdentity(ctx, auth),
      force ?? false
    )
  },
})

export const releasePageEditorLock = mutation({
  args: { pageId: v.id("pages") },
  returns: v.null(),
  handler: async (ctx, { pageId }) => {
    // Editor teardown may arrive after sign-out. No identity means no lease
    // to release; acknowledge without reading page or presence/lock rows.
    // An authenticated non-owner still goes through the ordinary denial.
    if (!(await getOwnerIdentity(ctx))) return null
    await requireOperationAccess(ctx)
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    await releasePageEditorLockRow(ctx, pageId, await editorIdentity(ctx, auth))
    return null
  },
})

/**
 * One editor heartbeat = one page read.
 *
 * The editor previously beat `touchPagePresence` AND `acquirePageEditorLock`
 * on every tick. Each did its own `ctx.db.get(pageId)`, and a `pages` document
 * carries every block body for every locale — so a beat read the full page
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
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("Page not found")
    assertPageIsActiveForOrdinaryOperation(page, "edit")
    assertActivePageType(page.pageType)
    const auth = await requireOperationAccess(ctx)
    const identity = await editorIdentity(ctx, auth)

    await touchPagePresenceRow(ctx, pageId, identity)
    // `force: false` — a heartbeat must never displace another editor's lock.
    // Taking over is an explicit user action routed through
    // `acquirePageEditorLock`.
    return await acquirePageEditorLockRow(ctx, pageId, identity, false)
  },
})
