// Email orchestration for the provider-neutral successor delivery queue.
//
// This file runs on the default V8 runtime. The direct Email SDK adapter code
// lives in `convex/emailNode.ts` ("use node").
//
// ADR-0054:
//  - Legacy rows remain migration input only; no public operation can create,
//    edit, or select the retired transport.
//  - Action Retrier receives only an opaque event ID. Message content remains
//    in the private app table until completion and is never logged here.
//  - `sendTestEmail` accepts no recipient argument, derives the durable owner,
//    and consumes an owner-derived rate-limit bucket before queueing.

import { v, ConvexError, type Infer } from "convex/values"
import {
  ActionRetrier,
  runIdValidator,
  runResultValidator,
  type RunId,
} from "@convex-dev/action-retrier"
import { components, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import {
  env,
  internalMutation,
  internalQuery,
  mutation,
  query,
  action,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server"
import { requireInstallationOwner } from "./lib/access/policy"
import { readEmailProviderStateDuringMigration } from "./lib/email/providerMigration"
import { EMAIL_PROVIDER_CATALOGUE } from "./lib/email/providerMetadata"
import { emailProviderEnvironmentReadiness } from "./lib/email/providerReadiness"
import {
  assertEmailDeliveryRequest,
  emailDeliveryConsumerValidator,
  emailDeliveryExpiresAt,
  emailDeliveryFailureReasonValidator,
  emailDeliveryStateValidator,
  emailMessageFingerprint,
  parseTerminalEmailDeliveryResult,
  queuedEmailMessageValidator,
  terminalEmailDeliveryResultValidator,
  type EmailDeliveryConsumer,
  type QueuedEmailMessage,
  type TerminalEmailDeliveryResult,
} from "./lib/email/delivery"
import {
  EMAIL_PROVIDER_ACTIVATION_RECEIPT_TTL_MS,
  emailProviderStateValidator,
  emailSenderIdentityValidator,
  type EmailProviderTestState,
  type PersistedEmailProviderState,
} from "./lib/email/providerState"
import { readOwnerState } from "./lib/access/owner"
import { hashAuthClientIdentity } from "./lib/authIpProof"
import { rateLimiter } from "./lib/rateLimits"

export const emailRetrier = new ActionRetrier(components.actionRetrier, {
  initialBackoffMs: 1000,
  base: 2,
  // Action Retrier counts failures after the first execution. Two retries
  // therefore cap one event at three direct SDK attempts.
  maxFailures: 2,
  // Component logs contain only opaque run IDs and constant sanitized errors;
  // suppress routine success chatter so message-bearing events stay quiet.
  logLevel: "ERROR",
})

type ActionRetrierRunResult = Infer<typeof runResultValidator>

// ─── Validators ───────────────────────────────────────────────────────────────

export const emailMessageValidator = v.object({
  to: v.string(),
  subject: v.string(),
  text: v.string(),
  html: v.optional(v.string()),
  fromAddress: v.optional(v.string()),
  fromName: v.optional(v.string()),
})

export const emailSendResultValidator = v.union(
  v.object({
    status: v.literal("queued"),
    configurationVersion: v.number(),
  }),
  v.object({
    status: v.literal("blocked"),
    reason: v.union(
      v.literal("not_configured"),
      v.literal("needs_setup"),
      v.literal("owner_email_missing"),
      v.literal("rate_limited")
    ),
  })
)

const registeredProviderIdValidator = v.literal("resend")

const providerCatalogueEntryValidator = v.object({
  id: v.string(),
  label: v.string(),
  description: v.string(),
  registered: v.boolean(),
  bundled: v.boolean(),
  documentationUrl: v.string(),
})

const emailProviderClientTestStateValidator = v.union(
  v.object({
    state: v.literal("queued"),
    updatedAt: v.number(),
  }),
  v.object({
    state: v.literal("provider_accepted"),
    receiptExpiresAt: v.number(),
    updatedAt: v.number(),
  }),
  v.object({
    state: v.union(v.literal("failed"), v.literal("unknown")),
    reason: emailDeliveryFailureReasonValidator,
    updatedAt: v.number(),
  })
)

const emailProviderSettingsValidator = v.object({
  catalogue: v.array(providerCatalogueEntryValidator),
  configuredProviderId: v.union(registeredProviderIdValidator, v.null()),
  activeProviderId: v.union(registeredProviderIdValidator, v.null()),
  readiness: v.union(
    v.literal("fallback"),
    v.literal("needs_setup"),
    v.literal("ready")
  ),
  sender: v.optional(emailSenderIdentityValidator),
  configurationVersion: v.number(),
  lastTest: v.optional(emailProviderClientTestStateValidator),
})

type EmailProviderSettings = Infer<typeof emailProviderSettingsValidator>

const emailProviderConfigurationResultValidator = v.object({
  providerId: registeredProviderIdValidator,
  configurationVersion: v.number(),
  status: v.union(v.literal("configured"), v.literal("active")),
})

const activationResultValidator = v.object({
  providerId: registeredProviderIdValidator,
  configurationVersion: v.number(),
  status: v.literal("active"),
})

type EmailProviderReadCtx = QueryCtx | MutationCtx

async function readPersistedEmailProviderStateRow(ctx: EmailProviderReadCtx) {
  const rows = await ctx.db
    .query("emailProviderState")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)
  if (rows.length > 1) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
  }
  return rows[0] ?? null
}

