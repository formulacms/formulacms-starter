/**
 * PERMANENT-DELETE (Module 1): permanent purge of a trashed Page on a
 * snapshot-authority site.
 *
 * Interface (small): `checkPagePurge` (every refusal rule, read-only),
 * `assertNoPagePurge` (the writers' guard) and `runPurgeBatch` (one bounded
 * batch of the phase order below). The entry points live in
 * `convex/cms/publication.ts`; this module imports nothing from it.
 *
 * Why batches commit separately: a large Page cannot be deleted in one
 * transaction (16,000 written documents, 16 MiB). Block-occurrence counts are
 * the reason the unit of work is never smaller than "one source row plus every
 * reference row that describes it": the accounting compares a source with its
 * `pagePublicationBlockReferences` rows when it reconciles, so a half-removed
 * source would be marked invalid.
 */
import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { releaseBoundedPilotPageSlot } from "../pilotEnvelope"
import { walkCanonicalMenuTargets } from "../menu"
import { nextUpdatedAt } from "../versions"
import { recordPublicChange } from "../language/freshness"
import {
  readOpenDefaultMigration,
  readOpenTransition,
  readSiteLanguageState,
} from "../language/state"
import { deleteStagingByPageId, occurrenceUsageWrites } from "./staging"

type ReadCtx = QueryCtx | MutationCtx

// ─── Classification (the schema-closure test reads these) ──────────────────

/**
 * How one table relates to a Page id.
 *  - self:    the Page row itself.
 *  - owned:   rows that belong to the Page; the purge deletes them (phase).
 *  - blocks:  rows of OTHER things that point at the Page; the purge refuses
 *             while one exists (`checkPagePurge`).
 *  - kept:    rows that stay on purpose, each with the reason and the reader
 *             that was checked to tolerate a missing Page.
 */
export type PageKeyedRole =
  | { role: "self"; reason: string }
  | { role: "owned"; phase: PurgePhase; reason: string }
  | { role: "blocks"; reason: string }
  | { role: "kept"; reason: string }

export const PAGE_PURGE_PHASES = [
  "redirects",
  "presence",
  "previews",
  "intents",
  "routes",
  "snapshots",
  "releases",
  "candidates",
  "localeDrafts",
  "localeStates",
  "legacy",
  "menus",
  "sharedDraft",
  "final",
] as const
export type PurgePhase = (typeof PAGE_PURGE_PHASES)[number]

