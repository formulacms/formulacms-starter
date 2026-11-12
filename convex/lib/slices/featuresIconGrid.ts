import { v, type Infer } from "convex/values"
import { group, text, richText, list } from "./primitives"

const primary = group({
  eyebrow: text({ placeholder: "Features" }).optional(),
  heading: richText({
    contract: "title",
    heading: { role: "sliceTitle" },
    placeholder: "Designed to scale",
  }),
  body: richText({
    contract: "basic",
    headingFloor: { parent: "primary.heading" },
    placeholder: "Spend less time configuring and more time creating.",
  }).optional(),
})

const items = list(
  group({
    icon: text({ placeholder: "Zap", translatable: false }).optional(),
    title: richText({
      contract: "title",
      heading: { role: "itemTitle", parent: "primary.heading" },
      placeholder: "Blazing Fast Performance",
    }),
    body: richText({
      contract: "basic",
      headingFloor: { parent: "items.title" },
      placeholder:
        "Optimized for speed with minimal loading times and instant interactions.",
    }),
  }),
  { max: 6 }
)

/**
 * Features Icon Grid slice descriptor — centered section heading with an
 * optional eyebrow + body intro, followed by a responsive 3-column grid of
 * feature cards (icon + title + description per card).
 *
 * Rewritten token-bound from the `features-12` shadcn block (ADR-0016 / ADR-0020).
 *
 * CSS classification drops:
 *   - Card shadow / hover states → CSS-only decoration (no field).
 *   - Grid column count (1/2/3) → CSS breakpoint classes (no structural-intent field).
 *   - Icon background color / icon size → CSS (`bg-brand/10`, `size-8`).
 *   - "Learn more" per-card link in source block → static UI chrome; dropped.
 *   - Decorative striped header cell → CSS decoration; dropped.
 *   - `overlayOpacity`, `alignment`, `imageMode` → not applicable.
 */
export const featuresIconGridDef = {
  type: "features-icon-grid" as const,
  primary,
  items,
  validator: v.object({
    id: v.string(),
    type: v.literal("features-icon-grid"),
    enabled: v.boolean(),
    primary: primary.validator,
    items: items.validator,
  }),
  aiHint: {
    purpose:
      "A responsive grid of feature cards under a section heading. Each card has an optional icon (one of the curated Lucide names: CloudUpload, Lock, Server, Database, Shield, Zap, Rocket, Globe, Gauge, RefreshCw, GitBranch, Settings), a short title, and a one-to-two sentence description. Best for listing product capabilities or service highlights.",
    fields: [
      "Return the fields below, each wrapped in matching fenced tags.",
      '[eyebrow]\nShort label above the heading (e.g., "Why choose us"). Omit the tag entirely if not needed.\n[/eyebrow]',
      "[heading]\nSection heading — 4–6 words maximum.\n[/heading]",
      "[body]\nOne sentence expanding the heading. Bold or italic may be used for emphasis. Omit the tag entirely if not needed.\n[/body]",
      "[items]\nProvide 3–6 items in this format. The icon must be exactly one of these names: CloudUpload, Lock, Server, Database, Shield, Zap, Rocket, Globe, Gauge, RefreshCw, GitBranch, Settings. Leave out the \"icon:\" pair when none fits; never invent another name.\n- icon: Zap | title: Blazing Fast | body: Optimized for speed with instant interactions.\n- icon: Globe | title: Works Everywhere | body: Mobile-first and accessible on all devices.\n- icon: Shield | title: Secure by Default | body: Built-in best practices for auth and data protection.\n[/items]",
    ].join("\n\n"),
  },
}

export const featuresIconGridSlice = featuresIconGridDef.validator
export type FeaturesIconGridSlice = Infer<typeof featuresIconGridSlice>
