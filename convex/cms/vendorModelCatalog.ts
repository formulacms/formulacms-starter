// The Anthropic and OpenAI model lists, fetched with the owner's own API key
// (AI-MODELS-1b, design § 2). Follows the OpenRouter sync pattern: a one-hour
// lock, an Action Retrier for transient failures, an atomic publish, and the
// last good snapshot kept on every failure. Nothing here changes a run; the
// merged read model is `convex/lib/aiCatalog.ts`.
import {
  ActionRetrier,
  runIdValidator,
  runResultValidator,
} from "@convex-dev/action-retrier"
import type { RunId } from "@convex-dev/action-retrier"
import { v } from "convex/values"
import { components, internal } from "../_generated/api"
import type { Doc } from "../_generated/dataModel"
import {
  env,
  internalAction,
  internalMutation,
  mutation,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server"
import {
  VENDOR_CATALOG_MAX_MODELS,
  anthropicNextPage,
  parseAnthropicModels,
  parseOpenAiModels,
  type VendorModel,
} from "../../lib/ai/model-catalog"
import { aiRateLimiter } from "../lib/aiRateLimit"
import { reasoningEffortValidator } from "../lib/aiValidators"
import {
  KEY_REFUSED_MESSAGE,
  isCurrentAttempt,
  keyIdentity,
  readSyncState,
  startCatalogRefresh,
} from "../lib/catalogRefresh"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { hashOwnerClaim } from "../lib/ownerClaim"
import { startOpenRouterRefresh } from "./openRouterCatalog"

const FETCH_TIMEOUT_MS = 15_000
const ANTHROPIC_MAX_PAGES = 3
const TOMBSTONE_MS = 180 * 24 * 60 * 60 * 1_000
/** Shrink guard: with the same key, fewer than half of >= 10 rows is refused. */
const SHRINK_GUARD_MIN_ROWS = 10

const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models"
/** Sent on the models call only; Messages calls are untouched. */
const ANTHROPIC_MODELS_VERSION = "2026-10-21"

export { KEY_REFUSED_MESSAGE }

const directProviderValidator = v.union(
  v.literal("anthropic"),
  v.literal("openai")
)
type DirectProvider = "anthropic" | "openai"
const DIRECT_PROVIDERS: readonly DirectProvider[] = ["anthropic", "openai"]

/** Reads the key from the environment. Call it only inside internal actions
 * (`detectKeysAndStart`, `fetchAndPublish`); no query or mutation reads a key. */
function providerKey(provider: DirectProvider): string | undefined {
  const value =
    provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  return value?.trim() || undefined
}

export const vendorCatalogRetrier = new ActionRetrier(
  components.actionRetrier,
  {
    initialBackoffMs: 5_000,
    base: 2,
    maxFailures: 4,
  }
)

async function startVendorRefresh(
  ctx: MutationCtx,
  provider: DirectProvider
): Promise<null> {
  return startCatalogRefresh(ctx, provider, async (attemptAt) => {
    const runId: RunId = await vendorCatalogRetrier.run(
      ctx,
      internal.cms.vendorModelCatalog.fetchAndPublish,
      { provider, attemptAt },
      { onComplete: internal.cms.vendorModelCatalog.recordRefreshResult }
    )
    return runId as string
  })
}

/** What asked for the refresh: the hourly key check, the daily refresh or
 * the owner's Refresh button. */
type RefreshTrigger = "hourly" | "daily" | "owner"
const refreshTriggerValidator = v.union(
  v.literal("hourly"),
  v.literal("daily"),
  v.literal("owner")
)

/**
 * The one retry rule. Automatic refreshes never retry a key the vendor
 * refused until it changes: the daily refresh runs for any other key, the
 * hourly check only when the provider never had a list or its key changed.
 * The owner's Refresh button always runs, so it retries a refused key.
 */
export function refreshDue(
  state: Doc<"openRouterCatalogSync"> | null,
  keyFingerprint: string,
  trigger: RefreshTrigger
): boolean {
  if (trigger === "owner") return true
  const { snapshot, refused } = keyIdentity(state)
  if (refused === keyFingerprint) return false
  if (trigger === "daily") return true
  return state?.lastSuccessAt === undefined || snapshot !== keyFingerprint
}

/**
 * Starts the due refreshes in one transaction: it reads the current state,
 * applies `refreshDue`, takes the lock and enqueues the run. The calling
 * action supplies only which keys are set and their fingerprints.
 */
export const startVendorRefreshes = internalMutation({
  args: {
    trigger: refreshTriggerValidator,
    keys: v.array(
      v.object({ provider: directProviderValidator, keyFingerprint: v.string() })
    ),
  },
  returns: v.null(),
  handler: async (ctx, { trigger, keys }): Promise<null> => {
    for (const { provider, keyFingerprint } of keys) {
      const state = await readSyncState(ctx, provider)
      if (refreshDue(state, keyFingerprint, trigger)) {
        await startVendorRefresh(ctx, provider)
      }
    }
    return null
  },
})

/** Key presence and fingerprints, read here in an action, then one mutation. */
async function detectKeysAndStart(
  ctx: ActionCtx,
  trigger: RefreshTrigger
): Promise<null> {
  const keys: { provider: DirectProvider; keyFingerprint: string }[] = []
  for (const provider of DIRECT_PROVIDERS) {
    const key = providerKey(provider)
    if (key) keys.push({ provider, keyFingerprint: await hashOwnerClaim(key) })
  }
  if (keys.length === 0) return null
  await ctx.runMutation(internal.cms.vendorModelCatalog.startVendorRefreshes, {
    trigger,
    keys,
  })
  return null
}

/** Daily cron target. Refreshes each direct provider whose key is set. */
export const enqueueDailyRefresh = internalAction({
  args: {},
  returns: v.null(),
  handler: (ctx): Promise<null> => detectKeysAndStart(ctx, "daily"),
})

/**
 * Hourly cron target. Keys are deployment variables, so there is no "key
 * saved" event: refresh a provider whose key is set when it was never
 * fetched, or when the key's fingerprint differs from the last list. A key
 * the vendor refused is not retried until it changes. No key: nothing runs.
 */
export const ensureVendorRefresh = internalAction({
  args: {},
  returns: v.null(),
  handler: (ctx): Promise<null> => detectKeysAndStart(ctx, "hourly"),
})

/** Scheduled by the owner's Refresh button. */
export const refreshVendorCatalogsForOwner = internalAction({
  args: {},
  returns: v.null(),
  handler: (ctx): Promise<null> => detectKeysAndStart(ctx, "owner"),
})

/**
 * Owner button (UI is a later step): refresh all three catalogs now, respecting
 * the locks. One use per five minutes for the whole deployment. The direct
 * lists start in an action, because only actions read the API keys; a key
 * the vendor refused is retried.
 */
export const refreshModelCatalogs = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    await aiRateLimiter.limit(ctx, "modelCatalogRefresh", { throws: true })
    await startOpenRouterRefresh(ctx)
    await ctx.scheduler.runAfter(
      0,
      internal.cms.vendorModelCatalog.refreshVendorCatalogsForOwner,
      {}
    )
    return null
  },
})

