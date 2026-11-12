import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { isActiveContentType } from "../contentTypes"
import {
  projectPublicPage,
  projectPublicReferenceCard,
  type PublicPage,
} from "../contentTypes/publicProjection"
import {
  isRoutableContentType,
  futurePageAddress,
  pathPrefixForContentType,
  type FuturePageAddressInput,
} from "../contentTypes/routing"
import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"
import { v } from "convex/values"
import {
  reconstructLocalePublicationCandidate,
  type LocalePublicationCandidatePayload,
} from "./localeCandidate"
import {
  PREPARABLE_TRANSITION_PHASES,
  readOpenTransition,
  readSiteLanguageState,
} from "../language/state"

/**
 * Public readers gate on the enabled set. Only F09 preparation and validation
 * use the hidden gate, which accepts exactly the open transition's target.
 */
type ProjectionLocaleGate =
  { kind: "public" } | { kind: "hidden_target"; locale: string }

type PublicationReadCtx = QueryCtx | MutationCtx

const addressHolderValidator = v.object({
  pageId: v.id("pages"),
  pageType: v.string(),
  title: v.string(),
})
export const pageAddressCheckValidator = v.object({
  kind: v.union(
    v.literal("free"),
    v.literal("taken"),
    v.literal("archived"),
    v.literal("historical"),
    v.literal("system"),
    v.literal("language")
  ),
  locale: v.string(),
  path: v.union(v.string(), v.null()),
  holder: v.optional(addressHolderValidator),
  canRedirect: v.optional(v.boolean()),
  reservedLocale: v.optional(v.string()),
  segment: v.optional(v.string()),
})
export type PageAddressCheck = {
  kind: "free" | "taken" | "archived" | "historical" | "system" | "language"
  locale: string
  path: string | null
  holder?: { pageId: Id<"pages">; pageType: string; title: string }
  canRedirect?: boolean
  reservedLocale?: string
  segment?: string
}
export const pageAddressNoticeValidator = v.object({
  locale: v.string(),
  oldPath: v.string(),
  newPath: v.string(),
  check: pageAddressCheckValidator,
})
export type PageAddressNotice = {
  locale: string
  oldPath: string
  newPath: string
  check: PageAddressCheck
}
export type AddressReadCache = Map<string, Promise<unknown>>
async function addressRead<T>(
  cache: AddressReadCache,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  if (!cache.has(key)) cache.set(key, read())
  return (await cache.get(key)) as T
}
export async function addressPageLifecycle(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  cache: AddressReadCache = new Map()
) {
  return addressRead(cache, `lifecycle:${pageId}`, async () => {
    const rows = await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .take(2)
    if (rows.length !== 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    return rows[0]!
  })
}
export async function addressSharedParent(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  cache: AddressReadCache = new Map()
) {
  return addressRead(cache, `parent:${pageId}`, async () => {
    const rows = await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .take(2)
    if (rows.length !== 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    return rows[0]!.system.parentId
  })
}
export async function addressHomePage(
  ctx: PublicationReadCtx,
  cache: AddressReadCache = new Map()
) {
  return addressRead(cache, "home", async () => {
    const rows = await ctx.db.query("siteSettings").take(2)
    if (rows.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    return rows[0]?.homePageId
  })
}
export async function addressDraftRows(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">
) {
  const rows = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_updatedAt", (q) => q.eq("pageId", pageId))
    .take(101)
  if (
    rows.length > 100 ||
    new Set(rows.map((row) => row.locale)).size !== rows.length
  )
    throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
  return rows
}
async function addressHolder(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  locale: string,
  cache: AddressReadCache
) {
  return addressRead(cache, `holder:${pageId}:${locale}`, async () => {
    const page = await ctx.db.get("pages", pageId)
    if (!page) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    const drafts = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .take(2)
    if (drafts.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    let title = drafts[0]?.content.title
    if (!title) {
      const states = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", locale)
        )
        .take(2)
      if (states.length > 1) throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
      // Archives hold their selected address but are deliberately not public.
      // Read the exact frozen aggregate, including its ownership verification.
      const selected = states[0]?.currentSnapshotId
      const projection = selected
        ? await readFrozenSnapshotProjection(ctx, selected, pageId, locale)
        : null
      const content = projection?.payload.localized.content
      if (content && typeof content.title === "string") title = content.title
    }
    return {
      pageId,
      pageType: page.pageType,
      title:
        title ||
        ("name" in page && typeof page.name === "string"
          ? page.name
          : page.slug),
    }
  })
}

/** Complete physical range first; filtering trash must never hide later holders. */
export async function readLiveAddressRows(
  ctx: PublicationReadCtx,
  locale: string,
  path: string,
  cache: AddressReadCache = new Map()
): Promise<Doc<"pageLocalePublicationStates">[] | null> {
  const rows = await addressRead(cache, `live:${locale}:${path}`, () =>
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) =>
        q.eq("locale", locale).eq("currentPath", path)
      )
      .take(101)
  )
  if (rows.length > 100) return null
  const live: Doc<"pageLocalePublicationStates">[] = []
  for (const row of rows) {
    let lifecycle: Doc<"pagePublicationPageStates">
    try {
      lifecycle = await addressPageLifecycle(ctx, row.pageId, cache)
    } catch {
      return null
    }
    if (row.hasCurrentSnapshot !== Boolean(row.currentSnapshotId)) return null
    if (lifecycle.lifecycleState === "active" && row.hasCurrentSnapshot)
      live.push(row)
  }
  return live
}
export async function readHeldHistoricalRows(
  ctx: PublicationReadCtx,
  locale: string,
  path: string,
  cache: AddressReadCache = new Map()
): Promise<Doc<"pageHistoricalLocaleRoutes">[] | null> {
  const rows = await addressRead(cache, `history:${locale}:${path}`, () =>
    ctx.db
      .query("pageHistoricalLocaleRoutes")
      .withIndex("by_locale_and_fromPath", (q) =>
        q.eq("locale", locale).eq("fromPath", path)
      )
      .take(101)
  )
  if (rows.length > 100) return null
  const held: Doc<"pageHistoricalLocaleRoutes">[] = []
  for (const row of rows) {
    if (row.releasedAt !== undefined) continue
    let lifecycle: Doc<"pagePublicationPageStates">
    try {
      lifecycle = await addressPageLifecycle(ctx, row.pageId, cache)
    } catch {
      return null
    }
    if (lifecycle.lifecycleState !== "trashed") held.push(row)
  }
  return held
}

export type PageAddressInput = FuturePageAddressInput & {
  path?: string
  cache?: AddressReadCache
  proposed?: Map<string, NonNullable<PageAddressCheck["holder"]>>
}
/** The sole comparison owner for live, historical and saved-draft claims. */
export async function checkPageAddress(
  ctx: PublicationReadCtx,
  input: PageAddressInput
): Promise<PageAddressCheck> {
  const cache = input.cache ?? new Map()
  const homePageId = input.homePageId ?? (await addressHomePage(ctx, cache))
  const futurePath = (address: FuturePageAddressInput) =>
    addressRead(
      cache,
      `future:${JSON.stringify([
        address.pageId ?? null,
        address.pageType,
        address.locale,
        address.slug,
        address.parentId ?? null,
        address.homePageId ?? null,
        address.parentPathOverride?.pageId ?? null,
        address.parentPathOverride?.path ?? null,
      ])}`,
      () => futurePageAddress(ctx, address)
    )
  const path = input.path ?? (await futurePath({ ...input, homePageId }))
  const free: PageAddressCheck = { kind: "free", locale: input.locale, path }
  if (path === null) return free
  const current = await addressRead(cache, `live:${input.locale}:${path}`, () =>
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) =>
        q.eq("locale", input.locale).eq("currentPath", path)
      )
      .take(101)
  )
  if (current.length > 100) throw new ConvexError("PAGE_ADDRESS_LOOKUP_LIMIT")
  if (new Set(current.map((row) => row.pageId)).size !== current.length)
    throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
  const ownsCurrentPath = current.some(
    (row) =>
      row.pageId === input.pageId &&
      row.hasCurrentSnapshot &&
      Boolean(row.currentSnapshotId)
  )
  const first = path.split("/")[1] ?? ""
  const reservedLocale = (SUPPORTED_LOCALES as readonly string[]).find(
    (locale) => locale === first
  )
  // Existing selected locale-prefix claims may be republished in place (M05 D1).
  if (reservedLocale && !ownsCurrentPath)
    return { ...free, kind: "language", reservedLocale }
  const prefix = pathPrefixForContentType(input.pageType)
  if (
    ["admin", "setup", "sign-in", "api", "authors", "jobs"].includes(first) &&
    !(prefix && prefix === first)
  )
    return { ...free, kind: "system", segment: first }
  const proposed = input.proposed?.get(`${input.locale}:${path}`)
  if (proposed && proposed.pageId !== input.pageId)
    return { ...free, kind: "taken", holder: proposed }
  for (const row of current) {
    if (row.pageId === input.pageId) continue
    const state = await addressPageLifecycle(ctx, row.pageId, cache)
    if (state.lifecycleState === "trashed" || row.pageId === input.pageId)
      continue
    if (!row.hasCurrentSnapshot || !row.currentSnapshotId)
      throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    return {
      ...free,
      kind: state.lifecycleState === "archived" ? "archived" : "taken",
      holder: await addressHolder(ctx, row.pageId, input.locale, cache),
    }
  }
  const historical = await readHeldHistoricalRows(
    ctx,
    input.locale,
    path,
    cache
  )
  if (!historical) throw new ConvexError("PAGE_ADDRESS_LOOKUP_LIMIT")
  for (const row of historical) {
    if (row.pageId === input.pageId) continue
    const state = await addressPageLifecycle(ctx, row.pageId, cache)
    const projection =
      state.lifecycleState === "active"
        ? await readCurrentSnapshotProjection(ctx, row.pageId, input.locale)
        : null
    return {
      ...free,
      kind: "historical",
      holder: await addressHolder(ctx, row.pageId, input.locale, cache),
      canRedirect: Boolean(projection),
    }
  }
  // Identifiers retain slashes: each literal split can produce the same path.
  const draftSlugs = new Set<string>()
  if (path === "/") draftSlugs.add(input.slug)
  else
    for (let i = path.length - 1; i >= 0; i--)
      if (path[i] === "/") draftSlugs.add(path.slice(i + 1))
  for (const draftSlug of draftSlugs) {
    const drafts = await addressRead(
      cache,
      `drafts:${input.locale}:${draftSlug}`,
      () =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_locale_and_slug", (q) =>
            q.eq("locale", input.locale).eq("slug", draftSlug)
          )
          .take(101)
    )
    if (drafts.length > 100) throw new ConvexError("PAGE_ADDRESS_LOOKUP_LIMIT")
    if (new Set(drafts.map((row) => row.pageId)).size !== drafts.length)
      throw new ConvexError("PAGE_ADDRESS_STATE_INVALID")
    for (const draft of drafts) {
      const state = await addressPageLifecycle(ctx, draft.pageId, cache)
      if (state.lifecycleState === "trashed" || draft.pageId === input.pageId)
        continue
      const parentId = await addressSharedParent(ctx, draft.pageId, cache)
      const holderPath = await futurePath({
        ...input,
        pageId: draft.pageId,
        pageType: draft.pageType,
        slug: draft.slug,
        parentId,
        homePageId,
      })
      if (holderPath === path)
        return {
          ...free,
          kind: state.lifecycleState === "archived" ? "archived" : "taken",
          holder: await addressHolder(ctx, draft.pageId, input.locale, cache),
        }
    }
  }
  return free
}
export function refusePageAddress(
  check: PageAddressCheck,
  source:
    | "identifier"
    | "parent"
    | "publish"
    | "transition"
    | "migration" = "identifier"
): void {
  if (check.kind === "free") return
  const code =
    source === "parent"
      ? "PAGE_PARENT_ADDRESS_TAKEN"
      : source === "publish" ||
          source === "transition" ||
          source === "migration"
        ? (
            {
              taken: "PUBLISHED_LOCALE_ROUTE_TAKEN",
              archived: "PUBLISHED_LOCALE_ROUTE_TAKEN",
              historical: "PUBLISHED_LOCALE_ROUTE_RESERVED",
              system: "PUBLISHED_SYSTEM_ROUTE_RESERVED",
              language: "LANGUAGE_LOCALE_PREFIX_RESERVED",
            } as const
          )[check.kind]
        : (
            {
              taken: "PAGE_ADDRESS_TAKEN",
              archived: "PAGE_ADDRESS_ARCHIVED",
              historical: "PAGE_ADDRESS_HISTORICAL",
              system: "PAGE_ADDRESS_SYSTEM_RESERVED",
              language: "LANGUAGE_LOCALE_PREFIX_RESERVED",
            } as const
          )[check.kind]
  throw new ConvexError({ code, source, ...check })
}
export async function allocatePageAddress(
  ctx: PublicationReadCtx,
  input: PageAddressInput
) {
  const cache = input.cache ?? new Map()
  const wantedSlug = input.slug.trim()
  if (!wantedSlug) throw new ConvexError("SLUG_REQUIRED")
  const wanted = await checkPageAddress(ctx, {
    ...input,
    slug: wantedSlug,
    cache,
  })
  if (wanted.kind === "free") return { slug: wantedSlug, check: wanted }
  for (let n = 2; n <= 50; n++) {
    const suffix = `-${n}`
    const slug = wantedSlug.slice(0, 80 - suffix.length) + suffix
    const check = await checkPageAddress(ctx, { ...input, slug, cache })
    if (check.kind === "free")
      return {
        slug,
        check,
        addressAllocation: { wantedSlug, allocatedSlug: slug },
      }
  }
  throw new ConvexError("PAGE_ADDRESS_LOOKUP_LIMIT")
}
export type PublicationAuthority = "legacy" | "snapshot_active" | "invalid"
export type SnapshotPayload = Readonly<{
  snapshotId: Id<"pagePublishedSnapshots">
  publicPage: PublicPage
  path: string | null
  payload: LocalePublicationCandidatePayload
}>

