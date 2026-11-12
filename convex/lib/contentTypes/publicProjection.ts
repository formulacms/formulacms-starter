import type { Doc, Id } from "../../_generated/dataModel"
import type { CMSLinkField, ImageField, Slice } from "../slices"
import type { Primitive } from "../slices/primitives"
import { contentTypeDefs, type ContentType } from "."
import { publicFieldsOf } from "./exposure"

/**
 * The only page shape that may leave an anonymous page-read function.
 *
 * This is intentionally independent of `Doc<"pages">`: adding a storage or
 * admin field cannot make it public by accident. The projector below copies
 * only the system allowlist and descriptor fields explicitly marked
 * `.public()`.
 */
export type PublicSeo = {
  metaTitle?: string
  metaDescription?: string
  ogImage?: string
  ogTitle?: string
  ogDescription?: string
  twitterCard?: "summary" | "summary_large_image"
  noIndex?: boolean
  noFollow?: boolean
  structuredData?: string
}

type PublicPageBase<LocalizedContent> = {
  _id: Id<"pages">
  pageType: ContentType
  updatedAt: number
  publishedAt?: number
  seo?: PublicSeo
  /** Exactly one requested locale is present at runtime. */
  content: Record<string, LocalizedContent>
}

export type PublicSliceBodyContent = {
  title: string
  metaTitle?: string
  metaDescription?: string
  slices: Slice[]
}

export type PublicAuthorContent = PublicSliceBodyContent & {
  roleTitle?: string
}

export type PublicJobContent = {
  title: string
  summary?: string
  slices: Slice[]
}

export type PublicTestimonialContent = {
  quote: string
}

export type PublicLandingPage = PublicPageBase<PublicSliceBodyContent> & {
  pageType: "landing-page"
}

export type PublicGenericPage = PublicPageBase<PublicSliceBodyContent> & {
  pageType: "page"
}

export type PublicPostPage = PublicPageBase<PublicSliceBodyContent> & {
  pageType: "post"
  authorIds?: Array<{ pageId?: Id<"pages">; itemId?: string }>
  category?: string
  featured: boolean
  promoteToFront: boolean
}

export type PublicAuthorPage = PublicPageBase<PublicAuthorContent> & {
  pageType: "author"
  name: string
  socials?: Array<{ platform: string; url: string }>
}

export type PublicTestimonialPage = PublicPageBase<PublicTestimonialContent> & {
  pageType: "testimonial"
  personName: string
  personRole?: string
  personCompany?: string
  personImage?: ImageField
  sourceUrl?: string
}

export type PublicJobPage = PublicPageBase<PublicJobContent> & {
  pageType: "job"
  department?: string
  location?: string
  remoteType: "remote" | "hybrid" | "onsite"
  employmentType:
    "full-time" | "part-time" | "contract" | "internship" | "temporary"
  salaryCurrency: "USD" | "EUR" | "GBP" | "CAD" | "AUD"
  salaryMin: number
  salaryMax: number
  applyUrl?: CMSLinkField
  applyEmail?: string
  closingDate?: string
  jobStatus: "open" | "closed" | "filled"
}

export type PublicPage =
  | PublicLandingPage
  | PublicGenericPage
  | PublicPostPage
  | PublicAuthorPage
  | PublicTestimonialPage
  | PublicJobPage

/** Public, locale-strict depth-one relation projection for slice renderers. */
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
  status: "published"
  cardImageMediaId?: Id<"media">
  content: Record<string, Record<string, unknown>>
} & Record<string, unknown>

const PUBLIC_SEO_KEYS = [
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
  locale: string
): {
  descriptor: (typeof contentTypeDefs)[ContentType]
  document: PublicDescriptorDocument
} | null {
  if (page.deletedAt !== undefined || page.status !== "published") return null
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
    descriptor.capabilities.sliceBody &&
    localizedValues.slices !== undefined
  ) {
    publicLocalized.slices = localizedValues.slices
  }

  return {
    descriptor,
    document: {
      _id: page._id,
      pageType,
      slug: page.slug,
      status: "published",
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
