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

import { getActor, getOwnerNotificationEmail } from "./lib/access/actor"
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
import {
  EMAIL_DEFAULT_PROVIDER_ID,
  EMAIL_PROVIDER_CATALOGUE,
  isRegisteredEmailProviderId,
  registeredEmailProviderIdValidator,
  type RegisteredEmailProviderId,
} from "./lib/email/providerMetadata"
import {
  emailProviderEnvironmentReadiness,
  emailProviderEnvironmentStatus,
} from "./lib/email/providerReadiness"
import {
  assertEmailDeliveryRequest,
  emailDeliveryConsumerValidator,
  emailDeliveryExpiresAt,
  emailDeliveryFailureCategoryValidator,
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
  emailProviderStateValidator,
  emailSenderIdentityValidator,
  isEmailAddress,
  type EmailProviderTestState,
  type PersistedEmailProviderState,
} from "./lib/email/providerState"
import { readOwnerState } from "./lib/access/owner"
import { rateLimiter } from "./lib/rateLimits"

/**
 * Rate-limit key for the email functions: a SHA-256 hex digest of the trimmed,
 * lower-cased identity, so raw user IDs never appear as limiter keys. Same
 * digest as the retired auth IP proof helper (ADR-0056), so existing keys
 * keep their values.
 */
export async function hashAuthClientIdentity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value.trim().toLowerCase())
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

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

const registeredProviderIdValidator = registeredEmailProviderIdValidator

// Names and presence flags only. A variable value never leaves the server,
// nor its length, prefix or suffix.
const emailEnvironmentVariableValidator = v.object({
  name: v.string(),
  required: v.boolean(),
  present: v.boolean(),
})

const providerReadinessValidator = v.union(
  v.literal("needs_setup"),
  v.literal("ready")
)

const providerCatalogueEntryValidator = v.object({
  id: v.string(),
  label: v.string(),
  description: v.string(),
  registered: v.boolean(),
  bundled: v.boolean(),
  documentationUrl: v.string(),
  // Registered entries only.
  environment: v.optional(v.array(emailEnvironmentVariableValidator)),
  readiness: v.optional(providerReadinessValidator),
})

const emailProviderClientTestStateValidator = v.union(
  v.object({
    providerId: registeredProviderIdValidator,
    state: v.literal("queued"),
    updatedAt: v.number(),
  }),
  v.object({
    providerId: registeredProviderIdValidator,
    state: v.union(v.literal("failed"), v.literal("unknown")),
    reason: emailDeliveryFailureReasonValidator,
    category: v.optional(emailDeliveryFailureCategoryValidator),
    updatedAt: v.number(),
  })
)