type CutoverPhase =
  "missing" | "duplicate" | Doc<"pagePublicationCutover">["phase"]

async function readCutoverPhase(
  ctx: PublicationReadCtx
): Promise<CutoverPhase> {
  const rows = await ctx.db
    .query("pagePublicationCutover")
    .withIndex("by_key", (q) => q.eq("key", "published-snapshot-v1"))
    .take(2)
  if (rows.length === 0) return "missing"
  if (rows.length !== 1) return "duplicate"
  return rows[0]!.phase
}

/** Migration preparation is legacy-readable; missing/duplicate authority is closed. */
export async function readPublicationAuthority(
  ctx: PublicationReadCtx
): Promise<PublicationAuthority> {
  const phase = await readCutoverPhase(ctx)
  if (phase === "snapshot_active") return "snapshot_active"
  if (phase === "legacy" || phase === "preparing" || phase === "ready")
    return "legacy"
  return "invalid"
}

/** Legacy Page writers are legal only in the explicit legacy phase. */
export async function assertLegacyPublicationWriterBlocked(
  ctx: PublicationReadCtx,
  operation: string
): Promise<void> {
  const phase = await readCutoverPhase(ctx)
  if (phase === "legacy") return
  if (phase === "missing" || phase === "duplicate") {
    throw new ConvexError("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
  }
  throw new ConvexError(
    `LEGACY_PUBLICATION_WRITER_DISABLED:${operation}:use successor publication commands`
  )
}

function one<T>(rows: readonly T[]): T | null {
  return rows.length === 1 ? rows[0]! : null
}

function attributionMatches(
  left: Doc<"pageLocalePublicationCandidates">["attribution"],
  right: Doc<"pageLocalePublicationCandidates">["attribution"]
): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === "owner" && right.kind === "owner"
    ? left.ownerId === right.ownerId &&
        left.authId === right.authId &&
        left.tokenIdentifier === right.tokenIdentifier
    : left.kind === "migration" &&
        right.kind === "migration" &&
        left.migrationRunId === right.migrationRunId
}