class VendorRequestError extends Error {}

/** One GET. Error text is the status plus a fixed phrase, never the body. */
async function getJson(
  url: string,
  headers: Record<string, string>,
  vendor: string
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new VendorRequestError(`${vendor} model list request failed.`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new KeyRefused()
  }
  if (!response.ok) {
    throw new VendorRequestError(
      `${vendor} model list responded ${response.status}.`
    )
  }
  try {
    return await response.json()
  } catch {
    throw new VendorRequestError(`${vendor} model list was not valid JSON.`)
  }
}

class KeyRefused extends Error {}

async function fetchAnthropic(key: string): Promise<VendorModel[]> {
  const headers = {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_MODELS_VERSION,
  }
  const models: VendorModel[] = []
  let afterId: string | undefined
  for (let page = 0; page < ANTHROPIC_MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: "1000" })
    for (const lifecycle of ["active", "deprecated", "retired"]) {
      params.append("lifecycle", lifecycle)
    }
    if (afterId) params.set("after_id", afterId)
    const body = await getJson(
      `${ANTHROPIC_MODELS_URL}?${params.toString()}`,
      headers,
      "Anthropic"
    )
    models.push(...parseAnthropicModels(body))
    if (models.length > VENDOR_CATALOG_MAX_MODELS) {
      throw new VendorRequestError(
        "Anthropic returned more models than the supported limit."
      )
    }
    afterId = anthropicNextPage(body)
    if (!afterId) return models
  }
  // Still more pages after the page limit: the list is beyond what we support.
  throw new VendorRequestError(
    "Anthropic returned more pages than the supported limit."
  )
}

