import { v, type Infer } from "convex/values"
import { group, text, richText, list } from "./primitives"
import { button } from "./fields"

const primary = group({
  eyebrow: text({ placeholder: "MONTRÉAL, QC — DIGITAL AGENCY" }),
  title: richText({
    contract: "title",
    heading: { role: "sliceTitle" },
    placeholder: "We craft digital experiences.",
  }),
  description: richText({
    contract: "basic",
    headingFloor: { parent: "primary.title" },
    placeholder:
      "Web design, development & AI integration — we build ambitious digital products for brands that want to lead.",
  }),
})

const items = list(button, { max: 2 })

/** Hero Agency slice descriptor — scaffolded (ADR-0016 M2). Tune the aiHint
 *  and replace the renderer stub with designed JSX before merging. */
export const heroAgencyDef = {
  type: "hero-agency" as const,
  primary,
  items,
  validator: v.object({
    id: v.string(),
    type: v.literal("hero-agency"),
    enabled: v.boolean(),
    primary: primary.validator,
    items: items.validator,
  }),
  aiHint: {
    purpose:
      "Capture the agency's primary value proposition and location/status.",
    fields: [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[eyebrow]\nLocation and agency type (e.g., LONDON, UK — CREATIVE STUDIO)\n[/eyebrow]",
      "[title]\nShort, punchy headline (max 5-7 words)\n[/title]",
      "[description]\nOne or two sentences describing core services and target audience.\n[/description]",
      "[items]\n- Let's Talk (primary)\n- View Work (outline)\n[/items]",
    ].join("\n\n"),
  },
}

export const heroAgencySlice = heroAgencyDef.validator
export type HeroAgencySlice = Infer<typeof heroAgencySlice>