function configuredProviderId(
  state: PersistedEmailProviderState
): "resend" | null {
  return state.provider.kind === "fallback" ? null : state.provider.providerId
}

function projectClientTestState(
  test: EmailProviderTestState | undefined,
  state: PersistedEmailProviderState
): EmailProviderSettings["lastTest"] {
  if (
    !test ||
    test.providerId !== configuredProviderId(state) ||
    test.configurationVersion !== state.configurationVersion
  ) {
    return undefined
  }
  if (test.state === "provider_accepted") {
    return {
      state: test.state,
      receiptExpiresAt: test.receiptExpiresAt,
      updatedAt: test.updatedAt,
    }
  }
  if (test.state === "queued") {
    return { state: test.state, updatedAt: test.updatedAt }
  }
  return {
    state: test.state,
    reason: test.reason,
    updatedAt: test.updatedAt,
  }
}

function projectEmailProviderSettings(
  state: PersistedEmailProviderState
): EmailProviderSettings {
  const providerId = configuredProviderId(state)
  const readiness = providerId
    ? emailProviderEnvironmentReadiness(
        providerId,
        env as unknown as Readonly<Record<string, string | undefined>>
      )
    : "fallback"
  const lastTest = projectClientTestState(state.lastTest, state)
  return {
    catalogue: EMAIL_PROVIDER_CATALOGUE.map((entry) => ({ ...entry })),
    configuredProviderId: providerId,
    activeProviderId:
      state.provider.kind === "active" ? state.provider.providerId : null,
    readiness,
    ...(state.sender ? { sender: state.sender } : {}),
    configurationVersion: state.configurationVersion,
    ...(lastTest ? { lastTest } : {}),
  }
}

function normalizeSender(input: { address: string; name?: string }): {
  address: string
  name?: string
} {
  const address = input.address.trim().toLowerCase()
  const trimmedName = input.name?.trim()
  const name = trimmedName ? trimmedName : undefined
  if (
    address.length === 0 ||
    address.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ||
    (name !== undefined && name.length > 120)
  ) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_INVALID")
  }
  return { address, ...(name ? { name } : {}) }
}

function sendersEqual(
  left: { address: string; name?: string } | undefined,
  right: { address: string; name?: string }
): boolean {
  return (
    left?.address.trim().toLowerCase() === right.address &&
    left?.name?.trim() === right.name
  )
}

function nextConfigurationVersion(current: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= Number.MAX_SAFE_INTEGER
  ) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
  }
  return current + 1
}

const resolvedSettingsValidator = v.object({
  provider: v.union(v.literal("console"), v.literal("resend")),
  fromAddress: v.optional(v.string()),
  fromName: v.optional(v.string()),
})

// ─── Resolved settings (internal) ─────────────────────────────────────────────

/**
 * E04 compatibility projection for existing consumers. Only an active
 * successor provider may expose sender identity. Legacy Console/SMTP/Resend
 * rows and stale SMTP environment variables remain non-delivering fallback.
 */
