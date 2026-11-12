import { isColumnPanel, panelBlocks } from "../menu"
import { ConvexError } from "convex/values"
import type {
  PaginationOptions,
  PaginationResult,
  TransactionMetrics,
} from "convex/server"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"
import type { L10n, NavItem } from "../menu"
import type { OwnerPrincipal } from "../access/owner"
import {
  readModuleState,
  resolveEffectiveModuleStateFromEnabled,
} from "../modules/state"
import {
  readPublicationAuthority,
  readSnapshotDisplayTitle,
} from "../publishing/snapshots"
import {
  DISCLOSURE_CHAIN_EMPTY_DIGEST,
  DISCLOSURE_PAGE_ITEMS_MAX_BYTES,
  DISCLOSURE_PAGE_MAX_ITEMS,
  DISCLOSURE_SECTION_BATCH,
  digestDisclosurePage,
  disclosureItemsBytes,
  truncateDisclosureItem,
  type DisclosureItem,
} from "./disclosure"
import { readFreshnessTokens, readLocaleFreshnessCounters } from "./freshness"
import {
  readOpenDefaultMigration,
  readSiteLanguageState,
  type SiteLanguageState,
} from "./state"
import { isLocalePrefixPath, localePrefixRange } from "./localePrefix"

/**
 * M05 sealed impact previews (contract `siteLanguageImpactPreviews`,
 * `siteLanguageDisclosurePages`, M16, M23, R8-H1). A preview walks one
 * section per step with exactly one `.paginate()`, writes at most one
 * disclosure page per step and extends the digest chain. Every step compares
 * all four captured token groups first; any move ends the preview `stale`.
 */

type Ctx = QueryCtx | MutationCtx

export type ImpactPreview = Doc<"siteLanguageImpactPreviews">
export type ImpactPreviewKind = ImpactPreview["kind"]
export type ImpactPreviewSection = ImpactPreview["cursorPhase"]
export type ImpactPreviewTokens = ImpactPreview["captured"]

export const IMPACT_PREVIEW_TTL_MS = 15 * 60 * 1000
export const IMPACT_PREVIEW_GENERATION = 1
/** Residual 2.1: a hard `bytesRead` maximum for one preview step. */
export const IMPACT_PREVIEW_BYTES_READ_MAX = 4 * 1024 * 1024

const RESERVE_METRICS = [
  "documentsRead",
  "bytesRead",
  "databaseQueries",
  "documentsWritten",
  "bytesWritten",
  "functionsScheduled",
] as const

/**
 * The pagination and metrics seam. Production passes only `numItems` and
 * `cursor`, so a `SplitRequired` page or a reserve crossing can only be
 * injected here (ledger C2b.1d). Callers must go through this object.
 */
export const impactPreviewSeam = {
  paginate<T>(
    query: {
      paginate(options: PaginationOptions): Promise<PaginationResult<T>>
    },
    options: PaginationOptions
  ): Promise<PaginationResult<T>> {
    return query.paginate(options)
  },
  metrics(ctx: MutationCtx): Promise<TransactionMetrics> {
    return ctx.meta.getTransactionMetrics()
  },
}

function fail(code: string): never {
  throw new ConvexError(code)
}

// ─── Tokens ─────────────────────────────────────────────────────────────────

export type LivePreviewState = {
  state: SiteLanguageState
  /** Null unless the authority classifies multilingual (S4). */
  tokens: ImpactPreviewTokens | null
  redirectsEffective: boolean
}

/**
 * Authority, module configuration and preview freshness scopes: settings,
 * authority, module enablement, module state and up to three counter rows.
 * Reveal previews bind the default locale as D1's shadowed URL source.
 */
export async function readLivePreviewState(
  ctx: Ctx,
  locale: string,
  includeDefaultLocale = false
): Promise<LivePreviewState> {
  const [state, moduleState, freshness] = await Promise.all([
    readSiteLanguageState(ctx),
    readModuleState(ctx),
    readFreshnessTokens(ctx, locale),
  ])
  const defaultLocaleFreshness =
    includeDefaultLocale && state.kind === "multilingual"
      ? state.locale === locale
        ? freshness.locale
        : await readLocaleFreshnessCounters(ctx, state.locale)
      : null
  const redirects = resolveEffectiveModuleStateFromEnabled(
    moduleState.configurationVersion,
    moduleState.enabledModuleIds
  ).modules.find((module) => module.moduleId === "redirects")
  return {
    state,
    tokens:
      state.kind === "multilingual"
        ? {
            authorityVersion: state.version,
            moduleConfigurationVersion: moduleState.configurationVersion,
            site: freshness.site,
            locale: freshness.locale,
            ...(defaultLocaleFreshness
              ? { defaultLocale: defaultLocaleFreshness }
              : {}),
          }
        : null,
    redirectsEffective: redirects?.effective === true,
  }
}

