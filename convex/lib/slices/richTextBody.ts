import { v, type Infer } from "convex/values"
import { group, richText } from "./primitives"

const primary = group({
  body: richText({
    profile: "full",
  }),
})

/**
 * Rich Text Body slice — a single full-profile rich-text block.
 * Used as the default landing slice for imported documents (.md, .docx).
 * Escape-hatch hand-authored: this is a foundational reference slice — a plain
 * prose container with no decorative heading, eyebrow, or CTA fields.
 */
export const richTextBodyDef = {
  type: "rich-text-body" as const,
  primary,
  validator: v.object({
    id: v.string(),
    type: v.literal("rich-text-body"),
    enabled: v.boolean(),
    primary: primary.validator,
  }),
  aiHint: {
    purpose:
      "A plain full-width rich-text content block. Use for article bodies, long-form prose, imported documents, or any freeform content section. Supports headings, lists, blockquotes, code blocks, images, and tables.",
    fields: [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[body]\nThe full rich-text content. Markdown headings (## Heading), bold, italic, bullet lists (- item) and numbered lists (1. item) are supported. Write everything else as plain sentences.\n[/body]",
    ].join("\n\n"),
  },
}

export const richTextBodySlice = richTextBodyDef.validator
export type RichTextBodySlice = Infer<typeof richTextBodySlice>