export const getResolvedSettings = internalQuery({
  args: {},
  returns: resolvedSettingsValidator,
  handler: async (
    ctx
  ): Promise<{
    provider: "console" | "resend"
    fromAddress?: string
    fromName?: string
  }> => {
    const { state } = await readEmailProviderStateDuringMigration(ctx)
    if (state.provider.kind !== "active" || !state.sender) {
      return { provider: "console" as const }
    }
    return {
      provider: state.provider.providerId,
      fromAddress: state.sender.address,
      ...(state.sender.name ? { fromName: state.sender.name } : {}),
    }
  },
})

// ─── E04 private delivery queue ──────────────────────────────────────────────

const preparedEmailDeliveryValidator = v.union(
  v.object({
    kind: v.literal("terminal"),
    result: terminalEmailDeliveryResultValidator,
  }),
  v.object({
    kind: v.literal("ready"),
    providerId: v.literal("resend"),
    configuration: v.object({}),
    sender: emailSenderIdentityValidator,
    message: queuedEmailMessageValidator,
    idempotencyKey: v.string(),
  })
)

function terminalResultFromEvent(
  event: Doc<"emailDeliveryEvents">
): TerminalEmailDeliveryResult {
  if (event.state === "provider_accepted" && event.providerId) {
    return { state: "provider_accepted", providerId: event.providerId }
  }
  if (event.state === "unknown" && event.providerId) {
    return {
      state: "unknown",
      providerId: event.providerId,
      reason: "delivery_unknown",
    }
  }
  return {
    state: "failed",
    ...(event.providerId ? { providerId: event.providerId } : {}),
    reason: event.failureReason ?? "internal_error",
  }
}

type QueueEmailDeliveryInput = Readonly<{
  consumer: EmailDeliveryConsumer
  idempotencyKey: string
  message: QueuedEmailMessage
}>

export async function queueFormulaCmsEmail(
  ctx: MutationCtx,
  input: QueueEmailDeliveryInput
): Promise<{
  eventId: Id<"emailDeliveryEvents">
  runId: string
  state: "queued"
}> {
  assertEmailDeliveryRequest(input)
  const messageFingerprint = await emailMessageFingerprint(input.message)
  const existing = await ctx.db
    .query("emailDeliveryEvents")
    .withIndex("by_idempotencyKey", (q) =>
      q.eq("idempotencyKey", input.idempotencyKey)
    )
    .unique()
  if (existing) {
    if (
      existing.messageFingerprint !== messageFingerprint ||
      JSON.stringify(existing.consumer) !== JSON.stringify(input.consumer) ||
      !existing.runId
    ) {
      throw new ConvexError("CMS_EMAIL_DELIVERY_IDEMPOTENCY_CONFLICT")
    }
    return {
      eventId: existing._id,
      runId: existing.runId,
      state: "queued",
    }
  }

  const now = Date.now()
  const expiresAt = emailDeliveryExpiresAt(input.consumer.kind, now)
  const eventId = await ctx.db.insert("emailDeliveryEvents", {
    consumer: input.consumer,
    idempotencyKey: input.idempotencyKey,
    messageFingerprint,
    message: input.message,
    state: "queued",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  })
  await ctx.scheduler.runAt(expiresAt, internal.email._expireDeliveryEvent, {
    eventId,
  })
  const runId: RunId = await emailRetrier.run(
    ctx as unknown as Parameters<typeof emailRetrier.run>[0],
    internal.emailNode.sendEmail,
    { eventId },
    { onComplete: internal.email._recordDeliveryResult }
  )
  await ctx.db.patch(eventId, { runId: runId as string })
  if (input.consumer.kind === "contact") {
    await ctx.db.patch(input.consumer.submissionId, {
      notifyRunId: runId as string,
    })
  } else if (input.consumer.kind === "invitation") {
    await ctx.db.patch(input.consumer.inviteId, {
      deliveryRunId: runId as string,
      deliveryState: "queued",
      deliveryError: undefined,
    })
  }
  return { eventId, runId: runId as string, state: "queued" }
}

