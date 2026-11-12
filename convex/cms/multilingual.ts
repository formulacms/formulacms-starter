import { ConvexError, v } from "convex/values"
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import type { Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server"
import { requireInstallationOwner } from "../lib/access/policy"
import {
  activateDefaultMigrationInTransaction,
  cancelDefaultMigrationInTransaction,
  listDefaultMigrationDisclosurePage,
  recordDefaultMigrationReviewInTransaction,
  setDefaultLanguageInTransaction,
  startDefaultMigrationInTransaction,
  stepDefaultMigrationInTransaction,
  type DefaultMigration,
} from "../lib/language/defaultMigration"
import {
  disclosureItemValidator,
  disclosureSectionValidator,
} from "../lib/language/disclosure"
import {
  IMPACT_PREVIEW_GENERATION,
  expireImpactPreviewInTransaction,
  listImpactPreviewPage,
  recordImpactReviewInTransaction,
  startImpactPreviewInTransaction,
  stepImpactPreviewInTransaction,
} from "../lib/language/impactPreview"
import {
  commandTokensValidator,
  commandTokensOf,
  type CommandTokens,
  readCommandEntry as readMultilingualCommandEntry,
  staleEntryTokenCode,
  requireFreshEntryTokens,
  addLanguageInTransaction,
  addLanguageSilentlyInTransaction,
  adoptMultilingualAuthorityInTransaction,
  readLocaleAddressConflicts,
  readMultilingualSnapshot,
  removeLanguageInTransaction,
  returnToSingleLanguageInTransaction,
  validateAdoption,
} from "../lib/language/multilingual"
import {
  requireOwnerAndOptionalModule,
  resolveOptionalModuleGuardState,
  readModuleState,
  resolveEffectiveModuleStateFromEnabled,
} from "../lib/modules/state"
import {
  readAuthorityRows,
  readOpenDefaultMigration,
  type SiteLanguageState,
} from "../lib/language/state"
import { SUPPORTED_LOCALES } from "../../lib/i18n/config"

// M05 owner commands (contract Command and API contract). Every entry point
// calls `requireInstallationOwner` first (M7). C1 owns state, adoption and
// return to one language; C2b.1 owns impact previews, disclosure pages and
// review receipts; C2b.2a owns add and reveal; C2b.2b owns remove; C3b owns
// the default migration's start, enumeration, disclosure and review receipt;
// C3c.1 owns its validation and cancel; C3c.2 owns activation.

const defaultMigrationSummaryValidator = v.object({
  migrationId: v.id("siteDefaultLanguageMigrations"),
  fromLocale: v.string(),
  toLocale: v.string(),
  phase: v.string(),
  generation: v.number(),
  counts: v.object({
    rows: v.number(),
    shadowedByCurrent: v.number(),
    shadowedByHistorical: v.number(),
    manualRulesShadowed: v.number(),
    manualRulesShifted: v.number(),
    manualRulesUnprefixed: v.number(),
    carriedShadowedSkipped: v.number(),
    blockers: v.number(),
  }),
  disclosurePageCount: v.number(),
  reviewedThroughOrdinal: v.number(),
  readinessVersion: v.union(v.number(), v.null()),
})

function defaultMigrationSummary(migration: DefaultMigration) {
  return {
    migrationId: migration._id,
    fromLocale: migration.fromLocale,
    toLocale: migration.toLocale,
    phase: migration.phase,
    generation: migration.generation,
    counts: migration.counts,
    disclosurePageCount: migration.disclosurePageCount,
    reviewedThroughOrdinal: migration.reviewedThroughOrdinal,
    readinessVersion: migration.manifest?.readinessVersion ?? null,
  }
}

const impactPreviewSummaryValidator = v.object({
  previewId: v.id("siteLanguageImpactPreviews"),
  kind: v.union(v.literal("remove"), v.literal("reveal")),
  locale: v.string(),
  phase: v.union(v.literal("scanning"), v.literal("complete")),
  count: v.object({
    publicPages: v.number(),
    routes: v.number(),
    manualRules: v.number(),
    menus: v.number(),
  }),
  digest: v.string(),
  pageCount: v.number(),
  reviewedThroughOrdinal: v.number(),
  generation: v.number(),
  updatedAt: v.number(),
})

async function readLiveImpactPreviewSummaries(
  ctx: QueryCtx,
  tokenIdentifier: string,
  enabledLocales: readonly string[],
  defaultLocale: string
) {
  const enabled = new Set(enabledLocales)
  const slots = SUPPORTED_LOCALES.flatMap((locale) => {
    const kind = enabled.has(locale)
      ? locale === defaultLocale
        ? null
        : ("remove" as const)
      : ("reveal" as const)
    return kind === null
      ? []
      : (["scanning", "complete"] as const).map((phase) => ({
          locale,
          kind,
          phase,
        }))
  })
  const rows = await Promise.all(
    slots.map(({ locale, kind, phase }) =>
      ctx.db
        .query("siteLanguageImpactPreviews")
        .withIndex("by_owner_and_locale_and_kind_and_phase", (q) =>
          q
            .eq("owner.tokenIdentifier", tokenIdentifier)
            .eq("locale", locale)
            .eq("kind", kind)
            .eq("phase", phase)
        )
        .order("desc")
        .take(1)
    )
  )
  return rows
    .flat()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((preview) => ({
      previewId: preview._id,
      kind: preview.kind,
      locale: preview.locale,
      phase: preview.phase as "scanning" | "complete",
      count: preview.count,
      digest: preview.digest,
      pageCount: preview.pageCount,
      reviewedThroughOrdinal: preview.reviewedThroughOrdinal,
      generation: preview.generation,
      updatedAt: preview.updatedAt,
    }))
}

const lifecycleNameValidator = v.union(
  v.literal("S0"),
  v.literal("S1"),
  v.literal("S2"),
  v.literal("S3"),
  v.literal("S4"),
  v.literal("IX")
)

// The three values a combined language command compares first (contract A4).
// `authorityVersion: null` means no authority row (S0, or S2 with no row),
// never version 0. `settingsUpdatedAt: null` means no settings document.
/** Invalid language state still reports what is readable (bounded rows). */
async function readUnclassifiedCommandTokens(
  ctx: QueryCtx,
  moduleConfigurationVersion: number
): Promise<CommandTokens> {
  const [settingsRows, authorityRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
  ])
  return {
    settingsUpdatedAt:
      settingsRows.length === 1 ? settingsRows[0]!.updatedAt : null,
    moduleConfigurationVersion,
    authorityVersion:
      authorityRows.length === 1 ? authorityRows[0]!.version : null,
  }
}

