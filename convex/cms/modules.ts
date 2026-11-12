import { ConvexError, v, type Infer } from "convex/values"
import { MODULE_CATALOG } from "../../lib/modules/catalog"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { mutation, query } from "../_generated/server"
import { requireInstallationOwner } from "../lib/access/policy"
import { readPublicationAuthority } from "../lib/publishing/snapshots"
import { requireOwnerPrincipal } from "../lib/access/owner"
import {
  previewModuleTransition,
  type ModuleTransitionRequest,
} from "../lib/modules/lifecycle"
import {
  readModuleState,
  resolveEffectiveModuleState,
  resolveEffectiveModuleStateFromEnabled,
  resolveModuleReadiness,
} from "../lib/modules/state"
import {
  readRedirectsDisableBlockers,
  type RedirectRulesBlocker,
} from "../lib/redirects/disableBlocker"
import {
  recordPublicChange,
  type FreshnessDomain,
} from "../lib/language/freshness"
import { insertModuleToggleIntent } from "../lib/language/lifecycle"
import {
  commandTokensValidator,
  readCommandEntry,
  requireFreshEntryTokens,
  returnToSingleLanguageInTransaction,
  readMultilingualToggleBlockers,
  type MultilingualModuleBlocker,
} from "../lib/language/multilingual"

const transitionRequestValidator = v.object({
  moduleId: v.string(),
  enabled: v.boolean(),
})

const effectiveModuleStateValidator = v.object({
  moduleId: v.string(),
  available: v.literal(true),
  enabled: v.boolean(),
  effective: v.boolean(),
  readiness: v.union(v.literal("ready"), v.literal("needs_setup")),
  setup: v.union(v.literal("not_required"), v.literal("required")),
})

// The closed blocker union: static dependency blockers from the lifecycle
// preview, plus module-owned blockers (Redirects retained rules, M01d;
// Multilingual language state, M05).
const transitionBlockerValidator = v.union(
  v.object({
    code: v.union(
      v.literal("DEPENDENCY_NOT_LISTED"),
      v.literal("DEPENDANT_ENABLED"),
      v.literal("REQUIRED_MODULE")
    ),
    moduleId: v.string(),
    relatedModuleId: v.string(),
  }),
  v.object({
    code: v.literal("MULTILINGUAL_AUTHORITY_ACTIVE"),
    moduleId: v.literal("multilingual"),
    locales: v.array(v.string()),
  }),
  v.object({
    code: v.literal("LANGUAGE_OPERATION_OPEN"),
    moduleId: v.literal("multilingual"),
    kind: v.union(
      v.literal("language_transition"),
      v.literal("default_migration")
    ),
  }),
  v.object({
    code: v.literal("LANGUAGE_STATE_INVALID"),
    moduleId: v.literal("multilingual"),
  }),
  v.object({
    code: v.literal("REDIRECT_RULES_PRESENT"),
    moduleId: v.literal("redirects"),
    ruleCount: v.number(),
    moreRules: v.boolean(),
    rules: v.array(
      v.object({
        ruleId: v.id("redirects"),
        fromPath: v.string(),
        locale: v.optional(v.string()),
      })
    ),
  })
)

const transitionPreviewValidator = v.object({
  multilingualCommandTokens: v.optional(
    v.union(commandTokensValidator, v.null())
  ),
  configurationVersion: v.number(),
  changes: v.array(
    v.object({
      moduleId: v.string(),
      fromEnabled: v.boolean(),
      toEnabled: v.boolean(),
    })
  ),
  requiredDependencies: v.array(v.string()),
  blockers: v.array(transitionBlockerValidator),
  readiness: v.array(effectiveModuleStateValidator),
})

const commitResultValidator = transitionPreviewValidator.extend({
  committed: v.boolean(),
})

const visibilityModuleValidator = v.object({
  id: effectiveModuleStateValidator.fields.moduleId,
  outcome: v.union(
    v.literal("off"),
    v.literal("on"),
    v.literal("needs_setup"),
    v.literal("error")
  ),
  setup: v.optional(v.array(effectiveModuleStateValidator.fields.setup)),
  errorCode: v.optional(v.literal("CMS_MODULE_READINESS_FAILED")),
})

