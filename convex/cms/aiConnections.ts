import { ConvexError, v } from "convex/values"
import { action, env, internalQuery } from "../_generated/server"
import { internal } from "../_generated/api"
import { validateApiConnection } from "../../lib/ai/connection-validation"
import { requireOwnerAndOptionalModule } from "../lib/modules/state"
import { runtimeApiProviderValidator } from "../lib/aiValidators"
import { rateLimiter } from "../lib/rateLimits"

const issueValidator = v.union(
  v.literal("missing-key"),
  v.literal("missing-cli"),
  v.literal("signed-out"),
  v.literal("wrong-auth-method"),
  v.literal("credentials-rejected"),
  v.literal("wrong-key-type"),
  v.literal("quota-exhausted"),
  v.literal("rate-limited"),
  v.literal("timeout"),
  v.literal("network"),
  v.literal("service-error"),
  v.literal("command-failed")
)

const checkValidator = v.union(
  v.object({
    state: v.literal("authenticated"),
    method: v.union(v.literal("api-key"), v.literal("subscription")),
  }),
  v.object({
    state: v.literal("not-configured"),
    issue: issueValidator,
  }),
  v.object({
    state: v.literal("invalid"),
    issue: issueValidator,
  }),
  v.object({
    state: v.literal("unreachable"),
    issue: issueValidator,
  })
)

/** F01 operation seam for the external validation action. */
export const assertCanValidate = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => {
    await requireOwnerAndOptionalModule(ctx, "ai", { requireReady: false })
    return true
  },
})

/**
 * Validate a live-site API connection inside the Convex deployment that will
 * execute it. No secret or vendor response body crosses this action boundary.
 */
export const validateProductionConnection = action({
  args: { provider: runtimeApiProviderValidator },
  returns: checkValidator,
  handler: async (ctx, { provider }) => {
    await ctx.runQuery(internal.cms.aiConnections.assertCanValidate, {})

    // Charge AFTER the operation gate, so an unauthorized caller can't burn
    // someone else's budget. Every call hits a paid vendor endpoint; this was
    // the one paid path with no ceiling on it.
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) throw new ConvexError("Unauthenticated")
    await rateLimiter.limit(ctx, "aiConnectionValidatePerUser", {
      key: identity.tokenIdentifier,
      throws: true,
    })

    const apiKey =
      provider === "openrouter"
        ? env.OPENROUTER_API_KEY
        : provider === "anthropic"
          ? env.ANTHROPIC_API_KEY
          : env.OPENAI_API_KEY
    return validateApiConnection(provider, apiKey)
  },
})
