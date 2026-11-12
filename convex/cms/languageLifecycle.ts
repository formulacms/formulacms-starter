import { ConvexError, v } from "convex/values"
import {
  env,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server"
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { CMS_TAGS } from "../../lib/cms/tags"
import { requireInstallationOwner } from "../lib/access/policy"
import {
  collectStepInTransaction,
  sweepStepInTransaction,
  type CollectionArgs,
  type SweepSection,
} from "../lib/language/collection"
import {
  isLocalOrigin,
  readConfiguredLifecycleOrigin,
  type LifecycleIntent,
} from "../lib/language/lifecycle"
import { readAuthorityRows } from "../lib/language/state"
import {
  postAndRecordRevalidation,
  type RevalidationEndpoint,
} from "./revalidate"

// M05 M17 — durable lifecycle revalidation. Language and public-module
// lifecycle commits insert one `siteLanguageLifecycleIntents` row; this
// cron-driven worker copies the F08c claim/lease/retry pattern and walks the
// intent's phases. C1 owns `tags_and_layout` and `roots`; C3 adds the path
// phases and C5a the `sitemap_manifest` phase, which posts nothing and
// schedules the idempotent sitemap build request with its phase move. An
// intent is delivered only when every phase succeeded against one configured
// origin; with no origin it ends `unconfigured`, which is never reported as
// delivered.

export const LANGUAGE_LIFECYCLE_CLAIM_LIMIT = 8
export const LANGUAGE_LIFECYCLE_RETRY_DELAY_MS = 5 * 60 * 1000
export const LANGUAGE_LIFECYCLE_LEASE_MS = 15 * 60 * 1000
/** Normative contract constant (P19a): intents requeued per call. */
export const LANGUAGE_LIFECYCLE_REQUEUE_BATCH = 32
const LANGUAGE_LIFECYCLE_MAX_STEPS = 8
/** Route rows per `manifest_paths` step: three paths each, ≤ 128 posted. */
export const LANGUAGE_LIFECYCLE_MANIFEST_BATCH = 42
/** `N` publication states per `new_default_paths` step: one path each. */
export const LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH = 128
const PUBLIC_LAYOUT_PATTERN = "/(public)/[locale]"

type Phase = LifecycleIntent["phase"]
type Claim = {
  intentId: Id<"siteLanguageLifecycleIntents">
  attempts: number
}
type Step = {
  phase: Phase
  cursor: string | null
  origin: string | null
  paths: string[]
  layoutPaths: string[]
  tags: string[]
  nextPhase: Phase
  nextCursor: string | null
}

const phaseValidator = v.union(
  v.literal("tags_and_layout"),
  v.literal("roots"),
  v.literal("manifest_paths"),
  v.literal("new_default_paths"),
  v.literal("sitemap_manifest"),
  v.literal("complete")
)
const claimArgs = {
  intentId: v.id("siteLanguageLifecycleIntents"),
  attempts: v.number(),
}

export const claimLanguageLifecycleIntents = internalMutation({
  args: {},
  returns: v.array(v.object(claimArgs)),
  handler: async (ctx): Promise<Claim[]> => {
    const now = Date.now()
    const limit = LANGUAGE_LIFECYCLE_CLAIM_LIMIT
    const [pending, abandoned, failed] = await Promise.all([
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_status_and_updatedAt", (q) => q.eq("status", "pending"))
        .take(limit),
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_status_and_updatedAt", (q) =>
          q
            .eq("status", "running")
            .lt("updatedAt", now - LANGUAGE_LIFECYCLE_LEASE_MS)
        )
        .take(limit),
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_status_and_updatedAt", (q) =>
          q
            .eq("status", "failed")
            .lt("updatedAt", now - LANGUAGE_LIFECYCLE_RETRY_DELAY_MS)
        )
        .take(limit),
    ])
    const claims: Claim[] = []
    for (const intent of [...pending, ...abandoned, ...failed].slice(
      0,
      limit
    )) {
      const sameOperation = await ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", intent.operationId)
        )
        .take(2)
      if (sameOperation.length !== 1) {
        // A duplicate operation identity is corrupt state; never pick a row.
        await ctx.db.patch(intent._id, {
          status: "failed",
          lastErrorCode: "LANGUAGE_LIFECYCLE_INTENT_DUPLICATE",
          updatedAt: now,
        })
        continue
      }
      await ctx.db.patch(intent._id, {
        status: "running",
        attempts: intent.attempts + 1,
        updatedAt: now,
      })
      claims.push({ intentId: intent._id, attempts: intent.attempts + 1 })
    }
    return claims
  },
})

