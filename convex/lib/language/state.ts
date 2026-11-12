import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"

/**
 * F09 single public-language authority, widened by M05 with the multilingual
 * dialect. The required `language` module owns `siteLanguageAuthority` and the
 * transition tables; every function here is a bounded point reader or a
 * same-transaction writer.
 */
type LanguageCtx = QueryCtx | MutationCtx

export const SITE_LANGUAGE_AUTHORITY_KEY = "site-language-v1" as const
export const MULTILINGUAL_MODULE_ID = "multilingual" as const

export type Transition = Doc<"siteLanguageTransitions">
export type TransitionPage = Doc<"siteLanguageTransitionPages">
export type DefaultMigration = Doc<"siteDefaultLanguageMigrations">

/** Phases in which a transition still holds `activeTransitionId`. */
export const OPEN_TRANSITION_PHASES: ReadonlySet<Transition["phase"]> = new Set(
  ["enumerating", "preparing", "validating", "ready", "cancelling"]
)

/** Default-migration phases that still hold `activeDefaultMigrationId`. */
export const OPEN_DEFAULT_MIGRATION_PHASES: ReadonlySet<
  DefaultMigration["phase"]
> = new Set(["enumerating", "validating", "ready"])

/** Phases in which the hidden target locale may still be prepared. */
export const PREPARABLE_TRANSITION_PHASES: ReadonlySet<Transition["phase"]> =
  new Set(["enumerating", "preparing", "validating", "ready"])

export type SiteLanguageState =
  | { kind: "invalid" }
  | {
      kind: "uninitialized"
      version: 0
      locale: string
      settings: Doc<"siteSettings">
    }
  | {
      kind: "multi_locale"
      version: 0
      locales: readonly string[]
      settings: Doc<"siteSettings">
    }
  | {
      kind: "current"
      version: number
      locale: string
      settings: Doc<"siteSettings">
      authority: Doc<"siteLanguageAuthority">
    }
  | {
      /** M05 M1. `locale` is the default (unprefixed) language. */
      kind: "multilingual"
      version: number
      locale: string
      locales: readonly string[]
      settings: Doc<"siteSettings">
      authority: Doc<"siteLanguageAuthority">
    }

function sameLocales(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && a.every((locale, index) => locale === b[index])
  )
}

/**
 * Pure classification. Missing or duplicate settings, a malformed enabled set,
 * duplicate authority rows, an authority row on a multi-locale install, or a
 * `currentLocale` that disagrees with settings are all invalid. An absent row
 * is version 0 compatibility, never an error.
 *
 * A row with `mode: "multilingual"` classifies only under every M05 M1
 * condition, including an enabled `multilingual` module; the caller supplies
 * that fact, and reads it only for such a row (M2 exception 3). Any other
 * shape of the widened fields is invalid, including a `current` row naming a
 * default migration. `continuityPointer` is valid in every mode (M24).
 */
export function classifySiteLanguageState(
  settingsRows: readonly Doc<"siteSettings">[],
  authorityRows: readonly Doc<"siteLanguageAuthority">[],
  multilingualModuleEnabled = false
): SiteLanguageState {
  if (settingsRows.length !== 1 || authorityRows.length > 1) {
    return { kind: "invalid" }
  }
  const settings = settingsRows[0]!
  const enabled = settings.enabledLocales ?? []
  if (
    enabled.length === 0 ||
    new Set(enabled).size !== enabled.length ||
    !enabled.includes(settings.defaultLocale)
  ) {
    return { kind: "invalid" }
  }
  const authority = authorityRows[0]
  if (!authority) {
    return enabled.length === 1
      ? {
          kind: "uninitialized",
          version: 0,
          locale: settings.defaultLocale,
          settings,
        }
      : { kind: "multi_locale", version: 0, locales: enabled, settings }
  }
  if (authority.mode === "multilingual") {
    return classifyMultilingual(settings, authority, multilingualModuleEnabled)
  }
  if (
    authority.enabledLocales !== undefined ||
    authority.activeDefaultMigrationId !== undefined ||
    enabled.length !== 1 ||
    authority.currentLocale !== settings.defaultLocale ||
    enabled[0] !== authority.currentLocale ||
    !Number.isSafeInteger(authority.version) ||
    authority.version < 1
  ) {
    return { kind: "invalid" }
  }
  return {
    kind: "current",
    version: authority.version,
    locale: authority.currentLocale,
    settings,
    authority,
  }
}