export function previewTokensEqual(
  left: ImpactPreviewTokens,
  right: ImpactPreviewTokens
): boolean {
  return (
    left.authorityVersion === right.authorityVersion &&
    left.moduleConfigurationVersion === right.moduleConfigurationVersion &&
    left.site.routeClaimVersion === right.site.routeClaimVersion &&
    left.site.publicationSetVersion === right.site.publicationSetVersion &&
    left.locale.routeClaimVersion === right.locale.routeClaimVersion &&
    left.locale.publicationSetVersion === right.locale.publicationSetVersion &&
    left.defaultLocale?.routeClaimVersion ===
      right.defaultLocale?.routeClaimVersion &&
    left.defaultLocale?.publicationSetVersion ===
      right.defaultLocale?.publicationSetVersion
  )
}

// ─── Start ──────────────────────────────────────────────────────────────────

const LIVE_PHASES = ["scanning", "complete"] as const

/**
 * Inserts a `scanning` preview bound to the owner and marks the slot's live
 * preview `stale` (M16). The caller schedules the first step.
 */
export async function startImpactPreviewInTransaction(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  kind: ImpactPreviewKind,
  locale: string
): Promise<Id<"siteLanguageImpactPreviews">> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const live = await readLivePreviewState(ctx, locale, kind === "reveal")
  const { state } = live
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual" || !live.tokens) {
    fail("MULTILINGUAL_NOT_ADOPTED")
  }
  // The preview prepares a commit that an open migration refuses (M6).
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    fail("LOCALE_UNSUPPORTED")
  }
  const enabled = state.locales.includes(locale)
  if (kind === "remove") {
    if (!enabled) fail("LOCALE_NOT_ENABLED")
    if (locale === state.locale) fail("LOCALE_IS_DEFAULT")
  } else if (enabled) {
    fail("LOCALE_ALREADY_ENABLED")
  }

  const liveRows: ImpactPreview[] = []
  for (const phase of LIVE_PHASES) {
    liveRows.push(
      ...(await ctx.db
        .query("siteLanguageImpactPreviews")
        .withIndex("by_owner_and_locale_and_kind_and_phase", (q) =>
          q
            .eq("owner.tokenIdentifier", owner.tokenIdentifier)
            .eq("locale", locale)
            .eq("kind", kind)
            .eq("phase", phase)
        )
        .take(2))
    )
  }
  if (liveRows.length > 1) fail("LANGUAGE_PREVIEW_STATE_INVALID")
  const now = Date.now()
  for (const row of liveRows) {
    await ctx.db.patch(row._id, { phase: "stale", updatedAt: now })
  }

  return ctx.db.insert("siteLanguageImpactPreviews", {
    kind,
    locale,
    owner: { ownerId: owner.ownerId, tokenIdentifier: owner.tokenIdentifier },
    captured: live.tokens,
    phase: "scanning",
    cursorPhase: "selections",
    count: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
    digest: DISCLOSURE_CHAIN_EMPTY_DIGEST,
    pageCount: 0,
    reviewedThroughOrdinal: -1,
    generation: IMPACT_PREVIEW_GENERATION,
    createdAt: now,
    updatedAt: now,
  })
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

export type PreviewCursor = {
  /** The section's `continueCursor`; null before its first page. */
  page: string | null
  /** A halved page size (menus: node items) while one applies. */
  size?: number
  /** The section's pagination finished while a menu's nodes remain. */
  done?: true
  menu?: { menuId: Id<"menus">; next: number }
  prefixSource?: "current" | "historical" | "continuity" | "manual_rules"
}

const START_CURSOR: PreviewCursor = { page: null }

