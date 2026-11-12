import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"

/**
 * Publishing pipeline: page-editor lock (plan 028 C0).
 *
 * A single-holder soft lock, refreshed by the same heartbeat that drives
 * presence. Expires after `PAGE_LOCK_ACTIVE_MS` with no touch; `force`
 * override is honored by `acquirePageEditorLock` for the take-over flow.
 */

export const PAGE_LOCK_ACTIVE_MS = 90_000

export type LockAuth = {
  userId: string
  email?: string | null
}

export type EditorLockState =
  | { status: "available"; lock: null; isMine: boolean }
  | { status: "locked"; lock: Doc<"pageEditorLocks">; isMine: boolean }

export type AcquireLockResult =
  | { status: "acquired"; lock: Doc<"pageEditorLocks"> }
  | { status: "blocked"; lock: Doc<"pageEditorLocks"> }

/** The most-recently-active lock, if any (used by the read query). */
export async function getPageEditorLockState(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
  userId: string,
  now: number = Date.now()
): Promise<EditorLockState> {
  const activeAfter = now - PAGE_LOCK_ACTIVE_MS
  const locks = await ctx.db
    .query("pageEditorLocks")
    .withIndex("by_pageId_and_lastActiveAt", (q) =>
      q.eq("pageId", pageId).gte("lastActiveAt", activeAfter)
    )
    .order("desc")
    .take(1)
  const lock = locks[0]
  if (!lock) {
    return { status: "available", lock: null, isMine: false }
  }
  return {
    status: "locked",
    lock,
    isMine: lock.userId === userId,
  }
}

/**
 * Acquire (or refresh) the caller's lock. If someone else's lock is still
 * active and `force` is false, returns `blocked`; otherwise other holders are
 * evicted.
 */
export async function acquirePageEditorLock(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  auth: LockAuth,
  force: boolean,
  now: number = Date.now()
): Promise<AcquireLockResult> {
  const activeAfter = now - PAGE_LOCK_ACTIVE_MS
  const locks = await ctx.db
    .query("pageEditorLocks")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(20)
  const activeOther = locks.find(
    (lock) => lock.userId !== auth.userId && lock.lastActiveAt >= activeAfter
  )
  if (activeOther && !force) {
    return { status: "blocked", lock: activeOther }
  }

  await Promise.all(
    locks
      .filter((lock) => lock.userId !== auth.userId)
      .map((lock) => ctx.db.delete(lock._id))
  )

  const ownLock = locks.find((lock) => lock.userId === auth.userId)
  const patch = {
    name: auth.email?.split("@")[0] ?? undefined,
    email: auth.email ?? undefined,
    lastActiveAt: now,
    updatedAt: now,
  }

  if (ownLock) {
    await ctx.db.patch(ownLock._id, patch)
    const lock = await ctx.db.get(ownLock._id)
    if (!lock) throw new ConvexError("Could not refresh editor lock")
    return { status: "acquired", lock }
  }

  const lockId = await ctx.db.insert("pageEditorLocks", {
    pageId,
    userId: auth.userId,
    acquiredAt: now,
    ...patch,
  })
  const lock = await ctx.db.get(lockId)
  if (!lock) throw new ConvexError("Could not acquire editor lock")
  return { status: "acquired", lock }
}

/** Release only the caller's own lock (if any). */
export async function releasePageEditorLock(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  auth: LockAuth
): Promise<void> {
  const locks = await ctx.db
    .query("pageEditorLocks")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(20)
  await Promise.all(
    locks
      .filter((lock) => lock.userId === auth.userId)
      .map((lock) => ctx.db.delete(lock._id))
  )
}
