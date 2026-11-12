import { ConvexError, v, type Infer } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { SUPPORTED_LOCALES } from "../../../lib/i18n/config"
import type { OwnerPrincipal } from "../access/owner"
import { readPublicationAuthority } from "../publishing/snapshots"
import {
  hasLocalePrefixShadow,
  readLivePreviewState,
  requireCommittablePreview,
  type ImpactPreview,
  type LocalePrefixShadowInputs,
  type PreviewCommitClaim,
} from "./impactPreview"
import { insertLanguageLifecycleIntent } from "./lifecycle"
import {
  readMultilingualModuleEnabled,
  readOpenDefaultMigration,
  readOpenTransition,
  readSiteLanguageState,
  type SiteLanguageState,
  type Transition,
} from "./state"

type Ctx = QueryCtx | MutationCtx

/** Most enabled languages one site may have: the supported catalog. */
export const MAX_ENABLED_LOCALES = SUPPORTED_LOCALES.length

export type MultilingualReadiness = Readonly<{
  readiness: "ready" | "needs_setup"
  setup: "not_required" | "required"
}>

/**
 * Module readiness provider. Multilingual has no setup step of its own: the
 * owner configures it in Languages, so it reports ready and not-required in
 * every state, like a module without setup facts. Display only: no behaviour
 * is gated on it (owner decision 2026-11-05). It reads nothing.
 */
export async function resolveMultilingualModuleReadiness(): Promise<MultilingualReadiness> {
  return { readiness: "ready", setup: "not_required" }
}

export type LifecycleStateName = "S0" | "S1" | "S2" | "S3" | "S4" | "IX"

export type MultilingualSnapshot = {
  state: SiteLanguageState
  moduleEnabled: boolean
  transition: Transition | null
  lifecycle: { name: LifecycleStateName; origin: "S0" | "S1" | "S2" | null }
}

function originOf(state: SiteLanguageState): "S0" | "S1" | "S2" | null {
  return state.kind === "uninitialized"
    ? "S0"
    : state.kind === "current"
      ? "S1"
      : state.kind === "multi_locale"
        ? "S2"
        : null
}

/** The contract's lifecycle state (S0–S4 or IX) from bounded point reads. */
export async function readMultilingualSnapshot(
  ctx: Ctx
): Promise<MultilingualSnapshot> {
  const [state, moduleEnabled] = await Promise.all([
    readSiteLanguageState(ctx),
    readMultilingualModuleEnabled(ctx),
  ])
  if (state.kind === "invalid") {
    return {
      state,
      moduleEnabled,
      transition: null,
      lifecycle: { name: "IX", origin: null },
    }
  }
  const transition = await readOpenTransition(ctx, state)
  if (state.kind === "multilingual") {
    return {
      state,
      moduleEnabled,
      transition,
      lifecycle: { name: "S4", origin: null },
    }
  }
  const origin = originOf(state)
  return {
    state,
    moduleEnabled,
    transition,
    lifecycle: moduleEnabled
      ? { name: "S3", origin }
      : { name: origin!, origin: null },
  }
}

function fail(code: string): never {
  throw new ConvexError(code)
}

export type AdoptionTokens = {
  expectedSettingsUpdatedAt: number
  expectedModuleConfigurationVersion: number
  expectedAuthorityVersion: number | null
}

/**
 * The bounded adoption validation shared by `previewAdoption` and adoption:
 * snapshot authority, valid state, module enabled, not yet adopted, no open
 * F09 transition, and supported unique locales. Returns the first refusal.
 */
export async function validateAdoption(ctx: Ctx): Promise<
  | {
      ok: true
      state: Exclude<
        SiteLanguageState,
        { kind: "invalid" } | { kind: "multilingual" }
      >
      moduleConfigurationVersion: number
    }
  | { ok: false; code: string }
> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    return { ok: false, code: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" }
  }
  const [state, moduleRows] = await Promise.all([
    readSiteLanguageState(ctx),
    ctx.db
      .query("cmsModuleState")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .take(2),
  ])
  if (state.kind === "invalid") {
    return { ok: false, code: "SITE_LANGUAGE_AUTHORITY_INVALID" }
  }
  const moduleRow = moduleRows.length === 1 ? moduleRows[0]! : null
  if (
    !moduleRow?.enabledModules.some(
      (entry) => entry.moduleId === "multilingual"
    )
  ) {
    return { ok: false, code: "MULTILINGUAL_MODULE_NOT_ENABLED" }
  }
  if (state.kind === "multilingual") {
    return { ok: false, code: "MULTILINGUAL_ALREADY_ADOPTED" }
  }
  // Includes `cancelling`, which still holds `activeTransitionId`.
  if (await readOpenTransition(ctx, state)) {
    return { ok: false, code: "LANGUAGE_TRANSITION_OPEN" }
  }
  const locales = state.settings.enabledLocales
  if (
    locales.length > MAX_ENABLED_LOCALES ||
    !locales.every((locale) =>
      (SUPPORTED_LOCALES as readonly string[]).includes(locale)
    )
  ) {
    return { ok: false, code: "LOCALE_UNSUPPORTED" }
  }
  return {
    ok: true,
    state,
    moduleConfigurationVersion: moduleRow.configurationVersion,
  }
}

/**
 * Adopt (contract Sequences › Adopt), in the caller's transaction. Writes the
 * authority row and one lifecycle intent; never settings, URLs or snapshots.
 */
export async function adoptMultilingualAuthorityInTransaction(
  ctx: MutationCtx,
  tokens: AdoptionTokens
): Promise<{
  version: number
  defaultLocale: string
  enabledLocales: string[]
}> {
  const validation = await validateAdoption(ctx)
  if (!validation.ok) fail(validation.code)
  const { state } = validation
  const authority: Doc<"siteLanguageAuthority"> | null =
    state.kind === "current" ? state.authority : null
  if (
    state.settings.updatedAt !== tokens.expectedSettingsUpdatedAt ||
    validation.moduleConfigurationVersion !==
      tokens.expectedModuleConfigurationVersion ||
    (authority?.version ?? null) !== tokens.expectedAuthorityVersion
  ) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  const now = Date.now()
  const version = (authority?.version ?? 0) + 1
  const enabledLocales = [...state.settings.enabledLocales]
  const defaultLocale = state.settings.defaultLocale
  if (authority) {
    await ctx.db.patch(authority._id, {
      mode: "multilingual",
      enabledLocales,
      currentLocale: defaultLocale,
      version,
      updatedAt: now,
    })
  } else {
    await ctx.db.insert("siteLanguageAuthority", {
      key: "site-language-v1",
      version,
      currentLocale: defaultLocale,
      mode: "multilingual",
      enabledLocales,
      updatedAt: now,
    })
  }
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `adopt:v${version}`,
    operationKind: "adopt",
    locales: enabledLocales,
    capturedAuthorityVersion: version,
  })
  return { version, defaultLocale, enabledLocales }
}

/**
 * Return to one language (contract Sequences), in the caller's transaction.
 * The module stays enabled, giving S3(S1).
 */
export async function returnToSingleLanguageInTransaction(
  ctx: MutationCtx,
  expectedAuthorityVersion: number
): Promise<{ version: number; locale: string }> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual") fail("MULTILINGUAL_NOT_ADOPTED")
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (state.version !== expectedAuthorityVersion) {
    fail("LANGUAGE_OPERATION_STALE")
  }
  if (state.locales.length !== 1) fail("LANGUAGE_MULTIPLE_LOCALES_ENABLED")
  const version = state.version + 1
  await ctx.db.patch(state.authority._id, {
    mode: "single",
    enabledLocales: undefined,
    version,
    updatedAt: Date.now(),
  })
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `return_to_single:v${version}`,
    operationKind: "return_to_single",
    locales: [state.locale],
    capturedAuthorityVersion: version,
  })
  return { version, locale: state.locale }
}

/**
 * One `take(1)` probe each for what becomes public again with the locale
 * (R4-H5): a current selection and, while Redirects is effective, a
 * locale-scoped manual rule. Shared by add and the owner's advisory query.
 */
