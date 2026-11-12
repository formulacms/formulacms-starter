// convex/cms/tags.ts
//
// Shared content-tag pool for pages and media. The canonical slug is what gets
// stored on `pages.tags` / `media.tags` and what descriptor code references
// via `relation({ tag })` — `label` is editor-facing only. Slug renames are
// intentionally not supported in v1 (they'd require coordinated code + data
// migration across stored arrays and descriptors); only label edits are.
//
// Naming note: `lib/cms/tags.ts` is the unrelated Next.js cache-tag contract.
// Surface this module as "content tags" in UI to avoid confusion.

import { ConvexError, v } from "convex/values"
import type { Doc } from "../_generated/dataModel"
import {
  type MutationCtx,
  internalMutation,
  mutation,
  query,
} from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import { TAG_SLUG_MAX_LENGTH, normalizeTagSlug } from "../../lib/cms/tag-slug"
import { assertLegacyPublicationWriterBlocked } from "../lib/publishing/snapshots"

// Re-export the isomorphic helpers so existing imports keep working. The real
// implementations live in `lib/cms/tag-slug.ts` so client components can
// consume them without pulling in the Convex server SDK.
export { TAG_SLUG_MAX_LENGTH, normalizeTagSlug }

/** Editor-facing label cleanup: trim + collapse whitespace, preserve casing. */
function normalizeLabel(input: string): string {
  return input.trim().replace(/\s+/g, " ")
}

/**
 * Autocomplete-friendly list. Returns tags sorted by label, optionally
 * filtered by a case-insensitive substring of `slug` or `label`.
 */
export const list = query({
  args: {
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id("tags"),
      slug: v.string(),
      label: v.string(),
      description: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, { search, limit }) => {
    await requireOperationAccess(ctx)
    let rows: Doc<"tags">[] = await ctx.db.query("tags").collect()
    const needle = search?.trim().toLowerCase()
    if (needle) {
      rows = rows.filter(
        (r) => r.slug.includes(needle) || r.label.toLowerCase().includes(needle)
      )
    }
    rows.sort((a, b) => a.label.localeCompare(b.label))
    const cap = limit ?? 50
    return rows.slice(0, cap).map((r) => ({
      _id: r._id,
      slug: r.slug,
      label: r.label,
      description: r.description ?? null,
    }))
  },
})

/**
 * Normalizes each label to a slug, inserts any missing tag rows, and returns
 * the canonical slug array in the input order. Idempotent: duplicate labels in
 * a single call collapse to one slug; calling twice with the same input does
 * not create extra rows. Labels that normalize to `null` (empty/punct-only)
 * are dropped from the result.
 *
 * Preferred call site: server-side inside the page/media update mutations,
 * so the invariant "stored tags always exist in the tags table" lives in one
 * place instead of being a client contract.
 */
export const ensureMany = internalMutation({
  args: {
    labels: v.array(v.string()),
  },
  returns: v.array(v.string()),
  handler: async (ctx, { labels }) => {
    await requireOperationAccess(ctx)
    return ensureTagsForLabels(ctx, labels)
  },
})

/**
 * Shared helper for mutations that store tags on another entity (pages, media).
 * Normalizes the supplied labels, inserts any missing tag rows, and returns the
 * canonical slug array in input order. Callers should call this **before**
 * patching the host doc so a failed ensure surfaces before the host write.
 *
 * Uses the F01 operation seam — the host mutation is expected to
 * have its own operation gate (`pages:update`, `media:update`, …) which is the
 * authoritative check for whether the caller may write tags onto that entity.
 */
export async function ensureTagsForLabels(
  ctx: MutationCtx,
  labels: string[]
): Promise<string[]> {
  const auth = await ctx.auth.getUserIdentity()
  const now = Date.now()
  const result: string[] = []
  const seen = new Set<string>()

  for (const raw of labels) {
    const slug = normalizeTagSlug(raw)
    if (!slug) continue
    if (seen.has(slug)) continue
    seen.add(slug)

    const existing = await ctx.db
      .query("tags")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique()
    if (!existing) {
      await ctx.db.insert("tags", {
        slug,
        label: normalizeLabel(raw) || slug,
        createdAt: now,
        createdBy: auth?.tokenIdentifier,
        updatedAt: now,
      })
    }
    result.push(slug)
  }
  return result
}

/**
 * Update a tag's editor-facing label (and optionally its description). Slugs
 * are deliberately frozen post-creation — see module header.
 */
export const rename = mutation({
  args: {
    id: v.id("tags"),
    label: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { id, label, description }) => {
    await requireOperationAccess(ctx)
    const cleaned = normalizeLabel(label)
    if (!cleaned) {
      throw new ConvexError("Label cannot be empty")
    }
    await ctx.db.patch(id, {
      label: cleaned,
      description: description?.trim() || undefined,
      updatedAt: Date.now(),
    })
    return null
  },
})

/**
 * One-shot backfill — walks every `pages` or `media` doc, normalizes their
 * existing `tags` arrays to canonical slugs, ensures the `tags` table contains
 * a row for each (using the original casing as the seed label), and writes the
 * normalized array back. Idempotent: re-running after backfill is a no-op
 * because already-normalized arrays compare equal.
 *
 * Convex allows only one paginated query per mutation, so callers run the
 * `pages` and `media` tables separately. Invoke once per table (call twice
 * total), each in turn re-called with the returned `nextCursor` until `null`.
 *
 * Usage (Convex dashboard or `npx convex run`):
 *   internal.cms.tags.backfill { target: "pages" }
 *   internal.cms.tags.backfill { target: "media" }
 */
export const backfill = internalMutation({
  args: {
    target: v.union(v.literal("pages"), v.literal("media")),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    target: v.union(v.literal("pages"), v.literal("media")),
    patched: v.number(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { target, cursor, batchSize }) => {
    if (target === "pages") {
      await assertLegacyPublicationWriterBlocked(ctx, "tags.backfill.pages")
    }
    const cap = batchSize ?? 200
    const page = await ctx.db
      .query(target)
      .paginate({ numItems: cap, cursor: cursor ?? null })

    let patched = 0
    for (const doc of page.page) {
      // `tags` exists on the media arm and on the `post` page arm only.
      // Landing-page and page arms do not carry tags after plan 028 C1.
      const isPageDoc = target === "pages"
      const hasTags = !isPageDoc || (isPageDoc && "tags" in doc)
      if (!hasTags) continue
      const tags = (doc as { tags?: string[] }).tags
      if (!tags || tags.length === 0) continue
      const slugs = await ensureTagsForLabels(ctx, tags)
      const unchanged =
        slugs.length === tags.length && slugs.every((s, i) => s === tags?.[i])
      if (!unchanged) {
        await ctx.db.patch(doc._id, { tags: slugs })
        patched++
      }
    }

    return {
      target,
      patched,
      nextCursor: page.isDone ? null : page.continueCursor,
    }
  },
})