function payloadPath(
  payload: LocalePublicationCandidatePayload
): string | null {
  return payload.route.kind === "routable" ? payload.route.canonicalPath : null
}

/** One owner for the listing keys on selection, republish and withdrawal.
 * The caller supplies the first-public source time: command time for a new
 * publication, legacy publishedAt (then currentPublishedAt) for migration.
 */
export function currentSnapshotIndexFields(
  state: Pick<
    Doc<"pageLocalePublicationStates">,
    "hasCurrentSnapshot" | "publicSince"
  >,
  selection: {
    pageType: Doc<"pages">["pageType"]
    firstPublicAt: number | undefined
  } | null
): Pick<Doc<"pageLocalePublicationStates">, "pageType" | "publicSince"> {
  if (!selection) return { pageType: undefined, publicSince: undefined }
  return {
    pageType: selection.pageType,
    publicSince: state.hasCurrentSnapshot
      ? (state.publicSince ?? selection.firstPublicAt)
      : selection.firstPublicAt,
  }
}

/** Both page and card projectors receive this immutable snapshot adapter. */
function snapshotPageSource(
  pageId: Id<"pages">,
  payload: LocalePublicationCandidatePayload,
  publishedAt: number
): Doc<"pages"> {
  return {
    _id: pageId,
    _creationTime: publishedAt,
    pageType: payload.page.pageType,
    slug: payload.localized.slug,
    status: "published",
    ...payload.shared.system,
    ...payload.shared.descriptor,
    content: { [payload.locale]: payload.localized.content },
    updatedAt: publishedAt,
    publishedAt,
  } as unknown as Doc<"pages">
}