/** Every table with a `v.id("pages")` field, found by walking the schema. */
export const PAGE_KEYED_TABLES: Record<string, PageKeyedRole> = {
  pages: {
    role: "self",
    reason:
      "The Page row (`parentId` links point at other Pages: the children rule refuses while children exist).",
  },
  pageStaging: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy draft overlay.",
  },
  pageSharedDrafts: {
    role: "owned",
    phase: "sharedDraft",
    reason:
      "Shared draft; its `system.parentId` is the draft-side parent link (children rule).",
  },
  pageLocaleDrafts: {
    role: "owned",
    phase: "localeDrafts",
    reason: "Working drafts.",
  },
  pageSearch: { role: "owned", phase: "legacy", reason: "Search rows." },
  pageRevisions: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy revision history.",
  },
  pagePresence: {
    role: "owned",
    phase: "presence",
    reason: "Editor presence.",
  },
  pageEditorLocks: {
    role: "owned",
    phase: "presence",
    reason: "Editor locks.",
  },
  pagePublicationPageStates: {
    role: "owned",
    phase: "final",
    reason:
      "Lifecycle state; deleted last (address readers need it until then).",
  },
  pageLocalePublicationStates: {
    role: "owned",
    phase: "localeStates",
    reason: "Per-language publication state.",
  },
  pageLocalePublicationCandidates: {
    role: "owned",
    phase: "candidates",
    reason: "Immutable publication candidates (with their reference rows).",
  },
  pageLocalePublicationReleases: {
    role: "owned",
    phase: "releases",
    reason: "Release rows.",
  },
  pagePublishedSnapshots: {
    role: "owned",
    phase: "snapshots",
    reason: "Published Snapshots (with their reference rows).",
  },
  pageHistoricalLocaleRoutes: {
    role: "owned",
    phase: "routes",
    reason: "Retired addresses of the Page.",
  },
  pagePublicationDocumentReferences: {
    role: "blocks",
    reason:
      "`pageId` rows are owned (cleared with their source row). `targetId` rows from another Page block (incoming_links) when the owner can fix them: shared_draft, locale_draft, current_public, and candidate rows of a pending or held release. Candidate rows of old published versions stay as history.",
  },
  pagePublicationMediaReferences: {
    role: "owned",
    phase: "snapshots",
    reason:
      "Cleared with each source row (shared draft, draft, candidate, snapshot).",
  },
  pagePublicationBlockReferences: {
    role: "owned",
    phase: "snapshots",
    reason:
      "Cleared with each source row through the occurrence writer, in the same transaction.",
  },
  pagePublicationRevalidationIntents: {
    role: "owned",
    phase: "intents",
    reason:
      "Only `complete` rows are deleted. The worker waits at the start of the intents phase (and again in the final step) while a row is pending or running; failed rows stay until the existing drain finishes them (it never reads the Page).",
  },
  pagePublicationMigrationPages: {
    role: "owned",
    phase: "legacy",
    reason: "Snapshot migration manifest rows.",
  },
  pagePublicationPreviewSessions: {
    role: "owned",
    phase: "previews",
    reason: "Preview sessions.",
  },
  pagePublicationStates: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy publication state.",
  },
  pagePublicationCandidates: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy candidates.",
  },
  pagePublicationReleases: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy releases.",
  },
  pagePublicationExpiries: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy expiries.",
  },
  pageCandidateMediaReferences: {
    role: "owned",
    phase: "legacy",
    reason: "Deleted through the legacy candidate id.",
  },
  pageCandidateDocumentReferences: {
    role: "owned",
    phase: "legacy",
    reason:
      "Deleted through the legacy candidate id. `targetId` rows of other Pages are frozen since the cutover (legacy writers are blocked) and do not block.",
  },
  pageCandidateBlockReferences: {
    role: "owned",
    phase: "legacy",
    reason: "Deleted through the legacy candidate id.",
  },
  menuReferences: {
    role: "blocks",
    reason:
      "A live menu that links the Page blocks (menus). Soft-deleted menus hold no rows.",
  },
  mediaReferences: {
    role: "owned",
    phase: "legacy",
    reason: "Legacy image links.",
  },
  documentReferences: {
    role: "owned",
    phase: "legacy",
    reason:
      "`sourceId` rows are deleted (legacy phase). `targetId` rows of other Pages are frozen since the cutover and do not block.",
  },
  redirects: {
    role: "owned",
    phase: "redirects",
    reason:
      "Deleted in bounded worker batches (first phase). Creating a redirect to a Page with a marker is refused.",
  },
  aiJobs: {
    role: "kept",
    reason:
      "Job history. Readers tolerate a missing Page (aiJobs.ts reads the Page with a null check before use).",
  },
  aiJobUnits: {
    role: "kept",
    reason:
      "Job history. The Page id sits inside a stored block `output` (a link value); output is shown, never dereferenced.",
  },
  siteLanguageDisclosurePages: {
    role: "kept",
    reason:
      "Disclosure pages of a language preview or migration (`items[].pageId`); collection sweeps expire them and no reader loads the Page.",
  },
  siteSettings: {
    role: "blocks",
    reason: "`homePageId`: the home Page is refused (home).",
  },
  siteDefaultLanguageRoutes: {
    role: "kept",
    reason:
      "Closed-operation continuity row. Reader: readPublishedDestination (pages.ts) returns null for a missing Page, so the request ends historical_unavailable. An open operation blocks (language_operation).",
  },
  siteLanguageTransitionPages: {
    role: "kept",
    reason:
      "Closed-transition history. Readers (attributeSnapshot, transition report) only compare ids. An open transition blocks (language_operation).",
  },
  siteLanguageTransitionRoutes: {
    role: "kept",
    reason:
      "Closed-transition continuity row; same reader as siteDefaultLanguageRoutes.",
  },
  revalidationAttempts: {
    role: "kept",
    reason: "Delivery log; `target` is a log entry, never dereferenced.",
  },
  menus: {
    role: "owned",
    phase: "menus",
    reason:
      "`nav` internal targets (typed page ids). Live menus block (menus); soft-deleted menus have the link replaced by a placeholder.",
  },
  pagePurges: { role: "kept", reason: "The purge queue itself (marker row)." },
}

/**
 * Page ids that the schema walk cannot see (stored as strings or inside
 * free-form values). Each is declared by hand with the reason it is safe.
 */
export const PAGE_STRING_KEYED: Array<{ where: string; safe: string }> = [
  {
    where: "blockOccurrenceUsage.pageId (string) and blockOccurrenceUsage.key",
    safe: "Derived counts; every source row is removed through the occurrence writer, which drops its members and refcounts.",
  },
  {
    where: "blockOccurrenceSources.key / sourceId (`table:id`)",
    safe: "Removed by the same reconcile when the source row is deleted.",
  },
  {
    where: "menus.nav internal targets",
    safe: "Typed as v.id('pages'); live menus block, soft-deleted menus are rewritten (menus phase).",
  },
  {
    where:
      "revalidationAttempts.target / pagePublicationRevalidationIntents referrer paths",
    safe: "A delivery log entry or a path string; the drain posts paths and never reads the Page row.",
  },
  {
    where: "webhookDeliveries.payload",
    safe: "A stored delivery body (snapshot of an event), never dereferenced.",
  },
]