export const enqueueDelivery = internalMutation({
  args: {
    consumer: emailDeliveryConsumerValidator,
    idempotencyKey: v.string(),
    message: queuedEmailMessageValidator,
  },
  returns: v.object({
    eventId: v.id("emailDeliveryEvents"),
    runId: v.string(),
    state: v.literal("queued"),
  }),
  handler: async (ctx, args) => await queueFormulaCmsEmail(ctx, args),
})

/**
 * One Action Retrier attempt starts here. Reading/incrementing happens before
 * provider dispatch, so an unexpected failure at this seam is proven not sent.
 */
export const prepareDeliveryAttempt = internalMutation({
  args: { eventId: v.id("emailDeliveryEvents") },
  returns: preparedEmailDeliveryValidator,
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId)
    if (!event) {
      return {
        kind: "terminal" as const,
        result: { state: "failed" as const, reason: "expired" as const },
      }
    }
    if (event.state !== "queued" || !event.message) {
      return {
        kind: "terminal" as const,
        result: terminalResultFromEvent(event),
      }
    }
    if (event.expiresAt <= Date.now()) {
      await ctx.db.patch(eventId, {
        state: "failed",
        failureReason: "expired",
        message: undefined,
        updatedAt: Date.now(),
      })
      return {
        kind: "terminal" as const,
        result: { state: "failed" as const, reason: "expired" as const },
      }
    }

    const { state } = await readEmailProviderStateDuringMigration(ctx)
    const attempts = event.attempts + 1
    const ownerTestMatches =
      event.consumer.kind === "owner_test" &&
      state.provider.kind !== "fallback" &&
      state.provider.providerId === event.consumer.providerId &&
      state.configurationVersion === event.consumer.configurationVersion
    const activeDelivery =
      event.consumer.kind !== "owner_test" && state.provider.kind === "active"
    if ((!ownerTestMatches && !activeDelivery) || !state.sender) {
      await ctx.db.patch(eventId, { attempts, updatedAt: Date.now() })
      return {
        kind: "terminal" as const,
        result: {
          state: "failed" as const,
          reason: "not_configured" as const,
        },
      }
    }

    if (state.provider.kind === "fallback") {
      throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
    }

    await ctx.db.patch(eventId, {
      attempts,
      providerId: state.provider.providerId,
      updatedAt: Date.now(),
    })
    return {
      kind: "ready" as const,
      providerId: state.provider.providerId,
      configuration: state.provider.configuration,
      sender: state.sender,
      message: event.message,
      idempotencyKey: event.idempotencyKey,
    }
  },
})

export const getDeliveryState = internalQuery({
  args: { eventId: v.id("emailDeliveryEvents") },
  returns: v.union(
    v.null(),
    v.object({
      state: emailDeliveryStateValidator,
      providerId: v.optional(v.string()),
      failureReason: v.optional(emailDeliveryFailureReasonValidator),
      attempts: v.number(),
    })
  ),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId)
    if (!event) return null
    return {
      state: event.state,
      ...(event.providerId ? { providerId: event.providerId } : {}),
      ...(event.failureReason ? { failureReason: event.failureReason } : {}),
      attempts: event.attempts,
    }
  },
})

function completionResult(
  event: Doc<"emailDeliveryEvents">,
  result: ActionRetrierRunResult
): TerminalEmailDeliveryResult {
  if (result.type === "success") {
    return (
      parseTerminalEmailDeliveryResult(result.returnValue) ?? {
        state: "failed",
        ...(event.providerId ? { providerId: event.providerId } : {}),
        reason: "internal_error",
      }
    )
  }
  if (result.type === "canceled") {
    return {
      state: "failed",
      ...(event.providerId ? { providerId: event.providerId } : {}),
      reason: "canceled",
    }
  }
  return {
    state: "failed",
    ...(event.providerId ? { providerId: event.providerId } : {}),
    reason: "retry_exhausted",
  }
}

