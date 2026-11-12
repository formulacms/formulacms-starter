import {
  Migrations,
  type MigrationFunctionReference,
} from "@convex-dev/migrations"
import { getFunctionName } from "convex/server"
import { components, internal } from "../../_generated/api"
import schema from "../../schema"
import { requireOperationAccess } from "../access/policy"
import { ConvexError, v } from "convex/values"
import type { DataModel, Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import {
  mutation as rawMutation,
  internalMutation as rawInternalMutation,
} from "../../_generated/server"
import {
  customCtx,
  customMutation,
} from "convex-helpers/server/customFunctions"
import { contentTypeDefs } from "../contentTypes"
import {
  extractSliceOccurrenceIdentities,
  type SliceOccurrenceExtraction,
} from "../slices/occurrencePresentation"
import { hasSliceBody } from "../pages/sliceBodyContent"
import { reconstructLocalePublicationCandidate } from "./localeCandidate"
import { readSlicePresentationCatalog } from "../slices/presentations"

/**
 * Publishing pipeline: per-page staging (ADR-0041 — Deploy 1 Widen).
 *
 * A `pageStaging` row is the in-flight edit set for a page. The row is
 * absent when nothing is in flight and is created lazily on first
 * autosave. Uniqueness is a get-then-insert inside one mutation (Convex
 * OCC is serializable — no unique constraint needed). The row is
 * promoted to live by `pages.publish` and deleted at that point (or by
 * explicit discard, hard delete, or the abandoned-staging TTL sweep).
 *
 * Shared staging persistence and retained occurrence accounting live here.
 * Internal occurrence maintenance workers and the owner start entry ship
 * with this existing module; legacy migration runners remain source-only.
 */

/**
 * ADR-0041 §9 — abandoned-staging TTL. Measured against `updatedAt`
 * (not `_creationTime`), so a long-lived actively-edited draft does not
 * expire. v1 hardcoded constant per ADR §9; promotable to a Setting on
 * demand.
 */
export const STAGING_ABANDONED_TTL_MS = 60 * 24 * 60 * 60 * 1000

/**
 * Batch size for the abandoned-staging sweep. Same discipline as
 * `SCHEDULED_TRANSITION_BATCH_SIZE`: one candidate per tick, self-
 * rescheduling when more work is queued. Bounds the transaction budget
 * (each delete may cascade to the media-references + doc-references seams
 * once staging fan-out lands in Deploy 2) without capping backlog
 * throughput at the cron interval.
 */
export const STAGING_SWEEP_BATCH_SIZE = 25

/**
 * The single staging row for a page, if one exists. Callers get either
 * `null` (nothing in flight) or the row itself.
 */
export async function getStagingByPageId(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">
): Promise<Doc<"pageStaging"> | null> {
  return await ctx.db
    .query("pageStaging")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .first()
}

/**
 * ADR-0041 §4 freshness rule — lazy-create semantics.
 *
 * The client sends `expectedUpdatedAt` referencing the staging row it last
 * observed. Two legitimate cases:
 *
 * - **No staging row exists** — treat as lazy-create (the token references
 *   a row that has since been promoted + deleted; the client's next
 *   autosave should build a fresh staging row on top of the newly-live
 *   content). Never a conflict.
 * - **Staging row exists with a matching `updatedAt`** — no conflict.
 *
 * Only a live staging row with a newer `updatedAt` than the token counts
 * as a genuine lost-update race between two writers.
 */
export function assertStagingFresh(
  staging: Doc<"pageStaging"> | null,
  expectedUpdatedAt: number | undefined
): void {
  if (expectedUpdatedAt === undefined) return
  if (staging === null) return
  if (staging.updatedAt === expectedUpdatedAt) return
  throw new ConvexError(
    "Someone else took over editing this page — reload to keep your changes as a new staging revision."
  )
}

/**
 * Compose an effective post-staging view of a page for downstream
 * consumers (checklist walkers, admin projections, publish coalescer).
 * The staging fields overlay the live page's fields, giving the shape a
 * publish would produce. `content` on staging replaces the live content
 * outright when present; unset staging keys leave the live values in
 * place.
 *
 * The result is typed as the live page arm — publish will re-hit the
 * discriminated union at `ctx.db.patch` time, and staging arms are the
 * per-pageType subset by construction.
 */
export function overlayStagingOnPage(
  page: Doc<"pages">,
  staging: Doc<"pageStaging"> | null
): Doc<"pages"> {
  if (!staging) return page
  const overlay: Record<string, unknown> = {}
  // Content is per-locale bag on both sides. Staging.content replaces
  // pages.content wholesale when present, so an editor removing a locale
  // from a live page is reflected via the publish patch. Absent means
  // "no staging content changes yet" — leave live alone.
  if (staging.content !== undefined) overlay.content = staging.content
  // System-owned staging fields (subset of `systemPageFields`).
  if (staging.slug !== undefined) overlay.slug = staging.slug
  if (staging.localizedSlugs !== undefined)
    overlay.localizedSlugs = staging.localizedSlugs
  if (staging.seo !== undefined) overlay.seo = staging.seo
  if (staging.scheduledAt !== undefined)
    overlay.scheduledAt = staging.scheduledAt
  if (staging.template !== undefined) overlay.template = staging.template
  if (staging.showOnHomepage !== undefined)
    overlay.showOnHomepage = staging.showOnHomepage
  if (staging.displayMode !== undefined)
    overlay.displayMode = staging.displayMode
  if (staging.cardImageMediaId !== undefined)
    overlay.cardImageMediaId = staging.cardImageMediaId
  if (staging.cardExcerpt !== undefined)
    overlay.cardExcerpt = staging.cardExcerpt

  // Descriptor sharedFields — walked off the descriptor so a future
  // shared field lands here without editing this helper.
  //
  // Null-preservation rule (ADR-0041 shared-field clear semantics):
  //   * `undefined` on staging = "no change to the live value" (skipped).
  //   * `null`      on staging = "clear this field at publish"; the
  //     overlay projects that as `undefined` so admin surfaces see the
  //     post-publish shape.
  //   * anything else = replacement value.
  //
  // This mirrors `pages.publish`'s promote patch — the two must agree,
  // or the "Unpublished changes" overlay would disagree with what
  // publish actually writes to `pages`.
  const descriptor = contentTypeDefs[page.pageType]
  if (descriptor) {
    for (const key of Object.keys(descriptor.sharedFields)) {
      const value = (staging as unknown as Record<string, unknown>)[key]
      if (value === undefined) continue
      overlay[key] = value === null ? undefined : value
    }
  }
  return { ...page, ...overlay } as Doc<"pages">
}

/**
 * Delete the staging row for a page, if one exists. Called at publish
 * promote, at explicit discard, at hard delete, and by the abandoned
 * sweep. Idempotent — no error when nothing is staged.
 */
export async function deleteStagingByPageId(
  ctx: MutationCtx,
  pageId: Id<"pages">
): Promise<void> {
  const staging = await getStagingByPageId(ctx, pageId)
  if (staging) await occurrenceUsageWrites(ctx).delete(staging._id)
}

/**
 * Enrich a list of `pages` rows with the staged overlays from `pageStaging`
 * (ADR-0041 Deploy 2 PR B). Two overlays land here:
 *
 *   * `scheduledAt` — every admin list surface that renders the
 *     "Publishes {date}" badge on `pages.scheduledAt` needs it after
 *     scheduling moved to staging.
 *   * `effectiveTitles` — every admin surface that renders the page's
 *     title (list, palette, admin search) needs it once `create` /
 *     `duplicate` / the hoist migration land drafts on staging with
 *     `pages.content` empty. `pageStaging.effectiveTitles[locale]` is the
 *     denormalized snapshot maintained by `updateDraft` and the hoist.
 *
 * Rows without a staging row (or with the individual field absent) pass
 * through unchanged. `effectiveTitles: undefined` on the row means the
 * caller falls back to `page.content[locale].title` — the pre-PR-B shape.
 *
 * Uses `pageStaging.by_pageId` per row (O(N) point lookups). Fine at
 * admin-list page size (25); promote to a single scan-by-set if a call
 * site ever needs bigger batches.
 */
export async function enrichWithStagingOverlay<T extends Doc<"pages">>(
  ctx: QueryCtx | MutationCtx,
  pages: T[]
): Promise<
  Array<
    T & { scheduledAt?: number; effectiveTitles?: Record<string, string> }
  >
> {
  return await Promise.all(
    pages.map(async (page) => {
      const staging = await ctx.db
        .query("pageStaging")
        .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
        .first()
      const extras: {
        scheduledAt?: number
        effectiveTitles?: Record<string, string>
      } = {}
      if (staging?.scheduledAt !== undefined) {
        extras.scheduledAt = staging.scheduledAt
      }
      if (staging?.effectiveTitles !== undefined) {
        extras.effectiveTitles = staging.effectiveTitles
      }
      return { ...page, ...extras }
    })
  )
}

/**
 * Pluck `effectiveTitles` off a locale-content bag for the §8
 * denormalization. Absent titles are omitted rather than persisted as
 * empty strings so downstream fallback logic ("prefer staging title when
 * present, else fall back to `pages.content` title") behaves crisply.
 */
export function pickEffectiveTitles(
  content: Record<string, { title?: string }> | undefined
): Record<string, string> | undefined {
  if (!content) return undefined
  const out: Record<string, string> = {}
  let any = false
  for (const [locale, bag] of Object.entries(content)) {
    if (typeof bag?.title === "string" && bag.title.length > 0) {
      out[locale] = bag.title
      any = true
    }
  }
  return any ? out : undefined
}

/**
 * Resolve the best display title for a page in an admin surface. Reads
 * `page.content[locale].title` first (works for any published page, or a
 * legacy draft whose content still lives on `pages.content`); when
 * absent — the ADR-0041 Deploy 2 PR B "content lives on staging" case —
 * falls back to the denormalized `pageStaging.effectiveTitles`. Falls
 * back to the page slug and finally "Untitled". Pass `null` for staging
 * to skip the fallback (e.g. published pages where staged edits should
 * not surface).
 */
export function pageDisplayTitle(
  page: Doc<"pages">,
  staging: Doc<"pageStaging"> | null
): string {
  const first = Object.values(page.content ?? {})[0] as
    { title?: string } | undefined
  if (first?.title) return first.title
  const staged = staging?.effectiveTitles
  if (staged) {
    for (const value of Object.values(staged)) {
      if (value && value.length > 0) return value
    }
  }
  return page.slug || "Untitled"
}

/**
 * Async variant that fetches staging when the caller does not already
 * have it. Skips the fetch for published pages (staging never widens
 * their display title).
 */
export async function resolvePageDisplayTitle(
  ctx: QueryCtx | MutationCtx,
  page: Doc<"pages">
): Promise<string> {
  const staging =
    page.status === "published" ? null : await getStagingByPageId(ctx, page._id)
  return pageDisplayTitle(page, staging)
}

// Retained occurrence accounting lives beside the existing server-only draft
// persistence seam. The pure identity policy stays safe for browser imports.
export const SLICE_OCCURRENCE_EPOCH = 1
const OCCURRENCE_STATE_KEY = "slice-occurrences-v1" as const
const OCCURRENCE_SOURCE_LIMIT = 512
const SOURCE_KINDS = {
  pages: "saved",
  pageStaging: "staging",
  pageLocaleDrafts: "localeDraft",
  pageSharedDrafts: "sharedDraft",
  pageLocalePublicationCandidates: "candidate",
  pagePublishedSnapshots: "snapshot",
} as const
export type SliceOccurrenceSourceTable = keyof typeof SOURCE_KINDS
const SOURCE_TABLES = Object.keys(SOURCE_KINDS) as SliceOccurrenceSourceTable[]
const TRACKED_TABLES = [
  ...SOURCE_TABLES,
  "pagePublicationSliceReferences",
  "pagePublicationPageStates",
  "pageLocalePublicationStates",
] as const
const REFERENCE_SOURCE_TABLES = {
  shared_draft: "pageSharedDrafts",
  locale_draft: "pageLocaleDrafts",
  candidate: "pageLocalePublicationCandidates",
  current_public: "pagePublishedSnapshots",
} as const

type SourceChange = { table: SliceOccurrenceSourceTable; id: string }
type OccurrenceTransaction = {
  dirty: Map<string, SourceChange>
  writer: MutationCtx["db"]
}
type OccurrenceContext = MutationCtx & {
  occurrenceUsage?: OccurrenceTransaction
}
type ExtractedSource = SliceOccurrenceExtraction & {
  fingerprint: string
  exists: boolean
}

export async function readSliceOccurrenceState(ctx: QueryCtx | MutationCtx) {
  return ctx.db
    .query("sliceOccurrenceCountState")
    .withIndex("by_key", (q) => q.eq("key", OCCURRENCE_STATE_KEY))
    .unique()
}

async function ensureOccurrenceState(ctx: MutationCtx) {
  const existing = await readSliceOccurrenceState(ctx)
  if (existing) return existing
  const id = await ctx.db.insert("sliceOccurrenceCountState", {
    key: OCCURRENCE_STATE_KEY,
    epoch: SLICE_OCCURRENCE_EPOCH,
    status: "uninitialized",
    mode: "backfill",
    unknownInvalidSources: 0,
    verificationFailed: false,
    run: 0,
    startedAt: 0,
    integrityVersion: 0,
  })
  return (await ctx.db.get(id))!
}

export async function readSliceOccurrenceCounter(
  ctx: QueryCtx | MutationCtx,
  type: string,
  presentationId: string
) {
  return ctx.db
    .query("sliceOccurrenceCounts")
    .withIndex("by_type_and_presentationId", (q) =>
      q.eq("type", type).eq("presentationId", presentationId)
    )
    .unique()
}

async function ensureOccurrenceCounter(
  ctx: MutationCtx,
  type: string,
  presentationId: string
) {
  const current = await readSliceOccurrenceCounter(ctx, type, presentationId)
  if (current) {
    if (current.epoch !== SLICE_OCCURRENCE_EPOCH)
      throw new ConvexError("SLICE_OCCURRENCE_EPOCH_INVALID")
    return current
  }
  const id = await ctx.db.insert("sliceOccurrenceCounts", {
    type,
    presentationId,
    count: 0,
    invalidSources: 0,
    version: 0,
    epoch: SLICE_OCCURRENCE_EPOCH,
  })
  return (await ctx.db.get(id))!
}

function sourceKey(table: SliceOccurrenceSourceTable, id: string) {
  return `${table}:${id}`
}

function emptyExtraction(exists: boolean): ExtractedSource {
  return {
    exists,
    fingerprint: "absent",
    occurrences: [],
    invalidTypes: [],
    unknownInvalid: false,
  }
}

async function extractOccurrenceSource(
  ctx: MutationCtx,
  table: SliceOccurrenceSourceTable,
  id: string,
  candidates: Map<string, ExtractedSource>
): Promise<ExtractedSource> {
  const normalized = ctx.db.normalizeId(table, id)
  if (!normalized) throw new ConvexError("SLICE_OCCURRENCE_SOURCE_INVALID")
  const row = await ctx.db.get(table, normalized)
  if (!row) return emptyExtraction(false)
  if (table === "pagePublishedSnapshots") {
    const snapshot = row as Doc<"pagePublishedSnapshots">
    let candidate = candidates.get(snapshot.candidateId)
    if (!candidate) {
      candidate = await extractOccurrenceSource(
        ctx,
        "pageLocalePublicationCandidates",
        snapshot.candidateId,
        candidates
      )
    }
    if (
      !candidate.exists ||
      candidate.fingerprint !== snapshot.candidateDigest ||
      candidate.occurrences.some(
        (key) =>
          key.pageId !== String(snapshot.pageId) ||
          key.locale !== snapshot.locale
      )
    ) {
      return {
        ...emptyExtraction(true),
        unknownInvalid: true,
        fingerprint: "invalid-snapshot",
      }
    }
    return {
      ...candidate,
      fingerprint: JSON.stringify([
        snapshot.candidateId,
        snapshot.candidateDigest,
      ]),
    }
  }
  if (table === "pageLocalePublicationCandidates") {
    const cached = candidates.get(id)
    if (cached) return cached
    const candidate = row as Doc<"pageLocalePublicationCandidates">
    const payload = await reconstructLocalePublicationCandidate(candidate)
    const result =
      payload &&
      payload.page.id === String(candidate.pageId) &&
      payload.page.pageType === candidate.pageType &&
      payload.locale === candidate.locale
        ? extractSliceOccurrenceIdentities(String(candidate.pageId), {
            [candidate.locale]: payload.localized.content,
          })
        : { occurrences: [], invalidTypes: [], unknownInvalid: true }
    const extracted = { ...result, exists: true, fingerprint: candidate.digest }
    candidates.set(id, extracted)
    return extracted
  }
  if (table === "pageSharedDrafts") {
    return {
      ...emptyExtraction(true),
      fingerprint: String((row as Doc<"pageSharedDrafts">).generation),
    }
  }
  const value = row as
    Doc<"pages"> | Doc<"pageStaging"> | Doc<"pageLocaleDrafts">
  const content = !hasSliceBody(value as Doc<"pages">)
    ? undefined
    : table === "pageLocaleDrafts"
      ? {
          [(row as Doc<"pageLocaleDrafts">).locale]: (
            row as Doc<"pageLocaleDrafts">
          ).content,
        }
      : value.content
  const result = extractSliceOccurrenceIdentities(
    String(table === "pages" ? row._id : (row as Doc<"pageStaging">).pageId),
    content
  )
  return {
    ...result,
    exists: true,
    fingerprint: JSON.stringify([
      "generation" in row ? row.generation : null,
      result.occurrences.map((key) => key.key),
      result.invalidTypes,
      result.unknownInvalid,
    ]),
  }
}

async function validateOccurrenceReferences(
  ctx: MutationCtx,
  change: SourceChange,
  extracted: ExtractedSource
): Promise<ExtractedSource> {
  const sourceKind = Object.entries(REFERENCE_SOURCE_TABLES).find(
    ([, table]) => table === change.table
  )?.[0] as keyof typeof REFERENCE_SOURCE_TABLES | undefined
  if (!sourceKind) return extracted
  const refs = await ctx.db
    .query("pagePublicationSliceReferences")
    .withIndex("by_sourceKind_and_sourceId", (q) =>
      q
        .eq("sourceKind", sourceKind)
        .eq(
          "sourceId",
          change.id as Doc<"pagePublicationSliceReferences">["sourceId"]
        )
    )
    .take(OCCURRENCE_SOURCE_LIMIT + 1)
  // Old snapshots intentionally lose their current-public aliases.
  if (sourceKind === "current_public" && refs.length === 0) return extracted
  const expected = new Map<string, number>()
  for (const key of extracted.occurrences)
    expected.set(key.type, (expected.get(key.type) ?? 0) + 1)
  const actual = new Map<string, number>()
  let invalid = refs.length > OCCURRENCE_SOURCE_LIMIT
  for (const ref of refs) {
    if (
      actual.has(ref.sliceType) ||
      !Number.isSafeInteger(ref.count) ||
      ref.count < 0
    )
      invalid = true
    actual.set(ref.sliceType, (actual.get(ref.sliceType) ?? 0) + ref.count)
  }
  if (!extracted.exists && refs.length > 0) invalid = true
  if (expected.size !== actual.size) invalid = true
  for (const [type, count] of expected)
    if (actual.get(type) !== count) invalid = true
  if (!invalid) return extracted
  const invalidTypes = [
    ...new Set([
      ...extracted.invalidTypes,
      ...expected.keys(),
      ...actual.keys(),
    ]),
  ].sort()
  return {
    ...extracted,
    occurrences: [],
    invalidTypes,
    unknownInvalid: extracted.unknownInvalid || invalidTypes.length === 0,
  }
}

function zeroReferences(): Doc<"sliceOccurrenceUsage">["references"] {
  return {
    saved: 0,
    staging: 0,
    localeDraft: 0,
    sharedDraft: 0,
    candidate: 0,
    snapshot: 0,
  }
}

async function changeOccurrenceTotal(
  ctx: MutationCtx,
  type: string,
  presentationId: string,
  delta: number
) {
  await ensureOccurrenceCounter(ctx, type, "default")
  const counter = await ensureOccurrenceCounter(ctx, type, presentationId)
  const count = counter.count + delta
  if (!Number.isSafeInteger(count) || count < 0)
    throw new ConvexError("SLICE_OCCURRENCE_COUNTER_INVALID")
  await ctx.db.patch(counter._id, { count, version: counter.version + 1 })
}

/** The only owner of source membership, fixed refcounts and scalar totals. */
export async function reconcileSliceOccurrenceSource(
  ctx: MutationCtx,
  change: SourceChange,
  mode: "backfill" | "verify" = "backfill",
  candidates = new Map<string, ExtractedSource>()
): Promise<void> {
  const state = await ensureOccurrenceState(ctx)
  const extraction = await validateOccurrenceReferences(
    ctx,
    change,
    await extractOccurrenceSource(ctx, change.table, change.id, candidates)
  )
  const key = sourceKey(change.table, change.id)
  let source = await ctx.db
    .query("sliceOccurrenceSources")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique()
  const members = source
    ? await ctx.db
        .query("sliceOccurrenceSourceMembers")
        .withIndex("by_sourceId_and_occurrenceId", (q) =>
          q.eq("sourceId", source!._id)
        )
        .take(OCCURRENCE_SOURCE_LIMIT + 1)
    : []
  if (members.length > OCCURRENCE_SOURCE_LIMIT)
    throw new ConvexError("SLICE_OCCURRENCE_MEMBERSHIP_INVALID")
  const old = new Map<
    string,
    {
      member: Doc<"sliceOccurrenceSourceMembers">
      occurrence: Doc<"sliceOccurrenceUsage">
    }
  >()
  for (const member of members) {
    const occurrence = await ctx.db.get(member.occurrenceId)
    if (!occurrence)
      throw new ConvexError("SLICE_OCCURRENCE_MEMBERSHIP_INVALID")
    old.set(occurrence.key, { member, occurrence })
  }
  const desired = new Map(
    extraction.occurrences.map((identity) => [identity.key, identity])
  )
  if (mode === "verify") {
    const equal =
      source?.fingerprint === extraction.fingerprint &&
      source.epoch === SLICE_OCCURRENCE_EPOCH &&
      source.unknownInvalid === extraction.unknownInvalid &&
      JSON.stringify(source.invalidTypes) ===
        JSON.stringify(extraction.invalidTypes) &&
      old.size === desired.size &&
      [...desired.keys()].every((identity) => old.has(identity))
    if (
      !equal ||
      extraction.unknownInvalid ||
      extraction.invalidTypes.length > 0
    )
      await ctx.db.patch(state._id, { verificationFailed: true })
    return
  }
  if (
    !source &&
    !extraction.exists &&
    !extraction.unknownInvalid &&
    extraction.invalidTypes.length === 0
  )
    return
  if (!source) {
    const sourceId = await ctx.db.insert("sliceOccurrenceSources", {
      key,
      table: change.table,
      sourceId: change.id,
      fingerprint: "",
      epoch: SLICE_OCCURRENCE_EPOCH,
      invalidTypes: [],
      unknownInvalid: false,
    })
    source = (await ctx.db.get(sourceId))!
  }
  const kind = SOURCE_KINDS[change.table]
  for (const [identity, { member, occurrence }] of old) {
    if (desired.has(identity)) continue
    const references = {
      ...occurrence.references,
      [kind]: occurrence.references[kind] - 1,
    }
    if (references[kind] < 0)
      throw new ConvexError("SLICE_OCCURRENCE_REFCOUNT_INVALID")
    await ctx.db.delete(member._id)
    if (Object.values(references).every((count) => count === 0)) {
      await ctx.db.delete(occurrence._id)
      await changeOccurrenceTotal(
        ctx,
        occurrence.type,
        occurrence.presentationId,
        -1
      )
    } else await ctx.db.patch(occurrence._id, { references })
  }
  for (const [identity, value] of desired) {
    if (old.has(identity)) continue
    let occurrence = await ctx.db
      .query("sliceOccurrenceUsage")
      .withIndex("by_key", (q) => q.eq("key", identity))
      .unique()
    if (!occurrence) {
      const id = await ctx.db.insert("sliceOccurrenceUsage", {
        ...value,
        references: { ...zeroReferences(), [kind]: 1 },
      })
      occurrence = (await ctx.db.get(id))!
      await changeOccurrenceTotal(ctx, value.type, value.presentationId, 1)
    } else {
      await ctx.db.patch(occurrence._id, {
        references: {
          ...occurrence.references,
          [kind]: occurrence.references[kind] + 1,
        },
      })
    }
    await ctx.db.insert("sliceOccurrenceSourceMembers", {
      sourceId: source._id,
      occurrenceId: occurrence._id,
    })
  }
  for (const type of new Set([
    ...source.invalidTypes,
    ...extraction.invalidTypes,
  ])) {
    const delta =
      Number(extraction.invalidTypes.includes(type)) -
      Number(source.invalidTypes.includes(type))
    if (delta === 0) continue
    const counter = await ensureOccurrenceCounter(ctx, type, "default")
    const invalidSources = counter.invalidSources + delta
    if (invalidSources < 0)
      throw new ConvexError("SLICE_OCCURRENCE_INTEGRITY_INVALID")
    await ctx.db.patch(counter._id, {
      invalidSources,
      version: counter.version + 1,
    })
  }
  const unknownDelta =
    Number(extraction.unknownInvalid) - Number(source.unknownInvalid)
  if (unknownDelta) {
    const current = await ensureOccurrenceState(ctx)
    const unknownInvalidSources = current.unknownInvalidSources + unknownDelta
    if (unknownInvalidSources < 0)
      throw new ConvexError("SLICE_OCCURRENCE_INTEGRITY_INVALID")
    await ctx.db.patch(current._id, {
      unknownInvalidSources,
      integrityVersion: current.integrityVersion + 1,
    })
  }
  if (
    !extraction.exists &&
    !extraction.unknownInvalid &&
    extraction.invalidTypes.length === 0
  )
    await ctx.db.delete(source._id)
  else
    await ctx.db.patch(source._id, {
      fingerprint: extraction.fingerprint,
      epoch: SLICE_OCCURRENCE_EPOCH,
      invalidTypes: extraction.invalidTypes,
      unknownInvalid: extraction.unknownInvalid,
    })
}

function normalizedWriteTable(db: MutationCtx["db"], args: unknown[]) {
  if (typeof args[0] !== "string") return null
  if ((TRACKED_TABLES as readonly string[]).includes(args[0]))
    return {
      table: args[0] as (typeof TRACKED_TABLES)[number],
      id: args[1] as string | undefined,
    }
  for (const table of TRACKED_TABLES)
    if (db.normalizeId(table, args[0])) return { table, id: args[0] }
  return null
}

function enqueueOccurrenceChange(
  transaction: OccurrenceTransaction,
  table: string,
  id: string,
  row?: Record<string, unknown> | null
) {
  if ((SOURCE_TABLES as readonly string[]).includes(table)) {
    const change = { table: table as SliceOccurrenceSourceTable, id }
    transaction.dirty.set(sourceKey(change.table, id), change)
  } else if (table === "pagePublicationSliceReferences" && row) {
    const sourceTable =
      REFERENCE_SOURCE_TABLES[
        row.sourceKind as keyof typeof REFERENCE_SOURCE_TABLES
      ]
    if (sourceTable && typeof row.sourceId === "string") {
      const change = { table: sourceTable, id: row.sourceId }
      transaction.dirty.set(sourceKey(change.table, change.id), change)
    }
  }
}

async function flushOccurrenceChanges(
  ctx: MutationCtx,
  transaction: OccurrenceTransaction
) {
  const candidates = new Map<string, ExtractedSource>()
  // Candidate payloads are extracted once before snapshot aliases.
  const changes = [...transaction.dirty.values()].sort(
    (a, b) =>
      Number(a.table === "pagePublishedSnapshots") -
      Number(b.table === "pagePublishedSnapshots")
  )
  for (const change of changes)
    await reconcileSliceOccurrenceSource(ctx, change, "backfill", candidates)
  transaction.dirty.clear()
}

function createOccurrenceTransaction(
  ctx: MutationCtx,
  immediate = false
): OccurrenceTransaction {
  const transaction: OccurrenceTransaction = {
    dirty: new Map(),
    writer: ctx.db,
  }
  transaction.writer = new Proxy(ctx.db, {
    get(db, method, receiver) {
      const original: unknown = Reflect.get(db, method, receiver)
      if (!["insert", "patch", "replace", "delete"].includes(String(method)))
        return typeof original === "function" ? original.bind(db) : original
      return async (...args: unknown[]) => {
        const target =
          method === "insert"
            ? { table: args[0] as string, id: undefined }
            : normalizedWriteTable(db, args)
        const old =
          target?.id && target.table === "pagePublicationSliceReferences"
            ? await db.get(target.id as Id<"pagePublicationSliceReferences">)
            : null
        const result: unknown = await Reflect.apply(
          original as (...values: unknown[]) => unknown,
          db,
          args
        )
        if (target) {
          const id = method === "insert" ? String(result) : target.id
          const value = method === "insert" ? args[1] : args.at(-1)
          if (id)
            enqueueOccurrenceChange(
              transaction,
              target.table,
              id,
              method === "delete"
                ? old
                : method === "patch" && old
                  ? { ...old, ...(value as Record<string, unknown>) }
                  : (value as Record<string, unknown>)
            )
        }
        if (immediate) await flushOccurrenceChanges(ctx, transaction)
        return result
      }
    },
  })
  return transaction
}

/** Every occurrence-bearing DML site obtains its writer through this seam. */
export function occurrenceUsageWrites(ctx: MutationCtx): MutationCtx["db"] {
  return (
    (ctx as OccurrenceContext).occurrenceUsage?.writer ??
    createOccurrenceTransaction(ctx, true).writer
  )
}

const occurrenceCustomization = customCtx((ctx: MutationCtx) => ({
  occurrenceUsage: createOccurrenceTransaction(ctx),
}))
const occurrenceWriteContext = {
  ...occurrenceCustomization,
  input: async (ctx: MutationCtx) => {
    const result = await occurrenceCustomization.input(ctx, {}, {})
    return {
      ...result,
      onSuccess: async () =>
        flushOccurrenceChanges(ctx, result.ctx.occurrenceUsage),
    }
  },
}
export const occurrenceUsageMutation = customMutation(
  rawMutation,
  occurrenceWriteContext
)
export const occurrenceUsageInternalMutation = customMutation(
  rawInternalMutation,
  occurrenceWriteContext
)

/** Called only after bootstrap's empty-install authority checks and blank Home. */
export async function initializeEmptySliceOccurrenceCounts(
  ctx: MutationCtx
): Promise<void> {
  const state = await ensureOccurrenceState(ctx)
  if (state.status === "ready" && state.epoch === SLICE_OCCURRENCE_EPOCH) return
  // An onboarding stamp is not evidence that an old installation is empty.
  const [pages, staging, candidates, snapshots, drafts, refs] =
    await Promise.all([
      ctx.db.query("pages").take(2),
      ctx.db.query("pageStaging").take(1),
      ctx.db.query("pageLocalePublicationCandidates").take(1),
      ctx.db.query("pagePublishedSnapshots").take(1),
      ctx.db.query("pageLocaleDrafts").take(2),
      ctx.db.query("pagePublicationSliceReferences").take(1),
    ])
  const isEmpty = (extraction: SliceOccurrenceExtraction) =>
    extraction.occurrences.length === 0 &&
    extraction.invalidTypes.length === 0 &&
    !extraction.unknownInvalid
  if (
    pages.length !== 1 ||
    drafts.length !== 1 ||
    refs.length ||
    staging.length ||
    candidates.length ||
    snapshots.length ||
    pages.some(
      (page) =>
        !isEmpty(
          extractSliceOccurrenceIdentities(String(page._id), page.content)
        )
    ) ||
    drafts.some(
      (draft) =>
        !isEmpty(
          extractSliceOccurrenceIdentities(String(draft.pageId), {
            [draft.locale]: draft.content,
          })
        )
    )
  )
    return
  const catalog = await readSlicePresentationCatalog()
  for (const entry of catalog.entries)
    await ensureOccurrenceCounter(ctx, entry.type, entry.id)
  await ctx.db.patch(state._id, {
    status: "ready",
    epoch: SLICE_OCCURRENCE_EPOCH,
  })
}

/** Owner entry prepares a run; native migrations own resumable batch delivery. */
export async function beginSliceOccurrenceMaintenance(
  ctx: MutationCtx,
  mode: "backfill" | "verify",
  restart: boolean
) {
  const state = await ensureOccurrenceState(ctx)
  if (state.status === "building" && !restart) {
    if (state.mode !== mode)
      throw new ConvexError("SLICE_OCCURRENCE_MAINTENANCE_ACTIVE")
    return { restart: false }
  }
  const catalog = await readSlicePresentationCatalog()
  for (const entry of catalog.entries)
    await ensureOccurrenceCounter(ctx, entry.type, entry.id)
  await ctx.db.patch(state._id, {
    status: "building",
    mode,
    run: state.run + 1,
    startedAt: Date.now(),
    verificationFailed: false,
    verificationRun: undefined,
  })
  return { restart: true }
}

export async function maintainSliceOccurrenceSource(
  ctx: MutationCtx,
  table: SliceOccurrenceSourceTable,
  id: string
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building") return
  await reconcileSliceOccurrenceSource(ctx, { table, id }, state.mode)
}

export async function maintainSliceOccurrenceReference(
  ctx: MutationCtx,
  reference: Doc<"pagePublicationSliceReferences">
): Promise<void> {
  const table = REFERENCE_SOURCE_TABLES[reference.sourceKind]
  await maintainSliceOccurrenceSource(ctx, table, reference.sourceId)
}

export async function prepareSliceOccurrenceVerification(
  ctx: MutationCtx,
  counter: Doc<"sliceOccurrenceCounts">
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building" || counter.verificationRun === state.run)
    return
  await ctx.db.patch(counter._id, {
    verificationRun: state.run,
    verificationCount: 0,
    verificationVersion: counter.version,
    verificationFinishedRun: undefined,
    verificationInvalidSources: 0,
  })
}

export async function tallySliceOccurrenceVerification(
  ctx: MutationCtx,
  occurrence: Doc<"sliceOccurrenceUsage">
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building" || occurrence.lastTalliedRun === state.run)
    return
  const counter = await readSliceOccurrenceCounter(
    ctx,
    occurrence.type,
    occurrence.presentationId
  )
  const members = await ctx.db
    .query("sliceOccurrenceSourceMembers")
    .withIndex("by_occurrenceId", (q) => q.eq("occurrenceId", occurrence._id))
    .take(OCCURRENCE_SOURCE_LIMIT + 1)
  const expected = zeroReferences()
  let valid = members.length > 0 && members.length <= OCCURRENCE_SOURCE_LIMIT
  for (const member of members) {
    const source = await ctx.db.get(member.sourceId)
    if (!source) valid = false
    else expected[SOURCE_KINDS[source.table]]++
  }
  for (const kind of Object.values(SOURCE_KINDS))
    if (
      !Number.isSafeInteger(occurrence.references[kind]) ||
      expected[kind] !== occurrence.references[kind]
    )
      valid = false
  if (
    !valid ||
    !counter ||
    counter.verificationRun !== state.run ||
    counter.verificationVersion !== counter.version
  ) {
    await ctx.db.patch(state._id, { verificationFailed: true })
    return
  }
  await ctx.db.patch(counter._id, {
    verificationCount: (counter.verificationCount ?? 0) + 1,
  })
  await ctx.db.patch(occurrence._id, { lastTalliedRun: state.run })
}

export async function finishSliceOccurrenceCounterVerification(
  ctx: MutationCtx,
  counter: Doc<"sliceOccurrenceCounts">
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (
    state?.status !== "building" ||
    counter.verificationFinishedRun === state.run
  )
    return
  const count = counter.verificationCount
  if (
    counter.verificationRun !== state.run ||
    counter.verificationVersion !== counter.version ||
    count === undefined ||
    !Number.isSafeInteger(count) ||
    count < 0 ||
    counter.verificationInvalidSources === undefined ||
    (state.mode === "verify" &&
      (count !== counter.count ||
        counter.invalidSources !== counter.verificationInvalidSources))
  ) {
    await ctx.db.patch(state._id, { verificationFailed: true })
    return
  }
  await ctx.db.patch(counter._id, {
    count,
    version: counter.version + Number(count !== counter.count),
    verificationFinishedRun: state.run,
    invalidSources: counter.verificationInvalidSources,
  })
}

export async function finishSliceOccurrenceMaintenance(
  ctx: MutationCtx,
  completedSourcePasses: boolean
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building") return
  const counters = await ctx.db.query("sliceOccurrenceCounts").take(129)
  const verified =
    completedSourcePasses &&
    counters.length < 129 &&
    state.verificationRun === state.run &&
    state.verificationIntegrityVersion === state.integrityVersion &&
    state.verificationUnknownInvalidSources !== undefined &&
    (state.mode !== "verify" ||
      state.verificationUnknownInvalidSources ===
        state.unknownInvalidSources) &&
    counters.every((counter) => counter.verificationFinishedRun === state.run)
  await ctx.db.patch(state._id, {
    status: verified && !state.verificationFailed ? "ready" : "unavailable",
    verificationFailed: state.verificationFailed || !verified,
    ...(verified
      ? { unknownInvalidSources: state.verificationUnknownInvalidSources }
      : {}),
  })
}

export async function prepareSliceOccurrenceIntegrityVerification(
  ctx: MutationCtx
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building" || state.verificationRun === state.run)
    return
  await ctx.db.patch(state._id, {
    verificationRun: state.run,
    verificationIntegrityVersion: state.integrityVersion,
    verificationUnknownInvalidSources: 0,
  })
}

export async function tallySliceOccurrenceIntegrityVerification(
  ctx: MutationCtx,
  source: Doc<"sliceOccurrenceSources">
): Promise<void> {
  const state = await readSliceOccurrenceState(ctx)
  if (state?.status !== "building" || source.lastIntegrityRun === state.run)
    return
  for (const type of source.invalidTypes) {
    const counter = await readSliceOccurrenceCounter(ctx, type, "default")
    if (!counter || counter.verificationRun !== state.run) {
      await ctx.db.patch(state._id, { verificationFailed: true })
      return
    }
    await ctx.db.patch(counter._id, {
      verificationInvalidSources: (counter.verificationInvalidSources ?? 0) + 1,
    })
  }
  if (source.unknownInvalid)
    await ctx.db.patch(state._id, {
      verificationUnknownInvalidSources:
        (state.verificationUnknownInvalidSources ?? 0) + 1,
    })
  await ctx.db.patch(source._id, { lastIntegrityRun: state.run })
}

const occurrenceMigrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { internalMutation: occurrenceUsageInternalMutation, schema }
)

