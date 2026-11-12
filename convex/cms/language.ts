import {
  readLiveAddressRows,
  readHeldHistoricalRows,
} from "../lib/publishing/snapshots"
import { ConvexError, v } from "convex/values"
import {
  paginationOptsValidator,
  paginationResultValidator,
} from "convex/server"
import type {
  PaginationOptions,
  PaginationResult,
  TransactionMetrics,
} from "convex/server"
import { internal } from "../_generated/api"
import type { Doc, Id } from "../_generated/dataModel"
import { internalMutation, mutation, query } from "../_generated/server"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { SUPPORTED_LOCALES } from "../../lib/i18n/config"
import { transitionSiteDescriptionFields } from "../../lib/i18n/site-description"
import { requireInstallationOwner } from "../lib/access/policy"
import { walkCanonicalMenuTargets, type NavItem } from "../lib/menu"
import { validateCanonicalWrite } from "../lib/menu/canonicalWrite"
import { refreshMenuReferences } from "../lib/menu/references"
import { validateCanonicalMenuForLocale } from "../lib/menu/validate"
import {
  canonicalJson,
  digestLocalePublicationCandidate,
} from "../lib/publishing/localeCandidate"
import {
  readFrozenSnapshotProjection,
  readHiddenTargetSnapshotProjection,
  readPublicationAuthority,
} from "../lib/publishing/snapshots"
import {
  OPEN_TRANSITION_PHASES,
  PREPARABLE_TRANSITION_PHASES,
  SITE_LANGUAGE_AUTHORITY_KEY,
  assertNoLanguageTransitionConflicts,
  describeSourcePage,
  patchTransition,
  readAuthorityRows,
  readOpenTransition,
  readSiteLanguageState,
  readTransitionPage,
  recordTargetDraftWrite,
  type Transition,
  type TransitionPage,
} from "../lib/language/state"
import {
  CARRY_DECISION_EMPTY_DIGEST,
  extendCarryDecisionDigest,
} from "../lib/language/carryDecisionDigest"
import { crossedReserve } from "../lib/language/impactPreview"
import {
  createTransitionTargetDraft,
  deleteCancelledRetainedTargetDraft,
  deleteTransitionTargetDraft,
  publishPreparedTargetLocale,
  withdrawPreparedTargetLocale,
} from "./publication"

/**
 * F09a — owner-only durable site-language transition state machine. Owner
 * commands reauthenticate the installation owner; workers are internal and
 * carry the transition generation, so a stale or terminal step is a no-op.
 * Activation, the reader version pin and rollback activation are F09c.
 */

const PAGE_BATCH = 32
const ATTRIBUTION_LIMIT = 32
const ROUTE_LIMIT = 64
const MENU_LIMIT = 64
const REFERENCE_LIMIT = 512
const CANCEL_PASS_LIMIT = 16
const CARRY_BATCH = 32
const CARRY_COVERAGE_QUERY_MAX = 66
const CARRY_COVERAGE_DOCUMENTS_READ_MAX = 97
const CARRY_COVERAGE_DOCUMENTS_WRITTEN_MAX = 1
const CARRY_COVERAGE_SCHEDULED_MAX = 1

/** Injectable pagination/metrics seam for P24 and P11c carry-worker proof. */
export const languageCarrySeam = {
  paginate<T>(
    query: {
      paginate(options: PaginationOptions): Promise<PaginationResult<T>>
    },
    options: PaginationOptions
  ): Promise<PaginationResult<T>> {
    return query.paginate(options)
  },
  metrics(ctx: MutationCtx): Promise<TransactionMetrics> {
    return ctx.meta.getTransactionMetrics()
  },
}

const modeValidator = v.union(
  v.literal("correct_label"),
  v.literal("replace_content"),
  v.literal("rollback")
)
const phaseValidator = v.union(
  v.literal("enumerating"),
  v.literal("preparing"),
  v.literal("validating"),
  v.literal("ready"),
  v.literal("committed"),
  v.literal("cancelling"),
  v.literal("cancelled")
)

function fail(code: string): never {
  throw new ConvexError(code)
}

function errorCode(error: unknown): string {
  return error instanceof ConvexError && typeof error.data === "string"
    ? error.data
    : "LANGUAGE_TRANSITION_PREPARATION_FAILED"
}

function parseCursor(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

type CancelCursor =
  | {
      part: "pages"
      cursor: string | null
      failed: boolean
      passes: number
    }
  | { part: "carry_decisions"; cursor: string | null }

function cancellationCursor(transition: Transition): CancelCursor {
  const parsed = parseCursor(transition.cursor)
  if (parsed.part === "carry_decisions") {
    return {
      part: "carry_decisions",
      cursor: stringOrNull(parsed.cursor),
    }
  }
  if (parsed.part !== undefined && parsed.part !== "pages") {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return {
    part: "pages",
    cursor: stringOrNull(parsed.cursor),
    failed: parsed.failed === true,
    passes:
      typeof parsed.passes === "number" &&
      Number.isInteger(parsed.passes) &&
      parsed.passes >= 0
        ? parsed.passes
        : 0,
  }
}

async function requireSnapshotLanguageAuthority(
  ctx: QueryCtx | MutationCtx
): Promise<void> {
  if ((await readPublicationAuthority(ctx)) !== "snapshot_active") {
    fail("LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY")
  }
}

async function requireActiveTransition(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  expectedGeneration?: number
): Promise<Transition> {
  await requireSnapshotLanguageAuthority(ctx)
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "multilingual") {
    fail("LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED")
  }
  if (state.kind !== "current") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  const transition = await readOpenTransition(ctx, state)
  if (!transition || transition._id !== transitionId) {
    fail("LANGUAGE_TRANSITION_NOT_OPEN")
  }
  if (
    expectedGeneration !== undefined &&
    transition.generation !== expectedGeneration
  ) {
    fail("LANGUAGE_TRANSITION_STALE")
  }
  return transition
}

function requirePhase(
  transition: Transition,
  phases: readonly Transition["phase"][]
): void {
  if (!phases.includes(transition.phase)) {
    fail("LANGUAGE_TRANSITION_PHASE_INVALID")
  }
}

async function requireRow(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">,
  expectedGeneration?: number
): Promise<TransitionPage> {
  const row = await readTransitionPage(ctx, transition._id, pageId)
  if (!row) fail("LANGUAGE_TRANSITION_PAGE_NOT_FOUND")
  if (
    expectedGeneration !== undefined &&
    row.generation !== expectedGeneration
  ) {
    fail("LANGUAGE_TRANSITION_PAGE_STALE")
  }
  return row
}

async function scheduleStep(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">
): Promise<void> {
  const transition = await ctx.db.get(transitionId)
  if (!transition || !OPEN_TRANSITION_PHASES.has(transition.phase)) return
  await ctx.scheduler.runAfter(
    0,
    internal.cms.language.stepLanguageTransition,
    { transitionId, generation: transition.generation }
  )
}

async function scheduleContinuation(
  ctx: MutationCtx,
  transition: Transition
): Promise<void> {
  if (
    transition.phase === "preparing" &&
    transition.cursorPhase === "carry_coverage"
  ) {
    await ctx.scheduler.runAfter(
      0,
      internal.cms.language.stepLanguageTransition,
      { transitionId: transition._id, generation: transition.generation }
    )
    return
  }
  await scheduleStep(ctx, transition._id)
}

async function oneState(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<Doc<"pageLocalePublicationStates"> | null> {
  const rows = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    )
    .take(2)
  if (rows.length > 1) fail("PAGE_LOCALE_PUBLICATION_STATE_INVALID")
  return rows[0] ?? null
}

async function oneDraft(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<Doc<"pageLocaleDrafts"> | null> {
  const rows = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_locale", (q) =>
      q.eq("pageId", pageId).eq("locale", locale)
    )
    .take(2)
  if (rows.length > 1) fail("PAGE_LOCALE_DRAFT_INVALID")
  return rows[0] ?? null
}

async function onePageState(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<Doc<"pagePublicationPageStates">> {
  const rows = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (rows.length !== 1) fail("PAGE_PUBLICATION_PAGE_STATE_INVALID")
  return rows[0]!
}

/** Target fields without a selection, keeping draft and confirmation facts. */
function targetWithoutSelection(
  target: TransitionPage["target"]
): TransitionPage["target"] {
  return {
    draftCreatedByTransition: target.draftCreatedByTransition,
    ...(target.draftGeneration !== undefined
      ? { draftGeneration: target.draftGeneration }
      : {}),
    ...(target.confirmedDraftGeneration !== undefined
      ? { confirmedDraftGeneration: target.confirmedDraftGeneration }
      : {}),
    ...(target.confirmedSharedDraftGeneration !== undefined
      ? {
          confirmedSharedDraftGeneration: target.confirmedSharedDraftGeneration,
        }
      : {}),
    ...(target.targetBasis === "draft"
      ? { targetBasis: target.targetBasis }
      : {}),
    ...(target.retainedDraftAttribution
      ? { retainedDraftAttribution: target.retainedDraftAttribution }
      : {}),
    ...(target.retainedReview ? { retainedReview: target.retainedReview } : {}),
  }
}

type InstallationOwner = Awaited<ReturnType<typeof requireInstallationOwner>>
type RetainedBinding = NonNullable<
  TransitionPage["target"]["retainedReview"]
>["binding"]

type RetainedTargetState = {
  binding: RetainedBinding
  digest: string
  frozen: Awaited<ReturnType<typeof readFrozenSnapshotProjection>>
  selectionSnapshot: Doc<"pagePublishedSnapshots"> | null
  targetDraft: Doc<"pageLocaleDrafts"> | null
  sharedDraft: Doc<"pageSharedDrafts"> | null
}

function isRetainedTargetReviewEligible(row: TransitionPage): boolean {
  return (
    row.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT" ||
    row.target.retainedReview !== undefined ||
    row.target.targetBasis !== undefined ||
    row.target.retainedDraftAttribution !== undefined
  )
}

function nullableRetainedBinding(binding: RetainedBinding) {
  return {
    authorityVersion: binding.authorityVersion,
    settingsUpdatedAt: binding.settingsUpdatedAt,
    moduleConfigurationVersion: binding.moduleConfigurationVersion,
    lifecycleGeneration: binding.lifecycleGeneration,
    targetStateId: binding.targetStateId ?? null,
    targetPublicGeneration: binding.targetPublicGeneration,
    targetDraftGeneration: binding.targetDraftGeneration,
    targetReleaseGeneration: binding.targetReleaseGeneration,
    targetUpdatedAt: binding.targetUpdatedAt ?? null,
    selectionSnapshotId: binding.selectionSnapshotId ?? null,
    selectionPublishedAt: binding.selectionPublishedAt ?? null,
    selectionPath: binding.selectionPath ?? null,
    draftBaseSnapshotId: binding.draftBaseSnapshotId ?? null,
    workingDraftId: binding.workingDraftId ?? null,
    workingDraftGeneration: binding.workingDraftGeneration ?? null,
    sharedDraftId: binding.sharedDraftId ?? null,
    sharedDraftGeneration: binding.sharedDraftGeneration ?? null,
    sourceStateId: binding.sourceStateId ?? null,
    sourceSnapshotId: binding.sourceSnapshotId ?? null,
    sourcePublicGeneration: binding.sourcePublicGeneration,
    sourceDraftGeneration: binding.sourceDraftGeneration,
    sourceReleaseGeneration: binding.sourceReleaseGeneration,
    sourceUpdatedAt: binding.sourceUpdatedAt ?? null,
  }
}

async function retainedReviewDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `formulacms/f09/retained-target-review/v1\n${canonicalJson(value)}`
    )
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
}

