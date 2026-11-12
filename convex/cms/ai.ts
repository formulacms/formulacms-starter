import { ConvexError, v } from "convex/values"
import { env, query, type QueryCtx } from "../_generated/server"
import {
  API_PROVIDERS,
  type ApiModelCapability,
  type ReasoningEffort,
  type TaskProfile,
  type SafeGenerationError,
} from "../../lib/ai/execution-contract"
import {
  RUNTIME_TASK_PROFILES,
  TASK_PROFILE_REQUIREMENTS,
  taskProfileTuple,
} from "../../lib/ai/task-profiles"
import { OPENROUTER_CATALOG_MAX_MODELS } from "../../lib/ai/openrouter-catalog"
import { OPENROUTER_API_CATALOG } from "../../lib/ai/capabilities/openrouter-api"
import { ANTHROPIC_API_CATALOG } from "../../lib/ai/capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "../../lib/ai/capabilities/openai-api"
import { requireOwnerAndOptionalModule, readModuleState, resolveOptionalModuleGuardState } from "../lib/modules/state"
import {
  resolveRuntimeSelection,
  type RuntimeProviderAvailability,
} from "../lib/aiConfig"
import {
  reasoningEffortValidator,
  providerModelSelectionsValidator,
  runtimeApiProviderValidator,
  runtimeStatusValidator,
  taskDefaultsValidator,
  taskProfileValidator,
} from "../lib/aiValidators"
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
} from "../_generated/server"
import type { Infer, Value } from "convex/values"
import { internal } from "../_generated/api"
import { requireInstallationOwner } from "../lib/access/policy"
import {
  aiAttemptAdmissionRequestValidator,
  aiAttemptAdmissionValidator,
  aiAttemptSettlementValidator,
  aiAttemptReceiptValidator,
  aiPriceQuoteValidator,
  providerObservationValidator,
} from "../lib/aiValidators"
import {
  effectiveMonthlyCapMicros,
  quote,
  estimateMicros,
  chargeMicros,
  moneyInteger,
} from "../../lib/ai/price-quote"
import { MAX_OUTPUT_TOKENS } from "../../lib/ai/task-profiles"
import type {
  AttemptAdmission,
  AttemptReceipt,
} from "../../lib/ai/accounting-contract"
import type { Doc, Id } from "../_generated/dataModel"
import { runtimeProviderKey, resolveAiSettingsStatus, requireAiTranslationModule, readRuntimeProviderConnection } from "../lib/ai"
import { hashOwnerClaim } from "../lib/ownerClaim"

function availability(): RuntimeProviderAvailability {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY?.trim()),
    anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
  }
}

/** Cheap reactive gate used by existing authoring affordances. */
export const isConfigured = query({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const { enabledModuleIds } = await readModuleState(ctx)
    return (await resolveAiSettingsStatus(ctx, enabledModuleIds)).assistants.some((assistant) => assistant.ready)
  },
})

const profileProjectionValidator = v.object({
  profile: taskProfileValidator,
  model: v.string(),
  reasoning: v.union(reasoningEffortValidator, v.null()),
})

const providerProjectionValidator = v.object({
  id: runtimeApiProviderValidator,
  available: v.boolean(),
  profiles: v.array(profileProjectionValidator),
  selections: v.array(
    v.object({
      model: v.string(),
      name: v.optional(v.string()),
      reasoning: v.union(reasoningEffortValidator, v.null()),
      supportedProfiles: v.array(taskProfileValidator),
      siteDefaultEligible: v.boolean(),
      /** USD per one million tokens (input/output). Present when the provider
       *  catalog reports pricing (OpenRouter today). Display only. */
      pricePerM: v.optional(
        v.object({ inputPerM: v.number(), outputPerM: v.number() })
      ),
    })
  ),
})

function filterKnownTaskDefaults<T>(raw: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(raw)) {
    if ((RUNTIME_TASK_PROFILES as readonly string[]).includes(key)) {
      out[key] = value
    }
  }
  return out
}