export const getMultilingualState = query({
  args: {},
  returns: v.object({
    lifecycleState: lifecycleNameValidator,
    origin: v.union(
      v.literal("S0"),
      v.literal("S1"),
      v.literal("S2"),
      v.null()
    ),
    moduleEnabled: v.boolean(),
    moduleConfigurationVersion: v.number(),
    version: v.union(v.number(), v.null()),
    defaultLocale: v.union(v.string(), v.null()),
    enabledLocales: v.array(v.string()),
    openOperation: v.union(
      v.null(),
      v.object({
        kind: v.literal("language_transition"),
        phase: v.string(),
      }),
      v.object({
        kind: v.literal("default_migration"),
        phase: v.string(),
      })
    ),
    defaultMigration: v.union(v.null(), defaultMigrationSummaryValidator),
    latestPreviews: v.array(impactPreviewSummaryValidator),
    commandTokens: commandTokensValidator,
  }),
  handler: async (ctx) => {
    const owner = await requireInstallationOwner(ctx)
    const snapshot = await readMultilingualSnapshot(ctx)
    const moduleState = await readModuleState(ctx)
    const { state } = snapshot
    let migration: DefaultMigration | null = null
    if (state.kind === "multilingual") {
      try {
        migration = await readOpenDefaultMigration(ctx, state)
      } catch (error) {
        // An authority naming a migration that is not open is invalid (IX).
        if (!(error instanceof ConvexError)) throw error
        return {
          lifecycleState: "IX" as const,
          origin: null,
          moduleEnabled: snapshot.moduleEnabled,
          moduleConfigurationVersion: moduleState.configurationVersion,
          version: null,
          defaultLocale: null,
          enabledLocales: [],
          openOperation: null,
          defaultMigration: null,
          latestPreviews: [],
          commandTokens: await readUnclassifiedCommandTokens(
            ctx,
            moduleState.configurationVersion
          ),
        }
      }
    }
    const enabledLocales =
      state.kind === "invalid" ? [] : [...state.settings.enabledLocales]
    const defaultLocale =
      state.kind === "invalid" ? null : state.settings.defaultLocale
    const latestPreviews =
      state.kind === "multilingual"
        ? await readLiveImpactPreviewSummaries(
            ctx,
            owner.tokenIdentifier,
            enabledLocales,
            state.locale
          )
        : []
    return {
      lifecycleState: snapshot.lifecycle.name,
      origin: snapshot.lifecycle.origin,
      moduleEnabled: snapshot.moduleEnabled,
      moduleConfigurationVersion: moduleState.configurationVersion,
      version: state.kind === "invalid" ? null : state.version,
      defaultLocale,
      enabledLocales,
      openOperation: snapshot.transition
        ? {
            kind: "language_transition" as const,
            phase: snapshot.transition.phase,
          }
        : migration
          ? { kind: "default_migration" as const, phase: migration.phase }
          : null,
      defaultMigration: migration ? defaultMigrationSummary(migration) : null,
      latestPreviews,
      commandTokens:
        state.kind === "invalid"
          ? await readUnclassifiedCommandTokens(
              ctx,
              moduleState.configurationVersion
            )
          : commandTokensOf(state, moduleState.configurationVersion),
    }
  },
})