// Occurrence maintenance reuses the mounted, resumable migrations component.
// The public in-app start is owner gated; workers remain internal, including
// the existing deployment-admin CLI/dashboard trust boundary.
export const backfillSliceOccurrenceSaved = occurrenceMigrations.define({
  table: "pages",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(ctx, "pages", row._id),
})
export const backfillSliceOccurrenceStaged = occurrenceMigrations.define({
  table: "pageStaging",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(ctx, "pageStaging", row._id),
})
export const backfillSliceOccurrenceShared = occurrenceMigrations.define({
  table: "pageSharedDrafts",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(ctx, "pageSharedDrafts", row._id),
})
export const backfillSliceOccurrenceDrafts = occurrenceMigrations.define({
  table: "pageLocaleDrafts",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(ctx, "pageLocaleDrafts", row._id),
})
export const backfillSliceOccurrenceCandidates = occurrenceMigrations.define({
  table: "pageLocalePublicationCandidates",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(
      ctx,
      "pageLocalePublicationCandidates",
      row._id
    ),
})
export const backfillSliceOccurrenceSnapshots = occurrenceMigrations.define({
  table: "pagePublishedSnapshots",
  batchSize: 1,
  migrateOne: (ctx, row) =>
    maintainSliceOccurrenceSource(ctx, "pagePublishedSnapshots", row._id),
})
export const backfillSliceOccurrenceReferences = occurrenceMigrations.define({
  table: "pagePublicationSliceReferences",
  batchSize: 1,
  migrateOne: (ctx, row) => maintainSliceOccurrenceReference(ctx, row),
})
export const backfillSliceOccurrenceSourceClosure = occurrenceMigrations.define(
  {
    table: "sliceOccurrenceSources",
    batchSize: 1,
    migrateOne: (ctx, row) =>
      maintainSliceOccurrenceSource(ctx, row.table, row.sourceId),
  }
)
export const prepareSliceOccurrenceIntegrity = occurrenceMigrations.define({
  table: "sliceOccurrenceCountState",
  batchSize: 1,
  migrateOne: (ctx) => prepareSliceOccurrenceIntegrityVerification(ctx),
})
export const prepareSliceOccurrenceCounters = occurrenceMigrations.define({
  table: "sliceOccurrenceCounts",
  batchSize: 1,
  migrateOne: (ctx, row) => prepareSliceOccurrenceVerification(ctx, row),
})
export const tallySliceOccurrenceIntegrity = occurrenceMigrations.define({
  table: "sliceOccurrenceSources",
  batchSize: 16,
  migrateOne: (ctx, row) => tallySliceOccurrenceIntegrityVerification(ctx, row),
})
export const tallySliceOccurrenceKeys = occurrenceMigrations.define({
  table: "sliceOccurrenceUsage",
  batchSize: 16,
  migrateOne: (ctx, row) => tallySliceOccurrenceVerification(ctx, row),
})
export const verifySliceOccurrenceCounters = occurrenceMigrations.define({
  table: "sliceOccurrenceCounts",
  batchSize: 1,
  migrateOne: (ctx, row) => finishSliceOccurrenceCounterVerification(ctx, row),
})
export const finalizeSliceOccurrenceUsage = occurrenceMigrations.define({
  table: "sliceOccurrenceCountState",
  batchSize: 1,
  migrateOne: async (ctx, state) => {
    if (state.status !== "building") return
    const sources = sliceOccurrenceMaintenanceSeries().slice(0, -1)
    const statuses = await occurrenceMigrations.getStatus(ctx, {
      migrations: sources,
      limit: sources.length,
    })
    const completed =
      statuses.length === sources.length &&
      statuses.every(
        (status) =>
          status.state === "success" &&
          status.isDone &&
          status.latestStart >= state.startedAt
      )
    await finishSliceOccurrenceMaintenance(ctx, completed)
  },
})