function projectPayload(
  pageId: Id<"pages">,
  payload: LocalePublicationCandidatePayload,
  publishedAt: number
): PublicPage | null {
  return projectPublicPage(
    snapshotPageSource(pageId, payload, publishedAt),
    payload.locale
  )
}

/** Descriptor card fields, never a mutable Page or a second title algorithm. */
export function projectSnapshotReferenceCard(projection: SnapshotPayload) {
  const source = snapshotPageSource(
    projection.publicPage._id,
    projection.payload,
    projection.publicPage.publishedAt!
  )
  const card = projectPublicReferenceCard(source, projection.payload.locale)
  if (!card) return null
  // The system card image applies to every Type, including descriptors that
  // only supply title/excerpt. Retain the existing snapshot media behavior.
  const imageMediaId = card.imageMediaId ?? source.cardImageMediaId
  return { ...card, ...(imageMediaId ? { imageMediaId } : {}) }
}

async function verifyFrozenSnapshotUncached(
  ctx: PublicationReadCtx,
  snapshotId: Id<"pagePublishedSnapshots">,
  expected: { pageId: Id<"pages">; locale: string; generation?: number }
): Promise<{
  payload: LocalePublicationCandidatePayload
  publicPage: PublicPage
  snapshot: Doc<"pagePublishedSnapshots">
} | null> {
  const snapshot = await ctx.db.get(snapshotId)
  if (
    !snapshot ||
    snapshot.pageId !== expected.pageId ||
    snapshot.locale !== expected.locale ||
    (expected.generation !== undefined &&
      snapshot.generation !== expected.generation)
  ) {
    return null
  }
  if (snapshot.generation !== snapshot.sourcePublicGeneration + 1) return null
  const [candidate, release, byCandidate, byRelease, byGeneration] =
    await Promise.all([
      ctx.db.get(snapshot.candidateId),
      ctx.db.get(snapshot.releaseId),
      ctx.db
        .query("pagePublishedSnapshots")
        .withIndex("by_candidateId", (q) =>
          q.eq("candidateId", snapshot.candidateId)
        )
        .take(2),
      ctx.db
        .query("pagePublishedSnapshots")
        .withIndex("by_releaseId", (q) => q.eq("releaseId", snapshot.releaseId))
        .take(2),
      ctx.db
        .query("pagePublishedSnapshots")
        .withIndex("by_pageId_and_locale_and_generation", (q) =>
          q
            .eq("pageId", snapshot.pageId)
            .eq("locale", snapshot.locale)
            .eq("generation", snapshot.generation)
        )
        .take(2),
    ])
  if (
    !candidate ||
    !release ||
    byCandidate.length !== 1 ||
    byRelease.length !== 1 ||
    byGeneration.length !== 1 ||
    candidate.pageId !== snapshot.pageId ||
    candidate.locale !== snapshot.locale ||
    candidate.digest !== snapshot.candidateDigest ||
    candidate.sourceDraftGeneration !== snapshot.sourceDraftGeneration ||
    candidate.sourceSharedDraftGeneration !==
      snapshot.sourceSharedDraftGeneration ||
    candidate.sourcePublicGeneration !== snapshot.sourcePublicGeneration ||
    candidate.sourceLifecycleGeneration !==
      snapshot.sourceLifecycleGeneration ||
    release.pageId !== snapshot.pageId ||
    release.locale !== snapshot.locale ||
    release.candidateId !== candidate._id ||
    release.publishedSnapshotId !== snapshot._id ||
    release.expectedPublicGeneration !== snapshot.sourcePublicGeneration ||
    release.expectedLifecycleGeneration !==
      snapshot.sourceLifecycleGeneration ||
    release.status !== "published" ||
    release.publishedAt !== snapshot.publishedAt ||
    release.holdReason !== undefined ||
    release.heldAt !== undefined ||
    release.cancelledAt !== undefined ||
    release.cancelReason !== undefined ||
    release.replacedAt !== undefined ||
    release.replacedByReleaseId !== undefined ||
    !attributionMatches(candidate.attribution, snapshot.attribution) ||
    !attributionMatches(candidate.attribution, release.attribution)
  )
    return null

  const payload = await reconstructLocalePublicationCandidate(candidate)
  if (
    !payload ||
    payload.page.id !== String(snapshot.pageId) ||
    payload.page.pageType !== candidate.pageType ||
    payload.locale !== snapshot.locale
  )
    return null
  const publicPage = projectPayload(
    snapshot.pageId,
    payload,
    snapshot.publishedAt
  )
  return publicPage ? { payload, publicPage, snapshot } : null
}

