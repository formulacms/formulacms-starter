// The owner's own password change (ADR-0056 rule 6 later reuses this for the
// editor's forced change). A typed wrapper over the library's documented
// `changePassword`, which verifies the current password under its own rate
// limit; `signOutOtherSessions` ends every other session of the caller.
import { v } from "convex/values"
import type { Infer } from "convex/values"
import type { ChangePasswordResult } from "@convex-dev/auth/methods/username-password/server"
import { api } from "./_generated/api"
import { mutation } from "./_generated/server"
import { requireActor } from "./lib/access/actor"

const changeMyPasswordResultValidator = v.union(
  v.object({ status: v.literal("changed") }),
  v.object({ status: v.literal("wrong_password") }),
  v.object({ status: v.literal("invalid_input"), error: v.string() }),
  v.object({ status: v.literal("rate_limited"), retryAfterMs: v.number() })
)

export const changeMyPassword = mutation({
  args: { currentPassword: v.string(), newPassword: v.string() },
  returns: changeMyPasswordResultValidator,
  handler: async (
    ctx,
    args
  ): Promise<Infer<typeof changeMyPasswordResultValidator>> => {
    await requireActor(ctx)
    const result: ChangePasswordResult = await ctx.runMutation(
      api.auth.changePassword,
      { ...args, signOutOtherSessions: true }
    )
    if (result.success) return { status: "changed" }
    const error = result.userError
    if (error.error === "INVALID_CREDENTIALS") return { status: "wrong_password" }
    if (error.error === "RATE_LIMITED") {
      return { status: "rate_limited", retryAfterMs: error.retryAfterMs }
    }
    if (error.error === "NOT_LOGGED_IN") {
      return { status: "invalid_input", error: "NOT_LOGGED_IN" }
    }
    return { status: "invalid_input", error: error.error }
  },
})
