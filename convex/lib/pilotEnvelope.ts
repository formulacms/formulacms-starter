import { ConvexError } from "convex/values"
import type { Id } from "../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../_generated/server"

/**
 * The existing public route resolver and sitemap each use `.take(500)` on a
 * pages query. Until ROUTE-04 replaces those bounded reads, a pilot must stay
 * strictly below the sentinel: 499 rows maximum, never 500.
 */
export const BOUNDED_PILOT_PAGE_SENTINEL = 500
export const BOUNDED_PILOT_MAX_PAGE_COUNT = BOUNDED_PILOT_PAGE_SENTINEL - 1
export const BOUNDED_PILOT_WARNING_PERCENT = 80
export const BOUNDED_PILOT_WARNING_PAGE_COUNT = Math.ceil(
  (BOUNDED_PILOT_MAX_PAGE_COUNT * BOUNDED_PILOT_WARNING_PERCENT) / 100
)

export type BoundedPilotEnvelope = {
  totalPageCount: number
  publishedPageCount: number
  totalPagesBelowCap: boolean
  publishedPagesBelowCap: boolean
  totalPagesCanAcceptOne: boolean
  publishedPagesCanAcceptOne: boolean
  totalPagesAtOrAboveWarningThreshold: boolean
  publishedPagesAtOrAboveWarningThreshold: boolean
}

/**
 * Reads exactly the same sentinel size as the constrained route/sitemap
 * surfaces. It intentionally returns booleans rather than catalog counts so
 * the public status check cannot become a content-discovery endpoint.
 */
export async function readBoundedPilotEnvelope(
  ctx: QueryCtx | MutationCtx
): Promise<BoundedPilotEnvelope> {
  const [allPages, publishedPages] = await Promise.all([
    ctx.db.query("pages").take(BOUNDED_PILOT_PAGE_SENTINEL),
    ctx.db
      .query("pages")
      .withIndex("by_status", (q) => q.eq("status", "published"))
      .take(BOUNDED_PILOT_PAGE_SENTINEL),
  ])
  return {
    totalPageCount: allPages.length,
    publishedPageCount: publishedPages.length,
    totalPagesBelowCap: allPages.length < BOUNDED_PILOT_PAGE_SENTINEL,
    publishedPagesBelowCap:
      publishedPages.length < BOUNDED_PILOT_PAGE_SENTINEL,
    totalPagesCanAcceptOne: allPages.length < BOUNDED_PILOT_MAX_PAGE_COUNT,
    publishedPagesCanAcceptOne:
      publishedPages.length < BOUNDED_PILOT_MAX_PAGE_COUNT,
    totalPagesAtOrAboveWarningThreshold:
      allPages.length >= BOUNDED_PILOT_WARNING_PAGE_COUNT,
    publishedPagesAtOrAboveWarningThreshold:
      publishedPages.length >= BOUNDED_PILOT_WARNING_PAGE_COUNT,
  }
}

type PilotEnvelopeRow = {
  id: Id<"pilotEnvelope">
  totalPageCount: number
  publishedPageCount: number
}

async function getOrInitializePilotEnvelope(
  ctx: MutationCtx
): Promise<PilotEnvelopeRow> {
  const existing = await ctx.db.query("pilotEnvelope").first()
  if (existing) {
    return {
      id: existing._id,
      totalPageCount: existing.totalPageCount,
      publishedPageCount: existing.publishedPageCount,
    }
  }

  // A fresh starter starts at zero and takes this cheap path. Existing trees
  // are measured once before any ordinary write is allowed; if their bounded
  // reads already truncate, fail closed instead of guessing a counter.
  const measured = await readBoundedPilotEnvelope(ctx)
  if (!measured.totalPagesBelowCap) {
    throw new ConvexError(envelopeMessage("total"))
  }
  if (!measured.publishedPagesBelowCap) {
    throw new ConvexError(envelopeMessage("published"))
  }
  const now = Date.now()
  const id = await ctx.db.insert("pilotEnvelope", {
    totalPageCount: measured.totalPageCount,
    publishedPageCount: measured.publishedPageCount,
    updatedAt: now,
  })
  return {
    id,
    totalPageCount: measured.totalPageCount,
    publishedPageCount: measured.publishedPageCount,
  }
}

/** Reconcile the lightweight write counter from the authoritative bounded read. */
export async function initializeBoundedPilotEnvelope(
  ctx: MutationCtx
): Promise<BoundedPilotEnvelope> {
  const measured = await readBoundedPilotEnvelope(ctx)
  if (!measured.totalPagesBelowCap) {
    throw new ConvexError(envelopeMessage("total"))
  }
  if (!measured.publishedPagesBelowCap) {
    throw new ConvexError(envelopeMessage("published"))
  }
  const existing = await ctx.db.query("pilotEnvelope").first()
  const patch = {
    totalPageCount: measured.totalPageCount,
    publishedPageCount: measured.publishedPageCount,
    updatedAt: Date.now(),
  }
  if (existing) await ctx.db.patch(existing._id, patch)
  else await ctx.db.insert("pilotEnvelope", patch)
  return measured
}