async function readRetainedTargetState(
  ctx: QueryCtx | MutationCtx,
  transition: Transition,
  row: TransitionPage,
  owner: InstallationOwner
): Promise<RetainedTargetState | null> {
  const [
    settingsRows,
    authorityRows,
    moduleRows,
    pageStates,
    targetState,
    targetDraft,
    sharedRows,
    sourceState,
  ] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
    ctx.db
      .query("cmsModuleState")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .take(2),
    ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", row.pageId))
      .take(2),
    oneState(ctx, row.pageId, transition.targetLocale),
    oneDraft(ctx, row.pageId, transition.targetLocale),
    ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", row.pageId))
      .take(2),
    oneState(ctx, row.pageId, transition.sourceLocale),
  ])
  if (
    settingsRows.length !== 1 ||
    authorityRows.length !== 1 ||
    moduleRows.length > 1 ||
    pageStates.length !== 1 ||
    sharedRows.length > 1
  ) {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  if (pageStates[0]!.lifecycleState !== "active") return null
  if (
    targetDraft &&
    (!targetState || targetDraft.generation !== targetState.draftGeneration)
  ) {
    fail("PAGE_LOCALE_DRAFT_INVALID")
  }
  if (
    targetState?.hasCurrentSnapshot !== true &&
    (targetState?.currentSnapshotId !== undefined ||
      targetState?.currentPath !== undefined ||
      targetState?.currentPublishedAt !== undefined)
  ) {
    fail("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
  }
  const frozen = targetState?.hasCurrentSnapshot
    ? targetState.currentSnapshotId
      ? await readFrozenSnapshotProjection(
          ctx,
          targetState.currentSnapshotId,
          row.pageId,
          transition.targetLocale
        )
      : null
    : null
  if (targetState?.hasCurrentSnapshot && !frozen) {
    fail("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
  }
  const selectionSnapshot = targetState?.currentSnapshotId
    ? await ctx.db.get(targetState.currentSnapshotId)
    : null
  if (frozen && !selectionSnapshot) {
    fail("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
  }
  if (!frozen && !targetDraft && !targetState?.draftBaseSnapshotId) return null

  const binding: RetainedBinding = {
    authorityVersion: authorityRows[0]!.version,
    settingsUpdatedAt: settingsRows[0]!.updatedAt,
    moduleConfigurationVersion: moduleRows[0]?.configurationVersion ?? 0,
    lifecycleGeneration: pageStates[0]!.lifecycleGeneration,
    ...(targetState ? { targetStateId: targetState._id } : {}),
    targetPublicGeneration: targetState?.publicGeneration ?? 0,
    targetDraftGeneration: targetState?.draftGeneration ?? 0,
    targetReleaseGeneration: targetState?.releaseGeneration ?? 0,
    ...(targetState ? { targetUpdatedAt: targetState.updatedAt } : {}),
    ...(frozen
      ? {
          selectionSnapshotId: targetState!.currentSnapshotId!,
          selectionPublishedAt: selectionSnapshot!.publishedAt,
          ...(targetState?.currentPath !== undefined
            ? { selectionPath: targetState.currentPath }
            : {}),
        }
      : {}),
    ...(targetState?.draftBaseSnapshotId
      ? { draftBaseSnapshotId: targetState.draftBaseSnapshotId }
      : {}),
    ...(targetDraft
      ? {
          workingDraftId: targetDraft._id,
          workingDraftGeneration: targetDraft.generation,
        }
      : {}),
    ...(sharedRows[0]
      ? {
          sharedDraftId: sharedRows[0]._id,
          sharedDraftGeneration: sharedRows[0].generation,
        }
      : {}),
    ...(sourceState ? { sourceStateId: sourceState._id } : {}),
    ...(sourceState?.currentSnapshotId
      ? { sourceSnapshotId: sourceState.currentSnapshotId }
      : {}),
    sourcePublicGeneration: sourceState?.publicGeneration ?? 0,
    sourceDraftGeneration: sourceState?.draftGeneration ?? 0,
    sourceReleaseGeneration: sourceState?.releaseGeneration ?? 0,
    ...(sourceState ? { sourceUpdatedAt: sourceState.updatedAt } : {}),
  }
  const digest = await retainedReviewDigest({
    transition: {
      id: transition._id,
      generation: transition.generation,
      mode: transition.mode,
      sourceLocale: transition.sourceLocale,
      targetLocale: transition.targetLocale,
    },
    row: { generation: row.generation },
    owner: {
      id: owner.ownerId,
      tokenIdentifier: owner.tokenIdentifier,
    },
    binding: nullableRetainedBinding(binding),
  })
  return {
    binding,
    digest,
    frozen,
    selectionSnapshot,
    targetDraft,
    sharedDraft: sharedRows[0] ?? null,
  }
}

function retainedBindingMatches(
  left: RetainedBinding,
  right: RetainedBinding
): boolean {
  return (
    canonicalJson(nullableRetainedBinding(left)) ===
    canonicalJson(nullableRetainedBinding(right))
  )
}

function retainedDecisionCurrent(
  row: TransitionPage,
  owner: InstallationOwner,
  retained: RetainedTargetState | null
): retained is RetainedTargetState {
  const receipt = row.target.retainedReview
  return (
    receipt !== undefined &&
    receipt.ownerId === owner.ownerId &&
    receipt.tokenIdentifier === owner.tokenIdentifier &&
    receipt.basis === row.target.targetBasis &&
    retained !== null &&
    retainedBindingMatches(retained.binding, receipt.binding)
  )
}

function isTransitionPreparedSelection(
  row: TransitionPage,
  retained: RetainedTargetState
): boolean {
  return (
    retained.frozen !== null &&
    row.target.selectionProvenance === "transition_prepared" &&
    row.target.snapshotId === retained.binding.selectionSnapshotId &&
    row.target.publicGeneration === retained.binding.targetPublicGeneration
  )
}

async function patchRow(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  row: TransitionPage,
  next: Partial<TransitionPage>,
  options: { prepared?: boolean; carryInput?: boolean; reopen?: boolean } = {}
): Promise<void> {
  const disposition = next.disposition ?? row.disposition
  const status = next.status ?? row.status
  await ctx.db.patch(row._id, {
    ...next,
    generation: row.generation + 1,
    updatedAt: Date.now(),
  })
  await patchTransition(ctx, transitionId, {
    before: row,
    after: { disposition, status },
    ...options,
  })
}

async function blockRow(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">,
  code: string
): Promise<void> {
  const row = await readTransitionPage(ctx, transitionId, pageId)
  if (!row || (row.status === "blocked" && row.blockerCode === code)) return
  await patchRow(ctx, transitionId, row, {
    status: "blocked",
    blockerCode: code,
  })
}

async function insertRow(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">,
  fields: Pick<TransitionPage, "kind" | "source" | "disposition" | "status"> & {
    blockerCode?: string
  }
): Promise<void> {
  const row = {
    transitionId,
    pageId,
    ...fields,
    target: { draftCreatedByTransition: false },
    generation: 1,
    updatedAt: Date.now(),
  }
  await ctx.db.insert("siteLanguageTransitionPages", row)
  await patchTransition(ctx, transitionId, { before: null, after: row })
}

async function upsertContinuityRoute(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  fromPath: string,
  pageId: Id<"pages">,
  origin: Doc<"siteLanguageTransitionRoutes">["origin"]
): Promise<void> {
  const existing = await ctx.db
    .query("siteLanguageTransitionRoutes")
    .withIndex("by_transitionId_and_fromPath", (q) =>
      q.eq("transitionId", transitionId).eq("fromPath", fromPath)
    )
    .take(2)
  if (existing.some((route) => route.pageId === pageId)) return
  await ctx.db.insert("siteLanguageTransitionRoutes", {
    transitionId,
    fromPath,
    pageId,
    origin,
    createdAt: Date.now(),
  })
}

async function deleteRoutes(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">,
  origin: Doc<"siteLanguageTransitionRoutes">["origin"]
): Promise<void> {
  const routes = await ctx.db
    .query("siteLanguageTransitionRoutes")
    .withIndex("by_transitionId_and_pageId", (q) =>
      q.eq("transitionId", transitionId).eq("pageId", pageId)
    )
    .take(ROUTE_LIMIT + 1)
  if (routes.length > ROUTE_LIMIT) fail("LANGUAGE_TRANSITION_ROUTE_LIMIT")
  for (const route of routes) {
    if (route.origin === origin) await ctx.db.delete(route._id)
  }
}

type CarryOutcome = Doc<"siteLanguageCarryDecisions">["outcome"]
type ContinuityPointer = NonNullable<
  Doc<"siteLanguageAuthority">["continuityPointer"]
>

type InitialCarryCursor = {
  part: "decide" | "digest"
  page: string | null
  size: number
  startSourcePublicSetVersion: number
  startCarryInputVersion: number
  digest?: string
}

function initialCarryCursor(transition: Transition): InitialCarryCursor {
  const parsed = parseCursor(transition.cursor)
  const part = parsed.part === "digest" ? "digest" : "decide"
  const size =
    typeof parsed.size === "number" &&
    Number.isInteger(parsed.size) &&
    parsed.size >= 1 &&
    parsed.size <= CARRY_BATCH
      ? parsed.size
      : CARRY_BATCH
  const startSourcePublicSetVersion =
    typeof parsed.startSourcePublicSetVersion === "number"
      ? parsed.startSourcePublicSetVersion
      : transition.sourcePublicSetVersion
  const startCarryInputVersion =
    typeof parsed.startCarryInputVersion === "number"
      ? parsed.startCarryInputVersion
      : (transition.carryInputVersion ?? 0)
  if (part === "digest" && typeof parsed.digest !== "string") {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return {
    part,
    page: stringOrNull(parsed.page),
    size,
    startSourcePublicSetVersion,
    startCarryInputVersion,
    ...(part === "digest" ? { digest: parsed.digest as string } : {}),
  }
}

async function halveCarryStep<T extends { size: number }>(
  ctx: MutationCtx,
  transition: Transition,
  cursor: T
): Promise<boolean> {
  if (cursor.size <= 1) fail("LANGUAGE_TRANSITION_CARRY_LIMIT")
  await patchTransition(ctx, transition._id, {
    fields: {
      cursor: JSON.stringify({
        ...cursor,
        size: Math.floor(cursor.size / 2),
      }),
    },
  })
  return true
}

type CoverageCarryCursor = {
  migrationId: Id<"siteDefaultLanguageMigrations">
  generation: number
  page: string | null
  size: number
  previousFromPath: string | null
}

function initialCoverageCarryCursor(
  pointer: ContinuityPointer
): CoverageCarryCursor {
  return {
    migrationId: pointer.migrationId,
    generation: pointer.generation,
    page: null,
    size: CARRY_BATCH,
    previousFromPath: null,
  }
}

function coverageCarryCursor(transition: Transition): CoverageCarryCursor {
  const parsed = parseCursor(transition.cursor)
  if (
    typeof parsed.migrationId !== "string" ||
    typeof parsed.generation !== "number" ||
    !Number.isSafeInteger(parsed.generation) ||
    parsed.generation < 1 ||
    typeof parsed.size !== "number" ||
    !Number.isInteger(parsed.size) ||
    parsed.size < 1 ||
    parsed.size > CARRY_BATCH ||
    (parsed.page !== null && typeof parsed.page !== "string") ||
    (parsed.previousFromPath !== null &&
      typeof parsed.previousFromPath !== "string")
  ) {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return {
    migrationId: parsed.migrationId as Id<"siteDefaultLanguageMigrations">,
    generation: parsed.generation,
    page: parsed.page,
    size: parsed.size,
    previousFromPath: parsed.previousFromPath,
  }
}

async function readContinuityPointer(
  ctx: MutationCtx
): Promise<ContinuityPointer | undefined> {
  const authorityRows = await readAuthorityRows(ctx)
  if (authorityRows.length !== 1) fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  return authorityRows[0]!.continuityPointer
}

async function requireContinuityPointer(
  ctx: MutationCtx
): Promise<ContinuityPointer> {
  const pointer = await readContinuityPointer(ctx)
  if (!pointer) fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  return pointer
}

function coverageCrossedReserve(
  metrics: TransactionMetrics,
  rowsRemaining: number
): boolean {
  if (crossedReserve(metrics)) return true
  const projectedPointReads = rowsRemaining * 2
  return (
    metrics.databaseQueries.used + projectedPointReads >
      CARRY_COVERAGE_QUERY_MAX ||
    metrics.documentsRead.used + projectedPointReads + 1 >
      CARRY_COVERAGE_DOCUMENTS_READ_MAX ||
    metrics.documentsWritten.used + 1 > CARRY_COVERAGE_DOCUMENTS_WRITTEN_MAX ||
    metrics.functionsScheduled.used + 1 > CARRY_COVERAGE_SCHEDULED_MAX
  )
}

async function carryOutcome(
  ctx: MutationCtx,
  transition: Transition,
  route: Doc<"siteDefaultLanguageRoutes">,
  ownedRoute?: Readonly<{ pageId: Id<"pages"> }>,
  knownRoutes?: readonly Doc<"siteLanguageTransitionRoutes">[]
): Promise<CarryOutcome> {
  if (route.locale !== transition.sourceLocale) return "drop_locale"
  const [current, historical] = await Promise.all([
    readLiveAddressRows(ctx, transition.sourceLocale, route.fromPath),
    readHeldHistoricalRows(ctx, transition.sourceLocale, route.fromPath),
  ])
  if (!current || !historical || current.length > 1 || historical.length > 1)
    fail("PAGE_ADDRESS_STATE_INVALID")
  if (current.length > 0 || historical.length > 0) return "drop_claimed"
  const duplicates =
    knownRoutes ??
    (await transitionRoutesAtPath(ctx, transition._id, route.fromPath))
  if (
    duplicates.some(
      (candidate) =>
        !ownedRoute ||
        candidate.origin !== "carried" ||
        candidate.pageId !== ownedRoute.pageId
    )
  ) {
    return "drop_duplicate"
  }
  const page = await readTransitionPage(ctx, transition._id, route.pageId)
  return page?.disposition === "target" ? "carry" : "drop_disposition"
}

async function transitionRoutesAtPath(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  fromPath: string
): Promise<Doc<"siteLanguageTransitionRoutes">[]> {
  return ctx.db
    .query("siteLanguageTransitionRoutes")
    .withIndex("by_transitionId_and_fromPath", (q) =>
      q.eq("transitionId", transitionId).eq("fromPath", fromPath)
    )
    .take(2)
}

async function convertPointedCarryRoutes(
  ctx: MutationCtx,
  transition: Transition,
  pointer: NonNullable<Doc<"siteLanguageAuthority">["continuityPointer"]>
): Promise<boolean> {
  const cursor = initialCarryCursor(transition)
  if (cursor.part === "digest") {
    let result: PaginationResult<Doc<"siteLanguageCarryDecisions">>
    try {
      result = await languageCarrySeam.paginate(
        ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transition._id)
          ),
        { numItems: cursor.size, cursor: cursor.page }
      )
    } catch {
      fail("LANGUAGE_TRANSITION_STATE_INVALID")
    }
    if (
      result.page.length > cursor.size ||
      result.pageStatus === "SplitRequired" ||
      crossedReserve(await languageCarrySeam.metrics(ctx))
    ) {
      return halveCarryStep(ctx, transition, cursor)
    }
    let digest = cursor.digest!
    for (const decision of result.page) {
      digest = await extendCarryDecisionDigest(digest, decision)
      if (crossedReserve(await languageCarrySeam.metrics(ctx))) {
        return halveCarryStep(ctx, transition, cursor)
      }
    }
    if (!result.isDone) {
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify({
            ...cursor,
            page: result.continueCursor,
            digest,
          }),
        },
      })
      return true
    }
    const fresh = await ctx.db.get(transition._id)
    if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    const stale =
      fresh.sourcePublicSetVersion !== cursor.startSourcePublicSetVersion ||
      (fresh.carryInputVersion ?? 0) !== cursor.startCarryInputVersion
    await patchTransition(ctx, transition._id, {
      fields: {
        phase: "preparing",
        cursorPhase: stale ? "carry_reconcile" : "carry_coverage",
        cursor: stale
          ? undefined
          : JSON.stringify(initialCoverageCarryCursor(pointer)),
        carryDecisionDigest: digest,
        generation: fresh.generation + 1,
      },
    })
    return true
  }

  let result: PaginationResult<Doc<"siteDefaultLanguageRoutes">>
  try {
    result = await languageCarrySeam.paginate(
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation", (q) =>
          q
            .eq("migrationId", pointer.migrationId)
            .eq("generation", pointer.generation)
        ),
      { numItems: cursor.size, cursor: cursor.page }
    )
  } catch {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  if (
    result.page.length > cursor.size ||
    result.pageStatus === "SplitRequired" ||
    crossedReserve(await languageCarrySeam.metrics(ctx))
  ) {
    return halveCarryStep(ctx, transition, cursor)
  }

  const plans: Array<{
    route: Doc<"siteDefaultLanguageRoutes">
    outcome: CarryOutcome
  }> = []
  for (const route of result.page) {
    if (route.retiredAt !== undefined) continue
    plans.push({
      route,
      outcome: await carryOutcome(ctx, transition, route),
    })
    if (crossedReserve(await languageCarrySeam.metrics(ctx))) {
      return halveCarryStep(ctx, transition, cursor)
    }
  }

  const decidedAt = Date.now()
  for (const { route, outcome } of plans) {
    await ctx.db.insert("siteLanguageCarryDecisions", {
      transitionId: transition._id,
      routeId: route._id,
      fromPath: route.fromPath,
      outcome,
      capturedSourcePublicSetVersion: transition.sourcePublicSetVersion,
      capturedCarryInputVersion: transition.carryInputVersion ?? 0,
      capturedCarryDecisionGeneration: transition.carryDecisionGeneration ?? 0,
      decidedAt,
    })
    if (outcome === "carry") {
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId: transition._id,
        fromPath: route.fromPath,
        pageId: route.pageId,
        origin: "carried",
        createdAt: decidedAt,
      })
    }
  }
  await patchTransition(ctx, transition._id, {
    fields: {
      cursor: JSON.stringify(
        result.isDone
          ? {
              ...cursor,
              part: "digest",
              page: null,
              digest: CARRY_DECISION_EMPTY_DIGEST,
            }
          : { ...cursor, page: result.continueCursor }
      ),
    },
  })
  return true
}

type ReconcileCarryCursor = {
  part: "probe" | "decide" | "digest"
  page: string | null
  size: number
  digest?: string
}

