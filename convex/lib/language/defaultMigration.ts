import { ConvexError } from "convex/values"
import type {
  PaginationOptions,
  PaginationResult,
  TransactionMetrics,
} from "convex/server"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"
import { storeLegacySiteDescription } from "../../../lib/i18n/site-description"
import { panelBlocks, type NavItem } from "../menu"
import { hasLocaleText } from "../menu/canonical"
import type { OwnerPrincipal } from "../access/owner"
import {
  moduleStateFromRows,
  resolveEffectiveModuleStateFromEnabled,
} from "../modules/state"
import {
  readPublicationAuthority,
  addressPageLifecycle,
  type AddressReadCache,
} from "../publishing/snapshots"

import {
  DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES,
  DEFAULT_MIGRATION_SECTION_BATCH,
  DISCLOSURE_CHAIN_EMPTY_DIGEST,
  DISCLOSURE_PAGE_ITEMS_MAX_BYTES,
  DISCLOSURE_PAGE_MAX_ITEMS,
  digestDisclosurePage,
  disclosureItemsBytes,
  truncateDisclosureItem,
  utf8ByteLength,
  type DisclosureItem,
  type DisclosureSection,
} from "./disclosure"
import { readMigrationFreshnessTokens } from "./freshness"
import { insertLanguageLifecycleIntent } from "./lifecycle"
import {
  crossedReserve,
  decodeCursor,
  encodeCursor,
  type PreviewCursor,
} from "./impactPreview"
import {
  MULTILINGUAL_MODULE_ID,
  classifySiteLanguageState,
  readAuthorityRows,
  readOpenDefaultMigration,
  readSiteLanguageState,
  type SiteLanguageState,
} from "./state"

/**
 * M05 default-language migration (contract Default migration steps 1–4 and
 * 6, `siteDefaultLanguageMigrations`, `siteDefaultLanguageRoutes`, M13, M14,
 * M16, M23; ledger C3b and C3c.1). One step walks one cursor phase with at
 * most one `.paginate()`, computes its whole batch before writing, and writes
 * at most one disclosure page. Every step compares the captured tokens first;
 * a move restarts the generation (M14). Validation seals the generation into
 * `manifest` and sets `ready`. Activation and collection are C3c.2.
 */

type Ctx = QueryCtx | MutationCtx

export type DefaultMigration = Doc<"siteDefaultLanguageMigrations">
export type DefaultMigrationTokens = DefaultMigration["captured"]
export type DefaultMigrationCounts = DefaultMigration["counts"]
export type DefaultMigrationCursorPhase = NonNullable<
  DefaultMigration["cursorPhase"]
>
type RouteOrigin = Doc<"siteDefaultLanguageRoutes">["origin"]

/** Residual 2.3 (ledger C3b Decision): a hard maximum, enforced by the trigger. */
export const DEFAULT_MIGRATION_BYTES_READ_MAX = 4 * 1024 * 1024

/** Route rows per validation page (ceilings `validation` cell; ledger C3c.1). */
export const DEFAULT_MIGRATION_VALIDATION_BATCH = 64

export const NO_DEFAULT_MIGRATION_COUNTS: DefaultMigrationCounts = {
  rows: 0,
  shadowedByCurrent: 0,
  shadowedByHistorical: 0,
  manualRulesShadowed: 0,
  manualRulesShifted: 0,
  manualRulesUnprefixed: 0,
  carriedShadowedSkipped: 0,
  blockers: 0,
}

/**
 * The pagination and metrics seam, as for previews (ledger C2b.1d). A
 * `SplitRequired` page, a reserve crossing or an unresumable cursor can only
 * be injected here.
 */
export const defaultMigrationSeam = {
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

export type LiveMigrationState = {
  state: SiteLanguageState
  /** Null unless the authority classifies multilingual (S4). */
  tokens: DefaultMigrationTokens | null
  redirectsEffective: boolean
}

/**
 * Settings, authority and one module-state read, then the site, default and
 * target counter rows (≤ 6). The module row serves both the classifier's
 * enablement check and the configuration version, so this reads it once.
 */
export async function readLiveMigrationState(
  ctx: Ctx,
  toLocale: string
): Promise<LiveMigrationState> {
  const [settingsRows, authorityRows, moduleRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
    ctx.db
      .query("cmsModuleState")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .take(2),
  ])
  const moduleEnabled =
    moduleRows.length === 1 &&
    moduleRows[0]!.enabledModules.some(
      (entry) => entry.moduleId === MULTILINGUAL_MODULE_ID
    )
  const state = classifySiteLanguageState(
    settingsRows,
    authorityRows,
    moduleEnabled
  )
  if (state.kind !== "multilingual") {
    return { state, tokens: null, redirectsEffective: false }
  }
  const moduleState = moduleStateFromRows(moduleRows)
  const freshness = await readMigrationFreshnessTokens(
    ctx,
    state.locale,
    toLocale
  )
  const redirects = resolveEffectiveModuleStateFromEnabled(
    moduleState.configurationVersion,
    moduleState.enabledModuleIds
  ).modules.find((module) => module.moduleId === "redirects")
  return {
    state,
    tokens: {
      authorityVersion: state.version,
      moduleConfigurationVersion: moduleState.configurationVersion,
      site: freshness.site,
      from: freshness.from,
      to: freshness.to,
    },
    redirectsEffective: redirects?.effective === true,
  }
}

export function migrationTokensEqual(
  left: DefaultMigrationTokens,
  right: DefaultMigrationTokens
): boolean {
  const same = (
    a: DefaultMigrationTokens["site"],
    b: DefaultMigrationTokens["site"]
  ) =>
    a.routeClaimVersion === b.routeClaimVersion &&
    a.publicationSetVersion === b.publicationSetVersion
  return (
    left.authorityVersion === right.authorityVersion &&
    left.moduleConfigurationVersion === right.moduleConfigurationVersion &&
    same(left.site, right.site) &&
    same(left.from, right.from) &&
    same(left.to, right.to)
  )
}

/** The authority names this migration and its languages still hold. */
function namesMigration(
  state: SiteLanguageState,
  migration: DefaultMigration
): boolean {
  return (
    state.kind === "multilingual" &&
    state.authority.activeDefaultMigrationId === migration._id &&
    state.locale === migration.fromLocale &&
    state.locales.includes(migration.toLocale)
  )
}

// ─── Start ──────────────────────────────────────────────────────────────────

/**
 * The home rule, read live (R3-H2): once anything is public in any locale,
 * `N` must serve the configured home page at `/`. Two reads.
 */
async function homeRuleHolds(
  ctx: Ctx,
  settings: Pick<Doc<"siteSettings">, "homePageId">,
  toLocale: string
): Promise<boolean> {
  const anyCurrent = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
      q.eq("hasCurrentSnapshot", true)
    )
    .take(1)
  if (anyCurrent.length === 0) return true
  const homePageId = settings.homePageId
  const homeRows = homePageId
    ? await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homePageId).eq("locale", toLocale)
        )
        .take(2)
    : []
  return (
    homeRows.length === 1 &&
    homeRows[0]!.hasCurrentSnapshot &&
    homeRows[0]!.currentPath === "/"
  )
}

/**
 * C7: true when no C3b pointer exists and the last committed F09 transition
 * targets a language other than the current default (a silent change moved
 * the default after it).
 */
