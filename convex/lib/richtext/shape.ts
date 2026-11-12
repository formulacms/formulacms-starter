import type { ResolvedFieldContract } from "./contracts"

export interface RemovedRichTextLink {
  href?: string
  pageId?: string
}

export interface FieldShapeResult {
  value: string
  removedLinks: RemovedRichTextLink[]
}

/** Reports survive repeated adoption/flush without duplicating the same address. */
export function mergeRemovedLinks(
  ...groups: RemovedRichTextLink[][]
): RemovedRichTextLink[] {
  const links = new Map<string, RemovedRichTextLink>()
  for (const group of groups)
    for (const link of group) {
      links.set(JSON.stringify([link.href, link.pageId]), link)
    }
  return [...links.values()]
}

type JsonRecord = Record<string, unknown>

export function toFieldShape(
  contract: ResolvedFieldContract,
  value: string
): FieldShapeResult {
  if (typeof value !== "string")
    return { value: String(value), removedLinks: [] }
  if (contract.contract !== "title" && contract.contract !== "inline") {
    return { value, removedLinks: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    if (
      contract.contract === "title" &&
      !looksLikeMalformedJson(value) &&
      !looksLikeHtml(value)
    ) {
      return {
        value: JSON.stringify(
          plainTitleDoc(value, contract.headingDefaultLevel)
        ),
        removedLinks: [],
      }
    }
    return { value, removedLinks: [] }
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "doc" ||
    !Array.isArray(parsed.content)
  ) {
    return { value, removedLinks: [] }
  }
  if (!isStructurallyReadable(parsed)) return { value, removedLinks: [] }

  if (contract.contract === "inline") {
    const content = parsed.content.map((block) => {
      if (!isRecord(block) || block.type !== "heading") return block
      const next: JsonRecord = { ...block, type: "paragraph" }
      delete next.attrs
      return next
    })
    if (sameValue(content, parsed.content)) return { value, removedLinks: [] }
    return { value: JSON.stringify({ ...parsed, content }), removedLinks: [] }
  }

  const blocks = parsed.content.filter(isRecord)
  if (
    !blocks.every(
      (block) => block.type === "paragraph" || block.type === "heading"
    )
  ) {
    return { value, removedLinks: [] }
  }
  const hasHeading = blocks.some((block) => block.type === "heading")
  if (hasHeading && !(blocks.length === 1 && blocks[0]?.type === "heading")) {
    return { value, removedLinks: [] }
  }
  const removedLinks = collectRemovedLinks(parsed)

  const content = joinTitleLine(
    blocks.map((block) =>
      Array.isArray(block.content) ? stripLinkMarks(block.content) : []
    )
  )
  const next = canonicalTitleDoc(contract.headingDefaultLevel, content)
  if (
    blocks.length === 1 &&
    blocks[0]?.type === "heading" &&
    removedLinks.length === 0 &&
    JSON.stringify(next) === value
  ) {
    return { value, removedLinks }
  }
  return { value: JSON.stringify(next), removedLinks }
}

function plainTitleDoc(value: string, level: number): JsonRecord {
  if (!value.trim()) return canonicalTitleDoc(level, [])
  return canonicalTitleDoc(
    level,
    joinTitleLine([[{ type: "text", text: value }]])
  )
}

function canonicalTitleDoc(level: number, content: JsonRecord[]): JsonRecord {
  return {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level },
        ...(content.length ? { content } : {}),
      },
    ],
  }
}

/**
 * A title is one line (ADR-0055 amendment, owner 2026-11-04). Join the inline
 * content of every block into one run: each `hardBreak`, newline or block
 * boundary becomes one space, runs of whitespace around a break collapse,
 * whitespace next to a break at either end goes, and the words and marks stay.
 */