export const planLanguageLifecycleStep = internalQuery({
  args: claimArgs,
  returns: v.union(
    v.null(),
    v.object({
      phase: phaseValidator,
      cursor: v.union(v.string(), v.null()),
      origin: v.union(v.string(), v.null()),
      paths: v.array(v.string()),
      layoutPaths: v.array(v.string()),
      tags: v.array(v.string()),
      nextPhase: phaseValidator,
      nextCursor: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, { intentId, attempts }): Promise<Step | null> => {
    const intent = await ctx.db.get(intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== attempts
    ) {
      return null
    }
    const base = {
      phase: intent.phase,
      cursor: intent.cursor ?? null,
      origin: intent.origin ?? null,
    }
    if (intent.phase === "tags_and_layout") {
      return {
        ...base,
        paths: [],
        layoutPaths: [PUBLIC_LAYOUT_PATTERN],
        // Never `cms:media`: no lifecycle change moves a storage URL.
        tags: [CMS_TAGS.pages, CMS_TAGS.menus, CMS_TAGS.settings],
        nextPhase: "roots",
        nextCursor: null,
      }
    }
    if (intent.phase === "roots") {
      const settings = await ctx.db.query("siteSettings").take(2)
      const defaultLocale =
        settings.length === 1 ? settings[0]!.defaultLocale : null
      const prefixed = intent.locales
        .filter((locale) => locale !== defaultLocale)
        .map((locale) => `/${locale}`)
      return {
        ...base,
        paths: ["/", ...new Set(prefixed)],
        layoutPaths: [],
        tags: [],
        // A default migration is delivered only after its path phases.
        nextPhase:
          intent.operationKind === "default_migration"
            ? "manifest_paths"
            : afterPathPhases(intent),
        nextCursor: null,
      }
    }
    if (
      intent.phase === "manifest_paths" ||
      intent.phase === "new_default_paths"
    ) {
      return planDefaultMigrationPaths(ctx, intent, base)
    }
    if (intent.phase === "sitemap_manifest") {
      // Posts nothing: the advance requests the build (C5a, P19d).
      return {
        ...base,
        paths: [],
        layoutPaths: [],
        tags: [],
        nextPhase: "complete",
        nextCursor: null,
      }
    }
    // `complete`, or a phase whose owning chunk has not landed.
    return null
  },
})

/**
 * Every operation except a module toggle changes the language version, so it
 * ends with `sitemap_manifest` (C5a). Intents already past their path phases
 * when C5a landed are covered by the version-0 sitemap branch.
 */
function afterPathPhases(intent: LifecycleIntent): Step["nextPhase"] {
  return intent.operationKind === "module_toggle"
    ? "complete"
    : "sitemap_manifest"
}

function localePath(locale: string, path: string): string {
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}

/**
 * P19c (ledger C3c.2b-2). The two `default_migration` path phases page with
 * one `.paginate()` whose raw `continueCursor` is the intent's cursor. The
 * generation and `[D, N]` come from the intent, never from live state.
 * `manifest_paths` posts `p`, `/<D>p` and `/<N>p` for every row of the
 * generation, shadowed and retired rows included; `new_default_paths` posts
 * `/<N><path>` for every current `N` path. A cursor that no longer resumes
 * restarts its phase with a step that posts nothing, because a function may
 * run only one `.paginate()`. An intent without its migration fails closed.
 */
export async function planDefaultMigrationPaths(
  ctx: QueryCtx,
  intent: LifecycleIntent,
  base: Pick<Step, "phase" | "cursor" | "origin">
): Promise<Step | null> {
  const { migrationId, generation, locales } = intent
  if (
    intent.operationKind !== "default_migration" ||
    migrationId === undefined ||
    generation === undefined ||
    locales.length !== 2
  ) {
    return null
  }
  const [from, to] = locales as [string, string]
  const manifest = base.phase === "manifest_paths"
  const restart: Step = {
    ...base,
    paths: [],
    layoutPaths: [],
    tags: [],
    nextPhase: base.phase,
    nextCursor: null,
  }
  let paths: string[]
  let isDone: boolean
  let continueCursor: string
  try {
    if (manifest) {
      const result = await ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation", (q) =>
          q.eq("migrationId", migrationId).eq("generation", generation)
        )
        .paginate({
          numItems: LANGUAGE_LIFECYCLE_MANIFEST_BATCH,
          cursor: base.cursor,
        })
      paths = result.page.flatMap((row) => [
        row.fromPath,
        localePath(from, row.fromPath),
        localePath(to, row.fromPath),
      ])
      ;({ isDone, continueCursor } = result)
    } else {
      const result = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_locale_and_currentPath", (q) => q.eq("locale", to))
        .paginate({
          numItems: LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH,
          cursor: base.cursor,
        })
      paths = result.page.flatMap((state) =>
        state.currentPath === undefined
          ? []
          : [localePath(to, state.currentPath)]
      )
      ;({ isDone, continueCursor } = result)
    }
  } catch (error) {
    // Only a stored cursor can be unresumable; anything else is a real fault.
    if (base.cursor === null) throw error
    return restart
  }
  return {
    ...base,
    paths,
    layoutPaths: [],
    tags: [],
    nextPhase: isDone
      ? manifest
        ? "new_default_paths"
        : afterPathPhases(intent)
      : base.phase,
    nextCursor: isDone ? null : continueCursor,
  }
}

export const advanceLanguageLifecycleIntent = internalMutation({
  args: {
    ...claimArgs,
    fromPhase: phaseValidator,
    fromCursor: v.union(v.string(), v.null()),
    origin: v.string(),
    nextPhase: phaseValidator,
    nextCursor: v.union(v.string(), v.null()),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts ||
      intent.phase !== args.fromPhase ||
      (intent.cursor ?? null) !== args.fromCursor ||
      (intent.origin !== undefined && intent.origin !== args.origin)
    ) {
      return false
    }
    const delivered = args.nextPhase === "complete"
    if (args.fromPhase === "sitemap_manifest") {
      // Scheduled with the phase move, so the advance stays within the drain
      // row's reads. The request is idempotent: one build per language
      // version (P19d).
      await ctx.scheduler.runAfter(
        0,
        internal.cms.publication.requestSitemapManifestBuild,
        {}
      )
    }
    await ctx.db.patch(intent._id, {
      phase: args.nextPhase,
      cursor: delivered ? undefined : (args.nextCursor ?? undefined),
      origin: args.origin,
      status: delivered ? "delivered" : "running",
      lastErrorCode: undefined,
      updatedAt: Date.now(),
    })
    return true
  },
})

