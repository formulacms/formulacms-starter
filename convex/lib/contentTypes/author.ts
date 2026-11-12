import { v } from "convex/values"
import { group, list, text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

/**
 * Author — a routable content type with a byline surface. `name` + `socials`
 * at the row level; `title` (seeded from `name` at creation) + `metaTitle` +
 * `metaDescription` + `roleTitle` per locale. Routable at `/authors/<slug>`;
 * SEO opts into `Person` / `profile` so JSON-LD + OG tags match the semantic
 * type.
 *
 * ADR-0038 §Slices-as-body: `bio` was retired in plan 029 C10 (task 6).
 * Formatted author intros now live as a `rich-text-body` slice on the
 * author's slice canvas — `sliceBody: true`. JSON-LD `Person.description` and
 * reference-card excerpts derive from the first-slice text extract via the
 * search extractor's slice walk. Adding a `bio` field back requires editing
 * this file AND removing the corresponding line from the plan 029 addendum
 * classification table.
 *
 * Post-C7: every routable descriptor declares its full localized shape here —
 * the schema arm's `content[locale]` derives from `localizedValidator`, no
 * shared junk-drawer widening. Author-specific `roleTitle` is stored only
 * under the author arm (schema derivation enforces this at push time).
 */

const sharedFields = {
  name: text({ placeholder: "Full name" }).public(),
  socials: list(
    group({
      platform: text(),
      url: text(),
    })
  )
    .optional()
    .public(),
} as const

const localizedFields = {
  title: text({ placeholder: "Author display name" }).public(),
  metaTitle: text().optional().public(),
  metaDescription: text({ multiline: true }).optional().public(),
  roleTitle: text().optional().public(),
} as const

export const authorContentType: ContentTypeDescriptor<
  typeof sharedFields,
  typeof localizedFields
> = {
  type: "author",
  label: { singular: "Author", plural: "Authors" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({
    name: sharedFields.name.validator,
    socials: sharedFields.socials.validator,
  }),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    metaTitle: localizedFields.metaTitle.validator,
    metaDescription: localizedFields.metaDescription.validator,
    roleTitle: localizedFields.roleTitle.validator,
  }),
  routing: { pathPrefix: "authors" },
  seo: { schemaOrgType: "Person", ogType: "profile" },
  capabilities: {
    sliceBody: true,
    revisions: true,
    scheduling: true,
    presence: true,
    requiresBodyContent: false,
  },
  referenceCard: (doc, locale) => {
    const content = (
      doc as {
        content?: Record<string, { title?: string; roleTitle?: string }>
      }
    ).content
    const name = (doc as { name?: string }).name
    // Use `||` so an empty localized title falls through to `name` and
    // then to the "Untitled" default; `??` would short-circuit on "".
    const title = content?.[locale]?.title || name || "Untitled"
    const subtitle = content?.[locale]?.roleTitle
    const slug = (doc as { slug?: string }).slug ?? ""
    const status = (doc as { status?: string }).status
    const imageMediaId = (
      doc as {
        cardImageMediaId?: import("../../_generated/dataModel").Id<"media">
      }
    ).cardImageMediaId
    return {
      id: doc._id,
      type: "author",
      title,
      ...(!(content?.[locale]?.title || name)
        ? { titleFallback: "untitled" as const }
        : {}),
      subtitle: subtitle && subtitle.length > 0 ? subtitle : undefined,
      href:
        status === "published" && slug
          ? `/${locale}/authors/${slug}`
          : undefined,
      imageMediaId,
    }
  },
}
