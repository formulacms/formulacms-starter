import { readSliceMetadata } from "@/lib/slices/builder"
import { readSliceDefinition } from "@/convex/lib/slices"
import { sliceDefs, type Primitive } from "@/convex/lib/slices"
import { authorContentType } from "@/convex/lib/contentTypes/author"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { SLICE_METADATA, type SliceMetadata } from "@/lib/slices/builder"
import { humanize } from "@/lib/humanize"

import type { MessageKeys, NestedKeyOf } from "next-intl"

type MetadataMessages =
  (typeof import("../../messages/admin/en.json"))["metadata"]
export type AdminMetadataMessageKey = MessageKeys<
  MetadataMessages,
  NestedKeyOf<MetadataMessages>
>
export type AdminMetadataTranslator = (key: AdminMetadataMessageKey) => string
const bundledCopy: Partial<
  Record<
    string,
    {
      label: string
      description: string
      labelKey: AdminMetadataMessageKey
      descriptionKey: AdminMetadataMessageKey
    }
  >
> = {
  "cta-band": {
    labelKey: "slices.cta-band.label",
    descriptionKey: "slices.cta-band.description",
    label: "CTA Band",
    description:
      "A full-width branded call-to-action band with a heading, optional body copy, and up to two CTA buttons.",
  },
  "faq-simple": {
    labelKey: "slices.faq-simple.label",
    descriptionKey: "slices.faq-simple.description",
    label: "FAQ Simple",
    description: "Section heading with an expandable accordion of FAQ items.",
  },
  "features-icon-grid": {
    labelKey: "slices.features-icon-grid.label",
    descriptionKey: "slices.features-icon-grid.description",
    label: "Features Icon Grid",
    description:
      "Responsive grid of feature cards with optional icon, title, and description under a section heading.",
  },
  "hero-agency": {
    labelKey: "slices.hero-agency.label",
    descriptionKey: "slices.hero-agency.description",
    label: "Hero Agency",
    description:
      "High-impact agency hero with eyebrow text and split footer layout.",
  },
  "hero-with-image": {
    labelKey: "slices.hero-with-image.label",
    descriptionKey: "slices.hero-with-image.description",
    label: "Hero with Image",
    description:
      "Split hero with eyebrow announcement, headline, description, CTAs, and a side image.",
  },
  "rich-text-body": {
    labelKey: "slices.rich-text-body.label",
    descriptionKey: "slices.rich-text-body.description",
    label: "Rich Text Body",
    description:
      "A plain full-width rich-text content block for article bodies, long-form prose, or imported documents.",
  },
}

/** Translate only the current bundled copy, preserving custom metadata. */
export function adminSliceMetadata(
  type: string,
  t: AdminMetadataTranslator,
  metadata: SliceMetadata | undefined = readSliceMetadata(
    type as keyof typeof SLICE_METADATA
  )
): SliceMetadata | undefined {
  const expected = bundledCopy[type]
  if (!metadata || metadata.origin !== "system" || !expected) return metadata
  return {
    ...metadata,
    label:
      metadata.label === expected.label ? t(expected.labelKey) : metadata.label,
    description:
      metadata.description === expected.description
        ? t(expected.descriptionKey)
        : metadata.description,
  }
}
const groupKeys: Partial<Record<string, AdminMetadataMessageKey>> = {
  heroes: "groups.heroes",
  features: "groups.features",
  "body-copy": "groups.body-copy",
  cta: "groups.cta",
  faq: "groups.faq",
  forms: "groups.forms",
  misc: "groups.misc",
}
export function adminSliceGroupLabel(
  id: string,
  fallback: string,
  t: AdminMetadataTranslator
): string {
  const key = groupKeys[id]
  return key ? t(key) : fallback
}
const ownedFields = new WeakSet<object>()
function register(def: Primitive) {
  ownedFields.add(def)
  if (def.kind === "group")
    Object.values(def.config.fields as Record<string, Primitive>).forEach(
      register
    )
  if (def.kind === "list") register(def.config.item as Primitive)
}
for (const type of Object.keys(bundledCopy)) {
  const def = readSliceDefinition(type as keyof typeof sliceDefs)
  if (def) {
    register(def.primary)
    if (def.items !== undefined) register(def.items)
  }
}
for (const descriptor of [authorContentType, postContentType]) {
  Object.values(descriptor.sharedFields).forEach(register)
  Object.values(descriptor.localizedFields).forEach(register)
}
const fieldKeys: Partial<Record<string, AdminMetadataMessageKey>> = {
  heading: "fields.heading",
  title: "fields.title",
  body: "fields.body",
  eyebrow: "fields.eyebrow",
  description: "fields.description",
  eyebrowLinkLabel: "fields.eyebrowLinkLabel",
  eyebrowLink: "fields.eyebrowLink",
  image: "fields.image",
  question: "fields.question",
  answer: "fields.answer",
  icon: "fields.icon",
  label: "fields.label",
  link: "fields.link",
  name: "fields.name",
  socials: "fields.socials",
  platform: "fields.platform",
  url: "fields.url",
  roleTitle: "fields.roleTitle",
  category: "fields.category",
  featured: "fields.featured",
  promoteToFront: "fields.promoteToFront",
  items: "fields.items",
}
const hints: Partial<Record<string, AdminMetadataMessageKey>> = {
  "Full name": "hints.fullName",
  "How does your pricing work?": "hints.faqQuestion",
  Features: "hints.featuresEyebrow",
  "MONTRÉAL, QC — DIGITAL AGENCY": "hints.agencyEyebrow",
  "We're hiring!": "hints.hiringEyebrow",
  "Join our remote team": "hints.hiringLink",
}
/** Object identity distinguishes bundled primitives from owner-created fields. */
export function adminFieldMetadata(
  def: Primitive,
  name: string,
  t: AdminMetadataTranslator
): { label: string; def: Primitive } {
  if (!ownedFields.has(def)) return { label: humanize(name), def }
  const labelKey = fieldKeys[name]
  const label = labelKey ? t(labelKey) : humanize(name)
  const placeholder = def.config.placeholder
  const hint = typeof placeholder === "string" ? hints[placeholder] : undefined
  return {
    label,
    def: hint
      ? { ...def, config: { ...def.config, placeholder: t(hint) } }
      : def,
  }
}
/** Known bundled provider copy is separate from owner registrations and brands. */
export function adminEmailProvider<
  T extends { id: string; label: string; description: string },
>(entry: T, t: AdminMetadataTranslator): T {
  if (
    entry.id === "resend" &&
    entry.description === "Transactional email delivery through Resend."
  )
    return { ...entry, description: t("email.resendDescription") }
  if (
    entry.id === "custom" &&
    entry.label === "Custom provider" &&
    entry.description ===
      "Register a reviewed provider implementation in this application build."
  )
    return {
      ...entry,
      label: t("email.customLabel"),
      description: t("email.customDescription"),
    }
  return entry
}
