import { v } from "convex/values"
import { text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

/**
 * Generic page — the parent-hierarchy-participating, sliceBody-driven default.
 * Routable at `<locale>/<slug>` (empty pathPrefix = mounted at the locale
 * root); scheduling + revisions + presence all on. No type-specific row
 * fields — page and landing-page are identical at the row level today; only
 * the `pageType` discriminator distinguishes them.
 */

const sharedFields = {} as const
const localizedFields = {
  title: text({ placeholder: "Untitled page" }).public(),
  metaTitle: text().optional().public(),
  metaDescription: text({ multiline: true }).optional().public(),
} as const

export const pageContentType: ContentTypeDescriptor<typeof sharedFields, typeof localizedFields> = {
  type: "page",
  label: { singular: "Page", plural: "Pages" },
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
      type: "page",
      title,
      href: status === "published" && slug ? `/${locale}/${slug}` : undefined,
    }
  },
}
