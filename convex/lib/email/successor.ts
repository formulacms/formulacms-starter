"use node"

import {
  createEmailClient,
  EmailAdapterError,
  EmailRouteError,
  type EmailAdapter as SdkEmailAdapter,
  type EmailMessage as SdkEmailMessage,
} from "@opencoredev/email-sdk"

export type FormulaCmsEmailAddress = Readonly<{
  email: string
  name?: string
}>

type FormulaCmsEmailContent =
  | Readonly<{ text: string; html?: string }>
  | Readonly<{ html: string; text?: string }>

/**
 * The normalized message contract owned by FormulaCMS. It deliberately omits
 * provider choice, routing, fallback, retry, telemetry, and raw SDK options.
 */
export type FormulaCmsEmailMessage = Readonly<{
  from: FormulaCmsEmailAddress
  to: FormulaCmsEmailAddress
  subject: string
}> &
  FormulaCmsEmailContent

export type FormulaCmsProviderContext = Readonly<{
  attempt: 1
  idempotencyKey: string
}>

export type FormulaCmsProviderAccepted = Readonly<{
  providerMessageId?: string
}>

/**
 * Server-only provider seam. E02 may put factories for implementations of
 * this contract in a typed registry; consumers must keep calling the service
 * returned by `createFormulaCmsEmailService`.
 */
export type EmailProviderAdapter = Readonly<{
  id: string
  idempotency: "native" | "message_id" | "none"
  send(
    message: FormulaCmsEmailMessage,
    context: FormulaCmsProviderContext
  ): Promise<FormulaCmsProviderAccepted>
}>

export type FormulaCmsEmailDispatchResult =
  | Readonly<{
      state: "provider_accepted"
      providerId: string
      providerMessageId?: string
      retry: "never"
    }>
  | Readonly<{
      state: "failed"
      providerId: string
      reason: "invalid_input" | "provider_rejected"
      retry: "action_retrier" | "never"
    }>
  | Readonly<{
      state: "unknown"
      providerId: string
      reason: "delivery_unknown"
      retry: "never"
    }>

export type FormulaCmsEmailService = Readonly<{
  providerId: string
  dispatch(input: {
    message: FormulaCmsEmailMessage
    idempotencyKey: string
  }): Promise<FormulaCmsEmailDispatchResult>
}>

function toSdkMessage(message: FormulaCmsEmailMessage): SdkEmailMessage {
  const envelope = {
    from: message.from,
    to: message.to,
    subject: message.subject,
  }
  if (typeof message.text === "string") {
    return {
      ...envelope,
      text: message.text,
      ...(typeof message.html === "string" ? { html: message.html } : {}),
    }
  }
  const html = message.html
  if (typeof html !== "string") {
    throw new Error("FormulaCMS email requires text or HTML content")
  }
  return { ...envelope, html }
}

function finalAdapterFailure(error: unknown): EmailAdapterError | undefined {
  if (error instanceof EmailRouteError) return error.failures.at(-1)
  return error instanceof EmailAdapterError ? error : undefined
}

/**
 * Build the only send surface E04 consumers may call.
 *
 * The Email SDK is intentionally configured with one adapter, one attempt,
 * no fallback, and telemetry disabled. The method accepts no SDK send options,
 * so callers cannot override any of those invariants. Action Retrier remains
 * the sole future durable retry owner and may retry only the explicit
 * `failed` + `action_retrier` result.
 */
export function createFormulaCmsEmailService(
  provider: EmailProviderAdapter
): FormulaCmsEmailService {
  const providerId = provider.id.trim()
  if (!providerId) throw new Error("FormulaCMS email provider id is required")

  const sdkAdapter: SdkEmailAdapter = {
    name: providerId,
    capabilities: {
      repeatedHeaders: false,
      idempotency: provider.idempotency,
      scheduling: false,
      personalized: "unsupported",
    },
    async send(message, context) {
      if (context.attempt !== 1) {
        throw new Error("FormulaCMS Email SDK attempt invariant violated")
      }
      const accepted = await provider.send(message as FormulaCmsEmailMessage, {
        attempt: 1,
        idempotencyKey: context.idempotencyKey ?? "",
      })
      return {
        adapter: providerId,
        id: accepted.providerMessageId,
      }
    },
  }

  const client = createEmailClient({
    adapters: [sdkAdapter],
    defaultAdapter: providerId,
    retry: { maxAttempts: 1 },
    telemetry: false,
  })

  return Object.freeze({
    providerId,
    async dispatch({
      message,
      idempotencyKey,
    }): Promise<FormulaCmsEmailDispatchResult> {
      if (!idempotencyKey.trim()) {
        return {
          state: "failed",
          providerId,
          reason: "invalid_input",
          retry: "never",
        }
      }

      try {
        const result = await client.send(toSdkMessage(message), {
          idempotencyKey,
        })
        // Telemetry is disabled, so flush is best-effort housekeeping only.
        // It must never turn a provider-accepted send into a thrown Action
        // Retrier failure that could duplicate delivery.
        await client.flush().catch(() => undefined)
        return {
          state: "provider_accepted",
          providerId,
          providerMessageId: result.id,
          retry: "never",
        }
      } catch (error) {
        await client.flush().catch(() => undefined)
        const failure = finalAdapterFailure(error)
        if (failure?.delivery === "not_sent") {
          return {
            state: "failed",
            providerId,
            reason: "provider_rejected",
            retry: failure.retryable ? "action_retrier" : "never",
          }
        }
        return {
          state: "unknown",
          providerId,
          reason: "delivery_unknown",
          retry: "never",
        }
      }
    },
  })
}
