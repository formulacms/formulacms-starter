import { isRichTextEmpty } from "@/convex/lib/richtext/emptiness"

export const inputClass =
  "w-full px-3 py-1.5 text-sm rounded-md border bg-background focus:outline-none focus:ring-1 focus:ring-ring"

/**
 * Does a field value carry real content? Plain text: any non-whitespace. Rich
 * text (PM-JSON string): a doc with at least one text node — an "empty" editor
 * still serializes to a doc with an empty paragraph, which must not count.
 */
export function fieldHasContent(value: string | undefined): boolean {
  return !isRichTextEmpty(value)
}
