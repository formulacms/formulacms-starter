import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { sliceValidator, installedSliceValidator } from "./lib/slices"
import { navItemValidator } from "./lib/menu"
import {
  disclosureItemValidator,
  disclosureSectionValidator,
} from "./lib/language/disclosure"
import { contactPayloadValidator } from "./lib/formPayloads"
import { pageTypeValidator } from "./lib/pages/types"
// @content-type-codegen:schema-content-type-imports:start
import { landingPageContentType } from "./lib/contentTypes/landingPage"
import { pageContentType } from "./lib/contentTypes/page"
import { postContentType } from "./lib/contentTypes/post"
import { authorContentType } from "./lib/contentTypes/author"
import { testimonialContentType } from "./lib/contentTypes/testimonial"
import { jobContentType } from "./lib/contentTypes/job"
// @content-type-codegen:schema-content-type-imports:end
import { contentDraftInputValidator } from "./lib/contentTypes/inputShapes"
import {
  armLocalizedContentValidator,
  armLocalizedContentValidatorNoSlices,
  buildRevisionLocalizedContentValidator,
  buildRevisionSharedFieldsValidator,
} from "./lib/contentTypes/schemaShapes"
import {
  aiAttemptCountValidator,
  runtimeModelTupleValidator,
  aiCostSourceValidator,
  aiPriceQuoteValidator,
  aiAccountingProfileValidator,
  aiRuntimeSettingsValidator,
  providerHealthValidator,
  executionLaneValidator,
  generationEngineValidator,
  generationIdentityEvidenceValidator,
  providerModelSelectionsValidator,
  reasoningEffortValidator,
  runtimeApiProviderValidator,
  taskProfileValidator,
  workflowPhaseValidator,
} from "./lib/aiValidators"
import {
  emailProviderActivationReceiptFields,
  emailProviderStateFields,
} from "./lib/email/providerState"
import { emailProviderMigrationReceiptFields } from "./lib/email/providerMigration"
import { emailDeliveryEventFields } from "./lib/email/delivery"

export const aiPageJobContentValidator = v.object({
  // Translation jobs: the complete typed draft of one generation. On
  // `sourcePage` it is the source language's draft pinned at Start; on
  // `suggestion` it is that draft with the translation applied, which is
  // what Accept saves. Absent on jobs made before it existed.
  draft: v.optional(contentDraftInputValidator),
  title: v.string(),
  metaTitle: v.optional(v.string()),
  metaDescription: v.optional(v.string()),
  slices: v.array(sliceValidator),
  translatables: v.array(
    v.object({
      path: v.string(),
      kind: v.union(v.literal("text"), v.literal("richText")),
      value: v.string(),
    })
  ),
})
export const aiPageJobStateValidator = v.union(
  v.literal("running"),
  v.literal("canceling"),
  v.literal("done"),
  v.literal("canceled"),
  v.literal("failed"),
  v.literal("capped"),
  v.literal("expired")
)
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

/**
 * Permissive superset for revision-return validators only (ADR-0029). Live
 * `content[locale]` shape is now per-arm and derived from each descriptor's
 * `localizedValidator`; a revision snapshot is heterogeneous by design (a
 * post revision carries post fields, an author revision carries author
 * fields, and the return validator here has to admit both). All fields are
 * optional because the archived JSON pre-dates the current descriptor shape
 * and may omit anything.
 *
 * C9b: the shape is derived from every registered descriptor's
 * `localizedFields` instead of the C6 hard-coded `roleTitle`/`bio` bridge —
 * adding a new content type widens the return shape automatically.
 */
export const pageRevisionLocalizedContentValidator =
  buildRevisionLocalizedContentValidator()

/**
 * Permissive superset for revision snapshots' row-level shared-field bag
 * (plan 029 C9b). Derived from every registered descriptor's `sharedFields`;
 * every key optional per ADR-0029 (archived JSON may pre-date any field).
 * Consumed only as a return-validator shape by `listRevisions`.
 */
export const pageRevisionSharedFieldsValidator =
  buildRevisionSharedFieldsValidator()

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
const systemPageFields = {
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

/**
 * Descriptor-derived arm fields (plan 028 C7). Each arm =
 *   systemPageFields
 *   + descriptor's `sharedValidator.fields` (type-specific row-level fields)
 *   + `pageType: v.literal(<type>)`
 *   + descriptor-derived `content` record.
 * No junk drawer, no cross-arm leakage — an `author` row cannot carry
 * `authorId`, a `post` row cannot carry `roleTitle`, and neither can arrive
 * as an unexpected key at the storage boundary.
 */
// @content-type-codegen:schema-live-arms:start
export const landingPageArmFields = {
  ...systemPageFields,
  ...landingPageContentType.sharedValidator.fields,
  pageType: v.literal("landing-page"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(landingPageContentType))
  ),
} as const

export const pageArmFields = {
  ...systemPageFields,
  ...pageContentType.sharedValidator.fields,
  pageType: v.literal("page"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(pageContentType))
  ),
} as const

export const postArmFields = {
  ...systemPageFields,
  ...postContentType.sharedValidator.fields,
  pageType: v.literal("post"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(postContentType))
  ),
} as const

export const authorArmFields = {
  ...systemPageFields,
  ...authorContentType.sharedValidator.fields,
  pageType: v.literal("author"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(authorContentType))
  ),
} as const

export const testimonialArmFields = {
  ...systemPageFields,
  ...testimonialContentType.sharedValidator.fields,
  pageType: v.literal("testimonial"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidatorNoSlices(testimonialContentType))
  ),
} as const

export const jobArmFields = {
  ...systemPageFields,
  ...jobContentType.sharedValidator.fields,
  pageType: v.literal("job"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(jobContentType))
  ),
} as const
// @content-type-codegen:schema-live-arms:end

/**
 * Discriminated union for the `pages` table. Each arm carries a
 * `pageType: v.literal(<slug>)` so Convex + TypeScript both narrow off it.
 * Fields exclusive to one arm cannot leak onto another at the schema level —
 * this is the "junk drawer dissolved" mechanic (plan 028, ADR-0037 §4).
 */
// @content-type-codegen:schema-pages-table-validator:start
export const pagesTableValidator = v.union(
  v.object(landingPageArmFields),
  v.object(pageArmFields),
  v.object(postArmFields),
  v.object(authorArmFields),
  v.object(testimonialArmFields),
  v.object(jobArmFields)
)
// @content-type-codegen:schema-pages-table-validator:end

/**
 * ADR-0041 — per-page atomic staging (Deploy 1: Widen).
 *
 * Staging system fields are a strict subset of `systemPageFields`: fields
 * bypassed per ADR §1 "What stays live-immediate" (hierarchy — `parentId` /
 * `ancestryPath` / `localizedAncestryPaths` / `hierarchyDepth` /
 * `siblingOrder` / `parentSectionIds`) are OMITTED, as are page-lifecycle
 * fields the staging row does not own (`status`, `publishedAt`, `deletedAt`,
 * `expiresAt` — scheduled expiry stays orthogonal to staging per §7). The
 * publish mutation reads staging + the current live `pages` row to produce
 * the promoted patch, so staging never needs to redundantly mirror the
 * page-lifecycle keys.
 *
 * `template` and the post-listing card surface (`showOnHomepage` /
 * `displayMode` / `cardImageMediaId` / `cardExcerpt`) are ADR §1
 * "descriptor-declared shared fields" and stage here.
 */

/**
 * Wrap every descriptor sharedField validator in `v.optional(v.union(...,
 * v.null()))` so a staging row can carry three shapes per field:
 *
 *   * **absent (undefined)** — "no change to the live value at publish"
 *   * **the underlying type** — replacement value
 *   * **`null`**              — "clear this field at publish" (Deploy 2
 *     null-preservation rule; see `overlayStagingOnPage` + `pages.publish`
 *     for the promote-time translation).
 *
 * Widening for every descriptor sharedField (not just the nullable ones)
 * is fine: `updateDraft` still rejects an empty `name` / `personName`
 * with a typed error before it can land on staging, so the extra `null`
 * branch is unreachable for required fields in practice. Idempotent
 * writes at the schema level; existing staging rows with `undefined`
 * columns keep validating.
 */
function optionalizeSharedFieldsForStaging(
  sharedValidatorFields: Record<
    string,
    import("convex/values").GenericValidator
  >
): Record<string, import("convex/values").GenericValidator> {
  const out: Record<string, import("convex/values").GenericValidator> = {}
  for (const [key, validator] of Object.entries(sharedValidatorFields)) {
    // Strip `.optional()` from the descriptor validator before folding
    // it into the union — `v.optional` decorates the property key
    // (undefined-admits), and `v.union(v.optional(x), v.null())` would
    // put the undefined-admit inside the union where it doesn't make
    // sense. Rebuild the trio outside-in.
    const inner =
      validator.isOptional === "optional" && "value" in validator
        ? (
            validator as unknown as {
              value: import("convex/values").GenericValidator
            }
          ).value
        : validator
    out[key] = v.optional(v.union(inner, v.null()))
  }
  return out
}
const stagingSystemFields = {
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
const stagingBookkeepingFields = {
  pageId: v.id("pages"),
  updatedAt: v.number(),
  createdBy: v.optional(v.string()),
  effectiveTitles: v.optional(v.record(v.string(), v.string())),
} as const

// @content-type-codegen:schema-staging-arms:start
export const landingPageStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(landingPageContentType.sharedValidator.fields),
  pageType: v.literal("landing-page"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(landingPageContentType))
  ),
} as const

export const pageStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(pageContentType.sharedValidator.fields),
  pageType: v.literal("page"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(pageContentType))
  ),
} as const

export const postStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(postContentType.sharedValidator.fields),
  pageType: v.literal("post"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(postContentType))
  ),
} as const

export const authorStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(authorContentType.sharedValidator.fields),
  pageType: v.literal("author"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(authorContentType))
  ),
} as const

export const testimonialStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(testimonialContentType.sharedValidator.fields),
  pageType: v.literal("testimonial"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidatorNoSlices(testimonialContentType))
  ),
} as const

export const jobStagingArmFields = {
  ...stagingBookkeepingFields,
  ...stagingSystemFields,
  ...optionalizeSharedFieldsForStaging(jobContentType.sharedValidator.fields),
  pageType: v.literal("job"),
  content: v.optional(
    v.record(v.string(), armLocalizedContentValidator(jobContentType))
  ),
} as const
// @content-type-codegen:schema-staging-arms:end

// @content-type-codegen:schema-page-staging-table-validator:start
export const pageStagingTableValidator = v.union(
  v.object(landingPageStagingArmFields),
  v.object(pageStagingArmFields),
  v.object(postStagingArmFields),
  v.object(authorStagingArmFields),
  v.object(testimonialStagingArmFields),
  v.object(jobStagingArmFields)
)
// @content-type-codegen:schema-page-staging-table-validator:end

// @content-type-codegen:schema-page-staging-doc-validator:start
export const pageStagingDocValidator = v.union(
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...landingPageStagingArmFields,
  }),
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...pageStagingArmFields,
  }),
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...postStagingArmFields,
  }),
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...authorStagingArmFields,
  }),
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...testimonialStagingArmFields,
  }),
  v.object({
    _id: v.id("pageStaging"),
    _creationTime: v.number(),
    ...jobStagingArmFields,
  })
)
// @content-type-codegen:schema-page-staging-doc-validator:end

/**
 * F08a's publication rows deliberately do not reuse the mutable `pages`
 * document.  The page remains the identity/compatibility record while these
 * rows own successor authoring and public state.
 */
// M05 default migration: the freshness tokens a generation captures and its
// disclosure counts (contract `siteDefaultLanguageMigrations`). `manifest`
// repeats both shapes for the validated generation.
const freshnessPairValidator = v.object({
  routeClaimVersion: v.number(),
  publicationSetVersion: v.number(),
})

const defaultMigrationCapturedValidator = v.object({
  authorityVersion: v.number(),
  moduleConfigurationVersion: v.number(),
  site: freshnessPairValidator,
  from: freshnessPairValidator,
  to: freshnessPairValidator,
})

const defaultMigrationCountsValidator = v.object({
  rows: v.number(),
  shadowedByCurrent: v.number(),
  shadowedByHistorical: v.number(),
  manualRulesShadowed: v.number(),
  manualRulesShifted: v.number(),
  manualRulesUnprefixed: v.number(),
  carriedShadowedSkipped: v.number(),
  blockers: v.number(),
})

export const publicationAttributionValidator = v.union(
  v.object({
    kind: v.literal("owner"),
    ownerId: v.id("cmsOwner"),
    authId: v.string(),
    tokenIdentifier: v.string(),
  }),
  v.object({ kind: v.literal("migration"), migrationRunId: v.string() })
)

const publicationSharedSystemValidator = v.object({
  seo: v.optional(seoValidator),
  template: v.optional(v.string()),
  parentId: v.optional(v.id("pages")),
  siblingOrder: v.optional(v.number()),
  showOnHomepage: v.optional(v.boolean()),
  displayMode: v.optional(
    v.union(v.literal("card"), v.literal("full"), v.literal("both"))
  ),
  cardImageMediaId: v.optional(v.id("media")),
  cardExcerpt: v.optional(v.string()),
})

const publicationSharedBookkeepingFields = {
  pageId: v.id("pages"),
  generation: v.number(),
  system: publicationSharedSystemValidator,
  updatedBy: publicationAttributionValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
} as const

// Keep the new draft validators descriptor-derived. A new content type must
// widen these arms alongside the existing pages/pageStaging codegen markers;
// publication never accepts an untyped JSON bag as fresh authoring input.
export const pageSharedDraftsTableValidator = v.union(
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("landing-page"),
    descriptor: landingPageContentType.sharedValidator,
  }),
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("page"),
    descriptor: pageContentType.sharedValidator,
  }),
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("post"),
    descriptor: postContentType.sharedValidator,
  }),
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("author"),
    descriptor: authorContentType.sharedValidator,
  }),
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("testimonial"),
    descriptor: testimonialContentType.sharedValidator,
  }),
  v.object({
    ...publicationSharedBookkeepingFields,
    pageType: v.literal("job"),
    descriptor: jobContentType.sharedValidator,
  })
)

const publicationLocaleDraftBookkeepingFields = {
  pageId: v.id("pages"),
  locale: v.string(),
  generation: v.number(),
  slug: v.string(),
  addressAllocation: v.optional(
    v.object({ wantedSlug: v.string(), allocatedSlug: v.string() })
  ),
  updatedBy: publicationAttributionValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
} as const

export const pageLocaleDraftsTableValidator = v.union(
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("landing-page"),
    content: armLocalizedContentValidator(landingPageContentType),
  }),
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("page"),
    content: armLocalizedContentValidator(pageContentType),
  }),
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("post"),
    content: armLocalizedContentValidator(postContentType),
  }),
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("author"),
    content: armLocalizedContentValidator(authorContentType),
  }),
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("testimonial"),
    content: armLocalizedContentValidatorNoSlices(testimonialContentType),
  }),
  v.object({
    ...publicationLocaleDraftBookkeepingFields,
    pageType: v.literal("job"),
    content: armLocalizedContentValidator(jobContentType),
  })
)

