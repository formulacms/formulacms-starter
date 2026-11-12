import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import { contentTypeDefs } from "../contentTypes"
import type { PageRevisionChecklistSnapshot } from "./checklist"

export type { PageRevisionChecklistSnapshot }

/**
 * Publishing pipeline: revision history (plan 028 C0).
 *
 * ADR-0029 — revisions archive their content as a serialized JSON string, NOT
 * as a record validated against the live closed slice union. This decouples
 * history from the live schema so shrinking the union (deleting a slice type)
 * can never retroactively invalidate old revisions and block a deploy.
 */

export const MAX_PAGE_REVISIONS = 50

// ADR-0041 Deploy 3 (Narrow) — mirrors the shrunken
// `pageRevisionReasonValidator` union in `convex/schema.ts`.
export type PageRevisionReason =
  "manual_save" | "publish" | "scheduled_publish" | "scheduled_expiry"

/**
 * Permissive per-locale content bag for a revision snapshot.
 *
 * ADR-0029 — revisions are heterogeneous by design: an archived JSON blob
 * may carry any registered descriptor's localized fields, plus keys from
 * a since-retired descriptor. The live per-arm shape (post's
 * `{title, metaTitle, metaDescription, slices}`, testimonial's
 * `{title, quote}`, …) is enforced on the LIVE `pages.content` row, not
 * here.
 *
 * All named fields are optional; `[key: string]: unknown` keeps drifted
 * descriptor keys visible to readers who walk the bag by descriptor
 * (e.g. `compareRevisionContent` in
 * `components/admin/page-editor/lib/revision-diff.ts`).
 *
 * Plan 029 C10 task 8 continuation: widened from
 * `Doc<"pages">["content"][string]` because the strict per-arm union
 * lost `.slices` / `.metaTitle` on the testimonial arm, breaking every
 * historical revision reader.
 */
export interface RevisionLocalizedContent {
  title?: string
  metaTitle?: string
  metaDescription?: string
  /** Opaque history keeps unavailable slice records visible for inspection. */
  slices?: unknown[]
  [key: string]: unknown
}

export type RevisionContentRecord =
  Record<string, RevisionLocalizedContent> | undefined

export function serializeRevisionContent(
  content: RevisionContentRecord
): string {
  return JSON.stringify(content ?? {})
}

/**
 * Return the descriptor sharedField keys for a page's type, excluding
 * system-owned fields. C9b archives ONLY the descriptor-declared shared
 * fields — `slug`/`status`/`scheduledAt`/hierarchy live on `systemPageFields`
 * with their own archival paths (columns on the revision row directly), and
 * cross-cutting shared fields the system UX owns (`tags`, `authorIds`) also
 * skip archival so restore preserves current no-revert behavior; upgrading
 * those to full round-trip is a follow-up.
 */
const REVISION_SYSTEM_OWNED_SHARED_KEYS: ReadonlySet<string> = new Set([
  "tags",
  "authorIds",
])

/**
 * List the descriptor shared-field keys eligible for revision archival for a
 * given page type. Returns an empty array for unknown types (defensive:
 * revisions may pre-date a type being removed from the registry, and the
 * writer must not throw on the archival path).
 */
export function descriptorArchivableSharedKeys(pageType: string): string[] {
  const descriptor = (
    contentTypeDefs as Record<string, { sharedFields: Record<string, unknown> }>
  )[pageType]
  if (!descriptor) return []
  return Object.keys(descriptor.sharedFields).filter(
    (key) => !REVISION_SYSTEM_OWNED_SHARED_KEYS.has(key)
  )
}

/**
 * Extract the descriptor shared-field bag from a page row and serialize as
 * JSON. Every archivable key is written even when undefined so History's
 * `parseRevisionSharedFields` (`convex/cms/pageHistory.ts`) can distinguish
 * "cleared at this revision" from "descriptor field didn't exist yet". Empty
 * bag → `null` so
 * downstream `sharedFieldsJson` can stay absent for zero-shared types.
 */
export function serializeRevisionSharedFields(
  page: Doc<"pages">
): string | null {
  const keys = descriptorArchivableSharedKeys(page.pageType)
  if (keys.length === 0) return null
  const bag: Record<string, unknown> = {}
  const row = page as unknown as Record<string, unknown>
  for (const key of keys) {
    // Write the value verbatim (undefined stays as undefined via omission;
    // null persists as null-cleared). Downstream parsing distinguishes
    // "was cleared" (null) from "not archived" (absent).
    bag[key] = row[key] ?? null
  }
  return JSON.stringify(bag)
}

export async function nextRevisionNumber(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">
): Promise<number> {
  const latest = await ctx.db
    .query("pageRevisions")
    .withIndex("by_pageId_and_revisionNumber", (q) => q.eq("pageId", pageId))
    .order("desc")
    .first()
  return (latest?.revisionNumber ?? 0) + 1
}

function pickPageTitle(page: Doc<"pages">): string {
  const first = Object.values(page.content ?? {})[0]
  return first?.title || "Untitled"
}

export async function createPageRevision(
  ctx: MutationCtx,
  page: Doc<"pages">,
  reason: PageRevisionReason,
  createdBy: string | undefined,
  summary: string[],
  checklist?: PageRevisionChecklistSnapshot
): Promise<void> {
  const revisionNumber = await nextRevisionNumber(ctx, page._id)
  const sharedFieldsJson = serializeRevisionSharedFields(page)
  await ctx.db.insert("pageRevisions", {
    pageId: page._id,
    revisionNumber,
    createdAt: Date.now(),
    createdBy,
    reason,
    status: page.status,
    slug: page.slug,
    pageType: page.pageType,
    contentJson: serializeRevisionContent(page.content),
    ...(sharedFieldsJson !== null ? { sharedFieldsJson } : {}),
    localizedSlugs: page.localizedSlugs,
    seo: page.seo,
    metadata: {
      title: pickPageTitle(page),
      locales: Object.keys(page.content ?? {}).sort(),
      summary,
      ...(checklist !== undefined ? { checklist } : {}),
    },
  })

  if (revisionNumber <= MAX_PAGE_REVISIONS) return
  const oldestRevisionToKeep = revisionNumber - MAX_PAGE_REVISIONS + 1
  const oldRevisions = await ctx.db
    .query("pageRevisions")
    .withIndex("by_pageId_and_revisionNumber", (q) =>
      q.eq("pageId", page._id).lt("revisionNumber", oldestRevisionToKeep)
    )
    .take(100)
  await Promise.all(
    oldRevisions.map((revision) => ctx.db.delete("pageRevisions", revision._id))
  )
}
