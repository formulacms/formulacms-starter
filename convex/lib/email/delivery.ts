import { ConvexError, type Infer, v } from "convex/values"

export const emailDeliveryConsumerValidator = v.union(
  v.object({
    kind: v.literal("contact"),
    submissionId: v.id("formSubmissions"),
  }),
  v.object({ kind: v.literal("password_recovery") }),
  v.object({
    kind: v.literal("invitation"),
    inviteId: v.id("invites"),
  }),
  v.object({
    kind: v.literal("owner_test"),
    providerId: v.literal("resend"),
    configurationVersion: v.number(),
  })
)

export type EmailDeliveryConsumer = Infer<typeof emailDeliveryConsumerValidator>

/**
 * Sensitive, server-only message payload. It is never passed to Action
 * Retrier, exposed by a public query, or logged by FormulaCMS. The delivery
 * completion mutation clears it immediately; the expiry job is the recovery
 * path for an abandoned run.
 */
export const queuedEmailMessageValidator = v.object({
  to: v.string(),
  subject: v.string(),
  text: v.string(),
  html: v.optional(v.string()),
})

export type QueuedEmailMessage = Infer<typeof queuedEmailMessageValidator>

export const emailDeliveryStateValidator = v.union(
  v.literal("queued"),
  v.literal("provider_accepted"),
  v.literal("failed"),
  v.literal("unknown")
)

export type EmailDeliveryState = Infer<typeof emailDeliveryStateValidator>

export const emailDeliveryFailureReasonValidator = v.union(
  v.literal("not_configured"),
  v.literal("needs_setup"),
  v.literal("invalid_input"),
  v.literal("provider_rejected"),
  v.literal("retry_exhausted"),
  v.literal("delivery_unknown"),
  v.literal("canceled"),
  v.literal("expired"),
  v.literal("internal_error")
)

export type EmailDeliveryFailureReason = Infer<
  typeof emailDeliveryFailureReasonValidator
>

export const emailDeliveryEventFields = {
  consumer: emailDeliveryConsumerValidator,
  idempotencyKey: v.string(),
  messageFingerprint: v.string(),
  message: v.optional(queuedEmailMessageValidator),
  state: emailDeliveryStateValidator,
  providerId: v.optional(v.string()),
  failureReason: v.optional(emailDeliveryFailureReasonValidator),
  runId: v.optional(v.string()),
  attempts: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
} as const

export const terminalEmailDeliveryResultValidator = v.union(
  v.object({
    state: v.literal("provider_accepted"),
    providerId: v.string(),
  }),
  v.object({
    state: v.literal("failed"),
    providerId: v.optional(v.string()),
    reason: emailDeliveryFailureReasonValidator,
  }),
  v.object({
    state: v.literal("unknown"),
    providerId: v.string(),
    reason: v.literal("delivery_unknown"),
  })
)

export type TerminalEmailDeliveryResult = Infer<
  typeof terminalEmailDeliveryResultValidator
>

export const dispatchEmailDeliveryResultValidator = v.union(
  terminalEmailDeliveryResultValidator,
  v.object({
    state: v.literal("retryable_failure"),
    providerId: v.string(),
    reason: v.literal("provider_rejected"),
  })
)

export type DispatchEmailDeliveryResult = Infer<
  typeof dispatchEmailDeliveryResultValidator
>

const MAX_ADDRESS_LENGTH = 320
const MAX_SUBJECT_LENGTH = 998
const MAX_TEXT_LENGTH = 200_000
const MAX_HTML_LENGTH = 500_000
const MAX_IDEMPOTENCY_KEY_LENGTH = 256

function invalidRequest(): never {
  throw new ConvexError("CMS_EMAIL_DELIVERY_REQUEST_INVALID")
}

export function assertEmailDeliveryRequest(input: {
  idempotencyKey: string
  message: QueuedEmailMessage
}): void {
  const { idempotencyKey, message } = input
  if (
    !idempotencyKey ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !/^[A-Za-z0-9:_-]+$/.test(idempotencyKey)
  ) {
    invalidRequest()
  }
  if (
    !message.to.trim() ||
    message.to.length > MAX_ADDRESS_LENGTH ||
    !message.subject.trim() ||
    message.subject.length > MAX_SUBJECT_LENGTH ||
    !message.text.trim() ||
    message.text.length > MAX_TEXT_LENGTH ||
    (message.html !== undefined && message.html.length > MAX_HTML_LENGTH)
  ) {
    invalidRequest()
  }
}

const HOUR_MS = 60 * 60 * 1000

const RETENTION_MS: Readonly<Record<EmailDeliveryConsumer["kind"], number>> = {
  contact: 24 * HOUR_MS,
  password_recovery: HOUR_MS,
  invitation: 7 * 24 * HOUR_MS,
  owner_test: HOUR_MS,
}

export function emailDeliveryExpiresAt(
  kind: EmailDeliveryConsumer["kind"],
  now: number
): number {
  if (!Number.isSafeInteger(now) || now < 0) invalidRequest()
  return now + RETENTION_MS[kind]
}

export async function emailMessageFingerprint(
  message: QueuedEmailMessage
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(message))
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export function parseTerminalEmailDeliveryResult(
  value: unknown
): TerminalEmailDeliveryResult | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null
  }
  const record = value as Record<string, unknown>
  if (
    record.state === "provider_accepted" &&
    typeof record.providerId === "string" &&
    record.providerId.length > 0
  ) {
    return { state: "provider_accepted", providerId: record.providerId }
  }
  if (
    record.state === "unknown" &&
    typeof record.providerId === "string" &&
    record.providerId.length > 0 &&
    record.reason === "delivery_unknown"
  ) {
    return {
      state: "unknown",
      providerId: record.providerId,
      reason: "delivery_unknown",
    }
  }
  if (record.state !== "failed") return null
  const reason = record.reason
  if (
    reason !== "not_configured" &&
    reason !== "needs_setup" &&
    reason !== "invalid_input" &&
    reason !== "provider_rejected" &&
    reason !== "retry_exhausted" &&
    reason !== "delivery_unknown" &&
    reason !== "canceled" &&
    reason !== "expired" &&
    reason !== "internal_error"
  ) {
    return null
  }
  return {
    state: "failed",
    ...(typeof record.providerId === "string" && record.providerId.length > 0
      ? { providerId: record.providerId }
      : {}),
    reason,
  }
}
