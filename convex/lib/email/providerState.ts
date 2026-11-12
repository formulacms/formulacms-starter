import { ConvexError, type Infer, v } from "convex/values"
import {
  isRegisteredEmailProviderId,
  type RegisteredEmailProviderId,
} from "./providerMetadata"
import { emailDeliveryFailureReasonValidator } from "./delivery"

export const emailSenderIdentityValidator = v.object({
  address: v.string(),
  name: v.optional(v.string()),
})

export type EmailSenderIdentity = Infer<typeof emailSenderIdentityValidator>

const inactiveEmailProviderStateValidator = v.object({
  kind: v.literal("fallback"),
})

const resendEmailProviderStateValidator = v.object({
  kind: v.literal("active"),
  providerId: v.literal("resend"),
  // Resend has no provider-specific non-secret fields in E02. Sender identity
  // remains a state field shared by every registered provider.
  configuration: v.object({}),
})

const configuredResendEmailProviderStateValidator = v.object({
  kind: v.literal("configured"),
  providerId: v.literal("resend"),
  configuration: v.object({}),
})

export const registeredEmailProviderStateValidator = v.union(
  inactiveEmailProviderStateValidator,
  configuredResendEmailProviderStateValidator,
  resendEmailProviderStateValidator
)

export const emailProviderTestStateValidator = v.union(
  v.object({
    providerId: v.literal("resend"),
    configurationVersion: v.number(),
    state: v.literal("queued"),
    updatedAt: v.number(),
  }),
  v.object({
    providerId: v.literal("resend"),
    configurationVersion: v.number(),
    state: v.literal("provider_accepted"),
    activationReceiptId: v.id("emailProviderActivationReceipts"),
    receiptExpiresAt: v.number(),
    updatedAt: v.number(),
  }),
  v.object({
    providerId: v.literal("resend"),
    configurationVersion: v.number(),
    state: v.union(v.literal("failed"), v.literal("unknown")),
    reason: emailDeliveryFailureReasonValidator,
    updatedAt: v.number(),
  })
)

export type EmailProviderTestState = Infer<
  typeof emailProviderTestStateValidator
>

export const emailProviderStateFields = {
  key: v.literal("owner"),
  provider: registeredEmailProviderStateValidator,
  sender: v.optional(emailSenderIdentityValidator),
  configurationVersion: v.number(),
  lastTest: v.optional(emailProviderTestStateValidator),
  updatedAt: v.number(),
} as const

export const emailProviderStateValidator = v.object(emailProviderStateFields)

export type PersistedEmailProviderState = Infer<
  typeof emailProviderStateValidator
>

export type EmailDeliveryReadiness = "fallback" | "needs_setup" | "ready"

export type EmailProviderClientState = Readonly<{
  configuredProviderId: RegisteredEmailProviderId | null
  activeProviderId: RegisteredEmailProviderId | null
  readiness: EmailDeliveryReadiness
  sender?: EmailSenderIdentity
  configurationVersion: number
  lastTest?: EmailProviderTestState
}>

export type EmailProviderEnvironmentReadiness = "needs_setup" | "ready"

function invalidState(): never {
  throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validateSender(sender: EmailSenderIdentity | undefined): void {
  if (!sender) return
  if (!sender.address.trim()) invalidState()
  if (sender.name !== undefined && !sender.name.trim()) invalidState()
}

function validateTestState(test: EmailProviderTestState | undefined): void {
  if (!test) return
  if (
    !isNonNegativeSafeInteger(test.configurationVersion) ||
    !isNonNegativeSafeInteger(test.updatedAt) ||
    (test.state === "provider_accepted" &&
      !isNonNegativeSafeInteger(test.receiptExpiresAt))
  ) {
    invalidState()
  }
}

/** Missing state is the fresh-install, non-delivering Console fallback. */
export function freshEmailProviderState(): PersistedEmailProviderState {
  return {
    key: "owner",
    provider: { kind: "fallback" },
    configurationVersion: 0,
    updatedAt: 0,
  }
}

/**
 * Validate the bounded singleton result E03's reader will supply. Duplicate or
 * malformed state fails closed instead of selecting an arbitrary provider.
 */
export function emailProviderStateFromRows(
  rows: readonly PersistedEmailProviderState[]
): PersistedEmailProviderState {
  if (rows.length === 0) return freshEmailProviderState()
  if (rows.length !== 1) invalidState()

  const state = rows[0]!
  if (
    state.key !== "owner" ||
    !isNonNegativeSafeInteger(state.configurationVersion) ||
    !isNonNegativeSafeInteger(state.updatedAt)
  ) {
    invalidState()
  }
  validateSender(state.sender)
  validateTestState(state.lastTest)
  if (
    state.provider.kind !== "fallback" &&
    !isRegisteredEmailProviderId(state.provider.providerId)
  ) {
    invalidState()
  }
  return state
}

/**
 * Build the state candidate a future owner-authorized activation mutation may
 * persist. This does not bypass E05's test-receipt or authorization gates.
 */
export function createRegisteredEmailProviderState<
  Id extends string,
  Configuration extends Readonly<Record<string, unknown>>,
>(input: {
  providerId: string
  isRegistered: (value: string) => value is Id
  configuration: Configuration
  sender: EmailSenderIdentity
  configurationVersion: number
  updatedAt: number
}): Readonly<{
  key: "owner"
  provider: Readonly<{
    kind: "active"
    providerId: Id
    configuration: Configuration
  }>
  sender: EmailSenderIdentity
  configurationVersion: number
  updatedAt: number
}> {
  if (!input.isRegistered(input.providerId)) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_UNREGISTERED")
  }
  if (
    !isNonNegativeSafeInteger(input.configurationVersion) ||
    !isNonNegativeSafeInteger(input.updatedAt)
  ) {
    invalidState()
  }
  validateSender(input.sender)

  return {
    key: "owner",
    provider: {
      kind: "active",
      providerId: input.providerId,
      configuration: input.configuration,
    },
    sender: input.sender,
    configurationVersion: input.configurationVersion,
    updatedAt: input.updatedAt,
  }
}

/**
 * Secret-free projection for the future owner API. Readiness is derived from
 * the selected server factory and is never persisted as a credential proxy.
 */
export function toEmailProviderClientState(
  state: PersistedEmailProviderState,
  environmentReadiness?: EmailProviderEnvironmentReadiness
): EmailProviderClientState {
  const validated = emailProviderStateFromRows([state])
  if (validated.provider.kind === "fallback") {
    return {
      configuredProviderId: null,
      activeProviderId: null,
      readiness: "fallback",
      ...(validated.sender ? { sender: validated.sender } : {}),
      configurationVersion: validated.configurationVersion,
      ...(validated.lastTest ? { lastTest: validated.lastTest } : {}),
    }
  }

  return {
    configuredProviderId: validated.provider.providerId,
    activeProviderId:
      validated.provider.kind === "active"
        ? validated.provider.providerId
        : null,
    readiness: environmentReadiness === "ready" ? "ready" : "needs_setup",
    ...(validated.sender ? { sender: validated.sender } : {}),
    configurationVersion: validated.configurationVersion,
    ...(validated.lastTest ? { lastTest: validated.lastTest } : {}),
  }
}

export const EMAIL_PROVIDER_ACTIVATION_RECEIPT_TTL_MS = 15 * 60 * 1000

export const emailProviderActivationReceiptFields = {
  providerId: v.literal("resend"),
  configurationVersion: v.number(),
  deliveryEventId: v.id("emailDeliveryEvents"),
  issuedAt: v.number(),
  expiresAt: v.number(),
  consumedAt: v.optional(v.number()),
} as const