function reconcileCarryCursor(transition: Transition): ReconcileCarryCursor {
  const parsed = parseCursor(transition.cursor)
  const part =
    parsed.part === "decide" || parsed.part === "digest" ? parsed.part : "probe"
  const size =
    typeof parsed.size === "number" &&
    Number.isInteger(parsed.size) &&
    parsed.size >= 1 &&
    parsed.size <= CARRY_BATCH
      ? parsed.size
      : CARRY_BATCH
  if (part === "digest" && typeof parsed.digest !== "string") {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return {
    part,
    page: stringOrNull(parsed.page),
    size,
    ...(part === "digest" ? { digest: parsed.digest as string } : {}),
  }
}

function carryDecisionIsStale(
  decision: Doc<"siteLanguageCarryDecisions">,
  transition: Transition
): boolean {
  if (decision.outcome === "drop_retired") return false
  const captured = [
    decision.capturedSourcePublicSetVersion,
    decision.capturedCarryInputVersion,
    decision.capturedCarryDecisionGeneration,
  ]
  const live = [
    transition.sourcePublicSetVersion,
    transition.carryInputVersion ?? 0,
    transition.carryDecisionGeneration ?? 0,
  ]
  if (captured.some((value, index) => value > live[index]!)) {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  return captured.some((value, index) => value < live[index]!)
}

async function reconcilePointedCarryRoutes(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = reconcileCarryCursor(transition)
  if (cursor.part === "digest") {
    let result: PaginationResult<Doc<"siteLanguageCarryDecisions">>
    try {
      result = await languageCarrySeam.paginate(
        ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transition._id)
          ),
        { numItems: cursor.size, cursor: cursor.page }
      )
    } catch {
      fail("LANGUAGE_TRANSITION_STATE_INVALID")
    }
    if (
      result.page.length > cursor.size ||
      result.pageStatus === "SplitRequired" ||
      crossedReserve(await languageCarrySeam.metrics(ctx))
    ) {
      return halveCarryStep(ctx, transition, cursor)
    }
    let digest = cursor.digest!
    for (const decision of result.page) {
      digest = await extendCarryDecisionDigest(digest, decision)
      if (crossedReserve(await languageCarrySeam.metrics(ctx))) {
        return halveCarryStep(ctx, transition, cursor)
      }
    }
    if (!result.isDone) {
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify({
            ...cursor,
            page: result.continueCursor,
            digest,
          }),
        },
      })
      return true
    }
    const pointer = await requireContinuityPointer(ctx)
    await patchTransition(ctx, transition._id, {
      fields: {
        cursorPhase: "carry_coverage",
        cursor: JSON.stringify(initialCoverageCarryCursor(pointer)),
        carryDecisionDigest: digest,
      },
    })
    return true
  }

  let result: PaginationResult<Doc<"siteLanguageCarryDecisions">>
  try {
    result = await languageCarrySeam.paginate(
      ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transition._id)
        ),
      { numItems: cursor.size, cursor: cursor.page }
    )
  } catch {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  if (
    result.page.length > cursor.size ||
    result.pageStatus === "SplitRequired" ||
    crossedReserve(await languageCarrySeam.metrics(ctx))
  ) {
    return halveCarryStep(ctx, transition, cursor)
  }

  if (cursor.part === "probe") {
    let stale = false
    for (const decision of result.page) {
      stale ||= carryDecisionIsStale(decision, transition)
      if (crossedReserve(await languageCarrySeam.metrics(ctx))) {
        return halveCarryStep(ctx, transition, cursor)
      }
    }
    if (stale) {
      await patchTransition(ctx, transition._id, {
        fields: {
          carryDecisionGeneration:
            (transition.carryDecisionGeneration ?? 0) + 1,
          cursor: JSON.stringify({
            part: "decide",
            page: null,
            size: cursor.size,
          }),
        },
      })
      return true
    }
    if (!result.isDone) {
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify({
            ...cursor,
            page: result.continueCursor,
          }),
        },
      })
      return true
    }
    const pointer = await requireContinuityPointer(ctx)
    await patchTransition(ctx, transition._id, {
      fields: {
        cursorPhase: "carry_coverage",
        cursor: JSON.stringify(initialCoverageCarryCursor(pointer)),
      },
    })
    return true
  }

  const plans: Array<{
    decision: Doc<"siteLanguageCarryDecisions">
    route: Doc<"siteDefaultLanguageRoutes">
    outcome: CarryOutcome
    owned: Doc<"siteLanguageTransitionRoutes"> | null
  }> = []
  for (const decision of result.page) {
    if (decision.outcome === "drop_retired") continue
    const route = await ctx.db.get(decision.routeId)
    if (!route || route.fromPath !== decision.fromPath) {
      fail("LANGUAGE_TRANSITION_STATE_INVALID")
    }
    const pathRoutes = await transitionRoutesAtPath(
      ctx,
      transition._id,
      decision.fromPath
    )
    const outcome =
      route.retiredAt !== undefined
        ? "drop_retired"
        : await carryOutcome(
            ctx,
            transition,
            route,
            {
              pageId: route.pageId,
            },
            pathRoutes
          )
    const exact = pathRoutes.filter(
      (candidate) =>
        candidate.pageId === route.pageId && candidate.origin === "carried"
    )
    if (exact.length > 1) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    plans.push({ decision, route, outcome, owned: exact[0] ?? null })
    if (crossedReserve(await languageCarrySeam.metrics(ctx))) {
      return halveCarryStep(ctx, transition, cursor)
    }
  }

  const decidedAt = Date.now()
  for (const plan of plans) {
    await ctx.db.patch(plan.decision._id, {
      outcome: plan.outcome,
      capturedSourcePublicSetVersion: transition.sourcePublicSetVersion,
      capturedCarryInputVersion: transition.carryInputVersion ?? 0,
      capturedCarryDecisionGeneration: transition.carryDecisionGeneration ?? 0,
      decidedAt,
    })
    if (plan.outcome === "carry" && !plan.owned) {
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId: transition._id,
        fromPath: plan.decision.fromPath,
        pageId: plan.route.pageId,
        origin: "carried",
        createdAt: decidedAt,
      })
    } else if (plan.outcome !== "carry" && plan.owned) {
      await ctx.db.delete(plan.owned._id)
    }
  }
  await patchTransition(ctx, transition._id, {
    fields: {
      cursor: JSON.stringify(
        result.isDone
          ? {
              part: "digest",
              page: null,
              size: cursor.size,
              digest: CARRY_DECISION_EMPTY_DIGEST,
            }
          : { ...cursor, page: result.continueCursor }
      ),
    },
  })
  return true
}

async function coverPointedCarryRoutes(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = coverageCarryCursor(transition)
  let result: PaginationResult<Doc<"siteDefaultLanguageRoutes">>
  try {
    result = await languageCarrySeam.paginate(
      ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q
            .eq("migrationId", cursor.migrationId)
            .eq("generation", cursor.generation)
        ),
      { numItems: cursor.size, cursor: cursor.page }
    )
  } catch {
    fail("LANGUAGE_TRANSITION_STATE_INVALID")
  }
  if (
    result.page.length > cursor.size ||
    result.pageStatus === "SplitRequired" ||
    coverageCrossedReserve(
      await languageCarrySeam.metrics(ctx),
      result.page.length
    )
  ) {
    return halveCarryStep(ctx, transition, cursor)
  }

  let previousFromPath = cursor.previousFromPath
  for (const [index, pointed] of result.page.entries()) {
    if (pointed.fromPath === previousFromPath) {
      fail("LANGUAGE_TRANSITION_STATE_INVALID")
    }
    previousFromPath = pointed.fromPath
    const [decisions, routes] = await Promise.all([
      ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transition._id).eq("routeId", pointed._id)
        )
        .take(2),
      transitionRoutesAtPath(ctx, transition._id, pointed.fromPath),
    ])
    if (decisions.length > 1) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    const decision = decisions[0]
    const exactRoutes = routes.filter(
      (route) => route.pageId === pointed.pageId && route.origin === "carried"
    )
    if (pointed.retiredAt !== undefined) {
      if (
        (decision &&
          (decision.fromPath !== pointed.fromPath ||
            decision.outcome !== "drop_retired")) ||
        routes.length > 1 ||
        exactRoutes.length > 0
      ) {
        fail("LANGUAGE_TRANSITION_STATE_INVALID")
      }
    } else {
      if (
        !decision ||
        decision.fromPath !== pointed.fromPath ||
        decision.outcome === "drop_retired" ||
        decision.capturedSourcePublicSetVersion !==
          transition.sourcePublicSetVersion ||
        decision.capturedCarryInputVersion !==
          (transition.carryInputVersion ?? 0) ||
        decision.capturedCarryDecisionGeneration !==
          (transition.carryDecisionGeneration ?? 0)
      ) {
        fail("LANGUAGE_TRANSITION_STATE_INVALID")
      }
      if (
        decision.outcome === "carry"
          ? routes.length !== 1 || exactRoutes.length !== 1
          : routes.length > 1 || exactRoutes.length !== 0
      ) {
        fail("LANGUAGE_TRANSITION_STATE_INVALID")
      }
    }
    if (
      coverageCrossedReserve(
        await languageCarrySeam.metrics(ctx),
        result.page.length - index - 1
      )
    ) {
      return halveCarryStep(ctx, transition, cursor)
    }
  }

  const { _id, _creationTime, ...storedTransition } = transition
  void _id
  void _creationTime
  const entersValidation = result.isDone && transition.phase === "validating"
  if (entersValidation && !confirmationReceiptsMatch(transition)) {
    fail("LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED")
  }
  await ctx.db.replace(transition._id, {
    ...storedTransition,
    ...(entersValidation
      ? {
          cursorPhase: "validation",
          cursor: initialValidationCursor(transition),
        }
      : result.isDone
        ? { cursorPhase: undefined, cursor: undefined }
        : {
            cursor: JSON.stringify({
              ...cursor,
              page: result.continueCursor,
              previousFromPath,
            }),
          }),
    updatedAt: Date.now(),
  })
  if (!result.isDone) return true
  return entersValidation || transition.mode !== "replace_content"
}

/** A source current path that differs from the target path keeps resolving. */
async function replaceSourceCurrentRoute(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">,
  sourcePath: string | undefined,
  targetPath: string | null
): Promise<void> {
  await deleteRoutes(ctx, transitionId, pageId, "source_current")
  if (sourcePath !== undefined && sourcePath !== targetPath) {
    await upsertContinuityRoute(
      ctx,
      transitionId,
      sourcePath,
      pageId,
      "source_current"
    )
  }
}

// ─── Authority initialization ──────────────────────────────────────────────

/** Version 1 for a single-language install, in the caller's transaction. */
export async function insertInitialSiteLanguageAuthority(
  ctx: MutationCtx,
  locale: string
): Promise<void> {
  const rows = await readAuthorityRows(ctx)
  if (rows.length > 0) fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  await ctx.db.insert("siteLanguageAuthority", {
    key: SITE_LANGUAGE_AUTHORITY_KEY,
    version: 1,
    currentLocale: locale,
    updatedAt: Date.now(),
  })
}

export const initializeSiteLanguageAuthority = mutation({
  args: {},
  returns: v.object({ version: v.number(), currentLocale: v.string() }),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    await requireSnapshotLanguageAuthority(ctx)
    const state = await readSiteLanguageState(ctx)
    if (state.kind === "multi_locale") {
      fail("LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05")
    }
    if (state.kind === "multilingual") fail("MULTILINGUAL_ALREADY_ADOPTED")
    if (state.kind !== "uninitialized") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
    await insertInitialSiteLanguageAuthority(ctx, state.locale)
    return { version: 1, currentLocale: state.locale }
  },
})

// ─── Read models ───────────────────────────────────────────────────────────

const transitionSummaryValidator = v.object({
  _id: v.id("siteLanguageTransitions"),
  mode: modeValidator,
  sourceLocale: v.string(),
  targetLocale: v.string(),
  phase: phaseValidator,
  generation: v.number(),
  shortPath: v.boolean(),
  sourcePublicSetVersion: v.number(),
  preparedSetVersion: v.number(),
  previewConfirmedPreparedSetVersion: v.union(v.number(), v.null()),
  carryDecisionDigest: v.union(v.string(), v.null()),
  previewConfirmedCarryDecisionDigest: v.union(v.string(), v.null()),
  readinessVersion: v.union(v.number(), v.null()),
  pageCount: v.number(),
  targetCount: v.number(),
  withdrawCount: v.number(),
  redirectCount: v.number(),
  unresolvedCount: v.number(),
  blockedCount: v.number(),
  targetDrafts: v.union(
    v.literal("retained"),
    v.literal("discarding"),
    v.literal("discarded")
  ),
})

export const getLanguageState = query({
  args: {},
  returns: v.object({
    kind: v.union(
      v.literal("invalid"),
      v.literal("uninitialized"),
      v.literal("multi_locale"),
      v.literal("current"),
      v.literal("multilingual")
    ),
    version: v.union(v.number(), v.null()),
    currentLocale: v.union(v.string(), v.null()),
    enabledLocales: v.array(v.string()),
    transition: v.union(transitionSummaryValidator, v.null()),
    blockers: v.array(
      v.object({
        pageId: v.id("pages"),
        blockerCode: v.union(v.string(), v.null()),
      })
    ),
  }),
  handler: async (ctx) => {
    await requireInstallationOwner(ctx)
    const state = await readSiteLanguageState(ctx)
    if (state.kind === "invalid") {
      return {
        kind: "invalid" as const,
        version: null,
        currentLocale: null,
        enabledLocales: [],
        transition: null,
        blockers: [],
      }
    }
    const transition = await readOpenTransition(ctx, state)
    const blockers = transition
      ? await ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_status", (q) =>
            q.eq("transitionId", transition._id).eq("status", "blocked")
          )
          .take(10)
      : []
    return {
      kind: state.kind,
      version: state.version,
      currentLocale: state.kind === "multi_locale" ? null : state.locale,
      enabledLocales: [...state.settings.enabledLocales],
      transition: transition
        ? {
            _id: transition._id,
            mode: transition.mode,
            sourceLocale: transition.sourceLocale,
            targetLocale: transition.targetLocale,
            phase: transition.phase,
            generation: transition.generation,
            shortPath: transition.shortPath,
            sourcePublicSetVersion: transition.sourcePublicSetVersion,
            preparedSetVersion: transition.preparedSetVersion,
            previewConfirmedPreparedSetVersion:
              transition.previewConfirmedPreparedSetVersion ?? null,
            carryDecisionDigest: transition.carryDecisionDigest ?? null,
            previewConfirmedCarryDecisionDigest:
              transition.previewConfirmedCarryDecisionDigest ?? null,
            readinessVersion: transition.manifest?.readinessVersion ?? null,
            pageCount: transition.pageCount,
            targetCount: transition.targetCount,
            withdrawCount: transition.withdrawCount,
            redirectCount: transition.redirectCount,
            unresolvedCount: transition.unresolvedCount,
            blockedCount: transition.blockedCount,
            targetDrafts: transition.targetDrafts,
          }
        : null,
      blockers: blockers.map((row) => ({
        pageId: row.pageId,
        blockerCode: row.blockerCode ?? null,
      })),
    }
  },
})

const retainedTargetReportValidator = v.object({
  decisionCurrent: v.boolean(),
  decisionBasis: v.union(
    v.literal("retained_snapshot"),
    v.literal("draft"),
    v.null()
  ),
  reviewDigest: v.string(),
  targetLocale: v.string(),
  selection: v.union(
    v.null(),
    v.object({
      snapshotId: v.id("pagePublishedSnapshots"),
      publishedAt: v.number(),
      title: v.string(),
      path: v.union(v.string(), v.null()),
      seoTitle: v.union(v.string(), v.null()),
      seoDescription: v.union(v.string(), v.null()),
      contentKeys: v.array(v.string()),
    })
  ),
  draftBaseSnapshotId: v.union(v.id("pagePublishedSnapshots"), v.null()),
  workingDraft: v.union(
    v.null(),
    v.object({
      generation: v.number(),
      slug: v.string(),
      title: v.string(),
      contentKeys: v.array(v.string()),
      differsFromSelection: v.union(v.boolean(), v.null()),
    })
  ),
  sharedDraft: v.union(
    v.null(),
    v.object({
      generation: v.number(),
      differsFromSelection: v.union(v.boolean(), v.null()),
    })
  ),
})

const transitionPageReportValidator = v.object({
  pageId: v.id("pages"),
  kind: v.union(
    v.literal("public_route"),
    v.literal("public_non_routable"),
    v.literal("hidden_selection"),
    v.literal("private_draft"),
    v.literal("retained_target")
  ),
  disposition: v.union(
    v.literal("undecided"),
    v.literal("target"),
    v.literal("withdraw"),
    v.literal("redirect")
  ),
  status: v.union(
    v.literal("unready"),
    v.literal("stale"),
    v.literal("ready"),
    v.literal("blocked")
  ),
  blockerCode: v.union(v.string(), v.null()),
  generation: v.number(),
  redirectToPageId: v.union(v.id("pages"), v.null()),
  sourceSlug: v.union(v.string(), v.null()),
  sourcePath: v.union(v.string(), v.null()),
  targetPath: v.union(v.string(), v.null()),
  contentKeys: v.array(v.string()),
  seoJson: v.union(v.string(), v.null()),
  targetRouteConflict: v.boolean(),
  confirmed: v.boolean(),
  // Expected-generation tokens the owner workflow passes back (F09b).
  lifecycleGeneration: v.union(v.number(), v.null()),
  sourceDraftGeneration: v.number(),
  targetDraftGeneration: v.union(v.number(), v.null()),
  hasTargetDraft: v.boolean(),
  sharedDraftGeneration: v.union(v.number(), v.null()),
  retainedTarget: v.union(retainedTargetReportValidator, v.null()),
})