type FrozenSnapshotCache = Map<
  string,
  ReturnType<typeof verifyFrozenSnapshotUncached>
>

function verifyFrozenSnapshot(
  ctx: PublicationReadCtx,
  snapshotId: Id<"pagePublishedSnapshots">,
  expected: { pageId: Id<"pages">; locale: string; generation?: number },
  cache?: FrozenSnapshotCache
): ReturnType<typeof verifyFrozenSnapshotUncached> {
  if (!cache) return verifyFrozenSnapshotUncached(ctx, snapshotId, expected)
  const key = `${snapshotId}\0${expected.pageId}\0${expected.locale}\0${expected.generation ?? ""}`
  const cached = cache.get(key)
  if (cached) return cached
  const verified = verifyFrozenSnapshotUncached(ctx, snapshotId, expected)
  cache.set(key, verified)
  return verified
}

/**
 * Verify one immutable snapshot aggregate without requiring it to be the
 * current public selection. Private draft reconstruction uses this for the
 * locale state's exact draft-base snapshot after publish or withdrawal.
 */
export async function readFrozenSnapshotProjection(
  ctx: PublicationReadCtx,
  snapshotId: Id<"pagePublishedSnapshots">,
  pageId: Id<"pages">,
  locale: string
): Promise<SnapshotPayload | null> {
  const frozen = await verifyFrozenSnapshot(ctx, snapshotId, { pageId, locale })
  if (!frozen || !isActiveContentType(frozen.payload.page.pageType)) return null
  return {
    snapshotId,
    payload: frozen.payload,
    publicPage: frozen.publicPage,
    path: payloadPath(frozen.payload),
  }
}