async function recordOwnerTestCompletion(
  ctx: MutationCtx,
  event: Doc<"emailDeliveryEvents">,
  terminal: TerminalEmailDeliveryResult
): Promise<void> {
  if (event.consumer.kind !== "owner_test") return
  const stateRow = await readPersistedEmailProviderStateRow(ctx)
  if (
    !stateRow ||
    stateRow.provider.kind === "fallback" ||
    stateRow.provider.providerId !== event.consumer.providerId ||
    stateRow.configurationVersion !== event.consumer.configurationVersion
  ) {
    return
  }

  const now = Date.now()
  if (
    terminal.state === "provider_accepted" &&
    terminal.providerId === event.consumer.providerId
  ) {
    const expiresAt = now + EMAIL_PROVIDER_ACTIVATION_RECEIPT_TTL_MS
    const activationReceiptId = await ctx.db.insert(
      "emailProviderActivationReceipts",
      {
        providerId: event.consumer.providerId,
        configurationVersion: event.consumer.configurationVersion,
        deliveryEventId: event._id,
        issuedAt: now,
        expiresAt,
      }
    )
    await ctx.scheduler.runAt(
      expiresAt,
      internal.email._expireActivationReceipt,
      { activationReceiptId }
    )
    await ctx.db.patch(stateRow._id, {
      lastTest: {
        providerId: event.consumer.providerId,
        configurationVersion: event.consumer.configurationVersion,
        state: "provider_accepted",
        activationReceiptId,
        receiptExpiresAt: expiresAt,
        updatedAt: now,
      },
      updatedAt: now,
    })
    return
  }

  const reason =
    terminal.state === "provider_accepted"
      ? "internal_error"
      : terminal.state === "unknown"
        ? "delivery_unknown"
        : terminal.reason
  await ctx.db.patch(stateRow._id, {
    lastTest: {
      providerId: event.consumer.providerId,
      configurationVersion: event.consumer.configurationVersion,
      state: terminal.state === "unknown" ? "unknown" : "failed",
      reason,
      updatedAt: now,
    },
    updatedAt: now,
  })
}

export const _recordDeliveryResult = internalMutation({
  args: { runId: runIdValidator, result: runResultValidator },
  returns: v.null(),
  handler: async (ctx, { runId, result }) => {
    const event = await ctx.db
      .query("emailDeliveryEvents")
      .withIndex("by_runId", (q) => q.eq("runId", runId))
      .unique()
    if (!event) return null

    const terminal = completionResult(event, result)
    await ctx.db.patch(event._id, {
      state: terminal.state,
      ...(terminal.providerId ? { providerId: terminal.providerId } : {}),
      failureReason:
        terminal.state === "provider_accepted" ? undefined : terminal.reason,
      message: undefined,
      updatedAt: Date.now(),
    })

    if (event.consumer.kind === "contact") {
      const submission = await ctx.db.get(event.consumer.submissionId)
      if (submission) {
        await ctx.db.patch(submission._id, {
          notifyStatus:
            terminal.state === "provider_accepted" ? "sent" : "failed",
          notifyError:
            terminal.state === "provider_accepted"
              ? undefined
              : terminal.state === "unknown"
                ? "delivery_unknown"
                : terminal.reason,
          notifiedAt:
            terminal.state === "provider_accepted" ? Date.now() : undefined,
          notifyAttempts: event.attempts,
        })
      }
    } else if (event.consumer.kind === "invitation") {
      const invite = await ctx.db.get(event.consumer.inviteId)
      if (invite) {
        await ctx.db.patch(invite._id, {
          deliveryState: terminal.state,
          deliveryError:
            terminal.state === "provider_accepted"
              ? undefined
              : terminal.reason,
        })
      }
    } else if (event.consumer.kind === "owner_test") {
      await recordOwnerTestCompletion(ctx, event, terminal)
    }
    return null
  },
})

export const _expireDeliveryEvent = internalMutation({
  args: { eventId: v.id("emailDeliveryEvents") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId)
    if (event && event.expiresAt <= Date.now()) {
      await ctx.db.delete(eventId)
    }
    return null
  },
})

export const _expireActivationReceipt = internalMutation({
  args: {
    activationReceiptId: v.id("emailProviderActivationReceipts"),
  },
  returns: v.null(),
  handler: async (ctx, { activationReceiptId }) => {
    const receipt = await ctx.db.get(activationReceiptId)
    if (!receipt || receipt.expiresAt > Date.now()) return null

    const stateRow = await readPersistedEmailProviderStateRow(ctx)
    if (
      stateRow?.lastTest?.state === "provider_accepted" &&
      stateRow.lastTest.activationReceiptId === activationReceiptId
    ) {
      await ctx.db.patch(stateRow._id, {
        lastTest: undefined,
        updatedAt: Date.now(),
      })
    }
    await ctx.db.delete(activationReceiptId)
    return null
  },
})