function classifyMultilingual(
  settings: Doc<"siteSettings">,
  authority: Doc<"siteLanguageAuthority">,
  moduleEnabled: boolean
): SiteLanguageState {
  const locales = authority.enabledLocales
  if (
    !moduleEnabled ||
    !Number.isSafeInteger(authority.version) ||
    authority.version < 1 ||
    !locales ||
    locales.length === 0 ||
    new Set(locales).size !== locales.length ||
    !locales.every((locale) =>
      (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    ) ||
    !locales.includes(authority.currentLocale) ||
    !sameLocales(settings.enabledLocales ?? [], locales) ||
    settings.defaultLocale !== authority.currentLocale ||
    authority.activeTransitionId !== undefined
  ) {
    return { kind: "invalid" }
  }
  return {
    kind: "multilingual",
    version: authority.version,
    locale: authority.currentLocale,
    locales,
    settings,
    authority,
  }
}

/**
 * Whether the owner configuration enables `multilingual`. A bounded point
 * read; a missing or duplicated configuration row reads as not enabled, which
 * classifies a multilingual row invalid (fail closed).
 */
export async function readMultilingualModuleEnabled(
  ctx: LanguageCtx
): Promise<boolean> {
  const rows = await ctx.db
    .query("cmsModuleState")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  return (
    rows.length === 1 &&
    rows[0]!.enabledModules.some(
      (entry) => entry.moduleId === MULTILINGUAL_MODULE_ID
    )
  )
}

export async function readAuthorityRows(
  ctx: LanguageCtx
): Promise<Doc<"siteLanguageAuthority">[]> {
  return ctx.db
    .query("siteLanguageAuthority")
    .withIndex("by_key", (q) => q.eq("key", SITE_LANGUAGE_AUTHORITY_KEY))
    .take(2)
}

export async function readSiteLanguageState(
  ctx: LanguageCtx
): Promise<SiteLanguageState> {
  const [settingsRows, authorityRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
  ])
  // M2 exception 3: module state is read only for a stored multilingual row.
  const multilingualModuleEnabled =
    authorityRows.length === 1 && authorityRows[0]!.mode === "multilingual"
      ? await readMultilingualModuleEnabled(ctx)
      : false
  return classifySiteLanguageState(
    settingsRows,
    authorityRows,
    multilingualModuleEnabled
  )
}

export type PublicSiteLanguageState =
  | Exclude<SiteLanguageState, { kind: "invalid" }>
  | { kind: "unconfigured"; version: 0 }

/** Public language facts; an F09 transition target is never public. */
export function publicLocaleEligibility(state: PublicSiteLanguageState): {
  defaultLocale: string | null
  publicLocales: readonly string[]
} {
  switch (state.kind) {
    case "unconfigured":
      return { defaultLocale: null, publicLocales: [] }
    case "uninitialized":
    case "current":
      return { defaultLocale: state.locale, publicLocales: [state.locale] }
    case "multi_locale":
      return {
        defaultLocale: state.settings.defaultLocale,
        publicLocales: state.locales,
      }
    case "multilingual":
      return { defaultLocale: state.locale, publicLocales: state.locales }
  }
}

/**
 * Public reads retain the pre-onboarding F08 envelope: before either singleton
 * exists there is no language release to mix, so the request is version 0.
 * Once either singleton exists, the full persisted-tuple integrity rules apply.
 */
export async function readPublicSiteLanguageState(
  ctx: LanguageCtx
): Promise<PublicSiteLanguageState> {
  const state = await readSiteLanguageState(ctx)
  if (state.kind !== "invalid") return state

  const [settingsRows, authorityRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
  ])
  if (settingsRows.length === 0 && authorityRows.length === 0) {
    return { kind: "unconfigured", version: 0 }
  }
  throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
}

