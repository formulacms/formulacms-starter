import type { JSONContent } from "@tiptap/core"
import {
  contractSpec,
  type FieldContract,
} from "@/convex/lib/richtext/contracts"

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function copyAttrs(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? { ...value } : undefined
}

function nearestHeadingLevel(
  value: unknown,
  allowed: ReadonlySet<number>
): number {
  const levels = [...allowed].sort((a, b) => a - b)
  if (levels.length === 0) return 1

  const parsed = positiveInteger(value)
  if (parsed === undefined) return levels[0] ?? 1
  if (allowed.has(parsed)) return parsed

  return levels.reduce((nearest, level) => {
    const distance = Math.abs(level - parsed)
    const nearestDistance = Math.abs(nearest - parsed)
    return distance < nearestDistance ||
      (distance === nearestDistance && level < nearest)
      ? level
      : nearest
  }, levels[0] ?? 1)
}

function copyMarks(
  value: unknown,
  allowed: ReadonlySet<string>
): JSONContent["marks"] {
  if (!Array.isArray(value)) return undefined

  const marks: NonNullable<JSONContent["marks"]> = []
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.type !== "string") continue
    if (!allowed.has(candidate.type)) continue

    const mark: Record<string, unknown> = { type: candidate.type }
    const attrs = copyAttrs(candidate.attrs)
    if (attrs !== undefined) mark.attrs = attrs
    if (candidate.type === "link") {
      const linkAttrs = attrs ?? {}
      if (linkAttrs.target === undefined) {
        mark.attrs = { ...linkAttrs, target: null }
      }
    }
    marks.push(mark as NonNullable<JSONContent["marks"]>[number])
  }
  return marks
}

/** Normalize render input to the requested field contract without mutating it. */
export function normalizeRenderDocument(
  document: unknown,
  contract: FieldContract
): JSONContent {
  if (!isRecord(document) || document.type !== "doc") {
    return { type: "doc", content: [] }
  }

  const spec = contractSpec(contract)
  const root: JSONContent = { type: "doc", content: [] }
  const rootContent = root.content ?? []
  const sourceContent = Array.isArray(document.content) ? document.content : []
  type Frame = { source: unknown[]; target: JSONContent[]; index: number }
  const frames: Frame[] = [
    { source: sourceContent, target: rootContent, index: 0 },
  ]

  while (frames.length > 0) {
    const frame = frames[frames.length - 1]
    if (!frame) break
    if (frame.index >= frame.source.length) {
      frames.pop()
      continue
    }

    const candidate = frame.source[frame.index]
    frame.index += 1
    if (!isRecord(candidate) || typeof candidate.type !== "string") {
      if (isRecord(candidate) && Array.isArray(candidate.content)) {
        frames.push({
          source: candidate.content,
          target: frame.target,
          index: 0,
        })
      }
      continue
    }

    if (!spec.nodes.has(candidate.type)) {
      if (Array.isArray(candidate.content)) {
        frames.push({
          source: candidate.content,
          target: frame.target,
          index: 0,
        })
      }
      continue
    }

    if (candidate.type === "text") {
      if (typeof candidate.text !== "string" || candidate.text.length === 0)
        continue
      const textNode: JSONContent = { type: "text", text: candidate.text }
      const attrs = copyAttrs(candidate.attrs)
      if (attrs !== undefined) textNode.attrs = attrs
      const marks = copyMarks(candidate.marks, spec.marks)
      if (marks !== undefined) textNode.marks = marks
      frame.target.push(textNode)
      continue
    }

    const node: JSONContent = { type: candidate.type }
    let attrs = copyAttrs(candidate.attrs)
    if (candidate.type === "heading") {
      attrs = {
        ...(attrs ?? {}),
        level: nearestHeadingLevel(attrs?.level, spec.headingLevels),
      }
    }
    if (attrs !== undefined) node.attrs = attrs
    const marks = copyMarks(candidate.marks, spec.marks)
    if (marks !== undefined) node.marks = marks
    frame.target.push(node)

    if (Array.isArray(candidate.content)) {
      const children: JSONContent[] = []
      node.content = children
      frames.push({ source: candidate.content, target: children, index: 0 })
    }
  }

  root.content = rootContent
  return root
}
