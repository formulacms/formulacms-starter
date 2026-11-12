import { ConvexError, type Infer, v } from "convex/values"
import type { Doc } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import {
  emailProviderStateFromRows,
  freshEmailProviderState,
  type EmailSenderIdentity,
  type PersistedEmailProviderState,
} from "./providerState"

export const EMAIL_PROVIDER_MIGRATION_VERSION = 1 as const
export const EMAIL_PROVIDER_MIGRATION_KEY = "smtp-retirement" as const

const migrationCountFields = {
  emailSettingsRows: v.number(),
  legacySiteSettingsRows: v.number(),
  consoleRows: v.number(),
  smtpRows: v.number(),
  resendRows: v.number(),
  senderIdentityRows: v.number(),
  reusableSenderRows: v.number(),
  smtpCiphertextRows: v.number(),
  legacyProviderConfigRows: v.number(),
} as const

const migrationCountKeys = [
  "emailSettingsRows",
  "legacySiteSettingsRows",
  "consoleRows",
  "smtpRows",
  "resendRows",
  "senderIdentityRows",
  "reusableSenderRows",
  "smtpCiphertextRows",
  "legacyProviderConfigRows",
] as const satisfies readonly (keyof EmailProviderMigrationCounts)[]

export const emailProviderMigrationCountsValidator =
  v.object(migrationCountFields)

export type EmailProviderMigrationCounts = Infer<
  typeof emailProviderMigrationCountsValidator
>

const migrationConflictFields = {
  duplicateEmailSettings: v.boolean(),
  duplicateSiteSettings: v.boolean(),
  duplicateProviderState: v.boolean(),
  duplicateReceipt: v.boolean(),
  providerMismatch: v.boolean(),
  senderAddressMismatch: v.boolean(),
  senderNameMismatch: v.boolean(),
  unpreservableSenderIdentity: v.boolean(),
  activeSuccessorWithLegacyState: v.boolean(),
  invalidSuccessorState: v.boolean(),
  total: v.number(),
} as const

export const emailProviderMigrationConflictsValidator = v.object(
  migrationConflictFields
)

export type EmailProviderMigrationConflicts = Infer<
  typeof emailProviderMigrationConflictsValidator
>

export const emailProviderMigrationInventoryValidator = v.object({
  counts: emailProviderMigrationCountsValidator,
  conflicts: emailProviderMigrationConflictsValidator,
  successorRows: v.number(),
  receiptRows: v.number(),
})

export type EmailProviderMigrationInventory = Infer<
  typeof emailProviderMigrationInventoryValidator
>

export const emailProviderMigrationReceiptFields = {
  key: v.literal(EMAIL_PROVIDER_MIGRATION_KEY),
  migrationVersion: v.literal(EMAIL_PROVIDER_MIGRATION_VERSION),
  status: v.literal("verified"),
  sourceFingerprint: v.string(),
  destinationStateFingerprint: v.string(),
  counts: emailProviderMigrationCountsValidator,
  senderIdentityPresent: v.boolean(),
  senderIdentityPreserved: v.boolean(),
  smtpDisabled: v.literal(true),
  legacyCleanupRequired: v.boolean(),
  verifiedAt: v.number(),
} as const

export const emailProviderMigrationReceiptValidator = v.object(
  emailProviderMigrationReceiptFields
)

export type EmailProviderMigrationReceipt = Infer<
  typeof emailProviderMigrationReceiptValidator
>

export const emailProviderMigrationDryRunValidator = v.object({
  inventory: emailProviderMigrationInventoryValidator,
  sourceFingerprint: v.string(),
  canMigrate: v.boolean(),
  legacyDataPresent: v.boolean(),
  senderIdentityPresent: v.boolean(),
  senderIdentityPreservable: v.boolean(),
  operation: v.union(
    v.literal("blocked"),
    v.literal("verify_clear"),
    v.literal("create_fallback"),
    v.literal("preserve_fallback"),
    v.literal("update_fallback_sender")
  ),
})

export type EmailProviderMigrationDryRun = Infer<
  typeof emailProviderMigrationDryRunValidator
>

export const emailProviderMigrationResultValidator = v.object({
  outcome: v.union(v.literal("migrated"), v.literal("already_verified")),
  receipt: emailProviderMigrationReceiptValidator,
})

