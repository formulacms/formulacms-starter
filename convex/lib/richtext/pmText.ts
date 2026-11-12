/**
 * Pure PM-JSON text extraction + reinjection for AI translation.
 *
 * rich-text values are PM-JSON serialized to a string (ADR-0009). To translate
 * one without mangling structure we never hand the JSON blob to the model — we
 * walk the tree, pull out `text` node strings in document order, translate just
 * those, then write them back into the same positions. Marks (bold/italic/link),
 * node structure, attrs, and every non-text node are preserved untouched.
 *
 * Pure: no TipTap, no DOM. Safe to import into the Convex runtime.
 */

interface PMNode {
  type?: unknown
  text?: unknown
  content?: unknown
  [k: string]: unknown
}

function isPMNode(value: unknown): value is PMNode {
  return typeof value === "object" && value !== null
}

/** Collect the `.text` of every text node, in document order. */
export function collectTextSegments(node: unknown): string[] {
  const out: string[] = []
  function walk(n: unknown): void {
    if (!isPMNode(n)) return
    if (n.type === "text" && typeof n.text === "string") out.push(n.text)
    if (Array.isArray(n.content)) for (const child of n.content) walk(child)
  }
  walk(node)
  return out
}

/**
 * Return a deep copy of `node` with each text node's `.text` replaced by the
 * next entry of `replacements` (consumed in the same document order
 * {@link collectTextSegments} produced). Extra/short arrays are tolerated: a
 * missing replacement leaves the original text in place.
 * An empty replacement removes that text node, retaining its surrounding
 * block, breaks and siblings so the translated/refined document stays valid.
 */
export function replaceTextSegments(
  node: unknown,
  replacements: string[]
): unknown {
  let i = 0
  const removed = Symbol("empty text replacement")
  function map(n: unknown): unknown {
    if (!isPMNode(n)) return n
    const next: PMNode = { ...n }
    if (n.type === "text" && typeof n.text === "string") {
      next.text = i < replacements.length ? replacements[i] : n.text
      i += 1
      if (next.text === "") return removed
    }
    if (Array.isArray(n.content)) {
      next.content = n.content.map(map).filter((child) => child !== removed)
    }
    return next
  }
  const result = map(node)
  return result === removed ? null : result
}

/** Parse a stored rich-text string; returns null when it is not a PM document. */
export function parsePMDoc(json: string): PMNode | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!isPMNode(parsed) || parsed.type !== "doc") return null
  return parsed
}

/** Extract normalized visible text from stored PM-JSON or legacy HTML/text. */
export function richTextToPlainText(value: string): string {
  if (!value.trim()) return ""
  const doc = parsePMDoc(value)
  const text = doc
    ? visibleTextWithSeparators(doc)
    : value.replace(/<[^>]*>/g, " ")
  return text.replace(/\s+/g, " ").trim()
}

function visibleTextWithSeparators(node: unknown): string {
  if (!isPMNode(node)) return ""
  if (node.type === "text")
    return typeof node.text === "string" ? node.text : ""
  if (node.type === "hardBreak") return " "
  if (!Array.isArray(node.content)) return ""
  const children = node.content.map(visibleTextWithSeparators)
  return children.join(
    node.type === "paragraph" || node.type === "heading" ? "" : " "
  )
}
