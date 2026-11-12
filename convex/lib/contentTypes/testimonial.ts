import { v } from "convex/values"
import { image, text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

/**
 * Testimonial — the first `sliceBody: false` content type (plan 029 C10
 * vertical tracer). Non-routable: exists to be referenced from a
 * "testimonials" slice on another page, not to be its own URL.
 *
 * Registering it widened `content[locale]` from the slice-body shape to a
 * union that also admits this type's pure-form `{title, quote}`. Consumers
 * that read `.slices` / `.metaTitle` / `.metaDescription` narrow first — see
 * `hasSliceBody` in `convex/lib/pages/sliceBodyContent.ts`, which is the seam
 * that keeps that widening from reaching every read site.
 *
 * Shape per plan 029 addendum §Q8 (owner-approved 2026-07-09):
 * - Shared: personName (required, public), personRole?/personCompany?/
 *   personImage?/sourceUrl? (all public, all optional).
 * - Localized: title (required, INTERNAL — editors identify testimonials
 *   by "Person X @ Acme" in admin; public renderer never surfaces it) and
 *   quote (required, plain multiline text, public — translated per locale).
 *
 * Capabilities:
 * - `sliceBody: false` — activates {@link armLocalizedContentValidatorNoSlices}.
 *   The admin editor renders a PURE FORM for this arm: no slice canvas, no
 *   "Add slice" button (`components/admin/page-editor.tsx` gates the canvas on
 *   `capabilities.sliceBody`).
 * - `revisions: true` — save-history discipline still applies.
 * - `scheduling: false` / `presence: false` — one-shot reference targets
 *   don't warrant scheduling or lock choreography.
 * - `requiresBodyContent: false` — n/a for a pure-form type (no body to
 *   require).
 *
 * Non-routable (`routing` omitted): the slug field on the storage row is
 * kept for internal identification (existing `pages.slug` invariant),
 * and the New-Page dialog will auto-generate a hidden internal handle.
 *
 * Exposure classification (ADR-0038 §Q9.b): `.public()` on shared name/
 * role/company/image/sourceUrl and on the localized quote. `title` is
 * left UNMARKED so the fail-closed default keeps it out of public
 * surfaces — editors see it in the admin, the public renderer never does.
 */

const sharedFields = {
  personName: text({ placeholder: "Person's name" }).public(),
  personRole: text({ placeholder: "e.g. CEO" }).optional().public(),
  personCompany: text({ placeholder: "Company name" }).optional().public(),
  personImage: image().optional().public(),
  sourceUrl: text({ placeholder: "https://…" }).optional().public(),
} as const

const localizedFields = {
  // Internal identifier — editors see it in the admin ("Grace Hopper @
  // Yale, 1980"), the public renderer never surfaces it. No `.public()`.
  title: text({ placeholder: "Internal label (never rendered publicly)" }),
  quote: text({
    multiline: true,
    placeholder: "The testimonial text",
  }).public(),
} as const

export const testimonialContentType: ContentTypeDescriptor<
  typeof sharedFields,
  typeof localizedFields
> = {
  type: "testimonial",
  label: { singular: "Testimonial", plural: "Testimonials" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({
    personName: sharedFields.personName.validator,
    personRole: sharedFields.personRole.validator,
    personCompany: sharedFields.personCompany.validator,
    personImage: sharedFields.personImage.validator,
    sourceUrl: sharedFields.sourceUrl.validator,
  }),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    quote: localizedFields.quote.validator,
  }),
  // No routing — testimonials are referenced by relation() only.
  // No SEO — no public URL.
  capabilities: {
    sliceBody: false,
    revisions: true,
    scheduling: false,
    presence: false,
    requiresBodyContent: false,
  },
  referenceCard: (doc, locale) => {
    const content = (doc as {
      content?: Record<string, { title?: string; quote?: string }>
    }).content
    const personName = (doc as { personName?: string }).personName
    const personCompany = (doc as { personCompany?: string }).personCompany
    const localizedTitle = content?.[locale]?.title
    // Internal identifier is the fallback shown to editors picking a
    // testimonial. Public consumers must NOT render this — the exposure
    // contract's admin-only classification keeps them from seeing it via
    // descriptor walking, and reference-card consumers should use the
    // testimonial's own public renderer (`components/content-types/
    // testimonial.tsx`) for public surfaces.
    const title =
      personName ||
      localizedTitle ||
      "Untitled testimonial"
    const subtitle = personCompany || undefined
    const quote = content?.[locale]?.quote
    return {
      id: doc._id,
      type: "testimonial",
      title,
      subtitle: subtitle || (quote ? quote.slice(0, 120) : undefined),
      // Non-routable — no href.
    }
  },
}