/** Committed visibility only: no draft changes, blockers or external probes. */
export const effective = query({
  args: {},
  returns: v.object({
    version: transitionPreviewValidator.fields.configurationVersion,
    modules: v.array(visibilityModuleValidator),
  }),
  handler: async (ctx) => {
    await requireOwnerPrincipal(ctx)
    const snapshot = await resolveEffectiveModuleState(
      ctx,
      "effective-readiness"
    )
    const failed = new Set(snapshot.readinessFailures)
    const optionalIds = new Set<string>(
      MODULE_CATALOG.filter((module) => !module.required).map(
        (module) => module.id
      )
    )
    return {
      version: snapshot.configurationVersion,
      modules: snapshot.modules
        .filter((module) => optionalIds.has(module.moduleId))
        .map((module): Infer<typeof visibilityModuleValidator> => {
          if (!module.effective) return { id: module.moduleId, outcome: "off" }
          if (failed.has(module.moduleId))
            return {
              id: module.moduleId,
              outcome: "error",
              errorCode: "CMS_MODULE_READINESS_FAILED",
            }
          if (module.readiness === "needs_setup")
            return {
              id: module.moduleId,
              outcome: "needs_setup",
              setup: [module.setup],
            }
          return { id: module.moduleId, outcome: "on" }
        }),
    }
  },
})

type TransitionPreview = ReturnType<typeof previewModuleTransition>

function rejectBlockedTransition(): never {
  throw new ConvexError("CMS_MODULE_TRANSITION_BLOCKED")
}

/**
 * Module-owned disable blockers (recovery design RG11). Each is a direct
 * static call, evaluated only when the computed transition disables its
 * module, never for an unrelated or no-op request. A throw propagates, so the
 * preview fails and the commit rolls back.
 */
type ModuleOwnedBlocker = RedirectRulesBlocker | MultilingualModuleBlocker

async function readModuleOwnedBlockers(
  ctx: QueryCtx | MutationCtx,
  preview: TransitionPreview
): Promise<ModuleOwnedBlocker[]> {
  const disablesRedirects = preview.changes.some(
    (change) =>
      change.moduleId === "redirects" && change.fromEnabled && !change.toEnabled
  )
  // M05: evaluated only when the request toggles `multilingual`.
  const multilingualChange = preview.changes.find(
    (change) => change.moduleId === "multilingual"
  )
  return [
    ...(disablesRedirects ? await readRedirectsDisableBlockers(ctx) : []),
    ...(multilingualChange
      ? await readMultilingualToggleBlockers(ctx, multilingualChange.toEnabled)
      : []),
  ]
}