// ─── Tuning (the tests lower these) ────────────────────────────────────────

export const pagePurgeTuning = {
  /** Source rows (draft, candidate, snapshot) deleted per batch. */
  maxSourcesPerBatch: 10,
  /** Rows per plain index read. */
  rowsPerRead: 40,
}
export const PAGE_PURGE_MAX_BATCH_ITEMS = 25
export const PAGE_PURGE_MAX_FAILURES = 3
export const PAGE_PURGE_WAIT_MS = 30_000
export const PAGE_PURGE_STALE_MS = 10 * 60 * 1000

// ─── Marker helpers ────────────────────────────────────────────────────────

export async function readPagePurgeMarker(
  ctx: ReadCtx,
  pageId: Id<"pages">
): Promise<Doc<"pagePurges"> | null> {
  return ctx.db
    .query("pagePurges")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .first()
}

/** Writers call this before they make anything point at `pageId`. */
export async function assertNoPagePurge(
  ctx: ReadCtx,
  pageId: Id<"pages">
): Promise<void> {
  if (await readPagePurgeMarker(ctx, pageId))
    throw new ConvexError("PAGE_PURGE_IN_PROGRESS")
}

/**
 * Language, module and content-type operations start only when no purge has
 * started. A queued request (no `startedAt`) does not count: the daily batch
 * waits for an open language operation before it starts a purge instead.
 */
export async function assertNoPagePurgeInProgress(ctx: ReadCtx): Promise<void> {
  // The common case (no marker at all) stays one cheap read.
  if (!(await ctx.db.query("pagePurges").first())) return
  for await (const row of ctx.db
    .query("pagePurges")
    .withIndex("by_requestedAt")) {
    if (row.startedAt !== undefined)
      throw new ConvexError("PAGE_PURGE_IN_PROGRESS")
  }
}

// ─── Refusal rules ─────────────────────────────────────────────────────────

export type PagePurgeReason =
  | "children"
  | "incoming_links"
  | "menus"
  | "language_operation"
  | "not_trashed"
  | "stale"
  | "home"

export type PagePurgeDetail = {
  count?: number
  titles?: string[]
  menus?: string[]
}
export type PagePurgeRefusal = {
  reason: PagePurgeReason
  detail?: PagePurgeDetail
  /** Pages whose rows block (incoming_links only); the worker reads it, callers never return it. */
  blockers?: Id<"pages">[]
}

const DETAIL_LIMIT = 3
const SCAN_LIMIT = 512
/** Documents one closure scan may read before it refuses instead of passing. */
const SCAN_CAP = 6000
/** A scan stops early once this many distinct blockers are known. */
const BLOCKER_STOP = 25

/**
 * Reads an index range for rows whose Page is not excused. Excused rows are
 * skipped, never counted as a verdict. Returns true when the cap was hit
 * before the range ended (the caller must then refuse).
 */
async function scanBlockers<T>(
  rows: AsyncIterable<T>,
  pick: (row: T) => Id<"pages"> | null | Promise<Id<"pages"> | null>,
  found: Set<Id<"pages">>
): Promise<boolean> {
  let scanned = 0
  for await (const row of rows) {
    if (++scanned > SCAN_CAP) return true
    const id = await pick(row)
    if (id) found.add(id)
    if (found.size >= BLOCKER_STOP) return false
  }
  return false
}

export async function pageTitle(
  ctx: ReadCtx,
  pageId: Id<"pages">
): Promise<string> {
  const draft = await ctx.db
    .query("pageLocaleDrafts")
    .withIndex("by_pageId_and_updatedAt", (q) => q.eq("pageId", pageId))
    .order("desc")
    .first()
  const content = draft?.content as { title?: unknown } | undefined
  if (typeof content?.title === "string" && content.title.trim())
    return content.title.trim()
  const page = await ctx.db.get("pages", pageId)
  return page?.slug ?? String(pageId)
}

async function titlesOf(ctx: ReadCtx, ids: Iterable<Id<"pages">>) {
  const out: string[] = []
  for (const id of ids) {
    if (out.length >= DETAIL_LIMIT) break
    out.push(await pageTitle(ctx, id))
  }
  return out
}

/** The open language transition or default migration, if any. */
export async function languageOperationOpen(ctx: ReadCtx): Promise<boolean> {
  try {
    const state = await readSiteLanguageState(ctx)
    if (state.kind === "invalid") return true
    if (await readOpenTransition(ctx, state)) return true
    if (await readOpenDefaultMigration(ctx, state)) return true
    return false
  } catch {
    // Invalid authority state is never "no operation": refuse.
    return true
  }
}

/**
 * Read-only closure proof. `alsoPurging` holds the Pages that will be gone
 * before this one: a child or a referrer in the set does not block.
 * `expectedGeneration` (the start call) rejects a stale view of the Page.
 */