/** The configured origin changed between attempts: restart every phase. */
export const restartLanguageLifecycleIntent = internalMutation({
  args: { ...claimArgs, origin: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts ||
      intent.origin === args.origin
    ) {
      return false
    }
    await ctx.db.patch(intent._id, {
      phase: "tags_and_layout",
      cursor: undefined,
      origin: args.origin,
      updatedAt: Date.now(),
    })
    return true
  },
})

export const markLanguageLifecycleIntentUnconfigured = internalMutation({
  args: claimArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    // Terminal for this attempt and never delivered. The automatic re-arm
    // (A1) or the owner's requeue revives it once an origin exists.
    await ctx.db.patch(intent._id, {
      status: "unconfigured",
      lastErrorCode: "REVALIDATION_UNCONFIGURED",
      updatedAt: Date.now(),
    })
    return null
  },
})

/**
 * A2: delivery to a local origin failed. Quiet, never delivered, and not an
 * alarm. It stores the origin so the automatic re-arm can tell an origin
 * change from the same unreachable address.
 */
export const markLanguageLifecycleIntentLocalUnreachable = internalMutation({
  args: {
    ...claimArgs,
    origin: v.string(),
    errorCode: v.union(v.literal("http_error"), v.literal("network_error")),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    await ctx.db.patch(intent._id, {
      status: "local_unreachable",
      origin: args.origin,
      lastErrorCode:
        args.errorCode === "http_error"
          ? "REVALIDATION_HTTP_ERROR"
          : "REVALIDATION_NETWORK_ERROR",
      updatedAt: Date.now(),
    })
    return null
  },
})