export async function readLocaleReveal(
  ctx: Ctx,
  locale: string,
  redirectsEffective: boolean
): Promise<boolean> {
  const [selections, rules] = await Promise.all([
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
        q.eq("hasCurrentSnapshot", true).eq("locale", locale)
      )
      .take(1),
    redirectsEffective
      ? ctx.db
          .query("redirects")
          .withIndex("by_locale_fromPath", (q) => q.eq("locale", locale))
          .take(1)
      : Promise.resolve([]),
  ])
  return selections.length > 0 || rules.length > 0
}

export type AddLanguageArgs = {
  locale: string
  expectedAuthorityVersion: number
  expectedModuleConfigurationVersion: number
  preview?: PreviewCommitClaim
}

/**
 * Add and reveal (contract Sequences › Add and reveal), in the caller's
 * transaction. One `take(1)` probe each for what becomes public again with
 * the locale (R4-H5): a current selection and, while Redirects is effective,
 * a locale-scoped manual rule. Empty probes commit a plain `add` and ignore
 * any supplied preview. Otherwise only a matching, fully reviewed `reveal`
 * preview commits, and it is consumed (M16). Writes the authority, the
 * settings mirror, that preview and one intent; never an M9 row.
 */
export async function addLanguageInTransaction(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  args: AddLanguageArgs
): Promise<{
  version: number
  enabledLocales: string[]
  operationKind: "add" | "reveal"
}> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const { locale } = args
  const live = await readLivePreviewState(ctx, locale, true)
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
  // M1 keeps `activeTransitionId` off a multilingual row, so the only open
  // operation is a default migration (M6).
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    fail("LOCALE_UNSUPPORTED")
  }
  if (state.locales.includes(locale)) fail("LOCALE_ALREADY_ENABLED")

  const [reveals, shadowsDefaultPath] = await Promise.all([
    readLocaleReveal(ctx, locale, live.redirectsEffective),
    hasLocalePrefixShadow(ctx, live, locale),
  ])
  let preview: ImpactPreview | null = null
  if (reveals || shadowsDefaultPath) {
    if (!args.preview) fail("LANGUAGE_PREVIEW_REQUIRED")
    preview = await requireCommittablePreview(
      ctx,
      owner,
      "reveal",
      locale,
      tokens,
      args.preview
    )
  }

  const now = Date.now()
  const version = state.version + 1
  const enabledLocales = [...state.locales, locale]
  await ctx.db.patch(state.authority._id, {
    enabledLocales,
    version,
    updatedAt: now,
  })
  await ctx.db.patch(state.settings._id, { enabledLocales, updatedAt: now })
  if (preview) {
    await ctx.db.patch(preview._id, { phase: "consumed", updatedAt: now })
  }
  const operationKind = reveals ? "reveal" : "add"
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `${operationKind}:v${version}`,
    operationKind,
    locales: [locale],
    capturedAuthorityVersion: version,
  })
  return { version, enabledLocales, operationKind }
}

/** The most conflicting addresses one refusal lists. */
export const ADDRESS_CONFLICT_LIMIT = 10

/**
 * One default-language address that the new language prefix would shadow.
 * `publicPath` is the address as visitors use it today (the default language
 * is unprefixed). Never a page body, only ids the screen can link to.
 */
export type LanguageAddressConflict =
  | {
      kind: "page" | "former_address"
      publicPath: string
      pageId: Id<"pages">
    }
  | { kind: "redirect"; publicPath: string; redirectId: Id<"redirects"> }

export type LanguageAddressConflicts = {
  /** At most `ADDRESS_CONFLICT_LIMIT`, in a stable order. */
  conflicts: LanguageAddressConflict[]
  /** True when more conflicts exist than the list shows. */
  moreConflicts: boolean
}

/**
 * Bounded detail form of the prefix-shadow probe (`readLocalePrefixShadow`):
 * the same indexes and the same continuity rule, listing what shadows
 * instead of answering yes or no. Works before adoption (explicit inputs).
 */