function envelopeMessage(scope: "total" | "published"): string {
  return scope === "total"
    ? `Bounded pilot envelope reached: this starter may hold at most ${BOUNDED_PILOT_MAX_PAGE_COUNT} pages until ROUTE-04 lands.`
    : `Bounded pilot envelope reached: this starter may hold at most ${BOUNDED_PILOT_MAX_PAGE_COUNT} published pages until ROUTE-04 lands.`
}

/** Reject a normal page creation before it can make a bounded read truncate. */
export async function assertBoundedPilotCanCreate(
  ctx: MutationCtx,
  willPublish: boolean
): Promise<void> {
  const envelope = await getOrInitializePilotEnvelope(ctx)
  if (envelope.totalPageCount >= BOUNDED_PILOT_MAX_PAGE_COUNT) {
    throw new ConvexError({ code: "PILOT_PAGE_LIMIT", message: envelopeMessage("total") })
  }
  if (
    willPublish &&
    envelope.publishedPageCount >= BOUNDED_PILOT_MAX_PAGE_COUNT
  ) {
    throw new ConvexError(envelopeMessage("published"))
  }
  await ctx.db.patch(envelope.id, {
    totalPageCount: envelope.totalPageCount + 1,
    publishedPageCount:
      envelope.publishedPageCount + (willPublish ? 1 : 0),
    updatedAt: Date.now(),
  })
}

/**
 * Reject a draft/archived promotion that would enter or remain in a truncated
 * route/sitemap state. Republishing an already-live page does not add a row
 * to the published set, so it remains allowed while the envelope is healthy.
 */
export async function assertBoundedPilotCanPublish(
  ctx: MutationCtx,
  currentlyPublished: boolean
): Promise<void> {
  const envelope = await getOrInitializePilotEnvelope(ctx)
  if (envelope.totalPageCount >= BOUNDED_PILOT_PAGE_SENTINEL) {
    throw new ConvexError({ code: "PILOT_PAGE_LIMIT", message: envelopeMessage("total") })
  }
  if (
    !currentlyPublished &&
    envelope.publishedPageCount >= BOUNDED_PILOT_MAX_PAGE_COUNT
  ) {
    throw new ConvexError(envelopeMessage("published"))
  }
  if (!currentlyPublished) {
    await ctx.db.patch(envelope.id, {
      publishedPageCount: envelope.publishedPageCount + 1,
      updatedAt: Date.now(),
    })
  }
}

/**
 * Non-mutating scheduling preflight. A legacy/imported tree without a ledger
 * is measured once; an unsafe result is treated as a failed preflight so the
 * cron can clear the schedule instead of retrying it forever.
 */
export async function canBoundedPilotPublish(
  ctx: MutationCtx,
  currentlyPublished: boolean
): Promise<boolean> {
  try {
    const envelope = await getOrInitializePilotEnvelope(ctx)
    return (
      envelope.totalPageCount < BOUNDED_PILOT_PAGE_SENTINEL &&
      (currentlyPublished ||
        envelope.publishedPageCount < BOUNDED_PILOT_MAX_PAGE_COUNT)
    )
  } catch (error) {
    if (error instanceof ConvexError) return false
    throw error
  }
}

/** Keep the ledger aligned when a live page leaves the published status. */
export async function releaseBoundedPilotPublishedSlot(
  ctx: MutationCtx
): Promise<void> {
  const envelope = await ctx.db.query("pilotEnvelope").first()
  // Do not make a legacy over-cap tree undeletable or unarchivable just to
  // create its counter. The next guarded creation/promotion will measure it
  // and fail closed; an operator can reconcile after bringing it below cap.
  if (!envelope || envelope.publishedPageCount === 0) return
  await ctx.db.patch(envelope._id, {
    publishedPageCount: envelope.publishedPageCount - 1,
    updatedAt: Date.now(),
  })
}

/** Keep the ledger aligned when a page is hard-deleted. */
export async function releaseBoundedPilotPageSlot(
  ctx: MutationCtx,
  wasPublished: boolean
): Promise<void> {
  const envelope = await ctx.db.query("pilotEnvelope").first()
  if (!envelope) return
  await ctx.db.patch(envelope._id, {
    totalPageCount: Math.max(0, envelope.totalPageCount - 1),
    publishedPageCount: wasPublished
      ? Math.max(0, envelope.publishedPageCount - 1)
      : envelope.publishedPageCount,
    updatedAt: Date.now(),
  })
}