async function fetchOpenAi(key: string): Promise<VendorModel[]> {
  const body = await getJson(
    OPENAI_MODELS_URL,
    { authorization: `Bearer ${key}` },
    "OpenAI"
  )
  return parseOpenAiModels(body)
}

const publishResultValidator = v.union(
  v.object({ status: v.literal("published"), count: v.number() }),
  v.object({ status: v.literal("refused") }),
  v.object({ status: v.literal("no-key") }),
  // A newer run started meanwhile; this run wrote nothing.
  v.object({ status: v.literal("stale") })
)

/**
 * Retried external read. The key is read from the environment here and never
 * leaves this function: it is not an argument, not stored, not logged. Only
 * its fingerprint is stored, so the stored fingerprint is always the key the
 * list was fetched with. 401/403 is recorded and returned (no retry); every
 * other failure throws so the retrier tries again. `attemptAt` fences the
 * writes: a run that is no longer the current one writes nothing.
 */
export const fetchAndPublish = internalAction({
  args: { provider: directProviderValidator, attemptAt: v.number() },
  returns: publishResultValidator,
  handler: async (
    ctx,
    { provider, attemptAt }
  ): Promise<
    | { status: "published"; count: number }
    | { status: "refused" }
    | { status: "no-key" }
    | { status: "stale" }
  > => {
    const key = providerKey(provider)
    if (!key) return { status: "no-key" }
    const keyFingerprint = await hashOwnerClaim(key)
    let models: VendorModel[]
    try {
      models =
        provider === "anthropic"
          ? await fetchAnthropic(key)
          : await fetchOpenAi(key)
    } catch (error) {
      if (error instanceof KeyRefused) {
        const recorded: boolean = await ctx.runMutation(
          internal.cms.vendorModelCatalog.recordKeyRefused,
          { provider, keyFingerprint, attemptAt }
        )
        return { status: recorded ? "refused" : "stale" }
      }
      throw error
    }
    const count: number | null = await ctx.runMutation(
      internal.cms.vendorModelCatalog.publishVendorCatalog,
      { provider, models, syncedAt: Date.now(), keyFingerprint, attemptAt }
    )
    return count === null ? { status: "stale" } : { status: "published", count }
  },
})

const vendorModelValidator = v.object({
  provider: directProviderValidator,
  modelId: v.string(),
  name: v.optional(v.string()),
  line: v.optional(v.string()),
  releasedAt: v.optional(v.number()),
  inputModalities: v.optional(
    v.array(
      v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("file"),
        v.literal("audio"),
        v.literal("video")
      )
    )
  ),
  structuredOutput: v.optional(v.boolean()),
  effortControl: v.optional(
    v.union(v.literal("effort"), v.literal("none"), v.literal("unknown"))
  ),
  efforts: v.optional(v.array(reasoningEffortValidator)),
  maxInputTokens: v.optional(v.number()),
  maxOutputTokens: v.optional(v.number()),
  lifecycle: v.optional(
    v.union(
      v.literal("active"),
      v.literal("deprecated"),
      v.literal("retired")
    )
  ),
  deprecatedAt: v.optional(v.number()),
  retiresAt: v.optional(v.number()),
})