/** Paginated page report: content keys, routes, SEO values and conflicts. */
export const listLanguageTransitionPages = query({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(
      v.union(
        v.literal("unready"),
        v.literal("stale"),
        v.literal("ready"),
        v.literal("blocked")
      )
    ),
  },
  returns: paginationResultValidator(transitionPageReportValidator),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    const transition = await ctx.db.get(args.transitionId)
    if (!transition) fail("LANGUAGE_TRANSITION_NOT_FOUND")
    const status = args.status
    const result = status
      ? await ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_status", (q) =>
            q.eq("transitionId", args.transitionId).eq("status", status)
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_pageId", (q) =>
            q.eq("transitionId", args.transitionId)
          )
          .paginate(args.paginationOpts)
    const page = []
    for (const row of result.page) {
      const frozen = row.source.snapshotId
        ? await readFrozenSnapshotProjection(
            ctx,
            row.source.snapshotId,
            row.pageId,
            transition.sourceLocale
          )
        : null
      let targetRouteConflict = false
      if (row.source.path !== undefined) {
        const sourcePath = row.source.path
        const holders = await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_locale_and_currentPath", (q) =>
            q
              .eq("locale", transition.targetLocale)
              .eq("currentPath", sourcePath)
          )
          .take(2)
        targetRouteConflict = holders.some(
          (state) => state.pageId !== row.pageId
        )
      }
      const seo = frozen?.payload.shared.system.seo
      const [pageStates, sourceState, targetState, targetDraft, sharedRows] =
        await Promise.all([
          ctx.db
            .query("pagePublicationPageStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", row.pageId))
            .take(2),
          oneState(ctx, row.pageId, transition.sourceLocale),
          oneState(ctx, row.pageId, transition.targetLocale),
          oneDraft(ctx, row.pageId, transition.targetLocale),
          ctx.db
            .query("pageSharedDrafts")
            .withIndex("by_pageId", (q) => q.eq("pageId", row.pageId))
            .take(2),
        ])
      const retained = isRetainedTargetReviewEligible(row)
        ? await readRetainedTargetState(ctx, transition, row, owner)
        : null
      const selection = retained?.frozen ?? null
      const selectedLocalized = selection?.payload.localized
      const workingContent = retained?.targetDraft?.content as
        Record<string, unknown> | undefined
      const workingTitle = workingContent?.title
      const selectedSeo = selection?.payload.shared.system.seo as
        { metaTitle?: string; metaDescription?: string } | undefined
      page.push({
        pageId: row.pageId,
        kind: row.kind,
        disposition: row.disposition,
        status: row.status,
        blockerCode: row.blockerCode ?? null,
        generation: row.generation,
        redirectToPageId: row.redirectToPageId ?? null,
        sourceSlug: frozen?.payload.localized.slug ?? null,
        sourcePath: row.source.path ?? null,
        targetPath: row.target.path ?? null,
        contentKeys: Object.keys(
          frozen?.payload.localized.content ?? {}
        ).sort(),
        seoJson: seo === undefined ? null : canonicalJson(seo),
        targetRouteConflict,
        confirmed: row.target.confirmedDraftGeneration !== undefined,
        lifecycleGeneration:
          pageStates.length === 1 ? pageStates[0]!.lifecycleGeneration : null,
        sourceDraftGeneration: sourceState?.draftGeneration ?? 0,
        targetDraftGeneration: targetState?.draftGeneration ?? null,
        hasTargetDraft:
          targetDraft !== null &&
          targetState !== null &&
          targetDraft.generation === targetState.draftGeneration,
        sharedDraftGeneration:
          sharedRows.length === 1 ? sharedRows[0]!.generation : null,
        retainedTarget: retained
          ? {
              decisionCurrent: retainedDecisionCurrent(row, owner, retained),
              decisionBasis: row.target.targetBasis ?? null,
              reviewDigest: retained.digest,
              targetLocale: transition.targetLocale,
              selection: selection
                ? {
                    snapshotId: retained.binding.selectionSnapshotId!,
                    publishedAt: retained.binding.selectionPublishedAt!,
                    title:
                      typeof selection.payload.localized.content.title ===
                      "string"
                        ? selection.payload.localized.content.title
                        : "",
                    path: selection.path,
                    seoTitle: selectedSeo?.metaTitle ?? null,
                    seoDescription: selectedSeo?.metaDescription ?? null,
                    contentKeys: Object.keys(
                      selection.payload.localized.content
                    ).sort(),
                  }
                : null,
              draftBaseSnapshotId: retained.binding.draftBaseSnapshotId ?? null,
              workingDraft: retained.targetDraft
                ? {
                    generation: retained.targetDraft.generation,
                    slug: retained.targetDraft.slug,
                    title: typeof workingTitle === "string" ? workingTitle : "",
                    contentKeys: Object.keys(workingContent ?? {}).sort(),
                    differsFromSelection: selectedLocalized
                      ? canonicalJson({
                          slug: retained.targetDraft.slug,
                          content: workingContent,
                        }) !== canonicalJson(selectedLocalized)
                      : null,
                  }
                : null,
              sharedDraft: retained.sharedDraft
                ? {
                    generation: retained.sharedDraft.generation,
                    differsFromSelection: selection
                      ? retained.sharedDraft.generation !==
                        retained.selectionSnapshot!.sourceSharedDraftGeneration
                      : null,
                  }
                : null,
            }
          : null,
      })
    }
    return { ...result, page }
  },
})

const carryDecisionOutcomeValidator = v.union(
  v.literal("carry"),
  v.literal("drop_locale"),
  v.literal("drop_claimed"),
  v.literal("drop_duplicate"),
  v.literal("drop_disposition"),
  v.literal("drop_retired")
)

const carryDecisionViewValidator = v.object({
  fromPath: v.string(),
  outcome: carryDecisionOutcomeValidator,
})

/** Bounded owner view of the current carry-decision corpus (M05 C3e.1). */
export const listLanguageCarryDecisions = query({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    paginationOpts: paginationOptsValidator,
    filter: v.union(
      v.literal("all"),
      v.literal("carried"),
      v.literal("dropped")
    ),
  },
  returns: paginationResultValidator(carryDecisionViewValidator),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    if (!(await ctx.db.get(args.transitionId))) {
      fail("LANGUAGE_TRANSITION_NOT_FOUND")
    }
    const range = ctx.db
      .query("siteLanguageCarryDecisions")
      .withIndex("by_transitionId_and_fromPath", (q) =>
        q.eq("transitionId", args.transitionId)
      )
    const filtered =
      args.filter === "carried"
        ? range.filter((q) => q.eq(q.field("outcome"), "carry"))
        : args.filter === "dropped"
          ? range.filter((q) => q.neq(q.field("outcome"), "carry"))
          : range
    const result = await filtered.paginate(args.paginationOpts)
    return {
      ...result,
      page: result.page.map(({ fromPath, outcome }) => ({ fromPath, outcome })),
    }
  },
})

/**
 * F09b Shared Draft disclosure (contract proof row 39). Shared Draft values are
 * not localized, so during a replacement a source publication publishes
 * whatever the Shared Draft holds, including target-language text entered for
 * confirmation. Returns null outside an open replacement or for a non-owner so
 * the editor never breaks on it.
 */
export const getSourcePublicationNotice = query({
  args: { pageId: v.id("pages") },
  returns: v.union(
    v.null(),
    v.object({
      sourceLocale: v.string(),
      targetLocale: v.string(),
      sharedChangedSinceSourcePublication: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    try {
      await requireInstallationOwner(ctx)
    } catch {
      return null
    }
    const state = await readSiteLanguageState(ctx)
    const transition = await readOpenTransition(ctx, state)
    if (!transition || transition.mode !== "replace_content") return null
    const sharedRows = await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
      .take(2)
    if (sharedRows.length !== 1) return null
    const sourceState = await oneState(
      ctx,
      args.pageId,
      transition.sourceLocale
    )
    const snapshot = sourceState?.currentSnapshotId
      ? await ctx.db.get(sourceState.currentSnapshotId)
      : null
    return {
      sourceLocale: transition.sourceLocale,
      targetLocale: transition.targetLocale,
      // A Page with no source publication yet exposes its Shared Draft for the
      // first time, so it is treated as changed.
      sharedChangedSinceSourcePublication:
        !snapshot ||
        snapshot.sourceSharedDraftGeneration !== sharedRows[0]!.generation,
    }
  },
})

// ─── Start ─────────────────────────────────────────────────────────────────

const retainedTargetDraftRemedyValidator = v.object({
  transitionId: v.id("siteLanguageTransitions"),
  pageId: v.id("pages"),
  locale: v.string(),
  draftGeneration: v.number(),
  lifecycleGeneration: v.number(),
})

type RetainedTargetDraftRemedy = {
  transitionId: Id<"siteLanguageTransitions">
  pageId: Id<"pages">
  locale: string
  draftGeneration: number
  lifecycleGeneration: number
}

/**
 * Resolve the one F01 retained-target blocker that an owner may deliberately
 * remove after cancellation. Every predicate is re-read in the mutation.
 */
async function readRetainedTargetDraftRemedy(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">
): Promise<RetainedTargetDraftRemedy | null> {
  await requireSnapshotLanguageAuthority(ctx)
  const state = await readSiteLanguageState(ctx)
  if (
    state.kind !== "current" ||
    state.authority.activeTransitionId !== undefined
  ) {
    return null
  }

  const pageStates = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  if (pageStates.length !== 1 || pageStates[0]!.lifecycleState !== "active") {
    return null
  }

  const localeStates = await ctx.db
    .query("pageLocalePublicationStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(513)
  if (localeStates.length > 512) fail("PAGE_LOCALE_PUBLICATION_STATE_INVALID")

  const remedies: RetainedTargetDraftRemedy[] = []
  for (const localeState of localeStates) {
    if (
      localeState.locale === state.locale ||
      localeState.hasCurrentSnapshot ||
      localeState.currentSnapshotId
    ) {
      continue
    }
    const draft = await oneDraft(ctx, pageId, localeState.locale)
    if (!draft || draft.generation !== localeState.draftGeneration) continue

    const transitions = await ctx.db
      .query("siteLanguageTransitions")
      .withIndex("by_sourceLocale_and_targetLocale", (q) =>
        q
          .eq("sourceLocale", state.locale)
          .eq("targetLocale", localeState.locale)
      )
      .order("desc")
      .take(1)
    const transition = transitions[0]
    if (
      !transition ||
      transition.phase !== "cancelled" ||
      transition.targetDrafts !== "retained"
    ) {
      continue
    }
    const row = await readTransitionPage(ctx, transition._id, pageId)
    if (
      !row ||
      row.status !== "blocked" ||
      row.blockerCode !== "TARGET_LOCALE_HAS_RETAINED_CONTENT" ||
      row.target.draftCreatedByTransition
    ) {
      continue
    }
    remedies.push({
      transitionId: transition._id,
      pageId,
      locale: localeState.locale,
      draftGeneration: draft.generation,
      lifecycleGeneration: pageStates[0]!.lifecycleGeneration,
    })
  }
  if (remedies.length > 1) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  return remedies[0] ?? null
}

/** Owner-visible post-cancellation F01 remedy for this Page, if still safe. */
export const getRetainedTargetDraftRemedy = query({
  args: { pageId: v.id("pages") },
  returns: v.union(v.null(), retainedTargetDraftRemedyValidator),
  handler: async (ctx, args) => {
    try {
      await requireInstallationOwner(ctx)
    } catch {
      return null
    }
    return readRetainedTargetDraftRemedy(ctx, args.pageId)
  },
})

/** Delete only the exact private retained target Working Draft the owner saw. */
export const deleteRetainedTargetDraft = mutation({
  args: retainedTargetDraftRemedyValidator.fields,
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const remedy = await readRetainedTargetDraftRemedy(ctx, args.pageId)
    if (!remedy) fail("RETAINED_TARGET_DRAFT_NOT_AVAILABLE")
    if (
      remedy.transitionId !== args.transitionId ||
      remedy.locale !== args.locale ||
      remedy.lifecycleGeneration !== args.lifecycleGeneration
    ) {
      fail("RETAINED_TARGET_DRAFT_STALE")
    }
    if (remedy.draftGeneration !== args.draftGeneration) {
      fail("PAGE_LOCALE_DRAFT_STALE")
    }
    const generation = await deleteCancelledRetainedTargetDraft(ctx, {
      pageId: args.pageId,
      locale: args.locale,
      expectedDraftGeneration: args.draftGeneration,
      expectedLifecycleGeneration: args.lifecycleGeneration,
    })
    return { generation }
  },
})

export const startLanguageTransition = mutation({
  args: {
    mode: modeValidator,
    sourceLocale: v.string(),
    targetLocale: v.string(),
    expectedSettingsUpdatedAt: v.number(),
    expectedAuthorityVersion: v.number(),
    compensatesTransitionId: v.optional(v.id("siteLanguageTransitions")),
  },
  returns: v.id("siteLanguageTransitions"),
  handler: async (ctx, args) => {
    // 1. Owner and snapshot authority.
    const owner = await requireInstallationOwner(ctx)
    await requireSnapshotLanguageAuthority(ctx)
    // 2. Settings and authority.
    const state = await readSiteLanguageState(ctx)
    if (state.kind === "multi_locale") {
      fail("LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05")
    }
    if (state.kind === "multilingual") {
      fail("LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED")
    }
    if (state.kind !== "current" || args.sourceLocale !== state.locale) {
      fail("SITE_LANGUAGE_AUTHORITY_INVALID")
    }
    if (
      state.version !== args.expectedAuthorityVersion ||
      state.settings.updatedAt !== args.expectedSettingsUpdatedAt
    ) {
      fail("LANGUAGE_TRANSITION_STALE")
    }
    if (state.authority.activeTransitionId) {
      fail("LANGUAGE_TRANSITION_ALREADY_OPEN")
    }
    // 3. Target and conflicts.
    if (
      !(SUPPORTED_LOCALES as readonly string[]).includes(args.targetLocale) ||
      args.targetLocale === args.sourceLocale
    ) {
      fail("LANGUAGE_TRANSITION_TARGET_INVALID")
    }
    // 4. Rollback names the last committed transition with reversed locales.
    if (args.mode === "rollback") {
      const compensated = args.compensatesTransitionId
        ? await ctx.db.get(args.compensatesTransitionId)
        : null
      if (
        !compensated ||
        compensated._id !== state.authority.lastCommittedTransitionId ||
        compensated.phase !== "committed" ||
        compensated.sourceLocale !== args.targetLocale ||
        compensated.targetLocale !== args.sourceLocale
      ) {
        fail("LANGUAGE_ROLLBACK_INVALID")
      }
    } else if (args.compensatesTransitionId) {
      fail("LANGUAGE_ROLLBACK_INVALID")
    }
    // 5. Pending or held publication obligations.
    await assertNoLanguageTransitionConflicts(ctx)
    // 6. Short path: no current selection in any locale.
    const anySelection = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
        q.eq("hasCurrentSnapshot", true)
      )
      .take(1)
    // 7. Insert, claim the authority slot, schedule the first step.
    const now = Date.now()
    const transitionId = await ctx.db.insert("siteLanguageTransitions", {
      mode: args.mode,
      sourceLocale: args.sourceLocale,
      targetLocale: args.targetLocale,
      ...(args.compensatesTransitionId
        ? { compensatesTransitionId: args.compensatesTransitionId }
        : {}),
      phase: "enumerating",
      generation: 1,
      startAuthorityVersion: state.version,
      startSettingsUpdatedAt: state.settings.updatedAt,
      shortPath: anySelection.length === 0,
      sourcePublicSetVersion: 0,
      preparedSetVersion: 0,
      cursorPhase: "pages",
      pageCount: 0,
      targetCount: 0,
      withdrawCount: 0,
      redirectCount: 0,
      unresolvedCount: 0,
      blockedCount: 0,
      targetDrafts: "retained",
      attribution: {
        kind: "owner",
        ownerId: owner.ownerId,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: now,
      updatedAt: now,
    })
    await ctx.db.patch(state.authority._id, {
      activeTransitionId: transitionId,
      updatedAt: now,
    })
    await scheduleStep(ctx, transitionId)
    return transitionId
  },
})

// ─── Worker dispatch ───────────────────────────────────────────────────────

/** Runs one bounded batch; returns true while this phase has more work. */
async function runStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  switch (transition.phase) {
    case "enumerating":
      return enumerateStep(ctx, transition)
    case "preparing":
      if (transition.cursorPhase === "carry_reconcile") {
        return reconcilePointedCarryRoutes(ctx, transition)
      }
      if (transition.cursorPhase === "carry_coverage") {
        return coverPointedCarryRoutes(ctx, transition)
      }
      if (transition.mode === "correct_label") {
        return prepareCorrectionStep(ctx, transition)
      }
      return transition.mode === "rollback"
        ? prepareRollbackStep(ctx, transition)
        : false
    case "validating":
      if (transition.cursorPhase === "carry_coverage") {
        return coverPointedCarryRoutes(ctx, transition)
      }
      return validateStep(ctx, transition)
    case "cancelling":
      return cancelStep(ctx, transition)
    default:
      return false
  }
}

export async function runLanguageTransitionStep(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">,
  generation: number
): Promise<null> {
  const transition = await ctx.db.get(transitionId)
  if (
    !transition ||
    transition.generation !== generation ||
    !OPEN_TRANSITION_PHASES.has(transition.phase)
  ) {
    return null
  }
  if (await runStep(ctx, transition)) {
    await scheduleContinuation(ctx, transition)
  }
  return null
}

export const stepLanguageTransition = internalMutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    generation: v.number(),
  },
  returns: v.null(),
  handler: (ctx, args) =>
    runLanguageTransitionStep(ctx, args.transitionId, args.generation),
})

export const continueLanguageTransition = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    expectedGeneration: v.number(),
  },
  returns: v.object({
    phase: phaseValidator,
    generation: v.number(),
    more: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(
      ctx,
      args.transitionId,
      args.expectedGeneration
    )
    const more = await runStep(ctx, transition)
    if (more) await scheduleContinuation(ctx, transition)
    const after = await ctx.db.get(transition._id)
    if (!after) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    return { phase: after.phase, generation: after.generation, more }
  },
})

// ─── Enumerate ─────────────────────────────────────────────────────────────

