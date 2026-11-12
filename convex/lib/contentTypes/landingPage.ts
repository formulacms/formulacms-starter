import { v } from "convex/values"
import { text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

/**
 * Landing page — same row shape as `page` today; the discriminator is what
 * drives admin filters, permission scoping, and the eventual per-type editor
 * chrome. Routable at `<locale>/<slug>` (empty pathPrefix mounts it at the
 * locale root alongside `page`); slug uniqueness is global to the routable
 * namespace so a landing-page and a page cannot share a slug.
 */

const sharedFields = {} as const
const localizedFields = {
  title: text({ placeholder: "Untitled landing page" }).public(),
  metaTitle: text().optional().public(),
  metaDescription: text({ multiline: true }).optional().public(),
} as const

export const landingPageContentType: ContentTypeDescriptor<typeof sharedFields, typeof localizedFields> = {
  type: "landing-page",
  label: { singular: "Landing page", plural: "Landing pages" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({}),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    metaTitle: localizedFields.metaTitle.validator,
    metaDescription: localizedFields.metaDescription.validator,
  }),
  routing: { pathPrefix: "" },
  capabilities: {
    sliceBody: true,
    revisions: true,
    scheduling: true,
    presence: true,
    requiresBodyContent: false,
  },
  referenceCard: (doc, locale) => {
    const content = (doc as { content?: Record<string, { title?: string }> }).content
    const title = content?.[locale]?.title ?? "Untitled"
    const slug = (doc as { slug?: string }).slug ?? ""
    const status = (doc as { status?: string }).status
    return {
      id: doc._id,
      type: "landing-page",
      title,
      href: status === "published" && slug ? `/${locale}/${slug}` : undefined,
    }
  },
}