export const previewAdoption = query({
  args: {},
  returns: v.union(
    v.object({
      canAdopt: v.literal(true),
      defaultLocale: v.string(),
      enabledLocales: v.array(v.string()),
      expectedSettingsUpdatedAt: v.number(),
      expectedModuleConfigurationVersion: v.number(),
      expectedAuthorityVersion: v.union(v.number(), v.null()),
    }),
    v.object({ canAdopt: v.literal(false), blockerCode: v.string() })
  ),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual", { requireReady: false })
    const validation = await validateAdoption(ctx)
    if (!validation.ok) {
      return { canAdopt: false as const, blockerCode: validation.code }
    }
    const { state } = validation
    return {
      canAdopt: true as const,
      defaultLocale: state.settings.defaultLocale,
      enabledLocales: [...state.settings.enabledLocales],
      expectedSettingsUpdatedAt: state.settings.updatedAt,
      expectedModuleConfigurationVersion: validation.moduleConfigurationVersion,
      expectedAuthorityVersion:
        state.kind === "current" ? state.authority.version : null,
    }
  },
})

export const adoptMultilingualAuthority = mutation({
  args: {
    expectedSettingsUpdatedAt: v.number(),
    expectedModuleConfigurationVersion: v.number(),
    expectedAuthorityVersion: v.union(v.number(), v.null()),
  },
  returns: v.object({
    version: v.number(),
    defaultLocale: v.string(),
    enabledLocales: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual", { requireReady: false })
    return adoptMultilingualAuthorityInTransaction(ctx, args)
  },
})

export const returnToSingleLanguage = mutation({
  args: { expectedAuthorityVersion: v.number() },
  returns: v.object({ version: v.number(), locale: v.string() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual", { requireReady: false })
    return returnToSingleLanguageInTransaction(
      ctx,
      args.expectedAuthorityVersion
    )
  },
})

// ─── Impact previews (C2b.1) ────────────────────────────────────────────────

const previewKindValidator = v.union(v.literal("remove"), v.literal("reveal"))

const previewCommitClaimValidator = v.object({
  previewId: v.id("siteLanguageImpactPreviews"),
  expectedDigest: v.string(),
  expectedCount: v.object({
    publicPages: v.number(),
    routes: v.number(),
    manualRules: v.number(),
    menus: v.number(),
  }),
})

// ─── Add and reveal (C2b.2a) ────────────────────────────────────────────────

export const addLanguage = mutation({
  args: {
    locale: v.string(),
    expectedAuthorityVersion: v.number(),
    expectedModuleConfigurationVersion: v.number(),
    preview: v.optional(previewCommitClaimValidator),
  },
  returns: v.object({
    version: v.number(),
    enabledLocales: v.array(v.string()),
    operationKind: v.union(v.literal("add"), v.literal("reveal")),
  }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return addLanguageInTransaction(ctx, owner, args)
  },
})

// ─── Remove (C2b.2b) ────────────────────────────────────────────────────────

export const removeLanguage = mutation({
  args: previewCommitClaimValidator.fields,
  returns: v.object({
    version: v.number(),
    enabledLocales: v.array(v.string()),
    locale: v.string(),
  }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return removeLanguageInTransaction(ctx, owner, args)
  },
})

// ─── Combined language commands (A4) ────────────────────────────────────────
//
// Each command is one Convex transaction. The steps are plain helpers that
// take `ctx` (disable through `commitModuleTransitionInTransaction`,
// then adopt, add, remove and return), never `ctx.runMutation`, so any
// refusal, including a late one, rolls back every earlier step and every
// consumed preview. Every client token is compared with the state before the
// command, including the tokens of steps the command then skips; later steps
// get the versions this transaction produced, and each helper keeps its own
// checks. Each step writes its own lifecycle intent (M17).

function failWith(code: string): never {
  throw new ConvexError(code)
}

type EntryState = Exclude<SiteLanguageState, { kind: "invalid" }>
async function readCommandEntry(ctx: MutationCtx, options: { requireSnapshotAuthority: boolean }) {
  return readMultilingualCommandEntry(ctx, {
    ...options,
    moduleConfigurationVersion: (await readModuleState(ctx)).configurationVersion,
  })
}

/**
 * The Multilingual module is switched only in Settings > Modules (owner
 * 2026-11-05). A language command on a site where it is off refuses and
 * writes nothing; it never turns the module on.
 */
function requireMultilingualModuleOn(
  entry: Awaited<ReturnType<typeof readCommandEntry>>
): void {
  if (!entry.moduleEnabled) failWith("MULTILINGUAL_MODULE_NOT_ENABLED")
}

/** Adopt when not adopted; never touches module state (module is on). */
async function adoptInTransaction(
  ctx: MutationCtx,
  entry: Awaited<ReturnType<typeof readCommandEntry>>
): Promise<{ authorityVersion: number; moduleConfigurationVersion: number }> {
  const moduleConfigurationVersion = entry.tokens.moduleConfigurationVersion
  if (entry.state.kind === "multilingual") {
    return {
      authorityVersion: entry.state.version,
      moduleConfigurationVersion,
    }
  }
  const adopted = await adoptMultilingualAuthorityInTransaction(ctx, {
    expectedSettingsUpdatedAt: entry.state.settings.updatedAt,
    expectedModuleConfigurationVersion: moduleConfigurationVersion,
    expectedAuthorityVersion: entry.tokens.authorityVersion,
  })
  return {
    authorityVersion: adopted.version,
    moduleConfigurationVersion,
  }
}

/** The settings document after the command, for the result's token fields. */
async function readSettingsAfter(
  ctx: MutationCtx,
  entry: Awaited<ReturnType<typeof readCommandEntry>>
) {
  const settings = await ctx.db.get(entry.state.settings._id)
  if (!settings) failWith("SITE_LANGUAGE_AUTHORITY_INVALID")
  return {
    settingsUpdatedAt: settings.updatedAt,
    defaultLocale: settings.defaultLocale,
    enabledLocales: [...settings.enabledLocales],
  }
}

function requireAddableLocale(entry: EntryState, locale: string): void {
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
    failWith("LOCALE_UNSUPPORTED")
  }
  const enabled =
    entry.kind === "multilingual"
      ? entry.locales
      : entry.settings.enabledLocales
  if (enabled.includes(locale)) failWith("LOCALE_ALREADY_ENABLED")
}

const entryTokenArgs = {
  expectedSettingsUpdatedAt: v.number(),
  expectedModuleConfigurationVersion: v.number(),
  expectedAuthorityVersion: v.union(v.number(), v.null()),
}

const addressConflictValidator = v.union(
  v.object({
    kind: v.union(v.literal("page"), v.literal("former_address")),
    publicPath: v.string(),
    pageId: v.id("pages"),
  }),
  v.object({
    kind: v.literal("redirect"),
    publicPath: v.string(),
    redirectId: v.id("redirects"),
  })
)

/**
 * The default-language addresses a new `/locale` prefix would shadow, read
 * with explicit inputs so it works before adoption (module off, S0 to S3).
 * Shared by the advisory query and `addSiteLanguage`, which runs it before
 * its first write.
 */
async function readAddressConflictsFor(
  ctx: QueryCtx | MutationCtx,
  state: EntryState,
  locale: string
) {
  const moduleState = await readModuleState(ctx)
  const redirectsEffective =
    resolveEffectiveModuleStateFromEnabled(
      moduleState.configurationVersion,
      moduleState.enabledModuleIds
    ).modules.find((module) => module.moduleId === "redirects")?.effective ===
    true
  const authority =
    state.kind === "current" || state.kind === "multilingual"
      ? state.authority
      : null
  return readLocaleAddressConflicts(
    ctx,
    {
      defaultLocale: state.settings.defaultLocale,
      continuityPointer: authority?.continuityPointer,
      lastCommittedTransitionId: authority?.lastCommittedTransitionId,
      redirectsEffective,
    },
    locale
  )
}

/**
 * Advisory (owner 2026-11-02): adding or re-adding a language never needs a
 * reviewed preview. `needsReview` is kept for the current screen and is
 * always false with no reasons; `conflicts` lists, bounded, the
 * default-language addresses the new prefix would shadow (`addSiteLanguage`
 * refuses those). Works with the module off. Every mutation recomputes it.
 */
export const needsReviewToAddLanguage = query({
  args: { locale: v.string() },
  returns: v.object({
    needsReview: v.boolean(),
    reasons: v.array(
      v.union(v.literal("reveal"), v.literal("shadowsDefaultPath"))
    ),
    conflicts: v.array(addressConflictValidator),
    moreConflicts: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const snapshot = await readMultilingualSnapshot(ctx)
    const state: SiteLanguageState = snapshot.state
    if (state.kind === "invalid") failWith("SITE_LANGUAGE_AUTHORITY_INVALID")
    requireAddableLocale(state, args.locale)
    const detail = await readAddressConflictsFor(ctx, state, args.locale)
    return { needsReview: false, reasons: [], ...detail }
  },
})

/**
 * Adopt (if not adopted) and add, in one step with no preview (owner
 * 2026-11-02). Refuses `MULTILINGUAL_MODULE_NOT_ENABLED` while the module is
 * off: it is switched only in Modules (owner 2026-11-05). Expected refusals return a structured result
 * and are decided before the first write: stale tokens
 * (`SITE_LANGUAGE_VERSION_CHANGED`) and a shadowed default-language address
 * (`LANGUAGE_ADDRESS_CONFLICT`). Anything else still throws. The `preview`
 * argument is accepted and ignored for older callers.
 */
export const addSiteLanguage = mutation({
  args: {
    locale: v.string(),
    ...entryTokenArgs,
    preview: v.optional(previewCommitClaimValidator),
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      authorityVersion: v.number(),
      moduleConfigurationVersion: v.number(),
      settingsUpdatedAt: v.number(),
      defaultLocale: v.string(),
      enabledLocales: v.array(v.string()),
      operationKind: v.union(v.literal("add"), v.literal("reveal")),
    }),
    v.object({
      ok: v.literal(false),
      code: v.literal("SITE_LANGUAGE_VERSION_CHANGED"),
    }),
    v.object({
      ok: v.literal(false),
      code: v.literal("LANGUAGE_ADDRESS_CONFLICT"),
      conflicts: v.array(addressConflictValidator),
      moreConflicts: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const entry = await readCommandEntry(ctx, {
      requireSnapshotAuthority: true,
    })
    requireMultilingualModuleOn(entry)
    if (
      staleEntryTokenCode(
        entry.tokens,
        {
          settingsUpdatedAt: args.expectedSettingsUpdatedAt,
          moduleConfigurationVersion: args.expectedModuleConfigurationVersion,
          authorityVersion: args.expectedAuthorityVersion,
        },
        false
      )
    ) {
      return { ok: false as const, code: "SITE_LANGUAGE_VERSION_CHANGED" as const }
    }
    requireAddableLocale(entry.state, args.locale)
    // Decide the conflict before the adopt write below.
    const found = await readAddressConflictsFor(ctx, entry.state, args.locale)
    if (found.conflicts.length > 0) {
      return {
        ok: false as const,
        code: "LANGUAGE_ADDRESS_CONFLICT" as const,
        ...found,
      }
    }
    const threaded = await adoptInTransaction(ctx, entry)
    const added = await addLanguageSilentlyInTransaction(ctx, {
      locale: args.locale,
      expectedAuthorityVersion: threaded.authorityVersion,
      expectedModuleConfigurationVersion: threaded.moduleConfigurationVersion,
    })
    // Unreachable unless state changed under the check above; throwing rolls
    // back the adopt write (a returned result would commit them).
    if (!added.ok) failWith(added.code)
    return {
      ok: true as const,
      authorityVersion: added.version,
      moduleConfigurationVersion: threaded.moduleConfigurationVersion,
      ...(await readSettingsAfter(ctx, entry)),
      enabledLocales: added.enabledLocales,
      operationKind: added.operationKind,
    }
  },
})

const prepareResultValidator = {
  authorityVersion: v.number(),
  moduleConfigurationVersion: v.number(),
  settingsUpdatedAt: v.number(),
  defaultLocale: v.string(),
  enabledLocales: v.array(v.string()),
}

/**
 * Shared by `prepareLanguageReview` and `prepareLanguageChange`: the same
 * entry check (module must be on), then adopt (if not adopted). The optional
 * locale is validated after the tokens and before any write.
 */
async function prepareInTransaction(
  ctx: MutationCtx,
  args: {
    expectedSettingsUpdatedAt: number
    expectedModuleConfigurationVersion: number
    expectedAuthorityVersion: number | null
  },
  locale?: string
) {
  const entry = await readCommandEntry(ctx, { requireSnapshotAuthority: true })
  requireMultilingualModuleOn(entry)
  requireFreshEntryTokens(
    entry.tokens,
    {
      settingsUpdatedAt: args.expectedSettingsUpdatedAt,
      moduleConfigurationVersion: args.expectedModuleConfigurationVersion,
      authorityVersion: args.expectedAuthorityVersion,
    },
    false
  )
  if (locale !== undefined) requireAddableLocale(entry.state, locale)
  const threaded = await adoptInTransaction(ctx, entry)
  return {
    authorityVersion: threaded.authorityVersion,
    moduleConfigurationVersion: threaded.moduleConfigurationVersion,
    ...(await readSettingsAfter(ctx, entry)),
  }
}

/**
 * Adopt only (the module must already be on in Modules; it refuses
 * `MULTILINGUAL_MODULE_NOT_ENABLED` otherwise and writes nothing), so the
 * owner can run the existing preview and review flow and then `addLanguage`.
 * The result reports `cancelReturnsToOneLanguage` as a fact only: from one
 * language it is true, with several languages every language stays and it is
 * false. No caller returns to one language or turns the module off here; that
 * happens only in Modules.
 */
export const prepareLanguageReview = mutation({
  args: { locale: v.string(), ...entryTokenArgs },
  returns: v.object({
    ...prepareResultValidator,
    cancelReturnsToOneLanguage: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const { locale, ...tokens } = args
    const prepared = await prepareInTransaction(ctx, tokens, locale)
    return {
      ...prepared,
      cancelReturnsToOneLanguage: prepared.enabledLocales.length === 1,
    }
  },
})

/**
 * Adopt (if not adopted) with every language kept, no locale. The module must
 * already be on in Modules; with it off this refuses
 * `MULTILINGUAL_MODULE_NOT_ENABLED` and writes nothing. The screen calls it
 * when the owner continues inside the Remove or Make default dialog on an
 * unadopted multi-language site, then runs the existing removal preview or
 * default-migration flow. Adopted: no-write success.
 */
export const prepareLanguageChange = mutation({
  args: entryTokenArgs,
  returns: v.object(prepareResultValidator),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return await prepareInTransaction(ctx, args)
  },
})

/**
 * Remove the only extra language and go back to one language with the module
 * left on: remove, then return. The reviewed removal preview binds the
 * captured versions. The owner switches the module off in Modules.
 */
export const removeLastExtraLanguage = mutation({
  args: previewCommitClaimValidator.fields,
  returns: v.object({
    authorityVersion: v.number(),
    moduleConfigurationVersion: v.number(),
    locale: v.string(),
    removedLocale: v.string(),
  }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const entry = await readCommandEntry(ctx, {
      requireSnapshotAuthority: true,
    })
    if (entry.state.kind !== "multilingual")
      failWith("MULTILINGUAL_NOT_ADOPTED")
    if (entry.state.locales.length !== 2) failWith("LANGUAGE_NOT_LAST_EXTRA")
    const removed = await removeLanguageInTransaction(ctx, owner, args)
    const returned = await returnToSingleLanguageInTransaction(
      ctx,
      removed.version
    )
    // The module stays on; it is switched off only in Modules (owner
    // 2026-11-05), so the configuration version is unchanged.
    return {
      authorityVersion: returned.version,
      moduleConfigurationVersion: entry.tokens.moduleConfigurationVersion,
      locale: returned.locale,
      removedLocale: removed.locale,
    }
  },
})

export const startLanguageImpactPreview = mutation({
  args: { kind: previewKindValidator, locale: v.string() },
  returns: v.object({ previewId: v.id("siteLanguageImpactPreviews") }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const previewId = await startImpactPreviewInTransaction(
      ctx,
      owner,
      args.kind,
      args.locale
    )
    await ctx.scheduler.runAfter(
      0,
      internal.cms.multilingual.stepLanguageImpactPreview,
      { previewId, generation: IMPACT_PREVIEW_GENERATION }
    )
    return { previewId }
  },
})

async function canRunMultilingualStep(ctx: MutationCtx): Promise<boolean> {
  const gate = await resolveOptionalModuleGuardState(ctx, "multilingual")
  return gate.effective && gate.readiness === "ready"
}

/** One step plus its continuation or expiry; P11b measures this unit. */
export async function runPreviewStep(
  ctx: MutationCtx,
  previewId: Id<"siteLanguageImpactPreviews">,
  generation: number
): Promise<null> {
  const result = await stepImpactPreviewInTransaction(
    ctx,
    previewId,
    generation
  )
  if (result.kind === "continue") {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.multilingual.stepLanguageImpactPreview,
      { previewId, generation }
    )
  } else if (result.kind === "complete") {
    await ctx.scheduler.runAt(
      result.expiresAt,
      internal.cms.multilingual.expireLanguageImpactPreview,
      { previewId, generation }
    )
  }
  return null
}

export const stepLanguageImpactPreview = internalMutation({
  args: {
    previewId: v.id("siteLanguageImpactPreviews"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await canRunMultilingualStep(ctx))) return null
    return runPreviewStep(ctx, args.previewId, args.generation)
  },
})