/**
 * Document validator for a `pages` row (return-value validators, cache-side
 * type helpers). One arm per content type.
 */
// @content-type-codegen:schema-page-doc-validator:start
export const pageDocValidator = v.union(
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...landingPageArmFields,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...pageArmFields,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...postArmFields,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...authorArmFields,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...testimonialArmFields,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...jobArmFields,
  })
)
// @content-type-codegen:schema-page-doc-validator:end

/**
 * `pages` document with the staged overlays merged in (ADR-0041 Deploy 2
 * PR B). Two overlays live here:
 *
 *   * `scheduledAt` — after scheduling moved off `pages` onto `pageStaging`,
 *     any consumer that renders the "Publishes {date}" affordance (admin
 *     list, editor header/settings panel, command palette) needs the staged
 *     value.
 *   * `effectiveTitles` — after `create`/`duplicate` seed content into
 *     staging instead of `pages.content` (Deploy 2 PR B item 3, plus the
 *     hoist migration for existing drafts), `pages.content` is empty for
 *     never-published drafts, so admin list titles / command palette must
 *     read the denormalized `pageStaging.effectiveTitles` to show anything.
 *
 * Both overlays are `v.optional(...)`: absent = no staging row (or no
 * staged value in that field). Non-overlay callers (`getById`, sitemap
 * queries, revision resolvers) still return `pageDocValidator` — the pure
 * arm without the overlay.
 */
const stagedOverlayExtras = {
  scheduledAt: v.optional(v.number()),
  effectiveTitles: v.optional(v.record(v.string(), v.string())),
} as const

// @content-type-codegen:schema-page-with-staged-overlay-validator:start
export const pageWithStagedOverlayValidator = v.union(
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...landingPageArmFields,
    ...stagedOverlayExtras,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...pageArmFields,
    ...stagedOverlayExtras,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...postArmFields,
    ...stagedOverlayExtras,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...authorArmFields,
    ...stagedOverlayExtras,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...testimonialArmFields,
    ...stagedOverlayExtras,
  }),
  v.object({
    _id: v.id("pages"),
    _creationTime: v.number(),
    ...jobArmFields,
    ...stagedOverlayExtras,
  })
)
// @content-type-codegen:schema-page-with-staged-overlay-validator:end

// ADR-0041 Deploy 3 (Narrow) — the union retains historical revision reasons.
// `manual_save` survives for pre-U3b rows. Current publication writers are
// `publish` (from `performPublish` via `pages.publish`), `scheduled_publish`
// (from the same helper invoked by `processScheduledTransitions`), and
// `scheduled_expiry` (from the expiry cron branch of the same
// transition mutation). The pre-Deploy-3 arms `rollback`,
// `ai_generation`, and `translation` never had a runtime writer (the
// closest thing to a rollback revision is the `publish` reason that
// lands when a restored draft is promoted — see the note at
// `restoreRevisionAsDraft`). Verified against dev pageRevisions on
// 2026-07-14: only the four surviving reasons appear on live rows.
// Prod pageRevisions MUST be verified before the schema push there.
export const pageRevisionReasonValidator = v.union(
  v.literal("manual_save"),
  v.literal("publish"),
  v.literal("scheduled_publish"),
  v.literal("scheduled_expiry")
)

export const pageRevisionChecklistItemValidator = v.object({
  code: v.string(),
  message: v.string(),
  field: v.optional(v.string()),
  locales: v.optional(v.array(v.string())),
})

export const teamWorkflowStatusValidator = v.union(
  v.literal("working_draft"),
  v.literal("submitted"),
  v.literal("changes_requested"),
  v.literal("approved"),
  v.literal("published")
)

export const teamWorkflowActionValidator = v.union(
  v.literal("submitted"),
  v.literal("changes_requested"),
  v.literal("approved"),
  v.literal("withdrawn"),
  v.literal("reset"),
  v.literal("draft_resumed"),
  v.literal("draft_discarded"),
  v.literal("reassigned"),
  v.literal("revised"),
  v.literal("cancelled"),
  v.literal("published"),
  v.literal("scheduled_publish_rejected")
)

export const teamWorkflowStateDocValidator = v.object({
  _id: v.id("teamWorkflowStates"),
  _creationTime: v.number(),
  pageId: v.id("pages"),
  status: teamWorkflowStatusValidator,
  version: v.number(),
  stagingId: v.optional(v.id("pageStaging")),
  snapshotDigest: v.optional(v.string()),
  submittedBy: v.optional(v.string()),
  submittedAt: v.optional(v.number()),
  approvedBy: v.optional(v.string()),
  approvedAt: v.optional(v.number()),
  decisionNote: v.optional(v.string()),
  updatedAt: v.number(),
})

export const teamWorkflowEventDocValidator = v.object({
  _id: v.id("teamWorkflowEvents"),
  _creationTime: v.number(),
  pageId: v.id("pages"),
  action: teamWorkflowActionValidator,
  actorKind: v.union(v.literal("member"), v.literal("system")),
  actorId: v.string(),
  priorState: teamWorkflowStatusValidator,
  resultState: teamWorkflowStatusValidator,
  workflowVersion: v.number(),
  candidateId: v.optional(v.id("pagePublicationCandidates")),
  roundId: v.optional(v.id("teamReviewRounds")),
  assignmentId: v.optional(v.id("teamReviewAssignments")),
  actorAuthId: v.optional(v.string()),
  actorMembershipId: v.optional(v.id("cmsMemberships")),
  snapshotDigest: v.optional(v.string()),
  note: v.optional(v.string()),
  origin: v.union(v.literal("interactive"), v.literal("scheduled")),
  createdAt: v.number(),
})

export const teamPublishingPolicySetupValidator = v.union(
  v.literal("initialized"),
  v.literal("setup_required")
)

export const teamReviewRoundStatusValidator = v.union(
  v.literal("submitted"),
  v.literal("changes_requested"),
  v.literal("approved"),
  v.literal("withdrawn"),
  v.literal("published"),
  v.literal("cancelled")
)

export const teamReviewAssignmentStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("changes_requested"),
  v.literal("retired")
)

export const publicationReleaseStatusValidator = v.union(
  v.literal("pending"),
  v.literal("held"),
  v.literal("cancelled"),
  v.literal("replaced"),
  v.literal("published")
)

export const publicationExpiryStatusValidator = v.union(
  v.literal("pending"),
  v.literal("held"),
  v.literal("cancelled"),
  v.literal("replaced"),
  v.literal("executed")
)

export const pageRevisionChecklistValidator = v.object({
  blockerCount: v.number(),
  warningCount: v.number(),
  blockers: v.array(pageRevisionChecklistItemValidator),
  warnings: v.array(pageRevisionChecklistItemValidator),
})

export const pageRevisionDocValidator = v.object({
  _id: v.id("pageRevisions"),
  _creationTime: v.number(),
  pageId: v.id("pages"),
  revisionNumber: v.number(),
  createdAt: v.number(),
  createdBy: v.optional(v.string()),
  reason: pageRevisionReasonValidator,
  status: statusValidator,
  slug: v.string(),
  pageType: pageTypeValidator,
  content: v.optional(
    v.record(v.string(), pageRevisionLocalizedContentValidator)
  ),
  // Archived content remains readable even when the current installed
  // profile no longer has the slice code. Restore exposes these exact paths
  // as blockers rather than silently dropping records.
  contentBlockers: v.optional(
    v.array(
      v.object({
        locale: v.string(),
        index: v.number(),
        path: v.string(),
        type: v.string(),
      })
    )
  ),
  // C9b: descriptor shared-field bag as parsed at read time. Absent on
  // legacy revisions (see ADR-0029 heterogeneous-by-design) and on
  // capability-off types (no revisions written).
  sharedFields: v.optional(pageRevisionSharedFieldsValidator),
  localizedSlugs: v.optional(v.record(v.string(), v.string())),
  seo: v.optional(seoValidator),
  metadata: v.object({
    title: v.string(),
    locales: v.array(v.string()),
    summary: v.array(v.string()),
    checklist: v.optional(pageRevisionChecklistValidator),
  }),
})

export const pagePresenceDocValidator = v.object({
  _id: v.id("pagePresence"),
  _creationTime: v.number(),
  pageId: v.id("pages"),
  userId: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  lastActiveAt: v.number(),
  updatedAt: v.number(),
})

export const pageEditorLockDocValidator = v.object({
  _id: v.id("pageEditorLocks"),
  _creationTime: v.number(),
  pageId: v.id("pages"),
  userId: v.string(),
  name: v.optional(v.string()),
  email: v.optional(v.string()),
  acquiredAt: v.number(),
  lastActiveAt: v.number(),
  updatedAt: v.number(),
})

export const menuFields = {
  slug: v.string(),
  nav: v.array(navItemValidator),
  updatedAt: v.number(),
  updatedBy: v.optional(v.string()),
  deletedAt: v.optional(v.number()),
  schemaVersion: v.optional(v.number()),
} as const

export const menuDocValidator = v.object({
  _id: v.id("menus"),
  _creationTime: v.number(),
  ...menuFields,
})

export const mediaFields = {
  filename: v.string(),
  storageId: v.id("_storage"),
  url: v.string(),
  // Legacy only. Accessible alt text belongs on page/slice image fields,
  // where the editor knows the image's context.
  alt: v.optional(v.record(v.string(), v.string())),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  // Default image framing for new usages. Page/slice image fields can
  // override this contextually without creating another media asset.
  focal: v.optional(v.object({ x: v.number(), y: v.number() })),
  crop: v.optional(
    v.object({
      x: v.number(),
      y: v.number(),
      width: v.number(),
      height: v.number(),
    })
  ),
  cropSize: v.optional(
    v.object({
      width: v.number(),
      height: v.number(),
    })
  ),
  size: v.number(),
  mimeType: v.string(),
  folder: v.optional(v.string()),
  tags: v.optional(v.array(v.string())),
  uploadedAt: v.number(),
  uploadedBy: v.optional(v.string()),
  deletedAt: v.optional(v.number()),
  schemaVersion: v.optional(v.number()),
} as const

export const mediaDocValidator = v.object({
  _id: v.id("media"),
  _creationTime: v.number(),
  ...mediaFields,
})

export const siteSettingsFields = {
  siteName: v.string(),
  siteUrl: v.string(),
  // Legacy single description (before M05 A5). Read as the default language's
  // description until the first per-language write, make-default commit or F09
  // activation moves it into `siteDescriptions` and clears it.
  siteDescription: v.optional(v.string()),
  // Site description per language, keyed by locale code (M05 A5). A language
  // without a key has no description; the site name stays one value.
  siteDescriptions: v.optional(v.record(v.string(), v.string())),
  // Generic site-metadata contact details (footer, schema.org, emails).
  contactEmail: v.optional(v.string()),
  contactPhone: v.optional(v.string()),
  contactAddress: v.optional(v.string()),
  // Social profile links.
  socialFacebook: v.optional(v.string()),
  socialInstagram: v.optional(v.string()),
  socialX: v.optional(v.string()),
  socialLinkedin: v.optional(v.string()),
  defaultLocale: v.string(),
  enabledLocales: v.array(v.string()),
  // The page served at "/". Any page can be designated home (rename-safe),
  // replacing the former dedicated "homepage" pageType.
  homePageId: v.optional(v.id("pages")),
  timezone: v.optional(v.string()),
  dateFormat: v.optional(v.string()),
  adminPath: v.optional(v.string()),
  logoMediaId: v.optional(v.id("media")),
  faviconMediaId: v.optional(v.id("media")),
  defaultOgImageMediaId: v.optional(v.id("media")),
  logoStorageId: v.optional(v.id("_storage")),
  faviconStorageId: v.optional(v.id("_storage")),
  defaultOgImageStorageId: v.optional(v.id("_storage")),
  // Legacy email fields — superseded by the `emailSettings` table (ADR-0024 +
  // ADR-0029). Phase 3 added the `splitEmailSettings` migration that copies
  // these into the new table. DO NOT remove these fields here until an
  // operator has confirmed `splitEmailSettings` ran successfully on their
  // deployment (ADR-0025 widen→migrate→narrow). At that point, delete these
  // four optional fields; the `dropLegacyEmailFields` migration entry in
  // `convex/migrations.ts` documents the narrow step.
  emailProvider: v.optional(
    v.union(v.literal("resend"), v.literal("smtp"), v.literal("console"))
  ),
  emailFromAddress: v.optional(v.string()),
  emailFromName: v.optional(v.string()),
  emailProviderConfig: v.optional(v.string()),
  aiProvider: v.optional(v.string()),
  aiDefaultModel: v.optional(v.string()),
  // Unit D2 Production AI selection. Additive during the compatibility window:
  // legacy model/provider strings remain readable only when this is absent.
  aiRuntime: v.optional(aiRuntimeSettingsValidator),
  aiMonthlyCapMicros: v.optional(v.number()),
  /** Operator-edited tone/style guide injected into every content-writer
   *  call. Empty/absent ⇒ no voice injection. Capped at 400 chars in the
   *  updater to keep prompt cost predictable. */
  brandVoice: v.optional(v.string()),
  // Slice types the owner has retired from the authoring picker + the catalog's
  // "Active" view (curation, not deletion — ADR archive-vs-delete). The slice
  // code stays registered and existing pages keep rendering; an archived type
  // just stops being offered for new placements. Toggled via
  // cms/slices.setSliceArchived (settings:update). Lenient: a stale entry for a
  // later-deleted slice simply matches nothing.
  archivedSliceTypes: v.optional(v.array(v.string())),
  // Presentation curation restricts new assignments without rewriting retained
  // Page occurrences or their source renderers. Missing means source defaults.
  archivedSlicePresentationsV1: v.optional(
    v.array(v.object({ type: v.string(), presentationId: v.string() }))
  ),
  // Content types the owner has operationally archived from ordinary creation
  // and duplication. Descriptors and storage arms remain registered so
  // existing documents continue to render, update, and resolve as relations.
  archivedContentTypes: v.optional(v.array(v.string())),
  onboardingCompletedAt: v.optional(v.number()),
  // Phase 11 — legacy per-step onboarding completion bookmarks. Current setup
  // uses account plus the atomic site bootstrap; the remaining timestamps are
  // compatibility data for older partial installs. `onboardingEmailAt` is
  // retained for schema compatibility but is no longer read or written by
  // setup (ADR-0054).
  onboardingAccountAt: v.optional(v.number()),
  onboardingIdentityAt: v.optional(v.number()),
  onboardingLocalesAt: v.optional(v.number()),
  onboardingEmailAt: v.optional(v.number()),
  onboardingAiAt: v.optional(v.number()),
  updatedAt: v.number(),
  // ADR-0025 §2 — engine schema marker. Optional during the widen window;
  // Phase 3 backfills then narrows.
  schemaVersion: v.optional(v.number()),
} as const