export function encodeCursor(cursor: PreviewCursor): string {
  return JSON.stringify(cursor)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

export function decodeCursor(raw: string | undefined): PreviewCursor | null {
  if (raw === undefined) return START_CURSOR
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const value = parsed as Record<string, unknown>
  if (value.page !== null && typeof value.page !== "string") return null
  if (
    value.size !== undefined &&
    !(isNonNegativeInteger(value.size) && value.size >= 1)
  )
    return null
  if (value.done !== undefined && value.done !== true) return null
  if (value.menu !== undefined) {
    const menu = value.menu as Record<string, unknown> | null
    if (
      !menu ||
      typeof menu.menuId !== "string" ||
      !isNonNegativeInteger(menu.next)
    )
      return null
  }
  if (
    value.prefixSource !== undefined &&
    value.prefixSource !== "current" &&
    value.prefixSource !== "historical" &&
    value.prefixSource !== "continuity" &&
    value.prefixSource !== "manual_rules"
  ) {
    return null
  }
  return parsed as PreviewCursor
}

// ─── Menu nodes ─────────────────────────────────────────────────────────────

function ownText(locale: string, ...bags: (L10n | undefined)[]): boolean {
  return bags.some(
    (bag) =>
      bag !== undefined && Object.prototype.hasOwnProperty.call(bag, locale)
  )
}

/**
 * Menu nodes whose own text bag has a key for the locale, in a deterministic
 * walk: item, then each panel and footer block, then that block's links
 * (ledger C2b.1d). A node path is its id chain.
 */
export function menuNodePathsWithLocaleText(
  nav: readonly NavItem[],
  locale: string
): string[] {
  const paths: string[] = []
  for (const item of nav) {
    if (
      ownText(locale, item.label) ||
      (item.panel &&
        isColumnPanel(item.panel) &&
        ownText(locale, item.panel.title, item.panel.description))
    )
      paths.push(item.id)
    const blocks = panelBlocks(item.panel).map((entry) => entry.block)
    for (const block of blocks) {
      const blockPath = `${item.id}/${block.id}`
      const text =
        block.kind === "linkGroup"
          ? ownText(locale, block.heading)
          : block.kind === "featured"
            ? ownText(
                locale,
                block.heading,
                block.description,
                block.image?.alt,
                block.link?.label
              )
            : ownText(locale, block.heading, block.seeAll?.label)
      if (text) paths.push(blockPath)
      if (block.kind !== "linkGroup") continue
      for (const link of block.links) {
        if (ownText(locale, link.label, link.description)) {
          paths.push(`${blockPath}/${link.id}`)
        }
      }
    }
  }
  return paths
}

// ─── Step ───────────────────────────────────────────────────────────────────

const SECTION_ORDER: readonly ImpactPreviewSection[] = [
  "selections",
  "historical_routes",
  "manual_rules",
  "menus",
]

function nextSection(
  section: ImpactPreviewSection,
  redirectsEffective: boolean,
  kind: ImpactPreviewKind
): ImpactPreviewSection | null {
  if (section === "locale_prefix_shadowing") return null
  let index = SECTION_ORDER.indexOf(section) + 1
  if (SECTION_ORDER[index] === "manual_rules" && !redirectsEffective) index += 1
  return (
    SECTION_ORDER[index] ??
    (kind === "reveal" ? "locale_prefix_shadowing" : null)
  )
}

/** Page size (menus: node items per page) when no halving applies. */
function sectionBatch(section: ImpactPreviewSection): number {
  return DISCLOSURE_SECTION_BATCH[section]
}

export function crossedReserve(metrics: TransactionMetrics): boolean {
  if (metrics.bytesRead.used > IMPACT_PREVIEW_BYTES_READ_MAX) return true
  return RESERVE_METRICS.some((key) => {
    const { used, remaining } = metrics[key]
    return remaining < (used + remaining) / 2
  })
}

export type ImpactPreviewStepResult =
  | { kind: "noop" }
  | { kind: "stale" }
  | { kind: "continue" }
  | { kind: "complete"; expiresAt: number }

type CountDelta = ImpactPreview["count"]

type Batch =
  | {
      kind: "items"
      items: DisclosureItem[]
      delta: CountDelta
      cursor: PreviewCursor | "section_done"
    }
  | { kind: "halve" }
  | { kind: "stale" }

const NO_DELTA: CountDelta = {
  publicPages: 0,
  routes: 0,
  manualRules: 0,
  menus: 0,
}

async function markStale(
  ctx: MutationCtx,
  preview: ImpactPreview
): Promise<ImpactPreviewStepResult> {
  await ctx.db.patch(preview._id, { phase: "stale", updatedAt: Date.now() })
  return { kind: "stale" }
}

/**
 * One bounded step (contract Delayed work, `stepLanguageImpactPreview`). The
 * caller schedules the continuation on `continue` and the expiry on
 * `complete`.
 */
export async function stepImpactPreviewInTransaction(
  ctx: MutationCtx,
  previewId: Id<"siteLanguageImpactPreviews">,
  generation: number
): Promise<ImpactPreviewStepResult> {
  const preview = await ctx.db.get(previewId)
  if (
    !preview ||
    preview.phase !== "scanning" ||
    preview.generation !== generation
  ) {
    return { kind: "noop" }
  }

  let live: LivePreviewState
  try {
    live = await readLivePreviewState(
      ctx,
      preview.locale,
      preview.kind === "reveal"
    )
  } catch (error) {
    if (error instanceof ConvexError) return markStale(ctx, preview)
    throw error
  }
  if (!live.tokens || !previewTokensEqual(live.tokens, preview.captured)) {
    return markStale(ctx, preview)
  }
  const cursor = decodeCursor(preview.cursor)
  if (!cursor) return markStale(ctx, preview)

  const section = preview.cursorPhase
  const size =
    cursor.size ??
    (section === "locale_prefix_shadowing" &&
    cursor.prefixSource === "manual_rules"
      ? DISCLOSURE_SECTION_BATCH.manual_rules
      : sectionBatch(section))
  const batch =
    section === "menus" && cursor.menu
      ? await resumeMenu(ctx, preview, cursor, size)
      : cursor.done
        ? ({
            kind: "items",
            items: [],
            delta: NO_DELTA,
            cursor: "section_done",
          } as const)
        : await readSectionPage(ctx, preview, section, cursor, size, live)

  if (batch.kind === "stale") return markStale(ctx, preview)
  const now = Date.now()
  if (batch.kind === "halve") {
    if (size <= 1) return markStale(ctx, preview)
    await ctx.db.patch(preview._id, {
      cursor: encodeCursor({ ...cursor, size: Math.floor(size / 2) }),
      updatedAt: now,
    })
    return { kind: "continue" }
  }

  const items = batch.items.map(truncateDisclosureItem)
  let digest = preview.digest
  let pageCount = preview.pageCount
  if (items.length > 0) {
    if (
      items.length > DISCLOSURE_PAGE_MAX_ITEMS ||
      disclosureItemsBytes(items) > DISCLOSURE_PAGE_ITEMS_MAX_BYTES
    ) {
      throw new Error("DISCLOSURE_PAGE_BOUND_EXCEEDED")
    }
    digest = await digestDisclosurePage({
      previousDigest: preview.digest,
      subjectId: preview._id,
      generation: preview.generation,
      ordinal: pageCount,
      section,
      items,
    })
    await ctx.db.insert("siteLanguageDisclosurePages", {
      previewId: preview._id,
      generation: preview.generation,
      ordinal: pageCount,
      section,
      items,
      digest,
      createdAt: now,
    })
    pageCount += 1
  }

  const count = {
    publicPages: preview.count.publicPages + batch.delta.publicPages,
    routes: preview.count.routes + batch.delta.routes,
    manualRules: preview.count.manualRules + batch.delta.manualRules,
    menus: preview.count.menus + batch.delta.menus,
  }
  const following =
    batch.cursor === "section_done"
      ? nextSection(section, live.redirectsEffective, preview.kind)
      : section
  if (following === null) {
    const expiresAt = now + IMPACT_PREVIEW_TTL_MS
    await ctx.db.patch(preview._id, {
      phase: "complete",
      cursor: undefined,
      count,
      digest,
      pageCount,
      completedAt: now,
      expiresAt,
      updatedAt: now,
    })
    return { kind: "complete", expiresAt }
  }
  await ctx.db.patch(preview._id, {
    cursorPhase: following,
    cursor:
      batch.cursor === "section_done" ? undefined : encodeCursor(batch.cursor),
    count,
    digest,
    pageCount,
    updatedAt: now,
  })
  return { kind: "continue" }
}

/** Reads the page, then checks metrics after it and after every item (S6). */
async function readSectionPage(
  ctx: MutationCtx,
  preview: ImpactPreview,
  section: ImpactPreviewSection,
  cursor: PreviewCursor,
  size: number,
  live: LivePreviewState
): Promise<Batch> {
  const locale = preview.locale
  const numItems = section === "menus" ? 1 : size
  const options = { numItems, cursor: cursor.page }
  const items: DisclosureItem[] = []
  const delta = { ...NO_DELTA }
  let menuCursor: PreviewCursor["menu"]

  const guard = async <T>(
    read: () => Promise<PaginationResult<T>>
  ): Promise<PaginationResult<T> | Batch> => {
    let result: PaginationResult<T>
    try {
      result = await read()
    } catch {
      // A cursor that no longer resumes is refused, not misread (R8-H1).
      return { kind: "stale" }
    }
    if (result.page.length > numItems) return { kind: "stale" }
    if (result.pageStatus === "SplitRequired") {
      // The menus page is already one row; nothing is left to halve.
      return numItems <= 1 ? { kind: "stale" } : { kind: "halve" }
    }
    if (crossedReserve(await impactPreviewSeam.metrics(ctx))) {
      return { kind: "halve" }
    }
    return result
  }
  const afterItem = async () =>
    crossedReserve(await impactPreviewSeam.metrics(ctx))

  let isDone: boolean
  let continueCursor: string
  let prefixCursor: PreviewCursor | "section_done" | undefined
  switch (section) {
    case "selections": {
      const result = await guard(() =>
        impactPreviewSeam.paginate(
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
              q.eq("hasCurrentSnapshot", true).eq("locale", locale)
            ),
          options
        )
      )
      if ("kind" in result) return result
      for (const row of result.page) {
        const title = row.currentSnapshotId
          ? await readSnapshotDisplayTitle(ctx, row.currentSnapshotId)
          : ""
        items.push(
          row.currentPath === undefined
            ? { kind: "selection_non_routable", pageId: row.pageId, title }
            : {
                kind: "selection",
                pageId: row.pageId,
                path: row.currentPath,
                title,
              }
        )
        delta.publicPages += 1
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
    case "historical_routes": {
      const result = await guard(() =>
        impactPreviewSeam.paginate(
          ctx.db
            .query("pageHistoricalLocaleRoutes")
            .withIndex("by_locale_and_fromPath", (q) => q.eq("locale", locale)),
          options
        )
      )
      if ("kind" in result) return result
      for (const row of result.page) {
        if (row.releasedAt !== undefined) continue
        items.push({
          kind: "historical_route",
          pageId: row.pageId,
          fromPath: row.fromPath,
        })
        delta.routes += 1
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
    case "manual_rules": {
      const result = await guard(() =>
        impactPreviewSeam.paginate(
          ctx.db
            .query("redirects")
            .withIndex("by_locale_fromPath", (q) => q.eq("locale", locale)),
          options
        )
      )
      if ("kind" in result) return result
      for (const row of result.page) {
        items.push({
          kind: "manual_rule",
          ruleId: row._id,
          fromPath: row.fromPath,
          destination:
            row.toPageId !== undefined
              ? { kind: "page", pageId: row.toPageId }
              : /^https?:\/\//i.test(row.toPath ?? "")
                ? { kind: "external", url: row.toPath! }
                : { kind: "path", toPath: row.toPath ?? "" },
          statusCode: row.statusCode,
          // Removal silences the rule; reveal restores it.
          status: preview.kind === "remove" ? "silenced" : "active",
        })
        delta.manualRules += 1
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
    case "menus": {
      const result = await guard(() =>
        impactPreviewSeam.paginate(
          ctx.db.query("menus").withIndex("by_slug"),
          options
        )
      )
      if ("kind" in result) return result
      for (const menu of result.page) {
        if (menu.deletedAt !== undefined) continue
        const paths = menuNodePathsWithLocaleText(menu.nav, locale)
        if (paths.length === 0) continue
        delta.menus += 1
        items.push(...menuItems(menu, paths.slice(0, size)))
        if (paths.length > size) menuCursor = { menuId: menu._id, next: size }
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
    case "locale_prefix_shadowing": {
      if (live.state.kind !== "multilingual") return { kind: "stale" }
      const defaultLocale = live.state.locale
      const { start, end } = localePrefixRange(locale)
      const source = cursor.prefixSource ?? "current"
      if (source === "current") {
        const result = await guard(() =>
          impactPreviewSeam.paginate(
            ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_locale_and_currentPath", (q) =>
                q
                  .eq("locale", defaultLocale)
                  .gte("currentPath", start)
                  .lt("currentPath", end)
              ),
            options
          )
        )
        if ("kind" in result) return result
        for (const row of result.page) {
          if (
            !row.hasCurrentSnapshot ||
            row.currentPath === undefined ||
            !isLocalePrefixPath(row.currentPath, locale)
          ) {
            continue
          }
          items.push({
            kind: "locale_prefix_shadow",
            pageId: row.pageId,
            fromPath: row.currentPath,
            origin: "current",
          })
          delta.publicPages += 1
          if (await afterItem()) return { kind: "halve" }
        }
        prefixCursor = result.isDone
          ? { page: null, prefixSource: "historical" }
          : { page: result.continueCursor, prefixSource: source }
      } else if (source === "historical") {
        const result = await guard(() =>
          impactPreviewSeam.paginate(
            ctx.db
              .query("pageHistoricalLocaleRoutes")
              .withIndex("by_locale_and_fromPath", (q) =>
                q
                  .eq("locale", defaultLocale)
                  .gte("fromPath", start)
                  .lt("fromPath", end)
              ),
            options
          )
        )
        if ("kind" in result) return result
        for (const row of result.page) {
          if (
            row.releasedAt !== undefined ||
            !isLocalePrefixPath(row.fromPath, locale)
          )
            continue
          items.push({
            kind: "locale_prefix_shadow",
            pageId: row.pageId,
            fromPath: row.fromPath,
            origin: "historical",
          })
          delta.routes += 1
          if (await afterItem()) return { kind: "halve" }
        }
        prefixCursor = result.isDone
          ? { page: null, prefixSource: "continuity" }
          : { page: result.continueCursor, prefixSource: source }
      } else if (source === "continuity") {
        const pointer = live.state.authority.continuityPointer
        const transitionId = live.state.authority.lastCommittedTransitionId
        if (pointer) {
          const result = await guard(() =>
            impactPreviewSeam.paginate(
              ctx.db
                .query("siteDefaultLanguageRoutes")
                .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
                  q
                    .eq("migrationId", pointer.migrationId)
                    .eq("generation", pointer.generation)
                    .gte("fromPath", start)
                    .lt("fromPath", end)
                ),
              options
            )
          )
          if ("kind" in result) return result
          for (const row of result.page) {
            if (
              row.shadow !== undefined ||
              row.retiredAt !== undefined ||
              !isLocalePrefixPath(row.fromPath, locale)
            ) {
              continue
            }
            items.push({
              kind: "locale_prefix_shadow",
              pageId: row.pageId,
              fromPath: row.fromPath,
              origin: "default_migration",
            })
            delta.routes += 1
            if (await afterItem()) return { kind: "halve" }
          }
          prefixCursor = result.isDone
            ? live.redirectsEffective
              ? { page: null, prefixSource: "manual_rules" }
              : "section_done"
            : { page: result.continueCursor, prefixSource: source }
        } else if (transitionId) {
          const result = await guard(() =>
            impactPreviewSeam.paginate(
              ctx.db
                .query("siteLanguageTransitionRoutes")
                .withIndex("by_transitionId_and_fromPath", (q) =>
                  q
                    .eq("transitionId", transitionId)
                    .gte("fromPath", start)
                    .lt("fromPath", end)
                ),
              options
            )
          )
          if ("kind" in result) return result
          for (const row of result.page) {
            if (!isLocalePrefixPath(row.fromPath, locale)) continue
            items.push({
              kind: "locale_prefix_shadow",
              pageId: row.pageId,
              fromPath: row.fromPath,
              origin: "language_transition",
            })
            delta.routes += 1
            if (await afterItem()) return { kind: "halve" }
          }
          prefixCursor = result.isDone
            ? live.redirectsEffective
              ? { page: null, prefixSource: "manual_rules" }
              : "section_done"
            : { page: result.continueCursor, prefixSource: source }
        } else {
          prefixCursor = live.redirectsEffective
            ? { page: null, prefixSource: "manual_rules" }
            : "section_done"
        }
      } else {
        if (!live.redirectsEffective) return { kind: "stale" }
        const result = await guard(() =>
          impactPreviewSeam.paginate(
            ctx.db
              .query("redirects")
              .withIndex("by_locale_fromPath", (q) =>
                q
                  .eq("locale", defaultLocale)
                  .gte("fromPath", start)
                  .lt("fromPath", end)
              ),
            options
          )
        )
        if ("kind" in result) return result
        for (const row of result.page) {
          if (!isLocalePrefixPath(row.fromPath, locale)) continue
          items.push({
            kind: "manual_rule",
            ruleId: row._id,
            fromPath: row.fromPath,
            destination:
              row.toPageId !== undefined
                ? { kind: "page", pageId: row.toPageId }
                : /^https?:\/\//i.test(row.toPath ?? "")
                  ? { kind: "external", url: row.toPath! }
                  : { kind: "path", toPath: row.toPath ?? "" },
            statusCode: row.statusCode,
            status: "shadowed",
          })
          delta.manualRules += 1
          if (await afterItem()) return { kind: "halve" }
        }
        prefixCursor = result.isDone
          ? "section_done"
          : { page: result.continueCursor, prefixSource: source }
      }
      isDone = prefixCursor === "section_done"
      continueCursor =
        prefixCursor === "section_done" ? "" : (prefixCursor.page ?? "")
      break
    }
  }

  if (menuCursor) {
    return {
      kind: "items",
      items,
      delta,
      cursor: {
        page: continueCursor,
        ...(isDone ? { done: true as const } : {}),
        menu: menuCursor,
      },
    }
  }
  if (prefixCursor) {
    return {
      kind: "items",
      items,
      delta,
      cursor: prefixCursor,
    }
  }
  return {
    kind: "items",
    items,
    delta,
    cursor: isDone ? "section_done" : { page: continueCursor },
  }
}

/**
 * What the prefix-shadow probe needs, stated explicitly so it also works
 * before adoption (S0, S1, S2, S3): the default language, the F09 continuity
 * the authority row carries (if any) and whether Redirects is effective.
 */
export type LocalePrefixShadowInputs = {
  defaultLocale: string
  continuityPointer: Doc<"siteLanguageAuthority">["continuityPointer"]
  lastCommittedTransitionId: Doc<"siteLanguageAuthority">["lastCommittedTransitionId"]
  redirectsEffective: boolean
}

/** Bounded commit probe for any default-language URL shadowed by the prefix. */
export async function hasLocalePrefixShadow(
  ctx: Ctx,
  live: LivePreviewState,
  locale: string
): Promise<boolean> {
  if (live.state.kind !== "multilingual") return false
  return readLocalePrefixShadow(
    ctx,
    {
      defaultLocale: live.state.locale,
      continuityPointer: live.state.authority.continuityPointer,
      lastCommittedTransitionId: live.state.authority.lastCommittedTransitionId,
      redirectsEffective: live.redirectsEffective,
    },
    locale
  )
}

/**
 * The same bounded `take(1)` probes around explicit inputs. It reads only
 * route, continuity and rule rows, so the owner query can ask before the
 * module is on without a multilingual authority or preview tokens.
 */
export async function readLocalePrefixShadow(
  ctx: Ctx,
  inputs: LocalePrefixShadowInputs,
  locale: string
): Promise<boolean> {
  const { defaultLocale } = inputs
  const root = `/${locale}`
  async function unreleasedHistory(
    query: AsyncIterable<Doc<"pageHistoricalLocaleRoutes">>
  ) {
    const rows: Doc<"pageHistoricalLocaleRoutes">[] = []
    for await (const row of query) {
      if (row.releasedAt !== undefined) continue
      rows.push(row)
      if (rows.length === 1) break
    }
    return rows
  }
  const [
    currentExact,
    currentDescendant,
    historicalExact,
    historicalDescendant,
  ] = await Promise.all([
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) =>
        q.eq("locale", defaultLocale).eq("currentPath", root)
      )
      .take(1),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) =>
        q
          .eq("locale", defaultLocale)
          .gte("currentPath", `${root}/`)
          .lt("currentPath", `${root}0`)
      )
      .take(1),
    unreleasedHistory(
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", defaultLocale).eq("fromPath", root)
        )
    ),
    unreleasedHistory(
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q
            .eq("locale", defaultLocale)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
    ),
  ])
  if (
    currentExact.length > 0 ||
    currentDescendant.length > 0 ||
    historicalExact.length > 0 ||
    historicalDescendant.length > 0
  ) {
    return true
  }

  const pointer = inputs.continuityPointer
  const transitionId = inputs.lastCommittedTransitionId
  if (pointer) {
    const [exact, descendant] = await Promise.all([
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q
            .eq("migrationId", pointer.migrationId)
            .eq("generation", pointer.generation)
            .eq("fromPath", root)
        )
        .take(1),
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q
            .eq("migrationId", pointer.migrationId)
            .eq("generation", pointer.generation)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
        .take(1),
    ])
    if (exact.length > 0 || descendant.length > 0) return true
  } else if (transitionId) {
    const [exact, descendant] = await Promise.all([
      ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", root)
        )
        .take(1),
      ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q
            .eq("transitionId", transitionId)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
        .take(1),
    ])
    if (exact.length > 0 || descendant.length > 0) return true
  }

  if (!inputs.redirectsEffective) return false
  const [ruleExact, ruleDescendant] = await Promise.all([
    ctx.db
      .query("redirects")
      .withIndex("by_locale_fromPath", (q) =>
        q.eq("locale", defaultLocale).eq("fromPath", root)
      )
      .take(1),
    ctx.db
      .query("redirects")
      .withIndex("by_locale_fromPath", (q) =>
        q
          .eq("locale", defaultLocale)
          .gte("fromPath", `${root}/`)
          .lt("fromPath", `${root}0`)
      )
      .take(1),
  ])
  return ruleExact.length > 0 || ruleDescendant.length > 0
}

