import { v, type Infer } from "convex/values"
import { group, text, richText, list } from "./primitives"

const primary = group({
  eyebrow: text({ placeholder: "FAQ" }).optional(),
  heading: richText({
    contract: "title",
    heading: { role: "sliceTitle" },
    placeholder: "Frequently Asked Questions",
  }),
  body: richText({
    profile: "inline",
    placeholder: "Find answers to the most common questions below.",
  }).optional(),
})

const items = list(
  group({
    question: richText({
      contract: "title",
      heading: { role: "itemTitle", parent: "primary.heading" },
      placeholder: "How does your pricing work?",
    }),
    answer: richText({
      profile: "basic",
      placeholder: "You can return unused items within 30 days.",
    }),
  }),
  { max: 12 }
)

/**
 * FAQ Simple slice descriptor — a centered section heading with an optional
 * eyebrow + body intro, followed by a single-column accordion of FAQ items.
 *
 * Rewritten token-bound from the `faq-02` shadcn block (ADR-0016 / ADR-0020).
 *
 * CSS classification drops:
 *   - Heading font size (`text-4xl`, `tracking-[-0.04em]`) → CSS; renderer
 *     binds `text-title font-medium tracking-tight` (design-system tokens).
 *   - Layout split (h2 left, accordion right, `md:flex-row`) → CSS breakpoint
 *     classes; no editorial field models layout choice.
 *   - `max-w-xl` on accordion panel → CSS (`max-w-prose-content` token).
 *   - Answer text color (`text-muted-foreground`) → CSS token
 *     (`text-on-surface-muted`).
 *   - Accordion `defaultValue` → renderer-only JS behavior; not editorial.
 *   - Padding/gap (`px-6`, `py-20`, `gap-x-12`, `gap-y-6`) → design-system
 *     tokens (`py-section`, `px-gutter`, `gap-gutter`, `gap-stack`).
 *   - Question font size (`text-lg`) → `text-lead` token.
 */
export const faqSimpleDef = {
  type: "faq-simple" as const,
  primary,
  items,
  validator: v.object({
    id: v.string(),
    type: v.literal("faq-simple"),
    enabled: v.boolean(),
    primary: primary.validator,
    items: items.validator,
  }),
  aiHint: {
    purpose:
      "A section heading with an expandable accordion of FAQ items. Best for support, onboarding, or product FAQ sections with up to 12 questions.",
    fields: [
      "Return the fields below, each wrapped in matching fenced tags.",
      '[eyebrow]\nShort label above the heading (e.g., "FAQ" or "Help"). Omit the tag entirely if not needed.\n[/eyebrow]',
      '[heading]\nSection heading — 3–6 words maximum (e.g., "Frequently Asked Questions").\n[/heading]',
      "[body]\nOne sentence that frames the FAQ section. Bold or italic may be used for emphasis. Omit the tag entirely if not needed.\n[/body]",
      "[items]\nProvide 3–8 items in this format:\n- question: How does your pricing work? | answer: We offer monthly and annual plans with a free trial.\n- question: Can I cancel at any time? | answer: Yes, you can cancel your subscription at any time with no penalties.\n[/items]",
    ].join("\n\n"),
  },
}

export const faqSimpleSlice = faqSimpleDef.validator
export type FaqSimpleSlice = Infer<typeof faqSimpleSlice>