export const expireLanguageImpactPreview = internalMutation({
  args: {
    previewId: v.id("siteLanguageImpactPreviews"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await expireImpactPreviewInTransaction(ctx, args.previewId, args.generation)
    return null
  },
})

export const listLanguageImpact = query({
  args: {
    previewId: v.id("siteLanguageImpactPreviews"),
    ordinal: v.number(),
  },
  returns: v.union(
    v.object({ stale: v.literal(true) }),
    v.object({
      stale: v.literal(false),
      ordinal: v.number(),
      pageCount: v.number(),
      section: disclosureSectionValidator,
      items: v.array(disclosureItemValidator),
      digest: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return listImpactPreviewPage(ctx, owner, args.previewId, args.ordinal)
  },
})

export const recordLanguageImpactReview = mutation({
  args: {
    previewId: v.id("siteLanguageImpactPreviews"),
    ordinal: v.number(),
    pageDigest: v.string(),
  },
  returns: v.union(
    v.object({ stale: v.literal(true) }),
    v.object({
      stale: v.literal(false),
      reviewedThroughOrdinal: v.number(),
      pageCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return recordImpactReviewInTransaction(
      ctx,
      owner,
      args.previewId,
      args.ordinal,
      args.pageDigest
    )
  },
})

// ─── Default migration (C3b) ────────────────────────────────────────────────

export const startDefaultLanguageMigration = mutation({
  args: {
    toLocale: v.string(),
    expectedAuthorityVersion: v.number(),
    expectedModuleConfigurationVersion: v.number(),
  },
  returns: v.object({ migrationId: v.id("siteDefaultLanguageMigrations") }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const migrationId = await startDefaultMigrationInTransaction(
      ctx,
      owner,
      args
    )
    await ctx.scheduler.runAfter(
      0,
      internal.cms.multilingual.stepDefaultLanguageMigration,
      { migrationId, generation: 1 }
    )
    return { migrationId }
  },
})

/**
 * U2: the silent one-step default change. Owner only; the caller is the
 * Languages screen after `prepareLanguageChange` has adopted a multi-locale
 * site. No migration, review or route rows; the proxy reads the new default.
 */
export const setDefaultLanguage = mutation({
  args: {
    toLocale: v.string(),
    expectedAuthorityVersion: v.number(),
    expectedModuleConfigurationVersion: v.number(),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), authorityVersion: v.number() }),
    v.object({
      ok: v.literal(false),
      code: v.literal("SITE_LANGUAGE_VERSION_CHANGED"),
    })
  ),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return setDefaultLanguageInTransaction(ctx, args)
  },
})

const migrationStepResultValidator = v.union(
  v.object({ kind: v.literal("noop") }),
  v.object({ kind: v.literal("continue"), generation: v.number() }),
  v.object({ kind: v.literal("restarted"), generation: v.number() }),
  v.object({ kind: v.literal("blocked"), blockers: v.number() }),
  v.object({
    kind: v.literal("blocked"),
    code: v.literal("DEFAULT_MIGRATION_TARGET_HOME_MISSING"),
  }),
  v.object({
    kind: v.literal("ready"),
    generation: v.number(),
    readinessVersion: v.number(),
  })
)

/** One step plus its continuation; P11c measures this unit. */
export async function runDefaultMigrationStep(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  generation: number
) {
  const result = await stepDefaultMigrationInTransaction(
    ctx,
    migrationId,
    generation
  )
  if (result.kind === "continue" || result.kind === "restarted") {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.multilingual.stepDefaultLanguageMigration,
      { migrationId, generation: result.generation }
    )
  }
  return result
}

