import { resolveFieldContract, type FieldAddress, type FieldContract } from "./contracts"
import type { Primitive } from "../slices/primitives"
import { readTransitionField, transitionForField } from "./transitions"

export function toComparisonForm(
  contract: FieldContract,
  value: string,
  transitionAddress?: { sliceType: string; fieldPath: string }
): string {
  if (transitionAddress && transitionForField(transitionAddress)) {
    const read = readTransitionField(transitionAddress, value)
    if (read.kind === "title") {
      try {
        const parsed: unknown = JSON.parse(value)
        if (isRecord(parsed) && parsed.type === "doc")
          return flattenTitleDoc(parsed)
      } catch {
        return value
      }
      return value
    }
    if (read.kind === "plain") return plainTextDoc(read.value)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return value
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "doc" ||
    !Array.isArray(parsed.content)
  ) {
    return value
  }
  if (contract !== "inline" && contract !== "title")
    return stableSerialize(parsed)
  if (contract === "title") return flattenTitleDoc(parsed)
  return flattenDoc(parsed)
}

/** Descriptor-driven comparison projection for restore diff callers. */
export function toDescriptorComparisonForm(
  def: Primitive,
  value: unknown,
  address: FieldAddress
): unknown {
  if (def.kind === "group") {
    if (!isRecord(value)) return value
    const fields =
      (def.config as { fields?: Record<string, Primitive> }).fields ?? {}
    const next: Record<string, unknown> = { ...value }
    for (const [key, child] of Object.entries(fields)) {
      next[key] = toDescriptorComparisonForm(child, value[key], {
        ...address,
        fieldPath: address.fieldPath ? `${address.fieldPath}.${key}` : key,
      })
    }
    return next
  }
  if (def.kind === "list") {
    if (!Array.isArray(value)) return value
    const item = (def.config as { item: Primitive }).item
    return value.map((row, index) =>
      toDescriptorComparisonForm(item, row, {
        ...address,
        fieldPath: `${address.fieldPath}[${index}]`,
      })
    )
  }
  if (def.kind === "richText") {
    if (typeof value !== "string") return value
    const { contract } = resolveFieldContract(def.config)
    return toComparisonForm(contract, value, address)
  }
  if (typeof value === "string" && transitionForField(address)) {
    return toComparisonForm("inline", value, address)
  }
  return value
}

function flattenDoc(doc: Record<string, unknown>): string {
  const blocks = Array.isArray(doc.content) ? doc.content : []
  const inline: unknown[] = []
  blocks.forEach((block, index) => {
    if (index > 0) inline.push({ type: "hardBreak" }, { type: "hardBreak" })
    if (isRecord(block) && Array.isArray(block.content))
      inline.push(...block.content)
  })
  return stableSerialize({
    type: "doc",
    content: [
      { type: "paragraph", ...(inline.length ? { content: inline } : {}) },
    ],
  })
}

/**
 * A title is one line, so a stored break, a block boundary and a newline all
 * compare as one space. Nothing is trimmed: a change at an edge still shows.
 */
function flattenTitleDoc(doc: Record<string, unknown>): string {
  const blocks = Array.isArray(doc.content) ? doc.content : []
  const inline: Record<string, unknown>[] = []
  const push = (node: Record<string, unknown>) => {
    const prev = inline[inline.length - 1]
    if (
      node.type === "text" &&
      typeof node.text === "string" &&
      prev?.type === "text" &&
      typeof prev.text === "string" &&
      stableSerialize(prev.marks ?? []) === stableSerialize(node.marks ?? [])
    )
      inline[inline.length - 1] = { ...prev, text: prev.text + node.text }
    else inline.push(node)
  }
  const space = { type: "text", text: " " }
  blocks.forEach((block, index) => {
    if (index > 0) push(space)
    if (!isRecord(block) || !Array.isArray(block.content)) return
    for (const node of block.content) {
      if (!isRecord(node)) continue
      if (node.type === "hardBreak") push(space)
      else if (node.type === "text" && typeof node.text === "string")
        push({ ...node, text: node.text.replace(/\r\n|\r|\n/g, " ") })
      else push(node)
    }
  })
  return stableSerialize({
    type: "doc",
    content: [
      { type: "paragraph", ...(inline.length ? { content: inline } : {}) },
    ],
  })
}

function plainTextDoc(value: string): string {
  return flattenTitleDoc({
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(value ? { content: [{ type: "text", text: value }] } : {}),
      },
    ],
  })
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
