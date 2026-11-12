import { v } from "convex/values"
import { query } from "../_generated/server"
import { requireOperationAccess } from "../lib/access/policy"
import {
  CONTENT_TYPES,
  contentTypeDefs,
  isActiveContentType,
  type ContentType,
} from "../lib/contentTypes"
import { resolveReferenceCardForDoc } from "../lib/contentTypes/resolve"
import { pageTypeValidator } from "../lib/pages/types"
import type { PageType } from "../lib/pages/types"
import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { readPublicationAuthority } from "../lib/publishing/snapshots"
import { snapshotPickerRowForPage, type PagePickerRow } from "./pages"

/**
 * Relation-picker query surface (plan 028 C2, ADR-0037).
 *
 * Backs the admin `RelationPicker` component. Given a set of allowed target
 * content types (declared by a descriptor's `relation({ pageTypes })` field),
 * returns a compact list of `ReferenceCard`s the editor picks from.
 *
 * Filtering:
 *   - Constrained by the caller's `pageTypes` argument (the descriptor's
 *     allowlist for that relation field).
 *   - Restricted to the active Community content catalog. Registered-only
 *     storage arms never enter ordinary picker results.
 *   - `routableOnly=true` (menus / redirects / homepage pickers) drops
 *     non-routable types so the caller can't select an unreachable URL target.
 *   - Deleted (`deletedAt != null`) rows are always excluded.
 *   - Drafts + archived rows are included by default — an editor may prepare
 *     a not-yet-published reference. The public renderer's `resolveReferenceCard`
 *     invariant (no `href` on drafts) prevents leakage at read time.
 *
 * Search: prefix / substring match on the resolved card title. Simple in-memory
 * filter over a bounded fetch — good enough for the picker's typeahead until
 * the picker moves to the full-text `pageSearch` index in a follow-up.
 *
 * Fairness across allowed types: each type gets its own per-type cap that
 * matches the final `limit`, so a dense first type can't crowd out later
 * types the caller also asked about (regression: a `.slice(0, limit)` on
 * concatenated per-type results hid landing-page targets whenever the post
 * scan filled the window).
 */

const PICKER_LIMIT_MAX = 50
const PICKER_LIMIT_DEFAULT = 20
const PICKER_SCAN_MULTIPLIER = 4
// Under snapshot authority every scanned page is projected from its
// per-language drafts and snapshots (about 4 + 2 reads per language), so one
// call projects at most this many pages, shared fairly between the types.
const SNAPSHOT_PROJECTION_BUDGET = 100

// `type` stays `v.string()` because the shared `ReferenceCard` domain type in
// `convex/lib/contentTypes/types.ts` also carries `type: string` — narrowing
// the validator without narrowing the domain type breaks Convex's return-type
// check. Tightening to `pageTypeValidator` on both sides is deferred to C6
// (vocabulary sweep) alongside the descriptor-registry cleanup, so callers
// switching on `card.type === "post"` today rely on the descriptor honoring
// its own slug — a lightweight test in C5 will lock this contract.
const referenceCardValidator = v.object({
  id: v.id("pages"),
  type: v.string(),
  title: v.string(),
  titleFallback: v.optional(v.literal("untitled")),
  subtitle: v.optional(v.string()),
  href: v.optional(v.string()),
  imageMediaId: v.optional(v.id("media")),
  // Plan 029 C10 task 15: `ReferenceCard.featured` (types.ts) has carried
  // this since an earlier C10 task, but this validator never declared it —
  // every post resolved through `getReferenceCard` / `searchTargets` threw
  // "Unexpected field `featured`" the moment a real caller hit this path
  // (see convex/relations.test.ts). Optional so cards from descriptors that
  // never set it (author, page, …) are unaffected.
  featured: v.optional(v.boolean()),
})

type ResolvedCard = NonNullable<ReturnType<typeof resolveReferenceCardForDoc>>

/**
 * Snapshot authority keeps titles and publication state in per-language
 * drafts and Published Snapshots; the `pages` row has no `content` and stays
 * "draft". Resolve the descriptor's card from a copy of the row that carries
 * the snapshot title, address and state for this locale, so the card keeps its
 * shape and per-type rules (href only when published and routable).
 */
function snapshotReferenceCard(
  doc: Doc<"pages">,
  row: PagePickerRow,
  locale: string
): ResolvedCard | null {
  const title = row.localizedTitles[locale]?.trim()
  const projected = {
    ...doc,
    status:
      row.localePublicationStates[locale] === "published"
        ? ("published" as const)
        : ("draft" as const),
    slug: row.localizedSlugs?.[locale] ?? row.slug,
    content: title ? { [locale]: { title, slices: [] } } : {},
  } as unknown as Doc<"pages">
  const card = resolveReferenceCardForDoc(projected, locale)
  if (card && !title && card.title === "Untitled") {
    return { ...card, titleFallback: "untitled" }
  }
  return card
}