/**
 * Pin one anonymous public read to the language authority version selected by
 * its caller. Convex queries are transactional, so one assertion at the public
 * function boundary covers every nested projection in that query snapshot.
 *
 * Version 0 is the explicit compatibility version for installations that do
 * not yet have a language-authority row. Invalid authority never masquerades
 * as a version change: callers need the distinct integrity failure.
 */
export async function assertPublicLanguageVersion(
  ctx: LanguageCtx,
  expectedVersion: number
): Promise<PublicSiteLanguageState> {
  const state = await readPublicSiteLanguageState(ctx)
  if (state.version !== expectedVersion) {
    throw new ConvexError("SITE_LANGUAGE_VERSION_CHANGED")
  }
  return state
}

/** The open transition named by the authority row, validated, or null. */
export async function readOpenTransition(
  ctx: LanguageCtx,
  state: SiteLanguageState
): Promise<Transition | null> {
  if (state.kind !== "current" || !state.authority.activeTransitionId) {
    return null
  }
  const transition = await ctx.db.get(state.authority.activeTransitionId)
  if (
    !transition ||
    !OPEN_TRANSITION_PHASES.has(transition.phase) ||
    transition.sourceLocale !== state.locale
  ) {
    throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return transition
}

/**
 * The open default migration named by a multilingual authority, or null
 * (M6). No read unless the authority names one; a named row that is missing,
 * no longer open or migrating from another language is invalid state, and
 * nothing is repaired (M5).
 */
export async function readOpenDefaultMigration(
  ctx: LanguageCtx,
  state: SiteLanguageState
): Promise<DefaultMigration | null> {
  if (
    state.kind !== "multilingual" ||
    !state.authority.activeDefaultMigrationId
  ) {
    return null
  }
  const migration = await ctx.db.get(state.authority.activeDefaultMigrationId)
  if (
    !migration ||
    !OPEN_DEFAULT_MIGRATION_PHASES.has(migration.phase) ||
    migration.fromLocale !== state.locale
  ) {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  return migration
}

/**
 * Invariant 3 for ordinary commands: only the current language is accepted.
 * With no authority row the F08 enabled-locale gate stays in force (version 0
 * compatibility); a multilingual authority accepts any enabled language;
 * missing settings or invalid authority fail closed.
 */
export async function assertOrdinaryLocale(
  ctx: LanguageCtx,
  locale: string,
  code = "LOCALE_NOT_ENABLED"
): Promise<Exclude<SiteLanguageState, { kind: "invalid" }>> {
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  const accepted =
    state.kind === "current"
      ? locale === state.locale
      : state.kind === "multilingual"
        ? state.locales.includes(locale)
        : state.settings.enabledLocales.includes(locale)
  if (!accepted) throw new ConvexError(code)
  return state
}

export type ReleaseHoldCode = "LOCALE_NOT_ENABLED" | "LANGUAGE_VERSION_CHANGED"

/**
 * The language fields a delayed release or expiry captures when it is armed.
 * M07 adds `capturedLanguageVersion`; a row without it cannot prove the
 * version it was armed under.
 */
export type ReleaseExecutionRow = Readonly<{
  locale: string
  capturedLanguageVersion?: number
}>

/**
 * M05 delayed-work eligibility (contract Delayed work, M18; F09 invariant 16).
 * Returns `null` when the row may execute, otherwise its hold code. It never
 * writes, so a hold changes no visibility; the executor records `held` and
 * keeps its own F08 generation checks. A multilingual authority needs only the
 * locale enabled: an add, another language's removal, a default change and
 * the captured version leave locale-relative paths valid. A single or
 * version-0 authority needs the ordinary locale, then the captured version,
 * so a row with none holds. Invalid state refuses (M5).
 */
export async function assertReleaseExecutionEligible(
  ctx: LanguageCtx,
  row: ReleaseExecutionRow
): Promise<ReleaseHoldCode | null> {
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  if (state.kind === "multilingual") {
    return state.locales.includes(row.locale) ? null : "LOCALE_NOT_ENABLED"
  }
  const enabled =
    state.kind === "current"
      ? row.locale === state.locale
      : state.settings.enabledLocales.includes(row.locale)
  if (!enabled) return "LOCALE_NOT_ENABLED"
  return row.capturedLanguageVersion === state.version
    ? null
    : "LANGUAGE_VERSION_CHANGED"
}

export type DraftLocaleEligibility =
  { kind: "ordinary" } | { kind: "target"; transition: Transition }

/**
 * `saveLocaleDraft` / `discardLocaleDraft` widened eligibility: the current
 * language, or the open transition's target while it can still be prepared.
 * A multilingual authority has no target arm: any enabled language is
 * ordinary.
 */
export async function resolveDraftLocaleEligibility(
  ctx: LanguageCtx,
  locale: string
): Promise<DraftLocaleEligibility> {
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  if (state.kind === "multilingual") {
    if (state.locales.includes(locale)) return { kind: "ordinary" }
    throw new ConvexError("LOCALE_NOT_ENABLED")
  }
  if (state.kind !== "current") {
    if (state.settings.enabledLocales.includes(locale)) {
      return { kind: "ordinary" }
    }
    throw new ConvexError("LOCALE_NOT_ENABLED")
  }
  if (locale === state.locale) return { kind: "ordinary" }
  const transition = await readOpenTransition(ctx, state)
  if (
    transition &&
    transition.targetLocale === locale &&
    PREPARABLE_TRANSITION_PHASES.has(transition.phase)
  ) {
    return { kind: "target", transition }
  }
  throw new ConvexError("LOCALE_NOT_ENABLED")
}

/**
 * The one Language-domain conflict check shared by start and activation. It
 * is a direct check, not a registry. M05 (M6) refuses while the
 * `multilingual` module is enabled, whatever its readiness or the authority
 * mode. Both callers require a `current` authority, which the classifier
 * already refuses when it names a default migration, so no separate
 * `activeDefaultMigrationId` probe runs here (ledger C3a). M07 adds its expiry
 * probe.
 */
export async function assertNoLanguageTransitionConflicts(
  ctx: LanguageCtx
): Promise<void> {
  if (await readMultilingualModuleEnabled(ctx)) {
    throw new ConvexError("LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED")
  }
  const probes = await Promise.all(
    (["pending", "held"] as const).map((status) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_status_and_executeAt", (q) => q.eq("status", status))
        .take(1)
    )
  )
  if (probes.some((rows) => rows.length > 0)) {
    throw new ConvexError("LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS")
  }
}

type Counters = Pick<
  Transition,
  | "pageCount"
  | "targetCount"
  | "withdrawCount"
  | "redirectCount"
  | "unresolvedCount"
  | "blockedCount"
>

function contribution(
  row: Pick<TransitionPage, "disposition" | "status"> | null
): Counters {
  if (!row) {
    return {
      pageCount: 0,
      targetCount: 0,
      withdrawCount: 0,
      redirectCount: 0,
      unresolvedCount: 0,
      blockedCount: 0,
    }
  }
  return {
    pageCount: 1,
    targetCount: row.disposition === "target" ? 1 : 0,
    withdrawCount: row.disposition === "withdraw" ? 1 : 0,
    redirectCount: row.disposition === "redirect" ? 1 : 0,
    unresolvedCount: row.status === "unready" || row.status === "stale" ? 1 : 0,
    blockedCount: row.status === "blocked" ? 1 : 0,
  }
}

/** Counter point-write for one transition page status or disposition change. */
export function countersAfter(
  transition: Counters,
  before: Pick<TransitionPage, "disposition" | "status"> | null,
  after: Pick<TransitionPage, "disposition" | "status"> | null
): Counters {
  const b = contribution(before)
  const a = contribution(after)
  const next = {} as Counters
  for (const key of Object.keys(b) as Array<keyof Counters>) {
    next[key] = transition[key] - b[key] + a[key]
    if (next[key] < 0)
      throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return next
}

/** A `ready` or `validating` transition returns to `preparing`. */
export function reopenPatch(transition: Transition): Partial<Transition> {
  if (transition.phase !== "ready" && transition.phase !== "validating") {
    return {}
  }
  return {
    phase: "preparing",
    cursorPhase: undefined,
    cursor: undefined,
    generation: transition.generation + 1,
  }
}

/** Arms C3e.2 reconciliation only after the initial carry digest exists. */
function carryReconcilePatch(transition: Transition): Partial<Transition> {
  if (
    transition.carryDecisionDigest === undefined ||
    (transition.phase !== "preparing" &&
      transition.phase !== "ready" &&
      transition.phase !== "validating")
  ) {
    return {}
  }
  return { cursorPhase: "carry_reconcile", cursor: undefined }
}

export type SourcePageDescription = {
  kind: TransitionPage["kind"]
  source: TransitionPage["source"]
  disposition: TransitionPage["disposition"]
  status: TransitionPage["status"]
}

/**
 * Classifies one Page's source-locale state for a transition page row. Returns
 * null when the Page has neither a source selection nor, in correction mode, a
 * source Working Draft or draft base.
 */
export async function describeSourcePage(
  ctx: LanguageCtx,
  transition: Pick<Transition, "mode" | "sourceLocale">,
  pageId: Id<"pages">
): Promise<SourcePageDescription | null> {
  const [pageStates, localeStates, drafts] = await Promise.all([
    ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .take(2),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", transition.sourceLocale)
      )
      .take(2),
    ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", transition.sourceLocale)
      )
      .take(2),
  ])
  if (pageStates.length !== 1 || localeStates.length > 1 || drafts.length > 1) {
    throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  const localeState = localeStates[0]
  const source = {
    ...(localeState?.currentSnapshotId
      ? { snapshotId: localeState.currentSnapshotId }
      : {}),
    publicGeneration: localeState?.publicGeneration ?? 0,
    ...(localeState?.currentPath !== undefined
      ? { path: localeState.currentPath }
      : {}),
    draftGeneration: localeState?.draftGeneration ?? 0,
  }
  if (localeState?.hasCurrentSnapshot && localeState.currentSnapshotId) {
    if (pageStates[0]!.lifecycleState !== "active") {
      return {
        kind: "hidden_selection",
        source,
        disposition: "withdraw",
        status: "ready",
      }
    }
    return {
      kind:
        localeState.currentPath !== undefined
          ? "public_route"
          : "public_non_routable",
      source,
      disposition: transition.mode === "correct_label" ? "target" : "undecided",
      status: "unready",
    }
  }
  if (
    transition.mode === "correct_label" &&
    (drafts.length === 1 || localeState?.draftBaseSnapshotId)
  ) {
    // A private draft never gets a target selection; preparation copies the
    // draft privately, so "no target selection" is its only disposition.
    return {
      kind: "private_draft",
      source,
      disposition: "withdraw",
      status: "unready",
    }
  }
  return null
}

export async function readTransitionPage(
  ctx: LanguageCtx,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">
): Promise<TransitionPage | null> {
  const rows = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_transitionId_and_pageId", (q) =>
      q.eq("transitionId", transitionId).eq("pageId", pageId)
    )
    .take(2)
  if (rows.length > 1)
    throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  return rows[0] ?? null
}

async function readActiveTransitionForWrite(
  ctx: MutationCtx,
  authorityRows?: Doc<"siteLanguageAuthority">[]
): Promise<Transition | null> {
  const rows = authorityRows ?? (await readAuthorityRows(ctx))
  if (rows.length === 0) return null
  if (rows.length !== 1)
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  const activeId = rows[0]!.activeTransitionId
  if (!activeId) return null
  const transition = await ctx.db.get(activeId)
  if (!transition || !OPEN_TRANSITION_PHASES.has(transition.phase)) {
    throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return transition
}

/**
 * Invariant 6 freshness helper. Every successor write that changes source
 * public state calls it in its own transaction. With no open transition it is
 * one point read. Otherwise it advances `sourcePublicSetVersion`, returns a
 * `ready`/`validating` transition to `preparing`, and for a Page-scoped write
 * stales that Page's row or inserts an `unready` row when none exists. During
 * `cancelling` only the counter moves, so preparation cannot be revived.
 * Call sites use `recordPublicChange` (M05 recording seam), which passes the
 * authority rows it has already read.
 */
export async function recordSourcePublicChange(
  ctx: MutationCtx,
  pageId?: Id<"pages">,
  authorityRows?: Doc<"siteLanguageAuthority">[]
): Promise<void> {
  const transition = await readActiveTransitionForWrite(ctx, authorityRows)
  if (!transition) return
  const now = Date.now()
  let counters: Counters = transition
  if (pageId && transition.phase !== "cancelling") {
    const existing = await readTransitionPage(ctx, transition._id, pageId)
    if (existing) {
      const keepBlocked =
        existing.status === "blocked" &&
        existing.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT"
      if (!keepBlocked) {
        const description = await describeSourcePage(ctx, transition, pageId)
        const next = {
          ...(description &&
          (existing.kind === "hidden_selection" ||
            description.kind === "hidden_selection")
            ? {
                kind: description.kind,
                disposition: description.disposition,
              }
            : {}),
          ...(description ? { source: description.source } : {}),
          status: "stale" as const,
          blockerCode: undefined,
          generation: existing.generation + 1,
          updatedAt: now,
        }
        counters = countersAfter(counters, existing, {
          disposition: next.disposition ?? existing.disposition,
          status: next.status,
        })
        await ctx.db.patch(existing._id, next)
      }
    } else {
      const description = await describeSourcePage(ctx, transition, pageId)
      if (description) {
        const row = {
          transitionId: transition._id,
          pageId,
          kind: description.kind,
          source: description.source,
          disposition: description.disposition,
          target: { draftCreatedByTransition: false },
          status: "unready" as const,
          generation: 1,
          updatedAt: now,
        }
        counters = countersAfter(counters, null, row)
        await ctx.db.insert("siteLanguageTransitionPages", row)
      }
    }
  }
  await ctx.db.patch(transition._id, {
    ...counters,
    sourcePublicSetVersion: transition.sourcePublicSetVersion + 1,
    ...(transition.phase === "cancelling"
      ? {}
      : { ...reopenPatch(transition), ...carryReconcilePatch(transition) }),
    updatedAt: now,
  })
}

/**
 * Re-reads the transition and applies one page-row counter delta plus extra
 * fields in the caller's transaction. Nested worker steps write the same row,
 * so a held copy is never trusted.
 */
export async function patchTransition(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  change: {
    before?: Pick<TransitionPage, "disposition" | "status"> | null
    after?: Pick<TransitionPage, "disposition" | "status"> | null
    prepared?: boolean
    carryInput?: boolean
    reopen?: boolean
    fields?: Partial<Transition>
  }
): Promise<Transition> {
  const transition = await ctx.db.get(transitionId)
  if (!transition || !OPEN_TRANSITION_PHASES.has(transition.phase)) {
    throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  const counters =
    change.before !== undefined || change.after !== undefined
      ? countersAfter(transition, change.before ?? null, change.after ?? null)
      : {}
  const patch: Partial<Transition> = {
    ...counters,
    ...(change.prepared
      ? { preparedSetVersion: transition.preparedSetVersion + 1 }
      : {}),
    ...(change.carryInput
      ? { carryInputVersion: (transition.carryInputVersion ?? 0) + 1 }
      : {}),
    ...(change.reopen ? reopenPatch(transition) : {}),
    ...(change.carryInput ? carryReconcilePatch(transition) : {}),
    ...change.fields,
    updatedAt: Date.now(),
  }
  await ctx.db.patch(transition._id, patch)
  return { ...transition, ...patch }
}

/**
 * Records a target Working Draft save or discard through the widened
 * `saveLocaleDraft` / `discardLocaleDraft` path (or a transition copy): the
 * row is created or staled, `draftCreatedByTransition` is kept, and
 * `preparedSetVersion` advances.
 */
export async function recordTargetDraftWrite(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">,
  change: { draftGeneration: number; created: boolean }
): Promise<void> {
  const now = Date.now()
  const row = await readTransitionPage(ctx, transition._id, pageId)
  if (row) {
    const status = row.status === "blocked" ? "blocked" : ("stale" as const)
    const draftCreatedByTransition =
      row.target.draftCreatedByTransition || change.created
    let retainedDraftAttribution = draftCreatedByTransition
      ? undefined
      : row.target.retainedDraftAttribution
    if (
      !draftCreatedByTransition &&
      (retainedDraftAttribution || row.target.retainedReview)
    ) {
      const [drafts, states] = await Promise.all([
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", transition.targetLocale)
          )
          .take(2),
        ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", transition.targetLocale)
          )
          .take(2),
      ])
      if (drafts.length > 1 || states.length > 1) {
        throw new ConvexError("LANGUAGE_TRANSITION_STATE_INVALID")
      }
      retainedDraftAttribution = drafts[0]
        ? {
            ownerId:
              retainedDraftAttribution?.ownerId ??
              row.target.retainedReview!.ownerId,
            tokenIdentifier:
              retainedDraftAttribution?.tokenIdentifier ??
              row.target.retainedReview!.tokenIdentifier,
            locale: transition.targetLocale,
            draftId: drafts[0]._id,
            draftGeneration: drafts[0].generation,
            ...(states[0]?.draftBaseSnapshotId
              ? { draftBaseSnapshotId: states[0].draftBaseSnapshotId }
              : {}),
          }
        : undefined
    }
    await ctx.db.patch(row._id, {
      target: {
        ...row.target,
        draftGeneration: change.draftGeneration,
        draftCreatedByTransition,
        confirmedDraftGeneration: undefined,
        confirmedSharedDraftGeneration: undefined,
        retainedReview: undefined,
        retainedDraftAttribution,
      },
      status,
      generation: row.generation + 1,
      updatedAt: now,
    })
    await patchTransition(ctx, transition._id, {
      before: row,
      after: { disposition: row.disposition, status },
      prepared: true,
      reopen: true,
    })
    return
  }
  const description = await describeSourcePage(ctx, transition, pageId)
  const inserted = {
    transitionId: transition._id,
    pageId,
    // A target draft on a Page with no source selection has no public effect:
    // it can only ever be "no target selection".
    kind: description?.kind ?? ("private_draft" as const),
    source: description?.source ?? { publicGeneration: 0, draftGeneration: 0 },
    disposition: description?.disposition ?? ("withdraw" as const),
    target: {
      draftGeneration: change.draftGeneration,
      draftCreatedByTransition: change.created,
    },
    status: description ? description.status : ("ready" as const),
    generation: 1,
    updatedAt: now,
  }
  await ctx.db.insert("siteLanguageTransitionPages", inserted)
  await patchTransition(ctx, transition._id, {
    before: null,
    after: inserted,
    prepared: true,
    reopen: true,
  })
}

/**
 * Invariant 7: a target-locale-only Menu text write during an open transition
 * counts as prepared. Returns false when the locale is not the open target.
 */
export async function recordTargetMenuTextChange(
  ctx: MutationCtx,
  locale: string
): Promise<boolean> {
  const transition = await readActiveTransitionForWrite(ctx)
  if (
    !transition ||
    transition.targetLocale !== locale ||
    !PREPARABLE_TRANSITION_PHASES.has(transition.phase)
  ) {
    return false
  }
  await ctx.db.patch(transition._id, {
    preparedSetVersion: transition.preparedSetVersion + 1,
    carryInputVersion: (transition.carryInputVersion ?? 0) + 1,
    ...reopenPatch(transition),
    ...carryReconcilePatch(transition),
    updatedAt: Date.now(),
  })
  return true
}

/**
 * A Shared Draft write during an open transition stales a replacement page's
 * confirmation, which is bound to the exact Shared Draft generation.
 */
export async function recordSharedDraftChange(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<void> {
  const transition = await readActiveTransitionForWrite(ctx)
  if (!transition || !PREPARABLE_TRANSITION_PHASES.has(transition.phase)) return
  const row = await readTransitionPage(ctx, transition._id, pageId)
  if (!row || row.target.confirmedSharedDraftGeneration === undefined) return
  const now = Date.now()
  const counters = countersAfter(transition, row, {
    disposition: row.disposition,
    status: "stale",
  })
  await ctx.db.patch(row._id, {
    status: "stale",
    generation: row.generation + 1,
    updatedAt: now,
  })
  await ctx.db.patch(transition._id, {
    ...counters,
    preparedSetVersion: transition.preparedSetVersion + 1,
    ...reopenPatch(transition),
    updatedAt: now,
  })
}