/** Exact Apply plan; the raw transition writer retains its own blockers. */
async function readApplyPlan(
  ctx: QueryCtx | MutationCtx,
  preview: TransitionPreview
) {
  const blockers = await readModuleOwnedBlockers(ctx, preview)
  const disabling = preview.changes.some(
    (change) =>
      change.moduleId === "multilingual" &&
      change.fromEnabled &&
      !change.toEnabled
  )
  if (
    !disabling ||
    blockers.some((blocker) => blocker.code === "LANGUAGE_STATE_INVALID")
  )
    return { blockers, entry: null }
  const entry = await readCommandEntry(ctx, {
    requireSnapshotAuthority: false,
    moduleConfigurationVersion: preview.configurationVersion,
  })
  if (entry.state.kind === "multilingual" && entry.state.locales.length === 1) {
    if ((await readPublicationAuthority(ctx)) !== "snapshot_active")
      throw new ConvexError("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
    return {
      entry,
      blockers: blockers.filter(
        (blocker) => blocker.code !== "MULTILINGUAL_AUTHORITY_ACTIVE"
      ),
    }
  }
  return { blockers, entry }
}

function serializablePreview(
  preview: TransitionPreview,
  moduleOwnedBlockers: readonly ModuleOwnedBlocker[]
): Infer<typeof transitionPreviewValidator> {
  return {
    configurationVersion: preview.configurationVersion,
    changes: preview.changes.map((change) => ({ ...change })),
    requiredDependencies: [...preview.requiredDependencies],
    blockers: [
      ...preview.blockers.map((blocker) => ({ ...blocker })),
      ...moduleOwnedBlockers.map((blocker) =>
        blocker.code === "REDIRECT_RULES_PRESENT"
          ? { ...blocker, rules: blocker.rules.map((rule) => ({ ...rule })) }
          : blocker.code === "MULTILINGUAL_AUTHORITY_ACTIVE"
            ? { ...blocker, locales: [...blocker.locales] }
            : { ...blocker }
      ),
    ],
    readiness: preview.readiness.map((module) => ({ ...module })),
  }
}

/** Owner-facing dry run. It has no write side effect and exposes no secrets. */
export const preview = query({
  args: { changes: v.array(transitionRequestValidator) },
  returns: transitionPreviewValidator,
  handler: async (ctx, args) => {
    await requireOwnerPrincipal(ctx)
    const preview = previewModuleTransition(
      await resolveEffectiveModuleState(ctx),
      args.changes as readonly ModuleTransitionRequest[]
    )
    const plan = await readApplyPlan(ctx, preview)
    return {
      ...serializablePreview(preview, plan.blockers),
      multilingualCommandTokens: plan.entry?.tokens ?? null,
    }
  },
})

export type ModuleTransitionCommitInput = {
  expectedConfigurationVersion: number
  changes: readonly ModuleTransitionRequest[]
}

export type ModuleTransitionCommitResult = Infer<typeof commitResultValidator>

/**
 * Recomputes the full transition in the caller's write transaction. The
 * expected revision protects against stale previews, while a no-op at the
 * current revision is intentionally idempotent and does not advance the
 * revision. Module-owned blockers are re-read here, so a rule created after
 * the preview still blocks the commit. The caller authorizes first. A throw
 * propagates, so a larger transaction (the combined language commands)
 * rolls back every earlier write.
 */
export async function commitModuleTransitionInTransaction(
  ctx: MutationCtx,
  input: ModuleTransitionCommitInput
): Promise<ModuleTransitionCommitResult> {
  if (
    !Number.isSafeInteger(input.expectedConfigurationVersion) ||
    input.expectedConfigurationVersion < 0
  ) {
    throw new ConvexError("CMS_MODULE_CONFIGURATION_VERSION_INVALID")
  }
  const persisted = await readModuleState(ctx)
  if (persisted.configurationVersion !== input.expectedConfigurationVersion) {
    throw new ConvexError("CMS_MODULE_CONFIGURATION_STALE")
  }

  const current = resolveEffectiveModuleStateFromEnabled(
    persisted.configurationVersion,
    persisted.enabledModuleIds,
    await resolveModuleReadiness(ctx, persisted.enabledModuleIds)
  )
  const preview = previewModuleTransition(current, input.changes)
  const moduleOwnedBlockers = await readModuleOwnedBlockers(ctx, preview)
  // M5: a `multilingual` toggle in invalid language state refuses with the
  // integrity code before any write.
  if (
    moduleOwnedBlockers.some(
      (blocker) => blocker.code === "LANGUAGE_STATE_INVALID"
    )
  ) {
    throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  if (preview.blockers.length > 0 || moduleOwnedBlockers.length > 0) {
    rejectBlockedTransition()
  }

  if (preview.changes.length === 0) {
    return { ...serializablePreview(preview, []), committed: false }
  }

  const enabledIds = new Set(
    preview.readiness
      .filter((module) => module.enabled)
      .map((module) => module.moduleId)
  )
  const enabledModules = MODULE_CATALOG.filter(
    (descriptor) => !descriptor.required && enabledIds.has(descriptor.id)
  ).map((descriptor) => ({
    moduleId: descriptor.id,
    configVersion: descriptor.configVersion,
  }))

  if (persisted.configurationVersion >= Number.MAX_SAFE_INTEGER) {
    throw new ConvexError("CMS_MODULE_CONFIGURATION_VERSION_INVALID")
  }
  const nextConfigurationVersion = persisted.configurationVersion + 1
  const existingRows = await ctx.db
    .query("cmsModuleState")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  if (existingRows.length > 1) {
    throw new ConvexError("CMS_MODULE_STATE_INVALID")
  }
  if (existingRows.length === 0) {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: nextConfigurationVersion,
      enabledModules,
    })
  } else {
    await ctx.db.patch(existingRows[0]!._id, {
      configurationVersion: nextConfigurationVersion,
      enabledModules,
    })
  }
  // F09 invariant 6: a module-state change that changes a public
  // contribution advances an open language transition's source public set.
  const publicContributionChanged = MODULE_CATALOG.some(
    (descriptor) =>
      !descriptor.required &&
      descriptor.contributions.some((contribution) =>
        contribution.startsWith("public.")
      ) &&
      persisted.enabledModuleIds.has(descriptor.id) !==
        enabledIds.has(descriptor.id)
  )
  // M05 generic public-module hook (M17, M2 exception 2): one durable
  // lifecycle intent whenever a module with a `public.*` contribution
  // changes effective state.
  const effectiveBefore = new Map(
    current.modules.map((module) => [module.moduleId, module.effective])
  )
  const publicEffectiveChanged = preview.readiness.some(
    (module) =>
      MODULE_CATALOG.find(
        (descriptor) => descriptor.id === module.moduleId
      )?.contributions.some((contribution) =>
        contribution.startsWith("public.")
      ) === true && effectiveBefore.get(module.moduleId) !== module.effective
  )
  // M05 domains A and B (site): any public contribution changing effective
  // state advances the publication set; a `public.routing` one also advances
  // route claims.
  const routingEffectiveChanged = preview.readiness.some(
    (module) =>
      MODULE_CATALOG.find(
        (descriptor) => descriptor.id === module.moduleId
      )?.contributions.some(
        (contribution) => contribution === "public.routing"
      ) === true && effectiveBefore.get(module.moduleId) !== module.effective
  )
  if (publicContributionChanged || publicEffectiveChanged) {
    const domains: FreshnessDomain[] = []
    if (routingEffectiveChanged) domains.push("route_claims")
    if (publicEffectiveChanged) domains.push("publication_set")
    await recordPublicChange(ctx, {
      source: publicContributionChanged,
      scopes: [{ domains }],
    })
  }
  if (publicEffectiveChanged) {
    await insertModuleToggleIntent(ctx, nextConfigurationVersion)
  }

  return {
    ...serializablePreview(preview, []),
    configurationVersion: nextConfigurationVersion,
    committed: true,
  }
}