function sliceOccurrenceMaintenanceSeries(): MigrationFunctionReference[] {
  return [
    internal.lib.publishing.staging.backfillSliceOccurrenceSaved,
    internal.lib.publishing.staging.backfillSliceOccurrenceStaged,
    internal.lib.publishing.staging.backfillSliceOccurrenceShared,
    internal.lib.publishing.staging.backfillSliceOccurrenceDrafts,
    internal.lib.publishing.staging.backfillSliceOccurrenceCandidates,
    internal.lib.publishing.staging.backfillSliceOccurrenceSnapshots,
    internal.lib.publishing.staging.backfillSliceOccurrenceReferences,
    internal.lib.publishing.staging.backfillSliceOccurrenceSourceClosure,
    internal.lib.publishing.staging.prepareSliceOccurrenceIntegrity,
    internal.lib.publishing.staging.prepareSliceOccurrenceCounters,
    internal.lib.publishing.staging.tallySliceOccurrenceIntegrity,
    internal.lib.publishing.staging.tallySliceOccurrenceKeys,
    internal.lib.publishing.staging.verifySliceOccurrenceCounters,
    internal.lib.publishing.staging.finalizeSliceOccurrenceUsage,
  ]
}

const occurrenceMaintenanceMutation = customMutation(
  occurrenceUsageMutation,
  customCtx(async (ctx) => ({ owner: await requireOperationAccess(ctx) }))
)

export const startSliceOccurrenceUsageBackfill = occurrenceMaintenanceMutation({
  args: {
    mode: v.union(v.literal("backfill"), v.literal("verify")),
    restart: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { mode, restart }) => {
    const run = await beginSliceOccurrenceMaintenance(
      ctx,
      mode,
      restart ?? false
    )
    const series = sliceOccurrenceMaintenanceSeries()
    if (run.restart) {
      // Documented direct migration invocation: reset and next apply to the
      // entire native series, with one source document per source batch.
      const started: unknown = await ctx.runMutation(series[0], {
        cursor: null,
        dryRun: false,
        reset: true,
        next: series.slice(1).map((ref) => getFunctionName(ref)),
      })
      void started
    } else await occurrenceMigrations.runSerially(ctx, series)
    return null
  },
})
