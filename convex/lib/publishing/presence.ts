import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"

/**
 * Publishing pipeline: page-editor presence (plan 028 C0).
 *
 * Tracks which authenticated users are currently editing a page. The row is
 * refreshed by client heartbeats (`touchPagePresence`) and deleted on
 * `leavePagePresence` — plus a per-touch sweep of anything past
 * `PAGE_PRESENCE_ACTIVE_MS`.
 */

export const PAGE_PRESENCE_ACTIVE_MS = 45_000

/** Client identity fields the caller has already resolved (email + userId). */
export type PresenceAuth = {
  userId: string
  email?: string | null
}

/** Refresh (or insert) the caller's presence row for this page, then sweep. */
export async function touchPagePresence(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  auth: PresenceAuth,
  now: number = Date.now()
): Promise<void> {
  const existing = await ctx.db
    .query("pagePresence")
    .withIndex("by_pageId_and_userId", (q) =>
      q.eq("pageId", pageId).eq("userId", auth.userId)
    )
    .unique()

  const patch = {
    name: auth.email?.split("@")[0] ?? undefined,
    email: auth.email ?? undefined,
    lastActiveAt: now,
    updatedAt: now,
  }
  if (existing) {
    await ctx.db.patch(existing._id, patch)
  } else {
    await ctx.db.insert("pagePresence", {
      pageId,
      userId: auth.userId,
      ...patch,
    })
  }

  const staleBefore = now - PAGE_PRESENCE_ACTIVE_MS
  const staleRows = await ctx.db
    .query("pagePresence")
    .withIndex("by_pageId_and_lastActiveAt", (q) =>
      q.eq("pageId", pageId).lt("lastActiveAt", staleBefore)
    )
    .take(20)
  await Promise.all(staleRows.map((row) => ctx.db.delete(row._id)))
}

/** Delete the caller's presence row for this page, if any. */
export async function leavePagePresence(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  auth: PresenceAuth
): Promise<void> {
  const existing = await ctx.db
    .query("pagePresence")
    .withIndex("by_pageId_and_userId", (q) =>
      q.eq("pageId", pageId).eq("userId", auth.userId)
    )
    .unique()
  if (existing) await ctx.db.delete(existing._id)
}

/** List active (non-stale) presence rows for a page, newest-touch first. */
export async function listActivePagePresence(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
  now: number = Date.now()
): Promise<Doc<"pagePresence">[]> {
  const activeAfter = now - PAGE_PRESENCE_ACTIVE_MS
  return await ctx.db
    .query("pagePresence")
    .withIndex("by_pageId_and_lastActiveAt", (q) =>
      q.eq("pageId", pageId).gte("lastActiveAt", activeAfter)
    )
    .order("desc")
    .take(20)
}
