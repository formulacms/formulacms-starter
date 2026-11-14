// Callbacks the Convex Auth password method calls (ADR-0056). Shape follows
// the official example (examples/nextjs/convex/users.ts).
//
// Source comments in the library document two behaviours this file relies on:
// throwing in `createUser` cancels the whole sign-up, and throwing in
// `onSignIn` refuses the sign-in. Tests in `users.test.ts` guard both.
import { ConvexError, v } from "convex/values"
import { internalMutation, query } from "./_generated/server"
import { getActor } from "./lib/access/actor"
import {
  insertOwnerForClaim,
  readOwnerState,
  replaceOwnerBinding,
} from "./lib/access/owner"
import { revokeAllSessionsOf } from "./lib/sessions"
import { resolveOwnerClaimTransition } from "./lib/ownerClaim"

const methodValidator = v.object({
  name: v.literal("usernamePassword"),
  profile: v.object({}),
})

/**
 * The ONE grant check for new accounts (ADR-0056 rule 1). A direct call to
 * the public sign-up mutation has no grant in its transaction and is refused,
 * which rolls back the whole sign-up. Two grants exist, and both are inserted
 * inside the transaction of the public function that checks them:
 * - "owner": the owner code, `cms.owner.createOwnerAccount` (first owner);
 * - "recovery": a one-time link, `cms.recovery.claimRecoveryLink` (rule 4).
 */
export const createUser = internalMutation({
  args: { method: methodValidator },
  returns: v.id("users"),
  handler: async (ctx) => {
    const grants = await ctx.db.query("signupGrants").take(2)
    if (grants.length !== 1) {
      throw new ConvexError({ code: "SIGNUP_CLOSED" })
    }
    const grant = grants[0]!

    if (grant.kind === "owner") {
      // Re-check eligibility here so this callback stays authoritative even
      // if a future caller inserts a grant carelessly.
      if ((await resolveOwnerClaimTransition(ctx)).kind !== "fresh") {
        throw new ConvexError({ code: "SIGNUP_CLOSED" })
      }
      const userId = await ctx.db.insert("users", { name: grant.name })
      const owner = await insertOwnerForClaim(ctx, {
        authId: userId,
        tokenIdentifier: userId,
        email: null,
      })
      if (grant.notificationEmail !== undefined) {
        await ctx.db.patch("cmsOwner", owner.ownerId, {
          notificationEmail: grant.notificationEmail,
        })
      }
      await ctx.db.insert("ownerClaimLedger", {
        key: "owner",
        secretHash: grant.claimHash,
        claimedBy: userId,
        claimedAt: Date.now(),
        recovery: false,
      })
      await ctx.db.delete("signupGrants", grant._id)
      return userId
    }

    // Recovery: the link must still be open and unexpired, and an owner must
    // exist to be replaced.
    const link = await ctx.db.get("recoveryGrants", grant.recoveryGrantId)
    const state = await readOwnerState(ctx)
    if (
      !link ||
      link.state !== "open" ||
      link.expiresAt <= Date.now() ||
      state.status !== "ready"
    ) {
      throw new ConvexError({ code: "SIGNUP_CLOSED" })
    }
    const outgoingAuthId = state.owner.authId

    // The new account keeps the label the owner typed at setup.
    const outgoingUserId = ctx.db.normalizeId("users", outgoingAuthId)
    const outgoingUser = outgoingUserId
      ? await ctx.db.get("users", outgoingUserId)
      : null
    const userId = await ctx.db.insert("users", {
      ...(outgoingUser?.name ? { name: outgoingUser.name } : {}),
    })
    await replaceOwnerBinding(ctx, state.owner, {
      authId: userId,
      tokenIdentifier: userId,
      email: null,
    })
    // The old account can no longer sign in (`onSignIn`) and loses its sessions.
    if (outgoingUserId) {
      await ctx.db.patch("users", outgoingUserId, { disabled: true })
    }
    await revokeAllSessionsOf(ctx, outgoingAuthId)
    const ledger = await ctx.db
      .query("ownerClaimLedger")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique()
    if (ledger) {
      await ctx.db.patch("ownerClaimLedger", ledger._id, {
        claimedBy: userId,
        claimedAt: Date.now(),
        recovery: true,
      })
    }
    await ctx.db.patch("recoveryGrants", link._id, {
      state: "consumed",
      consumedBy: userId,
    })
    await ctx.db.delete("signupGrants", grant._id)
    return userId
  },
})

/** Runs on every sign-in. A disabled (replaced) account cannot sign in. */
export const onSignIn = internalMutation({
  args: { method: methodValidator, userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get("users", userId)
    if (user?.disabled === true) {
      throw new ConvexError({ code: "ACCOUNT_DISABLED" })
    }
    return null
  },
})

/**
 * The signed-in person's label for the public header (ADR-0056 rule 8). It
 * returns the name typed at setup and nothing else: never the username, the
 * user ID or the session ID. Null when signed out.
 */
export const getCurrentUserLabel = query({
  args: {},
  returns: v.union(v.null(), v.object({ name: v.union(v.string(), v.null()) })),
  handler: async (ctx) => {
    const actor = await getActor(ctx)
    if (!actor) return null
    const userId = ctx.db.normalizeId("users", actor.userId)
    const user = userId ? await ctx.db.get("users", userId) : null
    return { name: user?.name?.trim() || null }
  },
})
