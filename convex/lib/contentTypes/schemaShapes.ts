import { v, type GenericValidator } from "convex/values"
import { sliceValidator } from "../slices"
import { contentTypeDefs, REGISTERED_CONTENT_TYPES } from "./index"
import type { ContentTypeDescriptor, DescriptorFieldMap } from "./types"

/**
 * Schema derivation seam (plan 028 C7).
 *
 * The pages-table union arm for a given content type is composed inline in
 * `convex/schema.ts` from system row fields + the descriptor's own
 * `sharedValidator` fields + a `pageType` literal + a per-arm `content[locale]`
 * record derived from this helper.
 *
 * Keeping the derivation on the descriptor's `localizedValidator` is what
 * turns the C5 "pragmatic bridge" (junk drawer on shared) into structural
 * narrowing: an `author` row cannot carry `authorId`, a `post` row cannot
 * carry `roleTitle`, and neither can arrive as an unexpected key at the
 * storage boundary. ADR-003 (no `v.any()`) still holds — every field flows
 * back to a typed primitive.
 */

/**
 * `content[locale]` shape for a slice-bodied arm. Descriptor's
 * `localizedValidator.fields` + a required `slices` array.
 *
 * The single-branch return keeps the derived type statically knowable so
 * downstream readers can narrow on `page.pageType === "post"` (etc.) and
 * still see `content[locale].slices`. All four current content types opt
 * into `sliceBody`; a future non-slice descriptor (faq-item, testimonial —
 * plan 028 §C5 batch) will use `armLocalizedContentValidatorNoSlices`
 * instead, both to strip `slices` from its arm and to keep this branch's
 * type inference tight.
 */
export function armLocalizedContentValidator<
  Shared extends DescriptorFieldMap,
  Localized extends DescriptorFieldMap,
>(descriptor: ContentTypeDescriptor<Shared, Localized>) {
  return v.object({
    ...descriptor.localizedValidator.fields,
    slices: v.array(sliceValidator),
  })
}

/**
 * `content[locale]` shape for a **pure-form** arm — descriptor's
 * `localizedValidator.fields` only, no `slices` field.
 *
 * Dark-shipped for plan 029 C10 (first `sliceBody:false` descriptor,
 * `testimonial`). Not consumed by any current schema arm; the union of
 * `pagesTableValidator` still uses `armLocalizedContentValidator` for
 * every registered descriptor because all four have `sliceBody:true`.
 * C10 activates this branch alongside the exposure-contract ADR.
 *
 * Kept side-by-side with `armLocalizedContentValidator` — one seam, two
 * branches, so the pure-form path is a single flag flip on the
 * descriptor when it lands rather than a schema-generator rewrite.
 */
export function armLocalizedContentValidatorNoSlices<
  Shared extends DescriptorFieldMap,
  Localized extends DescriptorFieldMap,
>(descriptor: ContentTypeDescriptor<Shared, Localized>) {
  return v.object({
    ...descriptor.localizedValidator.fields,
  })
}

/**
 * Descriptor-derived permissive superset for a revision snapshot's per-locale
 * bag (plan 029 C9b). Every descriptor's `localizedFields` contributes its
 * keys; each value is `v.optional(v.any())` because archived JSON is opaque
 * per ADR-0029 — it may carry values from a prior descriptor shape, a null
 * clear sentinel, or an unknown drifted key that the reader keeps for
 * inspection. Precise per-arm typing is enforced by `pages.content` at
 * write time, not here.
 *
 * A revision snapshot is heterogeneous by design — a post revision carries
 * post fields, an author revision carries author fields — so this shape
 * admits either without pinning to a specific arm.
 */
export function buildRevisionLocalizedContentValidator() {
  const shape: Record<string, GenericValidator> = {
    slices: v.optional(v.array(v.any())),
  }
  for (const type of REGISTERED_CONTENT_TYPES) {
    const descriptor = contentTypeDefs[type]
    for (const key of Object.keys(descriptor.localizedValidator.fields)) {
      if (key in shape) continue
      shape[key] = v.optional(v.any())
    }
  }
  return v.object(shape as Record<string, GenericValidator>)
}

/**
 * Descriptor-derived permissive superset for a revision snapshot's row-level
 * shared-field bag (plan 029 C9b). Same rationale as
 * {@link buildRevisionLocalizedContentValidator}: unions every registered
 * descriptor's shared-field keys, each `v.optional(v.any())`. The writer
 * archives cleared values as an explicit `null` sentinel (distinct from
 * "not archived" = key absent) so restore can honor null-as-clear; both
 * flow through this permissive shape.
 */
export function buildRevisionSharedFieldsValidator() {
  const shape: Record<string, GenericValidator> = {}
  for (const type of REGISTERED_CONTENT_TYPES) {
    const descriptor = contentTypeDefs[type]
    for (const key of Object.keys(descriptor.sharedValidator.fields)) {
      if (key in shape) continue
      shape[key] = v.optional(v.any())
    }
  }
  return v.object(shape as Record<string, GenericValidator>)
}