function catalogFor(provider: (typeof API_PROVIDERS)[number]) {
  if (provider === "openrouter") return OPENROUTER_API_CATALOG
  if (provider === "anthropic") return ANTHROPIC_API_CATALOG
  return OPENAI_API_CATALOG
}

type NamedCapability = ApiModelCapability & { readonly name?: string }

function capabilitySupportsProfile(
  capability: ApiModelCapability,
  reasoning: ReasoningEffort | null,
  profile: TaskProfile
): boolean {
  const requirements = TASK_PROFILE_REQUIREMENTS[profile]
  const inputModalities = new Set(capability.inputModalities)
  if (
    !requirements.inputModalities.every((modality) =>
      inputModalities.has(modality)
    ) ||
    (requirements.structuredOutput && !capability.structuredOutput)
  ) {
    return false
  }
  if (profile === "mechanical-translation") return reasoning === "high"
  if (profile === "vision-spec" || profile === "renderer-jsx") {
    return (
      reasoning !== null &&
      (["high", "xhigh", "max"] as const).includes(
        reasoning as "high" | "xhigh" | "max"
      )
    )
  }
  return true
}

function selectionProjections(
  provider: (typeof API_PROVIDERS)[number],
  openRouterCatalog?: Record<string, NamedCapability>
) {
  const catalog =
    provider === "openrouter" && openRouterCatalog
      ? openRouterCatalog
      : catalogFor(provider)
  return Object.entries(catalog).flatMap(([model, capability]) => {
    const pricePerM = capability.pricing
      ? {
          inputPerM: capability.pricing.inputPerM,
          outputPerM: capability.pricing.outputPerM,
        }
      : undefined
    const efforts =
      capability.reasoning.kind === "effort"
        ? capability.reasoning.supportedEfforts
        : [null]
    return efforts.map((reasoning: ReasoningEffort | null) => {
      const supportedProfiles = RUNTIME_TASK_PROFILES.filter((profile) =>
        capabilitySupportsProfile(capability, reasoning, profile)
      )
      return {
        model,
        ...(capability.name ? { name: capability.name } : {}),
        reasoning,
        supportedProfiles,
        siteDefaultEligible:
          supportedProfiles.length === RUNTIME_TASK_PROFILES.length,
        ...(pricePerM ? { pricePerM } : {}),
      }
    })
  })
}

/**
 * F01-operation-gated committed catalog and secret-free Production AI status.
 * No live provider discovery occurs here and no credential value is returned.
 */