export async function checkPagePurge(
  ctx: ReadCtx,
  pageId: Id<"pages">,
  alsoPurging: ReadonlySet<Id<"pages">>,
  options: {
    expectedGeneration?: number
    strictChildren?: boolean
    /** The final step: a referrer that is only queued still blocks until its rows are gone. */
    strictLinks?: boolean
    /** A caller that checks many Pages reads the language state once. */
    languageOpen?: boolean
  } = {}
): Promise<PagePurgeRefusal | null> {
  const states = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  const page = await ctx.db.get("pages", pageId)
  if (states.length !== 1 || !page || states[0]!.lifecycleState !== "trashed")
    return { reason: "not_trashed" }
  if (
    options.expectedGeneration !== undefined &&
    states[0]!.lifecycleGeneration !== options.expectedGeneration
  )
    return { reason: "stale" }

  const settings = await ctx.db.query("siteSettings").take(2)
  if (settings.length === 1 && settings[0]!.homePageId === pageId)
    return { reason: "home" }

  if (options.languageOpen ?? (await languageOperationOpen(ctx)))
    return { reason: "language_operation" }

  // Children: the draft-side parent link and the legacy `pages.parentId`.
  // At the start, children selected together are ordered first, so they do
  // not block. The final re-check is strict: a child must already be gone.
  const childExcused = (id: Id<"pages">) =>
    id === pageId || (!options.strictChildren && alsoPurging.has(id))
  const children = new Set<Id<"pages">>()
  const childrenCapped =
    (await scanBlockers(
      ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_systemParentId", (q) => q.eq("system.parentId", pageId)),
      (row) => (childExcused(row.pageId) ? null : row.pageId),
      children
    )) ||
    (await scanBlockers(
      ctx.db
        .query("pages")
        .withIndex("by_parent", (q) => q.eq("parentId", pageId)),
      (row) => (childExcused(row._id) ? null : row._id),
      children
    ))
  if (children.size > 0 || childrenCapped)
    return {
      reason: "children",
      detail: { count: children.size, titles: await titlesOf(ctx, children) },
    }

  // Incoming links that the owner can still fix from the admin: draft links
  // (shared or locale), the current snapshot, and a candidate whose release is
  // scheduled (pending or held). Candidate rows of old published versions are
  // immutable history; they stay and point at a missing page (publishing a
  // restored old version then fails with PUBLICATION_REFERENCE_TARGET_MISSING).
  // The legacy reference tables are frozen since the cutover and never block.
  // Rows from Pages that go away first are skipped; a range too large to read
  // fully refuses (it never passes).
  const linkExcused = (id: Id<"pages">) =>
    id === pageId || (!options.strictLinks && alsoPurging.has(id))
  const scheduled = new Map<string, boolean>()
  const candidateScheduled = async (candidateId: string) => {
    const known = scheduled.get(candidateId)
    if (known !== undefined) return known
    const releases = await ctx.db
      .query("pageLocalePublicationReleases")
      .withIndex("by_candidateId", (q) =>
        q.eq(
          "candidateId",
          candidateId as Id<"pageLocalePublicationCandidates">
        )
      )
      .take(SCAN_LIMIT)
    const result = releases.some(
      (row) => row.status === "pending" || row.status === "held"
    )
    scheduled.set(candidateId, result)
    return result
  }
  const sources = new Set<Id<"pages">>()
  const linksCapped = await scanBlockers(
    ctx.db
      .query("pagePublicationDocumentReferences")
      .withIndex("by_targetId_and_sourceKind_and_locale", (q) =>
        q.eq("targetId", pageId)
      ),
    async (row) => {
      if (linkExcused(row.pageId)) return null
      if (row.sourceKind === "candidate")
        return (await candidateScheduled(row.sourceId)) ? row.pageId : null
      return row.pageId
    },
    sources
  )
  if (sources.size > 0 || linksCapped)
    return {
      reason: "incoming_links",
      detail: { count: sources.size, titles: await titlesOf(ctx, sources) },
      ...(linksCapped ? {} : { blockers: [...sources] }),
    }

  // Live menus.
  const slugs = new Set<string>()
  const seenMenus = new Set<Id<"menus">>()
  let menusScanned = 0
  for await (const row of ctx.db
    .query("menuReferences")
    .withIndex("by_target", (q) => q.eq("targetId", pageId))) {
    if (++menusScanned > SCAN_CAP) {
      slugs.add("…")
      break
    }
    if (seenMenus.has(row.menuId)) continue
    seenMenus.add(row.menuId)
    const menu = await ctx.db.get("menus", row.menuId)
    if (menu && menu.deletedAt === undefined) slugs.add(menu.slug)
  }
  if (slugs.size > 0)
    return {
      reason: "menus",
      detail: {
        count: slugs.size,
        menus: [...slugs].sort().slice(0, DETAIL_LIMIT),
      },
    }

  // Revalidation in flight never refuses the start: the worker waits for it
  // (`revalidationInFlight`) before it removes anything the drain still needs.
  return null
}