export type EmailProviderMigrationResult = Infer<
  typeof emailProviderMigrationResultValidator
>

const narrowingBlockerValidator = v.union(
  v.literal("duplicate_email_settings"),
  v.literal("duplicate_site_settings"),
  v.literal("duplicate_provider_state"),
  v.literal("duplicate_receipt"),
  v.literal("conflicting_legacy_state"),
  v.literal("legacy_email_settings_present"),
  v.literal("legacy_site_fields_present"),
  v.literal("smtp_ciphertext_present"),
  v.literal("legacy_provider_config_present"),
  v.literal("verification_receipt_missing"),
  v.literal("verification_receipt_invalid")
)

export const emailProviderNarrowingAssessmentValidator = v.object({
  ready: v.boolean(),
  blockers: v.array(narrowingBlockerValidator),
})

export type EmailProviderNarrowingAssessment = Infer<
  typeof emailProviderNarrowingAssessmentValidator
>

type EmailMigrationReadCtx = QueryCtx | MutationCtx

type EmailMigrationRows = Readonly<{
  emailSettings: Doc<"emailSettings">[]
  siteSettings: Doc<"siteSettings">[]
  providerStates: Doc<"emailProviderState">[]
  receipts: Doc<"emailProviderMigrationReceipts">[]
}>

type EmailMigrationAnalysis = Readonly<{
  rows: EmailMigrationRows
  inventory: EmailProviderMigrationInventory
  dryRun: EmailProviderMigrationDryRun
  legacySender?: EmailSenderIdentity
  successorState?: PersistedEmailProviderState
}>

function invalidSource(): never {
  throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_SOURCE_INVALID")
}

function migrationBlocked(): never {
  throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_BLOCKED")
}

function migrationStale(): never {
  throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_STALE")
}

function cleanString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function hasLegacySiteEmailData(row: Doc<"siteSettings">): boolean {
  return (
    row.emailProvider !== undefined ||
    row.emailFromAddress !== undefined ||
    row.emailFromName !== undefined ||
    row.emailProviderConfig !== undefined
  )
}

async function readMigrationRows(
  ctx: EmailMigrationReadCtx
): Promise<EmailMigrationRows> {
  const [emailSettings, siteSettings, providerStates, receipts] =
    await Promise.all([
      ctx.db.query("emailSettings").take(2),
      ctx.db.query("siteSettings").take(2),
      ctx.db
        .query("emailProviderState")
        .withIndex("by_key", (q) => q.eq("key", "owner"))
        .take(2),
      ctx.db
        .query("emailProviderMigrationReceipts")
        .withIndex("by_key", (q) => q.eq("key", EMAIL_PROVIDER_MIGRATION_KEY))
        .take(2),
    ])
  return { emailSettings, siteSettings, providerStates, receipts }
}

function legacyProviders(rows: EmailMigrationRows): string[] {
  return [
    ...rows.emailSettings.map((row) => row.provider),
    ...rows.siteSettings.flatMap((row) =>
      row.emailProvider ? [row.emailProvider] : []
    ),
  ]
}

/**
 * The historical split migration intentionally projected legacy Resend to an
 * `emailSettings` Console row. Treat that exact semantic pair as compatible
 * while retaining conflicts for materially different providers such as SMTP.
 */
function legacyProvidersConflict(providers: readonly string[]): boolean {
  const compatibilityValues = providers.map((provider) =>
    provider === "resend" ? "console" : provider
  )
  return distinctValues(compatibilityValues).length > 1
}

function legacySenderValues(rows: EmailMigrationRows): {
  addresses: string[]
  names: string[]
  senderIdentityRows: number
  reusableSenderRows: number
} {
  const sources = [
    ...rows.emailSettings.map((row) => ({
      address: cleanString(row.fromAddress),
      name: cleanString(row.fromName),
    })),
    ...rows.siteSettings.map((row) => ({
      address: cleanString(row.emailFromAddress),
      name: cleanString(row.emailFromName),
    })),
  ]
  return {
    addresses: sources.flatMap(({ address }) => (address ? [address] : [])),
    names: sources.flatMap(({ name }) => (name ? [name] : [])),
    senderIdentityRows: sources.filter(({ address, name }) => address || name)
      .length,
    reusableSenderRows: sources.filter(({ address }) => address).length,
  }
}