function menuItems(
  menu: Doc<"menus">,
  paths: readonly string[]
): DisclosureItem[] {
  return paths.map((nodePath) => ({
    kind: "menu_node",
    menuId: menu._id,
    menuName: menu.slug,
    nodePath,
  }))
}

/** Continues inside one menu by id; issues no paginated query (S10). */
async function resumeMenu(
  ctx: MutationCtx,
  preview: ImpactPreview,
  cursor: PreviewCursor,
  size: number
): Promise<Batch> {
  const position = cursor.menu!
  const menu = await ctx.db.get(position.menuId)
  // A menu write between steps advances a captured counter, so a missing or
  // deleted menu here means the walk is no longer static.
  if (!menu || menu.deletedAt !== undefined) return { kind: "stale" }
  const paths = menuNodePathsWithLocaleText(menu.nav, preview.locale)
  if (position.next >= paths.length) return { kind: "stale" }
  const end = position.next + size
  if (crossedReserve(await impactPreviewSeam.metrics(ctx))) {
    return { kind: "halve" }
  }
  const items = menuItems(menu, paths.slice(position.next, end))
  const { size: _halved, menu: _menu, ...rest } = cursor
  void _halved
  void _menu
  if (end < paths.length) {
    return {
      kind: "items",
      items,
      delta: NO_DELTA,
      cursor: { ...rest, menu: { menuId: menu._id, next: end } },
    }
  }
  return {
    kind: "items",
    items,
    delta: NO_DELTA,
    cursor: rest.done ? "section_done" : { page: rest.page },
  }
}