export const siteSettingsDocValidator = v.object({
  _id: v.id("siteSettings"),
  _creationTime: v.number(),
  ...siteSettingsFields,
})

export const revalidationTargetValidator = v.union(
  v.id("pages"),
  v.literal("menus"),
  v.literal("settings")
)

export const revalidationStatusValidator = v.union(
  v.literal("ok"),
  v.literal("http_error"),
  v.literal("network_error"),
  v.literal("unconfigured")
)

/**
 * Outbound webhook events (plan 023 Phase 4 #7). "test" exists so an admin
 * can fire a signed test delivery at an endpoint; subscriptions (the
 * `events` array on an endpoint) only ever hold the three real events.
 */
export const webhookEventValidator = v.union(
  v.literal("page.published"),
  v.literal("page.unpublished"),
  v.literal("form.submitted"),
  v.literal("test")
)

const publicationReferenceSourceValidators = {
  sharedDraft: {
    sourceKind: v.literal("shared_draft"),
    sourceId: v.id("pageSharedDrafts"),
    sourceGeneration: v.number(),
  },
  localeDraft: {
    sourceKind: v.literal("locale_draft"),
    sourceId: v.id("pageLocaleDrafts"),
    sourceGeneration: v.number(),
    locale: v.string(),
  },
  candidate: {
    sourceKind: v.literal("candidate"),
    sourceId: v.id("pageLocalePublicationCandidates"),
    candidateDigest: v.string(),
    locale: v.string(),
  },
  currentPublic: {
    sourceKind: v.literal("current_public"),
    sourceId: v.id("pagePublishedSnapshots"),
    publicGeneration: v.number(),
    locale: v.string(),
  },
} as const

const publicationDocumentReferenceFields = {
  pageId: v.id("pages"),
  targetId: v.id("pages"),
  targetType: pageTypeValidator,
  sourcePath: v.string(),
  referenceKind: v.union(
    v.literal("shared-field"),
    v.literal("localized-field"),
    v.literal("slice-body"),
    v.literal("ancestry")
  ),
  targetLocale: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
} as const

const publicationMediaReferenceFields = {
  pageId: v.id("pages"),
  mediaId: v.id("media"),
  storageId: v.id("_storage"),
  sourcePath: v.string(),
  referenceKind: v.union(
    v.literal("slice-image"),
    v.literal("slice-media-link"),
    v.literal("card-image"),
    v.literal("descriptor-image")
  ),
  createdAt: v.number(),
  updatedAt: v.number(),
} as const

const publicationSliceReferenceFields = {
  pageId: v.id("pages"),
  sliceType: v.string(),
  count: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
} as const

const publicationDocumentReferenceValidator = v.union(
  v.object({
    ...publicationDocumentReferenceFields,
    ...publicationReferenceSourceValidators.sharedDraft,
  }),
  v.object({
    ...publicationDocumentReferenceFields,
    ...publicationReferenceSourceValidators.localeDraft,
  }),
  v.object({
    ...publicationDocumentReferenceFields,
    ...publicationReferenceSourceValidators.candidate,
  }),
  v.object({
    ...publicationDocumentReferenceFields,
    ...publicationReferenceSourceValidators.currentPublic,
  })
)

const publicationMediaReferenceValidator = v.union(
  v.object({
    ...publicationMediaReferenceFields,
    ...publicationReferenceSourceValidators.sharedDraft,
  }),
  v.object({
    ...publicationMediaReferenceFields,
    ...publicationReferenceSourceValidators.localeDraft,
  }),
  v.object({
    ...publicationMediaReferenceFields,
    ...publicationReferenceSourceValidators.candidate,
  }),
  v.object({
    ...publicationMediaReferenceFields,
    ...publicationReferenceSourceValidators.currentPublic,
  })
)

const publicationSliceReferenceValidator = v.union(
  v.object({
    ...publicationSliceReferenceFields,
    ...publicationReferenceSourceValidators.sharedDraft,
  }),
  v.object({
    ...publicationSliceReferenceFields,
    ...publicationReferenceSourceValidators.localeDraft,
  }),
  v.object({
    ...publicationSliceReferenceFields,
    ...publicationReferenceSourceValidators.candidate,
  }),
  v.object({
    ...publicationSliceReferenceFields,
    ...publicationReferenceSourceValidators.currentPublic,
  })
)