// ─── E05 owner provider settings ─────────────────────────────────────────────

export const getEmailProviderSettings = query({
  args: {},
  returns: emailProviderSettingsValidator,
  handler: async (ctx): Promise<EmailProviderSettings> => {
    await requireInstallationOwner(ctx)
    const { state } = await readEmailProviderStateDuringMigration(ctx)
    return projectEmailProviderSettings(state)
  },
})

export const getOwnerEmailProviderConfiguration = internalQuery({
  args: {},
  returns: emailProviderStateValidator,
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    return (await readEmailProviderStateDuringMigration(ctx)).state
  },
})

export const saveEmailProviderConfiguration = mutation({
  args: {
    providerId: registeredProviderIdValidator,
    senderAddress: v.string(),
    senderName: v.optional(v.string()),
  },
  returns: emailProviderConfigurationResultValidator,
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const current = await readEmailProviderStateDuringMigration(ctx)
    if (current.source === "legacy") {
      throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_REQUIRED")
    }
    const row = await readPersistedEmailProviderStateRow(ctx)
    if (current.source === "successor" && !row) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
    }

    const sender = normalizeSender({
      address: args.senderAddress,
      ...(args.senderName !== undefined ? { name: args.senderName } : {}),
    })
    if (
      configuredProviderId(current.state) === args.providerId &&
      sendersEqual(current.state.sender, sender)
    ) {
      return {
        providerId: args.providerId,
        configurationVersion: current.state.configurationVersion,
        status:
          current.state.provider.kind === "active"
            ? ("active" as const)
            : ("configured" as const),
      }
    }

    const configurationVersion = nextConfigurationVersion(
      current.state.configurationVersion
    )
    const nextState: PersistedEmailProviderState = {
      key: "owner",
      provider: {
        kind: "configured",
        providerId: args.providerId,
        configuration: {},
      },
      sender,
      configurationVersion,
      updatedAt: Date.now(),
    }
    if (row) {
      await ctx.db.patch(row._id, {
        provider: nextState.provider,
        sender,
        configurationVersion,
        lastTest: undefined,
        updatedAt: nextState.updatedAt,
      })
    } else {
      await ctx.db.insert("emailProviderState", nextState)
    }
    return {
      providerId: args.providerId,
      configurationVersion,
      status: "configured" as const,
    }
  },
})

export const checkEmailProviderConfiguration = action({
  args: { providerId: registeredProviderIdValidator },
  returns: v.object({
    providerId: registeredProviderIdValidator,
    readiness: v.union(v.literal("needs_setup"), v.literal("ready")),
  }),
  handler: async (ctx, { providerId }) => {
    await ctx.runQuery(internal.email.assertSettingsUpdate, {})
    return {
      providerId,
      readiness: emailProviderEnvironmentReadiness(
        providerId,
        env as unknown as Readonly<Record<string, string | undefined>>
      ),
    }
  },
})

