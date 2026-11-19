import {
  ActionRetrier,
  runIdValidator,
  runResultValidator,
} from "@convex-dev/action-retrier"
import type { RunId } from "@convex-dev/action-retrier"
import { v } from "convex/values"
import { components, internal } from "../_generated/api"
import {
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server"
import {
  OPENROUTER_CATALOG_MAX_MODELS,
  OPENROUTER_MODELS_URL,
  parseOpenRouterRows,
} from "../../lib/ai/openrouter-catalog"
import { readSyncState, startCatalogRefresh } from "../lib/catalogRefresh"
import { reasoningEffortValidator } from "../lib/aiValidators"

const FETCH_TIMEOUT_MS = 15_000

const inputModalityValidator = v.union(
  v.literal("text"),
  v.literal("image"),
  v.literal("file"),
  v.literal("audio"),
  v.literal("video")
)

export const catalogModelValidator = v.object({
  modelId: v.string(),
  name: v.string(),
  inputModalities: v.array(inputModalityValidator),
  structuredOutput: v.boolean(),
  reasoningEfforts: v.array(reasoningEffortValidator),
  inputPerM: v.optional(v.number()),
  outputPerM: v.optional(v.number()),
  ceilingInputPerM: v.optional(v.number()),
  ceilingOutputPerM: v.optional(v.number()),
  releasedAt: v.optional(v.number()),
  expiresAt: v.optional(v.number()),
  vendorEfforts: v.optional(v.array(reasoningEffortValidator)),
  defaultEffort: v.optional(reasoningEffortValidator),
  reasoningMandatory: v.optional(v.boolean()),
  hasReasoning: v.optional(v.boolean()),
  contextLength: v.optional(v.number()),
  maxOutputTokens: v.optional(v.number()),
})

export const openRouterCatalogRetrier = new ActionRetrier(
  components.actionRetrier,
  {
    initialBackoffMs: 5_000,
    base: 2,
    maxFailures: 4,
  }
)

/** Starts one refresh unless a run is still inside the one-hour lock window. */
export async function startOpenRouterRefresh(ctx: MutationCtx): Promise<null> {
  return startCatalogRefresh(ctx, "openrouter", async () => {
    const runId: RunId = await openRouterCatalogRetrier.run(
      ctx,
      internal.cms.openRouterCatalog.fetchAndPublish,
      {},
      { onComplete: internal.cms.openRouterCatalog.recordRefreshResult }
    )
    return runId as string
  })
}

/** Daily cron target (the name predates the daily schedule). Starts at most
 * one refresh within the lock window. */
export const enqueueWeeklyRefresh = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => startOpenRouterRefresh(ctx),
})

/**
 * Hourly cron target. Starts the same refresh only while no refresh ever
 * succeeded, so a new site gets its price list without waiting for Sunday.
 */
export const ensureFirstRefresh = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const state = await readSyncState(ctx, "openrouter")
    if (state?.lastSuccessAt !== undefined) return null
    return startOpenRouterRefresh(ctx)
  },
})

/** Retried external read. Publication happens only after full validation. */
export const fetchAndPublish = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`OpenRouter model catalog responded ${response.status}.`)
    }
    // Rolling aliases and `:batch` rows are dropped; the new facts are stored.
    const models = parseOpenRouterRows(await response.json())
    const syncedAt = Date.now()
    await ctx.runMutation(internal.cms.openRouterCatalog.publishCatalog, {
      models,
      syncedAt,
    })
    return models.length
  },
})

const MODEL_FIELDS = Object.keys(catalogModelValidator.fields) as Array<
  keyof typeof catalogModelValidator.fields
>

/** Whether a stored row already holds every field of the incoming row. */
function sameModel(
  current: Record<string, unknown>,
  next: Record<string, unknown>
): boolean {
  return MODEL_FIELDS.every(
    (field) => JSON.stringify(current[field]) === JSON.stringify(next[field])
  )
}

/** Replace the active snapshot in one bounded, atomic transaction. */
export const publishCatalog = internalMutation({
  args: {
    models: v.array(catalogModelValidator),
    syncedAt: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, { models, syncedAt }) => {
    if (models.length === 0 || models.length > OPENROUTER_CATALOG_MAX_MODELS) {
      throw new Error("Refusing to publish an invalid OpenRouter catalog size.")
    }
    const current = await ctx.db
      .query("openRouterCatalogModels")
      .take(OPENROUTER_CATALOG_MAX_MODELS + 1)
    if (current.length > OPENROUTER_CATALOG_MAX_MODELS) {
      throw new Error("Stored OpenRouter catalog exceeds its safety bound.")
    }
    const desired = new Map(models.map((model) => [model.modelId, model]))

    await Promise.all(
      current.map((row) => {
        const next = desired.get(row.modelId)
        if (!next) {
          return ctx.db.delete("openRouterCatalogModels", row._id)
        }
        desired.delete(row.modelId)
        if (!sameModel(row, next)) {
          return ctx.db.replace("openRouterCatalogModels", row._id, {
            ...next,
            syncedAt,
          })
        }
        return undefined
      })
    )
    await Promise.all(
      Array.from(desired.values()).map((model) =>
        ctx.db.insert("openRouterCatalogModels", {
          ...model,
          syncedAt,
        })
      )
    )

    const state = await readSyncState(ctx, "openrouter")
    const update = {
      key: "openrouter" as const,
      status: "success" as const,
      lastAttemptAt: state?.lastAttemptAt ?? syncedAt,
      lastSuccessAt: syncedAt,
      modelCount: models.length,
      ...(state?.runId === undefined ? {} : { runId: state.runId }),
      ...(state?.lastFailureAt === undefined
        ? {}
        : { lastFailureAt: state.lastFailureAt }),
    }
    if (state) {
      await ctx.db.replace("openRouterCatalogSync", state._id, update)
    } else {
      await ctx.db.insert("openRouterCatalogSync", update)
    }
    return models.length
  },
})

/** Exactly-once completion callback for exhausted retries or cancellation. */
export const recordRefreshResult = internalMutation({
  args: { runId: runIdValidator, result: runResultValidator },
  returns: v.null(),
  handler: async (ctx, { runId, result }) => {
    const state = await readSyncState(ctx, "openrouter")
    if (!state || state.runId !== runId) return null
    if (result.type === "success") return null

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