/**
 * True while a revalidation intent of the Page is `pending` or `running`.
 * `failed` and `complete` never count. The worker waits on this, the start
 * does not refuse on it.
 */
export async function revalidationInFlight(
  ctx: ReadCtx,
  pageId: Id<"pages">
): Promise<boolean> {
  const intents = ctx.db
    .query("pagePublicationRevalidationIntents")
    .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId))
  for await (const intent of intents) {
    if (intent.status === "pending" || intent.status === "running") return true
  }
  return false
}

/** Pages already queued and still moving (not stalled). */
export async function activeQueuedPageIds(
  ctx: ReadCtx
): Promise<Set<Id<"pages">>> {
  const out = new Set<Id<"pages">>()
  for await (const row of ctx.db
    .query("pagePurges")
    .withIndex("by_requestedAt")) {
    if (row.stalledAt === undefined) out.add(row.pageId)
  }
  return out
}

/** A menu write must not link a Page that is being purged. */
export async function assertNavNotLinkingPurgingPage(
  ctx: ReadCtx,
  nav: Parameters<typeof walkCanonicalMenuTargets>[0]
): Promise<void> {
  if (!(await ctx.db.query("pagePurges").first())) return
  for (const target of new Set(
    walkCanonicalMenuTargets(nav).map((entry) => entry.targetId)
  ))
    await assertNoPagePurge(ctx, target)
}

export type PurgeSelectionEntry = {
  pageId: Id<"pages">
  expectedGeneration?: number
}

/**
 * The start and the impact preview share this proof. A Page passes only if
 * every other Page it depends on in the selection also passes: the selection
 * is refined until it stops changing (a parent is refused when its selected
 * child is refused). Pages that already have a marker count as going away.
 */
export async function evaluatePurgeSelection(
  ctx: ReadCtx,
  entries: PurgeSelectionEntry[]
): Promise<Map<Id<"pages">, PagePurgeRefusal | null>> {
  const queued = await activeQueuedPageIds(ctx)
  const languageOpen = await languageOperationOpen(ctx)
  const result = new Map<Id<"pages">, PagePurgeRefusal | null>()
  const open = new Set<Id<"pages">>()
  for (const entry of entries) {
    if (queued.has(entry.pageId)) result.set(entry.pageId, null)
    else open.add(entry.pageId)
  }
  const expected = new Map(
    entries.map((entry) => [entry.pageId, entry.expectedGeneration])
  )
  for (;;) {
    const also = new Set<Id<"pages">>([...open, ...queued])
    let changed = false
    for (const pageId of [...open]) {
      const refusal = await checkPagePurge(ctx, pageId, also, {
        languageOpen,
        ...(expected.get(pageId) !== undefined
          ? { expectedGeneration: expected.get(pageId)! }
          : {}),
      })
      if (refusal) {
        open.delete(pageId)
        result.set(pageId, refusal)
        changed = true
      }
    }
    if (!changed) break
  }
  for (const pageId of open) result.set(pageId, null)
  return result
}

// ─── The worker's batch ────────────────────────────────────────────────────

type Budget = {
  sources: number
  maxSources: number
  /** True once this batch should stop and let the next one continue. */
  spent(): Promise<boolean>
}

function makeBudget(ctx: MutationCtx, maxSources: number): Budget {
  const budget: Budget = {
    sources: 0,
    maxSources,
    async spent() {
      if (budget.sources >= budget.maxSources) return true
      const m = await ctx.meta.getTransactionMetrics()
      // Stop at half of every limit: the deferred occurrence reconcile that
      // runs after the handler needs the other half.
      return [
        m.bytesRead,
        m.bytesWritten,
        m.databaseQueries,
        m.documentsRead,
        m.documentsWritten,
      ].some((metric) => metric.remaining < metric.used)
    },
  }
  return budget
}

type SourceKind =
  "shared_draft" | "locale_draft" | "candidate" | "current_public"
const REFERENCE_TABLES = [
  "pagePublicationDocumentReferences",
  "pagePublicationMediaReferences",
  "pagePublicationBlockReferences",
] as const

/** One source row and every reference row that describes it, together. */
async function deleteSource(
  ctx: MutationCtx,
  budget: Budget,
  sourceKind: SourceKind,
  table:
    | "pageSharedDrafts"
    | "pageLocaleDrafts"
    | "pageLocalePublicationCandidates"
    | "pagePublishedSnapshots",
  id: string
): Promise<void> {
  for (const refTable of REFERENCE_TABLES) {
    const rows = await ctx.db
      .query(refTable)
      .withIndex("by_sourceKind_and_sourceId", (q) =>
        q.eq("sourceKind", sourceKind).eq("sourceId", id as never)
      )
      .take(SCAN_LIMIT + 1)
    if (rows.length > SCAN_LIMIT)
      throw new ConvexError("PUBLICATION_REFERENCE_LIMIT")
    for (const row of rows)
      await occurrenceUsageWrites(ctx).delete(refTable, row._id as never)
  }
  await occurrenceUsageWrites(ctx).delete(table, id as never)
  budget.sources += 1
}

