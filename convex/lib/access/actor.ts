import { getAuthUserId } from "@convex-dev/auth/server"
import { ConvexError } from "convex/values"
import type { ActionCtx, MutationCtx, QueryCtx } from "../../_generated/server"

/**
 * The only file in `convex/` that reads the caller's identity (ADR-0056 rule
 * 2). Convex Auth puts the SESSION id in the token `subject`, so the person is
 * whoever the session belongs to: `getAuthUserId` looks the session up and
 * returns the user ID. Two sessions of one person share a `userId`. Every
 * stored `authId` and `tokenIdentifier` field holds this `userId`.
 *
 * A grep gate checks that no other non-test file calls `getUserIdentity` or
 * `getAuthUserId`.
 */
export type ActorContext = QueryCtx | MutationCtx | ActionCtx

export type Actor = {
  /** Convex Auth user ID. Stable across sessions. */
  userId: string
  /** The caller's current session ID (the token subject). */
  sessionId: string
}

/** Returns the signed-in actor, or null for a signed-out caller. */
export async function getActor(ctx: ActorContext): Promise<Actor | null> {
  const identity = await ctx.auth.getUserIdentity()
  if (identity === null) return null
  // `getAuthUserId` types its context as a query context. An action context
  // calls `runQuery` the same way at runtime; only its optional second
  // argument differs in type, so the cast is safe.
  const userId = await getAuthUserId(
    ctx as unknown as Pick<QueryCtx, "auth" | "runQuery">
  )
  // A valid token whose session is gone (signed out, revoked) is signed out.
  if (userId === null) return null
  return { userId, sessionId: identity.subject }
}

/** Throws UNAUTHENTICATED for a signed-out caller. */
export async function requireActor(ctx: ActorContext): Promise<Actor> {
  const actor = await getActor(ctx)
  if (!actor) throw new ConvexError("UNAUTHENTICATED")
  return actor
}

/**
 * The owner's stored notification email, the ONE place that answers it
 * (ADR-0056 rule 5). Convex Auth tokens carry no email. It is used only for
 * contact-form messages and the test email, never for sign-in. Null when the
 * owner has not set one.
 */
export async function getOwnerNotificationEmail(
  ctx: QueryCtx | MutationCtx
): Promise<string | null> {
  const rows = await ctx.db
    .query("cmsOwner")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  if (rows.length !== 1) return null
  return rows[0]!.notificationEmail ?? null
}
