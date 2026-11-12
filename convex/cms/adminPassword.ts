import { hashPassword } from "better-auth/crypto"
import { ConvexError, v } from "convex/values"
import { components, internal } from "../_generated/api"
import { internalAction, internalQuery } from "../_generated/server"

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const OWNER_NOT_FOUND = "No durable owner account matches that email."

/**
 * Durable-owner gate for the operator-only password recovery action.
 * Keeping the recovery function internal makes the Convex deployment console
 * or CLI credential the authority boundary; browsers cannot invoke it.
 */
export const assertDurableOwnerTarget = internalQuery({
  args: { authId: v.string() },
  returns: v.null(),
  handler: async (ctx, { authId }) => {
    const owners = await ctx.db
      .query("cmsOwner")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .take(2)
    if (owners.length !== 1 || owners[0]?.authId !== authId) {
      throw new ConvexError(OWNER_NOT_FOUND)
    }
    return null
  },
})

/**
 * Deployment-operator recovery path for a locked-out durable owner.
 *
 * Run only through `pnpm admin:reset-password` from a trusted terminal. This
 * deliberately bypasses email delivery, creates a credential account when the
 * owner signed up with OAuth only, and revokes all existing sessions after
 * changing the password.
 */
export const resetAdminPassword = internalAction({
  args: {
    email: v.string(),
    newPassword: v.string(),
  },
  returns: v.object({
    reset: v.boolean(),
    sessionsRevoked: v.number(),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ reset: boolean; sessionsRevoked: number }> => {
    const email = args.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ConvexError("Enter a valid owner email address.")
    }
    if (args.newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new ConvexError("Password must be at least 8 characters.")
    }
    if (args.newPassword.length > MAX_PASSWORD_LENGTH) {
      throw new ConvexError("Password must be at most 128 characters.")
    }

    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "email", operator: "eq", value: email }],
    })
    if (!user) throw new ConvexError(OWNER_NOT_FOUND)

    const authId = user._id as string
    await ctx.runQuery(internal.cms.adminPassword.assertDurableOwnerTarget, {
      authId,
    })

    const [password, credentialAccount] = await Promise.all([
      hashPassword(args.newPassword),
      ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: "account",
        where: [
          { field: "userId", operator: "eq", value: authId },
          { field: "providerId", operator: "eq", value: "credential" },
        ],
      }),
    ])
    const now = Date.now()

    if (credentialAccount) {
      await ctx.runMutation(components.betterAuth.adapter.updateOne, {
        input: {
          model: "account",
          where: [
            { field: "_id", operator: "eq", value: credentialAccount._id },
          ],
          update: { password, updatedAt: now },
        },
      })
    } else {
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: "account",
          data: {
            accountId: authId,
            providerId: "credential",
            userId: authId,
            password,
            createdAt: now,
            updatedAt: now,
          },
        },
      })
    }

    let sessionsRevoked = 0
    while (true) {
      const batch: { deleted: number; complete: boolean } =
        await ctx.runMutation(internal.cms.owner.deleteOwnerSessionBatch, {
          authId,
        })
      sessionsRevoked += batch.deleted
      if (batch.complete) break
    }

    return { reset: true, sessionsRevoked }
  },
})
