"use node"

import type { EmailProviderRegistry } from "./providerRegistry.node"
import { EMAIL_PROVIDER_REGISTRY } from "./providerRegistry.node"
import { createFormulaCmsEmailService } from "./successor"
import type {
  DispatchEmailDeliveryResult,
  QueuedEmailMessage,
} from "./delivery"
import type { EmailSenderIdentity } from "./providerState"

export type PreparedEmailDelivery = Readonly<{
  providerId: string
  configuration: unknown
  sender: EmailSenderIdentity
  message: QueuedEmailMessage
  idempotencyKey: string
}>

export type EmailDeliveryExecutorOptions = Readonly<{
  environment: Readonly<Record<string, string | undefined>>
  registry?: EmailProviderRegistry<string>
}>

/**
 * Execute exactly one direct-SDK attempt behind the FormulaCMS contract.
 * Provider-specific values and errors stop here; the caller receives only the
 * normalized result needed to decide whether Action Retrier may run again.
 */
export async function dispatchPreparedEmail(
  prepared: PreparedEmailDelivery,
  options: EmailDeliveryExecutorOptions
): Promise<DispatchEmailDeliveryResult> {
  const registry = options.registry ?? EMAIL_PROVIDER_REGISTRY

  try {
    if (
      registry.readiness(prepared.providerId, {
        environment: options.environment,
      }) !== "ready"
    ) {
      return {
        state: "failed",
        providerId: prepared.providerId,
        reason: "needs_setup",
      }
    }

    const adapter = registry.createAdapter(
      prepared.providerId,
      { environment: options.environment },
      prepared.configuration
    )
    const result = await createFormulaCmsEmailService(adapter).dispatch({
      message: {
        from: {
          email: prepared.sender.address,
          ...(prepared.sender.name ? { name: prepared.sender.name } : {}),
        },
        to: { email: prepared.message.to },
        subject: prepared.message.subject,
        text: prepared.message.text,
        ...(prepared.message.html ? { html: prepared.message.html } : {}),
      },
      idempotencyKey: prepared.idempotencyKey,
    })

    if (result.state === "provider_accepted") {
      return {
        state: "provider_accepted",
        providerId: result.providerId,
      }
    }
    if (result.state === "unknown") {
      return {
        state: "unknown",
        providerId: result.providerId,
        reason: "delivery_unknown",
      }
    }
    if (result.retry === "action_retrier") {
      return {
        state: "retryable_failure",
        providerId: result.providerId,
        reason: "provider_rejected",
      }
    }
    return {
      state: "failed",
      providerId: result.providerId,
      reason: result.reason,
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : ""
    if (code === "CMS_EMAIL_PROVIDER_NEEDS_SETUP") {
      return {
        state: "failed",
        providerId: prepared.providerId,
        reason: "needs_setup",
      }
    }
    return {
      state: "failed",
      providerId: prepared.providerId,
      reason: "internal_error",
    }
  }
}