export const stepDefaultLanguageMigration = internalMutation({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (!(await canRunMultilingualStep(ctx))) return null
    await runDefaultMigrationStep(ctx, args.migrationId, args.generation)
    return null
  },
})

/**
 * Owner resume: one bounded step of the current cursor phase. It never refuses
 * its own open migration (M6); another migration or generation is a no-op.
 */
export const continueDefaultLanguageMigration = mutation({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    expectedGeneration: v.number(),
  },
  returns: migrationStepResultValidator,
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return runDefaultMigrationStep(
      ctx,
      args.migrationId,
      args.expectedGeneration
    )
  },
})

const routeFilterValidator = v.union(
  v.literal("shadowed"),
  v.literal("manual"),
  v.literal("all")
)

const routeViewValidator = v.object({
  fromPath: v.string(),
  pageId: v.id("pages"),
  locale: v.string(),
  origin: v.union(
    v.literal("old_default_current"),
    v.literal("old_default_historical"),
    v.literal("carried")
  ),
  shadow: v.optional(
    v.union(v.literal("to_current"), v.literal("to_historical"))
  ),
  retiredAt: v.optional(v.number()),
  retiredReason: v.optional(
    v.union(v.literal("to_current"), v.literal("to_historical"))
  ),
  manualRule: v.optional(v.literal("shadowed")),
  capturedPath: v.optional(v.string()),
})