export default defineSchema({
  // ==========================================
  // CMS: Pages
  // ==========================================
  pages: defineTable(pagesTableValidator)
    .index("by_slug", ["slug"])
    .index("by_pageType_status", ["pageType", "status"])
    .index("by_pageType_and_status_and_publishedAt", [
      "pageType",
      "status",
      "publishedAt",
    ])
    .index("by_status", ["status"])
    // `by_status_and_scheduledAt` was dropped in ADR-0041 Deploy 2 PR B —
    // scheduling moved to `pageStaging.by_scheduledAt`. The equivalent
    // index on staging carries no status because staging rows have no
    // status; the cron filters to draft pages via a follow-up read.
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_parent", ["parentId"])
    // Plan 029 C10 task 9 — post editorial-flag indexes. Both fields
    // live on the `post` arm only (`featured` / `promoteToFront`), but a
    // Convex index defined on the discriminated table is available
    // regardless of arm — non-post arms simply have `undefined` in the
    // indexed slot and never match `.eq("pageType", "post").eq(...)`.
    // Consumers: task 10 sticky-swap (`by_type_promoteToFront` finds
    // "other posts holding the flag"); task 15 reference-card `featured`
    // badge surfaces (`by_type_featured` reads featured posts cheaply).
    .index("by_type_featured", ["pageType", "featured"])
    .index("by_type_promoteToFront", ["pageType", "promoteToFront"]),

  // Lightweight, transactionally maintained counter for the temporary pilot
  // route/sitemap envelope. The authoritative release check still measures
  // the bounded page reads; this singleton keeps normal page writes from
  // repeatedly loading up to 500 full page documents just to reserve a slot.
  pilotEnvelope: defineTable({
    totalPageCount: v.number(),
    publishedPageCount: v.number(),
    updatedAt: v.number(),
  }),

  // C1 originally kept a `by_authorId` index on the post arm for the (now
  // retired) `authors.ts` deletion guard. C5 removed both: (a) `authorId`
  // is now an object `{ pageId }` and Convex can't index into a nested
  // field, and (b) reverse lookups now go through the C2
  // `documentReferences.by_target` fan-in.

  // Denormalized full-text search rows — one per (page, locale). Convex
  // search indexes read a single top-level string field, so the localized
  // titles + slice text inside `pages.content` are flattened here by
  // `syncPageSearch` (convex/lib/publishing/search.ts) on every page write.
  // Rows exist iff the page exists and is not soft-deleted.
  pageSearch: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    status: statusValidator,
    title: v.string(),
    slug: v.string(),
    text: v.string(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["locale", "status"],
    }),

  pageRevisions: defineTable({
    pageId: v.id("pages"),
    revisionNumber: v.number(),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
    reason: pageRevisionReasonValidator,
    status: statusValidator,
    slug: v.string(),
    pageType: pageTypeValidator,
    // ADR-0029: revision content is an *archival snapshot* stored as serialized
    // JSON, deliberately NOT validated against the live closed slice union — so
    // deleting/shrinking a slice type never retroactively invalidates history
    // and blocks deploys. `contentJson` is the source of truth (written by
    // createPageRevision; unavailable slice types remain visible and block
    // restore rather than being silently dropped). ADR-003 (no v.any() for live content) still
    // governs `pages.content`. The legacy `content` record has been narrowed
    // out (backfilled → unset → removed here); readers derive `content` from
    // `contentJson` at query time.
    contentJson: v.optional(v.string()),
    // C9b: descriptor row-level (non-system-owned) shared-field bag,
    // archived as JSON alongside `contentJson`. Permanently optional per
    // ADR-0029 (legacy revisions predate this field and can't be
    // reconstructed). Types with `capabilities.revisions: false` never
    // write it.
    sharedFieldsJson: v.optional(v.string()),
    localizedSlugs: v.optional(v.record(v.string(), v.string())),
    seo: v.optional(seoValidator),
    metadata: v.object({
      title: v.string(),
      locales: v.array(v.string()),
      summary: v.array(v.string()),
      checklist: v.optional(pageRevisionChecklistValidator),
    }),
  })
    .index("by_pageId_and_revisionNumber", ["pageId", "revisionNumber"])
    .index("by_pageId_and_createdAt", ["pageId", "createdAt"]),

  pagePresence: defineTable({
    pageId: v.id("pages"),
    userId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    lastActiveAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId_and_userId", ["pageId", "userId"])
    .index("by_pageId_and_lastActiveAt", ["pageId", "lastActiveAt"]),

  pageEditorLocks: defineTable({
    pageId: v.id("pages"),
    userId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    acquiredAt: v.number(),
    lastActiveAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_pageId_and_lastActiveAt", ["pageId", "lastActiveAt"]),

  // ==========================================
  // CMS: Page staging (ADR-0041 — Deploy 1 Widen)
  //
  // At-most-one staging row per page holds the in-flight edit set that a
  // future publish promotes atomically into the live `pages` row. Deploy 3
  // (Narrow) retired `pages.updateLocaleContent`; content edits flow
  // through `pages.updateDraft` (staging) + `pages.publish` (promote) +
  // `pages.discardDraft` (drop). Hierarchy, timing, and lifecycle changes use
  // dedicated commands; the public row-level `pages.update` is a reload
  // tombstone for old clients.
  //
  // Indexes:
  //   - by_pageId: point lookup + admin-list overlay (§8).
  //   - by_scheduledAt: due-publish cron target (§7). Because the field is
  //     optional, callers must scope with `.gte("scheduledAt", 0)` to skip
  //     rows without a scheduled time.
  //   - by_updatedAt: TTL sweep (§9). Also optional-safe (`updatedAt` is
  //     required on every row).
  // ==========================================
  // Derived retained-occurrence accounting. Source bodies remain authoritative.
  sliceOccurrenceUsage: defineTable({
    key: v.string(),
    pageId: v.string(),
    locale: v.string(),
    type: v.string(),
    presentationId: v.string(),
    sliceId: v.string(),
    references: v.object({
      saved: v.number(),
      staging: v.number(),
      localeDraft: v.number(),
      sharedDraft: v.number(),
      candidate: v.number(),
      snapshot: v.number(),
    }),
    lastTalliedRun: v.optional(v.number()),
  })
    .index("by_key", ["key"])
    .index("by_type_and_presentationId", ["type", "presentationId"]),

  sliceOccurrenceSources: defineTable({
    key: v.string(),
    table: v.union(
      v.literal("pages"),
      v.literal("pageStaging"),
      v.literal("pageLocaleDrafts"),
      v.literal("pageSharedDrafts"),
      v.literal("pageLocalePublicationCandidates"),
      v.literal("pagePublishedSnapshots")
    ),
    sourceId: v.string(),
    fingerprint: v.string(),
    epoch: v.number(),
    invalidTypes: v.array(v.string()),
    unknownInvalid: v.boolean(),
    lastIntegrityRun: v.optional(v.number()),
  }).index("by_key", ["key"]),

  sliceOccurrenceSourceMembers: defineTable({
    sourceId: v.id("sliceOccurrenceSources"),
    occurrenceId: v.id("sliceOccurrenceUsage"),
  })
    .index("by_sourceId_and_occurrenceId", ["sourceId", "occurrenceId"])
    .index("by_occurrenceId", ["occurrenceId"]),

  sliceOccurrenceCounts: defineTable({
    type: v.string(),
    presentationId: v.string(),
    count: v.number(),
    // Type-wide integrity is stored on its default namespace row.
    invalidSources: v.number(),
    epoch: v.number(),
    version: v.number(),
    verificationCount: v.optional(v.number()),
    verificationVersion: v.optional(v.number()),
    verificationRun: v.optional(v.number()),
    verificationFinishedRun: v.optional(v.number()),
    verificationInvalidSources: v.optional(v.number()),
  }).index("by_type_and_presentationId", ["type", "presentationId"]),

  sliceOccurrenceCountState: defineTable({
    key: v.literal("slice-occurrences-v1"),
    epoch: v.number(),
    status: v.union(
      v.literal("uninitialized"),
      v.literal("building"),
      v.literal("ready"),
      v.literal("unavailable")
    ),
    mode: v.union(v.literal("backfill"), v.literal("verify")),
    unknownInvalidSources: v.number(),
    verificationFailed: v.boolean(),
    run: v.number(),
    startedAt: v.number(),
    integrityVersion: v.number(),
    verificationRun: v.optional(v.number()),
    verificationIntegrityVersion: v.optional(v.number()),
    verificationUnknownInvalidSources: v.optional(v.number()),
  }).index("by_key", ["key"]),

  pageStaging: defineTable(pageStagingTableValidator)
    .index("by_pageId", ["pageId"])
    .index("by_scheduledAt", ["scheduledAt"])
    .index("by_updatedAt", ["updatedAt"]),

  // F08a successor authority. These are additive: legacy Page-wide rows stay
  // intact until the separately reviewed migration/cleanup work proves it can
  // remove them. Public readers select this family only after the singleton
  // reaches `snapshot_active`. Convex already provides `_id` lookup and the
  // built-in `_creationTime` index; the indexes below cover only application
  // foreign keys, uniqueness/linkage checks, and filtered query predicates.
  pagePublicationCutover: defineTable({
    key: v.literal("published-snapshot-v1"),
    phase: v.union(
      v.literal("legacy"),
      v.literal("preparing"),
      v.literal("ready"),
      v.literal("snapshot_active")
    ),
    revision: v.number(),
    migrationRunId: v.optional(v.string()),
    expectedPageCount: v.optional(v.number()),
    preparedPageCount: v.optional(v.number()),
    closurePhase: v.optional(
      v.union(
        v.literal("manifests"),
        v.literal("routes"),
        v.literal("references")
      )
    ),
    closureCursor: v.optional(v.string()),
    closurePageCount: v.optional(v.number()),
    closureRollingDigest: v.optional(v.string()),
    closureDigest: v.optional(v.string()),
    cleanupStartedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  pagePublicationPageStates: defineTable({
    pageId: v.id("pages"),
    modelVersion: v.literal(1),
    lifecycleState: v.union(
      v.literal("active"),
      v.literal("archived"),
      v.literal("trashed")
    ),
    restoreLifecycleState: v.optional(
      v.union(v.literal("active"), v.literal("archived"))
    ),
    lifecycleGeneration: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_lifecycleState", ["lifecycleState"]),

  pageSharedDrafts: defineTable(pageSharedDraftsTableValidator).index(
    "by_pageId",
    ["pageId"]
  ),

  pageLocaleDrafts: defineTable(pageLocaleDraftsTableValidator)
    .index("by_pageId_and_locale", ["pageId", "locale"])
    .index("by_locale_and_slug", ["locale", "slug"])
    .index("by_pageId_and_updatedAt", ["pageId", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  pageLocalePublicationStates: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    draftGeneration: v.number(),
    draftBaseSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
    publicGeneration: v.number(),
    releaseGeneration: v.number(),
    currentReleaseId: v.optional(v.id("pageLocalePublicationReleases")),
    currentSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
    hasCurrentSnapshot: v.boolean(),
    currentPath: v.optional(v.string()),
    currentPublishedAt: v.optional(v.number()),
    pageType: v.optional(pageTypeValidator),
    publicSince: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_pageId_and_locale", ["pageId", "locale"])
    .index("by_pageId", ["pageId"])
    .index("by_locale_and_currentPath", ["locale", "currentPath"])
    .index("by_hasCurrentSnapshot_and_locale", ["hasCurrentSnapshot", "locale"])
    .index("by_currentSnapshotId", ["currentSnapshotId"])
    .index("by_hasCurrentSnapshot_and_locale_and_pageType_and_publicSince", [
      "hasCurrentSnapshot",
      "locale",
      "pageType",
      "publicSince",
    ]),

  pageLocalePublicationCandidates: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    pageType: pageTypeValidator,
    sourceDraftGeneration: v.number(),
    sourceSharedDraftGeneration: v.number(),
    sourcePublicGeneration: v.number(),
    sourceLifecycleGeneration: v.number(),
    attribution: publicationAttributionValidator,
    formatVersion: v.literal(1),
    payloadJson: v.string(),
    payloadBytes: v.number(),
    digest: v.string(),
    createdAt: v.number(),
  })
    .index("by_pageId_and_locale_and_createdAt", [
      "pageId",
      "locale",
      "createdAt",
    ])
    .index("by_digest", ["digest"]),

  pageLocalePublicationReleases: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    candidateId: v.id("pageLocalePublicationCandidates"),
    generation: v.number(),
    expectedPublicGeneration: v.number(),
    expectedLifecycleGeneration: v.number(),
    // Immediate publication and migration releases execute at their creation
    // time; a future scheduled release carries its due time.
    executeAt: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("held"),
      v.literal("cancelled"),
      v.literal("replaced"),
      v.literal("published")
    ),
    holdReason: v.optional(v.string()),
    heldAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    replacedAt: v.optional(v.number()),
    replacedByReleaseId: v.optional(v.id("pageLocalePublicationReleases")),
    publishedSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
    publishedAt: v.optional(v.number()),
    attribution: publicationAttributionValidator,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId_and_locale", ["pageId", "locale"])
    .index("by_pageId_and_locale_and_status", ["pageId", "locale", "status"])
    // Contract-named due-release index; its scheduling worker is later F08 work.
    .index("by_status_and_executeAt", ["status", "executeAt"])
    .index("by_candidateId", ["candidateId"])
    // M05 staged rollout (contract "Staged index rollout", P23): staged in C2a,
    // unstaged by C2b's first deploy. Readers land only after that deploy.
    .index("by_locale_and_status", ["locale", "status"]),

  pagePublishedSnapshots: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    generation: v.number(),
    candidateId: v.id("pageLocalePublicationCandidates"),
    candidateDigest: v.string(),
    sourceDraftGeneration: v.number(),
    sourceSharedDraftGeneration: v.number(),
    sourcePublicGeneration: v.number(),
    sourceLifecycleGeneration: v.number(),
    releaseId: v.id("pageLocalePublicationReleases"),
    publishedAt: v.number(),
    attribution: publicationAttributionValidator,
  })
    .index("by_pageId_and_locale_and_generation", [
      "pageId",
      "locale",
      "generation",
    ])
    .index("by_candidateId", ["candidateId"])
    .index("by_releaseId", ["releaseId"])
    .index("by_pageId_and_locale_and_publishedAt", [
      "pageId",
      "locale",
      "publishedAt",
    ]),

  // Immutable candidate references and the selected current-public copy are
  // deliberately separate. Replacing/withdrawing EN can therefore never
  // delete FR's current reference projection.
  pagePublicationDocumentReferences: defineTable(
    publicationDocumentReferenceValidator
  )
    .index("by_pageId_and_sourceKind", ["pageId", "sourceKind"])
    .index("by_pageId_and_locale_and_sourceKind", [
      "pageId",
      "locale",
      "sourceKind",
    ])
    .index("by_sourceKind_and_sourceId", ["sourceKind", "sourceId"])
    .index("by_targetId", ["targetId"])
    .index("by_targetId_and_sourceKind_and_locale", [
      "targetId",
      "sourceKind",
      "locale",
    ]),

  pagePublicationMediaReferences: defineTable(
    publicationMediaReferenceValidator
  )
    .index("by_pageId_and_sourceKind", ["pageId", "sourceKind"])
    .index("by_pageId_and_locale_and_sourceKind", [
      "pageId",
      "locale",
      "sourceKind",
    ])
    .index("by_sourceKind_and_sourceId", ["sourceKind", "sourceId"])
    .index("by_mediaId", ["mediaId"])
    .index("by_mediaId_and_sourceKind", ["mediaId", "sourceKind"])
    .index("by_storageId", ["storageId"]),

  pagePublicationSliceReferences: defineTable(
    publicationSliceReferenceValidator
  )
    .index("by_pageId_and_sourceKind", ["pageId", "sourceKind"])
    .index("by_pageId_and_locale_and_sourceKind", [
      "pageId",
      "locale",
      "sourceKind",
    ])
    .index("by_sourceKind_and_sourceId", ["sourceKind", "sourceId"])
    .index("by_sliceType", ["sliceType"]),

  pageHistoricalLocaleRoutes: defineTable({
    pageId: v.id("pages"),
    locale: v.string(),
    fromPath: v.string(),
    releasedAt: v.optional(v.number()),
    createdFromSnapshotId: v.id("pagePublishedSnapshots"),
    createdAt: v.number(),
  })
    .index("by_locale_and_fromPath", ["locale", "fromPath"])
    .index("by_createdFromSnapshotId", ["createdFromSnapshotId"])
    .index("by_pageId_and_locale", ["pageId", "locale"]),

  // M05 C5a: publication-owned sitemap partitions (contract "Sitemap
  // partitions"). A manifest splits each enabled locale's
  // `pageLocalePublicationStates.by_hasCurrentSnapshot_and_locale` keyspace
  // into half-open `_creationTime` ranges. No pagination cursor is persisted.
  siteSitemapManifests: defineTable({
    // ≥ 1, allocated as the highest existing version plus one.
    manifestVersion: v.number(),
    languageVersion: v.number(),
    status: v.union(
      v.literal("building"),
      v.literal("ready"),
      v.literal("superseded"),
      v.literal("abandoned")
    ),
    // Builder progress: the locale, low bound and ordinal of the partition
    // the next step closes. No `buildLocale` means every locale is closed.
    buildLocale: v.optional(v.string()),
    buildLowCreationTime: v.optional(v.number()),
    buildOrdinal: v.optional(v.number()),
    supersededAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_manifestVersion", ["manifestVersion"])
    .index("by_status_and_languageVersion", ["status", "languageVersion"]),

  siteSitemapPartitions: defineTable({
    manifestVersion: v.number(),
    locale: v.string(),
    ordinal: v.number(),
    // Inclusive low and exclusive high `_creationTime` bounds; null is
    // unbounded. Within one manifest and locale, high(k) = low(k + 1).
    lowCreationTime: v.union(v.number(), v.null()),
    highCreationTime: v.union(v.number(), v.null()),
    rowsAtBuild: v.number(),
    // One `_creationTime` tie group larger than the child ceiling, which an
    // index range cannot split: its child serves 503 and the sweep rebuilds.
    oversized: v.boolean(),
  }).index("by_manifestVersion_and_locale_and_ordinal", [
    "manifestVersion",
    "locale",
    "ordinal",
  ]),

  pagePublicationRevalidationIntents: defineTable({
    operationId: v.string(),
    operationKind: v.union(
      v.literal("publish"),
      v.literal("republish"),
      v.literal("withdraw"),
      v.literal("archive"),
      v.literal("restore"),
      v.literal("soft_delete"),
      v.literal("restore_soft_deleted")
    ),
    pageId: v.id("pages"),
    locale: v.string(),
    oldSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
    newSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
    oldPublicGeneration: v.number(),
    newPublicGeneration: v.number(),
    oldPath: v.optional(v.string()),
    newPath: v.optional(v.string()),
    phase: v.union(
      v.literal("self"),
      v.literal("referrers"),
      v.literal("descendants"),
      v.literal("complete")
    ),
    cursor: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("failed"),
      v.literal("complete")
    ),
    attempts: v.number(),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_pageId_and_locale", ["pageId", "locale"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"]),

  pagePublicationMigrationPages: defineTable({
    pageId: v.id("pages"),
    migrationRunId: v.string(),
    sourcePageDigest: v.string(),
    sourceStagingDigest: v.optional(v.string()),
    sourcePageWidePublicationDigest: v.optional(v.string()),
    sourceLocaleHomeConfigDigest: v.string(),
    pageStateId: v.id("pagePublicationPageStates"),
    sharedDraftId: v.id("pageSharedDrafts"),
    localeDraftIds: v.array(v.id("pageLocaleDrafts")),
    localeStateIds: v.array(v.id("pageLocalePublicationStates")),
    candidateIds: v.array(v.id("pageLocalePublicationCandidates")),
    releaseIds: v.array(v.id("pageLocalePublicationReleases")),
    snapshotIds: v.array(v.id("pagePublishedSnapshots")),
    workingReferenceCount: v.number(),
    candidateReferenceCount: v.number(),
    publicReferenceCount: v.number(),
    successorArtifactDigest: v.string(),
    preparedAt: v.number(),
  })
    .index("by_pageId_and_run", ["pageId", "migrationRunId"])
    .index("by_run_and_pageId", ["migrationRunId", "pageId"]),

  pagePublicationPreviewSessions: defineTable({
    sessionToken: v.string(),
    ownerId: v.id("cmsOwner"),
    authId: v.string(),
    tokenIdentifier: v.string(),
    pageId: v.id("pages"),
    requestedLocale: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_sessionToken", ["sessionToken"])
    .index("by_pageId_and_locale", ["pageId", "requestedLocale"])
    .index("by_expiresAt", ["expiresAt"]),

  // Persistent publication-unit identity. Unlike pageStaging.updatedAt,
  // these monotonic generations survive promote/discard/TTL deletion and do
  // not churn the public Page document's updatedAt projection.
  pagePublicationStates: defineTable({
    pageId: v.id("pages"),
    draftGeneration: v.number(),
    publicGeneration: v.number(),
    currentReleaseId: v.optional(v.id("pagePublicationReleases")),
    releaseGeneration: v.optional(v.number()),
    currentExpiryId: v.optional(v.id("pagePublicationExpiries")),
    expiryGeneration: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_pageId", ["pageId"]),

  // ==========================================
  // Team editorial workflow — Phase 4.
  //
  // The schema is capability-neutral infrastructure. The current owner-only
  // runtime exposes no workflow functions or UI; a later reviewed Team
  // capability may read or mutate these rows. State is one mutable pointer per
  // Page. Events are append-only through the application API and intentionally
  // have no retention sweep.
  // ==========================================
  teamWorkflowStates: defineTable({
    pageId: v.id("pages"),
    status: teamWorkflowStatusValidator,
    version: v.number(),
    stagingId: v.optional(v.id("pageStaging")),
    snapshotDigest: v.optional(v.string()),
    submittedBy: v.optional(v.string()),
    submittedAt: v.optional(v.number()),
    approvedBy: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_pageId", ["pageId"]),

  teamWorkflowEvents: defineTable({
    pageId: v.id("pages"),
    action: teamWorkflowActionValidator,
    actorKind: v.union(v.literal("member"), v.literal("system")),
    actorId: v.string(),
    priorState: teamWorkflowStatusValidator,
    resultState: teamWorkflowStatusValidator,
    workflowVersion: v.number(),
    candidateId: v.optional(v.id("pagePublicationCandidates")),
    roundId: v.optional(v.id("teamReviewRounds")),
    assignmentId: v.optional(v.id("teamReviewAssignments")),
    actorAuthId: v.optional(v.string()),
    actorMembershipId: v.optional(v.id("cmsMemberships")),
    snapshotDigest: v.optional(v.string()),
    note: v.optional(v.string()),
    origin: v.union(v.literal("interactive"), v.literal("scheduled")),
    createdAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_roundId", ["roundId"]),

  // U5 server foundation. Candidates and their reference fan-out are
  // append-only evidence; unlike pageStaging/page references, they survive
  // publication, pruning, and permanent parent deletion.
  pagePublicationCandidates: defineTable({
    pageId: v.id("pages"),
    pageType: pageTypeValidator,
    originalOwner: v.optional(v.string()),
    sourceDraftGeneration: v.number(),
    sourcePublicGeneration: v.number(),
    actorPrincipal: v.string(),
    actorAuthId: v.string(),
    actorMembershipId: v.id("cmsMemberships"),
    formatVersion: v.number(),
    payloadJson: v.string(),
    payloadBytes: v.number(),
    digest: v.string(),
    createdAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_pageId_and_createdAt", ["pageId", "createdAt"]),

  // One durable command identity for every immediate or scheduled promotion.
  // The candidate is immutable; replacement creates a new release row rather
  // than retargeting an old job. Held/terminal rows remain audit evidence.
  pagePublicationReleases: defineTable({
    pageId: v.id("pages"),
    candidateId: v.id("pagePublicationCandidates"),
    roundId: v.optional(v.id("teamReviewRounds")),
    requiresReview: v.boolean(),
    policyVersion: v.number(),
    authorPrincipal: v.string(),
    authorAuthId: v.string(),
    authorMembershipId: v.id("cmsMemberships"),
    executeAt: v.number(),
    generation: v.number(),
    status: publicationReleaseStatusValidator,
    holdReason: v.optional(v.string()),
    heldAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    replacedAt: v.optional(v.number()),
    replacedByReleaseId: v.optional(v.id("pagePublicationReleases")),
    publishedAt: v.optional(v.number()),
    publicGeneration: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_pageId_and_status", ["pageId", "status"])
    .index("by_status_and_executeAt", ["status", "executeAt"])
    .index("by_candidateId", ["candidateId"])
    .index("by_roundId", ["roundId"]),

  // Scheduled takedown is independent from candidate promotion. It names the
  // exact public generation it may archive so an old timer cannot remove a
  // newer publication.
  pagePublicationExpiries: defineTable({
    pageId: v.id("pages"),
    expectedPublicGeneration: v.number(),
    authorPrincipal: v.string(),
    authorAuthId: v.string(),
    authorMembershipId: v.id("cmsMemberships"),
    executeAt: v.number(),
    generation: v.number(),
    status: publicationExpiryStatusValidator,
    holdReason: v.optional(v.string()),
    heldAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    replacedAt: v.optional(v.number()),
    replacedByExpiryId: v.optional(v.id("pagePublicationExpiries")),
    executedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_pageId_and_status", ["pageId", "status"])
    .index("by_status_and_executeAt", ["status", "executeAt"]),

  pageCandidateMediaReferences: defineTable({
    candidateId: v.id("pagePublicationCandidates"),
    pageId: v.id("pages"),
    mediaId: v.optional(v.id("media")),
    storageId: v.optional(v.id("_storage")),
    locale: v.optional(v.string()),
    path: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_candidateId", ["candidateId"])
    .index("by_mediaId", ["mediaId"])
    .index("by_storageId", ["storageId"]),

  pageCandidateDocumentReferences: defineTable({
    candidateId: v.id("pagePublicationCandidates"),
    pageId: v.id("pages"),
    targetId: v.id("pages"),
    targetType: v.string(),
    sourceLocale: v.optional(v.string()),
    path: v.string(),
    source: v.string(),
    createdAt: v.number(),
  })
    .index("by_candidateId", ["candidateId"])
    .index("by_targetId", ["targetId"]),

  pageCandidateSliceReferences: defineTable({
    candidateId: v.id("pagePublicationCandidates"),
    pageId: v.id("pages"),
    sliceType: v.string(),
    count: v.number(),
    createdAt: v.number(),
  })
    .index("by_candidateId", ["candidateId"])
    .index("by_sliceType", ["sliceType"]),

  teamPublishingPolicies: defineTable({
    key: v.literal("publishing"),
    setupState: teamPublishingPolicySetupValidator,
    initializedFrom: v.union(
      v.literal("owner_bootstrap"),
      v.literal("explicit_setup")
    ),
    enabled: v.boolean(),
    selectedPageTypes: v.array(pageTypeValidator),
    reviewerMembershipIds: v.array(v.id("cmsMemberships")),
    requiredApprovals: v.number(),
    version: v.number(),
    createdAt: v.number(),
    createdByAuthId: v.string(),
    updatedAt: v.number(),
    updatedByAuthId: v.string(),
  }).index("by_key", ["key"]),

  teamPublishingPolicyAudit: defineTable({
    policyVersion: v.number(),
    action: v.union(v.literal("initialize"), v.literal("update")),
    actorAuthId: v.string(),
    beforeJson: v.optional(v.string()),
    afterJson: v.string(),
    createdAt: v.number(),
  }).index("by_policyVersion", ["policyVersion"]),

  teamReviewRounds: defineTable({
    pageId: v.id("pages"),
    candidateId: v.id("pagePublicationCandidates"),
    pageType: pageTypeValidator,
    originalOwner: v.optional(v.string()),
    submitterPrincipal: v.string(),
    submitterAuthId: v.string(),
    submitterMembershipId: v.id("cmsMemberships"),
    policyVersion: v.number(),
    requiredApprovals: v.number(),
    eligibleReviewerPrincipals: v.array(v.string()),
    status: teamReviewRoundStatusValidator,
    commandVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_pageId", ["pageId"])
    .index("by_pageId_and_status", ["pageId", "status"])
    .index("by_candidateId", ["candidateId"])
    .index("by_status", ["status"]),

  teamReviewAssignments: defineTable({
    roundId: v.id("teamReviewRounds"),
    reviewerPrincipal: v.string(),
    reviewerAuthId: v.string(),
    reviewerMembershipId: v.id("cmsMemberships"),
    status: v.optional(teamReviewAssignmentStatusValidator),
    decidedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
    retiredByPrincipal: v.optional(v.string()),
    retiredReason: v.optional(v.string()),
    replacesAssignmentId: v.optional(v.id("teamReviewAssignments")),
    assignedAt: v.number(),
    assignedByPrincipal: v.string(),
  })
    .index("by_roundId", ["roundId"])
    .index("by_reviewerPrincipal_and_assignedAt", [
      "reviewerPrincipal",
      "assignedAt",
    ])
    .index("by_reviewerPrincipal_and_status_and_assignedAt", [
      "reviewerPrincipal",
      "status",
      "assignedAt",
    ])
    .index("by_roundId_and_reviewerPrincipal", [
      "roundId",
      "reviewerPrincipal",
    ]),

  teamReviewDecisions: defineTable({
    roundId: v.id("teamReviewRounds"),
    assignmentId: v.optional(v.id("teamReviewAssignments")),
    reviewerPrincipal: v.string(),
    reviewerAuthId: v.string(),
    reviewerMembershipId: v.id("cmsMemberships"),
    decision: v.union(v.literal("approved"), v.literal("changes_requested")),
    note: v.optional(v.string()),
    roundCommandVersion: v.number(),
    createdAt: v.number(),
  })
    .index("by_roundId", ["roundId"])
    .index("by_assignmentId", ["assignmentId"])
    .index("by_roundId_and_reviewerPrincipal", [
      "roundId",
      "reviewerPrincipal",
    ]),

  // ==========================================
  // Author/member identity links
  //
  // Private system-owned association state. Better Auth user ids deliberately
  // do not live on the public Author descriptor/page arm, staging snapshots,
  // revisions, search rows, or webhook payloads.
  // ==========================================
  authorMemberLinks: defineTable({
    authorPageId: v.id("pages"),
    authId: v.string(),
    linkedAt: v.number(),
    linkedByAuthId: v.string(),
  })
    .index("by_authorPageId", ["authorPageId"])
    .index("by_authId", ["authId"]),

  // ==========================================
  // CMS: Menus
  // ==========================================
  menus: defineTable(menuFields).index("by_slug", ["slug"]),

  // Plan 035 A1b/C3 — exact materialized fan-out for live menu targets.
  // `path` is ID-addressed and reorder-stable; repeated targets at distinct
  // paths intentionally produce distinct rows. A1c reads `by_target` for
  // page-delete impact and blocks permanent deletion while a live menu links
  // to the target.
  menuReferences: defineTable({
    menuId: v.id("menus"),
    targetId: v.id("pages"),
    path: v.string(),
    updatedAt: v.number(),
  })
    .index("by_target", ["targetId"])
    .index("by_menu", ["menuId"]),

  // ==========================================
  // CMS: Media
  // ==========================================
  media: defineTable(mediaFields)
    .index("by_filename", ["filename"])
    .index("by_storageId", ["storageId"])
    .index("by_folder", ["folder"])
    .index("by_folder_and_uploadedAt", ["folder", "uploadedAt"])
    .searchIndex("search_filename", {
      searchField: "filename",
      filterFields: ["folder"],
    }),

  mediaReferences: defineTable({
    mediaId: v.id("media"),
    storageId: v.id("_storage"),
    pageId: v.id("pages"),
    locale: v.optional(v.string()),
    path: v.string(),
    source: v.union(
      v.literal("slice-image"),
      v.literal("slice-media-link"),
      v.literal("card-image"),
      // Plan 029 C10 — descriptor-level `image()` fields on shared /
      // localized field maps (e.g. testimonial.personImage). Emitted by
      // `collectMediaReferences`'s descriptor walk.
      v.literal("descriptor-image")
    ),
    updatedAt: v.number(),
  })
    .index("by_mediaId", ["mediaId"])
    .index("by_storageId", ["storageId"])
    .index("by_pageId", ["pageId"])
    .index("by_mediaId_and_pageId", ["mediaId", "pageId"]),

  // ==========================================
  // CMS: Document references — cross-page relations recorded by ADR-0037 / plan
  // 028 C2. One row per `relation()` field on a `pages` document; the write-path
  // scanner (`refreshDocumentReferencesForPage`) rebuilds fan-out on save.
  //
  // Consumers:
  //   - Deletion guards: "N pages reference this doc" via `by_target`
  //   - "Referenced-by" admin surfaces via `by_target`
  //   - Relation-aware revalidation (fan-in: touch a doc → invalidate sources)
  //   - Uniqueness sanity via `by_target_and_source`
  //
  // `path` is the descriptor-level dotted address of the source field
  // (e.g. `authorId`, or `content.en.slices[3].primary.relatedPost`). `source`
  // enumerates coarse origin buckets (top-level `sharedFields`, per-locale
  // `localizedFields`, slice body) so admin surfaces can group fan-out.
  // ==========================================
  documentReferences: defineTable({
    sourceId: v.id("pages"),
    sourceLocale: v.optional(v.string()),
    targetId: v.id("pages"),
    targetType: v.string(),
    path: v.string(),
    source: v.union(
      v.literal("shared-field"),
      v.literal("localized-field"),
      v.literal("slice-body")
    ),
    updatedAt: v.number(),
  })
    .index("by_target", ["targetId"])
    .index("by_source", ["sourceId"])
    .index("by_target_and_source", ["targetId", "sourceId"]),

  // ==========================================
  // CMS: Media Folders
  // ==========================================
  folders: defineTable({
    name: v.string(),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  // ==========================================
  // Site Settings (singleton row, read via `.first()`)
  // ==========================================
  siteSettings: defineTable(siteSettingsFields),

  // Bounded, secret-free operational trace of scheduled cache revalidation.
  revalidationAttempts: defineTable({
    target: revalidationTargetValidator,
    pathCount: v.number(),
    tagCount: v.number(),
    status: revalidationStatusValidator,
    httpStatus: v.optional(v.number()),
    errorSnippet: v.optional(v.string()),
    timestamp: v.number(),
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_status_and_timestamp", ["status", "timestamp"]),

  // ==========================================
  // Email settings (split off siteSettings per ADR-0024 + ADR-0029).
  // Singleton row read via `.first()`; no indexes needed. SMTP password is
  // encrypted at rest (AES-GCM with CMS_SECRET_KEY) — see ADR-0029 §1.
  // Note: "resend" is intentionally dropped per ADR-0024 (no native vendor
  // adapters in v1); legacy provider="resend" rows in `siteSettings` are
  // migrated to "console" in Phase 3.
  // ==========================================
  emailSettings: defineTable({
    provider: v.union(v.literal("console"), v.literal("smtp")),
    fromAddress: v.optional(v.string()),
    fromName: v.optional(v.string()),
    smtpHost: v.optional(v.string()),
    smtpPort: v.optional(v.number()),
    smtpSecure: v.optional(v.boolean()),
    smtpUser: v.optional(v.string()),
    // ENCRYPTED at rest. Never returned by any query directly — admin UI sees
    // a `hasPassword` derived field, not this one. See ADR-0029 §1.
    smtpPasswordCiphertext: v.optional(v.string()),
    schemaVersion: v.number(),
    updatedAt: v.number(),
  }),

  // ==========================================
  // E02 email successor state. This side-by-side singleton is the typed
  // destination for E03's separately gated dual-read and migration and the
  // authority consumed by E04 delivery plus E05 owner configuration. Missing
  // state means the non-delivering Console fallback.
  // ==========================================
  emailProviderState: defineTable(emailProviderStateFields).index("by_key", [
    "key",
  ]),

  // E05 short-lived, single-use proof that the current provider/configuration
  // version produced a provider-accepted owner test.
  emailProviderActivationReceipts: defineTable(
    emailProviderActivationReceiptFields
  )
    .index("by_providerId_and_configurationVersion", [
      "providerId",
      "configurationVersion",
    ])
    .index("by_expiresAt", ["expiresAt"]),

  // E03 source-only SMTP-retirement receipt. The record contains counts and
  // opaque fingerprints only: no credential, raw legacy configuration, or
  // sender address. Legacy fields and ciphertext remain in place until a
  // separately authorized cleanup makes the narrowing guard pass.
  emailProviderMigrationReceipts: defineTable(
    emailProviderMigrationReceiptFields
  ).index("by_key", ["key"]),

  // E04 private delivery envelope. Action Retrier receives only this row's
  // opaque ID; recipient/content never enters component arguments or results.
  // Completion clears `message`, and a per-event expiry job bounds orphaned
  // payload retention.
  emailDeliveryEvents: defineTable(emailDeliveryEventFields)
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_runId", ["runId"])
    .index("by_expiresAt", ["expiresAt"]),

  // ==========================================
  // Typed form submissions (public endpoint, ADR-0029 §2 + ADR-0040).
  // `ipHash` is sha256(lowercased IP) — never the raw IP. The email-delivery
  // outcome is recorded by the notification action introduced in Phase 3.
  // ==========================================
  formSubmissions: defineTable({
    form: v.literal("contact"),
    // Derived from `contactPayloadSchema` (ADR-0040) so the authored form
    // schema is the only enumeration of the stored fields.
    payload: contactPayloadValidator,
    sourcePath: v.optional(v.string()),
    sourceLocale: v.optional(v.string()),
    ipHash: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    notifyStatus: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("rate_limited")
    ),
    notifyError: v.optional(v.string()),
    notifyAttempts: v.number(),
    notifiedAt: v.optional(v.number()),
    // ActionRetrier runId for the in-flight notification. Persisted so the
    // retrier's onComplete callback (which only receives `{ runId, result }`)
    // can correlate back to the submission row.
    notifyRunId: v.optional(v.string()),
    readAt: v.optional(v.number()),
    schemaVersion: v.number(),
    createdAt: v.number(),
  })
    .index("by_form", ["form"])
    .index("by_createdAt", ["createdAt"])
    .index("by_notifyStatus", ["notifyStatus"])
    .index("by_readAt", ["readAt"])
    .index("by_notifyRunId", ["notifyRunId"]),

  // ==========================================
  // AI agent configs (per-agent overrides; registry holds defaults)
  // ==========================================
  // One row per agent that the operator has customized. Absent fields fall back
  // to convex/lib/agents/registry.ts defaults; absent `model` falls back to
  // siteSettings.aiDefaultModel → env → built-in default. Extend the `agent`
  // union to introduce new configurable agents.
  agentConfigs: defineTable({
    agent: v.union(
      v.literal("translation"),
      v.literal("content"),
      v.literal("slice-author"),
      v.literal("slice-renderer"),
      v.literal("help-assistant")
    ),
    model: v.optional(v.string()),
    // Unit D3 typed per-provider overrides. The legacy free-form `model`
    // remains readable only for the no-typed-selection compatibility branch.
    modelOverrides: v.optional(providerModelSelectionsValidator),
    /** @deprecated Never read. The system prompt is the agents' output contract,
     *  not an operator knob — exposing it let a bad override silently corrupt
     *  translations and content. It is unwritable (`updateAgent` has no such arg)
     *  and the runtime always uses the registry default. The column survives only
     *  because a Convex validator cannot drop a field that still has rows; run
     *  `cms/agents:clearStoredSystemPrompts` on each deployment, then delete it. */
    systemPrompt: v.optional(v.string()),
    userPromptTemplate: v.optional(v.string()),
    // Content-agent only: operator-curated preset libraries that surface in the
    // editor's Write / Refine dialogs. `undefined` means "use registry defaults";
    // an explicit empty array means "hide the picker entirely".
    writeBriefs: v.optional(
      v.array(v.object({ label: v.string(), body: v.string() }))
    ),
    refinePresets: v.optional(
      v.array(v.object({ label: v.string(), body: v.string() }))
    ),
    updatedAt: v.number(),
  }).index("by_agent", ["agent"]),

  // ==========================================
  // OpenRouter model catalog
  // ==========================================
  // One row per model keeps the weekly catalog bounded and queryable without
  // rewriting an unbounded array document. The bundled generated catalog is
  // the bootstrap fallback until the first successful synchronized snapshot.
  openRouterCatalogModels: defineTable({
    modelId: v.string(),
    name: v.string(),
    inputModalities: v.array(
      v.union(
        v.literal("text"),
        v.literal("image"),
        v.literal("file"),
        v.literal("audio"),
        v.literal("video")
      )
    ),
    structuredOutput: v.boolean(),
    reasoningEfforts: v.array(reasoningEffortValidator),
    inputPerM: v.optional(v.number()),
    outputPerM: v.optional(v.number()),
    ceilingInputPerM: v.optional(v.number()),
    ceilingOutputPerM: v.optional(v.number()),
    syncedAt: v.number(),
  }).index("by_modelId", ["modelId"]),

  openRouterCatalogSync: defineTable({
    key: v.literal("openrouter"),
    status: v.union(
      v.literal("running"),
      v.literal("success"),
      v.literal("failed")
    ),
    runId: v.optional(v.string()),
    lastAttemptAt: v.number(),
    lastSuccessAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    modelCount: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // ==========================================
  // AI audit log (ADR-0015) — one row per runtime AI generation call.
  // Privacy contract: stores SHA-256 of the brief, never the brief text or
  // the generated output. 90-day retention enforced by the nightly cron in
  // `convex/crons.ts`. Per-user erasure via the admin-only
  // `deleteAuditLogForUser` mutation. `authId` matches the `roles`-table key
  // (Better Auth `_id` == identity.subject) so erasure-by-user is targetable
  // using the value the Members UI already surfaces.
  // ==========================================
  aiJobs: defineTable({
    authId: v.string(),
    kind: v.union(v.literal("write"), v.literal("translation")),
    title: v.string(),
    locale: v.string(),
    pageId: v.id("pages"),
    sourceLocale: v.optional(v.string()),
    targetLocale: v.optional(v.string()),
    draftGeneration: v.number(),
    state: aiPageJobStateValidator,
    stopReason: v.optional(
      v.union(v.literal("canceled"), v.literal("failed"), v.literal("capped"))
    ),
    tuple: runtimeModelTupleValidator,
    brief: v.optional(v.string()),
    sourcePage: v.optional(aiPageJobContentValidator),
    suggestion: v.optional(aiPageJobContentValidator),
    assistantInstructions: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    userPromptTemplate: v.optional(v.string()),
    brandVoice: v.optional(v.string()),
    reservationKey: v.optional(v.string()),
    estimateMicros: v.number(),
    costMicros: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(),
    reviewedAt: v.optional(v.number()),
    // Write jobs only: the page's lifecycle and shared-draft generations right
    // after Start created it. Dismiss trashes the page only while they hold.
    startLifecycleGeneration: v.optional(v.number()),
    startSharedDraftGeneration: v.optional(v.number()),
    // Translation jobs only: the target language's draft generation at Start
    // (0 when the language has no state row). Accept refuses if it moved.
    targetDraftGeneration: v.optional(v.number()),
  })
    .index("by_authId_and_state", ["authId", "state"])
    .index("by_authId_and_reviewedAt", ["authId", "reviewedAt"]),
  aiJobUnits: defineTable({
    authId: v.string(),
    jobId: v.id("aiJobs"),
    index: v.number(),
    kind: v.union(v.literal("write"), v.literal("translation")),
    sliceType: v.optional(v.string()),
    purpose: v.optional(v.string()),
    address: v.optional(v.string()),
    segmentKind: v.optional(v.union(v.literal("text"), v.literal("richText"))),
    input: v.optional(v.string()),
    output: v.optional(v.union(installedSliceValidator, v.string())),
    state: v.union(
      v.literal("waiting"),
      v.literal("inProgress"),
      v.literal("saved"),
      v.literal("failed")
    ),
    reused: v.boolean(),
    costMicros: v.number(),
    workId: v.optional(v.string()),
    claimToken: v.optional(v.string()),
    admittedClaim: v.optional(v.string()),
    attemptKeys: v.array(v.string()),
  })
    .index("by_jobId_and_index", ["jobId", "index"])
    .index("by_authId", ["authId"]),
  aiSpendingJobReservations: defineTable({
    reservationKey: v.string(),
    authId: v.string(),
    jobId: v.id("aiJobs"),
    monthId: v.id("aiSpendingMonths"),
    monthKey: v.string(),
    estimateMicros: v.number(),
    remainingMicros: v.number(),
    state: v.union(v.literal("open"), v.literal("released")),
    createdAt: v.number(),
    releasedAt: v.optional(v.number()),
  })
    .index("by_reservationKey", ["reservationKey"])
    .index("by_jobId", ["jobId"])
    .index("by_authId", ["authId"]),
  aiSpendingMonths: defineTable({
    siteKey: v.literal("installation"),
    monthKey: v.string(),
    timeZone: v.string(),
    periodEndMs: v.number(),
    spentMicros: v.number(),
    reservedMicros: v.number(),
  })
    .index("by_siteKey_and_monthKey", ["siteKey", "monthKey"])
    .index("by_siteKey_and_periodEndMs", ["siteKey", "periodEndMs"]),
  aiProviderHealth: defineTable(providerHealthValidator).index("by_provider", ["provider"]),

  aiSpendingAttempts: defineTable({
    providerObservationRecorded: v.optional(v.boolean()),
    attemptKey: v.string(),
    authId: v.string(),
    monthId: v.id("aiSpendingMonths"),
    monthKey: v.string(),
    runId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    provider: runtimeApiProviderValidator,
    modelId: v.string(),
    lane: executionLaneValidator,
    profile: aiAccountingProfileValidator,
    phase: workflowPhaseValidator,
    inputTokens: v.number(),
    imageTokens: v.number(),
    maxOutputTokens: v.number(),
    price: aiPriceQuoteValidator,
    estimateMicros: v.number(),
    reservedMicros: v.number(),
    state: v.union(
      v.literal("open"),
      v.literal("released"),
      v.literal("settled")
    ),
    chargedMicros: v.optional(v.number()),
    costSource: v.optional(aiCostSourceValidator),
    createdAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    .index("by_attemptKey", ["attemptKey"])
    .index("by_authId", ["authId"]),

  aiAuditLog: defineTable({
    authId: v.string(),
    kind: v.union(
      v.literal("page-generate-outline"),
      v.literal("page-generate-fill"),
      v.literal("page-generate-meta"),
      v.literal("help-answer"),
      v.literal("page-translate"),
      v.literal("field-translate"),
      v.literal("field-generate"),
      v.literal("field-refine"),
      v.literal("slice-generate"),
      v.literal("slice-author-propose")
    ),
    runId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    attemptId: v.optional(v.string()),
    chargedMicros: v.optional(v.number()),
    currency: v.optional(v.literal("USD")),
    costSource: v.optional(aiCostSourceValidator),
    briefHash: v.optional(v.string()),
    sliceCount: v.number(),
    modelId: v.string(),
    profile: v.optional(taskProfileValidator),
    selectedLane: v.optional(executionLaneValidator),
    selectedEngine: v.optional(generationEngineValidator),
    selectedProvider: v.optional(runtimeApiProviderValidator),
    selectedModel: v.optional(v.string()),
    selectedReasoning: v.optional(reasoningEffortValidator),
    actualProvider: v.optional(runtimeApiProviderValidator),
    actualEngine: v.optional(generationEngineValidator),
    actualModel: v.optional(v.string()),
    actualReasoning: v.optional(reasoningEffortValidator),
    routedProvider: v.optional(v.string()),
    phase: v.optional(workflowPhaseValidator),
    attempts: v.optional(aiAttemptCountValidator),
    identityEvidence: v.optional(generationIdentityEvidenceValidator),
    tokenUsage: v.object({
      promptTokens: v.optional(v.number()),
      completionTokens: v.optional(v.number()),
      totalTokens: v.optional(v.number()),
    }),
    success: v.boolean(),
    errorCode: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_authId", ["authId"])
    .index("by_createdAt", ["createdAt"]),

  // ==========================================
  // Redirects
  // ==========================================
  // Source/destination paths are stored WITHOUT locale prefix (the proxy strips
  // it before matching). `locale` scopes a redirect to one language; omitting it
  // means "apply across every locale" — the common case for slug renames.
  // ==========================================
  // Outbound webhooks (plan 023 Phase 4 #7)
  // ==========================================
  webhookEndpoints: defineTable({
    url: v.string(),
    // HMAC-SHA256 signing key, generated server-side at creation. Never
    // returned by the `listEndpoints` projection; readable only through
    // `getEndpointSecret`, which is gated on `settings:update` (admin-only).
    secret: v.string(),
    events: v.array(webhookEventValidator),
    enabled: v.boolean(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
    updatedAt: v.number(),
  }),

  // One row per attempted delivery — the admin-visible audit trail. `payload`
  // stores the exact signed JSON bytes so a receiver can be debugged against
  // what was actually sent.
  webhookDeliveries: defineTable({
    endpointId: v.id("webhookEndpoints"),
    event: webhookEventValidator,
    payload: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("success"),
      v.literal("failed")
    ),
    attempts: v.number(),
    responseStatus: v.optional(v.number()),
    error: v.optional(v.string()),
    // action-retrier run id, for the onComplete correlation (same pattern as
    // formSubmissions.notifyRunId).
    runId: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_endpointId_and_createdAt", ["endpointId", "createdAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_runId", ["runId"]),

  redirects: defineTable({
    fromPath: v.string(),
    toPath: v.optional(v.string()),
    toPageId: v.optional(v.id("pages")),
    locale: v.optional(v.string()),
    statusCode: v.union(v.literal(301), v.literal(302)),
    createdAt: v.number(),
    updatedAt: v.number(),
    // Explicit rule provenance (M01a). `cms/redirects.create` stamps "manual".
    // Absent means the row predates provenance and its origin is unresolved:
    // never backfilled and never inferred from path shape. Required historical
    // locale URL continuity is not stored here; Publication owns it in
    // `pageHistoricalLocaleRoutes`. Read through `redirectRuleOrigin`.
    origin: v.optional(v.literal("manual")),
  })
    .index("by_locale_fromPath", ["locale", "fromPath"])
    .index("by_fromPath", ["fromPath"])
    .index("by_toPageId", ["toPageId"]),

  // ==========================================
  // CMS: Content Tags
  // ==========================================
  // Shared tag pool for pages and media. Stored on `pages.tags` / `media.tags`
  // as denormalized canonical slugs (descriptor code references slugs, see
  // `relation({ tag })` in convex/lib/slices/primitives.ts). No unique
  // constraint at the DB level — `ensureMany` looks up `by_slug` before
  // inserting; Convex OCC makes the read-then-insert race-safe within one
  // mutation.
  tags: defineTable({
    slug: v.string(),
    label: v.string(),
    description: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

  // ==========================================
  // Invites — single-use admin invitations to join the CMS (Phase 10).
  // Token-based: a 256-bit random token is generated at issuance, the email
  // recipient gets the plaintext via the invite URL, and ONLY the SHA-256
  // hash is persisted here. `tokenHash` is the lookup key on accept; the
  // plaintext is never re-retrievable from the DB. `email` is normalized
  // lowercase before insert. `usedAt` flips the row into "consumed" state
  // on a successful `acceptInvite`; expired/used rows can be GC'd later.
  // ==========================================
  invites: defineTable({
    email: v.string(),
    // Widened alongside `roles.role` (ADR-0035) so custom-role names can be
    // invited. Role existence is re-validated on both create and accept.
    role: v.string(),
    /** SHA-256 hex of the plaintext token. */
    tokenHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    /** authId of the admin who issued the invite. */
    invitedBy: v.string(),
    /**
     * Versioned evidence captured by the committing issuance mutation. Legacy
     * rows without this marker remain listable but cannot be accepted until an
     * admin cancels and reissues them.
     */
    authorization: v.optional(
      v.object({
        kind: v.literal("exact_admin"),
        actorAuthId: v.string(),
        recordedAt: v.number(),
        version: v.literal(1),
      })
    ),
    /** Action-retrier run used to derive queued/sent/failed delivery state. */
    deliveryRunId: v.optional(v.string()),
    /** E04 normalized delivery truth; the E05 UI owns its final projection. */
    deliveryState: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("provider_accepted"),
        v.literal("failed"),
        v.literal("unknown")
      )
    ),
    deliveryError: v.optional(v.string()),
    /** Phase 3 capacity reservation bound to this invite. */
    reservationKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_email", ["email"])
    // Lets custom-role delete/rename cascade to pending invites without a
    // full-table scan (ADR-0035 follow-up).
    .index("by_role", ["role"]),

  // ==========================================
  // Owner-claim ledger — one singleton document recording consumption of the
  // currently configured deployment claim. `secretHash` is SHA-256 of
  // FORMULACMS_OWNER_CLAIM (or its legacy fallback); plaintext is never stored.
  // Rotating the secret changes the hash and permits one recorded recovery claim
  // without deriving authority from role-table contents.
  // ==========================================
  ownerClaimLedger: defineTable({
    key: v.literal("owner"),
    secretHash: v.string(),
    claimedBy: v.string(),
    claimedAt: v.number(),
    recovery: v.boolean(),
    /** Phase 3 owner bootstrap/recovery reservation consumed by this claim. */
    reservationKey: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // ==========================================
  // Durable Community owner — the one installation authority. Its Convex
  // document ID is the stable owner identity; the Better Auth binding may be
  // replaced without changing that ID or historical content attribution.
  // ==========================================
  cmsOwner: defineTable({
    key: v.literal("owner"),
    authId: v.string(),
    tokenIdentifier: v.string(),
    establishedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ==========================================
  // Module configuration — one authoritative Community installation row.
  // `configurationVersion` is the monotonic compare-and-set revision owned by
  // F07b. This F07a shape records only owner-enabled optional modules; required
  // modules are derived as fixed active from the static catalog.
  // ==========================================
  cmsModuleState: defineTable({
    key: v.literal("owner"),
    configurationVersion: v.number(),
    enabledModules: v.array(
      v.object({
        moduleId: v.string(),
        configVersion: v.number(),
      })
    ),
  }).index("by_key", ["key"]),

  // ==========================================
  // CMS membership + capacity — Phase 3 authoritative authorization state.
  // `authId` is the Better Auth user id carried in identity.subject. The
  // singleton capacity key is only a local OCC serialization scope; it is not
  // the future licensed "production project" identity from ADR-0049.
  // ==========================================
  cmsMemberships: defineTable({
    authId: v.string(),
    tokenIdentifier: v.optional(v.string()),
    role: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("suspended"),
      v.literal("removed")
    ),
    createdAt: v.number(),
    activatedAt: v.number(),
    suspendedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    updatedAt: v.number(),
    updatedBy: v.optional(v.string()),
    transitionId: v.string(),
    migrationVersion: v.optional(v.number()),
  })
    .index("by_authId", ["authId"])
    .index("by_status_and_role", ["status", "role"])
    .index("by_migrationVersion", ["migrationVersion"]),

  cmsSeatReservations: defineTable({
    reservationKey: v.string(),
    kind: v.union(
      v.literal("ordinary_invite"),
      v.literal("owner_bootstrap"),
      v.literal("replacement")
    ),
    status: v.union(
      v.literal("active"),
      v.literal("consumed"),
      v.literal("cancelled"),
      v.literal("expired")
    ),
    inviteId: v.optional(v.id("invites")),
    tokenHash: v.optional(v.string()),
    email: v.optional(v.string()),
    claimHash: v.optional(v.string()),
    outgoingAuthId: v.optional(v.string()),
    /**
     * Owner recovery records whether an active predecessor supplied the seat
     * at reservation time. `false` means this replacement consumes one
     * reserved seat until claim or expiry. Ordinary replacements omit it.
     */
    replacesActiveSeat: v.optional(v.boolean()),
    successorAuthId: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    actorAuthId: v.optional(v.string()),
    transitionId: v.string(),
    migrationVersion: v.optional(v.number()),
  })
    .index("by_reservationKey", ["reservationKey"])
    .index("by_inviteId", ["inviteId"])
    .index("by_claimHash", ["claimHash"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"])
    .index("by_outgoingAuthId", ["outgoingAuthId"])
    .index("by_migrationVersion", ["migrationVersion"]),

  cmsProductionProject: defineTable({
    key: v.literal("production_project"),
    projectId: v.string(),
    establishedByLicenseId: v.string(),
    establishedAt: v.number(),
  }).index("by_key", ["key"]),

  cmsInstalledEntitlement: defineTable({
    key: v.literal("team"),
    rawEnvelope: v.string(),
    keyId: v.string(),
    licenseId: v.string(),
    licensee: v.string(),
    projectId: v.string(),
    memberCapacity: v.number(),
    issuedAt: v.string(),
    reissueRef: v.optional(v.string()),
    installedAt: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  cmsEntitlementEvents: defineTable({
    eventId: v.string(),
    requestHash: v.string(),
    kind: v.union(v.literal("install"), v.literal("remove")),
    outcome: v.union(
      v.literal("installed"),
      v.literal("removed"),
      v.literal("unchanged"),
      v.literal("rejected")
    ),
    reason: v.union(
      v.literal("valid_team"),
      v.literal("removed"),
      v.literal("already_absent"),
      v.literal("envelope_too_large"),
      v.literal("invalid_encoding"),
      v.literal("malformed_json"),
      v.literal("invalid_envelope"),
      v.literal("unsupported_format"),
      v.literal("unsupported_envelope_version"),
      v.literal("invalid_claims"),
      v.literal("unsupported_claims_version"),
      v.literal("unknown_key"),
      v.literal("invalid_public_key"),
      v.literal("bad_signature"),
      v.literal("wrong_project"),
      v.literal("inconsistent_state"),
      v.literal("stale_state")
    ),
    projectId: v.optional(v.string()),
    licenseId: v.optional(v.string()),
    memberCapacity: v.optional(v.number()),
    allowance: v.number(),
    // Phase 5C audit evidence is additive: historical events remain valid.
    actorAuthId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_createdAt", ["createdAt"]),

  cmsCapacity: defineTable({
    key: v.literal("cms"),
    activeCount: v.number(),
    reservedCount: v.number(),
    allowance: v.number(),
    overCap: v.boolean(),
    migrationState: v.union(
      v.literal("backfill_required"),
      v.literal("backfilling"),
      v.literal("ready"),
      v.literal("blocked")
    ),
    migrationVersion: v.number(),
    migrationIssueCount: v.number(),
    lastTransitionId: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  cmsMembershipMigrationIssues: defineTable({
    issueKey: v.string(),
    kind: v.union(
      v.literal("duplicate_capacity"),
      v.literal("duplicate_membership"),
      v.literal("duplicate_role"),
      v.literal("unknown_role"),
      v.literal("orphan_role"),
      v.literal("missing_admin"),
      v.literal("count_mismatch")
    ),
    authId: v.optional(v.string()),
    inviteId: v.optional(v.id("invites")),
    detail: v.string(),
    migrationVersion: v.number(),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_issueKey", ["issueKey"])
    .index("by_migrationVersion_and_resolvedAt", [
      "migrationVersion",
      "resolvedAt",
    ]),

  // U8 source-fixture rehearsal ledger. The migrations component owns the
  // durable cursor for each inventoried source table; this table owns the
  // bounded, exact-Admin-visible classifications that require deliberate
  // recovery. Source records remain authoritative and are never rewritten
  // into fabricated approvals, principals, candidates, or invitation proof.
  editorialMigrationIssues: defineTable({
    issueKey: v.string(),
    family: v.union(
      v.literal("authorization"),
      v.literal("membership"),
      v.literal("invitation"),
      v.literal("workflow"),
      v.literal("scheduling"),
      v.literal("history")
    ),
    kind: v.union(
      v.literal("authorization_setup_required"),
      v.literal("publishing_setup_required"),
      v.literal("unknown_role"),
      v.literal("role_membership_mismatch"),
      v.literal("unverifiable_invite"),
      v.literal("missing_parent"),
      v.literal("legacy_workflow_restart_required"),
      v.literal("legacy_schedule_held"),
      v.literal("legacy_expiry_held"),
      v.literal("broken_publication_pointer"),
      v.literal("invalid_principal_binding"),
      v.literal("incompatible_revision")
    ),
    sourceTable: v.union(
      v.literal("system"),
      v.literal("roles"),
      v.literal("cmsMemberships"),
      v.literal("invites"),
      v.literal("teamWorkflowStates"),
      v.literal("teamWorkflowEvents"),
      v.literal("pageStaging"),
      v.literal("pages"),
      v.literal("pageRevisions"),
      v.literal("pagePublicationStates"),
      v.literal("pagePublicationCandidates"),
      v.literal("pagePublicationReleases"),
      v.literal("pagePublicationExpiries"),
      v.literal("teamReviewRounds"),
      v.literal("teamReviewAssignments"),
      v.literal("teamReviewDecisions")
    ),
    sourceId: v.string(),
    pageId: v.optional(v.id("pages")),
    detail: v.string(),
    recovery: v.string(),
    migrationVersion: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_issueKey", ["issueKey"])
    .index("by_migrationVersion_and_resolvedAt", [
      "migrationVersion",
      "resolvedAt",
    ])
    .index("by_migrationVersion_and_source", [
      "migrationVersion",
      "sourceTable",
      "sourceId",
    ]),

  cmsEntitlementAudit: defineTable({
    transitionId: v.string(),
    kind: v.string(),
    actorAuthId: v.optional(v.string()),
    beforeActive: v.number(),
    beforeReserved: v.number(),
    afterActive: v.number(),
    afterReserved: v.number(),
    allowance: v.number(),
    withinAllowance: v.boolean(),
    wouldBlockIfEnforced: v.boolean(),
    reason: v.string(),
    createdAt: v.number(),
  })
    .index("by_transitionId", ["transitionId"])
    .index("by_createdAt", ["createdAt"]),

  // ==========================================
  // Roles — one row per user, keyed by Better Auth user id (`authId`).
  // Users live in the Better Auth component; we attach a role here rather than
  // via the admin plugin (broken with the Convex component — better-auth#7635).
  // Missing or dangling assignments grant no CMS authority. Only the
  // owner-claim mutation grants initial admin.
  // ==========================================
  roles: defineTable({
    authId: v.string(),
    // Widened from a built-in literal union to v.string() so custom role names
    // (ADR-0035) can be stored here. The name must resolve to either a built-in
    // slug (admin/editor/viewer) or a row in `rolePermissions`; enforcement
    // happens in `setRole` and `assignRoleInternal`, not in the validator.
    role: v.string(),
    assignedAt: v.number(),
    assignedBy: v.optional(v.string()),
  })
    .index("by_authId", ["authId"])
    // `by_role` lets custom-role delete/rename/list touch only the rows for a
    // specific role name. Without it, those handlers had to `.take(500)` and
    // JS-filter, silently missing assignments past position 500 (ADR-0035
    // follow-up).
    .index("by_role", ["role"]),

  // ==========================================
  // rolePermissions — saved Editor/Viewer policies plus Team custom roles.
  // Admin remains the sole code-defined wildcard. Reads project historical
  // rows through one installation-wide compatibility/active marker; only an
  // explicit successful permission save changes active authority.
  // ==========================================
  rolePermissions: defineTable({
    roleName: v.string(),
    // Optional while existing custom-role rows are classified by the U4a
    // authorization migration. Reserved rows back Editor/Viewer and must never
    // pass through the older custom-role lifecycle APIs.
    sourceKind: v.optional(v.union(v.literal("reserved"), v.literal("custom"))),
    permissions: v.array(v.string()),
    // U4a keeps migration inputs/history separate from the canonical active
    // policy. Optional fields let the marker-aware binary safely inspect rows
    // written by the preceding schema without tightening live validation.
    activePermissions: v.optional(v.array(v.string())),
    inactivePermissions: v.optional(v.array(v.string())),
    legacyPermissions: v.optional(v.array(v.string())),
    policyVersion: v.optional(v.number()),
    templateVersion: v.optional(v.number()),
    migrationVersion: v.optional(v.number()),
    stagedActivePermissions: v.optional(v.array(v.string())),
    stagedInactivePermissions: v.optional(v.array(v.string())),
    stagedPolicyVersion: v.optional(v.number()),
    stagedActivationId: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.string(),
    updatedAt: v.number(),
    updatedBy: v.string(),
    reviewedRegistryFingerprint: v.optional(v.string()),
  }).index("by_roleName", ["roleName"]),

  // One installation-wide switch selects either the bounded legacy adapter or
  // saved active policies. Staged rows never become authoritative one by one.
  authorizationPolicyState: defineTable({
    key: v.literal("authorization"),
    status: v.union(v.literal("staging"), v.literal("active")),
    activationId: v.string(),
    edition: v.union(v.literal("community"), v.literal("team")),
    policyFormatVersion: v.number(),
    migrationVersion: v.number(),
    templateVersion: v.number(),
    legacyInventoryVersion: v.number(),
    readerMapVersion: v.number(),
    registryFingerprint: v.string(),
    legacyInventoryFingerprint: v.string(),
    policyInventoryFingerprint: v.string(),
    createdAt: v.number(),
    createdBy: v.string(),
    updatedAt: v.number(),
    updatedBy: v.string(),
    activatedAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  // Append-only evidence for authorization-policy initialization, cutover and
  // exact-Admin edits. Historical/inactive grant strings stay on the policy
  // row; audit events record who changed active authority and when.
  authorizationPolicyAudit: defineTable({
    eventId: v.string(),
    action: v.union(
      v.literal("initialize"),
      v.literal("migration_prepare"),
      v.literal("migration_activate"),
      v.literal("policy_update"),
      v.literal("policy_reset")
    ),
    actorAuthId: v.string(),
    roleName: v.optional(v.string()),
    sourceKind: v.optional(v.union(v.literal("reserved"), v.literal("custom"))),
    activationId: v.optional(v.string()),
    previousPolicyVersion: v.optional(v.number()),
    policyVersion: v.optional(v.number()),
    beforePermissions: v.optional(v.array(v.string())),
    afterPermissions: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_roleName_and_createdAt", ["roleName", "createdAt"]),

  // ==========================================
  // Site language — F09 single public-language authority and transitions.
  // Owned by the required `language` module. Publication tables are changed
  // only through Publication's direct typed functions. Convex indexes do not
  // enforce uniqueness, so every point reader takes two rows and fails closed.
  // ==========================================
  siteLanguageAuthority: defineTable({
    key: v.literal("site-language-v1"),
    version: v.number(),
    currentLocale: v.string(),
    activeTransitionId: v.optional(v.id("siteLanguageTransitions")),
    lastCommittedTransitionId: v.optional(v.id("siteLanguageTransitions")),
    // M05 widening (shared authority dialect); absent on every F09-only row.
    mode: v.optional(v.union(v.literal("single"), v.literal("multilingual"))),
    enabledLocales: v.optional(v.array(v.string())),
    // M05 C3: the open default migration (multilingual rows only; a `current`
    // row carrying it is invalid), and the committed continuity generation,
    // which survives return to one language and module disable (M12, M24).
    activeDefaultMigrationId: v.optional(v.id("siteDefaultLanguageMigrations")),
    continuityPointer: v.optional(
      v.object({
        migrationId: v.id("siteDefaultLanguageMigrations"),
        generation: v.number(),
      })
    ),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // M05 freshness domains A and B (contract `siteLanguageFreshness`). One
  // lazily created row per scope; a missing row reads as 0/0. Counters advance
  // only under a multilingual authority, are monotonic and never reset.
  siteLanguageFreshness: defineTable({
    scope: v.union(v.literal("site"), v.literal("locale")),
    locale: v.optional(v.string()),
    routeClaimVersion: v.number(),
    publicationSetVersion: v.number(),
    updatedAt: v.number(),
  }).index("by_scope_and_locale", ["scope", "locale"]),

  // M05 sealed impact previews (contract `siteLanguageImpactPreviews`, M16).
  // One owner-bound, server-traversed removal or reveal preview; at most one
  // live (`scanning` or `complete`) row per owner, locale and kind.
  siteLanguageImpactPreviews: defineTable({
    kind: v.union(v.literal("remove"), v.literal("reveal")),
    locale: v.string(),
    owner: v.object({
      ownerId: v.id("cmsOwner"),
      tokenIdentifier: v.string(),
    }),
    captured: v.object({
      authorityVersion: v.number(),
      moduleConfigurationVersion: v.number(),
      site: v.object({
        routeClaimVersion: v.number(),
        publicationSetVersion: v.number(),
      }),
      locale: v.object({
        routeClaimVersion: v.number(),
        publicationSetVersion: v.number(),
      }),
      defaultLocale: v.optional(
        v.object({
          routeClaimVersion: v.number(),
          publicationSetVersion: v.number(),
        })
      ),
    }),
    phase: v.union(
      v.literal("scanning"),
      v.literal("complete"),
      v.literal("stale"),
      v.literal("consumed"),
      v.literal("expired")
    ),
    cursorPhase: v.union(
      v.literal("selections"),
      v.literal("historical_routes"),
      v.literal("manual_rules"),
      v.literal("menus"),
      v.literal("locale_prefix_shadowing")
    ),
    // Worker traversal only; never shown to the owner. Holds the section's
    // pagination cursor, a halved page size while one applies, and a menu's
    // node cursor (R8-H1).
    cursor: v.optional(v.string()),
    count: v.object({
      publicPages: v.number(),
      routes: v.number(),
      manualRules: v.number(),
      menus: v.number(),
    }),
    digest: v.string(),
    pageCount: v.number(),
    reviewedThroughOrdinal: v.number(),
    generation: v.number(),
    completedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner_and_locale_and_kind_and_phase", [
      "owner.tokenIdentifier",
      "locale",
      "kind",
      "phase",
    ])
    .index("by_phase_and_updatedAt", ["phase", "updatedAt"]),

  // M05 disclosure pages (contract `siteLanguageDisclosurePages`). One
  // digest-chained page of at most 50 items and 64 KiB per worker batch. The
  // page writer, not the validator, enforces exactly one subject.
  siteLanguageDisclosurePages: defineTable({
    previewId: v.optional(v.id("siteLanguageImpactPreviews")),
    migrationId: v.optional(v.id("siteDefaultLanguageMigrations")),
    generation: v.number(),
    ordinal: v.number(),
    section: disclosureSectionValidator,
    items: v.array(disclosureItemValidator),
    digest: v.string(),
    createdAt: v.number(),
  })
    .index("by_previewId_and_ordinal", ["previewId", "ordinal"])
    .index("by_migrationId_and_generation_and_ordinal", [
      "migrationId",
      "generation",
      "ordinal",
    ]),

  // M05 default-language migrations (contract `siteDefaultLanguageMigrations`).
  // At most one is open, named by the authority's `activeDefaultMigrationId`.
  siteDefaultLanguageMigrations: defineTable({
    fromLocale: v.string(),
    toLocale: v.string(),
    phase: v.union(
      v.literal("enumerating"),
      v.literal("validating"),
      v.literal("ready"),
      v.literal("committed"),
      v.literal("cancelled")
    ),
    generation: v.number(),
    cursorPhase: v.optional(
      v.union(
        v.literal("old_default_current"),
        v.literal("old_default_historical"),
        v.literal("carried"),
        v.literal("old_default_manual_rules"),
        v.literal("new_default_manual_rules"),
        v.literal("menus"),
        v.literal("validation")
      )
    ),
    // Pagination cursor, a halved page size while one applies, and a menu's
    // node cursor (R8-H1).
    cursor: v.optional(v.string()),
    captured: defaultMigrationCapturedValidator,
    counts: defaultMigrationCountsValidator,
    // The generation's disclosure chain head: the last page's digest, absent
    // before its first page (ledger C3b; contract Default migration step 2).
    digest: v.optional(v.string()),
    disclosurePageCount: v.number(),
    reviewedThroughOrdinal: v.number(),
    manifest: v.optional(
      v.object({
        generation: v.number(),
        readinessVersion: v.number(),
        captured: defaultMigrationCapturedValidator,
        counts: defaultMigrationCountsValidator,
        digest: v.string(),
        validatedAt: v.number(),
      })
    ),
    committedAt: v.optional(v.number()),
    committedAuthorityVersion: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    attribution: v.object({
      kind: v.literal("owner"),
      ownerId: v.id("cmsOwner"),
      authId: v.string(),
      tokenIdentifier: v.string(),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_phase", ["phase"]),

  // M05 continuity rows (contract `siteDefaultLanguageRoutes`), keyed
  // `(migrationId, generation, fromPath)` in the default URL space. Only the
  // pointed generation is ever served (M12); a duplicate key fails closed.
  siteDefaultLanguageRoutes: defineTable({
    migrationId: v.id("siteDefaultLanguageMigrations"),
    generation: v.number(),
    fromPath: v.string(),
    pageId: v.id("pages"),
    locale: v.string(),
    origin: v.union(
      v.literal("old_default_current"),
      v.literal("old_default_historical"),
      v.literal("carried")
    ),
    shadow: v.optional(
      v.union(v.literal("to_current"), v.literal("to_historical"))
    ),
    retiredAt: v.optional(v.number()),
    retiredReason: v.optional(
      v.union(v.literal("to_current"), v.literal("to_historical"))
    ),
    manualRule: v.optional(v.literal("shadowed")),
    capturedPath: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_migrationId_and_generation_and_fromPath", [
      "migrationId",
      "generation",
      "fromPath",
    ])
    .index("by_migrationId_and_generation", ["migrationId", "generation"]),

  // M05 F09 carry decisions (contract `siteLanguageCarryDecisions`). One per
  // pointed continuity row per F09 transition (R4-B1, R8-H2).
  siteLanguageCarryDecisions: defineTable({
    transitionId: v.id("siteLanguageTransitions"),
    routeId: v.id("siteDefaultLanguageRoutes"),
    fromPath: v.string(),
    outcome: v.union(
      v.literal("carry"),
      v.literal("drop_locale"),
      v.literal("drop_claimed"),
      v.literal("drop_duplicate"),
      v.literal("drop_disposition"),
      v.literal("drop_retired")
    ),
    capturedSourcePublicSetVersion: v.number(),
    capturedCarryInputVersion: v.number(),
    capturedCarryDecisionGeneration: v.number(),
    decidedAt: v.number(),
  })
    .index("by_transitionId_and_routeId", ["transitionId", "routeId"])
    .index("by_transitionId_and_fromPath", ["transitionId", "fromPath"]),

  // M05 durable lifecycle revalidation (M17). One row per committed language
  // or public-module lifecycle change, inserted in the committing mutation and
  // delivered by the `languageLifecycle` drain.
  siteLanguageLifecycleIntents: defineTable({
    operationId: v.string(),
    operationKind: v.union(
      v.literal("adopt"),
      v.literal("add"),
      v.literal("remove"),
      v.literal("reveal"),
      v.literal("default_migration"),
      // U2: the silent one-step default change (ADR-0053 amendment 2026-11-02).
      v.literal("default_change"),
      v.literal("return_to_single"),
      v.literal("module_toggle")
    ),
    locales: v.array(v.string()),
    migrationId: v.optional(v.id("siteDefaultLanguageMigrations")),
    generation: v.optional(v.number()),
    capturedAuthorityVersion: v.number(),
    origin: v.optional(v.string()),
    phase: v.union(
      v.literal("tags_and_layout"),
      v.literal("roots"),
      v.literal("manifest_paths"),
      v.literal("new_default_paths"),
      v.literal("sitemap_manifest"),
      v.literal("complete")
    ),
    cursor: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("failed"),
      v.literal("delivered"),
      v.literal("unconfigured"),
      // A2: delivery to a local origin failed. Quiet and never delivered.
      v.literal("local_unreachable")
    ),
    attempts: v.number(),
    lastErrorCode: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_operationId", ["operationId"])
    .index("by_status_and_updatedAt", ["status", "updatedAt"])
    // A2: the automatic re-arm finds quiet intents whose origin changed.
    .index("by_status_and_origin", ["status", "origin"])
    // A2: the delivery notice reads only the current language version.
    .index("by_capturedAuthorityVersion_and_status", [
      "capturedAuthorityVersion",
      "status",
    ]),

  siteLanguageTransitions: defineTable({
    mode: v.union(
      v.literal("correct_label"),
      v.literal("replace_content"),
      v.literal("rollback")
    ),
    sourceLocale: v.string(),
    targetLocale: v.string(),
    compensatesTransitionId: v.optional(v.id("siteLanguageTransitions")),
    // M05 A5 / F09 2026-11-01: set when this transition's activation swapped
    // the per-language site descriptions. A rollback swaps exactly when the
    // transition it compensates carries it (never inferred from that mode).
    descriptionSwapped: v.optional(v.literal(true)),
    phase: v.union(
      v.literal("enumerating"),
      v.literal("preparing"),
      v.literal("validating"),
      v.literal("ready"),
      v.literal("committed"),
      v.literal("cancelling"),
      v.literal("cancelled")
    ),
    generation: v.number(),
    startAuthorityVersion: v.number(),
    startSettingsUpdatedAt: v.number(),
    shortPath: v.boolean(),
    sourcePublicSetVersion: v.number(),
    preparedSetVersion: v.number(),
    cursorPhase: v.optional(
      v.union(
        v.literal("pages"),
        v.literal("target_artifacts"),
        v.literal("source_routes"),
        v.literal("carried_routes"),
        v.literal("carry_reconcile"),
        v.literal("carry_coverage"),
        v.literal("validation"),
        v.literal("coverage"),
        v.literal("cancel")
      )
    ),
    cursor: v.optional(v.string()),
    pageCount: v.number(),
    targetCount: v.number(),
    withdrawCount: v.number(),
    redirectCount: v.number(),
    unresolvedCount: v.number(),
    blockedCount: v.number(),
    previewConfirmedPreparedSetVersion: v.optional(v.number()),
    carryInputVersion: v.optional(v.number()),
    carryDecisionGeneration: v.optional(v.number()),
    carryDecisionDigest: v.optional(v.string()),
    previewConfirmedCarryDecisionDigest: v.optional(v.string()),
    manifest: v.optional(
      v.object({
        readinessVersion: v.number(),
        sourcePublicSetVersion: v.number(),
        preparedSetVersion: v.number(),
        authorityVersion: v.number(),
        settingsUpdatedAt: v.number(),
        pageCount: v.number(),
        routeCount: v.number(),
        digest: v.string(),
        validatedAt: v.number(),
      })
    ),
    targetDrafts: v.union(
      v.literal("retained"),
      v.literal("discarding"),
      v.literal("discarded")
    ),
    committedAt: v.optional(v.number()),
    committedAuthorityVersion: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    attribution: v.object({
      kind: v.literal("owner"),
      ownerId: v.id("cmsOwner"),
      authId: v.string(),
      tokenIdentifier: v.string(),
    }),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_phase", ["phase"])
    .index("by_sourceLocale_and_targetLocale", [
      "sourceLocale",
      "targetLocale",
    ]),

  siteLanguageTransitionPages: defineTable({
    transitionId: v.id("siteLanguageTransitions"),
    pageId: v.id("pages"),
    kind: v.union(
      v.literal("public_route"),
      v.literal("public_non_routable"),
      v.literal("hidden_selection"),
      v.literal("private_draft"),
      v.literal("retained_target")
    ),
    source: v.object({
      snapshotId: v.optional(v.id("pagePublishedSnapshots")),
      publicGeneration: v.number(),
      path: v.optional(v.string()),
      draftGeneration: v.number(),
    }),
    disposition: v.union(
      v.literal("undecided"),
      v.literal("target"),
      v.literal("withdraw"),
      v.literal("redirect")
    ),
    redirectToPageId: v.optional(v.id("pages")),
    target: v.object({
      snapshotId: v.optional(v.id("pagePublishedSnapshots")),
      publicGeneration: v.optional(v.number()),
      path: v.optional(v.string()),
      draftGeneration: v.optional(v.number()),
      draftCreatedByTransition: v.boolean(),
      confirmedDraftGeneration: v.optional(v.number()),
      confirmedSharedDraftGeneration: v.optional(v.number()),
      targetBasis: v.optional(
        v.union(v.literal("retained_snapshot"), v.literal("draft"))
      ),
      selectionProvenance: v.optional(
        v.union(
          v.literal("retained_preexisting"),
          v.literal("transition_prepared")
        )
      ),
      // Immutable adopted-selection binding, written only when the owner adopts
      // a pre-existing retained snapshot. Unlike `retainedReview` it survives a
      // target Working Draft save or discard, so cancellation can still prove
      // the selection it preserves is the one that was adopted.
      retainedSelection: v.optional(
        v.object({
          snapshotId: v.id("pagePublishedSnapshots"),
          publicGeneration: v.number(),
        })
      ),
      retainedDraftAttribution: v.optional(
        v.object({
          ownerId: v.id("cmsOwner"),
          tokenIdentifier: v.string(),
          locale: v.string(),
          draftId: v.id("pageLocaleDrafts"),
          draftGeneration: v.number(),
          draftBaseSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
        })
      ),
      retainedReview: v.optional(
        v.object({
          digest: v.string(),
          ownerId: v.id("cmsOwner"),
          tokenIdentifier: v.string(),
          reviewedAt: v.number(),
          reviewedTransitionGeneration: v.number(),
          reviewedPageGeneration: v.number(),
          acceptedPageGeneration: v.number(),
          basis: v.union(v.literal("retained_snapshot"), v.literal("draft")),
          binding: v.object({
            authorityVersion: v.number(),
            settingsUpdatedAt: v.number(),
            moduleConfigurationVersion: v.number(),
            lifecycleGeneration: v.number(),
            targetStateId: v.optional(v.id("pageLocalePublicationStates")),
            targetPublicGeneration: v.number(),
            targetDraftGeneration: v.number(),
            targetReleaseGeneration: v.number(),
            targetUpdatedAt: v.optional(v.number()),
            selectionSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
            selectionPublishedAt: v.optional(v.number()),
            selectionPath: v.optional(v.string()),
            draftBaseSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
            workingDraftId: v.optional(v.id("pageLocaleDrafts")),
            workingDraftGeneration: v.optional(v.number()),
            sharedDraftId: v.optional(v.id("pageSharedDrafts")),
            sharedDraftGeneration: v.optional(v.number()),
            sourceStateId: v.optional(v.id("pageLocalePublicationStates")),
            sourceSnapshotId: v.optional(v.id("pagePublishedSnapshots")),
            sourcePublicGeneration: v.number(),
            sourceDraftGeneration: v.number(),
            sourceReleaseGeneration: v.number(),
            sourceUpdatedAt: v.optional(v.number()),
          }),
        })
      ),
    }),
    status: v.union(
      v.literal("unready"),
      v.literal("stale"),
      v.literal("ready"),
      v.literal("blocked")
    ),
    blockerCode: v.optional(v.string()),
    generation: v.number(),
    updatedAt: v.number(),
  })
    .index("by_transitionId_and_pageId", ["transitionId", "pageId"])
    .index("by_transitionId_and_status", ["transitionId", "status"])
    .index("by_pageId", ["pageId"]),

  siteLanguageTransitionRoutes: defineTable({
    transitionId: v.id("siteLanguageTransitions"),
    fromPath: v.string(),
    pageId: v.id("pages"),
    origin: v.union(
      v.literal("source_current"),
      v.literal("source_historical"),
      v.literal("carried"),
      v.literal("redirect_disposition")
    ),
    createdAt: v.number(),
  })
    .index("by_transitionId_and_fromPath", ["transitionId", "fromPath"])
    .index("by_transitionId_and_pageId", ["transitionId", "pageId"]),

  // ==========================================
  // User preferences — per-user UI settings, keyed by Better Auth user id.
  // Distinct from `roles` (authorization) so toggles don't churn an auth-critical
  // row. `adminLocale` drives the admin UI language; null/missing → falls back
  // to siteSettings.defaultLocale.
  // ==========================================
  userPreferences: defineTable({
    authId: v.string(),
    adminLocale: v.optional(v.string()),
  }).index("by_authId", ["authId"]),
})
