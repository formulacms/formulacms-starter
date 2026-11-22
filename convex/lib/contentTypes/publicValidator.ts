import {
  v,
  type GenericValidator,
  type Infer,
  type ObjectType,
  type Validator,
} from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import { blockValidator, type Block } from "../blocks"
import type { DescriptorFieldMap, ContentTypeDescriptor } from "./types"
import { contentTypeDefs, type ContentType } from "."
import { publicFieldsOf } from "./exposure"
import { PUBLIC_SEO_KEYS } from "./publicProjection"
import { seoValidator } from "../pages/storageFields"

/**
 * Response validator and types of the anonymous page reader
 * (`getPublicPageById`), derived from the content-type descriptors.
 *
 * Prior art: Convex builds validators from plain objects and reuses them
 * across schema and function `returns`
 * (https://docs.convex.dev/functions/validation); `schemaShapes.ts` already
 * derives the storage arms from the descriptors the same way. The projector
 * (`publicProjection.ts`) copies the fields that `publicFieldsOf` returns, so
 * the validator reads that same source. A new content type needs no edit here.
 *
 * `.public()` on the descriptor field is therefore the only exposure gate: a
 * field without it never reaches the validator or the projector.
 * `convex/lib/contentTypes/exposure.test.ts` pins the shipped types' public
 * keys by name, so a shipped public field that loses `.public()` fails that
 * test.
 *
 * This is a leaf module: it never imports `convex/schema.ts`. The page
 * response stays separate from the `pages` storage validator, so a storage
 * field cannot become public by being added to a storage arm.
 */

// ─── Public SEO ───────────────────────────────────────────────────────────

/** The SEO keys that may cross the public seam, picked from the stored shape. */
export const publicSeoValidator = seoValidator.pick(...PUBLIC_SEO_KEYS)

export type PublicSeo = Infer<typeof publicSeoValidator>

// ─── Types ────────────────────────────────────────────────────────────────

type Defs = typeof contentTypeDefs

/** The `.public()` entries of a descriptor field map, as validators. */
type PublicValidators<F extends DescriptorFieldMap> = {
  [K in keyof F as F[K]["config"] extends { public: true }
    ? K
    : never]: F[K]["validator"] extends Validator<
    infer Type,
    infer IsOptional,
    infer Paths
  >
    ? Validator<Type, IsOptional, Paths>
    : never
}

/** Whether the stored arm of a type has a block body (`content[locale].blocks`). */
type HasBlockBody<T extends ContentType> =
  Extract<Doc<"pages">, { pageType: T }> extends { content?: infer Content }
    ? "blocks" extends keyof NonNullable<Content>[keyof NonNullable<Content>]
      ? true
      : false
    : false

/** The public page of one content type. */
export type PublicPageOf<T extends ContentType> = {
  _id: Id<"pages">
  pageType: T
  updatedAt: number
  publishedAt?: number
  seo?: PublicSeo
  /** Exactly one requested locale is present at runtime. */
  content: Record<
    string,
    ObjectType<PublicValidators<Defs[T]["localizedFields"]>> &
      (HasBlockBody<T> extends true ? { blocks: Block[] } : unknown)
  >
} & ObjectType<PublicValidators<Defs[T]["sharedFields"]>>

export type PublicLandingPage = PublicPageOf<"landing-page">
export type PublicGenericPage = PublicPageOf<"page">
export type PublicPostPage = PublicPageOf<"post">
export type PublicAuthorPage = PublicPageOf<"author">
export type PublicTestimonialPage = PublicPageOf<"testimonial">
export type PublicJobPage = PublicPageOf<"job">

/** The only page shape that may leave an anonymous page-read function. */
export type PublicPage = { [T in ContentType]: PublicPageOf<T> }[ContentType]

// ─── Validators ───────────────────────────────────────────────────────────

const publicPageSystemFields = {
  _id: v.id("pages"),
  updatedAt: v.number(),
  publishedAt: v.optional(v.number()),
  seo: v.optional(publicSeoValidator),
} as const

function publicValidatorsOf(
  fields: DescriptorFieldMap
): Record<string, GenericValidator> {
  const out: Record<string, GenericValidator> = {}
  for (const [key, def] of Object.entries(publicFieldsOf(fields))) {
    out[key] = def.validator
  }
  return out
}

/**
 * One strict arm per content type: the system allowlist, `pageType`, the
 * descriptor's `.public()` shared fields and, per locale, its `.public()`
 * localized fields plus `blocks` when the type has a block body.
 */
export function buildPublicPageArm(
  type: string,
  descriptor: Pick<
    ContentTypeDescriptor,
    "sharedFields" | "localizedFields" | "capabilities"
  >
) {
  return v.object({
    ...publicPageSystemFields,
    ...publicValidatorsOf(descriptor.sharedFields),
    pageType: v.literal(type),
    content: v.record(
      v.string(),
      v.object({
        ...publicValidatorsOf(descriptor.localizedFields),
        ...(descriptor.capabilities.blockBody
          ? { blocks: v.array(blockValidator) }
          : {}),
      })
    ),
  })
}

/**
 * Build the response validator for a registry. Exported for tests that need a
 * different registry; the application uses {@link publicPageValidator}.
 */
export function buildPublicPageValidator(
  defs: Record<
    string,
    Pick<
      ContentTypeDescriptor,
      "sharedFields" | "localizedFields" | "capabilities"
    >
  >
) {
  return v.union(
    ...Object.entries(defs).map(([type, descriptor]) =>
      buildPublicPageArm(type, descriptor)
    )
  )
}

/**
 * The response schema for `getPublicPageById`. The arms are built at runtime,
 * so Convex cannot infer the response type from them; the one cast below
 * gives the validator the precise type derived from the descriptors above.
 */
export const publicPageValidator = buildPublicPageValidator(
  contentTypeDefs
) as unknown as Validator<PublicPage, "required", string>