async function f09TransitionSuperseded(
  ctx: Ctx,
  state: Extract<SiteLanguageState, { kind: "multilingual" }>
): Promise<boolean> {
  const { authority } = state
  if (
    authority.continuityPointer !== undefined ||
    authority.lastCommittedTransitionId === undefined
  ) {
    return false
  }
  const transition = await ctx.db.get(authority.lastCommittedTransitionId)
  return transition !== null && transition.targetLocale !== state.locale
}

export type StartDefaultMigrationArgs = {
  toLocale: string
  expectedAuthorityVersion: number
  expectedModuleConfigurationVersion: number
}

/**
 * Step 1. Inserts generation 1 in `enumerating`, names it on the authority and
 * returns its id; the caller schedules the first step. Refusal order follows
 * `addLanguage` (ledger C3b).
 */
export async function startDefaultMigrationInTransaction(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  args: StartDefaultMigrationArgs
): Promise<Id<"siteDefaultLanguageMigrations">> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const { toLocale } = args
  const live = await readLiveMigrationState(ctx, toLocale)
  const { state, tokens } = live
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual" || !tokens) {
    fail("MULTILINGUAL_NOT_ADOPTED")
  }
  if (
    tokens.authorityVersion !== args.expectedAuthorityVersion ||
    tokens.moduleConfigurationVersion !==
      args.expectedModuleConfigurationVersion
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  // U2 (C7): a silent default change can leave a retained F09 transition that
  // targets the outgoing default. Its carry would fail inside enumeration and
  // strand an open migration, so C3b refuses up front. C3b is being retired.
  if (await f09TransitionSuperseded(ctx, state)) {
    fail("DEFAULT_MIGRATION_SUPERSEDED")
  }
  // M6: start refuses any open migration, including one it started itself.
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(toLocale)) {
    fail("LOCALE_UNSUPPORTED")
  }
  if (!state.locales.includes(toLocale)) fail("LOCALE_NOT_ENABLED")
  if (toLocale === state.locale) fail("LOCALE_IS_DEFAULT")

  if (!(await homeRuleHolds(ctx, state.settings, toLocale))) {
    fail("DEFAULT_MIGRATION_TARGET_HOME_MISSING")
  }

  const now = Date.now()
  const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
    fromLocale: state.locale,
    toLocale,
    phase: "enumerating",
    generation: 1,
    cursorPhase: "old_default_current",
    captured: tokens,
    counts: NO_DEFAULT_MIGRATION_COUNTS,
    disclosurePageCount: 0,
    reviewedThroughOrdinal: -1,
    attribution: {
      kind: "owner",
      ownerId: owner.ownerId,
      authId: owner.authId,
      tokenIdentifier: owner.tokenIdentifier,
    },
    createdAt: now,
    updatedAt: now,
  })
  await ctx.db.patch(state.authority._id, {
    activeDefaultMigrationId: migrationId,
    updatedAt: now,
  })
  return migrationId
}

// ─── Step ───────────────────────────────────────────────────────────────────

export type DefaultMigrationStepResult =
  | { kind: "noop" }
  | { kind: "continue"; generation: number }
  | { kind: "restarted"; generation: number }
  | { kind: "blocked"; blockers: number }
  | { kind: "blocked"; code: "DEFAULT_MIGRATION_TARGET_HOME_MISSING" }
  | { kind: "ready"; generation: number; readinessVersion: number }

const STEPPABLE_PHASES: ReadonlySet<DefaultMigration["phase"]> = new Set([
  "enumerating",
  "validating",
  "ready",
])

const PHASE_ORDER: readonly DefaultMigrationCursorPhase[] = [
  "old_default_current",
  "old_default_historical",
  "carried",
  "old_default_manual_rules",
  "new_default_manual_rules",
  "menus",
  "validation",
]

function nextPhase(
  phase: DefaultMigrationCursorPhase,
  redirectsEffective: boolean
): DefaultMigrationCursorPhase {
  let index = PHASE_ORDER.indexOf(phase) + 1
  while (
    !redirectsEffective &&
    (PHASE_ORDER[index] === "old_default_manual_rules" ||
      PHASE_ORDER[index] === "new_default_manual_rules")
  ) {
    index += 1
  }
  return PHASE_ORDER[index] ?? "validation"
}

function phaseSection(
  phase: DefaultMigrationCursorPhase
): keyof typeof DEFAULT_MIGRATION_SECTION_BATCH {
  return phase === "old_default_manual_rules" ||
    phase === "new_default_manual_rules"
    ? "manual_rule_shifts"
    : phase === "menus"
      ? "menus"
      : "shadowed"
}

/** Page size (menus: node items per page) when no halving applies. */
function phaseBatch(phase: DefaultMigrationCursorPhase): number {
  return DEFAULT_MIGRATION_SECTION_BATCH[phaseSection(phase)]
}

/** A carried phase that verified F09's last committed transition (ledger C3b). */
type ClaimScan = {
  bucket: "current" | "historical"
  page: string | null
  seen: number
  held: number
}
type QueuedClaim =
  | Candidate
  | {
      rule: Pick<
        Doc<"redirects">,
        "_id" | "fromPath" | "toPath" | "toPageId" | "statusCode"
      >
    }
type MigrationCursor = PreviewCursor & {
  f09?: true
  claims?: { queue: QueuedClaim[]; sourceDone: boolean; scan?: ClaimScan }
}

function decodeMigrationCursor(
  raw: string | undefined
): MigrationCursor | null {
  const cursor = decodeCursor(raw) as MigrationCursor | null
  if (!cursor) return null
  if (cursor.f09 !== undefined && cursor.f09 !== true) return null
  const claims = cursor.claims
  if (
    claims &&
    (!Array.isArray(claims.queue) ||
      claims.queue.length === 0 ||
      claims.queue.length > 64 ||
      typeof claims.sourceDone !== "boolean" ||
      claims.queue.some((item) =>
        "rule" in item
          ? !item.rule || typeof item.rule.fromPath !== "string"
          : typeof item.fromPath !== "string" ||
            typeof item.pageId !== "string" ||
            typeof item.locale !== "string"
      ))
  )
    return null
  if (
    claims?.scan &&
    (!["current", "historical"].includes(claims.scan.bucket) ||
      (claims.scan.page !== null && typeof claims.scan.page !== "string") ||
      !Number.isSafeInteger(claims.scan.seen) ||
      claims.scan.seen < 0 ||
      claims.scan.seen > 100 ||
      !Number.isSafeInteger(claims.scan.held) ||
      claims.scan.held < 0 ||
      claims.scan.held > 1)
  )
    return null
  return cursor
}

function reserveCrossed(metrics: TransactionMetrics): boolean {
  return (
    metrics.bytesRead.used > DEFAULT_MIGRATION_BYTES_READ_MAX ||
    crossedReserve(metrics)
  )
}

/**
 * M14: generation + 1 from an empty cursor with fresh tokens; counts, the
 * digest chain, disclosure pages and the review receipt start over. Rows and
 * pages of the old generation are left for collection (C3c.2). A previous
 * `manifest` stays, so readiness versions never repeat (ledger C3c.1).
 */