async function attributeSnapshot(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">,
  snapshotId: Id<"pagePublishedSnapshots">
): Promise<boolean> {
  const rows = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(ATTRIBUTION_LIMIT + 1)
  if (rows.length > ATTRIBUTION_LIMIT) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  for (const row of rows) {
    if (row.transitionId === transition._id) continue
    const earlier = await ctx.db.get(row.transitionId)
    if (!earlier) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    if (earlier.phase !== "committed" && earlier.phase !== "cancelled") continue
    if (
      earlier.targetLocale === transition.targetLocale &&
      row.target.snapshotId === snapshotId
    ) {
      return true
    }
    if (
      earlier.phase === "committed" &&
      earlier.sourceLocale === transition.targetLocale &&
      row.source.snapshotId === snapshotId
    ) {
      return true
    }
  }
  return false
}

async function attributeDraft(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">
): Promise<boolean> {
  const rows = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(ATTRIBUTION_LIMIT + 1)
  if (rows.length > ATTRIBUTION_LIMIT) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  for (const row of rows) {
    if (row.transitionId === transition._id) {
      // A target draft this transition already recorded (widened save).
      if (row.target.draftGeneration !== undefined) return true
      continue
    }
    const earlier = await ctx.db.get(row.transitionId)
    if (!earlier) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    if (
      (earlier.phase === "committed" || earlier.phase === "cancelled") &&
      earlier.targetLocale === transition.targetLocale &&
      row.target.draftCreatedByTransition
    ) {
      return true
    }
  }
  return false
}

async function mergeRetainedTarget(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">,
  artifact: { attributed: boolean; hasSelection: boolean }
): Promise<void> {
  const row = await readTransitionPage(ctx, transition._id, pageId)
  const empty = { publicGeneration: 0, draftGeneration: 0 }
  if (!artifact.attributed) {
    if (row) {
      await blockRow(
        ctx,
        transition._id,
        pageId,
        "TARGET_LOCALE_HAS_RETAINED_CONTENT"
      )
    } else {
      await insertRow(ctx, transition._id, pageId, {
        kind: "retained_target",
        source: empty,
        disposition: "undecided",
        status: "blocked",
        blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
      })
    }
    return
  }
  if (!artifact.hasSelection) {
    // An attributed retained draft is kept, unconfirmed, and never public.
    if (!row) {
      await insertRow(ctx, transition._id, pageId, {
        kind: "retained_target",
        source: empty,
        disposition: "withdraw",
        status: "ready",
      })
    }
    return
  }
  // An attributed retained selection needs `target` or `withdraw` (18).
  if (!row) {
    await insertRow(ctx, transition._id, pageId, {
      kind: "retained_target",
      source: empty,
      disposition: "undecided",
      status: "unready",
    })
  } else if (row.status === "blocked") {
    return
  } else if (row.kind === "private_draft") {
    // A private draft never has a target selection, so a retained one turns
    // the row into a retained target that needs an explicit decision.
    await patchRow(ctx, transition._id, row, {
      kind: "retained_target",
      disposition: "undecided",
      status: "unready",
    })
  } else if (row.status === "ready") {
    await patchRow(ctx, transition._id, row, { status: "unready" })
  }
}

async function enumerateStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursorPhase = transition.cursorPhase ?? "pages"
  const cursor = parseCursor(transition.cursor)

  if (cursorPhase === "pages") {
    const result = await ctx.db
      .query("pagePublicationPageStates")
      .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
    for (const pageState of result.page) {
      if (await readTransitionPage(ctx, transition._id, pageState.pageId)) {
        continue
      }
      const description = await describeSourcePage(
        ctx,
        transition,
        pageState.pageId
      )
      if (description) {
        await insertRow(ctx, transition._id, pageState.pageId, description)
      }
    }
    await patchTransition(ctx, transition._id, {
      fields: result.isDone
        ? { cursorPhase: "target_artifacts", cursor: undefined }
        : { cursor: JSON.stringify({ cursor: result.continueCursor }) },
    })
    return true
  }

  if (cursorPhase === "target_artifacts") {
    if (cursor.part !== "drafts") {
      const result = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_locale_and_currentPath", (q) =>
          q.eq("locale", transition.targetLocale)
        )
        .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
      for (const state of result.page) {
        const snapshots = [
          ...new Set(
            [state.currentSnapshotId, state.draftBaseSnapshotId].filter(
              (id): id is Id<"pagePublishedSnapshots"> => id !== undefined
            )
          ),
        ]
        // State rows with no selection, draft or draft base are clocks.
        if (snapshots.length === 0) continue
        let attributed = true
        for (const snapshotId of snapshots) {
          if (
            !(await attributeSnapshot(
              ctx,
              transition,
              state.pageId,
              snapshotId
            ))
          ) {
            attributed = false
          }
        }
        await mergeRetainedTarget(ctx, transition, state.pageId, {
          attributed,
          hasSelection: state.hasCurrentSnapshot,
        })
      }
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify(
            result.isDone
              ? { part: "drafts", cursor: null }
              : { part: "states", cursor: result.continueCursor }
          ),
        },
      })
      return true
    }
    const result = await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_locale_and_slug", (q) =>
        q.eq("locale", transition.targetLocale)
      )
      .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
    for (const draft of result.page) {
      const attributed = await attributeDraft(ctx, transition, draft.pageId)
      await mergeRetainedTarget(ctx, transition, draft.pageId, {
        attributed,
        hasSelection: false,
      })
    }
    await patchTransition(ctx, transition._id, {
      fields: result.isDone
        ? { cursorPhase: "source_routes", cursor: undefined }
        : {
            cursor: JSON.stringify({
              part: "drafts",
              cursor: result.continueCursor,
            }),
          },
    })
    return true
  }

  if (cursorPhase === "source_routes") {
    const result = await ctx.db
      .query("siteLanguageTransitionPages")
      .withIndex("by_transitionId_and_pageId", (q) =>
        q.eq("transitionId", transition._id)
      )
      .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
    for (const row of result.page) {
      if (row.disposition !== "target") continue
      const routes = await ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", row.pageId).eq("locale", transition.sourceLocale)
        )
        .take(ROUTE_LIMIT + 1)
      if (routes.length > ROUTE_LIMIT) fail("LANGUAGE_TRANSITION_ROUTE_LIMIT")
      for (const route of routes) {
        if (route.releasedAt !== undefined) continue
        await upsertContinuityRoute(
          ctx,
          transition._id,
          route.fromPath,
          row.pageId,
          "source_historical"
        )
      }
    }
    await patchTransition(ctx, transition._id, {
      fields: result.isDone
        ? { cursorPhase: "carried_routes", cursor: undefined }
        : { cursor: JSON.stringify({ cursor: result.continueCursor }) },
    })
    return true
  }

  // carried_routes
  const authorityRows = await readAuthorityRows(ctx)
  if (authorityRows.length !== 1) fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  const pointer = authorityRows[0]!.continuityPointer
  if (pointer) {
    return convertPointedCarryRoutes(ctx, transition, pointer)
  }
  const lastCommitted = authorityRows[0]!.lastCommittedTransitionId
  if (lastCommitted) {
    const result = await ctx.db
      .query("siteLanguageTransitionRoutes")
      .withIndex("by_transitionId_and_fromPath", (q) =>
        q.eq("transitionId", lastCommitted)
      )
      .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
    for (const route of result.page) {
      const row = await readTransitionPage(ctx, transition._id, route.pageId)
      if (row?.disposition === "target") {
        await upsertContinuityRoute(
          ctx,
          transition._id,
          route.fromPath,
          route.pageId,
          "carried"
        )
      }
    }
    if (!result.isDone) {
      await patchTransition(ctx, transition._id, {
        fields: { cursor: JSON.stringify({ cursor: result.continueCursor }) },
      })
      return true
    }
  }
  if (transition.mode === "correct_label") {
    await copyLiveMenuTextToTarget(ctx, transition)
  }
  const fresh = await ctx.db.get(transition._id)
  if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  await patchTransition(ctx, transition._id, {
    fields: {
      phase: "preparing",
      cursorPhase: undefined,
      cursor: undefined,
      generation: fresh.generation + 1,
    },
  })
  return transition.mode !== "replace_content"
}

// ─── Menus (direct) ────────────────────────────────────────────────────────

/** Copies a source-locale text value to the target key on every text bag. */
function copyLocaleText(
  value: unknown,
  source: string,
  target: string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => copyLocaleText(item, source, target))
  }
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const entries = Object.entries(record)
  if (
    Object.prototype.hasOwnProperty.call(record, source) &&
    entries.every(([, item]) => typeof item === "string")
  ) {
    return { ...record, [target]: record[source] }
  }
  return Object.fromEntries(
    entries.map(([key, item]) => [key, copyLocaleText(item, source, target)])
  )
}

/**
 * Correction only: copy every source-locale text value to the target key on
 * the same node, leaving structure and other locales unchanged. The existing
 * non-default write rule proves nothing else moved.
 */
export async function copyMenuTextToTarget(
  ctx: MutationCtx,
  transition: Transition,
  menu: Doc<"menus">
): Promise<void> {
  if (transition.mode !== "correct_label")
    fail("LANGUAGE_TRANSITION_MODE_INVALID")
  if (menu.deletedAt !== undefined) return
  const next = copyLocaleText(
    menu.nav,
    transition.sourceLocale,
    transition.targetLocale
  ) as NavItem[]
  validateCanonicalWrite(
    menu.nav,
    next,
    transition.targetLocale,
    transition.sourceLocale
  )
  if (canonicalJson(next) === canonicalJson(menu.nav)) return
  await ctx.db.patch(menu._id, { nav: next, updatedAt: Date.now() })
  const saved = await ctx.db.get(menu._id)
  if (!saved) fail("LANGUAGE_TRANSITION_MENU_INVALID")
  await refreshMenuReferences(ctx, saved)
  await patchTransition(ctx, transition._id, {
    prepared: true,
    carryInput: true,
  })
}

async function liveMenus(ctx: QueryCtx | MutationCtx): Promise<Doc<"menus">[]> {
  const menus = await ctx.db
    .query("menus")
    .withIndex("by_slug")
    .take(MENU_LIMIT + 1)
  if (menus.length > MENU_LIMIT) fail("LANGUAGE_TRANSITION_MENU_LIMIT")
  return menus.filter((menu) => menu.deletedAt === undefined)
}

async function copyLiveMenuTextToTarget(
  ctx: MutationCtx,
  transition: Transition
): Promise<void> {
  for (const menu of await liveMenus(ctx)) {
    await copyMenuTextToTarget(ctx, transition, menu)
  }
}

/** Validation step 5, from stored nav (the public reader hides the target). */
async function assertMenusReady(
  ctx: MutationCtx,
  transition: Transition
): Promise<void> {
  for (const menu of await liveMenus(ctx)) {
    try {
      validateCanonicalMenuForLocale(menu.nav, transition.targetLocale)
    } catch {
      fail("LANGUAGE_TRANSITION_MENU_TEXT_MISSING")
    }
    for (const target of walkCanonicalMenuTargets(menu.nav)) {
      const row = await readTransitionPage(
        ctx,
        transition._id,
        target.targetId as Id<"pages">
      )
      if (row?.disposition !== "target") {
        fail("LANGUAGE_TRANSITION_MENU_TARGET_UNAVAILABLE")
      }
    }
  }
}

// ─── Prepare ───────────────────────────────────────────────────────────────

type PrepareOutcome = "prepared" | "waiting" | "skipped"

async function sourceWorkingContent(
  ctx: MutationCtx,
  transition: Transition,
  pageId: Id<"pages">
): Promise<{ slug: string; content: Record<string, unknown> } | null> {
  const draft = await oneDraft(ctx, pageId, transition.sourceLocale)
  if (draft) {
    return {
      slug: draft.slug,
      content: draft.content as unknown as Record<string, unknown>,
    }
  }
  const state = await oneState(ctx, pageId, transition.sourceLocale)
  if (!state?.draftBaseSnapshotId) return null
  const base = await readFrozenSnapshotProjection(
    ctx,
    state.draftBaseSnapshotId,
    pageId,
    transition.sourceLocale
  )
  return base
    ? {
        slug: base.payload.localized.slug,
        content: base.payload.localized.content,
      }
    : null
}

/** Correction preparation for one row; mode-specific inputs per the contract. */
async function prepareCorrectionRow(
  ctx: MutationCtx,
  transition: Transition,
  row: TransitionPage
): Promise<PrepareOutcome> {
  const targetState = await oneState(ctx, row.pageId, transition.targetLocale)
  if (row.kind === "private_draft") {
    if (targetState?.hasCurrentSnapshot) return "skipped"
    let target = row.target
    if (!(await oneDraft(ctx, row.pageId, transition.targetLocale))) {
      const source = await sourceWorkingContent(ctx, transition, row.pageId)
      if (!source) return "skipped"
      const created = await createTransitionTargetDraft(ctx, {
        transitionId: transition._id,
        pageId: row.pageId,
        ...source,
      })
      target = {
        ...row.target,
        draftGeneration: created.draftGeneration,
        draftCreatedByTransition: true,
      }
    }
    await patchRow(
      ctx,
      transition._id,
      row,
      { target, status: "ready", blockerCode: undefined },
      { prepared: true, carryInput: true }
    )
    return "prepared"
  }
  if (row.disposition === "withdraw") {
    // A retained target selection needs the owner's explicit withdrawal.
    if (targetState?.hasCurrentSnapshot) return "skipped"
    await patchRow(ctx, transition._id, row, {
      status: "ready",
      blockerCode: undefined,
    })
    return "prepared"
  }
  if (row.disposition !== "target") return "skipped"
  const description = await describeSourcePage(ctx, transition, row.pageId)
  if (
    !description?.source.snapshotId ||
    description.kind === "hidden_selection"
  ) {
    return "skipped"
  }
  const frozen = await readFrozenSnapshotProjection(
    ctx,
    description.source.snapshotId,
    row.pageId,
    transition.sourceLocale
  )
  if (!frozen) fail("PUBLISHED_SNAPSHOT_INTEGRITY_INVALID")
  // Ancestry stays strict: a child waits for its parent's target selection.
  const parentId = frozen.payload.shared.system.parentId
  if (
    typeof parentId === "string" &&
    !(await readHiddenTargetSnapshotProjection(
      ctx,
      parentId as Id<"pages">,
      transition.targetLocale
    ))
  ) {
    return "waiting"
  }
  const pageState = await onePageState(ctx, row.pageId)
  const selection = await publishPreparedTargetLocale(ctx, {
    arm: "frozen",
    transitionId: transition._id,
    pageId: row.pageId,
    sourceSnapshotId: description.source.snapshotId,
    sourcePublicGeneration: description.source.publicGeneration,
    expectedTargetPublicGeneration: targetState?.publicGeneration ?? 0,
    expectedLifecycleGeneration: pageState.lifecycleGeneration,
    expectedReleaseGeneration: targetState?.releaseGeneration ?? 0,
  })
  // Only after the target selection exists, and only when a source Working
  // Draft exists, the target gets a transition-created Working Draft.
  let draftGeneration = row.target.draftGeneration
  let draftCreatedByTransition = row.target.draftCreatedByTransition
  const sourceDraft = await oneDraft(ctx, row.pageId, transition.sourceLocale)
  if (
    sourceDraft &&
    !(await oneDraft(ctx, row.pageId, transition.targetLocale))
  ) {
    const created = await createTransitionTargetDraft(ctx, {
      transitionId: transition._id,
      pageId: row.pageId,
      slug: sourceDraft.slug,
      content: sourceDraft.content as unknown as Record<string, unknown>,
    })
    draftGeneration = created.draftGeneration
    draftCreatedByTransition = true
  }
  await replaceSourceCurrentRoute(
    ctx,
    transition._id,
    row.pageId,
    description.source.path,
    selection.path
  )
  await patchRow(
    ctx,
    transition._id,
    row,
    {
      source: description.source,
      target: {
        ...targetWithoutSelection(row.target),
        snapshotId: selection.snapshotId,
        publicGeneration: selection.publicGeneration,
        ...(selection.path !== null ? { path: selection.path } : {}),
        ...(draftGeneration !== undefined ? { draftGeneration } : {}),
        draftCreatedByTransition,
        selectionProvenance: "transition_prepared",
      },
      status: "ready",
      blockerCode: undefined,
    },
    { prepared: true, carryInput: true }
  )
  return "prepared"
}

/** Nested worker unit: a throw rolls back only this page's preparation. */
export const prepareTransitionPage = internalMutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    generation: v.number(),
    pageId: v.id("pages"),
  },
  returns: v.union(
    v.literal("prepared"),
    v.literal("waiting"),
    v.literal("skipped")
  ),
  handler: async (ctx, args): Promise<PrepareOutcome> => {
    const transition = await ctx.db.get(args.transitionId)
    if (
      !transition ||
      transition.generation !== args.generation ||
      transition.phase !== "preparing"
    ) {
      return "skipped"
    }
    const row = await readTransitionPage(ctx, transition._id, args.pageId)
    if (!row || (row.status !== "unready" && row.status !== "stale")) {
      return "skipped"
    }
    return prepareCorrectionRow(ctx, transition, row)
  },
})