type VendorRow = Omit<Doc<"aiVendorModels">, "_id" | "_creationTime">

const ROW_FIELDS = [
  "name",
  "line",
  "releasedAt",
  "inputModalities",
  "structuredOutput",
  "effortControl",
  "efforts",
  "maxInputTokens",
  "maxOutputTokens",
  "lifecycle",
  "deprecatedAt",
  "retiresAt",
] as const

/** Anthropic reports its lifecycle; OpenAI's is derived from `shutdown_date`. */
function lifecycleOf(
  provider: DirectProvider,
  model: VendorModel,
  now: number
): VendorRow["lifecycle"] {
  if (provider === "anthropic") return model.lifecycle ?? "active"
  if (model.retiresAt === undefined) return "active"
  return model.retiresAt <= now ? "retired" : "deprecated"
}

function sameRow(current: Doc<"aiVendorModels">, next: VendorRow): boolean {
  return (
    current.absentSince === undefined &&
    ROW_FIELDS.every(
      (field) =>
        JSON.stringify(current[field]) === JSON.stringify(next[field])
    )
  )
}

/** A provider keeps at most this many rows: the listed ones plus tombstones. */
const STORED_ROWS_BOUND = VENDOR_CATALOG_MAX_MODELS * 2
/** Tombstones read per publish for cleanup; more than any bounded state holds,
 * and a larger overflow left by older code shrinks on each later publish. */
const TOMBSTONE_SCAN = VENDOR_CATALOG_MAX_MODELS * 4

/**
 * Atomic publish: upsert, tombstone the missing, then trim the retained
 * history. Listed rows are read apart from tombstones, so old tombstones never
 * block a publish. Afterwards tombstones older than 180 days are deleted and,
 * when turnover fills the bound, the oldest ones first (the only exception to
 * the 180-day retention). Returns null and writes nothing when a newer run
 * started after this one (`attemptAt`).
 */