export const getModelsSettings = query({
  args: {},
  returns: v.object({
    runtime: runtimeStatusValidator,
    providerDefaults: providerModelSelectionsValidator,
    taskDefaults: taskDefaultsValidator,
    providers: v.array(providerProjectionValidator),
    openRouterCatalog: v.object({
      source: v.union(v.literal("synced"), v.literal("bundled")),
      refreshStatus: v.union(
        v.literal("idle"),
        v.literal("running"),
        v.literal("success"),
        v.literal("failed")
      ),
      modelCount: v.number(),
      updatedAt: v.optional(v.number()),
    }),
    /** Whether this caller may change anything. The field stays in the shape
     *  so the page can render read-only without a second round-trip, and so a
     *  later Team read-only capability has somewhere to report itself. */
    canEdit: v.boolean(),
  }),
  handler: async (ctx) => {
    // Community's single durable owner reads and writes AI settings through
    // the same seam, so reaching the body already proves edit authority.
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    const settings = await ctx.db.query("siteSettings").first()
    const selected = settings?.aiRuntime?.selectedProvider
    const available = availability()
    const runtime = resolveRuntimeSelection(selected, available)
    const synchronizedModels = await ctx.db
      .query("openRouterCatalogModels")
      .take(OPENROUTER_CATALOG_MAX_MODELS + 1)
    const synchronizedCatalog =
      synchronizedModels.length > 0 &&
      synchronizedModels.length <= OPENROUTER_CATALOG_MAX_MODELS
        ? Object.fromEntries(
            synchronizedModels.map((model) => [
              model.modelId,
              {
                name: model.name,
                inputModalities: model.inputModalities,
                outputModalities: ["text"] as const,
                structuredOutput: model.structuredOutput,
                reasoning:
                  model.reasoningEfforts.length > 0
                    ? {
                        kind: "effort" as const,
                        supportedEfforts: model.reasoningEfforts,
                        providerDefault: "medium" as const,
                      }
                    : { kind: "unsupported" as const },
                ...(model.inputPerM === undefined ||
                model.outputPerM === undefined
                  ? {}
                  : {
                      pricing: {
                        inputPerM: model.inputPerM,
                        outputPerM: model.outputPerM,
                      },
                    }),
              } satisfies NamedCapability,
            ])
          )
        : undefined
    const catalogState = await ctx.db
      .query("openRouterCatalogSync")
      .withIndex("by_key", (q) => q.eq("key", "openrouter"))
      .unique()
    return {
      // Not an access bypass: `requireOperationAccess` above already
      // resolved the verified owner principal, and Community has exactly one
      // fixed owner-only community seam. T01 recomputes this from a real member capability.
      canEdit: true,
      runtime: {
        selectedProvider: runtime.selectedProvider,
        status: runtime.status,
        availability: runtime.availability,
      },
      providerDefaults: settings?.aiRuntime?.providerDefaults ?? {},
      // Lenient read: `taskDefaultsValidator` is keyed by `v.string()` (the
      // record-with-hyphenated-literal-keys codepath crashes Convex's function
      // export), so a persisted key from a retired profile — most commonly
      // `vision-spec`/`renderer-jsx` after the 2026-07-14 lane retirement — is
      // still storage-valid. Filter to the currently-known runtime profiles so
      // the UI never surfaces a row it has no picker for; `patch` replaces the
      // whole aiRuntime object on the next save, so nothing lingers.
      taskDefaults: filterKnownTaskDefaults(
        settings?.aiRuntime?.taskDefaults ?? {}
      ),
      openRouterCatalog: {
        source: synchronizedCatalog
          ? ("synced" as const)
          : ("bundled" as const),
        refreshStatus: catalogState?.status ?? ("idle" as const),
        modelCount: synchronizedCatalog
          ? synchronizedModels.length
          : Object.keys(OPENROUTER_API_CATALOG).length,
        ...(catalogState?.lastSuccessAt === undefined
          ? {}
          : { updatedAt: catalogState.lastSuccessAt }),
      },
      providers: API_PROVIDERS.map((provider) => ({
        id: provider,
        available: available[provider],
        profiles: RUNTIME_TASK_PROFILES.map((profile) => {
          const tuple = taskProfileTuple(provider, profile)
          return {
            profile,
            model: tuple.model,
            reasoning:
              "reasoning" in tuple && tuple.reasoning
                ? tuple.reasoning.effort
                : null,
          }
        }),
        selections: selectionProjections(provider, synchronizedCatalog),
      })),
    }
  },
})

// AI1 spending admission and settlement. Site/month totals are authoritative;
// per-attempt identifying records may be erased without resetting allowance.

type AdmissionArgs = Infer<typeof aiAttemptAdmissionRequestValidator>
type SettlementArgs = Infer<typeof aiAttemptSettlementValidator>
type ProviderObservation = Infer<typeof providerObservationValidator>

/** Preserve per-attempt deduplication and reject non-current fingerprints.
 * A changed fingerprint replaces regardless of timestamp. For the same
 * fingerprint, refused is absorbing; otherwise ignore observedAt <= previous.observedAt,
 * and replace for every newer observation, including repeated states.
 * Equal timestamps keep the first committed observation.
 * Accepted writes re-run effective/status in open admin tabs. */
export async function recordProviderObservation(
  ctx: MutationCtx,
  observation: ProviderObservation,
  sourceAttemptKey: string
): Promise<void> {
  const key = runtimeProviderKey(observation.provider)
  if (!key || await hashOwnerClaim(key) !== observation.keyFingerprint) return
  const previous = await ctx.db.query("aiProviderHealth")
    .withIndex("by_provider", (q) => q.eq("provider", observation.provider)).unique()
  if (previous?.sourceAttemptKey === sourceAttemptKey) return
  if (previous?.keyFingerprint === observation.keyFingerprint) {
    if (previous.state === "refused" || previous.observedAt >= observation.observedAt) return
  }
  const next = { ...observation, sourceAttemptKey }
  if (previous) await ctx.db.replace("aiProviderHealth", previous._id, next)
  else await ctx.db.insert("aiProviderHealth", next)
}
const SITE_KEY = "installation" as const
const receiptOrNull = v.union(aiAttemptReceiptValidator, v.null())