async function restart(
  ctx: MutationCtx,
  migration: DefaultMigration,
  tokens: DefaultMigrationTokens
): Promise<DefaultMigrationStepResult> {
  const generation = migration.generation + 1
  await ctx.db.patch(migration._id, {
    phase: "enumerating",
    generation,
    cursorPhase: "old_default_current",
    cursor: undefined,
    captured: tokens,
    counts: NO_DEFAULT_MIGRATION_COUNTS,
    digest: undefined,
    disclosurePageCount: 0,
    reviewedThroughOrdinal: -1,
    updatedAt: Date.now(),
  })
  return { kind: "restarted", generation }
}

type PlannedRow = {
  fromPath: string
  pageId: Id<"pages">
  locale: string
  origin: RouteOrigin
  shadow?: "to_current" | "to_historical"
  manualRule?: "shadowed"
  capturedPath?: string
}

type Batch =
  | {
      kind: "items"
      items: DisclosureItem[]
      rows: PlannedRow[]
      delta: DefaultMigrationCounts
      cursor: MigrationCursor | "phase_done"
    }
  | { kind: "halve" }
  | { kind: "restart" }

function addCounts(
  left: DefaultMigrationCounts,
  right: DefaultMigrationCounts
): DefaultMigrationCounts {
  return {
    rows: left.rows + right.rows,
    shadowedByCurrent: left.shadowedByCurrent + right.shadowedByCurrent,
    shadowedByHistorical:
      left.shadowedByHistorical + right.shadowedByHistorical,
    manualRulesShadowed: left.manualRulesShadowed + right.manualRulesShadowed,
    manualRulesShifted: left.manualRulesShifted + right.manualRulesShifted,
    manualRulesUnprefixed:
      left.manualRulesUnprefixed + right.manualRulesUnprefixed,
    carriedShadowedSkipped:
      left.carriedShadowedSkipped + right.carriedShadowedSkipped,
    blockers: left.blockers + right.blockers,
  }
}

/**
 * One bounded step (contract Delayed work, `stepDefaultLanguageMigration`).
 * The caller schedules the continuation on `continue` and `restarted`.
 */
export async function stepDefaultMigrationInTransaction(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  generation: number
): Promise<DefaultMigrationStepResult> {
  const migration = await ctx.db.get(migrationId)
  if (
    !migration ||
    !STEPPABLE_PHASES.has(migration.phase) ||
    migration.generation !== generation
  ) {
    return { kind: "noop" }
  }

  let live: LiveMigrationState
  try {
    live = await readLiveMigrationState(ctx, migration.toLocale)
  } catch (error) {
    // Invalid module state cannot be enumerated or restarted against.
    if (error instanceof ConvexError) return { kind: "noop" }
    throw error
  }
  const { state, tokens } = live
  if (!tokens || !namesMigration(state, migration)) return { kind: "noop" }
  if (!migrationTokensEqual(tokens, migration.captured)) {
    return restart(ctx, migration, tokens)
  }
  if (migration.phase === "ready") {
    const manifest = migration.manifest
    if (!manifest || manifest.generation !== generation) {
      throw new Error("DEFAULT_MIGRATION_GENERATION_INCONSISTENT")
    }
    return {
      kind: "ready",
      generation,
      readinessVersion: manifest.readinessVersion,
    }
  }
  if (migration.phase === "validating") {
    return validateStep(
      ctx,
      migration,
      tokens,
      state as Extract<SiteLanguageState, { kind: "multilingual" }>
    )
  }

  const cursor = decodeMigrationCursor(migration.cursor)
  const phase = migration.cursorPhase
  if (!cursor || !phase || phase === "validation") {
    return restart(ctx, migration, tokens)
  }
  const size = cursor.size ?? phaseBatch(phase)
  const multilingual = state as Extract<
    SiteLanguageState,
    { kind: "multilingual" }
  >

  let batch: Batch
  if (phase === "menus" && cursor.menu) {
    batch = await resumeMenu(ctx, migration, cursor, size)
  } else if (cursor.done) {
    batch = {
      kind: "items",
      items: [],
      rows: [],
      delta: NO_DEFAULT_MIGRATION_COUNTS,
      cursor: "phase_done",
    }
  } else if (phase === "carried") {
    const pointer = multilingual.authority.continuityPointer
    const transitionId = multilingual.authority.lastCommittedTransitionId
    if (!pointer && transitionId && !cursor.f09) {
      // A separate step keeps the transition read out of a full route batch.
      const transition = await ctx.db.get(transitionId)
      if (!transition || transition.targetLocale !== migration.fromLocale) {
        fail("SITE_LANGUAGE_AUTHORITY_INVALID")
      }
      await ctx.db.patch(migration._id, {
        cursor: encodeCursor({ ...cursor, f09: true } as MigrationCursor),
        updatedAt: Date.now(),
      })
      return { kind: "continue", generation }
    }
    batch =
      pointer || transitionId
        ? await readPhasePage(ctx, migration, live, phase, cursor, size)
        : {
            kind: "items",
            items: [],
            rows: [],
            delta: NO_DEFAULT_MIGRATION_COUNTS,
            cursor: "phase_done",
          }
  } else {
    batch = await readPhasePage(ctx, migration, live, phase, cursor, size)
  }

  if (batch.kind === "restart") return restart(ctx, migration, tokens)
  const now = Date.now()
  if (batch.kind === "halve") {
    if (size <= 1) return restart(ctx, migration, tokens)
    await ctx.db.patch(migration._id, {
      cursor: encodeCursor({ ...cursor, size: Math.floor(size / 2) }),
      updatedAt: now,
    })
    return { kind: "continue", generation }
  }

  for (const row of batch.rows) {
    await ctx.db.insert("siteDefaultLanguageRoutes", {
      migrationId: migration._id,
      generation,
      ...row,
      createdAt: now,
    })
  }

  const items = batch.items.map(truncateDisclosureItem)
  let digest = migration.digest
  let pageCount = migration.disclosurePageCount
  if (items.length > 0) {
    if (
      items.length > DISCLOSURE_PAGE_MAX_ITEMS ||
      disclosureItemsBytes(items) > DISCLOSURE_PAGE_ITEMS_MAX_BYTES
    ) {
      throw new Error("DISCLOSURE_PAGE_BOUND_EXCEEDED")
    }
    const section = phaseSection(phase)
    digest = await digestDisclosurePage({
      previousDigest: migration.digest ?? DISCLOSURE_CHAIN_EMPTY_DIGEST,
      subjectId: migration._id,
      generation,
      ordinal: pageCount,
      section,
      items,
    })
    await ctx.db.insert("siteLanguageDisclosurePages", {
      migrationId: migration._id,
      generation,
      ordinal: pageCount,
      section,
      items,
      digest,
      createdAt: now,
    })
    pageCount += 1
  }

  const counts = addCounts(migration.counts, batch.delta)
  const following =
    batch.cursor === "phase_done"
      ? nextPhase(phase, live.redirectsEffective)
      : phase
  if (following === "validation") {
    // The caller schedules validation (step 4) like any other step.
    await ctx.db.patch(migration._id, {
      phase: "validating",
      cursorPhase: "validation",
      cursor: undefined,
      counts,
      digest,
      disclosurePageCount: pageCount,
      updatedAt: now,
    })
    return { kind: "continue", generation }
  }
  await ctx.db.patch(migration._id, {
    cursorPhase: following,
    cursor:
      batch.cursor === "phase_done" ? undefined : encodeCursor(batch.cursor),
    counts,
    digest,
    disclosurePageCount: pageCount,
    updatedAt: now,
  })
  return { kind: "continue", generation }
}

// ─── Validation ─────────────────────────────────────────────────────────────