const emailProviderSettingsValidator = v.object({
  catalogue: v.array(providerCatalogueEntryValidator),
  // The provider the owner screen opens: the enabled one, else the default.
  preselectedProviderId: registeredProviderIdValidator,
  // The owner's choice: the one enabled provider, or none.
  enabledProviderId: v.union(registeredProviderIdValidator, v.null()),
  // The result: the enabled provider once the mail server accepted a test of
  // the current configuration, else null.
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

// Result of save, enable and disable. `status` is the state of the enabled
// provider: `disabled` when none is enabled, `inactive` when it is enabled but
// no accepted test of the current configuration exists, else `active`.
const emailProviderStateResultValidator = v.object({
  enabledProviderId: v.union(registeredProviderIdValidator, v.null()),
  configurationVersion: v.number(),
  status: v.union(
    v.literal("disabled"),
    v.literal("inactive"),
    v.literal("active")
  ),
})

type EmailProviderStateResult = Infer<typeof emailProviderStateResultValidator>

function emailProviderStateResult(
  state: PersistedEmailProviderState
): EmailProviderStateResult {
  return {
    enabledProviderId: enabledProviderIdOf(state),
    configurationVersion: state.configurationVersion,
    status:
      state.provider.kind === "fallback"
        ? "disabled"
        : state.provider.kind === "configured"
          ? "inactive"
          : "active",
  }
}

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

function enabledProviderIdOf(
  state: PersistedEmailProviderState
): RegisteredEmailProviderId | null {
  return state.provider.kind === "fallback" ? null : state.provider.providerId
}

function projectClientTestState(
  test: EmailProviderTestState | undefined,
  state: PersistedEmailProviderState
): EmailProviderSettings["lastTest"] {
  if (
    !test ||
    test.providerId !== enabledProviderIdOf(state) ||
    test.configurationVersion !== state.configurationVersion
  ) {
    return undefined
  }
  // An accepted test is never shown. Today an accepted result makes the
  // provider active at once; a row written before that change may still hold
  // one with a live receipt, and it stays hidden.
  if (test.state === "provider_accepted") return undefined
  if (test.state === "queued") {
    return {
      providerId: test.providerId,
      state: test.state,
      updatedAt: test.updatedAt,
    }
  }
  return {
    providerId: test.providerId,
    state: test.state,
    reason: test.reason,
    ...(test.category ? { category: test.category } : {}),
    updatedAt: test.updatedAt,
  }
}

function currentEnvironment(): Readonly<Record<string, string | undefined>> {
  return env as unknown as Readonly<Record<string, string | undefined>>
}

function projectCatalogue(): EmailProviderSettings["catalogue"] {
  return EMAIL_PROVIDER_CATALOGUE.map((entry) => {
    if (!entry.registered || !isRegisteredEmailProviderId(entry.id)) {
      return { ...entry }
    }
    const { readiness, variables } = emailProviderEnvironmentStatus(
      entry.id,
      currentEnvironment()
    )
    return {
      ...entry,
      environment: variables.map((variable) => ({ ...variable })),
      readiness,
    }
  })
}

function projectEmailProviderSettings(
  state: PersistedEmailProviderState
): EmailProviderSettings {
  const providerId = enabledProviderIdOf(state)
  const readiness = providerId
    ? emailProviderEnvironmentReadiness(providerId, currentEnvironment())
    : "fallback"
  const lastTest = projectClientTestState(state.lastTest, state)
  return {
    catalogue: projectCatalogue(),
    preselectedProviderId: providerId ?? EMAIL_DEFAULT_PROVIDER_ID,
    enabledProviderId: providerId,
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
    !isEmailAddress(address) ||
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
  provider: v.union(
    v.literal("console"),
    v.literal("smtp"),
    v.literal("resend")
  ),
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
    provider: "console" | RegisteredEmailProviderId
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
    providerId: registeredProviderIdValidator,
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
    ...(event.failureCategory ? { category: event.failureCategory } : {}),
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
  await ctx.db.patch("emailDeliveryEvents", eventId, { runId: runId as string })
  if (input.consumer.kind === "contact") {
    await ctx.db.patch("formSubmissions", input.consumer.submissionId, {
      notifyRunId: runId as string,
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
    const event = await ctx.db.get("emailDeliveryEvents", eventId)
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
      await ctx.db.patch("emailDeliveryEvents", eventId, {
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
      await ctx.db.patch("emailDeliveryEvents", eventId, { attempts, updatedAt: Date.now() })
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

    await ctx.db.patch("emailDeliveryEvents", eventId, {
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
    const event = await ctx.db.get("emailDeliveryEvents", eventId)
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
  // Every retried attempt stored its category on the event before it threw,
  // so the reason the owner sees survives Action Retrier's exhaustion.
  return {
    state: "failed",
    ...(event.providerId ? { providerId: event.providerId } : {}),
    reason: "retry_exhausted",
    ...(event.failureCategory ? { category: event.failureCategory } : {}),
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
    // An accepted test of the current provider and configuration version
    // makes the enabled provider active, in this same transaction. Any such
    // test qualifies, even if a later test of the same version failed.
    await ctx.db.patch("emailProviderState", stateRow._id, {
      provider: {
        kind: "active",
        providerId: event.consumer.providerId,
        configuration: stateRow.provider.configuration,
      },
      lastTest: undefined,
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
  const category = terminal.state === "failed" ? terminal.category : undefined
  await ctx.db.patch("emailProviderState", stateRow._id, {
    lastTest: {
      providerId: event.consumer.providerId,
      configurationVersion: event.consumer.configurationVersion,
      state: terminal.state === "unknown" ? "unknown" : "failed",
      reason,
      ...(category ? { category } : {}),
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
    await ctx.db.patch("emailDeliveryEvents", event._id, {
      state: terminal.state,
      ...(terminal.providerId ? { providerId: terminal.providerId } : {}),
      failureReason:
        terminal.state === "provider_accepted" ? undefined : terminal.reason,
      failureCategory:
        terminal.state === "failed" ? terminal.category : undefined,
      message: undefined,
      updatedAt: Date.now(),
    })

    if (event.consumer.kind === "contact") {
      const submission = await ctx.db.get("formSubmissions", event.consumer.submissionId)
      if (submission) {
        await ctx.db.patch("formSubmissions", submission._id, {
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
    } else if (event.consumer.kind === "owner_test") {
      await recordOwnerTestCompletion(ctx, event, terminal)
    }
    return null
  },
})

/**
 * Called by the delivery action just before it throws for a retry. Action
 * Retrier turns the throw into "retry_exhausted" after the last attempt and
 * drops the reason, so the bounded category is kept on the event here and
 * read back when the run completes. Best effort: the caller ignores a
 * failure, because a missing category only hides the detail.
 */
export const _recordDeliveryAttemptCategory = internalMutation({
  args: {
    eventId: v.id("emailDeliveryEvents"),
    category: emailDeliveryFailureCategoryValidator,
  },
  returns: v.null(),
  handler: async (ctx, { eventId, category }) => {
    const event = await ctx.db.get("emailDeliveryEvents", eventId)
    if (event && event.state === "queued") {
      await ctx.db.patch("emailDeliveryEvents", eventId, {
        failureCategory: category,
      })
    }
    return null
  },
})

export const _expireDeliveryEvent = internalMutation({
  args: { eventId: v.id("emailDeliveryEvents") },
  returns: v.null(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get("emailDeliveryEvents", eventId)
    if (event && event.expiresAt <= Date.now()) {
      await ctx.db.delete("emailDeliveryEvents", eventId)
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
    const receipt = await ctx.db.get("emailProviderActivationReceipts", activationReceiptId)
    if (!receipt || receipt.expiresAt > Date.now()) return null

    const stateRow = await readPersistedEmailProviderStateRow(ctx)
    if (
      stateRow?.lastTest?.state === "provider_accepted" &&
      stateRow.lastTest.activationReceiptId === activationReceiptId
    ) {
      await ctx.db.patch("emailProviderState", stateRow._id, {
        lastTest: undefined,
        updatedAt: Date.now(),
      })
    }
    await ctx.db.delete("emailProviderActivationReceipts", activationReceiptId)
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

/**
 * Reads the successor state for a provider-state write. A legacy source must
 * migrate first. A successor source without its row is invalid.
 */
async function readProviderStateForWrite(ctx: MutationCtx) {
  const current = await readEmailProviderStateDuringMigration(ctx)
  if (current.source === "legacy") {
    throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_REQUIRED")
  }
  const row = await readPersistedEmailProviderStateRow(ctx)
  if (current.source === "successor" && !row) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_STATE_INVALID")
  }
  return { state: current.state, row }
}

/**
 * Saving takes only the sender. It never enables or disables a provider. A
 * changed sender keeps the owner's choice, makes an active provider inactive
 * until a new test is accepted, bumps the version and clears the last test.
 */
export const saveEmailProviderConfiguration = mutation({
  args: {
    senderAddress: v.string(),
    senderName: v.optional(v.string()),
  },
  returns: emailProviderStateResultValidator,
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const { state, row } = await readProviderStateForWrite(ctx)

    const sender = normalizeSender({
      address: args.senderAddress,
      ...(args.senderName !== undefined ? { name: args.senderName } : {}),
    })
    if (sendersEqual(state.sender, sender)) {
      return emailProviderStateResult(state)
    }

    const configurationVersion = nextConfigurationVersion(
      state.configurationVersion
    )
    const provider: PersistedEmailProviderState["provider"] =
      state.provider.kind === "active"
        ? {
            kind: "configured",
            providerId: state.provider.providerId,
            configuration: state.provider.configuration,
          }
        : state.provider
    const next: PersistedEmailProviderState = {
      key: "owner",
      provider,
      sender,
      configurationVersion,
      updatedAt: Date.now(),
    }
    if (row) {
      await ctx.db.patch("emailProviderState", row._id, {
        provider,
        sender,
        configurationVersion,
        lastTest: undefined,
        updatedAt: next.updatedAt,
      })
    } else {
      await ctx.db.insert("emailProviderState", next)
    }
    return emailProviderStateResult(next)
  },
})

/**
 * The owner's choice: enable one provider. It needs no sender and no ready
 * environment. Enabling a provider that is already enabled writes nothing.
 * Enabling another one disables the current one. Either way the provider
 * starts inactive, the version increases and the last test is cleared, so a
 * test still in flight for an older version can never activate it.
 */
export const enableEmailProvider = mutation({
  args: { providerId: registeredProviderIdValidator },
  returns: emailProviderStateResultValidator,
  handler: async (ctx, { providerId }) => {
    await requireInstallationOwner(ctx)
    const { state, row } = await readProviderStateForWrite(ctx)
    if (enabledProviderIdOf(state) === providerId) {
      return emailProviderStateResult(state)
    }

    const configurationVersion = nextConfigurationVersion(
      state.configurationVersion
    )
    const provider: PersistedEmailProviderState["provider"] = {
      kind: "configured",
      providerId,
      configuration: {},
    }
    const next: PersistedEmailProviderState = {
      key: "owner",
      provider,
      ...(state.sender ? { sender: state.sender } : {}),
      configurationVersion,
      updatedAt: Date.now(),
    }
    if (row) {
      await ctx.db.patch("emailProviderState", row._id, {
        provider,
        configurationVersion,
        lastTest: undefined,
        updatedAt: next.updatedAt,
      })
    } else {
      await ctx.db.insert("emailProviderState", next)
    }
    return emailProviderStateResult(next)
  },
})

/**
 * Disable the enabled provider. Nothing is enabled afterwards and the site
 * uses the Console fallback. The sender stays. A call for a provider that is
 * not the enabled one writes nothing and reports the stored state.
 */
export const disableEmailProvider = mutation({
  args: { providerId: registeredProviderIdValidator },
  returns: emailProviderStateResultValidator,
  handler: async (ctx, { providerId }) => {
    await requireInstallationOwner(ctx)
    const current = await readEmailProviderStateDuringMigration(ctx)
    const row = await readPersistedEmailProviderStateRow(ctx)
    if (
      !row ||
      current.source !== "successor" ||
      enabledProviderIdOf(current.state) !== providerId
    ) {
      return emailProviderStateResult(current.state)
    }

    const configurationVersion = nextConfigurationVersion(
      current.state.configurationVersion
    )
    await ctx.db.patch("emailProviderState", row._id, {
      provider: { kind: "fallback" },
      configurationVersion,
      lastTest: undefined,
      updatedAt: Date.now(),
    })
    return {
      enabledProviderId: null,
      configurationVersion,
      status: "disabled" as const,
    }
  },
})

export const checkEmailProviderConfiguration = action({
  args: { providerId: registeredProviderIdValidator },
  returns: v.object({
    providerId: registeredProviderIdValidator,
    readiness: providerReadinessValidator,
    environment: v.array(emailEnvironmentVariableValidator),
  }),
  handler: async (ctx, { providerId }) => {
    await ctx.runQuery(internal.email.assertSettingsUpdate, {})
    const environment = currentEnvironment()
    return {
      providerId,
      readiness: emailProviderEnvironmentReadiness(providerId, environment),
      environment: emailProviderEnvironmentStatus(
        providerId,
        environment
      ).variables.map((variable) => ({ ...variable })),
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
    await ctx.db.patch("emailProviderState", row._id, {
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
    return await getOwnerNotificationEmail(ctx)
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
    const actor = await getActor(ctx)
    if (!actor) {
      throw new ConvexError("Unauthenticated: sign in to continue")
    }

    const email = await ctx.runQuery(
      internal.email.getDurableOwnerRecipient,
      {}
    )
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

    const ownerKey = await hashAuthClientIdentity(actor.userId)
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
      `${actor.userId}:${Date.now()}:${crypto.randomUUID()}`
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
