import {
  Migrations,
  type MigrationFunctionReference,
} from "@convex-dev/migrations"
import { components, internal } from "../../_generated/api"
import type { DataModel, Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { v } from "convex/values"
import schema from "../../schema"
import { reconstructLocalePublicationCandidate } from "../publishing/localeCandidate"
import { occurrenceUsageInternalMutation } from "../publishing/staging"
import { internalMutation } from "../../_generated/server"
import {
  richTextImagesForSource,
  type PublicationSourceKind,
} from "./richTextImages"

/**
 * Backfill of rich-text image references (PERMANENT-DELETE).
 *
 * Publication now writes a `rich-text-image` media reference row for every
 * library image a rich-text field shows (`writeReferences`). Sources written
 * before that change have no such row. This migration adds the missing rows to
 * the four reference sources: Shared Drafts, locale drafts, Candidates and the
 * current Published Snapshots.
 *
 * INSERT ONLY (F08 clause 3): it never patches or deletes a reference row,
 * candidate payload, snapshot or digest. It is idempotent: a row for the same
 * media + source + path is never inserted twice, so a rerun inserts nothing.
 * Supported limit: a source holds at most 512 reference rows. A source whose
 * existing and missing rows together exceed that makes the migration FAIL (it
 * never skips), so `MEDIA_USAGE_INDEX_FAILED` keeps media purge refused.
 *
 * Running it: the migrations component is mounted in every install. The hourly
 * cron "rich-text image usage backfill" (`convex/crons.ts`) starts it, and so
 * does the first `purgeTrashedMedia` call that finds the backfill unfinished
 * (`startRichTextImageBackfill`). That call refuses with
 * `MEDIA_USAGE_INDEX_PENDING` until all four migrations report `success`.
 * A deployment administrator can also start it by hand:
 *   npx convex run lib/media/richTextBackfill:backfillRichTextImagesShared \
 *     '{"next":["lib/media/richTextBackfill:backfillRichTextImagesDrafts",
 *       "lib/media/richTextBackfill:backfillRichTextImagesCandidates",
 *       "lib/media/richTextBackfill:backfillRichTextImagesSnapshots"]}'
 * and read `npx convex run --component migrations lib:getStatus '{}'`.
 */
const mediaMigrations = new Migrations<DataModel, typeof schema>(
  components.migrations,
  { internalMutation: occurrenceUsageInternalMutation, schema }
)

/** Reference rows one source may hold (writeReferences refuses more). */
const REFERENCE_LIMIT = 512

type SourceRef = {
  pageId: Id<"pages">
  sourceKind: PublicationSourceKind
  sourceId: string
  locale?: string
  /** Source arm fields (`sourceGeneration`, `candidateDigest`, `publicGeneration`). */
  arm: Record<string, unknown>
}

/** Insert the rich-text image rows this source lacks. Returns rows inserted. */
async function insertMissingRows(
  ctx: MutationCtx,
  source: Doc<"pages">,
  ref: SourceRef
): Promise<number> {
  const wanted = await richTextImagesForSource(
    ctx,
    source,
    ref.locale,
    ref.sourceKind
  )
  if (wanted.length === 0) return 0
  // The whole bounded source range (the writer allows 512 rows per source).
  const existing = await ctx.db
    .query("pagePublicationMediaReferences")
    .withIndex("by_sourceKind_and_sourceId", (q) =>
      q.eq("sourceKind", ref.sourceKind).eq("sourceId", ref.sourceId as never)
    )
    .take(REFERENCE_LIMIT + 1)
  const have = new Set(
    existing
      .filter((row) => row.referenceKind === "rich-text-image")
      .map((row) => `${row.mediaId}\0${row.sourcePath}`)
  )
  const missing = wanted.filter(
    (item) => !have.has(`${item.mediaId}\0${item.path}`)
  )
  // A source this full cannot hold every image row (more than 500 references
  // on one source is not a supported input). Do not skip it: a skipped source
  // would let its images be deleted. Fail, so purge stays refused.
  if (
    existing.length > REFERENCE_LIMIT ||
    existing.length + missing.length > REFERENCE_LIMIT
  )
    throw new Error("MEDIA_BACKFILL_REFERENCE_LIMIT")
  const now = Date.now()
  let inserted = 0
  for (const item of missing) {
    const key = `${item.mediaId}\0${item.path}`
    if (have.has(key)) continue
    have.add(key)
    await ctx.db.insert("pagePublicationMediaReferences", {
      pageId: ref.pageId,
      ...(ref.locale ? { locale: ref.locale } : {}),
      sourceKind: ref.sourceKind,
      sourceId: ref.sourceId,
      ...ref.arm,
      mediaId: item.mediaId,
      storageId: item.storageId,
      sourcePath: item.path,
      referenceKind: "rich-text-image",
      createdAt: now,
      updatedAt: now,
    } as never)
    inserted += 1
  }
  return inserted
}

/** The page-shaped source `writeReferences` receives for a stored candidate. */
async function candidateSource(
  candidate: Doc<"pageLocalePublicationCandidates">
): Promise<Doc<"pages"> | null> {
  const payload = await reconstructLocalePublicationCandidate(candidate)
  if (!payload) return null
  return {
    _id: candidate.pageId,
    pageType: payload.page.pageType,
    ...payload.shared.descriptor,
    ...payload.shared.system,
    slug: payload.localized.slug,
    content: { [candidate.locale]: payload.localized.content },
  } as unknown as Doc<"pages">
}

export const backfillRichTextImagesShared = mediaMigrations.define({
  table: "pageSharedDrafts",
  batchSize: 20,
  migrateOne: async (ctx, draft) => {
    const page = await ctx.db.get("pages", draft.pageId)
    if (!page) return
    await insertMissingRows(
      ctx,
      {
        ...page,
        ...draft.descriptor,
        ...draft.system,
        content: {},
      } as unknown as Doc<"pages">,
      {
        pageId: draft.pageId,
        sourceKind: "shared_draft",
        sourceId: draft._id,
        arm: { sourceGeneration: draft.generation },
      }
    )
  },
})

export const backfillRichTextImagesDrafts = mediaMigrations.define({
  table: "pageLocaleDrafts",
  batchSize: 20,
  migrateOne: async (ctx, draft) => {
    const page = await ctx.db.get("pages", draft.pageId)
    if (!page) return
    await insertMissingRows(
      ctx,
      {
        ...page,
        content: { [draft.locale]: draft.content },
      } as unknown as Doc<"pages">,
      {
        pageId: draft.pageId,
        sourceKind: "locale_draft",
        sourceId: draft._id,
        locale: draft.locale,
        arm: { sourceGeneration: draft.generation },
      }
    )
  },
})

// A candidate payload is up to 512 KiB, so keep batches small.
export const backfillRichTextImagesCandidates = mediaMigrations.define({
  table: "pageLocalePublicationCandidates",
  batchSize: 8,
  migrateOne: async (ctx, candidate) => {
    const source = await candidateSource(candidate)
    if (!source) return
    await insertMissingRows(ctx, source, {
      pageId: candidate.pageId,
      sourceKind: "candidate",
      sourceId: candidate._id,
      locale: candidate.locale,
      arm: { candidateDigest: candidate.digest },
    })
  },
})

// Only the snapshot a locale currently serves has `current_public` rows.
export const backfillRichTextImagesSnapshots = mediaMigrations.define({
  table: "pagePublishedSnapshots",
  batchSize: 8,
  migrateOne: async (ctx, snapshot) => {
    const current = await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_currentSnapshotId", (q) =>
        q.eq("currentSnapshotId", snapshot._id)
      )
      .first()
    if (!current) return
    const candidate = await ctx.db.get(
      "pageLocalePublicationCandidates",
      snapshot.candidateId
    )
    if (!candidate) return
    const source = await candidateSource(candidate)
    if (!source) return
    await insertMissingRows(ctx, source, {
      pageId: snapshot.pageId,
      sourceKind: "current_public",
      sourceId: snapshot._id,
      locale: snapshot.locale,
      arm: { publicGeneration: snapshot.generation },
    })
  },
})