export const listDefaultLanguageRoutes = query({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    generation: v.number(),
    paginationOpts: paginationOptsValidator,
    filter: routeFilterValidator,
  },
  returns: paginationResultValidator(routeViewValidator),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    const migration = await ctx.db.get(args.migrationId)
    if (!migration) throw new ConvexError("LANGUAGE_PREVIEW_MISMATCH")
    const range = ctx.db
      .query("siteDefaultLanguageRoutes")
      .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
        q.eq("migrationId", args.migrationId).eq("generation", args.generation)
      )
    const filtered =
      args.filter === "shadowed"
        ? range.filter((q) => q.neq(q.field("shadow"), undefined))
        : args.filter === "manual"
          ? range.filter((q) => q.neq(q.field("manualRule"), undefined))
          : range
    const result = await filtered.paginate(args.paginationOpts)
    return {
      ...result,
      page: result.page.map((row) => ({
        fromPath: row.fromPath,
        pageId: row.pageId,
        locale: row.locale,
        origin: row.origin,
        ...(row.shadow === undefined ? {} : { shadow: row.shadow }),
        ...(row.retiredAt === undefined ? {} : { retiredAt: row.retiredAt }),
        ...(row.retiredReason === undefined
          ? {}
          : { retiredReason: row.retiredReason }),
        ...(row.manualRule === undefined ? {} : { manualRule: row.manualRule }),
        ...(row.capturedPath === undefined
          ? {}
          : { capturedPath: row.capturedPath }),
      })),
    }
  },
})