export async function readLocaleAddressConflicts(
  ctx: Ctx,
  inputs: LocalePrefixShadowInputs,
  locale: string
): Promise<LanguageAddressConflicts> {
  const { defaultLocale } = inputs
  const root = `/${locale}`
  const take = ADDRESS_CONFLICT_LIMIT + 1
  const found: LanguageAddressConflict[] = []
  const pages = (rows: Doc<"pageLocalePublicationStates">[]) =>
    rows.map((row): LanguageAddressConflict => ({
      kind: "page",
      publicPath: row.currentPath ?? root,
      pageId: row.pageId,
    }))
  const former = (rows: { fromPath: string; pageId: Id<"pages"> }[]) =>
    rows.map((row): LanguageAddressConflict => ({
      kind: "former_address",
      publicPath: row.fromPath,
      pageId: row.pageId,
    }))
  async function unreleasedHistory(
    query: AsyncIterable<Doc<"pageHistoricalLocaleRoutes">>
  ) {
    const rows: Doc<"pageHistoricalLocaleRoutes">[] = []
    for await (const row of query) {
      if (row.releasedAt !== undefined) continue
      rows.push(row)
      if (rows.length === take) break
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
      .take(take),
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) =>
        q
          .eq("locale", defaultLocale)
          .gte("currentPath", `${root}/`)
          .lt("currentPath", `${root}0`)
      )
      .take(take),
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
  found.push(
    ...pages(currentExact),
    ...pages(currentDescendant),
    ...former(historicalExact),
    ...former(historicalDescendant)
  )

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
        .take(take),
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q
            .eq("migrationId", pointer.migrationId)
            .eq("generation", pointer.generation)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
        .take(take),
    ])
    found.push(...former(exact), ...former(descendant))
  } else if (transitionId) {
    const [exact, descendant] = await Promise.all([
      ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", root)
        )
        .take(take),
      ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q
            .eq("transitionId", transitionId)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
        .take(take),
    ])
    found.push(...former(exact), ...former(descendant))
  }

  if (inputs.redirectsEffective) {
    const [ruleExact, ruleDescendant] = await Promise.all([
      ctx.db
        .query("redirects")
        .withIndex("by_locale_fromPath", (q) =>
          q.eq("locale", defaultLocale).eq("fromPath", root)
        )
        .take(take),
      ctx.db
        .query("redirects")
        .withIndex("by_locale_fromPath", (q) =>
          q
            .eq("locale", defaultLocale)
            .gte("fromPath", `${root}/`)
            .lt("fromPath", `${root}0`)
        )
        .take(take),
    ])
    for (const rule of [...ruleExact, ...ruleDescendant]) {
      found.push({
        kind: "redirect",
        publicPath: rule.fromPath,
        redirectId: rule._id,
      })
    }
  }
  return {
    conflicts: found.slice(0, ADDRESS_CONFLICT_LIMIT),
    moreConflicts: found.length > ADDRESS_CONFLICT_LIMIT,
  }
}

export type AddLanguageSilentResult =
  | {
      ok: true
      version: number
      enabledLocales: string[]
      operationKind: "add" | "reveal"
    }
  | ({
      ok: false
      code: "LANGUAGE_ADDRESS_CONFLICT"
    } & LanguageAddressConflicts)

/**
 * Silent add and re-add (owner 2026-11-02): no reviewed preview, none
 * consumed. A language whose pages and rules were kept comes back by itself
 * (`reveal`). The one thing it refuses is a default-language address the new
 * prefix would shadow: a structured conflict result, decided before any
 * write. The caller must not have written anything it cannot roll back
 * before it sees `ok: false` (`addSiteLanguage` checks first and throws if
 * this ever disagrees, so nothing commits).
 */
export async function addLanguageSilentlyInTransaction(
  ctx: MutationCtx,
  args: Omit<AddLanguageArgs, "preview">
): Promise<AddLanguageSilentResult> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const { locale } = args
  const live = await readLivePreviewState(ctx, locale, true)
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
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    fail("LOCALE_UNSUPPORTED")
  }
  if (state.locales.includes(locale)) fail("LOCALE_ALREADY_ENABLED")

  const [reveals, shadowing] = await Promise.all([
    readLocaleReveal(ctx, locale, live.redirectsEffective),
    hasLocalePrefixShadow(ctx, live, locale),
  ])
  if (shadowing) {
    const detail = await readLocaleAddressConflicts(
      ctx,
      {
        defaultLocale: state.locale,
        continuityPointer: state.authority.continuityPointer,
        lastCommittedTransitionId: state.authority.lastCommittedTransitionId,
        redirectsEffective: live.redirectsEffective,
      },
      locale
    )
    return { ok: false, code: "LANGUAGE_ADDRESS_CONFLICT", ...detail }
  }

  const now = Date.now()
  const version = state.version + 1
  const enabledLocales = [...state.locales, locale]
  await ctx.db.patch(state.authority._id, {
    enabledLocales,
    version,
    updatedAt: now,
  })
  await ctx.db.patch(state.settings._id, { enabledLocales, updatedAt: now })
  const operationKind = reveals ? "reveal" : "add"
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `${operationKind}:v${version}`,
    operationKind,
    locales: [locale],
    capturedAuthorityVersion: version,
  })
  return { ok: true, version, enabledLocales, operationKind }
}