export const publishVendorCatalog = internalMutation({
  args: {
    provider: directProviderValidator,
    models: v.array(vendorModelValidator),
    syncedAt: v.number(),
    keyFingerprint: v.string(),
    attemptAt: v.number(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (
    ctx,
    { provider, models, syncedAt, keyFingerprint, attemptAt }
  ) => {
    if (models.length === 0 || models.length > VENDOR_CATALOG_MAX_MODELS) {
      throw new Error("Refusing to publish an invalid model list size.")
    }
    const state = await readSyncState(ctx, provider)
    if (!isCurrentAttempt(state, attemptAt)) return null
    // Every publish tombstones what it did not list, so at most one list's
    // worth of rows is listed at any time.
    const present = await ctx.db
      .query("aiVendorModels")
      .withIndex("by_provider_and_absentSince", (q) =>
        q.eq("provider", provider).eq("absentSince", undefined)
      )
      .take(VENDOR_CATALOG_MAX_MODELS + 1)
    if (present.length > VENDOR_CATALOG_MAX_MODELS) {
      throw new Error("Stored model list exceeds its safety bound.")
    }
    if (
      keyIdentity(state).snapshot === keyFingerprint &&
      present.length >= SHRINK_GUARD_MIN_ROWS &&
      models.length * 2 < present.length
    ) {
      throw new Error("Refusing a model list that is less than half the last one.")
    }

    const byId = new Map(present.map((row) => [row.modelId, row]))
    const listed = new Set<string>()
    for (const model of models) {
      if (listed.has(model.modelId)) continue
      listed.add(model.modelId)
      const next: VendorRow = {
        provider,
        modelId: model.modelId,
        ...Object.fromEntries(
          ROW_FIELDS.filter(
            (field) => field !== "lifecycle" && model[field] !== undefined
          ).map((field) => [field, model[field]])
        ),
        lifecycle: lifecycleOf(provider, model, syncedAt),
        syncedAt,
      }
      // A listed row, else a tombstone of a model that came back.
      const current =
        byId.get(model.modelId) ??
        (await ctx.db
          .query("aiVendorModels")
          .withIndex("by_provider_and_modelId", (q) =>
            q.eq("provider", provider).eq("modelId", model.modelId)
          )
          .first())
      if (!current) {
        await ctx.db.insert("aiVendorModels", next)
      } else if (!sameRow(current, next)) {
        await ctx.db.replace("aiVendorModels", current._id, next)
      }
    }
    for (const row of present) {
      if (!listed.has(row.modelId)) {
        await ctx.db.patch("aiVendorModels", row._id, { absentSince: syncedAt })
      }
    }

    // Retained history, oldest first: this transaction's writes included.
    const tombstones = await ctx.db
      .query("aiVendorModels")
      .withIndex("by_provider_and_absentSince", (q) =>
        q.eq("provider", provider).gt("absentSince", 0)
      )
      .take(TOMBSTONE_SCAN)
    const overBound = tombstones.length - (STORED_ROWS_BOUND - listed.size)
    for (const [index, row] of tombstones.entries()) {
      const expired = row.absentSince! < syncedAt - TOMBSTONE_MS
      if (!expired && index >= overBound) break
      await ctx.db.delete("aiVendorModels", row._id)
    }

    const update = {
      key: provider,
      status: "success" as const,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: syncedAt,
      modelCount: listed.size,
      keyFingerprint,
      ...(state.runId === undefined ? {} : { runId: state.runId }),
      ...(state.lastFailureAt === undefined
        ? {}
        : { lastFailureAt: state.lastFailureAt }),
    }
    await ctx.db.replace("openRouterCatalogSync", state._id, update)
    return listed.size
  },
})

/**
 * 401/403: report it, keep the last good list and its key fingerprint, and
 * do not retry. The refused key is kept apart, so a later list from that key
 * is not compared with another key's list. False when a newer run started.
 */
export const recordKeyRefused = internalMutation({
  args: {
    provider: directProviderValidator,
    keyFingerprint: v.string(),
    attemptAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, { provider, keyFingerprint, attemptAt }) => {
    const state = await readSyncState(ctx, provider)
    if (!isCurrentAttempt(state, attemptAt)) return false
    await ctx.db.patch("openRouterCatalogSync", state._id, {
      status: "failed",
      lastFailureAt: Date.now(),
      error: KEY_REFUSED_MESSAGE,
      // Undefined removes a legacy row's refused fingerprint from this field.
      keyFingerprint: keyIdentity(state).snapshot,
      refusedKeyFingerprint: keyFingerprint,
    })
    return true
  },
})

/** Exactly-once completion callback for exhausted retries or cancellation. */
export const recordRefreshResult = internalMutation({
  args: { runId: runIdValidator, result: runResultValidator },
  returns: v.null(),
  handler: async (ctx, { runId, result }) => {
    let state: Doc<"openRouterCatalogSync"> | null = null
    for (const provider of DIRECT_PROVIDERS) {
      const candidate = await readSyncState(ctx, provider)
      if (candidate?.runId === runId) state = candidate
    }
    if (!state) return null
    if (result.type === "success") {
      // The action returned without publishing (key removed meanwhile).
      if (state.status === "running") {
        await ctx.db.patch("openRouterCatalogSync", state._id, {
          status: state.lastSuccessAt === undefined ? "failed" : "success",
          ...(state.lastSuccessAt === undefined
            ? { error: "No API key is set." }
            : {}),
        })
      }
      return null
    }
    await ctx.db.patch("openRouterCatalogSync", state._id, {
      status: "failed",
      lastFailureAt: Date.now(),
      error:
        result.type === "failed"
          ? result.error.slice(0, 400)
          : "Catalog refresh canceled.",
    })
    return null
  },
})