function titleFromPublicPage(value: PublicPage, locale: string): string {
  const record = value as unknown as Record<string, unknown>
  if (typeof record.name === "string" && record.name.length > 0)
    return record.name
  const localized = value.content[locale] as Record<string, unknown> | undefined
  return typeof localized?.title === "string" ? localized.title : ""
}

/**
 * M05 disclosure display title (ledger C2b.1 residual 2.1): the snapshot and
 * its candidate, two point reads, projected like the public page. It is not a
 * current-selection check, so a hidden locale's title is readable; a snapshot
 * or candidate that is missing or fails to parse yields an empty title.
 */
export async function readSnapshotDisplayTitle(
  ctx: PublicationReadCtx,
  snapshotId: Id<"pagePublishedSnapshots">
): Promise<string> {
  const snapshot = await ctx.db.get(snapshotId)
  if (!snapshot) return ""
  const candidate = await ctx.db.get(snapshot.candidateId)
  if (!candidate) return ""
  const payload = await reconstructLocalePublicationCandidate(candidate)
  if (!payload) return ""
  const publicPage = projectPayload(
    snapshot.pageId,
    payload,
    snapshot.publishedAt
  )
  return publicPage ? titleFromPublicPage(publicPage, snapshot.locale) : ""
}

type ProjectionCache = {
  current: Map<string, Promise<SnapshotPayload | null>>
  frozen: FrozenSnapshotCache
  pages: Map<
    string,
    Promise<
      readonly [Doc<"pages"> | null, Doc<"pagePublicationPageStates"> | null]
    >
  >
  settings?: Promise<Doc<"siteSettings"> | null>
  address?: AddressReadCache
}