/** Owner command: authorizes, then commits one module transition. */
export const commit = mutation({
  args: {
    expectedConfigurationVersion: v.number(),
    changes: v.array(transitionRequestValidator),
    multilingualCommandTokens: v.optional(
      v.union(commandTokensValidator, v.null())
    ),
  },
  returns: commitResultValidator,
  handler: async (ctx, args) => {
    await requireOwnerPrincipal(ctx)
    if (
      args.changes.some(
        (change) => change.moduleId === "multilingual" && !change.enabled
      )
    ) {
      const persisted = await readModuleState(ctx)
      if (
        !Number.isSafeInteger(args.expectedConfigurationVersion) ||
        args.expectedConfigurationVersion < 0
      )
        throw new ConvexError("CMS_MODULE_CONFIGURATION_VERSION_INVALID")
      if (persisted.configurationVersion !== args.expectedConfigurationVersion)
        throw new ConvexError("CMS_MODULE_CONFIGURATION_STALE")
      const transition = previewModuleTransition(
        await resolveEffectiveModuleState(ctx),
        args.changes
      )
      const plan = await readApplyPlan(ctx, transition)
      if (
        plan.blockers.some(
          (blocker) => blocker.code === "LANGUAGE_STATE_INVALID"
        )
      )
        throw new ConvexError("SITE_LANGUAGE_AUTHORITY_INVALID")
      if (plan.entry) {
        await requireInstallationOwner(ctx)
        const expected = args.multilingualCommandTokens
        if (!expected) throw new ConvexError("LANGUAGE_OPERATION_STALE")
        requireFreshEntryTokens(plan.entry.tokens, expected, true)
      }
      if (transition.blockers.length || plan.blockers.length)
        rejectBlockedTransition()
      if (plan.entry?.state.kind === "multilingual")
        await returnToSingleLanguageInTransaction(ctx, plan.entry.state.version)
    }
    return commitModuleTransitionInTransaction(ctx, {
      expectedConfigurationVersion: args.expectedConfigurationVersion,
      changes: args.changes as readonly ModuleTransitionRequest[],
    })
  },
})
