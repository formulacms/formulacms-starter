import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"
import { crossedReserve } from "./impactPreview"
import { defaultMigrationSeam } from "./defaultMigration"
import { readAuthorityRows } from "./state"

/**
 * M05 collection of unreachable default-migration generations and dead
 * preview disclosure pages (contract Delayed work `collectDefaultLanguageRoutes`,
 * M12, `siteLanguageDisclosurePages` lifetime; ledger C3c.2b). A step holds no
 * cursor: it deletes from the head of a range its own writes shrink. A
 * generation the pointer names, or the one a committed migration activated,
 * lies outside every collected range.
 */

/** Ledger C3c.2b Gap: each delete re-reads its document, so 127 rows fit 257. */
export const COLLECTION_ROUTE_BATCH = 127
/** Ledger C3c.2b Gap: 16 pages keep the re-read bytes near 2 MiB. */
export const COLLECTION_PAGE_BATCH = 16
/** Subjects per nightly sweep step (ledger C3c.2b Interpretation). */
export const COLLECTION_SWEEP_BATCH = 16

export type CollectionSection = "routes" | "pages"

export type CollectionArgs =
  | {
      migrationId: Id<"siteDefaultLanguageMigrations">
      section?: CollectionSection
      limit?: number
    }
  | { previewId: Id<"siteLanguageImpactPreviews">; limit?: number }

export type CollectionStepResult =
  | { kind: "noop" }
  | { kind: "stopped"; reason: "authority_invalid" | "pointed" | "reserve" }
  | { kind: "continue"; next: CollectionArgs }
  | { kind: "done"; deleted: number }

type Migration = Doc<"siteDefaultLanguageMigrations">
type Authority = Doc<"siteLanguageAuthority">

/**
 * The exclusive generation bound of a migration's collectable range, or null
 * when the authority's pointer makes the state invalid for collection.
 */
export function collectableBound(
  migration: Migration,
  authority: Authority
): number | null {
  const pointer = authority.continuityPointer
  if (
    pointer?.migrationId === migration._id &&
    (migration.phase !== "committed" ||
      pointer.generation !== migration.generation)
  ) {
    return null
  }
  return migration.phase === "cancelled"
    ? migration.generation + 1
    : migration.generation
}

function routeRange(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  bound: number
) {
  return ctx.db
    .query("siteDefaultLanguageRoutes")
    .withIndex("by_migrationId_and_generation", (q) =>
      q.eq("migrationId", migrationId).lt("generation", bound)
    )
}

function migrationPageRange(
  ctx: MutationCtx,
  migrationId: Id<"siteDefaultLanguageMigrations">,
  bound: number
) {
  return ctx.db
    .query("siteLanguageDisclosurePages")
    .withIndex("by_migrationId_and_generation_and_ordinal", (q) =>
      q.eq("migrationId", migrationId).lt("generation", bound)
    )
}

function previewPageRange(
  ctx: MutationCtx,
  previewId: Id<"siteLanguageImpactPreviews">
) {
  return ctx.db
    .query("siteLanguageDisclosurePages")
    .withIndex("by_previewId_and_ordinal", (q) => q.eq("previewId", previewId))
}

function isCollectablePreview(preview: Doc<"siteLanguageImpactPreviews">) {
  return preview.phase === "stale" || preview.phase === "expired"
}

/** Deletes a whole read batch, or nothing and a halved retry on a crossing. */
async function deleteBatch(
  ctx: MutationCtx,
  ids: Id<"siteDefaultLanguageRoutes" | "siteLanguageDisclosurePages">[],
  limit: number,
  retry: (limit: number) => CollectionArgs
): Promise<CollectionStepResult | null> {
  if (crossedReserve(await defaultMigrationSeam.metrics(ctx))) {
    if (limit <= 1) return { kind: "stopped", reason: "reserve" }
    return { kind: "continue", next: retry(Math.floor(limit / 2)) }
  }
  for (const id of ids) await ctx.db.delete(id)
  return null
}

/**
 * One bounded collection step: ≤ 3 queries (subject, authority, one range)
 * and ≤ 127 rows or 16 pages (ledger C3c.2b). The caller schedules `next`.
 */