type ValidationTally = Pick<
  DefaultMigrationCounts,
  "rows" | "shadowedByCurrent" | "shadowedByHistorical" | "manualRulesShadowed"
>

type ValidationCursor = {
  /** The generation's `continueCursor`; null before its first page. */
  page: string | null
  /** A halved page size while one applies. */
  size?: number
  /** The previous page's last `fromPath`, for the duplicate check. */
  last?: string
  tally: ValidationTally
}

const TALLY_KEYS = [
  "rows",
  "shadowedByCurrent",
  "shadowedByHistorical",
  "manualRulesShadowed",
] as const satisfies readonly (keyof ValidationTally)[]

function decodeValidationCursor(
  raw: string | undefined
): ValidationCursor | null {
  if (raw === undefined) {
    return {
      page: null,
      tally: {
        rows: 0,
        shadowedByCurrent: 0,
        shadowedByHistorical: 0,
        manualRulesShadowed: 0,
      },
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const value = parsed as Record<string, unknown>
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0
  if (value.page !== null && typeof value.page !== "string") return null
  if (value.size !== undefined && !(count(value.size) && value.size !== 0)) {
    return null
  }
  if (value.last !== undefined && typeof value.last !== "string") return null
  const tally = value.tally as Record<string, unknown> | null | undefined
  if (!tally || typeof tally !== "object") return null
  if (!TALLY_KEYS.every((key) => count(tally[key]))) return null
  return parsed as ValidationCursor
}

function inconsistent(): never {
  throw new Error("DEFAULT_MIGRATION_GENERATION_INCONSISTENT")
}

/**
 * Step 4 (ledger C3c.1). The caller has compared tokens. Blockers stop it
 * before any read; otherwise it pages generation `g` (one `.paginate()`,
 * no per-row read), proves the stored rows match `counts`, re-checks the home
 * rule live on the last page, and seals `manifest` into `ready`.
 */
async function validateStep(
  ctx: MutationCtx,
  migration: DefaultMigration,
  tokens: DefaultMigrationTokens,
  state: Extract<SiteLanguageState, { kind: "multilingual" }>
): Promise<DefaultMigrationStepResult> {
  const { generation } = migration
  if (migration.counts.blockers > 0) {
    return { kind: "blocked", blockers: migration.counts.blockers }
  }
  const cursor = decodeValidationCursor(migration.cursor)
  if (!cursor) return restart(ctx, migration, tokens)
  const size = cursor.size ?? DEFAULT_MIGRATION_VALIDATION_BATCH

  const halve = async (): Promise<DefaultMigrationStepResult> => {
    if (size <= 1) return restart(ctx, migration, tokens)
    await ctx.db.patch(migration._id, {
      cursor: JSON.stringify({ ...cursor, size: Math.floor(size / 2) }),
      updatedAt: Date.now(),
    })
    return { kind: "continue", generation }
  }

  let result: PaginationResult<Doc<"siteDefaultLanguageRoutes">>
  try {
    result = await defaultMigrationSeam.paginate(
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q.eq("migrationId", migration._id).eq("generation", generation)
        ),
      { numItems: size, cursor: cursor.page }
    )
  } catch {
    // A cursor that no longer resumes restarts the generation (M14).
    return restart(ctx, migration, tokens)
  }
  if (result.page.length > size) return restart(ctx, migration, tokens)
  if (result.pageStatus === "SplitRequired") return halve()
  if (reserveCrossed(await defaultMigrationSeam.metrics(ctx))) return halve()

  const tally = { ...cursor.tally }
  let last = cursor.last
  for (const row of result.page) {
    // The index orders by `fromPath`, so a duplicate is adjacent.
    if (row.fromPath === last) {
      throw new Error("DEFAULT_MIGRATION_ROUTE_DUPLICATE")
    }
    last = row.fromPath
    if (row.shadow !== undefined && row.manualRule !== undefined) {
      inconsistent()
    }
    tally.rows += 1
    if (row.shadow === "to_current") tally.shadowedByCurrent += 1
    if (row.shadow === "to_historical") tally.shadowedByHistorical += 1
    if (row.manualRule !== undefined) tally.manualRulesShadowed += 1
    if (reserveCrossed(await defaultMigrationSeam.metrics(ctx))) return halve()
  }

  const now = Date.now()
  if (!result.isDone) {
    const next: ValidationCursor = {
      page: result.continueCursor,
      ...(cursor.size === undefined ? {} : { size: cursor.size }),
      ...(last === undefined ? {} : { last }),
      tally,
    }
    await ctx.db.patch(migration._id, {
      cursor: JSON.stringify(next),
      updatedAt: now,
    })
    return { kind: "continue", generation }
  }

  if (TALLY_KEYS.some((key) => tally[key] !== migration.counts[key])) {
    inconsistent()
  }
  if (!(await homeRuleHolds(ctx, state.settings, migration.toLocale))) {
    return { kind: "blocked", code: "DEFAULT_MIGRATION_TARGET_HOME_MISSING" }
  }
  const readinessVersion = (migration.manifest?.readinessVersion ?? 0) + 1
  await ctx.db.patch(migration._id, {
    phase: "ready",
    cursor: undefined,
    manifest: {
      generation,
      readinessVersion,
      captured: migration.captured,
      counts: migration.counts,
      digest: migration.digest ?? DISCLOSURE_CHAIN_EMPTY_DIGEST,
      validatedAt: now,
    },
    updatedAt: now,
  })
  return { kind: "ready", generation, readinessVersion }
}

// ─── Cancel ─────────────────────────────────────────────────────────────────

/**
 * Step 6 (ledger C3c.1). Any open phase; no public change. Collection of the
 * cancelled generation is scheduled by C3c.2 (ledger C3c.1 Deferral).
 */
export async function cancelDefaultMigrationInTransaction(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  expectedGeneration: number
): Promise<void> {
  const migration = await ctx.db.get(migrationId)
  if (!migration) fail("LANGUAGE_PREVIEW_MISMATCH")
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual") fail("MULTILINGUAL_NOT_ADOPTED")
  const open = await readOpenDefaultMigration(ctx, state)
  if (
    open?._id !== migration._id ||
    migration.generation !== expectedGeneration
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  const now = Date.now()
  await ctx.db.patch(migration._id, {
    phase: "cancelled",
    cursor: undefined,
    cancelledAt: now,
    updatedAt: now,
  })
  await ctx.db.patch(state.authority._id, {
    activeDefaultMigrationId: undefined,
    updatedAt: now,
  })
}

// ─── Activate ───────────────────────────────────────────────────────────────

export type ActivateDefaultMigrationArgs = {
  migrationId: Id<"siteDefaultLanguageMigrations">
  expectedGeneration: number
  expectedReadinessVersion: number
  expectedAuthorityVersion: number
}

/**
 * Step 5 (ledger C3c.2a Interpretation). One compare-and-set: every refusal
 * writes nothing, and success writes only the authority, settings, the
 * migration and one lifecycle intent. It never writes a route row (M12).
 */
export async function activateDefaultMigrationInTransaction(
  ctx: MutationCtx,
  args: ActivateDefaultMigrationArgs
): Promise<{ version: number; locale: string }> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const migration = await ctx.db.get(args.migrationId)
  if (!migration) {
    // State refusals still come first; only the migration names the target.
    const current = await readSiteLanguageState(ctx)
    if (current.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
    if (current.kind !== "multilingual") fail("MULTILINGUAL_NOT_ADOPTED")
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const live = await readLiveMigrationState(ctx, migration.toLocale)
  const { state, tokens } = live
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual" || tokens === null) {
    fail("MULTILINGUAL_NOT_ADOPTED")
  }
  const openMigration = await readOpenDefaultMigration(ctx, state)
  if (
    openMigration?._id !== migration._id ||
    !namesMigration(state, migration)
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  const { manifest } = migration
  if (
    tokens.authorityVersion !== args.expectedAuthorityVersion ||
    migration.generation !== args.expectedGeneration ||
    migration.phase !== "ready" ||
    manifest === undefined ||
    manifest.generation !== migration.generation ||
    manifest.readinessVersion !== args.expectedReadinessVersion ||
    !migrationTokensEqual(manifest.captured, migration.captured) ||
    !migrationTokensEqual(manifest.captured, tokens)
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  if (
    migration.disclosurePageCount > 0 &&
    migration.reviewedThroughOrdinal !== migration.disclosurePageCount - 1
  ) {
    fail("DEFAULT_MIGRATION_REVIEW_INCOMPLETE")
  }
  // M15: the home rule has no counter, so it is re-read here (R3-H2).
  const homeHolds = await homeRuleHolds(ctx, state.settings, migration.toLocale)
  if (!homeHolds) fail("DEFAULT_MIGRATION_TARGET_HOME_MISSING")
  const obligations = await Promise.all(
    [migration.fromLocale, migration.toLocale].flatMap((locale) =>
      (["pending", "held"] as const).map((status) =>
        ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_locale_and_status", (q) =>
            q.eq("locale", locale).eq("status", status)
          )
          .take(1)
      )
    )
  )
  if (obligations.some((rows) => rows.length > 0)) {
    fail("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT")
  }

  const now = Date.now()
  const version = state.version + 1
  await ctx.db.patch(state.authority._id, {
    currentLocale: migration.toLocale,
    version,
    continuityPointer: {
      migrationId: migration._id,
      generation: migration.generation,
    },
    activeDefaultMigrationId: undefined,
    updatedAt: now,
  })
  await ctx.db.patch(state.settings._id, {
    defaultLocale: migration.toLocale,
    // M05 A5: the legacy single description is stored under the outgoing
    // default language in this same commit, so the change never relabels it.
    ...storeLegacySiteDescription(state.settings, migration.fromLocale),
    updatedAt: now,
  })
  await ctx.db.patch(migration._id, {
    phase: "committed",
    committedAt: now,
    committedAuthorityVersion: version,
    updatedAt: now,
  })
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `default_migration:v${version}`,
    operationKind: "default_migration",
    locales: [migration.fromLocale, migration.toLocale],
    migrationId: migration._id,
    generation: migration.generation,
    capturedAuthorityVersion: version,
  })
  return { version, locale: migration.toLocale }
}

// ─── Phase pages ────────────────────────────────────────────────────────────

type Candidate = {
  fromPath: string
  pageId: Id<"pages">
  locale: string
  origin: RouteOrigin
  capturedPath?: string
}

function localePrefixed(locale: string, path: string): string {
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}

function ruleDestination(
  row: Pick<Doc<"redirects">, "toPageId" | "toPath">
): Extract<DisclosureItem, { kind: "manual_rule" }>["destination"] {
  return row.toPageId !== undefined
    ? { kind: "page", pageId: row.toPageId }
    : /^https?:\/\//i.test(row.toPath ?? "")
      ? { kind: "external", url: row.toPath! }
      : { kind: "path", toPath: row.toPath ?? "" }
}

async function existingRoute(
  ctx: MutationCtx,
  migration: DefaultMigration,
  fromPath: string
): Promise<Doc<"siteDefaultLanguageRoutes"> | null> {
  const rows = await ctx.db
    .query("siteDefaultLanguageRoutes")
    .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
      q
        .eq("migrationId", migration._id)
        .eq("generation", migration.generation)
        .eq("fromPath", fromPath)
    )
    .take(2)
  // Uniqueness of `(migrationId, generation, fromPath)` fails closed.
  if (rows.length > 1) throw new Error("DEFAULT_MIGRATION_ROUTE_DUPLICATE")
  return rows[0] ?? null
}