export const failLanguageLifecycleIntent = internalMutation({
  args: {
    ...claimArgs,
    errorCode: v.union(
      v.literal("http_error"),
      v.literal("network_error"),
      v.literal("phase_unsupported")
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    await ctx.db.patch(intent._id, {
      status: "failed",
      lastErrorCode:
        args.errorCode === "http_error"
          ? "REVALIDATION_HTTP_ERROR"
          : args.errorCode === "network_error"
            ? "REVALIDATION_NETWORK_ERROR"
            : "LANGUAGE_LIFECYCLE_PHASE_UNSUPPORTED",
      updatedAt: Date.now(),
    })
    return null
  },
})

export const releaseLanguageLifecycleIntent = internalMutation({
  args: claimArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const intent = await ctx.db.get(args.intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== args.attempts
    ) {
      return null
    }
    await ctx.db.patch(intent._id, { status: "pending", updatedAt: Date.now() })
    return null
  },
})

/** The drain reads the origin through the same helper as the re-arm. */
export const readLanguageLifecycleOrigin = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> =>
    readConfiguredLifecycleOrigin(ctx),
})

async function resolveLifecycleTarget(
  ctx: ActionCtx
): Promise<RevalidationEndpoint | null> {
  const secret = env.REVALIDATE_SECRET
  if (!secret) return null
  const baseUrl: string | null = await ctx.runQuery(
    internal.cms.languageLifecycle.readLanguageLifecycleOrigin,
    {}
  )
  return baseUrl ? { baseUrl, secret } : null
}

async function runLanguageLifecycleIntent(
  ctx: ActionCtx,
  claim: Claim
): Promise<void> {
  for (let step = 0; step < LANGUAGE_LIFECYCLE_MAX_STEPS; step += 1) {
    const plan: Step | null = await ctx.runQuery(
      internal.cms.languageLifecycle.planLanguageLifecycleStep,
      claim
    )
    if (plan === null) {
      const intent = await ctx.runQuery(
        internal.cms.languageLifecycle.readLanguageLifecycleClaim,
        claim
      )
      if (intent && intent.phase !== "complete") {
        const failed: null = await ctx.runMutation(
          internal.cms.languageLifecycle.failLanguageLifecycleIntent,
          { ...claim, errorCode: "phase_unsupported" }
        )
        void failed
      }
      return
    }
    const target = await resolveLifecycleTarget(ctx)
    if (!target) {
      // Record the unconfigured attempt like every other revalidation caller.
      await postAndRecordRevalidation(ctx, null, "settings", {})
      const marked: null = await ctx.runMutation(
        internal.cms.languageLifecycle.markLanguageLifecycleIntentUnconfigured,
        claim
      )
      void marked
      return
    }
    if (plan.origin !== null && plan.origin !== target.baseUrl) {
      const restarted: boolean = await ctx.runMutation(
        internal.cms.languageLifecycle.restartLanguageLifecycleIntent,
        { ...claim, origin: target.baseUrl }
      )
      if (!restarted) return
      continue
    }
    // A phase restart or an empty page has nothing to purge (ledger C3c.2b-2).
    const empty =
      plan.paths.length === 0 &&
      plan.layoutPaths.length === 0 &&
      plan.tags.length === 0
    if (!empty) {
      const result = await postAndRecordRevalidation(ctx, target, "settings", {
        ...(plan.paths.length > 0 ? { paths: plan.paths } : {}),
        ...(plan.layoutPaths.length > 0
          ? { layoutPaths: plan.layoutPaths }
          : {}),
        ...(plan.tags.length > 0 ? { tags: plan.tags } : {}),
      })
      if (result.status !== "ok") {
        const errorCode =
          result.status === "http_error" ? "http_error" : "network_error"
        // Delivery is still attempted to local origins. Only a network error
        // there (no HTTP response: refused, DNS, timeout) ends the intent
        // quiet (A2). An HTTP error response proves the site answered, so it
        // fails and is retried like any other origin.
        const ended: null =
          result.status === "network_error" && isLocalOrigin(target.baseUrl)
          ? await ctx.runMutation(
              internal.cms.languageLifecycle
                .markLanguageLifecycleIntentLocalUnreachable,
              { ...claim, origin: target.baseUrl, errorCode }
            )
          : await ctx.runMutation(
              internal.cms.languageLifecycle.failLanguageLifecycleIntent,
              { ...claim, errorCode }
            )
        void ended
        return
      }
    }
    const advanced: boolean = await ctx.runMutation(
      internal.cms.languageLifecycle.advanceLanguageLifecycleIntent,
      {
        ...claim,
        fromPhase: plan.phase,
        fromCursor: plan.cursor,
        origin: target.baseUrl,
        nextPhase: plan.nextPhase,
        nextCursor: plan.nextCursor,
      }
    )
    if (!advanced || plan.nextPhase === "complete") return
  }
  const released: null = await ctx.runMutation(
    internal.cms.languageLifecycle.releaseLanguageLifecycleIntent,
    claim
  )
  void released
}