export async function collectStepInTransaction(
  ctx: MutationCtx,
  args: CollectionArgs
): Promise<CollectionStepResult> {
  if ("previewId" in args) {
    const preview = await ctx.db.get(args.previewId)
    if (!preview || !isCollectablePreview(preview)) return { kind: "noop" }
    const limit = args.limit ?? COLLECTION_PAGE_BATCH
    const pages = await previewPageRange(ctx, preview._id).take(limit)
    const crossed = await deleteBatch(
      ctx,
      pages.map((page) => page._id),
      limit,
      (half) => ({ previewId: preview._id, limit: half })
    )
    if (crossed) return crossed
    return pages.length === limit
      ? { kind: "continue", next: { previewId: preview._id, limit } }
      : { kind: "done", deleted: pages.length }
  }

  const migration = await ctx.db.get(args.migrationId)
  if (!migration) return { kind: "noop" }
  const authorities = await readAuthorityRows(ctx)
  if (authorities.length !== 1) {
    return { kind: "stopped", reason: "authority_invalid" }
  }
  const bound = collectableBound(migration, authorities[0]!)
  if (bound === null) return { kind: "stopped", reason: "pointed" }
  const section = args.section ?? "routes"
  const limit =
    args.limit ??
    (section === "routes" ? COLLECTION_ROUTE_BATCH : COLLECTION_PAGE_BATCH)
  const rows =
    section === "routes"
      ? await routeRange(ctx, migration._id, bound).take(limit)
      : await migrationPageRange(ctx, migration._id, bound).take(limit)
  const crossed = await deleteBatch(
    ctx,
    rows.map((row) => row._id),
    limit,
    (half) => ({ migrationId: migration._id, section, limit: half })
  )
  if (crossed) return crossed
  if (rows.length === limit) {
    return {
      kind: "continue",
      next: { migrationId: migration._id, section, limit },
    }
  }
  if (section === "routes") {
    return {
      kind: "continue",
      next: { migrationId: migration._id, section: "pages" },
    }
  }
  return { kind: "done", deleted: rows.length }
}

// ─── Nightly sweep ──────────────────────────────────────────────────────────

export type SweepSection = "migrations" | "stale_previews" | "expired_previews"

export type SweepResult = {
  subjects: CollectionArgs[]
  next: { section: SweepSection; cursor: string | null } | null
}

const NEXT_SECTION: Record<SweepSection, SweepSection | null> = {
  migrations: "stale_previews",
  stale_previews: "expired_previews",
  expired_previews: null,
}

/**
 * One bounded sweep step (ledger C3c.2b Interpretation): one `.paginate()` of
 * 16 subjects, `take(1)` probes of each collectable range, and the subjects
 * that have something to collect. The caller schedules each and `next`.
 */
export async function sweepStepInTransaction(
  ctx: MutationCtx,
  section: SweepSection,
  cursor: string | null
): Promise<SweepResult> {
  const options = { numItems: COLLECTION_SWEEP_BATCH, cursor }
  const subjects: CollectionArgs[] = []
  let page: { isDone: boolean; continueCursor: string }
  if (section === "migrations") {
    const authorities = await readAuthorityRows(ctx)
    const result = await defaultMigrationSeam.paginate(
      ctx.db.query("siteDefaultLanguageMigrations"),
      options
    )
    page = result
    for (const migration of authorities.length === 1 ? result.page : []) {
      const bound = collectableBound(migration, authorities[0]!)
      if (bound === null) continue
      const hasGarbage =
        (await routeRange(ctx, migration._id, bound).take(1)).length > 0 ||
        (await migrationPageRange(ctx, migration._id, bound).take(1)).length > 0
      if (hasGarbage) subjects.push({ migrationId: migration._id })
    }
  } else {
    const phase = section === "stale_previews" ? "stale" : "expired"
    const result = await defaultMigrationSeam.paginate(
      ctx.db
        .query("siteLanguageImpactPreviews")
        .withIndex("by_phase_and_updatedAt", (q) => q.eq("phase", phase)),
      options
    )
    page = result
    for (const preview of result.page) {
      const [disclosure] = await previewPageRange(ctx, preview._id).take(1)
      if (disclosure) subjects.push({ previewId: preview._id })
    }
  }
  const following = NEXT_SECTION[section]
  const next = !page.isDone
    ? { section, cursor: page.continueCursor }
    : following
      ? { section: following, cursor: null }
      : null
  return { subjects, next }
}