async function isWaitingOnAncestry(
  ctx: MutationCtx,
  transition: Transition,
  row: TransitionPage
): Promise<boolean> {
  if (row.disposition !== "target" || !row.source.snapshotId) return false
  const frozen = await readFrozenSnapshotProjection(
    ctx,
    row.source.snapshotId,
    row.pageId,
    transition.sourceLocale
  )
  const parentId = frozen?.payload.shared.system.parentId
  return (
    typeof parentId === "string" &&
    !(await readHiddenTargetSnapshotProjection(
      ctx,
      parentId as Id<"pages">,
      transition.targetLocale
    ))
  )
}

async function prepareCorrectionStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = parseCursor(transition.cursor)
  const status = cursor.status === "stale" ? "stale" : "unready"
  let progress = cursor.progress === true
  if (cursor.status === "block") {
    // A full pass made no progress: only a missing parent can be left.
    let blocked = 0
    for (const pending of ["unready", "stale"] as const) {
      const rows = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_status", (q) =>
          q.eq("transitionId", transition._id).eq("status", pending)
        )
        .take(PAGE_BATCH)
      for (const row of rows) {
        if (await isWaitingOnAncestry(ctx, transition, row)) {
          await blockRow(ctx, transition._id, row.pageId, "ANCESTRY_UNRESOLVED")
          blocked += 1
        }
      }
    }
    await patchTransition(ctx, transition._id, {
      fields: { cursor: undefined },
    })
    return false
  }
  const result = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_transitionId_and_status", (q) =>
      q.eq("transitionId", transition._id).eq("status", status)
    )
    .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
  for (const row of result.page) {
    try {
      const outcome: PrepareOutcome = await ctx.runMutation(
        internal.cms.language.prepareTransitionPage,
        {
          transitionId: transition._id,
          generation: transition.generation,
          pageId: row.pageId,
        }
      )
      if (outcome === "prepared") progress = true
    } catch (error) {
      await blockRow(ctx, transition._id, row.pageId, errorCode(error))
    }
  }
  if (!result.isDone) {
    await patchTransition(ctx, transition._id, {
      fields: {
        cursor: JSON.stringify({
          status,
          cursor: result.continueCursor,
          progress,
        }),
      },
    })
    return true
  }
  if (status === "unready") {
    await patchTransition(ctx, transition._id, {
      fields: {
        cursor: JSON.stringify({ status: "stale", cursor: null, progress }),
      },
    })
    return true
  }
  const fresh = await ctx.db.get(transition._id)
  if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  if (fresh.unresolvedCount === 0) {
    await patchTransition(ctx, transition._id, {
      fields: { cursor: undefined },
    })
    return false
  }
  await patchTransition(ctx, transition._id, {
    fields: {
      cursor: JSON.stringify(
        progress
          ? { status: "unready", cursor: null, progress: false }
          : { status: "block" }
      ),
    },
  })
  return true
}

/**
 * A rollback reuses an already-selected snapshot; it never creates another
 * candidate or snapshot. Only the exact source selection recorded by the
 * compensated commit is selected implicitly. Any other retained selection
 * remains undecided until the owner gives it an explicit disposition.
 */
async function prepareRollbackRow(
  ctx: MutationCtx,
  transition: Transition,
  row: TransitionPage
): Promise<PrepareOutcome> {
  if (!transition.compensatesTransitionId) {
    fail("LANGUAGE_ROLLBACK_INVALID")
  }
  const targetState = await oneState(ctx, row.pageId, transition.targetLocale)
  let disposition = row.disposition
  if (disposition === "undecided" && targetState?.currentSnapshotId) {
    const compensated = await readTransitionPage(
      ctx,
      transition.compensatesTransitionId,
      row.pageId
    )
    if (
      compensated?.source.snapshotId === targetState.currentSnapshotId &&
      compensated.source.publicGeneration === targetState.publicGeneration
    ) {
      disposition = "target"
    }
  }
  if (disposition !== "target") return "skipped"
  if (
    !targetState?.hasCurrentSnapshot ||
    !targetState.currentSnapshotId ||
    !(await readHiddenTargetSnapshotProjection(
      ctx,
      row.pageId,
      transition.targetLocale
    ))
  ) {
    return "skipped"
  }
  await patchRow(
    ctx,
    transition._id,
    row,
    {
      disposition,
      target: {
        ...targetWithoutSelection(row.target),
        snapshotId: targetState.currentSnapshotId,
        publicGeneration: targetState.publicGeneration,
        ...(targetState.currentPath !== undefined
          ? { path: targetState.currentPath }
          : {}),
      },
      status: "ready",
      blockerCode: undefined,
    },
    { prepared: true, carryInput: true }
  )
  return "prepared"
}

/** One bounded pass over rollback rows; unresolved choices remain owner work. */
async function prepareRollbackStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = parseCursor(transition.cursor)
  const status = cursor.status === "stale" ? "stale" : "unready"
  const result = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_transitionId_and_status", (q) =>
      q.eq("transitionId", transition._id).eq("status", status)
    )
    .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
  for (const row of result.page) {
    await prepareRollbackRow(ctx, transition, row)
  }
  if (!result.isDone) {
    await patchTransition(ctx, transition._id, {
      fields: {
        cursor: JSON.stringify({
          status,
          cursor: result.continueCursor,
        }),
      },
    })
    return true
  }
  if (status === "unready") {
    await patchTransition(ctx, transition._id, {
      fields: { cursor: JSON.stringify({ status: "stale", cursor: null }) },
    })
    return true
  }
  await patchTransition(ctx, transition._id, { fields: { cursor: undefined } })
  return false
}

/** Owner preparation of one page (replacement: `draft` arm; correction: `frozen`). */
export const prepareTargetPage = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    pageId: v.id("pages"),
    expectedPageGeneration: v.number(),
  },
  returns: v.object({
    snapshotId: v.union(v.id("pagePublishedSnapshots"), v.null()),
    generation: v.number(),
  }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    let transition = await requireActiveTransition(ctx, args.transitionId)
    requirePhase(transition, ["preparing", "validating", "ready"])
    if (transition.phase !== "preparing") {
      transition = await patchTransition(ctx, transition._id, { reopen: true })
    }
    const row = await requireRow(
      ctx,
      transition,
      args.pageId,
      args.expectedPageGeneration
    )
    if (row.status === "blocked")
      fail(row.blockerCode ?? "LANGUAGE_TRANSITION_PAGE_BLOCKED")
    if (transition.mode === "correct_label") {
      const outcome = await prepareCorrectionRow(ctx, transition, row)
      if (outcome === "waiting") fail("PAGE_ANCESTRY_UNAVAILABLE")
      if (outcome === "skipped") fail("LANGUAGE_TRANSITION_PAGE_NOT_PREPARABLE")
    } else if (transition.mode === "replace_content") {
      if (row.disposition !== "target") fail("LANGUAGE_DISPOSITION_INVALID")
      if (row.target.targetBasis && !row.target.retainedReview) {
        fail("RETAINED_TARGET_REVIEW_STALE")
      }
      if (row.target.retainedReview) {
        const retained = await readRetainedTargetState(
          ctx,
          transition,
          row,
          owner
        )
        if (!retainedDecisionCurrent(row, owner, retained)) {
          fail("RETAINED_TARGET_REVIEW_STALE")
        }
        await assertNoLanguageTransitionConflicts(ctx)
        if (row.target.targetBasis === "retained_snapshot") {
          if (
            !retained.frozen ||
            row.target.selectionProvenance !== "retained_preexisting" ||
            row.target.snapshotId !== retained.binding.selectionSnapshotId ||
            row.target.publicGeneration !==
              retained.binding.targetPublicGeneration
          ) {
            fail("RETAINED_TARGET_DECISION_INVALID")
          }
          const parentId = retained.frozen.payload.shared.system.parentId
          if (typeof parentId === "string") {
            const parent = await readTransitionPage(
              ctx,
              transition._id,
              parentId as Id<"pages">
            )
            if (
              parent?.disposition !== "target" ||
              !(await readHiddenTargetSnapshotProjection(
                ctx,
                parentId as Id<"pages">,
                transition.targetLocale
              ))
            ) {
              fail("PAGE_ANCESTRY_UNAVAILABLE")
            }
          }
          await replaceSourceCurrentRoute(
            ctx,
            transition._id,
            row.pageId,
            row.source.path,
            retained.frozen.path
          )
          await patchRow(
            ctx,
            transition._id,
            row,
            {
              target: {
                ...row.target,
                snapshotId: retained.binding.selectionSnapshotId!,
                publicGeneration: retained.binding.targetPublicGeneration,
                ...(retained.frozen.path !== null
                  ? { path: retained.frozen.path }
                  : { path: undefined }),
              },
              status: "ready",
              blockerCode: undefined,
            },
            { prepared: true, carryInput: true }
          )
          const after = await readTransitionPage(
            ctx,
            transition._id,
            args.pageId
          )
          if (!after) fail("LANGUAGE_TRANSITION_STATE_INVALID")
          return {
            snapshotId: retained.binding.selectionSnapshotId!,
            generation: after.generation,
          }
        }
        if (retained.frozen && !isTransitionPreparedSelection(row, retained)) {
          fail("RETAINED_TARGET_SELECTION_MUST_BE_WITHDRAWN")
        }
        if (!retained.targetDraft) {
          fail("RETAINED_TARGET_DECISION_INVALID")
        }
      }
      const [targetState, targetDraft, sharedRows, pageState] =
        await Promise.all([
          oneState(ctx, args.pageId, transition.targetLocale),
          oneDraft(ctx, args.pageId, transition.targetLocale),
          ctx.db
            .query("pageSharedDrafts")
            .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
            .take(2),
          onePageState(ctx, args.pageId),
        ])
      if (sharedRows.length !== 1) fail("PAGE_SHARED_DRAFT_INVALID")
      if (
        !targetState ||
        !targetDraft ||
        row.target.confirmedDraftGeneration === undefined ||
        row.target.confirmedDraftGeneration !== targetState.draftGeneration ||
        row.target.confirmedSharedDraftGeneration !== sharedRows[0]!.generation
      ) {
        fail("TARGET_CONFIRMATION_STALE")
      }
      const selection = await publishPreparedTargetLocale(ctx, {
        arm: "draft",
        transitionId: transition._id,
        pageId: args.pageId,
        expectedTargetDraftGeneration: targetState.draftGeneration,
        expectedSharedDraftGeneration: sharedRows[0]!.generation,
        expectedTargetPublicGeneration: targetState.publicGeneration,
        expectedLifecycleGeneration: pageState.lifecycleGeneration,
        expectedReleaseGeneration: targetState.releaseGeneration,
        preserveDraft:
          row.target.targetBasis === "draft" &&
          row.target.retainedReview !== undefined,
      })
      const reboundTarget = targetWithoutSelection(row.target)
      if (row.target.targetBasis === "draft" && row.target.retainedReview) {
        const rebound = await readRetainedTargetState(
          ctx,
          transition,
          row,
          owner
        )
        if (!rebound) fail("RETAINED_TARGET_DECISION_INVALID")
        reboundTarget.retainedReview = {
          ...row.target.retainedReview,
          digest: rebound.digest,
          binding: rebound.binding,
        }
      }
      await replaceSourceCurrentRoute(
        ctx,
        transition._id,
        args.pageId,
        row.source.path,
        selection.path
      )
      await patchRow(
        ctx,
        transition._id,
        row,
        {
          target: {
            ...reboundTarget,
            snapshotId: selection.snapshotId,
            publicGeneration: selection.publicGeneration,
            ...(selection.path !== null ? { path: selection.path } : {}),
            selectionProvenance: "transition_prepared",
          },
          status: "ready",
          blockerCode: undefined,
        },
        { prepared: true, carryInput: true }
      )
    } else {
      fail("LANGUAGE_TRANSITION_MODE_INVALID")
    }
    const after = await readTransitionPage(ctx, transition._id, args.pageId)
    if (!after) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    return {
      snapshotId: after.target.snapshotId ?? null,
      generation: after.generation,
    }
  },
})

const retainedTargetReviewClaimValidator = v.object({
  digest: v.string(),
  basis: v.union(v.literal("retained_snapshot"), v.literal("draft")),
})

export const setPageDisposition = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    pageId: v.id("pages"),
    disposition: v.union(
      v.literal("target"),
      v.literal("withdraw"),
      v.literal("redirect")
    ),
    redirectToPageId: v.optional(v.id("pages")),
    expectedPageGeneration: v.number(),
    retainedTargetReview: v.optional(retainedTargetReviewClaimValidator),
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    const owner = await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(ctx, args.transitionId)
    requirePhase(transition, ["preparing", "validating", "ready"])
    const row = await requireRow(
      ctx,
      transition,
      args.pageId,
      args.expectedPageGeneration
    )
    const retainedClaim = args.retainedTargetReview
    let retained: RetainedTargetState | null = null
    let acceptedTarget = row.target
    if (retainedClaim) {
      if (
        transition.mode !== "replace_content" ||
        !isRetainedTargetReviewEligible(row)
      ) {
        fail("RETAINED_TARGET_DECISION_INVALID")
      }
      retained = await readRetainedTargetState(ctx, transition, row, owner)
      if (!retained) fail("RETAINED_TARGET_DECISION_INVALID")
      if (retained.digest !== retainedClaim.digest) {
        fail("RETAINED_TARGET_REVIEW_STALE")
      }
      await assertNoLanguageTransitionConflicts(ctx)
      const hasSelection = retained.frozen !== null
      const hasTransitionPreparedSelection = isTransitionPreparedSelection(
        row,
        retained
      )
      if (
        retainedClaim.basis === "retained_snapshot" &&
        hasTransitionPreparedSelection
      ) {
        fail("RETAINED_TARGET_DECISION_INVALID")
      }
      if (retainedClaim.basis === "retained_snapshot" && !hasSelection) {
        fail("RETAINED_TARGET_DECISION_INVALID")
      }
      if (retainedClaim.basis === "draft") {
        if (hasSelection && !hasTransitionPreparedSelection) {
          fail("RETAINED_TARGET_SELECTION_MUST_BE_WITHDRAWN")
        }
        if (
          args.disposition === "target" &&
          (!retained.targetDraft || !row.source.snapshotId)
        ) {
          fail("RETAINED_TARGET_DECISION_INVALID")
        }
        if (
          args.disposition !== "target" &&
          !retained.targetDraft &&
          !retained.binding.draftBaseSnapshotId
        ) {
          fail("RETAINED_TARGET_DECISION_INVALID")
        }
      }
      if (args.disposition === "redirect" && !hasSelection) {
        fail("RETAINED_TARGET_DECISION_INVALID")
      }
      // Reviewing a retained row does not adopt a draft this transition
      // created; its creation provenance still governs cancellation.
      const retainedDraftAttribution =
        retained.targetDraft && !row.target.draftCreatedByTransition
          ? {
              ownerId: owner.ownerId,
              tokenIdentifier: owner.tokenIdentifier,
              locale: transition.targetLocale,
              draftId: retained.targetDraft._id,
              draftGeneration: retained.targetDraft.generation,
              ...(retained.binding.draftBaseSnapshotId
                ? {
                    draftBaseSnapshotId: retained.binding.draftBaseSnapshotId,
                  }
                : {}),
            }
          : undefined
      const receipt = {
        digest: retained.digest,
        ownerId: owner.ownerId,
        tokenIdentifier: owner.tokenIdentifier,
        reviewedAt: Date.now(),
        reviewedTransitionGeneration: transition.generation,
        reviewedPageGeneration: row.generation,
        acceptedPageGeneration: row.generation + 1,
        basis: retainedClaim.basis,
        binding: retained.binding,
      }
      if (args.disposition === "target") {
        acceptedTarget =
          retainedClaim.basis === "retained_snapshot"
            ? {
                ...row.target,
                snapshotId: retained.binding.selectionSnapshotId!,
                publicGeneration: retained.binding.targetPublicGeneration,
                ...(retained.binding.selectionPath !== undefined
                  ? { path: retained.binding.selectionPath }
                  : {}),
                draftGeneration:
                  retained.targetDraft?.generation ??
                  retained.binding.targetDraftGeneration,
                draftCreatedByTransition: row.target.draftCreatedByTransition,
                targetBasis: retainedClaim.basis,
                selectionProvenance: "retained_preexisting" as const,
                retainedSelection: {
                  snapshotId: retained.binding.selectionSnapshotId!,
                  publicGeneration: retained.binding.targetPublicGeneration,
                },
                retainedDraftAttribution,
                retainedReview: receipt,
              }
            : {
                ...(hasTransitionPreparedSelection
                  ? row.target
                  : targetWithoutSelection(row.target)),
                draftGeneration: retained.targetDraft!.generation,
                draftCreatedByTransition: row.target.draftCreatedByTransition,
                targetBasis: retainedClaim.basis,
                retainedDraftAttribution,
                retainedReview: receipt,
              }
      } else {
        acceptedTarget = targetWithoutSelection({
          ...row.target,
          draftGeneration:
            retained.targetDraft?.generation ??
            retained.binding.targetDraftGeneration,
          draftCreatedByTransition: row.target.draftCreatedByTransition,
          targetBasis: retainedClaim.basis,
          retainedDraftAttribution,
          retainedReview: receipt,
        })
      }
    } else if (row.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT") {
      fail("TARGET_LOCALE_HAS_RETAINED_CONTENT")
    }
    if (row.kind === "hidden_selection" && args.disposition !== "withdraw") {
      fail("LANGUAGE_DISPOSITION_INVALID")
    }
    if (args.disposition === "redirect") {
      if (!args.redirectToPageId || args.redirectToPageId === args.pageId) {
        fail("LANGUAGE_DISPOSITION_INVALID")
      }
      await requireRow(ctx, transition, args.redirectToPageId)
    } else if (args.redirectToPageId) {
      fail("LANGUAGE_DISPOSITION_INVALID")
    }
    // Leaving `target` withdraws the prepared or retained target selection,
    // bound to its exact snapshot.
    if (args.disposition !== "target") {
      const targetState = await oneState(
        ctx,
        args.pageId,
        transition.targetLocale
      )
      if (targetState?.hasCurrentSnapshot && targetState.currentSnapshotId) {
        await withdrawPreparedTargetLocale(ctx, {
          transitionId: transition._id,
          pageId: args.pageId,
          expectedSnapshotId: targetState.currentSnapshotId,
          expectedPublicGeneration: targetState.publicGeneration,
        })
      }
      await deleteRoutes(ctx, transition._id, args.pageId, "source_current")
    }
    if (row.disposition === "redirect" && row.source.path !== undefined) {
      const sourcePath = row.source.path
      const routes = await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transition._id).eq("fromPath", sourcePath)
        )
        .take(ROUTE_LIMIT + 1)
      for (const route of routes) {
        if (route.origin === "redirect_disposition")
          await ctx.db.delete(route._id)
      }
    }
    if (
      args.disposition === "redirect" &&
      args.redirectToPageId &&
      row.source.path !== undefined
    ) {
      await upsertContinuityRoute(
        ctx,
        transition._id,
        row.source.path,
        args.redirectToPageId,
        "redirect_disposition"
      )
    }
    const leaving = args.disposition !== "target"
    await ctx.db.patch(row._id, {
      disposition: args.disposition,
      redirectToPageId: args.redirectToPageId,
      target: leaving ? targetWithoutSelection(acceptedTarget) : acceptedTarget,
      status: leaving ? "ready" : "unready",
      blockerCode: undefined,
      generation: row.generation + 1,
      updatedAt: Date.now(),
    })
    await patchTransition(ctx, transition._id, {
      before: row,
      after: {
        disposition: args.disposition,
        status: leaving ? "ready" : "unready",
      },
      prepared: true,
      carryInput: true,
      reopen: true,
    })
    return { generation: row.generation + 1 }
  },
})