function readCachedSnapshotProjection(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  locale: string,
  visiting: Set<string>,
  gate: ProjectionLocaleGate,
  cache: ProjectionCache
): Promise<SnapshotPayload | null> {
  const key = `${pageId}\0${locale}`
  if (visiting.has(key)) return Promise.resolve(null)
  const cached = cache.current.get(key)
  if (cached) return cached
  const projection = readCurrentSnapshotProjectionInner(
    ctx,
    pageId,
    locale,
    visiting,
    gate,
    cache
  )
  cache.current.set(key, projection)
  return projection
}

async function readCurrentSnapshotProjectionInner(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  locale: string,
  visiting: Set<string>,
  gate: ProjectionLocaleGate,
  cache?: ProjectionCache
): Promise<SnapshotPayload | null> {
  const visitKey = `${pageId}\0${locale}`
  if (visiting.has(visitKey)) return null
  visiting.add(visitKey)
  try {
    const pageAndState =
      cache?.pages.get(pageId) ??
      Promise.all([
        ctx.db.get(pageId),
        cache?.address
          ? addressPageLifecycle(ctx, pageId, cache.address).then((row) => [
              row,
            ])
          : ctx.db
              .query("pagePublicationPageStates")
              .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
              .take(2),
      ]).then(([page, states]) => [page, one(states)] as const)
    cache?.pages.set(pageId, pageAndState)
    const settingsRead =
      cache?.settings ??
      ctx.db
        .query("siteSettings")
        .take(2)
        .then((rows) => one(rows))
    if (cache) cache.settings = settingsRead
    const [[page, pageState], localeStates, settings] = await Promise.all([
      pageAndState,
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", locale)
        )
        .take(2),
      settingsRead,
    ])
    const localeState = one(localeStates)
    if (
      !page ||
      !isActiveContentType(page.pageType) ||
      !pageState ||
      pageState.lifecycleState !== "active" ||
      !settings?.homePageId ||
      (gate.kind === "public"
        ? !settings.enabledLocales?.includes(locale)
        : gate.locale !== locale) ||
      !localeState ||
      !localeState.hasCurrentSnapshot ||
      !localeState.currentSnapshotId ||
      localeState.currentPublishedAt === undefined ||
      localeState.currentReleaseId !== undefined
    ) {
      return null
    }
    const frozen = await verifyFrozenSnapshot(
      ctx,
      localeState.currentSnapshotId,
      {
        pageId,
        locale,
        generation: localeState.publicGeneration,
      },
      cache?.frozen
    )
    if (
      !frozen ||
      frozen.snapshot.publishedAt !== localeState.currentPublishedAt ||
      frozen.payload.page.pageType !== page.pageType ||
      !isActiveContentType(frozen.payload.page.pageType)
    )
      return null
    const path = payloadPath(frozen.payload)
    if (path !== (localeState.currentPath ?? null)) return null
    const isHome = settings.homePageId === pageId
    if (
      (isHome &&
        (frozen.payload.route.kind !== "routable" ||
          frozen.payload.route.canonicalPath !== "/" ||
          frozen.payload.route.ancestry.length !== 0 ||
          frozen.payload.shared.system.parentId !== undefined)) ||
      (!isHome && path === "/") ||
      isRoutableContentType(frozen.payload.page.pageType) !==
        (frozen.payload.route.kind === "routable")
    ) {
      return null
    }
    if (frozen.payload.route.kind === "routable") {
      let expectedParentId = frozen.payload.shared.system.parentId
      const ancestry = frozen.payload.route.ancestry
      for (let index = ancestry.length - 1; index >= 0; index -= 1) {
        const item = ancestry[index]!
        if (
          typeof expectedParentId !== "string" ||
          item.pageId !== expectedParentId
        )
          return null
        const ancestorId = item.pageId as Id<"pages">
        const [ancestorFrozen, ancestorCurrent] = await Promise.all([
          verifyFrozenSnapshot(
            ctx,
            item.snapshotId as Id<"pagePublishedSnapshots">,
            {
              pageId: ancestorId,
              locale,
              generation: item.publicGeneration,
            },
            cache?.frozen
          ),
          cache
            ? readCachedSnapshotProjection(
                ctx,
                ancestorId,
                locale,
                visiting,
                gate,
                cache
              )
            : readCurrentSnapshotProjectionInner(
                ctx,
                ancestorId,
                locale,
                visiting,
                gate
              ),
        ])
        if (
          !ancestorFrozen ||
          !ancestorCurrent ||
          payloadPath(ancestorFrozen.payload) !== item.canonicalPath ||
          titleFromPublicPage(ancestorFrozen.publicPage, locale) !== item.title
        )
          return null
        expectedParentId = ancestorFrozen.payload.shared.system.parentId
      }
      if (expectedParentId !== undefined) return null
    }
    return {
      snapshotId: frozen.snapshot._id,
      payload: frozen.payload,
      publicPage: frozen.publicPage,
      path,
    }
  } finally {
    visiting.delete(visitKey)
  }
}

