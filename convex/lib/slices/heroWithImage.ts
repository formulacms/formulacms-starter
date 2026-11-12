import { v, type Infer } from "convex/values"
import { group, text, richText, image, link, list } from "./primitives"
import { button } from "./fields"
import { buildPMDoc, buildPMDocForContract } from "../richtext/build"

const primary = group({
  eyebrow: text({ placeholder: "We're hiring!" }),
  eyebrowLinkLabel: text({ placeholder: "Join our remote team" }).optional(),
  eyebrowLink: link(),
  title: richText({
    contract: "title",
    heading: { role: "sliceTitle" },
    placeholder: "People who care about your growth",
  }),
  description: richText({
    contract: "basic",
    headingFloor: { parent: "primary.title" },
    placeholder:
      "Powerful, self-serve product and growth analytics to help you convert, engage, and retain more.",
  }),
  image: image(),
})

const items = list(button, { max: 2 })

const bodyDoc = (text: string) =>
  JSON.stringify(buildPMDoc(text, "basic", { emphasis: true }))

const previewPrimary: Infer<typeof primary.validator> = {
  eyebrow: "We're hiring!",
  eyebrowLinkLabel: "Join our remote team",
  eyebrowLink: {
    type: "external",
    url: "https://example.com/careers",
  },
  title: JSON.stringify(
    buildPMDocForContract(
      "People who care about your growth",
      { contract: "title" },
      { emphasis: true }
    )
  ),
  description: bodyDoc(
    "Powerful, self-serve product and growth analytics to help you convert, engage, and retain more."
  ),
  image: {
    url: "/slice-samples/hero-with-image.webp",
    width: 1500,
    height: 1201,
    alt: "Person standing in a creative studio",
  },
}

const previewItems: Infer<typeof items.validator> = [
  {
    id: "demo",
    label: "Demo",
    link: { type: "external", url: "https://example.com/demo" },
    variant: "outline",
    withIcon: false,
    enabled: true,
  },
  {
    id: "sign-up",
    label: "Sign up",
    link: { type: "external", url: "https://example.com/sign-up" },
    variant: "primary",
    withIcon: false,
    enabled: true,
  },
]

/** Hero with Image slice descriptor with reference-backed simulator content. */
export const heroWithImageDef = {
  type: "hero-with-image" as const,
  primary,
  items,
  validator: v.object({
    id: v.string(),
    type: v.literal("hero-with-image"),
    enabled: v.boolean(),
    primary: primary.validator,
    items: items.validator,
  }),
  preview: { primary: previewPrimary, items: previewItems },
  aiHint: {
    purpose:
      "Write a bold hero section with an optional eyebrow announcement, headline, supporting copy, two CTAs, and a side image.",
    fields: [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[eyebrow]\nShort announcement label, e.g., We're hiring!\n[/eyebrow]",
      "[eyebrowLinkLabel]\nVisible label for the eyebrow CTA, e.g., Join our remote team\n[/eyebrowLinkLabel]",
      "[eyebrowLink]\nDestination metadata for the eyebrow CTA\n[/eyebrowLink]",
      "[title]\nMain headline for the hero section\n[/title]",
      "[description]\nOne or two sentences supporting the headline\n[/description]",
      "[items]\n- Demo\n- Sign up\n[/items]",
    ].join("\n\n"),
  },
}

export const heroWithImageSlice = heroWithImageDef.validator
export type HeroWithImageSlice = Infer<typeof heroWithImageSlice>