export const listDefaultMigrationDisclosure = query({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    generation: v.number(),
    ordinal: v.number(),
  },
  returns: v.union(
    v.object({ stale: v.literal(true) }),
    v.object({
      stale: v.literal(false),
      ordinal: v.number(),
      pageCount: v.number(),
      section: disclosureSectionValidator,
      items: v.array(disclosureItemValidator),
      digest: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return listDefaultMigrationDisclosurePage(
      ctx,
      args.migrationId,
      args.generation,
      args.ordinal
    )
  },
})

export const recordDefaultMigrationReview = mutation({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    expectedGeneration: v.number(),
    ordinal: v.number(),
    pageDigest: v.string(),
  },
  returns: v.union(
    v.object({ stale: v.literal(true) }),
    v.object({
      stale: v.literal(false),
      reviewedThroughOrdinal: v.number(),
      pageCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return recordDefaultMigrationReviewInTransaction(
      ctx,
      args.migrationId,
      args.expectedGeneration,
      args.ordinal,
      args.pageDigest
    )
  },
})

/** Step 5: one compare-and-set (ledger C3c.2a). */
export const activateDefaultLanguageMigration = mutation({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    expectedGeneration: v.number(),
    expectedReadinessVersion: v.number(),
    expectedAuthorityVersion: v.number(),
  },
  returns: v.object({ version: v.number(), locale: v.string() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    return activateDefaultMigrationInTransaction(ctx, args)
  },
})

/** Step 6: any open phase; no public change (ledger C3c.1). */
export const cancelDefaultLanguageMigration = mutation({
  args: {
    migrationId: v.id("siteDefaultLanguageMigrations"),
    expectedGeneration: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    await requireOwnerAndOptionalModule(ctx, "multilingual")
    await cancelDefaultMigrationInTransaction(
      ctx,
      args.migrationId,
      args.expectedGeneration
    )
    // Step 6: collection runs after the unchanged two-patch cancel (ledger
    // C3c.2b; closes the C3c.1 Deferral).
    await ctx.scheduler.runAfter(
      0,
      internal.cms.languageLifecycle.collectDefaultLanguageRoutes,
      { migrationId: args.migrationId }
    )
    return null
  },
})