export const enqueueOwnerTestDelivery = internalMutation({
  args: {
    providerId: registeredProviderIdValidator,
    configurationVersion: v.number(),
    message: queuedEmailMessageValidator,
    idempotencyKey: v.string(),
  },
  returns: v.object({
    eventId: v.id("emailDeliveryEvents"),
    runId: v.string(),
    state: v.literal("queued"),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const current = await readEmailProviderStateDuringMigration(ctx)
    if (
      current.state.provider.kind === "fallback" ||
      current.state.provider.providerId !== args.providerId ||
      current.state.configurationVersion !== args.configurationVersion ||
      !current.state.sender
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_STALE")
    }
    if (
      emailProviderEnvironmentReadiness(
        args.providerId,
        env as unknown as Readonly<Record<string, string | undefined>>
      ) !== "ready"
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
    }

    const queued = await queueFormulaCmsEmail(ctx, {
      consumer: {
        kind: "owner_test",
        providerId: args.providerId,
        configurationVersion: args.configurationVersion,
      },
      idempotencyKey: args.idempotencyKey,
      message: args.message,
    })
    const row = await readPersistedEmailProviderStateRow(ctx)
    if (!row) throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
    await ctx.db.patch(row._id, {
      lastTest: {
        providerId: args.providerId,
        configurationVersion: args.configurationVersion,
        state: "queued",
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    })
    return queued
  },
})

export const activateEmailProvider = mutation({
  args: { providerId: registeredProviderIdValidator },
  returns: activationResultValidator,
  handler: async (ctx, { providerId }) => {
    await requireInstallationOwner(ctx)
    const current = await readEmailProviderStateDuringMigration(ctx)
    const row = await readPersistedEmailProviderStateRow(ctx)
    if (!row || current.source !== "successor") {
      throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED")
    }
    if (
      current.state.provider.kind === "active" &&
      current.state.provider.providerId === providerId
    ) {
      return {
        providerId,
        configurationVersion: current.state.configurationVersion,
        status: "active" as const,
      }
    }
    if (
      current.state.provider.kind !== "configured" ||
      current.state.provider.providerId !== providerId ||
      !current.state.sender
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED")
    }
    if (
      emailProviderEnvironmentReadiness(
        providerId,
        env as unknown as Readonly<Record<string, string | undefined>>
      ) !== "ready"
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
    }

    const test = current.state.lastTest
    if (
      test?.state !== "provider_accepted" ||
      test.providerId !== providerId ||
      test.configurationVersion !== current.state.configurationVersion
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_TEST_REQUIRED")
    }
    const receipt = await ctx.db.get(test.activationReceiptId)
    const now = Date.now()
    if (
      !receipt ||
      receipt.providerId !== providerId ||
      receipt.configurationVersion !== current.state.configurationVersion ||
      receipt.consumedAt !== undefined ||
      receipt.expiresAt <= now
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_TEST_REQUIRED")
    }

    await ctx.db.patch(receipt._id, { consumedAt: now })
    await ctx.db.patch(row._id, {
      provider: {
        kind: "active",
        providerId,
        configuration: current.state.provider.configuration,
      },
      lastTest: undefined,
      updatedAt: now,
    })
    return {
      providerId,
      configurationVersion: current.state.configurationVersion,
      status: "active" as const,
    }
  },
})

export const deactivateEmailProvider = mutation({
  args: { providerId: registeredProviderIdValidator },
  returns: emailProviderConfigurationResultValidator,
  handler: async (ctx, { providerId }) => {
    await requireInstallationOwner(ctx)
    const current = await readEmailProviderStateDuringMigration(ctx)
    const row = await readPersistedEmailProviderStateRow(ctx)
    if (!row || current.source !== "successor") {
      throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED")
    }
    // Same stale-call convention as activation: a call for a provider that is
    // not the stored one is refused, and a call that finds the requested
    // provider already off is a no-op that reports the stored state.
    if (
      current.state.provider.kind === "fallback" ||
      current.state.provider.providerId !== providerId
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_CONFIGURATION_REQUIRED")
    }
    if (current.state.provider.kind === "configured") {
      return {
        providerId,
        configurationVersion: current.state.configurationVersion,
        status: "configured" as const,
      }
    }

    // Back to `configured` for the same provider and sender. The accepted
    // test is cleared and the version is bumped, so turning the provider on
    // again needs a new accepted test. Credentials stay in the environment.
    const configurationVersion = nextConfigurationVersion(
      current.state.configurationVersion
    )
    await ctx.db.patch("emailProviderState", row._id, {
      provider: {
        kind: "configured",
        providerId,
        configuration: current.state.provider.configuration,
      },
      configurationVersion,
      lastTest: undefined,
      updatedAt: Date.now(),
    })
    return {
      providerId,
      configurationVersion,
      status: "configured" as const,
    }
  },
})

export const assertActiveEmailProviderReady = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const { state } = await readEmailProviderStateDuringMigration(ctx)
    if (state.provider.kind !== "active" || !state.sender) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_NOT_ACTIVE")
    }
    if (
      emailProviderEnvironmentReadiness(
        state.provider.providerId,
        env as unknown as Readonly<Record<string, string | undefined>>
      ) !== "ready"
    ) {
      throw new ConvexError("CMS_EMAIL_PROVIDER_NEEDS_SETUP")
    }
    return null
  },
})

