import { v } from "convex/values"
import { boolean, list, relation, text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

/**
 * Post — carries a byline (`authorIds`, plural per plan 029 C10) +
 * classification (`tags`, `category`) + editorial flags (`featured`,
 * `promoteToFront`) + the post-listing card surface (shared per ADR-0037 §4).
 *
 * Plan 029 C10 shape (2026-07-09):
 * - `authorIds: list(relation({pageTypes:["author"]}))` — was singular
 *   `authorId` prior to C10. Position = byline order; first = lead author by
 *   convention. `documentReferences` fan-out via the walker's list-of-relations
 *   walk (no code change needed).
 * - `featured: boolean` (default false) — public editorial highlight; drives
 *   the reference-card badge. Indexed via `by_type_featured`.
 * - `promoteToFront: boolean` (default false) — sticky singleton; the save
 *   mutation auto-unsets any other post with `promoteToFront === true` so at
 *   most one post carries the flag at a time. Blog-page renderer picks up the
 *   flag as first slot (render-time publish gate). Indexed via
 *   `by_type_promoteToFront`.
 * - `capabilities.requiresBodyContent: true` — publish walker requires ≥1
 *   meaningful enabled slice for post (slices-as-body per ADR-0038
 *   §Slices-as-body). Emits `missing_required_field: "body"` when empty.
 *
 * ADR-0038 exposure: `.public()` on every field EXCEPT `tags` (locked as
 * "Internal Labels" — plan 029 §Recommended editor seam).
 */

const sharedFields = {
  authorIds: list(relation({ pageTypes: ["author"] })).optional().public(),
  tags: list(text()).optional(),
  category: text().optional().public(),
  featured: boolean({ default: false }).public(),
  promoteToFront: boolean({ default: false }).public(),
} as const
const localizedFields = {
  title: text({ placeholder: "Untitled post" }).public(),
  metaTitle: text().optional().public(),
  metaDescription: text({ multiline: true }).optional().public(),
} as const

export const postContentType: ContentTypeDescriptor<typeof sharedFields, typeof localizedFields> = {
  type: "post",
  label: { singular: "Post", plural: "Posts" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({
    authorIds: sharedFields.authorIds.validator,
    tags: sharedFields.tags.validator,
    category: sharedFields.category.validator,
    featured: sharedFields.featured.validator,
    promoteToFront: sharedFields.promoteToFront.validator,
  }),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    metaTitle: localizedFields.metaTitle.validator,
    metaDescription: localizedFields.metaDescription.validator,
  }),
  routing: { pathPrefix: "" },
  seo: { schemaOrgType: "Article", ogType: "article" },
  capabilities: {
    sliceBody: true,
    revisions: true,
    scheduling: true,
    presence: true,
    requiresBodyContent: true,
  },
  referenceCard: (doc, locale) => {
    const content = (doc as { content?: Record<string, { title?: string }> }).content
    const title = content?.[locale]?.title ?? "Untitled"
    const slug = (doc as { slug?: string }).slug ?? ""
    const status = (doc as { status?: string }).status
    const featured = (doc as { featured?: boolean }).featured === true
    return {
      id: doc._id,
      type: "post",
      title,
      href: status === "published" && slug ? `/${locale}/${slug}` : undefined,
      featured,
    }
  },
}
