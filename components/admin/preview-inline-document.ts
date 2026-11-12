import {
  resolveFieldContract,
  type FieldContract,
  type ResolvedFieldContract,
} from "@/convex/lib/richtext/contracts"
import {
  toFieldShape,
  type RemovedRichTextLink,
} from "@/convex/lib/richtext/shape"
import type { JSONContent } from "@tiptap/core"

/** Public inline rendering separates structural paragraphs with two breaks. */
export function normalizePreviewInlineDocument(
  document: JSONContent,
  contract: FieldContract = "inline",
  report: (links: RemovedRichTextLink[]) => void = () => {},
  resolvedContract?: ResolvedFieldContract
): JSONContent {
  if (contract === "basic" || contract === "full") return document
  const content = (document.content ?? []).flatMap((block, index) => [
    ...(index ? [{ type: "hardBreak" }, { type: "hardBreak" }] : []),
    ...(block.content ?? []),
  ])
  const value = { type: "doc", content: [{ type: "paragraph", content }] }
  if (contract !== "title") return value
  const shaped = toFieldShape(
    resolvedContract ?? resolveFieldContract("title"),
    JSON.stringify(value)
  )
  report(shaped.removedLinks)
  return JSON.parse(shaped.value)
}