/**
 * Deletes rows read by `read` until none are left or the budget is spent.
 * Returns true when the range is empty.
 */
async function drain<T extends { _id: unknown }>(
  budget: Budget,
  read: () => Promise<T[]>,
  remove: (row: T) => Promise<void>
): Promise<boolean> {
  for (;;) {
    const rows = await read()
    if (rows.length === 0) return true
    for (const row of rows) await remove(row)
    if (await budget.spent()) return false
  }
}

/** Redirects to the Page, in batches; each batch frees its paths (route claims). */
async function drainRedirects(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  budget: Budget
): Promise<boolean> {
  const take = pagePurgeTuning.rowsPerRead
  const locales = new Set<string>()
  const done = await drain(
    budget,
    () =>
      ctx.db
        .query("redirects")
        .withIndex("by_toPageId", (q) => q.eq("toPageId", pageId))
        .take(take),
    async (row) => {
      locales.add(row.locale ?? "")
      await ctx.db.delete("redirects", row._id)
    }
  )
  // A removed redirect frees its path, as redirects.remove records.
  if (locales.size > 0)
    await recordPublicChange(ctx, {
      source: false,
      scopes: [...locales].map((locale) => ({
        ...(locale === "" ? {} : { locale }),
        domains: ["route_claims" as const],
      })),
    })
  return done
}

/** Only complete rows go; pending and running block, failed stay for the drain. */
async function drainCompleteIntents(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  budget: Budget
): Promise<boolean> {
  const take = pagePurgeTuning.rowsPerRead
  const rows = ctx.db
    .query("pagePublicationRevalidationIntents")
    .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId))
  let removed = 0
  for await (const row of rows) {
    if (row.status !== "complete") continue
    await ctx.db.delete("pagePublicationRevalidationIntents", row._id)
    if (++removed % take === 0 && (await budget.spent())) return false
  }
  return true
}

/** Presence rows and editor locks. A trashed Page still accepts both writes. */
async function drainEditorRows(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  budget: Budget
): Promise<boolean> {
  const take = pagePurgeTuning.rowsPerRead
  const presence = await drain(
    budget,
    () =>
      ctx.db
        .query("pagePresence")
        .withIndex("by_pageId_and_userId", (q) => q.eq("pageId", pageId))
        .take(take),
    async (row) => ctx.db.delete("pagePresence", row._id)
  )
  if (!presence) return false
  return drain(
    budget,
    () =>
      ctx.db
        .query("pageEditorLocks")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .take(take),
    async (row) => ctx.db.delete("pageEditorLocks", row._id)
  )
}

async function drainPreviewSessions(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  budget: Budget
): Promise<boolean> {
  return drain(
    budget,
    () =>
      ctx.db
        .query("pagePublicationPreviewSessions")
        .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId))
        .take(pagePurgeTuning.rowsPerRead),
    async (row) => ctx.db.delete("pagePublicationPreviewSessions", row._id)
  )
}

function replacePageTargets(
  nav: unknown,
  pageId: Id<"pages">
): { nav: unknown; changed: boolean } {
  let changed = false
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      if (record.type === "internal" && record.pageId === pageId) {
        changed = true
        return { type: "placeholder" }
      }
      return Object.fromEntries(
        Object.entries(record).map(([key, child]) => [key, visit(child)])
      )
    }
    return value
  }
  return { nav: visit(nav), changed }
}

export type PurgeBatchResult = {
  phase: PurgePhase
  finished: boolean
  /** Set when the closure re-check wants the worker to wait or to stop. */
  hold?: { kind: "wait" | "stop"; reason: string }
}

async function otherActivePurges(
  ctx: ReadCtx,
  pageId: Id<"pages">
): Promise<Set<Id<"pages">>> {
  const out = new Set<Id<"pages">>()
  for await (const row of ctx.db
    .query("pagePurges")
    .withIndex("by_requestedAt")) {
    if (row.pageId !== pageId && row.stalledAt === undefined)
      out.add(row.pageId)
  }
  return out
}