async function resolveCard(
  ctx: QueryCtx,
  snapshot: boolean,
  doc: Doc<"pages">,
  locale: string
): Promise<ResolvedCard | null> {
  if (!snapshot) return resolveReferenceCardForDoc(doc, locale)
  const row = await snapshotPickerRowForPage(ctx, doc._id, {
    includeArchived: true,
  })
  return row ? snapshotReferenceCard(doc, row, locale) : null
}

export const searchTargets = query({
  args: {
    pageTypes: v.array(pageTypeValidator),
    locale: v.string(),
    search: v.optional(v.string()),
    routableOnly: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  returns: v.array(referenceCardValidator),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    if (args.pageTypes.length === 0) return []

    const permitted = new Set<PageType>(CONTENT_TYPES as PageType[])

    const allowedTypes: PageType[] = args.pageTypes.filter((t) => {
      if (!permitted.has(t)) return false
      const descriptor = contentTypeDefs[t as ContentType]
      if (!descriptor) return false
      if (args.routableOnly && descriptor.routing === undefined) return false
      return true
    })
    if (allowedTypes.length === 0) return []

    const limit = Math.min(
      Math.max(1, args.limit ?? PICKER_LIMIT_DEFAULT),
      PICKER_LIMIT_MAX
    )
    const search = args.search?.trim().toLowerCase() ?? ""

    // Per-type fetch cap. Bigger than `limit` so the in-memory title-substring
    // filter has candidates beyond the first `limit` index rows — an editor
    // searching for a known-but-older target should find it. `.take()` scan is
    // still bounded per-type so a huge allowlist can't degenerate to a table
    // scan (the whole handler tops out at
    // `allowedTypes.length * scanPerType` reads).
    const scanPerType = Math.min(
      limit * PICKER_SCAN_MULTIPLIER,
      PICKER_LIMIT_MAX * PICKER_SCAN_MULTIPLIER
    )

    const snapshot =
      (await readPublicationAuthority(ctx)) === "snapshot_active"
    const perTypeScan = snapshot
      ? Math.min(
          scanPerType,
          Math.ceil(SNAPSHOT_PROJECTION_BUDGET / allowedTypes.length)
        )
      : scanPerType

    const perTypeCards: Array<{
      type: PageType
      cards: NonNullable<ReturnType<typeof resolveReferenceCardForDoc>>[]
    }> = []

    const perTypeResults = await Promise.all(
      allowedTypes.map(async (type) => {
        const rows = await ctx.db
          .query("pages")
          .withIndex("by_pageType_status", (q) => q.eq("pageType", type))
          .take(perTypeScan)
        const cards: ResolvedCard[] = []
        for (const row of rows) {
          if (row.deletedAt !== undefined) continue
          const card = await resolveCard(ctx, snapshot, row, args.locale)
          if (!card) continue
          if (search && !card.title.toLowerCase().includes(search)) continue
          cards.push(card)
          // The interleave below takes at most `limit` cards per type.
          if (snapshot && cards.length >= limit) break
        }
        return { type, cards }
      })
    )
    perTypeCards.push(...perTypeResults)

    // Round-robin interleave so the visible window shows something from every
    // type the caller asked about — otherwise a `.slice(0, limit)` on a naive
    // concat hides all landing-pages behind a dense post scan.
    const interleaved: NonNullable<
      ReturnType<typeof resolveReferenceCardForDoc>
    >[] = []
    const cursors = new Array(perTypeCards.length).fill(0)
    while (interleaved.length < limit) {
      let advanced = false
      for (
        let i = 0;
        i < perTypeCards.length && interleaved.length < limit;
        i++
      ) {
        const bucket = perTypeCards[i]!
        const cursor = cursors[i]!
        if (cursor < bucket.cards.length) {
          interleaved.push(bucket.cards[cursor]!)
          cursors[i] = cursor + 1
          advanced = true
        }
      }
      if (!advanced) break
    }

    return interleaved
  },
})

/**
 * Single-document reference-card resolver for the picker's "currently
 * selected" card and any other admin surface that already holds an id.
 * Public renderers use the sync `resolveReferenceCardForDoc` on documents
 * they've loaded; this query is the admin equivalent when you only have an id.
 *
 * The private owner gate runs before the row lookup, so callers cannot use a
 * missing, deleted, or inactive id as an existence oracle. Owners receive
 * `null` for those rows so the picker can flag a dangling reference.
 */
export const getReferenceCard = query({
  args: {
    id: v.id("pages"),
    locale: v.string(),
  },
  returns: v.union(referenceCardValidator, v.null()),
  handler: async (ctx, args) => {
    await requireOperationAccess(ctx)
    const doc: Doc<"pages"> | null = await ctx.db.get(args.id)
    if (!doc) return null
    if (doc.deletedAt !== undefined) return null
    if (!isActiveContentType(doc.pageType)) return null
    // Reuse the already-loaded doc — the sync resolver applies the same
    // deletion + href-strip invariants the async variant would after a
    // second db.get.
    return resolveCard(
      ctx,
      (await readPublicationAuthority(ctx)) === "snapshot_active",
      doc,
      args.locale
    )
  },
})
