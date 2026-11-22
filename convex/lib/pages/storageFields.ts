import { v } from "convex/values"
import { perLanguageSeoValidator } from "../contentTypes/perLanguageFields"

/**
 * Storage field sets of the `pages` and `pageStaging` rows, and of every
 * arm's Localized Content.
 *
 * This is a leaf module: it imports only `convex/values` and the pure
 * per-language SEO validator. It must never import the content-type
 * registry, `schemaShapes.ts` or `convex/schema.ts`, because the registry
 * loads the definition check, and the check reads the name sets below.
 */

export const seoValidator = v.object({
  metaTitle: v.optional(v.string()),
  metaDescription: v.optional(v.string()),
  focusKeyword: v.optional(v.string()),
  keywords: v.optional(v.array(v.string())),
  ogImage: v.optional(v.string()),
  ogTitle: v.optional(v.string()),
  ogDescription: v.optional(v.string()),
  twitterCard: v.optional(
    v.union(v.literal("summary"), v.literal("summary_large_image"))
  ),
  canonicalUrl: v.optional(v.string()),
  noIndex: v.optional(v.boolean()),
  noFollow: v.optional(v.boolean()),
  structuredData: v.optional(v.string()),
  seoScore: v.optional(v.number()),
})

export const statusValidator = v.union(
  v.literal("draft"),
  v.literal("published"),
  v.literal("archived")
)

/**
 * System row fields — appear on every content-type arm of the pages-table
 * union. NOT a junk drawer: every field here is intrinsically cross-type
 * (identity, status/timestamps, hierarchy, SEO, and the
 * post-listing card surface which any type may participate in per
 * ADR-0037 §4). Type-specific row-level fields come from each descriptor's
 * `sharedValidator` (author `name`/`socials`, post `authorId`/`tags`/…) —
 * see the arm builders below. The `pageType` discriminator lives on each
 * arm (`v.literal(<type>)`), NOT here. `content` is per-arm and derived
 * from the descriptor's `localizedValidator` (schemaShapes.ts).
 */
export const systemPageFields = {
  slug: v.string(),
  status: statusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  deletedAt: v.optional(v.number()),
  localizedSlugs: v.optional(v.record(v.string(), v.string())),
  parentId: v.optional(v.id("pages")),
  ancestryPath: v.optional(v.string()),
  localizedAncestryPaths: v.optional(v.record(v.string(), v.string())),
  hierarchyDepth: v.optional(v.number()),
  siblingOrder: v.optional(v.number()),
  parentSectionIds: v.optional(v.array(v.id("pages"))),
  seo: v.optional(seoValidator),
  publishedAt: v.optional(v.number()),
  // `expiresAt` lives on every arm today because all four current content
  // types have `capabilities.scheduling: true`. A future non-scheduling
  // type will drop it (and the `by_status_and_expiresAt` index needs
  // revisiting at that point).
  //
  // `scheduledAt` was removed here in ADR-0041 Deploy 2 PR B — scheduling
  // is now a staging concern, held on `pageStaging.scheduledAt` and read
  // by the scheduled-publish cron via `pageStaging.by_scheduledAt`.
  // Existing rows are cleared by the `moveScheduledAtToStaging` migration
  // (convex/migrations.ts entry 012), which must run before this narrow
  // ships in production.
  expiresAt: v.optional(v.number()),
  template: v.optional(v.string()),
  createdBy: v.optional(v.string()),
  // Post-listing card surface — semantically post-oriented, but kept shared
  // per ADR-0037 §4: any content type may participate in a card surface
  // (relation cards, homepage tiles), so structurally forbidding these on
  // non-post arms would trade an unused constraint for read-time narrowing
  // ripple. Reference to a media asset (not a raw URL) — editors replace
  // a media asset without breaking page card images, and a deleted media
  // row is detectable instead of silently 404ing.
  showOnHomepage: v.optional(v.boolean()),
  displayMode: v.optional(
    v.union(v.literal("card"), v.literal("full"), v.literal("both"))
  ),
  cardImageMediaId: v.optional(v.id("media")),
  cardExcerpt: v.optional(v.string()),
} as const

export const stagingSystemFields = {
  slug: v.optional(v.string()),
  localizedSlugs: v.optional(v.record(v.string(), v.string())),
  seo: v.optional(seoValidator),
  scheduledAt: v.optional(v.number()),
  template: v.optional(v.string()),
  showOnHomepage: v.optional(v.boolean()),
  displayMode: v.optional(
    v.union(v.literal("card"), v.literal("full"), v.literal("both"))
  ),
  cardImageMediaId: v.optional(v.id("media")),
  cardExcerpt: v.optional(v.string()),
} as const

/**
 * Staging bookkeeping fields — one row per page holding an in-flight
 * edit set. `pageId` targets the live row; `updatedAt` drives freshness
 * (the ADR §4 concurrency token) and the abandoned-staging TTL sweep
 * (§9); `createdBy` records the auth subject that opened this staging
 * session; `effectiveTitles` is the §8 admin-discoverability
 * denormalization (option b) — one string per locale mirroring the
 * editable title so admin lists and search can prefer staged titles at
 * query time without a second index.
 */
export const stagingBookkeepingFields = {
  pageId: v.id("pages"),
  updatedAt: v.number(),
  createdBy: v.optional(v.string()),
  effectiveTitles: v.optional(v.record(v.string(), v.string())),
} as const

/**
 * Per-language search, social and card fields (ADR-0037 amendment,
 * 2026-11-17). They sit in every arm's Localized Content, whatever the
 * content type, next to the descriptor's own localized fields.
 */
export const perLanguageFields = {
  seo: v.optional(perLanguageSeoValidator),
  cardExcerpt: v.optional(v.string()),
} as const

/**
 * Names a descriptor must not reuse. Each set is derived from the field
 * objects above, so a new storage field is reserved the moment it exists.
 *
 * - Live row: the descriptor's shared fields are spread after the system
 *   fields in the `pages` arm, and would silently replace a field of the
 *   same name.
 * - Staging row: the shared fields are spread after the bookkeeping and
 *   system fields in the `pageStaging` arm.
 * - Localized content: `perLanguageFields` and `blocks` are spread after the
 *   descriptor's own localized fields (`blocks` is reserved for every type,
 *   block-bodied or not).
 */
const rowIdentityNames = ["pageType", "content", "_id", "_creationTime"] as const

export const LIVE_ROW_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(systemPageFields),
  ...rowIdentityNames,
])

export const STAGING_ROW_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(stagingSystemFields),
  ...Object.keys(stagingBookkeepingFields),
  ...rowIdentityNames,
])

export const LOCALIZED_CONTENT_FIELD_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(perLanguageFields),
  "blocks",
])