/**
 * Hold at most one exact bucket page per step. Source pagination and dense claim
 * pagination never share a transaction; dense trash/released buckets
 * therefore cannot spend the 92-query / 112-document enumeration reserve.
 * Freshness tokens are checked again by the caller on every continuation.
 */
async function readClaimStep(
  ctx: MutationCtx,
  migration: DefaultMigration,
  live: LiveMigrationState,
  phase: Exclude<DefaultMigrationCursorPhase, "validation">,
  cursor: MigrationCursor,
  size: number
): Promise<Batch> {
  const items: DisclosureItem[] = [],
    rows: PlannedRow[] = []
  const delta = { ...NO_DEFAULT_MIGRATION_COUNTS }
  const cache: AddressReadCache = new Map()
  const finish = (
    claims: MigrationCursor["claims"],
    page = cursor.page,
    done = false
  ): Batch => ({
    kind: "items",
    items,
    rows,
    delta,
    cursor:
      !claims && done
        ? "phase_done"
        : {
            page,
            ...(cursor.f09 ? { f09: true as const } : {}),
            ...(claims
              ? { claims, ...(cursor.size ? { size: cursor.size } : {}) }
              : {}),
          },
  })
  if (!cursor.claims) {
    const options = { numItems: size, cursor: cursor.page }
    let result: PaginationResult<QueuedClaim>
    try {
      if (phase === "old_default_current") {
        const page = await defaultMigrationSeam.paginate(
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_locale_and_currentPath", (q) =>
              q.eq("locale", migration.fromLocale)
            ),
          options
        )
        result = {
          ...page,
          page: page.page
            .filter(
              (row) => row.currentPath !== undefined && row.hasCurrentSnapshot
            )
            .map((row) => ({
              fromPath: row.currentPath!,
              pageId: row.pageId,
              locale: migration.fromLocale,
              origin: "old_default_current" as const,
              capturedPath: row.currentPath,
            })),
        }
      } else if (phase === "old_default_historical") {
        const page = await defaultMigrationSeam.paginate(
          ctx.db
            .query("pageHistoricalLocaleRoutes")
            .withIndex("by_locale_and_fromPath", (q) =>
              q.eq("locale", migration.fromLocale)
            ),
          options
        )
        result = {
          ...page,
          page: page.page
            .filter((row) => row.releasedAt === undefined)
            .map((row) => ({
              fromPath: row.fromPath,
              pageId: row.pageId,
              locale: migration.fromLocale,
              origin: "old_default_historical" as const,
            })),
        }
      } else if (phase === "new_default_manual_rules") {
        const page = await defaultMigrationSeam.paginate(
          ctx.db
            .query("redirects")
            .withIndex("by_locale_fromPath", (q) =>
              q.eq("locale", migration.toLocale)
            ),
          options
        )
        result = {
          ...page,
          page: page.page.map(
            ({ _id, fromPath, toPageId, toPath, statusCode }) => ({
              rule: { _id, fromPath, toPageId, toPath, statusCode },
            })
          ),
        }
      } else {
        const authority = (
          live.state as Extract<SiteLanguageState, { kind: "multilingual" }>
        ).authority
        if (authority.continuityPointer) {
          const pointer = authority.continuityPointer
          const page = await defaultMigrationSeam.paginate(
            ctx.db
              .query("siteDefaultLanguageRoutes")
              .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
                q
                  .eq("migrationId", pointer.migrationId)
                  .eq("generation", pointer.generation)
              ),
            options
          )
          delta.carriedShadowedSkipped = page.page.filter(
            (row) => row.shadow !== undefined || row.retiredAt !== undefined
          ).length
          result = {
            ...page,
            page: page.page
              .filter(
                (row) => row.shadow === undefined && row.retiredAt === undefined
              )
              .map((row) => ({
                fromPath: row.fromPath,
                pageId: row.pageId,
                locale: row.locale,
                origin: "carried" as const,
              })),
          }
        } else {
          const page = await defaultMigrationSeam.paginate(
            ctx.db
              .query("siteLanguageTransitionRoutes")
              .withIndex("by_transitionId_and_fromPath", (q) =>
                q.eq("transitionId", authority.lastCommittedTransitionId!)
              ),
            options
          )
          result = {
            ...page,
            page: page.page.map((row) => ({
              fromPath: row.fromPath,
              pageId: row.pageId,
              locale: migration.fromLocale,
              origin: "carried" as const,
            })),
          }
        }
      }
    } catch {
      return { kind: "restart" }
    }
    if (
      result.pageStatus === "SplitRequired" ||
      reserveCrossed(await defaultMigrationSeam.metrics(ctx))
    )
      return { kind: "halve" }
    if (!result.page.length)
      return finish(undefined, result.continueCursor, result.isDone)
    cursor = {
      ...cursor,
      page: result.continueCursor,
      claims: { queue: result.page, sourceDone: result.isDone },
    }
  }

  const planned = new Set<string>()
  const emit = async (
    item: QueuedClaim,
    shadow?: "to_current" | "to_historical"
  ) => {
    const fromPath = "rule" in item ? item.rule.fromPath : item.fromPath
    if ("rule" in item) {
      if (!shadow) {
        const shadowed = Boolean(await existingRoute(ctx, migration, fromPath))
        items.push({
          kind: "manual_rule",
          ruleId: item.rule._id,
          fromPath,
          destination: ruleDestination(item.rule),
          statusCode: item.rule.statusCode,
          status: shadowed ? "shadowed" : "shifted",
          ...(!shadowed ? { newVisiblePath: fromPath } : {}),
        })
        if (!shadowed) delta.manualRulesUnprefixed++
      }
    } else {
      const row: PlannedRow = { ...item }
      if (shadow) {
        row.shadow = shadow
        items.push({
          kind: "shadowed_row",
          pageId: item.pageId,
          fromPath,
          destinationLocale: item.locale,
          reason: shadow,
        })
        if (shadow === "to_current") delta.shadowedByCurrent++
        else delta.shadowedByHistorical++
      } else if (live.redirectsEffective) {
        const rules = await ctx.db
          .query("redirects")
          .withIndex("by_locale_fromPath", (q) =>
            q.eq("locale", migration.toLocale).eq("fromPath", fromPath)
          )
          .take(1)
        if (rules.length) {
          row.manualRule = "shadowed"
          delta.manualRulesShadowed++
        }
      }
      rows.push(row)
      planned.add(fromPath)
      delta.rows++
    }
  }
  const eligibleSource = async (item: QueuedClaim) => {
    if ("rule" in item) return true
    if (
      utf8ByteLength(item.fromPath) > DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES
    ) {
      items.push({
        kind: "route_path_too_long",
        pageId: item.pageId,
        fromPath: item.fromPath,
        origin: item.origin,
        code: "DEFAULT_MIGRATION_ROUTE_PATH_TOO_LONG",
      })
      delta.blockers++
      return false
    }
    if (
      (phase === "old_default_current" || phase === "old_default_historical") &&
      (await addressPageLifecycle(ctx, item.pageId, cache)).lifecycleState ===
        "trashed"
    )
      return false
    if (
      planned.has(item.fromPath) ||
      (await existingRoute(ctx, migration, item.fromPath))
    ) {
      if (item.origin === "carried") delta.carriedShadowedSkipped++
      return false
    }
    return true
  }
  type ClaimRow =
    Doc<"pageLocalePublicationStates"> | Doc<"pageHistoricalLocaleRoutes">
  const heldCount = async (rows: ClaimRow[], kind: ClaimScan["bucket"]) => {
    let held = 0
    for (const row of rows) {
      if ("releasedAt" in row && row.releasedAt !== undefined) continue
      if (
        kind === "current" &&
        !(
          "hasCurrentSnapshot" in row &&
          row.hasCurrentSnapshot &&
          row.currentSnapshotId
        )
      )
        continue
      if (
        (await addressPageLifecycle(ctx, row.pageId, cache)).lifecycleState !==
        "trashed"
      )
        held++
      if (held > 1) inconsistent()
    }
    return held
  }
  const pending = cursor.claims
  if (!pending) return { kind: "restart" }
  const { queue, sourceDone } = pending
  if (!pending.scan) {
    // Empty/singleton buckets finish cheaply; only dense buckets need a
    // resumable exact scan. Eight sparse candidates still leave headroom.
    for (let next = 0; next < Math.min(queue.length, 8); next++) {
      const item = queue[next]!
      if (!(await eligibleSource(item))) continue
      const fromPath = "rule" in item ? item.rule.fromPath : item.fromPath
      const current = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_locale_and_currentPath", (q) =>
          q.eq("locale", migration.toLocale).eq("currentPath", fromPath)
        )
        .take(2)
      if (current.length === 2)
        return finish({
          queue: queue.slice(next),
          sourceDone,
          scan: { bucket: "current", page: null, seen: 0, held: 0 },
        })
      if (await heldCount(current, "current")) {
        await emit(item, "to_current")
        continue
      }
      const history = await ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", migration.toLocale).eq("fromPath", fromPath)
        )
        .take(2)
      if (history.length === 2)
        return finish({
          queue: queue.slice(next),
          sourceDone,
          scan: { bucket: "historical", page: null, seen: 0, held: 0 },
        })
      await emit(
        item,
        (await heldCount(history, "historical")) ? "to_historical" : undefined
      )
      if (reserveCrossed(await defaultMigrationSeam.metrics(ctx)))
        return { kind: "halve" }
    }
    return finish(
      queue.length > 8 ? { queue: queue.slice(8), sourceDone } : undefined,
      cursor.page,
      sourceDone
    )
  }
  const item = queue[0]!,
    fromPath = "rule" in item ? item.rule.fromPath : item.fromPath
  const complete = () =>
    finish(
      queue.length > 1 ? { queue: queue.slice(1), sourceDone } : undefined,
      cursor.page,
      sourceDone
    )
  if (!(await eligibleSource(item))) return complete()
  const scan = pending.scan
  const options = { numItems: Math.min(size, 16), cursor: scan.page }
  let page: PaginationResult<ClaimRow>
  try {
    page =
      scan.bucket === "current"
        ? await defaultMigrationSeam.paginate(
            ctx.db
              .query("pageLocalePublicationStates")
              .withIndex("by_locale_and_currentPath", (q) =>
                q.eq("locale", migration.toLocale).eq("currentPath", fromPath)
              ),
            options
          )
        : await defaultMigrationSeam.paginate(
            ctx.db
              .query("pageHistoricalLocaleRoutes")
              .withIndex("by_locale_and_fromPath", (q) =>
                q.eq("locale", migration.toLocale).eq("fromPath", fromPath)
              ),
            options
          )
  } catch {
    return { kind: "restart" }
  }
  if (page.pageStatus === "SplitRequired") return { kind: "halve" }
  let held = scan.held
  const seen = scan.seen + page.page.length
  if (seen > 100) fail("PAGE_ADDRESS_LOOKUP_LIMIT")
  held += await heldCount(page.page, scan.bucket)
  if (held > 1) inconsistent()
  if (reserveCrossed(await defaultMigrationSeam.metrics(ctx)))
    return { kind: "halve" }
  if (!page.isDone)
    return finish({
      queue,
      sourceDone,
      scan: { ...scan, page: page.continueCursor, seen, held },
    })
  if (!held && scan.bucket === "current")
    return finish({
      queue,
      sourceDone,
      scan: { bucket: "historical", page: null, seen: 0, held: 0 },
    })
  const shadow = held
    ? scan.bucket === "current"
      ? ("to_current" as const)
      : ("to_historical" as const)
    : undefined
  await emit(item, shadow)
  return complete()
}

