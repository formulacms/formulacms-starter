import type { Doc, Id } from "../../_generated/dataModel"
import type { Primitive } from "../blocks/primitives"
import { contentTypeDefs, type ContentType } from "."
import { publicFieldsOf } from "./exposure"
import type { PublicPage, PublicSeo } from "./publicValidator"

export type {
  PublicAuthorPage,
  PublicGenericPage,
  PublicJobPage,
  PublicLandingPage,
  PublicPage,
  PublicPageOf,
  PublicPostPage,
  PublicSeo,
  PublicTestimonialPage,
} from "./publicValidator"

/*
 * The public page types and the response validator are derived from the
 * descriptors in `publicValidator.ts`. The projector below copies only the
 * system allowlist and descriptor fields explicitly marked `.public()`, so
 * adding a storage or admin field cannot make it public by accident.
 */

/** Public, locale-strict depth-one relation projection for block renderers. */
export type PublicRelationCard = {
  pageId: Id<"pages">
  pageType: ContentType
  title: string
  excerpt?: string
  image?: { url: string }
  href?: string
}

type PublicDescriptorCard = Omit<PublicRelationCard, "image" | "href"> & {
  imageMediaId?: Id<"media">
}

type PublicDescriptorDocument = {
  _id: Id<"pages">
  pageType: ContentType
  slug: string
  status: Doc<"pages">["status"]
  cardImageMediaId?: Id<"media">
  content: Record<string, Record<string, unknown>>
} & Record<string, unknown>

/** The one list of SEO keys that cross the public seam (also feeds the validator). */
export const PUBLIC_SEO_KEYS = [
  "metaTitle",
  "metaDescription",
  "ogImage",
  "ogTitle",
  "ogDescription",
  "twitterCard",
  "noIndex",
  "noFollow",
  "structuredData",
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function copyPublicDescriptorFields(
  fields: Record<string, Primitive>,
  values: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(publicFieldsOf(fields))) {
    const value = values[key]
    if (value !== undefined) output[key] = value
  }
  return output
}

function projectPublicSeo(value: unknown): PublicSeo | undefined {
  if (!isRecord(value)) return undefined
  const seo: Record<string, unknown> = {}
  for (const key of PUBLIC_SEO_KEYS) {
    const field = value[key]
    if (field !== undefined) seo[key] = field
  }
  return Object.keys(seo).length > 0 ? (seo as PublicSeo) : undefined
}

/**
 * Make the deliberately small public input passed to a descriptor's
 * `referenceCard` implementation. It retains route/media internals only long
 * enough to derive the public card; callers never return this object.
 */
function projectPublicDescriptorDocument(
  page: Doc<"pages">,
  locale: string,
  opts: { requirePublished: boolean } = { requirePublished: true }
): {
  descriptor: (typeof contentTypeDefs)[ContentType]
  document: PublicDescriptorDocument
} | null {
  if (page.deletedAt !== undefined) return null
  if (opts.requirePublished && page.status !== "published") return null
  const pageType = page.pageType as ContentType
  const descriptor = contentTypeDefs[pageType]
  if (!descriptor) return null

  const contentByLocale = page.content as
    Record<string, Record<string, unknown> | undefined> | undefined
  const localizedValues = contentByLocale?.[locale]
  if (!localizedValues) return null

  const pageValues = page as unknown as Record<string, unknown>
  const publicLocalized = copyPublicDescriptorFields(
    descriptor.localizedFields,
    localizedValues
  )
  if (
    descriptor.capabilities.blockBody &&
    localizedValues.blocks !== undefined
  ) {
    publicLocalized.blocks = localizedValues.blocks
  }

  return {
    descriptor,
    document: {
      _id: page._id,
      pageType,
      slug: page.slug,
      status: page.status,
      ...(page.cardImageMediaId
        ? { cardImageMediaId: page.cardImageMediaId }
        : {}),
      ...copyPublicDescriptorFields(descriptor.sharedFields, pageValues),
      content: { [locale]: publicLocalized },
    },
  }
}

/**
 * Strict, requested-locale page projection. A missing locale is not replaced
 * with a default or arbitrary locale: public callers receive `null` instead.
 */
export function projectPublicPage(
  page: Doc<"pages">,
  locale: string
): PublicPage | null {
  const projected = projectPublicDescriptorDocument(page, locale)
  if (!projected) return null

  const { descriptor, document } = projected
  const pageValues = page as unknown as Record<string, unknown>
  const seo = projectPublicSeo(page.seo)
  return {
    _id: page._id,
    pageType: document.pageType,
    updatedAt: page.updatedAt,
    ...(page.publishedAt !== undefined
      ? { publishedAt: page.publishedAt }
      : {}),
    ...(seo ? { seo } : {}),
    ...copyPublicDescriptorFields(descriptor.sharedFields, pageValues),
    content: document.content,
  } as PublicPage
}

/**
 * Descriptor-specific public card input/output. The descriptor receives only
 * public field values for the requested locale, so a fallback in an individual
 * descriptor cannot expose an admin-only field.
 */
export function projectPublicReferenceCard(
  page: Doc<"pages">,
  locale: string
): PublicDescriptorCard | null {
  const projected = projectPublicDescriptorDocument(page, locale)
  if (!projected) return null
  const card = projected.descriptor.referenceCard(
    projected.document as unknown as Doc<"pages">,
    locale
  )
  if (!card || !card.title) return null

  return {
    pageId: page._id,
    pageType: projected.document.pageType,
    title: card.title,
    ...(card.subtitle ? { excerpt: card.subtitle } : {}),
    ...(card.imageMediaId ? { imageMediaId: card.imageMediaId } : {}),
  }
}

/**
 * The public-safe display title of a page in one language, for the search
 * index. The page's own title may be admin-only (a testimonial's internal
 * label); the descriptor's `referenceCard` then names the page, and it
 * receives public fields only, so an admin-only value cannot leak. Unlike
 * {@link projectPublicReferenceCard}, this does not require the page to be
 * published: search rows exist for drafts too, and public search filters by
 * status later.
 */
export function publicDisplayTitle(page: Doc<"pages">, locale: string): string {
  const projected = projectPublicDescriptorDocument(page, locale, {
    requirePublished: false,
  })
  if (!projected) return ""
  const card = projected.descriptor.referenceCard(
    projected.document as unknown as Doc<"pages">,
    locale
  )
  return card?.title ?? ""
}