/**
 * Remove (contract Sequences › Remove), in the caller's transaction. The
 * command names no locale: it removes the language of the submitted preview,
 * and every captured token is the preview's (ledger C2b.2b). Refusals, in
 * order: snapshot authority (M4); state; an open default migration (M6); a
 * missing preview; the shared M16 predicate `requireCommittablePreview`; the
 * locale enabled and not the default; then one `take(1)` probe each for a
 * `pending` and a `held` release in that locale. Writes the authority, the settings mirror, the consumed
 * preview and one intent; never an M9 row.
 */
export async function removeLanguageInTransaction(
  ctx: MutationCtx,
  owner: OwnerPrincipal,
  claim: PreviewCommitClaim
): Promise<{ version: number; enabledLocales: string[]; locale: string }> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const [state, target] = await Promise.all([
    readSiteLanguageState(ctx),
    ctx.db.get(claim.previewId),
  ])
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  if (state.kind !== "multilingual") fail("MULTILINGUAL_NOT_ADOPTED")
  // M1 keeps `activeTransitionId` off a multilingual row, so the only open
  // operation is a default migration (M6).
  if (await readOpenDefaultMigration(ctx, state)) {
    fail("LANGUAGE_OPERATION_OPEN")
  }
  // Only the preview names the language, and so the freshness scope. The
  // shared predicate below owns every other preview refusal.
  if (!target) fail("LANGUAGE_PREVIEW_MISMATCH")
  const { locale } = target
  const { tokens } = await readLivePreviewState(ctx, locale)
  if (!tokens) fail("MULTILINGUAL_NOT_ADOPTED")
  const preview = await requireCommittablePreview(
    ctx,
    owner,
    "remove",
    locale,
    tokens,
    claim
  )
  if (!state.locales.includes(locale)) fail("LOCALE_NOT_ENABLED")
  if (locale === state.locale) fail("LOCALE_IS_DEFAULT")
  const obligations = await Promise.all(
    (["pending", "held"] as const).map((status) =>
      ctx.db
        .query("pageLocalePublicationReleases")
        .withIndex("by_locale_and_status", (q) =>
          q.eq("locale", locale).eq("status", status)
        )
        .take(1)
    )
  )
  if (obligations.some((rows) => rows.length > 0)) {
    fail("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT")
  }

  const now = Date.now()
  const version = state.version + 1
  const enabledLocales = state.locales.filter((enabled) => enabled !== locale)
  await ctx.db.patch(state.authority._id, {
    enabledLocales,
    version,
    updatedAt: now,
  })
  await ctx.db.patch(state.settings._id, { enabledLocales, updatedAt: now })
  await ctx.db.patch(preview._id, { phase: "consumed", updatedAt: now })
  await insertLanguageLifecycleIntent(ctx, {
    operationId: `remove:v${version}`,
    operationKind: "remove",
    locales: [locale],
    capturedAuthorityVersion: version,
  })
  return { version, enabledLocales, locale }
}

export type MultilingualModuleBlocker =
  | {
      code: "MULTILINGUAL_AUTHORITY_ACTIVE"
      moduleId: "multilingual"
      locales: string[]
    }
  | {
      code: "LANGUAGE_OPERATION_OPEN"
      moduleId: "multilingual"
      kind: "language_transition" | "default_migration"
    }
  | { code: "LANGUAGE_STATE_INVALID"; moduleId: "multilingual" }