function series(): MigrationFunctionReference[] {
  return [
    internal.lib.media.richTextBackfill.backfillRichTextImagesShared,
    internal.lib.media.richTextBackfill.backfillRichTextImagesDrafts,
    internal.lib.media.richTextBackfill.backfillRichTextImagesCandidates,
    internal.lib.media.richTextBackfill.backfillRichTextImagesSnapshots,
  ]
}

export type RichTextBackfillState = "done" | "running" | "failed"

/**
 * `done` once every migration of the series reports `success`. `failed` when
 * one failed or was canceled (starting again resumes it). Anything else,
 * including "never started", is `running`.
 */
export async function richTextImageBackfillState(
  ctx: QueryCtx | MutationCtx
): Promise<RichTextBackfillState> {
  const refs = series()
  const statuses = await mediaMigrations.getStatus(ctx, {
    migrations: refs,
    limit: refs.length,
  })
  if (statuses.some((s) => s.state === "failed" || s.state === "canceled"))
    return "failed"
  return statuses.length === refs.length &&
    statuses.every((s) => s.state === "success" && s.isDone)
    ? "done"
    : "running"
}

/**
 * Start (or resume) the series. A series already running is left alone by the
 * component. Call it only from a mutation that then returns normally, because
 * a thrown error would roll the start back.
 */
export async function startRichTextImageBackfill(
  ctx: MutationCtx
): Promise<void> {
  await mediaMigrations.runSerially(ctx, series())
}

/**
 * Hourly cron entry (convex/crons.ts). Starts the series when it has not
 * started or has failed, so the usage index is ready before an owner first
 * deletes an image for good. One small status read once it is complete.
 * `purgeTrashedMedia` keeps the same start as a fallback.
 */
export const startRichTextImageBackfillIfNeeded = internalMutation({
  args: {},
  returns: v.union(v.literal("started"), v.literal("done")),
  handler: async (ctx) => {
    if ((await richTextImageBackfillState(ctx)) === "done") return "done"
    await startRichTextImageBackfill(ctx)
    return "started"
  },
})