function distinctAddresses(values: readonly string[]): string[] {
  const byNormalized = new Map<string, string>()
  for (const value of values) {
    const normalized = value.toLowerCase()
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, value)
  }
  return [...byNormalized.values()]
}

function distinctValues(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function deriveLegacySender(
  addresses: readonly string[],
  names: readonly string[]
): EmailSenderIdentity | undefined {
  const address = distinctAddresses(addresses)[0]
  if (!address) return undefined
  const name = distinctValues(names)[0]
  return { address, ...(name ? { name } : {}) }
}

function sendersMatch(
  left: EmailSenderIdentity | undefined,
  right: EmailSenderIdentity | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.address.trim().toLowerCase() === right.address.trim().toLowerCase() &&
    cleanString(left.name) === cleanString(right.name)
  )
}

function countConflicts(
  conflicts: Omit<EmailProviderMigrationConflicts, "total">
): EmailProviderMigrationConflicts {
  return {
    ...conflicts,
    total: Object.values(conflicts).filter(Boolean).length,
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function sourceFingerprint(rows: EmailMigrationRows): Promise<string> {
  return await sha256(
    JSON.stringify({
      emailSettings: rows.emailSettings.map((row) => ({
        id: row._id,
        provider: row.provider,
        fromAddress: row.fromAddress ?? null,
        fromName: row.fromName ?? null,
        smtpHost: row.smtpHost ?? null,
        smtpPort: row.smtpPort ?? null,
        smtpSecure: row.smtpSecure ?? null,
        smtpUser: row.smtpUser ?? null,
        smtpPasswordCiphertext: row.smtpPasswordCiphertext ?? null,
        schemaVersion: row.schemaVersion,
        updatedAt: row.updatedAt,
      })),
      siteSettings: rows.siteSettings.map((row) => ({
        id: row._id,
        emailProvider: row.emailProvider ?? null,
        emailFromAddress: row.emailFromAddress ?? null,
        emailFromName: row.emailFromName ?? null,
        emailProviderConfig: row.emailProviderConfig ?? null,
        updatedAt: row.updatedAt,
      })),
    })
  )
}

async function stateFingerprint(
  state: PersistedEmailProviderState
): Promise<string> {
  return await sha256(JSON.stringify(state))
}

function stateFields(
  row: Doc<"emailProviderState">
): PersistedEmailProviderState {
  return {
    key: row.key,
    provider: row.provider,
    ...(row.sender ? { sender: row.sender } : {}),
    configurationVersion: row.configurationVersion,
    ...(row.lastTest ? { lastTest: row.lastTest } : {}),
    updatedAt: row.updatedAt,
  }
}

function receiptFields(
  row: Doc<"emailProviderMigrationReceipts">
): EmailProviderMigrationReceipt {
  return {
    key: row.key,
    migrationVersion: row.migrationVersion,
    status: row.status,
    sourceFingerprint: row.sourceFingerprint,
    destinationStateFingerprint: row.destinationStateFingerprint,
    counts: row.counts,
    senderIdentityPresent: row.senderIdentityPresent,
    senderIdentityPreserved: row.senderIdentityPreserved,
    smtpDisabled: row.smtpDisabled,
    legacyCleanupRequired: row.legacyCleanupRequired,
    verifiedAt: row.verifiedAt,
  }
}

function receiptsMatch(
  existing: Doc<"emailProviderMigrationReceipts">,
  candidate: EmailProviderMigrationReceipt
): boolean {
  const current = receiptFields(existing)
  return (
    receiptEvidenceIsWellFormed(current) &&
    current.key === candidate.key &&
    current.migrationVersion === candidate.migrationVersion &&
    current.status === candidate.status &&
    current.sourceFingerprint === candidate.sourceFingerprint &&
    current.destinationStateFingerprint ===
      candidate.destinationStateFingerprint &&
    migrationCountKeys.every(
      (key) => current.counts[key] === candidate.counts[key]
    ) &&
    current.senderIdentityPresent === candidate.senderIdentityPresent &&
    current.senderIdentityPreserved === candidate.senderIdentityPreserved &&
    current.smtpDisabled === candidate.smtpDisabled &&
    current.legacyCleanupRequired === candidate.legacyCleanupRequired
  )
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function receiptEvidenceIsWellFormed(
  receipt: EmailProviderMigrationReceipt
): boolean {
  const recordedLegacyRows =
    receipt.counts.emailSettingsRows > 0 ||
    receipt.counts.legacySiteSettingsRows > 0
  return (
    /^[a-f0-9]{64}$/.test(receipt.sourceFingerprint) &&
    /^[a-f0-9]{64}$/.test(receipt.destinationStateFingerprint) &&
    migrationCountKeys.every((key) =>
      isNonNegativeSafeInteger(receipt.counts[key])
    ) &&
    isNonNegativeSafeInteger(receipt.verifiedAt) &&
    (!receipt.senderIdentityPresent || receipt.senderIdentityPreserved) &&
    receipt.legacyCleanupRequired === recordedLegacyRows
  )
}

async function analyzeEmailProviderMigration(
  ctx: EmailMigrationReadCtx
): Promise<EmailMigrationAnalysis> {
  const rows = await readMigrationRows(ctx)
  const providers = legacyProviders(rows)
  const senderValues = legacySenderValues(rows)
  const distinctProviderValues = distinctValues(providers)
  const distinctAddressValues = distinctAddresses(senderValues.addresses)
  const distinctNameValues = distinctValues(senderValues.names)
  const legacySiteSettingsRows = rows.siteSettings.filter(
    hasLegacySiteEmailData
  ).length
  const legacyDataPresent =
    rows.emailSettings.length > 0 || legacySiteSettingsRows > 0

  let successorState: PersistedEmailProviderState | undefined
  let invalidSuccessorState = false
  if (rows.providerStates.length === 1) {
    try {
      successorState = emailProviderStateFromRows([
        stateFields(rows.providerStates[0]!),
      ])
    } catch {
      invalidSuccessorState = true
    }
  }

  const legacySender = deriveLegacySender(
    senderValues.addresses,
    senderValues.names
  )
  const successorSenderMismatch =
    successorState?.sender !== undefined &&
    legacySender !== undefined &&
    !sendersMatch(successorState.sender, legacySender)
  const conflicts = countConflicts({
    duplicateEmailSettings: rows.emailSettings.length > 1,
    duplicateSiteSettings: rows.siteSettings.length > 1,
    duplicateProviderState: rows.providerStates.length > 1,
    duplicateReceipt: rows.receipts.length > 1,
    providerMismatch: legacyProvidersConflict(distinctProviderValues),
    senderAddressMismatch:
      distinctAddressValues.length > 1 ||
      (successorSenderMismatch &&
        successorState?.sender?.address.trim().toLowerCase() !==
          legacySender?.address.trim().toLowerCase()),
    senderNameMismatch:
      distinctNameValues.length > 1 ||
      (successorSenderMismatch &&
        cleanString(successorState?.sender?.name) !==
          cleanString(legacySender?.name)),
    unpreservableSenderIdentity:
      senderValues.senderIdentityRows > 0 && legacySender === undefined,
    activeSuccessorWithLegacyState:
      legacyDataPresent &&
      successorState !== undefined &&
      successorState.provider.kind !== "fallback",
    invalidSuccessorState,
  })
  const counts: EmailProviderMigrationCounts = {
    emailSettingsRows: rows.emailSettings.length,
    legacySiteSettingsRows,
    consoleRows: providers.filter((provider) => provider === "console").length,
    smtpRows: providers.filter((provider) => provider === "smtp").length,
    resendRows: providers.filter((provider) => provider === "resend").length,
    senderIdentityRows: senderValues.senderIdentityRows,
    reusableSenderRows: senderValues.reusableSenderRows,
    smtpCiphertextRows: rows.emailSettings.filter(
      (row) => row.smtpPasswordCiphertext !== undefined
    ).length,
    legacyProviderConfigRows: rows.siteSettings.filter(
      (row) => row.emailProviderConfig !== undefined
    ).length,
  }
  const inventory: EmailProviderMigrationInventory = {
    counts,
    conflicts,
    successorRows: rows.providerStates.length,
    receiptRows: rows.receipts.length,
  }

  let operation: EmailProviderMigrationDryRun["operation"]
  if (conflicts.total > 0) {
    operation = "blocked"
  } else if (!legacyDataPresent) {
    operation = "verify_clear"
  } else if (!successorState) {
    operation = "create_fallback"
  } else if (!successorState.sender && legacySender) {
    operation = "update_fallback_sender"
  } else {
    operation = "preserve_fallback"
  }

  const dryRun: EmailProviderMigrationDryRun = {
    inventory,
    sourceFingerprint: await sourceFingerprint(rows),
    canMigrate: conflicts.total === 0,
    legacyDataPresent,
    senderIdentityPresent: senderValues.senderIdentityRows > 0,
    senderIdentityPreservable:
      senderValues.senderIdentityRows === 0 || legacySender !== undefined,
    operation,
  }
  return { rows, inventory, dryRun, legacySender, successorState }
}

export async function inventoryEmailProviderMigration(
  ctx: EmailMigrationReadCtx
): Promise<EmailProviderMigrationInventory> {
  return (await analyzeEmailProviderMigration(ctx)).inventory
}

export async function dryRunEmailProviderMigration(
  ctx: EmailMigrationReadCtx
): Promise<EmailProviderMigrationDryRun> {
  return (await analyzeEmailProviderMigration(ctx)).dryRun
}

/**
 * Compatibility reader for the E03 widening window. Successor state wins only
 * after every singleton is structurally sound. Legacy Console, SMTP, and
 * Resend selections all synthesize the non-delivering fallback; SMTP values
 * and environment variables are never interpreted as an active provider.
 */
export async function readEmailProviderStateDuringMigration(
  ctx: EmailMigrationReadCtx
): Promise<
  Readonly<{
    source: "successor" | "legacy" | "fresh"
    state: PersistedEmailProviderState
  }>
> {
  const analysis = await analyzeEmailProviderMigration(ctx)
  if (analysis.inventory.conflicts.total > 0) invalidSource()
  if (analysis.successorState) {
    return { source: "successor", state: analysis.successorState }
  }
  if (!analysis.dryRun.legacyDataPresent) {
    return { source: "fresh", state: freshEmailProviderState() }
  }
  const state: PersistedEmailProviderState = {
    ...freshEmailProviderState(),
    ...(analysis.legacySender ? { sender: analysis.legacySender } : {}),
    configurationVersion: analysis.legacySender ? 1 : 0,
  }
  return { source: "legacy", state }
}

function assertMigrationTimestamp(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new ConvexError("CMS_EMAIL_PROVIDER_MIGRATION_TIMESTAMP_INVALID")
  }
}

function assertFingerprint(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) migrationStale()
}

export async function migrateEmailProviderState(
  ctx: MutationCtx,
  input: { expectedSourceFingerprint: string; now: number }
): Promise<EmailProviderMigrationResult> {
  assertMigrationTimestamp(input.now)
  assertFingerprint(input.expectedSourceFingerprint)
  const analysis = await analyzeEmailProviderMigration(ctx)
  if (analysis.dryRun.sourceFingerprint !== input.expectedSourceFingerprint) {
    migrationStale()
  }
  if (!analysis.dryRun.canMigrate) migrationBlocked()

  let destination: PersistedEmailProviderState
  let wroteState = false
  const existing = analysis.rows.providerStates[0]
  if (!analysis.dryRun.legacyDataPresent) {
    destination = existing
      ? emailProviderStateFromRows([stateFields(existing)])
      : freshEmailProviderState()
    if (destination.provider.kind !== "fallback") migrationBlocked()
  } else if (!existing) {
    destination = {
      key: "owner",
      provider: { kind: "fallback" },
      ...(analysis.legacySender ? { sender: analysis.legacySender } : {}),
      configurationVersion: analysis.legacySender ? 1 : 0,
      updatedAt: input.now,
    }
    await ctx.db.insert("emailProviderState", destination)
    wroteState = true
  } else {
    const current = emailProviderStateFromRows([stateFields(existing)])
    if (current.provider.kind !== "fallback") migrationBlocked()
    if (!current.sender && analysis.legacySender) {
      if (current.configurationVersion === Number.MAX_SAFE_INTEGER) {
        invalidSource()
      }
      destination = {
        ...current,
        sender: analysis.legacySender,
        configurationVersion: current.configurationVersion + 1,
        updatedAt: input.now,
      }
      await ctx.db.patch(existing._id, {
        sender: analysis.legacySender,
        configurationVersion: destination.configurationVersion,
        updatedAt: input.now,
      })
      wroteState = true
    } else {
      destination = current
    }
  }

  const verified = emailProviderStateFromRows([destination])
  if (
    verified.provider.kind !== "fallback" ||
    (analysis.legacySender &&
      !sendersMatch(verified.sender, analysis.legacySender))
  ) {
    invalidSource()
  }

  const receipt: EmailProviderMigrationReceipt = {
    key: EMAIL_PROVIDER_MIGRATION_KEY,
    migrationVersion: EMAIL_PROVIDER_MIGRATION_VERSION,
    status: "verified",
    sourceFingerprint: analysis.dryRun.sourceFingerprint,
    destinationStateFingerprint: await stateFingerprint(verified),
    counts: analysis.inventory.counts,
    senderIdentityPresent: analysis.dryRun.senderIdentityPresent,
    senderIdentityPreserved:
      !analysis.legacySender ||
      sendersMatch(verified.sender, analysis.legacySender),
    smtpDisabled: true,
    legacyCleanupRequired:
      analysis.inventory.counts.emailSettingsRows > 0 ||
      analysis.inventory.counts.legacySiteSettingsRows > 0,
    verifiedAt: input.now,
  }
  const existingReceipt = analysis.rows.receipts[0]
  if (
    existingReceipt &&
    receiptsMatch(existingReceipt, receipt) &&
    !wroteState
  ) {
    return {
      outcome: "already_verified",
      receipt: receiptFields(existingReceipt),
    }
  }
  if (existingReceipt) {
    await ctx.db.patch(existingReceipt._id, receipt)
  } else {
    await ctx.db.insert("emailProviderMigrationReceipts", receipt)
  }
  return { outcome: "migrated", receipt }
}

/**
 * Source-side narrow guard only. E03 never deletes ciphertext or legacy
 * fields; a separately authorized cleanup must make every blocker disappear
 * before schema narrowing can be considered.
 */
export async function assessEmailProviderNarrowing(
  ctx: EmailMigrationReadCtx
): Promise<EmailProviderNarrowingAssessment> {
  const analysis = await analyzeEmailProviderMigration(ctx)
  const blockers: EmailProviderNarrowingAssessment["blockers"] = []
  const { conflicts } = analysis.inventory
  if (conflicts.duplicateEmailSettings) {
    blockers.push("duplicate_email_settings")
  }
  if (conflicts.duplicateSiteSettings) {
    blockers.push("duplicate_site_settings")
  }
  if (conflicts.duplicateProviderState) {
    blockers.push("duplicate_provider_state")
  }
  if (conflicts.duplicateReceipt) blockers.push("duplicate_receipt")
  if (
    conflicts.providerMismatch ||
    conflicts.senderAddressMismatch ||
    conflicts.senderNameMismatch ||
    conflicts.unpreservableSenderIdentity ||
    conflicts.activeSuccessorWithLegacyState ||
    conflicts.invalidSuccessorState
  ) {
    blockers.push("conflicting_legacy_state")
  }
  if (analysis.inventory.counts.emailSettingsRows > 0) {
    blockers.push("legacy_email_settings_present")
  }
  if (analysis.inventory.counts.legacySiteSettingsRows > 0) {
    blockers.push("legacy_site_fields_present")
  }
  if (analysis.inventory.counts.smtpCiphertextRows > 0) {
    blockers.push("smtp_ciphertext_present")
  }
  if (analysis.inventory.counts.legacyProviderConfigRows > 0) {
    blockers.push("legacy_provider_config_present")
  }

  const receipt = analysis.rows.receipts[0]
  if (!receipt) {
    blockers.push("verification_receipt_missing")
  } else {
    const state =
      analysis.rows.providerStates.length === 0
        ? freshEmailProviderState()
        : analysis.successorState
    const validDestination =
      state !== undefined &&
      state.provider.kind === "fallback" &&
      receipt.destinationStateFingerprint === (await stateFingerprint(state))
    if (
      receipt.migrationVersion !== EMAIL_PROVIDER_MIGRATION_VERSION ||
      receipt.status !== "verified" ||
      receipt.smtpDisabled !== true ||
      !receiptEvidenceIsWellFormed(receiptFields(receipt)) ||
      !validDestination
    ) {
      blockers.push("verification_receipt_invalid")
    }
  }

  return { ready: blockers.length === 0, blockers }
}