/** Reads the page, then checks metrics after it and after every item (S6). */
async function readPhasePage(
  ctx: MutationCtx,
  migration: DefaultMigration,
  live: LiveMigrationState,
  phase: Exclude<DefaultMigrationCursorPhase, "validation">,
  cursor: MigrationCursor,
  size: number
): Promise<Batch> {
  if (
    phase === "old_default_current" ||
    phase === "old_default_historical" ||
    phase === "carried" ||
    phase === "new_default_manual_rules"
  )
    return readClaimStep(ctx, migration, live, phase, cursor, size)
  const from = migration.fromLocale
  const numItems = phase === "menus" ? 1 : size
  const options = { numItems, cursor: cursor.page }
  const items: DisclosureItem[] = []
  const rows: PlannedRow[] = []
  const delta = { ...NO_DEFAULT_MIGRATION_COUNTS }
  let menuCursor: PreviewCursor["menu"]

  const guard = async <T>(
    read: () => Promise<PaginationResult<T>>
  ): Promise<PaginationResult<T> | Batch> => {
    let result: PaginationResult<T>
    try {
      result = await read()
    } catch {
      // A cursor that no longer resumes restarts the generation (M14).
      return { kind: "restart" }
    }
    if (result.page.length > numItems) return { kind: "restart" }
    if (result.pageStatus === "SplitRequired") {
      return numItems <= 1 ? { kind: "restart" } : { kind: "halve" }
    }
    if (reserveCrossed(await defaultMigrationSeam.metrics(ctx))) {
      return { kind: "halve" }
    }
    return result
  }
  const afterItem = async () =>
    reserveCrossed(await defaultMigrationSeam.metrics(ctx))

  let isDone: boolean
  let continueCursor: string
  switch (phase) {
    case "old_default_manual_rules": {
      const scope = from
      const result = await guard(() =>
        defaultMigrationSeam.paginate(
          ctx.db
            .query("redirects")
            .withIndex("by_locale_fromPath", (q) => q.eq("locale", scope)),
          options
        )
      )
      if ("kind" in result) return result
      for (const rule of result.page) {
        const base = {
          kind: "manual_rule" as const,
          ruleId: rule._id,
          fromPath: rule.fromPath,
          destination: ruleDestination(rule),
          statusCode: rule.statusCode,
        }
        if (phase === "old_default_manual_rules") {
          // Reachable at `/p` only while nothing served claimed `p`.
          if (!(await existingRoute(ctx, migration, rule.fromPath))) {
            items.push({
              ...base,
              status: "shifted",
              newVisiblePath: localePrefixed(from, rule.fromPath),
            })
            delta.manualRulesShifted += 1
          }
        }
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
    case "menus": {
      const result = await guard(() =>
        defaultMigrationSeam.paginate(
          ctx.db.query("menus").withIndex("by_slug"),
          options
        )
      )
      if ("kind" in result) return result
      for (const menu of result.page) {
        if (menu.deletedAt !== undefined) continue
        const paths = menuNodePathsMissingRequiredText(
          menu.nav,
          migration.toLocale
        )
        if (paths.length === 0) continue
        const blockers = menuBlockers(menu, paths.slice(0, size))
        items.push(...blockers)
        delta.blockers += blockers.length
        if (paths.length > size) menuCursor = { menuId: menu._id, next: size }
        if (await afterItem()) return { kind: "halve" }
      }
      ;({ isDone, continueCursor } = result)
      break
    }
  }

  if (menuCursor) {
    return {
      kind: "items",
      items,
      rows,
      delta,
      cursor: {
        page: continueCursor,
        ...(isDone ? { done: true as const } : {}),
        menu: menuCursor,
      },
    }
  }
  return {
    kind: "items",
    items,
    rows,
    delta,
    cursor: isDone
      ? "phase_done"
      : { page: continueCursor, ...(cursor.f09 ? { f09: true as const } : {}) },
  }
}

// ─── Menus ──────────────────────────────────────────────────────────────────

/**
 * Menu nodes where `validateCanonicalMenu` requires default-language text and
 * `locale` has none, in the preview's walk order: item, then each panel and
 * footer block, then that block's links (contract Default migration step 3).
 */
export function menuNodePathsMissingRequiredText(
  nav: readonly NavItem[],
  locale: string
): string[] {
  const paths: string[] = []
  for (const item of nav) {
    if (!hasLocaleText(item.label, locale)) paths.push(item.id)
    const blocks = panelBlocks(item.panel).map((entry) => entry.block)
    for (const block of blocks) {
      const blockPath = `${item.id}/${block.id}`
      const missing =
        block.kind === "linkGroup"
          ? block.heading !== undefined && !hasLocaleText(block.heading, locale)
          : block.kind === "dynamicList"
            ? (block.heading !== undefined &&
                !hasLocaleText(block.heading, locale)) ||
              (block.seeAll !== undefined &&
                !hasLocaleText(block.seeAll.label, locale))
            : !hasLocaleText(block.heading, locale) ||
              (block.image !== undefined &&
                !hasLocaleText(block.image.alt, locale, true)) ||
              (block.link !== undefined &&
                !hasLocaleText(block.link.label, locale))
      if (missing) paths.push(blockPath)
      if (block.kind !== "linkGroup") continue
      for (const link of block.links) {
        if (!hasLocaleText(link.label, locale)) {
          paths.push(`${blockPath}/${link.id}`)
        }
      }
    }
  }
  return paths
}

function menuBlockers(
  menu: Doc<"menus">,
  paths: readonly string[]
): DisclosureItem[] {
  return paths.map((nodePath) => ({
    kind: "menu_blocker",
    menuId: menu._id,
    menuName: menu.slug,
    nodePath,
    code: "DEFAULT_MIGRATION_MENU_TEXT_MISSING",
  }))
}

/** Continues inside one menu by id; issues no paginated query (S10). */
async function resumeMenu(
  ctx: MutationCtx,
  migration: DefaultMigration,
  cursor: MigrationCursor,
  size: number
): Promise<Batch> {
  const position = cursor.menu!
  const menu = await ctx.db.get(position.menuId)
  // A menu write advances a captured counter, so a missing menu here means the
  // walk no longer resumes.
  if (!menu || menu.deletedAt !== undefined) return { kind: "restart" }
  const paths = menuNodePathsMissingRequiredText(menu.nav, migration.toLocale)
  if (position.next >= paths.length) return { kind: "restart" }
  if (reserveCrossed(await defaultMigrationSeam.metrics(ctx))) {
    return { kind: "halve" }
  }
  const end = position.next + size
  const items = menuBlockers(menu, paths.slice(position.next, end))
  const delta = { ...NO_DEFAULT_MIGRATION_COUNTS, blockers: items.length }
  const { size: _halved, menu: _menu, ...rest } = cursor
  void _halved
  void _menu
  if (end < paths.length) {
    return {
      kind: "items",
      items,
      rows: [],
      delta,
      cursor: { ...rest, menu: { menuId: menu._id, next: end } },
    }
  }
  return {
    kind: "items",
    items,
    rows: [],
    delta,
    cursor: rest.done ? "phase_done" : { page: rest.page },
  }
}

// ─── Listing and review ─────────────────────────────────────────────────────

const REVIEWABLE_PHASES: ReadonlySet<DefaultMigration["phase"]> = new Set([
  "validating",
  "ready",
])

/**
 * The generation is still the live, fully enumerated corpus: the authority
 * names it, it is reviewable, and the captured tokens have not moved.
 */
async function isCurrentCorpus(
  ctx: Ctx,
  migration: DefaultMigration,
  generation: number
): Promise<boolean> {
  if (
    !REVIEWABLE_PHASES.has(migration.phase) ||
    migration.generation !== generation
  ) {
    return false
  }
  const live = await readLiveMigrationState(ctx, migration.toLocale)
  return (
    live.tokens !== null &&
    namesMigration(live.state, migration) &&
    migrationTokensEqual(live.tokens, migration.captured)
  )
}

async function readDisclosurePage(
  ctx: Ctx,
  migration: DefaultMigration,
  ordinal: number
): Promise<Doc<"siteLanguageDisclosurePages">> {
  const pages = await ctx.db
    .query("siteLanguageDisclosurePages")
    .withIndex("by_migrationId_and_generation_and_ordinal", (q) =>
      q
        .eq("migrationId", migration._id)
        .eq("generation", migration.generation)
        .eq("ordinal", ordinal)
    )
    .take(2)
  if (pages.length !== 1) fail("LANGUAGE_PREVIEW_STATE_INVALID")
  return pages[0]!
}

export type DefaultMigrationDisclosureListing =
  | { stale: true }
  | {
      stale: false
      ordinal: number
      pageCount: number
      section: DisclosureSection
      items: DisclosureItem[]
      digest: string
    }

/** One disclosure page of the generation (M16). */
export async function listDefaultMigrationDisclosurePage(
  ctx: Ctx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  generation: number,
  ordinal: number
): Promise<DefaultMigrationDisclosureListing> {
  const migration = await ctx.db.get(migrationId)
  if (!migration) fail("LANGUAGE_PREVIEW_MISMATCH")
  if (!(await isCurrentCorpus(ctx, migration, generation))) {
    return { stale: true }
  }
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal >= migration.disclosurePageCount
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const page = await readDisclosurePage(ctx, migration, ordinal)
  return {
    stale: false,
    ordinal,
    pageCount: migration.disclosurePageCount,
    section: page.section,
    items: page.items,
    digest: page.digest,
  }
}

export type DefaultMigrationReceipt =
  | { stale: true }
  | { stale: false; reviewedThroughOrdinal: number; pageCount: number }

/**
 * Advances the generation's review receipt by exactly one page (M16). A moved
 * token, another generation or a migration that is not reviewable returns
 * `{stale: true}` and records nothing; an out-of-order ordinal or a wrong
 * digest refuses.
 */
export async function recordDefaultMigrationReviewInTransaction(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  expectedGeneration: number,
  ordinal: number,
  pageDigest: string
): Promise<DefaultMigrationReceipt> {
  const migration = await ctx.db.get(migrationId)
  if (!migration) fail("LANGUAGE_PREVIEW_MISMATCH")
  if (!(await isCurrentCorpus(ctx, migration, expectedGeneration))) {
    return { stale: true }
  }
  if (
    ordinal !== migration.reviewedThroughOrdinal + 1 ||
    ordinal >= migration.disclosurePageCount
  ) {
    fail("LANGUAGE_PREVIEW_MISMATCH")
  }
  const page = await readDisclosurePage(ctx, migration, ordinal)
  if (page.digest !== pageDigest) fail("LANGUAGE_PREVIEW_MISMATCH")
  await ctx.db.patch(migrationId, {
    reviewedThroughOrdinal: ordinal,
    updatedAt: Date.now(),
  })
  return {
    stale: false,
    reviewedThroughOrdinal: ordinal,
    pageCount: migration.disclosurePageCount,
  }
}

// ─── Silent default change (U2) ─────────────────────────────────────────────

export type SetDefaultLanguageArgs = StartDefaultMigrationArgs

export type SetDefaultLanguageResult =
  | { ok: true; authorityVersion: number }
  | { ok: false; code: "SITE_LANGUAGE_VERSION_CHANGED" }

/**
 * ADR-0053 amendment 2026-11-02 (owner: "setting default locale only changes
 * how pages url are handled by proxy.ts"; "this should happen silently and
 * automatically"). One transaction, no migration, no route rows. It changes
 * the authority and settings default, moves the legacy site description to the
 * outgoing default, and inserts one `default_change` lifecycle intent.
 * Refusal order is contract C2; every refusal writes nothing. Owner
 * 2026-11-02: publication readiness does not gate the switch (the default
 * language only decides which public URLs are unprefixed), so a new default
 * language needs no published home. A stale token is an expected refusal
 * and returns a structured result before the first write.
 */
export async function setDefaultLanguageInTransaction(
  ctx: MutationCtx,
  args: SetDefaultLanguageArgs
): Promise<SetDefaultLanguageResult> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const { toLocale } = args
  const { state, tokens } = await readLiveMigrationState(ctx, toLocale)
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual" || !tokens) {
    fail("MULTILINGUAL_NOT_ADOPTED")
  }
  if (
    tokens.authorityVersion !== args.expectedAuthorityVersion ||
    tokens.moduleConfigurationVersion !==
      args.expectedModuleConfigurationVersion
  ) {
    return { ok: false, code: "SITE_LANGUAGE_VERSION_CHANGED" }
  }
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(toLocale)) {
    fail("LOCALE_UNSUPPORTED")
  }
  if (!state.locales.includes(toLocale)) fail("LOCALE_NOT_ENABLED")
  if (toLocale === state.locale) fail("LOCALE_IS_DEFAULT")

  const now = Date.now()
  const version = state.version + 1
  const fromLocale = state.locale
  await ctx.db.patch(state.authority._id, {
    currentLocale: toLocale,
    version,
    updatedAt: now,
  })
  await ctx.db.patch(state.settings._id, {
    defaultLocale: toLocale,
    // M05 A5: the legacy single description is stored under the outgoing
    // default language in this same commit, so the change never relabels it.
    ...storeLegacySiteDescription(state.settings, fromLocale),
    updatedAt: now,
  })
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `default_change:v${version}`,
    operationKind: "default_change",
    locales: [fromLocale, toLocale],
    capturedAuthorityVersion: version,
  })
  return { ok: true, authorityVersion: version }
}