// ─── Listing ────────────────────────────────────────────────────────────────

export type ImpactPreviewListing =
  | { stale: true }
  | {
      stale: false
      ordinal: number
      pageCount: number
      section: Doc<"siteLanguageDisclosurePages">["section"]
      items: DisclosureItem[]
      digest: string
    }

/** Reads one disclosure page of the caller's own preview. */
export async function listImpactPreviewPage(
  ctx: Ctx,
  owner: OwnerPrincipal,
  previewId: Id<"siteLanguageImpactPreviews">,
  ordinal: number
): Promise<ImpactPreviewListing> {
  const preview = await ctx.db.get(previewId)
  if (!preview || preview.owner.tokenIdentifier !== owner.tokenIdentifier) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  if (preview.phase !== "complete") return { stale: true }
  const live = await readLivePreviewState(
    ctx,
    preview.locale,
    preview.kind === "reveal"
  )
  if (!live.tokens || !previewTokensEqual(live.tokens, preview.captured)) {
    return { stale: true }
  }
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= preview.pageCount
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const pages = await ctx.db
    .query("siteLanguageDisclosurePages")
    .withIndex("by_previewId_and_ordinal", (q) =>
      q.eq("previewId", previewId).eq("ordinal", ordinal)
    )
    .take(2)
  if (pages.length !== 1 || pages[0]!.generation !== preview.generation) {
    fail("LANGUAGE_PREVIEW_STATE_INVALID")
  }
  const page = pages[0]!
  return {
    stale: false,
    ordinal,
    pageCount: preview.pageCount,
    section: page.section,
    items: page.items,
    digest: page.digest,
  }
}