function monthKey(now: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now)
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`
}
function monthEnd(key: string, timeZone: string): number {
  const [year, month] = key.split("-").map(Number)
  const target = Date.UTC(year!, month!, 1)
  let instant = target
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(
      formatter
        .formatToParts(instant)
        .map((part) => [part.type, Number(part.value)])
    )
    const local = Date.UTC(
      p.year!,
      p.month! - 1,
      p.day!,
      p.hour!,
      p.minute!,
      p.second!
    )
    instant += target - local
  }
  return instant
}
export async function pricing(
  ctx: QueryCtx | MutationCtx,
  args: AdmissionArgs,
  now: number
) {
  const catalog =
    args.provider === "openrouter"
      ? await ctx.db
          .query("openRouterCatalogModels")
          .withIndex("by_modelId", (q) => q.eq("modelId", args.modelId))
          .unique()
      : null
  const price = quote(args.provider, args.modelId, {
    inputTokens: args.inputTokens,
    now,
    ...(catalog ? { catalog } : {}),
  })
  moneyInteger(args.maxOutputTokens)
  if (
    args.maxOutputTokens === 0 ||
    args.maxOutputTokens > MAX_OUTPUT_TOKENS[args.profile]
  )
    throw new Error("Invalid AI output limit.")
  return {
    price,
    estimateMicros: estimateMicros(
      price,
      args.inputTokens,
      args.maxOutputTokens,
      args.imageTokens
    ),
  }
}
export async function currentMonth(ctx: QueryCtx | MutationCtx, now: number) {
  const settings = await ctx.db.query("siteSettings").first()
  const capMicros = moneyInteger(
    effectiveMonthlyCapMicros(settings?.aiMonthlyCapMicros)
  )
  const latest = await ctx.db
    .query("aiSpendingMonths")
    .withIndex("by_siteKey_and_periodEndMs", (q) => q.eq("siteKey", SITE_KEY))
    .order("desc")
    .first()
  // Freeze a started month's window. An eastward timezone edit cannot create
  // another allowance early; a westward edit reuses the same month-key row.
  if (latest && latest.periodEndMs > now)
    return {
      row: latest,
      capMicros,
      monthKey: latest.monthKey,
      timeZone: latest.timeZone,
      periodEndMs: latest.periodEndMs,
    }
  const timeZone = settings?.timezone ?? "UTC"
  const key = monthKey(now, timeZone)
  const row = await ctx.db
    .query("aiSpendingMonths")
    .withIndex("by_siteKey_and_monthKey", (q) =>
      q.eq("siteKey", SITE_KEY).eq("monthKey", key)
    )
    .unique()
  return {
    row,
    capMicros,
    monthKey: key,
    timeZone,
    periodEndMs: monthEnd(key, timeZone),
  }
}

/** D2: the whole job is admitted atomically before any work is enqueued. */
export async function reservePageJob(
  ctx: MutationCtx,
  authId: string,
  jobId: Id<"aiJobs">,
  estimate: number
): Promise<string> {
  moneyInteger(estimate)
  const month = await currentMonth(ctx, Date.now())
  const reserved = month.row?.reservedMicros ?? 0
  if (
    BigInt(month.row?.spentMicros ?? 0) + BigInt(reserved) + BigInt(estimate) >
    BigInt(month.capMicros)
  )
    throw new Error("AI monthly spending cap reached.")
  const monthId =
    month.row?._id ??
    (await ctx.db.insert("aiSpendingMonths", {
      siteKey: SITE_KEY,
      monthKey: month.monthKey,
      timeZone: month.timeZone,
      periodEndMs: month.periodEndMs,
      spentMicros: 0,
      reservedMicros: 0,
    }))
  await ctx.db.patch("aiSpendingMonths", monthId, {
    reservedMicros: moneyInteger(reserved + estimate),
  })
  const reservationKey = `page-job:${crypto.randomUUID()}`
  await ctx.db.insert("aiSpendingJobReservations", {
    reservationKey,
    authId,
    jobId,
    monthId,
    monthKey: month.monthKey,
    estimateMicros: estimate,
    remainingMicros: estimate,
    state: "open",
    createdAt: Date.now(),
  })
  // The job remainder has no attempt deadline. Each admitted attempt still does.
  return reservationKey
}
export async function releasePageJobReservation(
  ctx: MutationCtx,
  key: string | undefined
): Promise<void> {
  if (!key) return
  const row = await ctx.db
    .query("aiSpendingJobReservations")
    .withIndex("by_reservationKey", (q) => q.eq("reservationKey", key))
    .unique()
  if (!row || row.state !== "open") return
  const month = await ctx.db.get("aiSpendingMonths", row.monthId)
  if (!month) throw new Error("AI spending month is missing.")
  await ctx.db.patch("aiSpendingMonths", month._id, {
    reservedMicros: moneyInteger(month.reservedMicros - row.remainingMicros),
  })
  await ctx.db.patch("aiSpendingJobReservations", row._id, {
    remainingMicros: 0,
    state: "released",
    releasedAt: Date.now(),
  })
}
async function admitAttempt(
  ctx: MutationCtx,
  authId: string,
  args: AdmissionArgs
): Promise<AttemptAdmission> {
  const { anchorAttemptKey, ...attempt } = args
  const jobReservation =
    anchorAttemptKey === undefined
      ? null
      : await ctx.db
          .query("aiSpendingJobReservations")
          .withIndex("by_reservationKey", (q) =>
            q.eq("reservationKey", anchorAttemptKey)
          )
          .unique()
  let jobUnit: Doc<"aiJobUnits"> | null = null
  if (jobReservation) {
    const job = await ctx.db.get("aiJobs", jobReservation.jobId)
    const unitId = args.unitId
      ? ctx.db.normalizeId("aiJobUnits", args.unitId)
      : null
    jobUnit = unitId ? await ctx.db.get("aiJobUnits", unitId) : null
    if (
      jobReservation.authId !== authId ||
      jobReservation.state !== "open" ||
      !job ||
      Date.now() >= job.expiresAt ||
      !jobUnit ||
      jobUnit.jobId !== job._id ||
      jobUnit.authId !== authId ||
      args.runId !== job._id ||
      jobUnit.state !== "inProgress" ||
      !jobUnit.claimToken ||
      jobUnit.admittedClaim === jobUnit.claimToken
    )
      throw new Error("AI operation is no longer available.")
  } else if (anchorAttemptKey !== undefined) {
    const anchor = await ctx.db
      .query("aiSpendingAttempts")
      .withIndex("by_attemptKey", (q) => q.eq("attemptKey", anchorAttemptKey))
      .unique()
    if (!anchor || anchor.authId !== authId)
      throw new Error("AI operation is no longer available.")
  }
  if (!args.attemptKey.trim() || args.attemptKey.length > 200)
    throw new Error("Invalid AI attempt identity.")
  const prior = await ctx.db
    .query("aiSpendingAttempts")
    .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptKey))
    .unique()
  if (prior) throw new Error("AI attempt identity has already been admitted.")
  const now = Date.now()
  const priced = await pricing(ctx, args, now)
  const current = await currentMonth(ctx, now)
  const anchoredMonth = jobReservation
    ? await ctx.db.get("aiSpendingMonths", jobReservation.monthId)
    : null
  if (jobReservation && !anchoredMonth)
    throw new Error("AI spending month is missing.")
  const month = anchoredMonth
    ? { ...current, row: anchoredMonth, monthKey: anchoredMonth.monthKey }
    : current
  const spent = month.row?.spentMicros ?? 0,
    reserved = month.row?.reservedMicros ?? 0
  const additional = jobReservation
    ? Math.max(0, priced.estimateMicros - jobReservation.remainingMicros)
    : priced.estimateMicros
  if (
    BigInt(spent) + BigInt(reserved) + BigInt(additional) >
    BigInt(month.capMicros)
  )
    throw new Error("AI monthly spending cap reached.")
  const monthId =
    month.row?._id ??
    (await ctx.db.insert("aiSpendingMonths", {
      siteKey: SITE_KEY,
      monthKey: month.monthKey,
      timeZone: month.timeZone,
      periodEndMs: month.periodEndMs,
      spentMicros: 0,
      reservedMicros: 0,
    }))
  await ctx.db.patch("aiSpendingMonths", monthId, {
    reservedMicros: moneyInteger(reserved + additional),
  })
  if (jobReservation && jobUnit) {
    await ctx.db.patch("aiSpendingJobReservations", jobReservation._id, {
      remainingMicros: Math.max(
        0,
        jobReservation.remainingMicros - priced.estimateMicros
      ),
    })
    await ctx.db.patch("aiJobUnits", jobUnit._id, {
      admittedClaim: jobUnit.claimToken,
      attemptKeys: [...jobUnit.attemptKeys, args.attemptKey],
    })
  }
  await ctx.db.insert("aiSpendingAttempts", {
    ...attempt,
    authId,
    monthId,
    monthKey: month.monthKey,
    price: priced.price,
    estimateMicros: priced.estimateMicros,
    reservedMicros: priced.estimateMicros,
    state: "open",
    createdAt: now,
  })
  await ctx.scheduler.runAfter(
    (args.lane === "runtime" ? 90_000 : 300_000) + 60_000,
    internal.cms.ai.settleAttemptAtDeadline,
    { attemptKey: args.attemptKey }
  )
  return {
    attemptKey: args.attemptKey,
    admitted: true as const,
    estimateMicros: priced.estimateMicros,
    priceRevision: priced.price.revision,
  }
}
function savedReceipt(row: Doc<"aiSpendingAttempts">): AttemptReceipt | null {
  return row.chargedMicros === undefined || !row.costSource
    ? null
    : {
        attemptKey: row.attemptKey,
        chargedMicros: row.chargedMicros,
        costSource: row.costSource,
        currency: "USD",
      }
}
export async function settleAttempt(
  ctx: MutationCtx,
  args: SettlementArgs
): Promise<AttemptReceipt | null> {
  const row = await ctx.db
    .query("aiSpendingAttempts")
    .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptKey))
    .unique()
  if (!row) return null // B5 final boundary: erased receipts never recreate rows.
  const first = savedReceipt(row)
  if (first) return first
  const month = await ctx.db.get("aiSpendingMonths", row.monthId)
  if (!month) throw new Error("AI spending month is missing.")
  const cost = chargeMicros(
    row.price,
    row.estimateMicros,
    args.usage,
    args.outcome
  )
  await ctx.db.patch("aiSpendingMonths", month._id, {
    spentMicros: moneyInteger(month.spentMicros + cost.chargedMicros),
    reservedMicros: moneyInteger(month.reservedMicros - row.reservedMicros),
  })
  await ctx.db.patch("aiSpendingAttempts", row._id, {
    ...cost,
    reservedMicros: 0,
    state: "settled",
    settledAt: Date.now(),
  })
  // D3: costs are durable before output can be saved or recovery can reuse it.
  const jobId = row.runId ? ctx.db.normalizeId("aiJobs", row.runId) : null
  const unitId = row.unitId
    ? ctx.db.normalizeId("aiJobUnits", row.unitId)
    : null
  if (jobId && unitId) {
    const job = await ctx.db.get("aiJobs", jobId)
    const unit = await ctx.db.get("aiJobUnits", unitId)
    if (
      job &&
      unit &&
      unit.jobId === jobId &&
      job.authId === row.authId &&
      unit.attemptKeys.includes(row.attemptKey)
    ) {
      await ctx.db.patch("aiJobs", jobId, {
        costMicros: moneyInteger(job.costMicros + cost.chargedMicros),
      })
      await ctx.db.patch("aiJobUnits", unitId, {
        costMicros: moneyInteger(unit.costMicros + cost.chargedMicros),
      })
    }
  }
  const kind =
    row.phase === "translation"
      ? "field-translate"
      : row.phase === "help-answer"
        ? "help-answer"
        : row.phase === "page-outline"
          ? "page-generate-outline"
          : row.phase === "page-fill"
            ? "page-generate-fill"
            : row.phase === "page-meta"
              ? "page-generate-meta"
              : row.phase === "content-refinement"
                ? "field-refine"
                : row.phase === "slice-spec" || row.phase === "renderer-jsx"
                  ? "slice-author-propose"
                  : "field-generate"
  await writePostAdmissionAudit(ctx, {
    authId: row.authId,
    kind,
    sliceCount: 0,
    modelId: row.modelId,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.unitId ? { unitId: row.unitId } : {}),
    attemptId: row.attemptKey,
    ...cost,
    currency: "USD",
    tokenUsage: {
      promptTokens: args.usage?.inputTokens,
      completionTokens: args.usage?.outputTokens,
      totalTokens: args.usage?.totalTokens,
    },
    success: args.outcome === "completed",
  })
  return { attemptKey: row.attemptKey, ...cost, currency: "USD" }
}

export const admitRuntimeAttempt = internalMutation({
  args: { authId: v.string(), request: aiAttemptAdmissionRequestValidator },
  returns: aiAttemptAdmissionValidator,
  handler: async (ctx, args) => {
    const guard = await resolveOptionalModuleGuardState(ctx, "ai")
    if (!guard.effective) throw new ConvexError("CMS_MODULE_DISABLED")
    // Use this request's frozen provider; another assistant can keep AI ready.
    const connection = await readRuntimeProviderConnection(ctx, args.request.provider)
    if (connection.state === "missing" || connection.state === "refused") {
      const refused = connection.state === "refused"
      const error: SafeGenerationError = {
        category: refused ? "AUTH_REQUIRED" : "CONFIG_MISSING",
        message: refused
          ? "The assistant's connection was refused."
          : "The assistant's connection is not configured.",
        selected: { lane: "runtime", provider: args.request.provider, model: args.request.modelId },
        attempts: 0,
        phase: args.request.phase,
        retryable: false,
        nextAction: refused ? "authenticate-provider" : "configure-provider",
      }
      throw new ConvexError(error as unknown as Value)
    }
    if (guard.readiness !== "ready") throw new ConvexError("CMS_MODULE_NOT_READY")
    if (args.request.profile === "mechanical-translation" || args.request.profile === "brand-translation") await requireAiTranslationModule(ctx)
    return admitAttempt(ctx, args.authId, args.request)
  },
})
export const admitLocalAttempt = mutation({
  args: { request: aiAttemptAdmissionRequestValidator },
  returns: aiAttemptAdmissionValidator,
  handler: async (ctx, { request }) => {
    const owner = await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    if (request.lane !== "local-build")
      throw new Error("Invalid local accounting lane.")
    return admitAttempt(ctx, owner.authId, request)
  },
})
export const settleRuntimeAttempt = internalMutation({
  args: { ...aiAttemptSettlementValidator.fields, providerObservation: v.optional(providerObservationValidator) },
  returns: receiptOrNull,
  handler: async (ctx, { providerObservation, ...args }) => {
    if (providerObservation) {
      const attempt = await ctx.db.query("aiSpendingAttempts")
        .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptKey)).unique()
      if (attempt && attempt.lane === "runtime" && attempt.provider === providerObservation.provider &&
          !attempt.providerObservationRecorded) {
        await recordProviderObservation(ctx, providerObservation, args.attemptKey)
        await ctx.db.patch("aiSpendingAttempts", attempt._id, { providerObservationRecorded: true })
      }
    }
    return settleAttempt(ctx, args)
  },
})
export const settleLocalAttempt = mutation({
  args: aiAttemptSettlementValidator.fields,
  returns: receiptOrNull,
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    const row = await ctx.db
      .query("aiSpendingAttempts")
      .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptKey))
      .unique()
    if (row && (row.authId !== owner.authId || row.lane !== "local-build"))
      throw new Error("AI attempt does not belong to this owner session.")
    return settleAttempt(ctx, args)
  },
})
export const settleAttemptAtDeadline = internalMutation({
  args: { attemptKey: v.string() },
  returns: receiptOrNull,
  handler: async (ctx, args) =>
    settleAttempt(ctx, { ...args, outcome: "failed" }),
})
/** Job termination can release unused holds without discarding a late receipt. */
export const releaseAttemptReservation = internalMutation({
  args: { attemptKey: v.string() },
  returns: v.null(),
  handler: async (ctx, { attemptKey }) => {
    const row = await ctx.db
      .query("aiSpendingAttempts")
      .withIndex("by_attemptKey", (q) => q.eq("attemptKey", attemptKey))
      .unique()
    if (!row || row.reservedMicros === 0) return null
    const month = await ctx.db.get("aiSpendingMonths", row.monthId)
    if (!month) throw new Error("AI spending month is missing.")
    await ctx.db.patch("aiSpendingMonths", month._id, {
      reservedMicros: moneyInteger(month.reservedMicros - row.reservedMicros),
    })
    await ctx.db.patch("aiSpendingAttempts", row._id, {
      reservedMicros: 0,
      state: "released",
    })
    return null
  },
})
export const estimateAttempt = internalQuery({
  args: { request: aiAttemptAdmissionRequestValidator, now: v.number() },
  returns: v.object({
    price: aiPriceQuoteValidator,
    estimateMicros: v.number(),
  }),
  handler: async (ctx, { request, now }) => pricing(ctx, request, now),
})
export const monthStatus = internalQuery({
  args: { now: v.number() },
  returns: v.object({
    monthKey: v.string(),
    spentMicros: v.number(),
    reservedMicros: v.number(),
    capMicros: v.number(),
    status: v.union(
      v.literal("below"),
      v.literal("warn80"),
      v.literal("reached")
    ),
  }),
  handler: async (ctx, { now }) => {
    const month = await currentMonth(ctx, now)
    const spentMicros = month.row?.spentMicros ?? 0,
      reservedMicros = month.row?.reservedMicros ?? 0
    const total = BigInt(spentMicros) + BigInt(reservedMicros),
      cap = BigInt(month.capMicros)
    const status =
      total >= cap
        ? ("reached" as const)
        : total * 5n >= cap * 4n
          ? ("warn80" as const)
          : ("below" as const)
    return {
      monthKey: month.monthKey,
      spentMicros,
      reservedMicros,
      capMicros: month.capMicros,
      status,
    }
  },
})
/** Called only by the erasure path, inside its transaction. */
export async function eraseSpendingAttemptsForUser(
  ctx: MutationCtx,
  authId: string
): Promise<boolean> {
  // Installation health belongs to the one owner, not an arbitrary erased user.
  const owner = await ctx.db.query("cmsOwner")
    .withIndex("by_key", (q) => q.eq("key", "owner")).unique()
  if (owner?.authId === authId) {
    for (const health of await ctx.db.query("aiProviderHealth").take(3)) {
      await ctx.db.delete("aiProviderHealth", health._id)
    }
  }
  const rows = await ctx.db
    .query("aiSpendingAttempts")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .take(200)
  for (const row of rows) {
    await settleAttempt(ctx, { attemptKey: row.attemptKey, outcome: "failed" })
    await ctx.db.delete("aiSpendingAttempts", row._id)
  }
  return rows.length === 200
}

/** Sole post-admission audit writer. The check, optional local limiter effect,
 * and insert share one mutation, so erasure cannot interleave between them. */
export async function writePostAdmissionAudit(
  ctx: MutationCtx,
  args: Omit<Doc<"aiAuditLog">, "_id" | "_creationTime" | "createdAt"> & {
    attemptId: string
  },
  beforeWrite?: () => Promise<void>
): Promise<null> {
  const attempt = await ctx.db
    .query("aiSpendingAttempts")
    .withIndex("by_attemptKey", (q) => q.eq("attemptKey", args.attemptId))
    .unique()
  if (!attempt || attempt.authId !== args.authId) return null
  await beforeWrite?.()
  await ctx.db.insert("aiAuditLog", { ...args, createdAt: Date.now() })
  return null
}
