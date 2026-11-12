import type { Doc } from "../../_generated/dataModel"
import type { QueryCtx, MutationCtx } from "../../_generated/server"

/**
 * Publishing pipeline: scheduled state transitions (plan 028 C0).
 *
 * The transition mutation itself lives in `convex/cms/pages.ts` because it
 * coordinates domain-specific machinery (revisions, checklists, webhooks,
 * revalidation). What lives here are the queries that pick up work, plus the
 * batch size — the seams that would recur if another content type ever grew
 * its own scheduling story.
 */

// One publish and one expiry per mutation keeps each document's revision,
// reference/search rebuild, webhook fan-out, and revalidation inside a small
// transaction budget. The worker immediately schedules itself when either
// queue may contain more work, so this bounds transactions without capping
// backlog throughput at the one-minute cron interval.
export const SCHEDULED_TRANSITION_BATCH_SIZE = 1

/**
 * Staging rows whose `scheduledAt` has arrived, up to the batch size.
 *
 * ADR-0041 Deploy 2 PR B — scheduling now lives on `pageStaging`, not on
 * `pages`. The cron still filters to draft pages via a follow-up `ctx.db.get`
 * in the caller (the by_scheduledAt index carries no status). Because
 * `scheduledAt` is optional on staging, the range must scope `.gte(0)` to
 * skip staging rows without a scheduled time.
 */
export async function queryDueScheduledPublishes(
  ctx: QueryCtx | MutationCtx,
  now: number,
  batchSize: number = SCHEDULED_TRANSITION_BATCH_SIZE
): Promise<Doc<"pageStaging">[]> {
  return await ctx.db
    .query("pageStaging")
    .withIndex("by_scheduledAt", (q) =>
      q.gte("scheduledAt", 0).lte("scheduledAt", now)
    )
    .take(batchSize)
}

/** Published pages whose `expiresAt` has arrived, up to the batch size. */
export async function queryDueScheduledExpiries(
  ctx: QueryCtx | MutationCtx,
  now: number,
  batchSize: number = SCHEDULED_TRANSITION_BATCH_SIZE
): Promise<Doc<"pages">[]> {
  return await ctx.db
    .query("pages")
    .withIndex("by_status_and_expiresAt", (q) =>
      q.eq("status", "published").gte("expiresAt", 0).lte("expiresAt", now)
    )
    .take(batchSize)
}
