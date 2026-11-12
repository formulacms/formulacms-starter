/** Pure shared definition of rich-text content; intentionally no TipTap import. */
export function isRichTextEmpty(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return true
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return false
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "doc" ||
    !Array.isArray(parsed.content)
  )
    return false

  const pending: unknown[] = [parsed]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!isRecord(current)) continue
    if (typeof current.type !== "string") return false
    if (current.content !== undefined && !Array.isArray(current.content))
      return false
    if (
      current.marks !== undefined &&
      (!Array.isArray(current.marks) ||
        current.marks.some(
          (mark) => !isRecord(mark) || typeof mark.type !== "string"
        ))
    )
      return false
    if (current.type === "text") {
      if (typeof current.text !== "string") return false
      if (current.content !== undefined) return false
      if (current.text.trim()) return false
      continue
    }
    if (current.type === "horizontalRule") return false
    if (current.type === "image") {
      const attrs = isRecord(current.attrs) ? current.attrs : undefined
      if (typeof attrs?.src !== "string") return false
      if (attrs.src.trim()) return false
    }
    if (
      ![
        "doc",
        "paragraph",
        "heading",
        "blockquote",
        "bulletList",
        "orderedList",
        "listItem",
        "codeBlock",
        "table",
        "tableRow",
        "tableCell",
        "tableHeader",
        "hardBreak",
        "image",
        "horizontalRule",
      ].includes(current.type)
    )
      return false
    if (Array.isArray(current.content)) pending.push(...current.content)
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