/**
 * M05 rules for a `multilingual` toggle (contract Module enable and disable).
 * Enable is blocked by invalid state (M5) or an open or cancelling F09
 * transition (M6); disable by a multilingual authority, an open operation or
 * invalid state.
 */
export async function readMultilingualToggleBlockers(
  ctx: Ctx,
  toEnabled: boolean
): Promise<MultilingualModuleBlocker[]> {
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "invalid") {
    return [{ code: "LANGUAGE_STATE_INVALID", moduleId: "multilingual" }]
  }
  const blockers: MultilingualModuleBlocker[] = []
  if (!toEnabled && state.kind === "multilingual") {
    blockers.push({
      code: "MULTILINGUAL_AUTHORITY_ACTIVE",
      moduleId: "multilingual",
      locales: [...state.locales],
    })
  }
  if (await readOpenDefaultMigration(ctx, state)) {
    blockers.push({
      code: "LANGUAGE_OPERATION_OPEN",
      moduleId: "multilingual",
      kind: "default_migration",
    })
  }
  if (await readOpenTransition(ctx, state)) {
    blockers.push({
      code: "LANGUAGE_OPERATION_OPEN",
      moduleId: "multilingual",
      kind: "language_transition",
    })
  }
  return blockers
}

// Shared command entry and optimistic-concurrency checks (M05 / Modules Apply).
export const commandTokensValidator = v.object({
  settingsUpdatedAt: v.union(v.number(), v.null()),
  moduleConfigurationVersion: v.number(),
  authorityVersion: v.union(v.number(), v.null()),
})

export type CommandTokens = Infer<typeof commandTokensValidator>

export function commandTokensOf(
  state: Exclude<SiteLanguageState, { kind: "invalid" }>,
  moduleConfigurationVersion: number
): CommandTokens {
  return {
    settingsUpdatedAt: state.settings.updatedAt,
    moduleConfigurationVersion,
    authorityVersion:
      state.kind === "current" || state.kind === "multilingual"
        ? state.version
        : null,
  }
}

type EntryState = Exclude<SiteLanguageState, { kind: "invalid" }>

/** The language state, module flag and tokens a combined command starts from. */
export async function readCommandEntry(
  ctx: Ctx,
  options: {
    requireSnapshotAuthority: boolean
    moduleConfigurationVersion: number
  }
) {
  if (
    options.requireSnapshotAuthority &&
    (await readPublicationAuthority(ctx)) !== "snapshot_active"
  ) {
    fail("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
  const snapshot = await readMultilingualSnapshot(ctx)
  const state: SiteLanguageState = snapshot.state
  if (state.kind === "invalid") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  return {
    state: state as EntryState,
    moduleEnabled: snapshot.moduleEnabled,
    tokens: commandTokensOf(
      state as EntryState,
      options.moduleConfigurationVersion
    ),
  }
}

/**
 * Compares the client's tokens with the pre-command tokens. A module
 * configuration mismatch refuses `CMS_MODULE_CONFIGURATION_STALE` when the
 * command changes the module and `LANGUAGE_OPERATION_STALE` otherwise.
 */
export function staleEntryTokenCode(
  actual: CommandTokens,
  expected: {
    settingsUpdatedAt?: number | null
    moduleConfigurationVersion: number
    authorityVersion: number | null
  },
  changesModule: boolean
): "LANGUAGE_OPERATION_STALE" | "CMS_MODULE_CONFIGURATION_STALE" | null {
  if (
    (expected.settingsUpdatedAt !== undefined &&
      expected.settingsUpdatedAt !== actual.settingsUpdatedAt) ||
    expected.authorityVersion !== actual.authorityVersion
  ) {
    return "LANGUAGE_OPERATION_STALE"
  }
  if (
    expected.moduleConfigurationVersion !== actual.moduleConfigurationVersion
  ) {
    return changesModule
      ? "CMS_MODULE_CONFIGURATION_STALE"
      : "LANGUAGE_OPERATION_STALE"
  }
  return null
}

export function requireFreshEntryTokens(
  actual: CommandTokens,
  expected: Parameters<typeof staleEntryTokenCode>[1],
  changesModule: boolean
): void {
  const stale = staleEntryTokenCode(actual, expected, changesModule)
  if (stale) fail(stale)
}