export const readLanguageLifecycleClaim = internalQuery({
  args: claimArgs,
  returns: v.union(v.null(), v.object({ phase: phaseValidator })),
  handler: async (ctx, { intentId, attempts }) => {
    const intent = await ctx.db.get(intentId)
    if (
      !intent ||
      intent.status !== "running" ||
      intent.attempts !== attempts
    ) {
      return null
    }
    return { phase: intent.phase }
  },
})

/** Cron entry point: drain a bounded batch of lifecycle intents. */
export const drainLanguageLifecycleIntents = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    // A1: undelivered intents restart by themselves once an origin exists.
    // Its own mutation, never part of a claim or advance; scheduled at most
    // once per run, and only when an origin is configured.
    if (await resolveLifecycleTarget(ctx)) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.languageLifecycle.rearmUndeliveredLifecycleIntents,
        {}
      )
    }
    const claims: Claim[] = await ctx.runMutation(
      internal.cms.languageLifecycle.claimLanguageLifecycleIntents,
      {}
    )
    for (const claim of claims) {
      await runLanguageLifecycleIntent(ctx, claim)
    }
    return null
  },
})

/**
 * Shared by the owner command and the automatic re-arm (A1): return a batch
 * of undelivered intents to `pending` with `origin`, restarting every phase.
 */
async function rearmRows(
  ctx: MutationCtx,
  rows: LifecycleIntent[],
  origin: string
): Promise<number> {
  const now = Date.now()
  for (const intent of rows) {
    await ctx.db.patch(intent._id, {
      status: "pending",
      phase: "tags_and_layout",
      cursor: undefined,
      origin,
      updatedAt: now,
    })
  }
  return rows.length
}

/**
 * A1/A2 automatic re-arm, scheduled by the drain: at most 32 intents per call
 * in all, nothing with no configured origin, at most three ranges and one
 * settings read. `unconfigured` intents come first, oldest first; then
 * `local_unreachable` intents whose stored origin differs from the current
 * one (the range below it, then the range above it, on
 * `by_status_and_origin`). An unchanged origin is never touched, so the
 * re-arm cannot loop over an unreachable local site. It schedules one drain
 * run only when it re-armed at least one intent.
 */
export const rearmUndeliveredLifecycleIntents = internalMutation({
  args: {},
  returns: v.object({ requeued: v.number(), moreRemain: v.boolean() }),
  handler: async (ctx) => {
    const origin = await readConfiguredLifecycleOrigin(ctx)
    if (!origin) return { requeued: 0, moreRemain: false }
    // The ceiling is 32 intents in all (33 documents with the settings read):
    // no lookahead. A drain follows whenever anything was re-armed, so the
    // chain continues without a "more remain" signal.
    const capacity = LANGUAGE_LIFECYCLE_REQUEUE_BATCH
    const rows: LifecycleIntent[] = await ctx.db
      .query("siteLanguageLifecycleIntents")
      .withIndex("by_status_and_updatedAt", (q) =>
        q.eq("status", "unconfigured")
      )
      .take(capacity)
    if (rows.length < capacity) {
      rows.push(
        ...(await ctx.db
          .query("siteLanguageLifecycleIntents")
          .withIndex("by_status_and_origin", (q) =>
            q
              .eq("status", "local_unreachable")
              .gt("origin", "")
              .lt("origin", origin)
          )
          .take(capacity - rows.length))
      )
    }
    if (rows.length < capacity) {
      rows.push(
        ...(await ctx.db
          .query("siteLanguageLifecycleIntents")
          .withIndex("by_status_and_origin", (q) =>
            q.eq("status", "local_unreachable").gt("origin", origin)
          )
          .take(capacity - rows.length))
      )
    }
    const requeued = await rearmRows(ctx, rows, origin)
    if (requeued > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.cms.languageLifecycle.drainLanguageLifecycleIntents,
        {}
      )
    }
    return { requeued, moreRemain: false }
  },
})