async function runPhase(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  phase: PurgePhase,
  budget: Budget,
  hold: (h: NonNullable<PurgeBatchResult["hold"]>) => void
): Promise<boolean> {
  const take = pagePurgeTuning.rowsPerRead
  switch (phase) {
    case "presence":
      return drainEditorRows(ctx, pageId, budget)
    case "previews":
      return drainPreviewSessions(ctx, pageId, budget)
    case "redirects":
      return drainRedirects(ctx, pageId, budget)
    case "intents":
      // The revalidation drain still reads this Page's intent rows (and the
      // reference rows its later phases delete). Wait here, before the first
      // phase that removes them; the start never refuses on it.
      if (await revalidationInFlight(ctx, pageId)) {
        hold({ kind: "wait", reason: "revalidation_pending" })
        return false
      }
      return drainCompleteIntents(ctx, pageId, budget)
    case "routes":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageHistoricalLocaleRoutes")
            .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pageHistoricalLocaleRoutes", row._id)
      )
    case "snapshots":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pagePublishedSnapshots")
            .withIndex("by_pageId_and_locale_and_generation", (q) =>
              q.eq("pageId", pageId)
            )
            .take(1),
        (row) =>
          deleteSource(
            ctx,
            budget,
            "current_public",
            "pagePublishedSnapshots",
            row._id
          )
      )
    case "releases":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageLocalePublicationReleases")
            .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pageLocalePublicationReleases", row._id)
      )
    case "candidates":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageLocalePublicationCandidates")
            .withIndex("by_pageId_and_locale_and_createdAt", (q) =>
              q.eq("pageId", pageId)
            )
            .take(1),
        (row) =>
          deleteSource(
            ctx,
            budget,
            "candidate",
            "pageLocalePublicationCandidates",
            row._id
          )
      )
    case "localeDrafts":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageLocaleDrafts")
            .withIndex("by_pageId_and_updatedAt", (q) => q.eq("pageId", pageId))
            .take(1),
        (row) =>
          deleteSource(ctx, budget, "locale_draft", "pageLocaleDrafts", row._id)
      )
    case "localeStates":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) =>
          occurrenceUsageWrites(ctx).delete(
            "pageLocalePublicationStates",
            row._id
          )
      )
    case "legacy":
      return runLegacy(ctx, pageId, budget)
    case "menus": {
      for await (const menu of ctx.db.query("menus")) {
        if (menu.deletedAt === undefined) continue
        const rewritten = replacePageTargets(menu.nav, pageId)
        if (!rewritten.changed) continue
        await ctx.db.patch("menus", menu._id, {
          nav: rewritten.nav as Doc<"menus">["nav"],
          updatedAt: nextUpdatedAt(menu.updatedAt, Date.now()),
        })
      }
      return true
    }
    case "sharedDraft":
      return drain(
        budget,
        () =>
          ctx.db
            .query("pageSharedDrafts")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(1),
        (row) =>
          deleteSource(ctx, budget, "shared_draft", "pageSharedDrafts", row._id)
      )
    case "final":
      return runFinal(ctx, pageId, hold)
  }
}

/** Legacy tables, each bounded. Candidate reference rows go by candidate id. */
async function runLegacy(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  budget: Budget
): Promise<boolean> {
  const take = pagePurgeTuning.rowsPerRead
  const staging = await ctx.db
    .query("pageStaging")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .first()
  if (staging) {
    await deleteStagingByPageId(ctx, pageId)
    budget.sources += 1
  }
  const simple: Array<() => Promise<boolean>> = [
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pageSearch")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pageSearch", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pageRevisions")
            .withIndex("by_pageId_and_revisionNumber", (q) =>
              q.eq("pageId", pageId)
            )
            .take(take),
        async (row) => ctx.db.delete("pageRevisions", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("mediaReferences")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("mediaReferences", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("documentReferences")
            .withIndex("by_source", (q) => q.eq("sourceId", pageId))
            .take(take),
        async (row) => ctx.db.delete("documentReferences", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pagePublicationMigrationPages")
            .withIndex("by_pageId_and_run", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pagePublicationMigrationPages", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pagePublicationStates")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pagePublicationStates", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pagePublicationReleases")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pagePublicationReleases", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pagePublicationExpiries")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(take),
        async (row) => ctx.db.delete("pagePublicationExpiries", row._id)
      ),
    () =>
      drain(
        budget,
        () =>
          ctx.db
            .query("pagePublicationCandidates")
            .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
            .take(1),
        async (candidate) => {
          for (const table of [
            "pageCandidateMediaReferences",
            "pageCandidateDocumentReferences",
            "pageCandidateBlockReferences",
          ] as const) {
            const rows = await ctx.db
              .query(table)
              .withIndex("by_candidateId", (q) =>
                q.eq("candidateId", candidate._id)
              )
              .take(SCAN_LIMIT + 1)
            if (rows.length > SCAN_LIMIT)
              throw new ConvexError("PUBLICATION_REFERENCE_LIMIT")
            for (const row of rows)
              await occurrenceUsageWrites(ctx).delete(table, row._id)
          }
          await ctx.db.delete("pagePublicationCandidates", candidate._id)
        }
      ),
  ]
  for (const step of simple) if (!(await step())) return false
  return !(await ctx.db
    .query("pageStaging")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .first())
}