export const getDurableOwnerRecipient = internalQuery({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx) => {
    const owner = await readOwnerState(ctx)
    if (owner.status === "missing") return null
    if (owner.status === "invalid") {
      throw new ConvexError("CMS_OWNER_STATE_INVALID")
    }
    const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: "user",
      where: [{ field: "_id", operator: "eq", value: owner.owner.authId }],
    })
    const email = typeof user?.email === "string" ? user.email.trim() : ""
    return email || null
  },
})

// ─── Admin: read settings ─────────────────────────────────────────────────────

// The legacy settings row is migration input only. No public reader projects
// its provider or credential shape.

// ─── Admin: write settings ────────────────────────────────────────────────────

// The successor mutations below write only typed, non-secret provider state.

// Legacy credential writes are retired; stored ciphertext remains read-only
// migration inventory until the separately authorized cleanup.

// ─── Admin: send an operational-alert test to yourself ────────────────────────

/**
 * Send a controlled operational-alert test to the calling admin's own email
 * address. ADR-0026 §2: no recipient argument; the action resolves the auth
 * identity's email and sends only to that address. The installation-owner gate
 * remains mandatory, and E04 applies an owner-derived rate limit.
 *
 * This is a manual delivery probe, not automatic incident monitoring. Its
 * fixed body contains no secret values, credentials, deployment URLs, or
 * customer data, so a received message is safe drill evidence.
 */
export const sendTestEmail = action({
  args: {},
  returns: emailSendResultValidator,
  handler: async (
    ctx
  ): Promise<
    | { status: "queued"; configurationVersion: number }
    | {
        status: "blocked"
        reason:
          | "not_configured"
          | "needs_setup"
          | "owner_email_missing"
          | "rate_limited"
      }
  > => {
    // Owner gate precedes the account lookup so an unrelated caller cannot
    // reach the recipient or rate-limit path.
    await ctx.runQuery(internal.email.assertSettingsUpdate, {})
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) {
      throw new ConvexError("Unauthenticated: sign in to continue")
    }

    const email = identity.email
    if (!email) {
      return {
        status: "blocked",
        reason: "owner_email_missing",
      }
    }

    const state: PersistedEmailProviderState = await ctx.runQuery(
      internal.email.getOwnerEmailProviderConfiguration,
      {}
    )
    if (state.provider.kind === "fallback" || !state.sender) {
      return { status: "blocked", reason: "not_configured" }
    }

    const readiness = emailProviderEnvironmentReadiness(
      state.provider.providerId,
      env as unknown as Readonly<Record<string, string | undefined>>
    )
    if (readiness !== "ready") {
      return { status: "blocked", reason: "needs_setup" }
    }

    const ownerKey = await hashAuthClientIdentity(identity.tokenIdentifier)
    const limit = await rateLimiter.limit(ctx, "emailOwnerTestPerOwner", {
      key: ownerKey,
    })
    if (!limit.ok) {
      return {
        status: "blocked",
        reason: "rate_limited",
      }
    }

    const eventKey = await hashAuthClientIdentity(
      `${identity.tokenIdentifier}:${Date.now()}:${crypto.randomUUID()}`
    )
    await ctx.runMutation(internal.email.enqueueOwnerTestDelivery, {
      providerId: state.provider.providerId,
      configurationVersion: state.configurationVersion,
      idempotencyKey: `owner_test:${eventKey}`,
      message: {
        to: email,
        subject: "formulacms operational alert test",
        text:
          "Operational alert test\n\n" +
          "Alert class: recovery drill\n" +
          "Severity: SEV2\n\n" +
          "This controlled message checks the configured email provider. It contains no " +
          "secret values, credentials, deployment URLs, or customer data.\n\n" +
          "— sent by formulacms (Settings → Email → Send operational alert test).",
      },
    })
    return {
      status: "queued",
      configurationVersion: state.configurationVersion,
    }
  },
})

/**
 * Internal helper: enforce installation-owner access inside a query so the
 * `sendTestEmail` action can gate without re-implementing the check.
 */
export const assertSettingsUpdate = internalQuery({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    return null
  },
})