/** Read and verify the complete selected immutable aggregate for Page+locale. */
export async function readCurrentSnapshotProjection(
  ctx: PublicationReadCtx,
  pageId: Doc<"pages">["_id"],
  locale: string,
  address?: AddressReadCache
): Promise<SnapshotPayload | null> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return null
  // F09 invariant: invalid language authority fails every public read closed.
  // An absent authority row is version 0 compatibility and reads as today.
  if ((await readSiteLanguageState(ctx)).kind === "invalid") return null
  return readCurrentSnapshotProjectionInner(
    ctx,
    pageId,
    locale,
    new Set(),
    {
      kind: "public",
    },
    address
      ? { current: new Map(), frozen: new Map(), pages: new Map(), address }
      : undefined
  )
}

export type PublicSnapshotProjectionReader = (
  pageId: Doc<"pages">["_id"],
  locale: string
) => Promise<SnapshotPayload | null>

/**
 * `readCurrentSnapshotProjection` for a reader that verifies many Page+locale
 * aggregates in one query (sitemap children, C5a). Both authority gates are
 * read once: a Convex query reads one snapshot, so re-reading them per
 * projection returns the same answer. Null when either gate is closed, in
 * which case every projection would be null.
 */
export async function createPublicSnapshotProjectionReader(
  ctx: PublicationReadCtx
): Promise<PublicSnapshotProjectionReader | null> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return null
  if ((await readSiteLanguageState(ctx)).kind === "invalid") return null
  const cache: ProjectionCache = {
    current: new Map(),
    frozen: new Map(),
    pages: new Map(),
  }
  return (pageId, locale) =>
    readCachedSnapshotProjection(
      ctx,
      pageId,
      locale,
      new Set(),
      { kind: "public" },
      cache
    )
}

/**
 * The per-locale snapshot alternates of one Page (M05 C5, N11). Each entry
 * must pass the same current-snapshot and same-locale ancestry checks as the
 * public page reader. `noIndex` separates navigation from SEO alternates.
 */
export async function readPublicSnapshotLocaleAlternates(
  ctx: PublicationReadCtx,
  pageId: Id<"pages">,
  enabledLocales: readonly string[]
): Promise<Array<{ locale: string; path: string; noIndex: boolean }>> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return []
  if ((await readSiteLanguageState(ctx)).kind === "invalid") return []
  const alternates: Array<{ locale: string; path: string; noIndex: boolean }> =
    []
  for (const locale of enabledLocales) {
    const projection = await readCurrentSnapshotProjectionInner(
      ctx,
      pageId,
      locale,
      new Set(),
      { kind: "public" }
    )
    const page = projection?.publicPage
    if (
      !projection ||
      projection.path === null ||
      !page ||
      !isRoutableContentType(projection.payload.page.pageType)
    )
      continue
    alternates.push({
      locale,
      path: projection.path,
      noIndex: page.seo?.noIndex === true,
    })
  }
  return alternates
}

/**
 * Hidden-target projection (F09 invariant 17). Same verification as
 * `readCurrentSnapshotProjection`, with the enabled-locale check replaced by
 * "locale is the open transition's target". Public readers never call it.
 */
export async function readHiddenTargetSnapshotProjection(
  ctx: PublicationReadCtx,
  pageId: Doc<"pages">["_id"],
  locale: string
): Promise<SnapshotPayload | null> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") return null
  const state = await readSiteLanguageState(ctx)
  if (state.kind !== "current") return null
  const transition = await readOpenTransition(ctx, state)
  if (
    !transition ||
    transition.targetLocale !== locale ||
    !PREPARABLE_TRANSITION_PHASES.has(transition.phase)
  ) {
    return null
  }
  return readCurrentSnapshotProjectionInner(ctx, pageId, locale, new Set(), {
    kind: "hidden_target",
    locale,
  })
}

export async function requireSnapshotAuthority(
  ctx: PublicationReadCtx
): Promise<void> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    throw new ConvexError("PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED")
  }
}