/**
 * Owner "Push updates now" / Retry (R5-H3; A2; B1): requeue one bounded batch
 * of undelivered intents once an origin is configured, one status per call,
 * one range: `unconfigured` first, then `failed` (a real delivery failure,
 * retried now instead of after the automatic delay), then the quiet
 * `local_unreachable` ones; oldest first. Running claims are never touched.
 * The caller repeats the call until nothing is requeued. Idempotent: only
 * undelivered rows are touched. With no origin it returns a structured
 * `REVALIDATION_UNCONFIGURED` result (an expected state, not an error).
 */
export const requeueUndeliveredLifecycleIntents = mutation({
  args: {},
  returns: v.union(
    v.object({ requeued: v.number(), moreRemain: v.boolean() }),
    v.object({
      ok: v.literal(false),
      code: v.literal("REVALIDATION_UNCONFIGURED"),
    })
  ),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    const origin = await readConfiguredLifecycleOrigin(ctx)
    if (!origin) {
      return { ok: false as const, code: "REVALIDATION_UNCONFIGURED" as const }
    }
    const batchOf = (
      status: "unconfigured" | "failed" | "local_unreachable",
      count: number
    ) =>
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status))
        .take(count)
    const order = ["unconfigured", "failed", "local_unreachable"] as const
    let rows: LifecycleIntent[] = []
    let chosen = -1
    for (let index = 0; index < order.length; index += 1) {
      rows = await batchOf(order[index]!, LANGUAGE_LIFECYCLE_REQUEUE_BATCH + 1)
      if (rows.length > 0) {
        chosen = index
        break
      }
    }
    // Later statuses wait behind this batch when any of them has a row.
    let laterWaits = false
    if (chosen >= 0 && rows.length <= LANGUAGE_LIFECYCLE_REQUEUE_BATCH) {
      for (const status of order.slice(chosen + 1)) {
        if ((await batchOf(status, 1)).length > 0) {
          laterWaits = true
          break
        }
      }
    }
    const requeued = await rearmRows(
      ctx,
      rows.slice(0, LANGUAGE_LIFECYCLE_REQUEUE_BATCH),
      origin
    )
    return {
      requeued,
      moreRemain: rows.length > LANGUAGE_LIFECYCLE_REQUEUE_BATCH || laterWaits,
    }
  },
})

const intentSummaryValidator = v.object({
  operationId: v.string(),
  operationKind: v.string(),
  status: v.string(),
  lastErrorCode: v.union(v.string(), v.null()),
})

/** A failed intent is a lasting failure from its third attempt on (A2). */
const LANGUAGE_LIFECYCLE_LASTING_FAILURE_ATTEMPTS = 3

/**
 * Aggregate lifecycle status. `updating` covers every intent, whatever its
 * authority version: any pending, running or failed intent. The delivery
 * fields read only intents of the current `siteLanguageAuthority.version`
 * (A2): `notDelivered` while one is `unconfigured`, `failing` while one is
 * `failed` after its third attempt, and `localUnreachable` while one ended
 * quiet against a local origin. With `operationId`, that intent's own status
 * and last error code are reported whatever its version (R3-H3, R4-H3).
 */
