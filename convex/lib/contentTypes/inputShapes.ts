import { v } from "convex/values"
import { sliceValidator } from "../slices"
// @content-type-codegen:content-draft-imports:start
import { landingPageContentType } from "./landingPage"
import { pageContentType } from "./page"
import { postContentType } from "./post"
import { authorContentType } from "./author"
import { testimonialContentType } from "./testimonial"
import { jobContentType } from "./job"
// @content-type-codegen:content-draft-imports:end
import { REGISTERED_CONTENT_TYPES, type ContentType } from "./index"

/**
 * Typed per-descriptor content-save input (plan 029 C8 Phase 2).
 *
 * The prior hand-rolled `{title, metaTitle, metaDescription, slices}` bag
 * could not express arbitrary descriptor localized fields (author
 * `roleTitle`/`bio`, future faq/testimonial content). This module replaces
 * that bag with a discriminated union — one arm per registered
 * content-type descriptor, each arm carrying the descriptor's own typed
 * `localizedValidator` shape plus a `slices` field on arms whose
 * descriptor sets `sliceBody: true`. `pages.updateDraft` is the sole
 * public consumer (ADR-0041 Deploy 3 Narrow).
 *
 * **Scope note (advisor-driven).** Only the LOCALIZED bag flows through this
 * union. `sharedFields` (post `authorId`/`tags`/`category`, author
 * `name`/`socials`) continue to save via the existing `updatePage` mutation
 * — that mutation already does per-field change detection so a partially-
 * populated shared bag can't silently clear the fields the C8 generic panel
 * happens not to render (`tags`, etc.). This keeps C8 additive: the write
 * boundary the plan calls out shifts only for localized descriptor fields.
 *
 * **Fallback rule is mandatory** (plan 029 rev 2): the union arms are
 * enumerated explicitly here rather than generated from the registry so
 * Convex + TypeScript stay precise. Adding a descriptor without touching
 * this module trips the compile-time drift guard below.
 */

// @content-type-codegen:content-draft-arms:start
const landingPageDraftInput = v.object({
  pageType: v.literal("landing-page"),
  localized: landingPageContentType.localizedValidator,
  slices: v.array(sliceValidator),
})

const pageDraftInput = v.object({
  pageType: v.literal("page"),
  localized: pageContentType.localizedValidator,
  slices: v.array(sliceValidator),
})

const postDraftInput = v.object({
  pageType: v.literal("post"),
  localized: postContentType.localizedValidator,
  slices: v.array(sliceValidator),
})

const authorDraftInput = v.object({
  pageType: v.literal("author"),
  localized: authorContentType.localizedValidator,
  slices: v.array(sliceValidator),
})

const testimonialDraftInput = v.object({
  pageType: v.literal("testimonial"),
  localized: testimonialContentType.localizedValidator,
})

const jobDraftInput = v.object({
  pageType: v.literal("job"),
  localized: jobContentType.localizedValidator,
  slices: v.array(sliceValidator),
})
// @content-type-codegen:content-draft-arms:end

/**
 * The typed content-save input consumed by `pages.updateDraft`. Convex
 * + TypeScript both narrow on `pageType`: a `post`-arm consumer sees
 * `localized: {title, metaTitle, metaDescription}` + `slices`; the
 * `testimonial` pure-form arm carries only `title` + `quote`.
 */
// @content-type-codegen:content-draft-validator:start
export const contentDraftInputValidator = v.union(
  landingPageDraftInput,
  pageDraftInput,
  postDraftInput,
  authorDraftInput,
  testimonialDraftInput,
  jobDraftInput
)
// @content-type-codegen:content-draft-validator:end

/**
 * Compile-time drift guard mirroring `_registryValidatorGuard` at
 * `convex/lib/contentTypes/index.ts:54`.
 *
 * A registered descriptor added without a matching draft-input arm trips
 * tsc here; a spurious arm here without a registered descriptor trips the
 * `extends ContentType` guard on the other side. Same pattern C1 used to
 * keep the schema union + `PAGE_TYPES` + `contentTypeValidator` locked
 * together.
 */
// @content-type-codegen:content-draft-guard:start
type _EnumeratedDraftArms = "landing-page" | "page" | "post" | "author" | "testimonial" | "job"

type _DraftArmsMatchRegistry = _EnumeratedDraftArms extends ContentType
  ? ContentType extends _EnumeratedDraftArms
    ? true
    : never
  : never

const _draftArmsGuard: _DraftArmsMatchRegistry = true
void _draftArmsGuard
// @content-type-codegen:content-draft-guard:end
void REGISTERED_CONTENT_TYPES