export const copySourceToTargetDraft = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    pageId: v.id("pages"),
    expectedSourceDraftGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
  },
  returns: v.object({ draftGeneration: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(ctx, args.transitionId)
    if (transition.mode !== "replace_content") {
      fail("LANGUAGE_TRANSITION_MODE_INVALID")
    }
    requirePhase(transition, [
      "enumerating",
      "preparing",
      "validating",
      "ready",
    ])
    const [pageState, sourceState] = await Promise.all([
      onePageState(ctx, args.pageId),
      oneState(ctx, args.pageId, transition.sourceLocale),
    ])
    if (
      pageState.lifecycleState !== "active" ||
      pageState.lifecycleGeneration !== args.expectedLifecycleGeneration ||
      (sourceState?.draftGeneration ?? 0) !== args.expectedSourceDraftGeneration
    ) {
      fail("LANGUAGE_TRANSITION_SOURCE_STALE")
    }
    const source = await sourceWorkingContent(ctx, transition, args.pageId)
    if (!source) fail("LANGUAGE_TRANSITION_SOURCE_MISSING")
    const created = await createTransitionTargetDraft(ctx, {
      transitionId: transition._id,
      pageId: args.pageId,
      ...source,
    })
    // Copied text starts unconfirmed: confirmation binds exact generations.
    await recordTargetDraftWrite(ctx, transition, args.pageId, {
      draftGeneration: created.draftGeneration,
      created: true,
    })
    return created
  },
})

export const confirmTargetContent = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    pageId: v.id("pages"),
    expectedTargetDraftGeneration: v.number(),
    expectedSharedDraftGeneration: v.number(),
    expectedPageGeneration: v.number(),
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(ctx, args.transitionId)
    if (transition.mode !== "replace_content") {
      fail("LANGUAGE_TRANSITION_MODE_INVALID")
    }
    requirePhase(transition, ["preparing", "validating", "ready"])
    const row = await requireRow(
      ctx,
      transition,
      args.pageId,
      args.expectedPageGeneration
    )
    const [targetState, targetDraft, sharedRows] = await Promise.all([
      oneState(ctx, args.pageId, transition.targetLocale),
      oneDraft(ctx, args.pageId, transition.targetLocale),
      ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", args.pageId))
        .take(2),
    ])
    if (
      !targetState ||
      !targetDraft ||
      targetDraft.generation !== targetState.draftGeneration ||
      targetState.draftGeneration !== args.expectedTargetDraftGeneration ||
      sharedRows.length !== 1 ||
      sharedRows[0]!.generation !== args.expectedSharedDraftGeneration
    ) {
      fail("TARGET_CONFIRMATION_STALE")
    }
    await patchRow(
      ctx,
      transition._id,
      row,
      {
        target: {
          ...row.target,
          confirmedDraftGeneration: args.expectedTargetDraftGeneration,
          confirmedSharedDraftGeneration: args.expectedSharedDraftGeneration,
        },
      },
      { prepared: true, carryInput: true, reopen: true }
    )
    return { generation: row.generation + 1 }
  },
})

export const confirmTransitionPreview = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    expectedPreparedSetVersion: v.number(),
    expectedCarryDecisionDigest: v.optional(v.string()),
  },
  returns: v.object({ preparedSetVersion: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(ctx, args.transitionId)
    requirePhase(transition, ["preparing", "validating", "ready"])
    if (transition.preparedSetVersion !== args.expectedPreparedSetVersion) {
      fail("LANGUAGE_TRANSITION_STALE")
    }
    if (transition.carryDecisionDigest !== args.expectedCarryDecisionDigest) {
      fail("LANGUAGE_TRANSITION_STALE")
    }
    const next = transition.preparedSetVersion + 1
    await patchTransition(ctx, transition._id, {
      prepared: true,
      reopen: true,
      fields: {
        previewConfirmedPreparedSetVersion: next,
        previewConfirmedCarryDecisionDigest: transition.carryDecisionDigest,
      },
    })
    return { preparedSetVersion: next }
  },
})

// ─── Validate ──────────────────────────────────────────────────────────────

function initialValidationCursor(transition: Transition): string {
  return JSON.stringify({
    part: "pages",
    cursor: null,
    digest: "",
    routeCount: 0,
    hasPublicRoute: false,
    homeReady: false,
    failures: 0,
    lastFromPath: null,
    startSource: transition.sourcePublicSetVersion,
    startPrepared: transition.preparedSetVersion,
  })
}

function confirmationReceiptsMatch(transition: Transition): boolean {
  return (
    transition.previewConfirmedPreparedSetVersion ===
      transition.preparedSetVersion &&
    transition.previewConfirmedCarryDecisionDigest ===
      transition.carryDecisionDigest
  )
}

function requireConfirmationReceipts(transition: Transition): void {
  if (!confirmationReceiptsMatch(transition)) {
    fail("LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED")
  }
}

export const validateLanguageTransition = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    expectedGeneration: v.number(),
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(
      ctx,
      args.transitionId,
      args.expectedGeneration
    )
    requirePhase(transition, ["preparing", "ready"])
    if (transition.unresolvedCount > 0 || transition.blockedCount > 0) {
      fail("LANGUAGE_TRANSITION_NOT_RESOLVED")
    }
    requireConfirmationReceipts(transition)
    await assertMenusReady(ctx, transition)
    const pointer = await readContinuityPointer(ctx)
    if (pointer && transition.carryDecisionDigest === undefined) {
      fail("LANGUAGE_TRANSITION_STATE_INVALID")
    }
    const updated = await patchTransition(ctx, transition._id, {
      fields: {
        phase: "validating",
        cursorPhase: pointer ? "carry_coverage" : "validation",
        cursor: pointer
          ? JSON.stringify(initialCoverageCarryCursor(pointer))
          : initialValidationCursor(transition),
        generation: transition.generation + 1,
      },
    })
    await scheduleStep(ctx, transition._id)
    return { generation: updated.generation }
  },
})

async function rollingDigest(
  previous: string,
  value: unknown
): Promise<string> {
  return digestLocalePublicationCandidate(
    `${previous}\n${canonicalJson(value)}`
  )
}

/** Validation checks 1–3 for one transition page; returns a blocker or null. */
async function validatePage(
  ctx: MutationCtx,
  transition: Transition,
  row: TransitionPage
): Promise<string | null> {
  if (row.status !== "ready") return "LANGUAGE_TRANSITION_PAGE_NOT_READY"
  const targetState = await oneState(ctx, row.pageId, transition.targetLocale)
  if (row.disposition !== "target") {
    if (row.disposition === "undecided") return "LANGUAGE_DISPOSITION_UNDECIDED"
    if (targetState?.hasCurrentSnapshot) return "TARGET_SELECTION_NOT_WITHDRAWN"
    if (row.disposition === "redirect") {
      const destination = row.redirectToPageId
        ? await readTransitionPage(ctx, transition._id, row.redirectToPageId)
        : null
      if (destination?.disposition !== "target") {
        return "REDIRECT_DESTINATION_UNAVAILABLE"
      }
    }
    return null
  }
  if (
    !targetState?.hasCurrentSnapshot ||
    targetState.currentSnapshotId !== row.target.snapshotId ||
    targetState.publicGeneration !== row.target.publicGeneration
  ) {
    return "TARGET_SELECTION_MISMATCH"
  }
  const projection = await readHiddenTargetSnapshotProjection(
    ctx,
    row.pageId,
    transition.targetLocale
  )
  if (!projection) return "TARGET_SNAPSHOT_INVALID"
  if (projection.payload.route.kind === "routable") {
    for (const item of projection.payload.route.ancestry) {
      const ancestor = await readTransitionPage(
        ctx,
        transition._id,
        item.pageId as Id<"pages">
      )
      if (ancestor?.disposition !== "target")
        return "TARGET_ANCESTRY_NOT_TARGET"
    }
  }
  const references = await ctx.db
    .query("pagePublicationDocumentReferences")
    .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
      q
        .eq("pageId", row.pageId)
        .eq("locale", transition.targetLocale)
        .eq("sourceKind", "current_public")
    )
    .take(REFERENCE_LIMIT + 1)
  if (references.length > REFERENCE_LIMIT) return "PUBLICATION_REFERENCE_LIMIT"
  for (const reference of references) {
    if (reference.referenceKind === "ancestry") continue
    const destination = await readTransitionPage(
      ctx,
      transition._id,
      reference.targetId
    )
    if (
      destination?.disposition !== "target" ||
      !(await readHiddenTargetSnapshotProjection(
        ctx,
        reference.targetId,
        transition.targetLocale
      ))
    ) {
      return "TARGET_REFERENCE_UNAVAILABLE"
    }
  }
  return null
}

async function returnToPreparing(
  ctx: MutationCtx,
  transitionId: Id<"siteLanguageTransitions">
) {
  const fresh = await ctx.db.get(transitionId)
  if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  await patchTransition(ctx, transitionId, {
    fields: {
      phase: "preparing",
      cursorPhase: undefined,
      cursor: undefined,
      generation: fresh.generation + 1,
    },
  })
}

async function validateStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = parseCursor(transition.cursor)
  const save = async (fields: Record<string, unknown>) =>
    patchTransition(ctx, transition._id, {
      fields: { cursor: JSON.stringify({ ...cursor, ...fields }) },
    })
  let failures = typeof cursor.failures === "number" ? cursor.failures : 0
  let digest = typeof cursor.digest === "string" ? cursor.digest : ""

  if (transition.cursorPhase === "validation") {
    const settingsRows = await ctx.db.query("siteSettings").take(2)
    if (settingsRows.length !== 1) fail("SITE_LANGUAGE_AUTHORITY_INVALID")
    const settings = settingsRows[0]!
    if (cursor.part === "pages") {
      const result = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transition._id)
        )
        .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
      let hasPublicRoute = cursor.hasPublicRoute === true
      let homeReady = cursor.homeReady === true
      for (const row of result.page) {
        const code = await validatePage(ctx, transition, row)
        if (code) {
          await blockRow(ctx, transition._id, row.pageId, code)
          failures += 1
        }
        if (
          row.kind === "public_route" ||
          (row.disposition === "target" && row.target.path !== undefined)
        ) {
          hasPublicRoute = true
        }
        if (
          settings.homePageId === row.pageId &&
          row.disposition === "target" &&
          row.target.path === "/"
        ) {
          homeReady = true
        }
        digest = await rollingDigest(digest, {
          pageId: row.pageId,
          disposition: row.disposition,
          redirectToPageId: row.redirectToPageId ?? null,
          target: row.target.snapshotId ?? null,
          path: row.target.path ?? null,
        })
      }
      await save(
        result.isDone
          ? {
              part: "routes",
              cursor: null,
              failures,
              digest,
              hasPublicRoute,
              homeReady,
            }
          : {
              cursor: result.continueCursor,
              failures,
              digest,
              hasPublicRoute,
              homeReady,
            }
      )
      return true
    }
    if (cursor.part === "routes") {
      const result = await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transition._id)
        )
        .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
      let lastFromPath = stringOrNull(cursor.lastFromPath)
      let routeCount =
        typeof cursor.routeCount === "number" ? cursor.routeCount : 0
      for (const route of result.page) {
        const destination = await readTransitionPage(
          ctx,
          transition._id,
          route.pageId
        )
        if (route.fromPath === lastFromPath) {
          failures += 1
          await blockRow(
            ctx,
            transition._id,
            route.pageId,
            "CONTINUITY_ROUTE_DUPLICATE"
          )
        } else if (destination?.disposition !== "target") {
          failures += 1
          await blockRow(
            ctx,
            transition._id,
            route.pageId,
            "CONTINUITY_DESTINATION_UNAVAILABLE"
          )
        }
        lastFromPath = route.fromPath
        routeCount += 1
        digest = await rollingDigest(digest, {
          fromPath: route.fromPath,
          pageId: route.pageId,
          origin: route.origin,
        })
      }
      await save(
        result.isDone
          ? {
              part: "home",
              cursor: null,
              failures,
              digest,
              lastFromPath,
              routeCount,
            }
          : {
              cursor: result.continueCursor,
              failures,
              digest,
              lastFromPath,
              routeCount,
            }
      )
      return true
    }
    // Check 4: with any active public route, the home is `target` at "/".
    if (cursor.hasPublicRoute === true && cursor.homeReady !== true) {
      failures += 1
      if (settings.homePageId) {
        await blockRow(
          ctx,
          transition._id,
          settings.homePageId,
          "HOME_NOT_TARGET"
        )
      }
    }
    if (failures > 0) {
      await returnToPreparing(ctx, transition._id)
      return false
    }
    await patchTransition(ctx, transition._id, {
      fields: {
        cursorPhase: "coverage",
        cursor: JSON.stringify({
          ...cursor,
          part: "source",
          cursor: null,
          failures,
        }),
      },
    })
    return true
  }

  // Coverage: invariant 8 in both directions.
  const part = cursor.part === "target" ? "target" : "source"
  if (part === "source" || cursor.part === "target") {
    const locale =
      part === "source" ? transition.sourceLocale : transition.targetLocale
    const result = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
        q.eq("hasCurrentSnapshot", true).eq("locale", locale)
      )
      .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
    for (const state of result.page) {
      const row = await readTransitionPage(ctx, transition._id, state.pageId)
      if (part === "source") {
        if (!row) {
          const description = await describeSourcePage(
            ctx,
            transition,
            state.pageId
          )
          if (description) {
            await insertRow(ctx, transition._id, state.pageId, description)
          }
          failures += 1
        } else if (row.status !== "ready") {
          failures += 1
        }
      } else if (
        row?.disposition !== "target" ||
        row.target.snapshotId !== state.currentSnapshotId
      ) {
        failures += 1
        if (row) {
          await blockRow(
            ctx,
            transition._id,
            state.pageId,
            "TARGET_SELECTION_NOT_RECORDED"
          )
        } else {
          await insertRow(ctx, transition._id, state.pageId, {
            kind: "retained_target",
            source: { publicGeneration: 0, draftGeneration: 0 },
            disposition: "undecided",
            status: "blocked",
            blockerCode: "TARGET_SELECTION_NOT_RECORDED",
          })
        }
      }
    }
    if (!result.isDone) {
      await save({ cursor: result.continueCursor, failures })
      return true
    }
    if (part === "source") {
      await save({ part: "target", cursor: null, failures })
      return true
    }
  }

  const fresh = await ctx.db.get(transition._id)
  if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
  if (failures > 0 || fresh.unresolvedCount > 0 || fresh.blockedCount > 0) {
    await returnToPreparing(ctx, transition._id)
    return false
  }
  if (!confirmationReceiptsMatch(fresh)) {
    await returnToPreparing(ctx, transition._id)
    return false
  }
  if (
    fresh.sourcePublicSetVersion !== cursor.startSource ||
    fresh.preparedSetVersion !== cursor.startPrepared
  ) {
    await patchTransition(ctx, transition._id, {
      fields: {
        cursorPhase: "validation",
        cursor: initialValidationCursor(fresh),
      },
    })
    return true
  }
  const [settingsRows, authorityRows] = await Promise.all([
    ctx.db.query("siteSettings").take(2),
    readAuthorityRows(ctx),
  ])
  if (settingsRows.length !== 1 || authorityRows.length !== 1) {
    fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  }
  const now = Date.now()
  await patchTransition(ctx, transition._id, {
    fields: {
      phase: "ready",
      cursorPhase: undefined,
      cursor: undefined,
      generation: fresh.generation + 1,
      manifest: {
        readinessVersion: (fresh.manifest?.readinessVersion ?? 0) + 1,
        sourcePublicSetVersion: fresh.sourcePublicSetVersion,
        preparedSetVersion: fresh.preparedSetVersion,
        authorityVersion: authorityRows[0]!.version,
        settingsUpdatedAt: settingsRows[0]!.updatedAt,
        pageCount: fresh.pageCount,
        routeCount:
          typeof cursor.routeCount === "number" ? cursor.routeCount : 0,
        digest,
        validatedAt: now,
      },
    },
  })
  return false
}

