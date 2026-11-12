import { erasePageJobsForUser } from "./aiJobs"
import { eraseSpendingAttemptsForUser, writePostAdmissionAudit } from "./ai"
// convex/cms/aiAuditLog.ts
// ADR-0015 — runtime AI audit log: retention purge + per-user erasure.
//
// No writer ships in Phase 0. The first writer is the page-level spec's
// Phase 1 `generatePageMeta` action; until then this module is purely
// scaffolding so the schema, the cron, and the GDPR/CCPA erasure path are
// all in place before any row is written.
import { v } from "convex/values"
import { internalMutation, mutation } from "../_generated/server"
import { internal } from "../_generated/api"
import { requireInstallationOwner } from "../lib/access/policy"
import {
  aiCostSourceValidator,
  aiAttemptCountValidator,
  executionLaneValidator,
  generationEngineValidator,
  generationIdentityEvidenceValidator,
  reasoningEffortValidator,
  runtimeApiProviderValidator,
  taskProfileValidator,
  workflowPhaseValidator,
} from "../lib/aiValidators"

/**
 * Internal: write one audit row. Called from AI actions after a generation
 * call completes (or fails). `authId` is supplied by the action because the
 * action runs under the caller's identity; we keep this mutation auth-free so
 * it can also be invoked from background pipelines later.
 *
 * Privacy: callers MUST NOT pass the brief text — only its sha256 hash
 * (`briefHash`). Generated output is never stored.
 */
export const recordEvent = internalMutation({
  args: {
    authId: v.string(),
    kind: v.union(
      v.literal("page-generate-outline"),
      v.literal("page-generate-fill"),
      v.literal("page-generate-meta"),
      v.literal("help-answer"),
      v.literal("page-translate"),
      v.literal("field-translate"),
      v.literal("field-generate"),
      v.literal("field-refine"),
      v.literal("slice-generate"),
      v.literal("slice-author-propose")
    ),
    runId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    chargedMicros: v.optional(v.number()),
    currency: v.optional(v.literal("USD")),
    costSource: v.optional(aiCostSourceValidator),
    briefHash: v.optional(v.string()),
    sliceCount: v.number(),
    modelId: v.string(),
    profile: v.optional(taskProfileValidator),
    selectedLane: v.optional(executionLaneValidator),
    selectedEngine: v.optional(generationEngineValidator),
    selectedProvider: v.optional(runtimeApiProviderValidator),
    selectedModel: v.optional(v.string()),
    selectedReasoning: v.optional(reasoningEffortValidator),
    actualProvider: v.optional(runtimeApiProviderValidator),
    actualEngine: v.optional(generationEngineValidator),
    actualModel: v.optional(v.string()),
    actualReasoning: v.optional(reasoningEffortValidator),
    routedProvider: v.optional(v.string()),
    phase: v.optional(workflowPhaseValidator),
    attempts: v.optional(aiAttemptCountValidator),
    identityEvidence: v.optional(generationIdentityEvidenceValidator),
    tokenUsage: v.object({
      promptTokens: v.optional(v.number()),
      completionTokens: v.optional(v.number()),
      totalTokens: v.optional(v.number()),
    }),
    success: v.boolean(),
    errorCode: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (args.attemptId)
      return writePostAdmissionAudit(ctx, {
        ...args,
        attemptId: args.attemptId,
      })

    await ctx.db.insert("aiAuditLog", { ...args, createdAt: Date.now() })
    return null
  },
})

/** 90 days in milliseconds — the retention boundary per ADR-0015. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

/** Rows deleted per purge transaction — small enough to stay well inside the
 *  per-mutation write limit. */
const PURGE_BATCH_SIZE = 500

/**
 * Nightly cron target: delete every audit row older than the retention
 * boundary. Paginated by batch size so a single tick never has to handle
 * an unbounded delete; a full batch self-continues via the scheduler so a
 * backlog drains within one night while each mutation stays small. A short
 * batch is the fixpoint (rows older than the cutoff only shrink), so the
 * continuation chain always terminates. Returns the number of rows removed
 * by this invocation for the cron log; the cron itself ignores the value.
 *
 * No auth: this runs from the scheduler, not a user request.
 */
export const purgeExpired = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx): Promise<number> => {
    const cutoff = Date.now() - RETENTION_MS
    const expired = await ctx.db
      .query("aiAuditLog")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
      .take(PURGE_BATCH_SIZE)
    await Promise.all(expired.map((row) => ctx.db.delete(row._id)))
    if (expired.length === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.cms.aiAuditLog.purgeExpired, {})
    }
    return expired.length
  },
})

/**
 * Installation-owner-only: delete every audit row belonging to one user, honouring a
 * right-to-erasure request without waiting for the next purge.
 *
 * Gated on the durable installation-owner seam because erasure can target any
 * account's audit rows and is therefore an owner-only administration action.
 */
export const deleteAuditLogForUser = mutation({
  args: { authId: v.string() },
  returns: v.number(),
  handler: async (ctx, { authId }) => {
    await requireInstallationOwner(ctx)
    return eraseUserBatch(ctx, authId)
  },
})
async function eraseUserBatch(
  ctx: import("../_generated/server").MutationCtx,
  authId: string
): Promise<number> {
  const moreAttempts = await eraseSpendingAttemptsForUser(ctx, authId)
  const moreJobs = await erasePageJobsForUser(ctx, authId)
  const rows = await ctx.db
    .query("aiAuditLog")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .take(500)
  for (const row of rows) await ctx.db.delete("aiAuditLog", row._id)
  if (moreAttempts || moreJobs || rows.length === 500)
    await ctx.scheduler.runAfter(0, internal.cms.aiAuditLog.continueErasure, {
      authId,
    })
  return rows.length
}
export const continueErasure = internalMutation({
  args: { authId: v.string() },
  returns: v.number(),
  handler: async (ctx, { authId }) => eraseUserBatch(ctx, authId),
})