function joinTitleLine(blocks: JsonRecord[][]): JsonRecord[] {
  const SEP = Symbol("separator")
  const pieces: Array<JsonRecord | typeof SEP> = []
  blocks.forEach((inline, index) => {
    if (index > 0) pieces.push(SEP)
    for (const node of inline) {
      if (node.type === "hardBreak") pieces.push(SEP)
      else if (node.type === "text" && typeof node.text === "string") {
        // A newline inside text is a separator too.
        node.text.split(/\r\n|\r|\n/).forEach((part, at) => {
          if (at > 0) pieces.push(SEP)
          if (part) pieces.push({ ...node, text: part })
        })
      } else pieces.push(node)
    }
  })
  const sameMarks = (a: JsonRecord, b: JsonRecord) =>
    JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? [])
  const out: JsonRecord[] = []
  let gap = false
  let hadSeparator = false
  for (const piece of pieces) {
    if (piece === SEP) {
      gap = true
      hadSeparator = true
      continue
    }
    let node = piece
    if (gap && node.type === "text" && typeof node.text === "string")
      node = { ...node, text: node.text.replace(/^\s+/, "") }
    if (node.type === "text" && node.text === "") continue
    if (gap && out.length) {
      const prev = out[out.length - 1]!
      const prevText = typeof prev.text === "string" ? prev.text : ""
      if (prev.type === "text" && /\s$/.test(prevText)) {
        // The text before the break already ends in whitespace.
      } else if (
        prev.type === "text" &&
        node.type === "text" &&
        sameMarks(prev, node)
      )
        out[out.length - 1] = { ...prev, text: `${prevText} ` }
      else out.push({ type: "text", text: " " })
    }
    gap = false
    const prev = out[out.length - 1]
    if (
      hadSeparator &&
      prev &&
      node.type === "text" &&
      prev.type === "text" &&
      sameMarks(prev, node)
    ) {
      out[out.length - 1] = {
        ...prev,
        text: `${String(prev.text)}${String(node.text)}`,
      }
      continue
    }
    out.push(node)
  }
  // A break at the end takes the whitespace next to it away too.
  const last = out[out.length - 1]
  if (gap && last?.type === "text" && typeof last.text === "string") {
    const text = last.text.replace(/\s+$/, "")
    if (text) out[out.length - 1] = { ...last, text }
    else out.pop()
  }
  return out
}

function stripLinkMarks(nodes: unknown[]): JsonRecord[] {
  const out: JsonRecord[] = []
  for (const node of nodes) {
    if (!isRecord(node))
      throw new Error("unreachable: input was structurally checked")
    const next: JsonRecord = { ...node }
    if (Array.isArray(node.marks)) {
      const marks = node.marks.filter((mark) => {
        return !isRecord(mark) || mark.type !== "link"
      })
      if (marks.length === 0) delete next.marks
      else next.marks = marks
    }
    if (Array.isArray(node.content)) next.content = stripLinkMarks(node.content)
    out.push(next)
  }
  return out
}

function collectRemovedLinks(node: unknown): RemovedRichTextLink[] {
  const removed: RemovedRichTextLink[] = []
  if (!isRecord(node)) return removed
  const pending: unknown[] = [node]
  while (pending.length) {
    const current = pending.pop()
    if (!isRecord(current)) continue
    if (Array.isArray(current.marks)) {
      for (const mark of current.marks) {
        if (!isRecord(mark) || mark.type !== "link") continue
        const attrs = isRecord(mark.attrs) ? mark.attrs : {}
        removed.push({
          ...(typeof attrs.href === "string" ? { href: attrs.href } : {}),
          ...(typeof attrs.pageId === "string" ? { pageId: attrs.pageId } : {}),
        })
      }
    }
    if (Array.isArray(current.content)) {
      for (let index = current.content.length - 1; index >= 0; index -= 1) {
        pending.push(current.content[index])
      }
    }
  }
  return removed
}

function isStructurallyReadable(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "doc" || !Array.isArray(value.content))
    return false
  for (const block of value.content) {
    if (
      !isRecord(block) ||
      (block.type !== "paragraph" && block.type !== "heading")
    )
      return false
    if (block.content !== undefined && !Array.isArray(block.content))
      return false
    if (Array.isArray(block.content)) {
      for (const child of block.content) {
        if (
          !isRecord(child) ||
          (child.type !== "text" && child.type !== "hardBreak")
        )
          return false
        if (
          child.type === "text" &&
          (typeof child.text !== "string" || child.text.length === 0)
        )
          return false
        if (child.content !== undefined) return false
        if (
          child.marks !== undefined &&
          (!Array.isArray(child.marks) ||
            child.marks.some(
              (mark) => !isRecord(mark) || typeof mark.type !== "string"
            ))
        )
          return false
      }
    }
  }
  return true
}

function looksLikeMalformedJson(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith("{") || trimmed.startsWith("[")
}

function looksLikeHtml(value: string): boolean {
  return /^\s*<[A-Za-z!/][^>]*>/.test(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