// ─── Activate ──────────────────────────────────────────────────────────────

export type ActivateLanguageTransitionInput = {
  transitionId: Id<"siteLanguageTransitions">
  expectedGeneration: number
  expectedAuthorityVersion: number
  expectedSettingsUpdatedAt: number
  expectedReadinessVersion: number
}

export type ActivateLanguageTransitionResult = {
  transitionId: Id<"siteLanguageTransitions">
  version: number
  currentLocale: string
}

/**
 * Whether activating this transition swaps the per-language site
 * descriptions: a `correct_label` always does, `replace_content` never does,
 * and a `rollback` does exactly when the transition it compensates recorded
 * `descriptionSwapped`. The flag is read, never inferred from the compensated
 * mode, so a rollback of a rollback stays consistent. This is the one extra
 * point read of step 2.
 */
async function transitionSwapsDescriptions(
  ctx: MutationCtx,
  transition: Doc<"siteLanguageTransitions">
): Promise<boolean> {
  if (transition.mode === "correct_label") return true
  if (transition.mode === "replace_content") return false
  const compensated = transition.compensatesTransitionId
    ? await ctx.db.get(transition.compensatesTransitionId)
    : null
  if (!compensated) fail("LANGUAGE_ROLLBACK_INVALID")
  return compensated.descriptionSwapped === true
}

/**
 * F09c bounded compare-and-set. Readiness already scanned the public set, so
 * this transaction touches only settings, authority, the transition, fixed
 * conflict probes and (for the short path) a take-one selection probe.
 */
export async function activateLanguageTransitionInTransaction(
  ctx: MutationCtx,
  args: ActivateLanguageTransitionInput
): Promise<ActivateLanguageTransitionResult> {
  await requireSnapshotLanguageAuthority(ctx)
  const state = await readSiteLanguageState(ctx)
  if (state.kind === "multilingual") {
    fail("LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED")
  }
  if (state.kind !== "current") fail("SITE_LANGUAGE_AUTHORITY_INVALID")
  const transition = await ctx.db.get(args.transitionId)
  if (
    !transition ||
    state.authority.activeTransitionId !== transition._id ||
    transition.sourceLocale !== state.locale
  ) {
    fail("LANGUAGE_TRANSITION_NOT_OPEN")
  }
  if (
    transition.generation !== args.expectedGeneration ||
    state.version !== args.expectedAuthorityVersion ||
    state.settings.updatedAt !== args.expectedSettingsUpdatedAt
  ) {
    fail("LANGUAGE_TRANSITION_STALE")
  }
  if (transition.phase !== "ready") {
    fail("LANGUAGE_TRANSITION_PHASE_INVALID")
  }
  const manifest = transition.manifest
  // C3e.3b reaches `ready` only after covering the live pointer and rechecking
  // both receipts. Authorized carry writers reopen the transition, so this
  // constant-time pairing check preserves that proof without rescanning rows.
  const hasCarryPointer = state.authority.continuityPointer !== undefined
  const hasCarryCorpus = transition.carryDecisionDigest !== undefined
  if (
    !manifest ||
    manifest.readinessVersion !== args.expectedReadinessVersion ||
    manifest.authorityVersion !== state.version ||
    manifest.settingsUpdatedAt !== state.settings.updatedAt ||
    manifest.sourcePublicSetVersion !== transition.sourcePublicSetVersion ||
    manifest.preparedSetVersion !== transition.preparedSetVersion ||
    manifest.pageCount !== transition.pageCount ||
    hasCarryPointer !== hasCarryCorpus ||
    !confirmationReceiptsMatch(transition) ||
    transition.unresolvedCount !== 0 ||
    transition.blockedCount !== 0 ||
    transition.targetCount +
      transition.withdrawCount +
      transition.redirectCount !==
      transition.pageCount
  ) {
    fail("LANGUAGE_TRANSITION_STALE")
  }
  await assertNoLanguageTransitionConflicts(ctx)
  if (transition.shortPath) {
    const anySelection = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
        q.eq("hasCurrentSnapshot", true)
      )
      .take(1)
    if (anySelection.length > 0) fail("LANGUAGE_TRANSITION_STALE")
  }

  // M05 A5 / F09 2026-11-01: the site description is stored per language. The
  // legacy single value goes under the source language first; the source and
  // target values are then swapped exactly when this transition relabels.
  const relabel = await transitionSwapsDescriptions(ctx, transition)

  const now = Date.now()
  const version = state.version + 1
  await ctx.db.patch(state.settings._id, {
    defaultLocale: transition.targetLocale,
    enabledLocales: [transition.targetLocale],
    ...transitionSiteDescriptionFields(
      state.settings,
      transition.sourceLocale,
      transition.targetLocale,
      relabel
    ),
    updatedAt: now,
  })
  await ctx.db.patch(state.authority._id, {
    version,
    currentLocale: transition.targetLocale,
    activeTransitionId: undefined,
    lastCommittedTransitionId: transition._id,
    continuityPointer: undefined,
    updatedAt: now,
  })
  await ctx.db.patch(transition._id, {
    ...(relabel ? { descriptionSwapped: true as const } : {}),
    phase: "committed",
    generation: transition.generation + 1,
    committedAt: now,
    committedAuthorityVersion: version,
    updatedAt: now,
  })
  await ctx.scheduler.runAfter(0, internal.cms.revalidate.revalidateSettings, {
    languageVersion: version,
    currentLocale: transition.targetLocale,
  })
  return {
    transitionId: transition._id,
    version,
    currentLocale: transition.targetLocale,
  }
}

export const activateLanguageTransition = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    expectedGeneration: v.number(),
    expectedAuthorityVersion: v.number(),
    expectedSettingsUpdatedAt: v.number(),
    expectedReadinessVersion: v.number(),
  },
  returns: v.object({
    transitionId: v.id("siteLanguageTransitions"),
    version: v.number(),
    currentLocale: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    return activateLanguageTransitionInTransaction(ctx, args)
  },
})

// ─── Cancel ────────────────────────────────────────────────────────────────

export const cancelLanguageTransition = mutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    expectedGeneration: v.number(),
    discardTargetDrafts: v.boolean(),
  },
  returns: v.object({ generation: v.number() }),
  handler: async (ctx, args) => {
    await requireInstallationOwner(ctx)
    const transition = await requireActiveTransition(
      ctx,
      args.transitionId,
      args.expectedGeneration
    )
    if (!PREPARABLE_TRANSITION_PHASES.has(transition.phase)) {
      fail("LANGUAGE_TRANSITION_PHASE_INVALID")
    }
    const updated = await patchTransition(ctx, transition._id, {
      fields: {
        phase: "cancelling",
        cursorPhase: "cancel",
        cursor: JSON.stringify({
          part: "pages",
          cursor: null,
          failed: false,
          passes: 0,
        }),
        generation: transition.generation + 1,
        targetDrafts: args.discardTargetDrafts ? "discarding" : "retained",
      },
    })
    await scheduleStep(ctx, transition._id)
    return { generation: updated.generation }
  },
})

export const withdrawTransitionTarget = internalMutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    generation: v.number(),
    pageId: v.id("pages"),
    snapshotId: v.id("pagePublishedSnapshots"),
    publicGeneration: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const transition = await ctx.db.get(args.transitionId)
    if (!transition || transition.generation !== args.generation) return null
    await withdrawPreparedTargetLocale(ctx, {
      transitionId: args.transitionId,
      pageId: args.pageId,
      expectedSnapshotId: args.snapshotId,
      expectedPublicGeneration: args.publicGeneration,
    })
    return null
  },
})

export const discardTransitionTargetDraft = internalMutation({
  args: {
    transitionId: v.id("siteLanguageTransitions"),
    generation: v.number(),
    pageId: v.id("pages"),
    preserved: v.optional(
      v.object({
        snapshotId: v.id("pagePublishedSnapshots"),
        publicGeneration: v.number(),
      })
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const transition = await ctx.db.get(args.transitionId)
    if (!transition || transition.generation !== args.generation) return null
    await deleteTransitionTargetDraft(ctx, {
      transitionId: args.transitionId,
      pageId: args.pageId,
      preserved: args.preserved,
    })
    return null
  },
})

async function cancelStep(
  ctx: MutationCtx,
  transition: Transition
): Promise<boolean> {
  const cursor = cancellationCursor(transition)
  if (cursor.part === "carry_decisions") {
    const result = await languageCarrySeam.paginate(
      ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transition._id)
        ),
      {
        numItems: CARRY_BATCH,
        cursor: stringOrNull(cursor.cursor),
      }
    )
    for (const decision of result.page) {
      await ctx.db.delete(decision._id)
    }
    if (!result.isDone) {
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify({
            part: "carry_decisions",
            cursor: result.continueCursor,
          }),
        },
      })
      return true
    }
    const now = Date.now()
    const fresh = await ctx.db.get(transition._id)
    if (!fresh) fail("LANGUAGE_TRANSITION_STATE_INVALID")
    await patchTransition(ctx, transition._id, {
      fields: {
        phase: "cancelled",
        cancelledAt: now,
        cursorPhase: undefined,
        cursor: undefined,
        generation: fresh.generation + 1,
        targetDrafts:
          fresh.targetDrafts === "discarding" ? "discarded" : "retained",
      },
    })
    const authorityRows = await readAuthorityRows(ctx)
    if (
      authorityRows.length !== 1 ||
      authorityRows[0]!.activeTransitionId !== transition._id
    ) {
      fail("SITE_LANGUAGE_AUTHORITY_INVALID")
    }
    await ctx.db.patch(authorityRows[0]!._id, {
      activeTransitionId: undefined,
      updatedAt: now,
    })
    return false
  }
  let failed = cursor.failed
  const passes = cursor.passes
  const result = await ctx.db
    .query("siteLanguageTransitionPages")
    .withIndex("by_transitionId_and_pageId", (q) =>
      q.eq("transitionId", transition._id)
    )
    .paginate({ numItems: PAGE_BATCH, cursor: stringOrNull(cursor.cursor) })
  for (const row of result.page) {
    const targetState = await oneState(ctx, row.pageId, transition.targetLocale)
    if (row.target.selectionProvenance === "retained_preexisting") {
      // The adopted-selection binding outlives a target Working Draft save or
      // discard, which clear the review receipt. Rows written before the
      // binding existed fall back to the receipt.
      const receipt = row.target.retainedReview
      const adopted =
        row.target.retainedSelection ??
        (receipt?.basis === "retained_snapshot" &&
        receipt.binding.selectionSnapshotId
          ? {
              snapshotId: receipt.binding.selectionSnapshotId,
              publicGeneration: receipt.binding.targetPublicGeneration,
            }
          : undefined)
      if (
        !adopted ||
        row.target.snapshotId !== adopted.snapshotId ||
        row.target.publicGeneration !== adopted.publicGeneration ||
        !targetState?.hasCurrentSnapshot ||
        targetState.currentSnapshotId !== adopted.snapshotId ||
        targetState.publicGeneration !== adopted.publicGeneration ||
        (receipt &&
          (receipt.basis !== "retained_snapshot" ||
            receipt.binding.selectionSnapshotId !== adopted.snapshotId ||
            receipt.binding.targetPublicGeneration !==
              adopted.publicGeneration))
      ) {
        // Never repair, overwrite or withdraw a successor selection under an
        // obsolete adopted selection. Hold cancellation for recovery.
        failed = true
        continue
      }
      // This exact selection pre-dated the transition and was only adopted;
      // cancellation therefore preserves it in both draft-discard modes. Only
      // a draft the transition itself created is deleted, and only in discard
      // mode.
      if (
        transition.targetDrafts === "discarding" &&
        row.target.draftCreatedByTransition
      ) {
        try {
          await ctx.runMutation(
            internal.cms.language.discardTransitionTargetDraft,
            {
              transitionId: transition._id,
              generation: transition.generation,
              pageId: row.pageId,
              preserved: adopted,
            }
          )
        } catch {
          failed = true
        }
      }
      continue
    }
    if (
      row.target.snapshotId &&
      targetState?.hasCurrentSnapshot &&
      targetState.currentSnapshotId === row.target.snapshotId
    ) {
      try {
        await ctx.runMutation(internal.cms.language.withdrawTransitionTarget, {
          transitionId: transition._id,
          generation: transition.generation,
          pageId: row.pageId,
          snapshotId: row.target.snapshotId,
          publicGeneration: targetState.publicGeneration,
        })
      } catch {
        // A child still selected under this parent: retry on the next pass.
        failed = true
        continue
      }
    }
    if (
      transition.targetDrafts === "discarding" &&
      row.target.draftCreatedByTransition
    ) {
      try {
        await ctx.runMutation(
          internal.cms.language.discardTransitionTargetDraft,
          {
            transitionId: transition._id,
            generation: transition.generation,
            pageId: row.pageId,
          }
        )
      } catch {
        failed = true
      }
    }
  }
  if (!result.isDone) {
    await patchTransition(ctx, transition._id, {
      fields: {
        cursor: JSON.stringify({
          part: "pages",
          cursor: result.continueCursor,
          failed,
          passes,
        }),
      },
    })
    return true
  }
  if (failed) {
    if (passes + 1 >= CANCEL_PASS_LIMIT) {
      // Holds `cancelling` so no new transition can start; owner resumes.
      await patchTransition(ctx, transition._id, {
        fields: {
          cursor: JSON.stringify({
            part: "pages",
            cursor: null,
            failed: false,
            passes: 0,
          }),
        },
      })
      return false
    }
    await patchTransition(ctx, transition._id, {
      fields: {
        cursor: JSON.stringify({
          part: "pages",
          cursor: null,
          failed: false,
          passes: passes + 1,
        }),
      },
    })
    return true
  }
  await patchTransition(ctx, transition._id, {
    fields: {
      cursor: JSON.stringify({ part: "carry_decisions", cursor: null }),
    },
  })
  return true
}