// ─── Review receipt ─────────────────────────────────────────────────────────

export type ImpactPreviewReceipt =
  | { stale: true }
  | { stale: false; reviewedThroughOrdinal: number; pageCount: number }

/**
 * Advances the caller's review receipt by exactly one page (M16). A preview
 * that is not `complete`, has passed `expiresAt` or whose tokens moved returns
 * `{stale: true}` and records nothing, as the listing does; the listing cannot
 * read the clock, so only the receipt refuses an expiry whose flip has not run
 * yet. Another owner's preview, an out-of-order ordinal and a wrong digest are
 * malformed receipts and refuse (ledger C2b.1e).
 */
export async function recordImpactReviewInTransaction(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  previewId: Id<"siteLanguageImpactPreviews">,
  ordinal: number,
  pageDigest: string
): Promise<ImpactPreviewReceipt> {
  const preview = await ctx.db.get(previewId)
  if (!preview || preview.owner.tokenIdentifier !== owner.tokenIdentifier) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const now = Date.now()
  if (
    preview.phase !== "complete" ||
    preview.expiresAt === undefined ||
    now >= preview.expiresAt
  ) {
    return { stale: true }
  }
  const live = await readLivePreviewState(
    ctx,
    preview.locale,
    preview.kind === "reveal"
  )
  if (!live.tokens || !previewTokensEqual(live.tokens, preview.captured)) {
    return { stale: true }
  }
  if (
    ordinal !== preview.reviewedThroughOrdinal + 1 ||
    ordinal >= preview.pageCount
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const pages = await ctx.db
    .query("siteLanguageDisclosurePages")
    .withIndex("by_previewId_and_ordinal", (q) =>
      q.eq("previewId", previewId).eq("ordinal", ordinal)
    )
    .take(2)
  if (pages.length !== 1 || pages[0]!.generation !== preview.generation) {
    fail("LANGUAGE_PREVIEW_STATE_INVALID")
  }
  if (pages[0]!.digest !== pageDigest) fail("LANGUAGE_PREVIEW_MISMATCH")
  await ctx.db.patch(previewId, {
    reviewedThroughOrdinal: ordinal,
    updatedAt: now,
  })
  return {
    stale: false,
    reviewedThroughOrdinal: ordinal,
    pageCount: preview.pageCount,
  }
}

// ─── Commit ─────────────────────────────────────────────────────────────────

/** What the owner saw and submits with a commit (M16). */
export type PreviewCommitClaim = {
  previewId: Id<"siteLanguageImpactPreviews">
  expectedDigest: string
  expectedCount: ImpactPreview["count"]
}

function countsEqual(
  left: ImpactPreview["count"],
  right: ImpactPreview["count"]
): boolean {
  return (
    left.publicPages === right.publicPages &&
    left.routes === right.routes &&
    left.manualRules === right.manualRules &&
    left.menus === right.menus
  )
}

/**
 * M16 at commit, one point read. The preview must be the caller's own, of
 * `kind` for `locale`, `complete`, unexpired, captured at the live tokens,
 * equal to the submitted terminal digest and count, and reviewed through its
 * last page. Refusals (ledger C2b.2a): a foreign, other-kind or other-locale
 * preview, or another digest or count, is `LANGUAGE_PREVIEW_MISMATCH`; a
 * scanning preview or a short receipt is `LANGUAGE_PREVIEW_REVIEW_INCOMPLETE`;
 * a stale, expired or consumed preview, one past `expiresAt` whose flip has
 * not run, or moved tokens is `LANGUAGE_OPERATION_STALE`.
 */
export async function requireCommittablePreview(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  kind: ImpactPreviewKind,
  locale: string,
  liveTokens: ImpactPreviewTokens,
  claim: PreviewCommitClaim
): Promise<ImpactPreview> {
  const preview = await ctx.db.get(claim.previewId)
  if (
    !preview ||
    preview.owner.tokenIdentifier !== owner.tokenIdentifier ||
    preview.kind !== kind ||
    preview.locale !== locale
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  if (preview.phase === "scanning") fail("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE")
  if (
    preview.phase !== "complete" ||
    preview.expiresAt === undefined ||
    Date.now() >= preview.expiresAt ||
    !previewTokensEqual(liveTokens, preview.captured)
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  if (
    preview.digest !== claim.expectedDigest ||
    !countsEqual(preview.count, claim.expectedCount)
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  if (preview.reviewedThroughOrdinal !== preview.pageCount - 1) {
    fail("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE")
  }
  return preview
}

/** Flips a still-`complete` preview to `expired` at its expiry time. */
export async function expireImpactPreviewInTransaction(
  ctx: MutationCtx,
  previewId: Id<"siteLanguageImpactPreviews">,
  generation: number
): Promise<void> {
  const preview = await ctx.db.get(previewId)
  if (
    !preview ||
    preview.phase !== "complete" ||
    preview.generation !== generation ||
    preview.expiresAt === undefined ||
    Date.now() < preview.expiresAt
  ) {
    return
  }
  await ctx.db.patch(previewId, { phase: "expired", updatedAt: Date.now() })
}
