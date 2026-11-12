"use node"

// Node-runtime E04 delivery action. Action Retrier invokes this function with
// only an opaque app event ID; full recipients/content never enter component
// arguments, return values, or errors.

import { v } from "convex/values"
import { internal } from "./_generated/api"
import { env, internalAction } from "./_generated/server"
import {
  dispatchPreparedEmail,
  type PreparedEmailDelivery,
} from "./lib/email/delivery.node"
import { EMAIL_PROVIDER_REGISTRY } from "./lib/email/providerRegistry.node"
import {
  terminalEmailDeliveryResultValidator,
  type TerminalEmailDeliveryResult,
} from "./lib/email/delivery"

type PreparedDeliveryAttempt =
  | Readonly<{
      kind: "terminal"
      result: TerminalEmailDeliveryResult
    }>
  | (Readonly<{ kind: "ready" }> & PreparedEmailDelivery)

export const getProviderReadiness = internalAction({
  args: { providerId: v.literal("resend") },
  returns: v.union(v.literal("needs_setup"), v.literal("ready")),
  handler: async (_ctx, { providerId }): Promise<"needs_setup" | "ready"> =>
    EMAIL_PROVIDER_REGISTRY.readiness(providerId, {
      environment: env as unknown as Readonly<
        Record<string, string | undefined>
      >,
    }),
})

/**
 * One retried FormulaCMS delivery attempt. Only the explicit
 * `retryable_failure` result (a provider error proven `not_sent`) becomes a
 * thrown Action Retrier failure. Unknown delivery and every other result
 * return normally and are terminal.
 */
export const sendEmail = internalAction({
  args: { eventId: v.id("emailDeliveryEvents") },
  returns: terminalEmailDeliveryResultValidator,
  handler: async (ctx, { eventId }): Promise<TerminalEmailDeliveryResult> => {
    const prepared: PreparedDeliveryAttempt =
      await (async (): Promise<PreparedDeliveryAttempt> => {
        try {
          return await ctx.runMutation(internal.email.prepareDeliveryAttempt, {
            eventId,
          })
        } catch {
          // The provider has not been constructed or called yet, so this failure
          // is proven not sent and may safely be retried.
          throw new Error("CMS_EMAIL_DELIVERY_PRE_DISPATCH_RETRYABLE")
        }
      })()

    if (prepared.kind === "terminal") return prepared.result

    const result = await dispatchPreparedEmail(prepared, {
      // The config declaration is source-current, while generated env types
      // remain intentionally stale until deployment-free codegen exists.
      environment: env as unknown as Readonly<
        Record<string, string | undefined>
      >,
    })
    if (result.state === "retryable_failure") {
      throw new Error("CMS_EMAIL_DELIVERY_PROVIDER_NOT_SENT")
    }
    return result
  },
})
