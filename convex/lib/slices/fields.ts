import { type Infer } from "convex/values"
import { image, link, select, text, boolean, group } from "./primitives"

/**
 * Reusable field descriptors shared across slices, built on the primitive
 * registry. Validators + Infer types are re-exported under their historical
 * names so app-side imports keep resolving.
 */

// ---- image ----------------------------------------------------------------
export const imagePrimitive = image()
export const imageField = imagePrimitive.validator
export type ImageField = Infer<typeof imageField>

// ---- link -----------------------------------------------------------------
export const linkPrimitive = link()
export const cmsLinkField = linkPrimitive.validator
export type CMSLinkField = Infer<typeof cmsLinkField>

// ---- button (a reusable named group) --------------------------------------
// label + link + variant + optional media-library icon + enabled. A slice's
// `items` is `list(button)`.
export const button = group({
  id: text({ editorial: false }).optional(),
  label: text(),
  link: link(),
  variant: select({
    options: ["primary", "secondary", "outline", "ghost", "link"],
    default: "primary",
  }).optional(),
  withIcon: boolean({ label: "Show icon", default: false }),
  icon: image().optional(),
  enabled: boolean({ label: "Enabled", default: true }),
})
export const buttonField = button.validator
export type ButtonField = Infer<typeof buttonField>
