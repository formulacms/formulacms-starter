/**
 * Content-type descriptor registry.
 *
 * Plan 028 chunk C1: the three page-type flavors that lived as `pageType`
 * literals on the `pages` table are re-declared as descriptors. Every downstream
 * surface (schema union, permission generator, admin filters, sidebar, palette,
 * relation picker) reads from this registry — mirroring the slice registry
 * pattern (`convex/lib/slices/`). The C5 batch (`author`, `faq-item`,
 * `testimonial`) extends the registry with real per-type field payloads.
 */

import { v } from "convex/values"
import type { ContentTypeDescriptor } from "./types"
// @content-type-codegen:content-type-imports:start
import { landingPageContentType } from "./landingPage"
import { pageContentType } from "./page"
import { postContentType } from "./post"
import { authorContentType } from "./author"
import { testimonialContentType } from "./testimonial"
import { jobContentType } from "./job"
// @content-type-codegen:content-type-imports:end
import { STARTER_CONTENT_TYPES } from "./starterSelection"

/**
 * Registry of content-type descriptors, keyed by slug. Insertion order is
 * preserved and is what {@link CONTENT_TYPES} enumerates.
 */
// @content-type-codegen:content-type-definitions:start
export const contentTypeDefs = {
  "landing-page": landingPageContentType,
  page: pageContentType,
  post: postContentType,
  author: authorContentType,
  testimonial: testimonialContentType,
  job: jobContentType,
} as const satisfies Record<string, ContentTypeDescriptor>
// @content-type-codegen:content-type-definitions:end

/**
 * Content-type slug. Derived from `contentTypeDefs` so adding a descriptor
 * adds the type with no second list to keep in sync (mirrors
 * `SLICE_TYPES` / `SliceType`).
 */
export type ContentType = keyof typeof contentTypeDefs

/** Canonical enumeration of every registered storage-compatible type. */
export const REGISTERED_CONTENT_TYPES = Object.keys(
  contentTypeDefs
) as ContentType[]

/**
 * Curated app catalog. The engine file selects every registered type; the
 * generated starter rewrites `starterSelection.ts` to its release selection.
 */
export const CONTENT_TYPES = [...STARTER_CONTENT_TYPES] as ContentType[]

const activeContentTypeSet = new Set<ContentType>()
for (const type of CONTENT_TYPES) {
  if (!(type in contentTypeDefs)) {
    throw new Error(`Starter content-type selection is not registered: ${type}`)
  }
  if (activeContentTypeSet.has(type)) {
    throw new Error(`Starter content-type selection contains a duplicate: ${type}`)
  }
  activeContentTypeSet.add(type)
}

/**
 * Whether a registered storage arm is exposed by this starter's current
 * release selection. Registered-but-inactive arms remain schema-compatible
 * for migration work; ordinary runtime surfaces must use this guard.
 */
export function isActiveContentType(value: string): boolean {
  return activeContentTypeSet.has(value as ContentType)
}

/**
 * Discriminator validator for `pages.pageType`, enumerated explicitly so
 * Convex sees a static tuple of literals (the runtime-built shape is inferred
 * imprecisely). The compile-time guard below fires when the enumeration and
 * the registry drift — same trick the slice registry uses to keep
 * `sliceValidator` and `sliceDefs` in sync.
 */
// @content-type-codegen:content-type-validator:start
export const contentTypeValidator = v.union(
  v.literal("landing-page"),
  v.literal("page"),
  v.literal("post"),
  v.literal("author"),
  v.literal("testimonial"),
  v.literal("job")
)
// @content-type-codegen:content-type-validator:end

// @content-type-codegen:content-type-guard:start
type _RegisteredContentType = "landing-page" | "page" | "post" | "author" | "testimonial" | "job"
type _RegistryMatchesValidator = keyof typeof contentTypeDefs extends
  _RegisteredContentType
  ? _RegisteredContentType extends keyof typeof contentTypeDefs
    ? true
    : never
  : never
const _registryValidatorGuard: _RegistryMatchesValidator = true
void _registryValidatorGuard
// @content-type-codegen:content-type-guard:end

// Cross-prefix uniqueness (plan 028 C3): a non-empty `pathPrefix` must map to
// at most one descriptor so the wildcard router can dispatch by URL segment.
// Multiple descriptors sharing the empty prefix is fine — the URL doesn't
// identify the type there, the doc's `pageType` does. This check runs at
// module load: a duplicate throws before any query can misroute.
{
  const seen = new Set<string>()
  for (const d of Object.values(contentTypeDefs) as ContentTypeDescriptor[]) {
    if (!d.routing) continue
    if (d.routing.pathPrefix.length === 0) continue
    if (seen.has(d.routing.pathPrefix)) {
      throw new Error(
        `Duplicate content-type pathPrefix "${d.routing.pathPrefix}" — non-empty prefixes must be unique.`
      )
    }
    seen.add(d.routing.pathPrefix)
  }
}

/** Look up a descriptor by slug; typed to return the specific descriptor entry. */
export function getContentType<T extends ContentType>(
  type: T
): (typeof contentTypeDefs)[T] {
  return contentTypeDefs[type]
}

export type {
  ContentTypeDescriptor,
  ContentTypeCapabilities,
  ReferenceCard,
  DescriptorField,
  DescriptorFieldMap,
} from "./types"