export const getLanguageLifecycleStatus = query({
  args: { operationId: v.optional(v.string()) },
  returns: v.object({
    updating: v.boolean(),
    notDelivered: v.boolean(),
    failing: v.boolean(),
    localUnreachable: v.boolean(),
    oldestUndelivered: v.union(intentSummaryValidator, v.null()),
    operation: v.union(intentSummaryValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const probe = (status: LifecycleIntent["status"]) =>
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_status_and_updatedAt", (q) => q.eq("status", status))
        .take(1)
    const authority = await readAuthorityRows(ctx)
    // No authority row is the version-0 compatibility version.
    const version = authority.length === 1 ? authority[0]!.version : 0
    const current = (status: LifecycleIntent["status"], count: number) =>
      ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_capturedAuthorityVersion_and_status", (q) =>
          q.eq("capturedAuthorityVersion", version).eq("status", status)
        )
        .take(count)
    const [
      pending,
      running,
      failed,
      unconfigured,
      currentFailed,
      currentLocal,
    ] = await Promise.all([
      probe("pending"),
      probe("running"),
      probe("failed"),
      current("unconfigured", 1),
      // Bounded: realistic sites hold a handful of failed intents.
      current("failed", 32),
      current("local_unreachable", 1),
    ])
    const summary = (intent: LifecycleIntent) => ({
      operationId: intent.operationId,
      operationKind: intent.operationKind,
      status: intent.status,
      lastErrorCode: intent.lastErrorCode ?? null,
    })
    let operation = null
    if (args.operationId !== undefined) {
      const rows = await ctx.db
        .query("siteLanguageLifecycleIntents")
        .withIndex("by_operationId", (q) =>
          q.eq("operationId", args.operationId!)
        )
        .take(2)
      operation = rows.length === 1 ? summary(rows[0]!) : null
    }
    return {
      updating: pending.length + running.length + failed.length > 0,
      notDelivered: unconfigured.length > 0,
      failing: currentFailed.some(
        (intent) =>
          intent.attempts >= LANGUAGE_LIFECYCLE_LASTING_FAILURE_ATTEMPTS
      ),
      localUnreachable: currentLocal.length > 0,
      oldestUndelivered: unconfigured[0] ? summary(unconfigured[0]) : null,
      operation,
    }
  },
})

// ─── Collection (C3c.2b) ────────────────────────────────────────────────────

// Convex needs an object validator; exactly one subject is checked below.
const collectionArgs = {
  migrationId: v.optional(v.id("siteDefaultLanguageMigrations")),
  previewId: v.optional(v.id("siteLanguageImpactPreviews")),
  section: v.optional(v.union(v.literal("routes"), v.literal("pages"))),
  limit: v.optional(v.number()),
}

/** One collection step plus its continuation; P11c measures this unit. */
export async function runCollectionStep(
  ctx: MutationCtx,
  args: CollectionArgs
) {
  const result = await collectStepInTransaction(ctx, args)
  if (result.kind === "continue") {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.languageLifecycle.collectDefaultLanguageRoutes,
      result.next
    )
  }
  return result
}

/**
 * Deletes route rows and disclosure pages of never-pointed generations, and
 * disclosure pages of stale or expired previews, in bounded steps (contract
 * Delayed work; ledger C3c.2b). Language domain: it runs with the module off.
 */
export const collectDefaultLanguageRoutes = internalMutation({
  args: collectionArgs,
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { migrationId, previewId, section, limit } = args
    if ((migrationId === undefined) === (previewId === undefined)) {
      throw new ConvexError("LANGUAGE_COLLECTION_SUBJECT_INVALID")
    }
    await runCollectionStep(
      ctx,
      migrationId !== undefined
        ? { migrationId, section, limit }
        : { previewId: previewId!, limit }
    )
    return null
  },
})

const sweepSectionValidator = v.union(
  v.literal("migrations"),
  v.literal("stale_previews"),
  v.literal("expired_previews")
)

/** One sweep step: schedules collection per subject, then itself. */
export async function runCollectionSweepStep(
  ctx: MutationCtx,
  section: SweepSection,
  cursor: string | null
) {
  const result = await sweepStepInTransaction(ctx, section, cursor)
  for (const subject of result.subjects) {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.languageLifecycle.collectDefaultLanguageRoutes,
      subject
    )
  }
  if (result.next) {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.languageLifecycle.sweepDefaultLanguageCollection,
      result.next
    )
  }
  return result
}

/** Nightly cron entry point (contract Delayed work, registration). */
export const sweepDefaultLanguageCollection = internalMutation({
  args: {
    section: v.optional(sweepSectionValidator),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await runCollectionSweepStep(
      ctx,
      args.section ?? "migrations",
      args.cursor ?? null
    )
    return null
  },
})