/**
 * The point of no return. Re-proves the closure first (a menu save or a draft
 * could have pointed at the Page since the start), then removes the lifecycle
 * state, the pilot slot, the Page row and the marker in one transaction.
 */
async function runFinal(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  hold: (h: NonNullable<PurgeBatchResult["hold"]>) => void
): Promise<boolean> {
  const queued = await otherActivePurges(ctx, pageId)
  const refusal = await checkPagePurge(ctx, pageId, queued, {
    strictChildren: true,
    strictLinks: true,
  })
  if (refusal) {
    // Language operations end by themselves; a child that is still queued
    // will be gone first once the worker reaches it. Everything else is a
    // real new reference: stop and keep the marker.
    const waits =
      refusal.reason === "language_operation" ||
      (refusal.reason === "children" &&
        (await childrenAllQueued(ctx, pageId, queued))) ||
      // A queued referrer drains its own link rows in its earlier phases, so
      // waiting for the rows (never for the page to vanish) cannot deadlock.
      (refusal.reason === "incoming_links" &&
        (refusal.blockers?.length ?? 0) > 0 &&
        refusal.blockers!.every((id) => queued.has(id)))
    hold({ kind: waits ? "wait" : "stop", reason: refusal.reason })
    return false
  }
  // Revalidation that started after the intents phase ends by itself.
  if (await revalidationInFlight(ctx, pageId)) {
    hold({ kind: "wait", reason: "revalidation_pending" })
    return false
  }
  // A trashed Page still accepts presence, editor-lock and preview writes, so
  // the last batch clears them again in the same transaction that deletes it.
  const lateBudget = makeBudget(ctx, Number.MAX_SAFE_INTEGER)
  if (
    !(await drainEditorRows(ctx, pageId, lateBudget)) ||
    !(await drainPreviewSessions(ctx, pageId, lateBudget)) ||
    // Intents that finished after the intents phase (a late withdrawal, a
    // retried failure) are removed here, in the transaction that ends the Page.
    !(await drainCompleteIntents(ctx, pageId, lateBudget))
  )
    return false
  const states = await ctx.db
    .query("pagePublicationPageStates")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .take(2)
  for (const state of states)
    await occurrenceUsageWrites(ctx).delete(
      "pagePublicationPageStates",
      state._id
    )
  const page = await ctx.db.get("pages", pageId)
  if (page) {
    await releaseBoundedPilotPageSlot(ctx, page.status === "published")
    await occurrenceUsageWrites(ctx).delete("pages", pageId)
  }
  const marker = await readPagePurgeMarker(ctx, pageId)
  if (marker) await ctx.db.delete("pagePurges", marker._id)
  return true
}

async function childrenAllQueued(
  ctx: ReadCtx,
  pageId: Id<"pages">,
  queued: ReadonlySet<Id<"pages">>
): Promise<boolean> {
  const children = new Set<Id<"pages">>()
  const excused = (id: Id<"pages">) => id === pageId
  const capped =
    (await scanBlockers(
      ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_systemParentId", (q) => q.eq("system.parentId", pageId)),
      (row) => (excused(row.pageId) ? null : row.pageId),
      children
    )) ||
    (await scanBlockers(
      ctx.db
        .query("pages")
        .withIndex("by_parent", (q) => q.eq("parentId", pageId)),
      (row) => (excused(row._id) ? null : row._id),
      children
    ))
  return (
    !capped && children.size > 0 && [...children].every((id) => queued.has(id))
  )
}

/**
 * Runs phases from `fromPhase` until the batch budget is spent, a phase asks
 * the worker to hold, or the Page is gone. Everything it writes commits
 * together; the caller catches a throw and keeps the marker.
 */
export async function runPurgeBatch(
  ctx: MutationCtx,
  pageId: Id<"pages">,
  fromPhase: string,
  maxSources: number
): Promise<PurgeBatchResult> {
  const budget = makeBudget(ctx, maxSources)
  let index = Math.max(0, PAGE_PURGE_PHASES.indexOf(fromPhase as PurgePhase))
  const held: { value?: NonNullable<PurgeBatchResult["hold"]> } = {}
  for (; index < PAGE_PURGE_PHASES.length; index += 1) {
    const phase = PAGE_PURGE_PHASES[index]!
    const done = await runPhase(ctx, pageId, phase, budget, (h) => {
      held.value = h
    })
    if (held.value) return { phase, finished: false, hold: held.value }
    if (!done) return { phase, finished: false }
    if (phase === "final") return { phase, finished: true }
    // The "final" phase runs in a batch of its own, after a fresh budget.
    if (PAGE_PURGE_PHASES[index + 1] === "final")
      return { phase: "final", finished: false }
    if (await budget.spent())
      return { phase: PAGE_PURGE_PHASES[index + 1]!, finished: false }
  }
  return { phase: "final", finished: true }
}
