import {
  contractSpec,
  resolveFieldContract,
  type FieldContract,
  type ResolvedFieldContract,
} from "./contracts"
import { validateDoc } from "./profiles"
import { toFieldShape } from "./shape"

type JsonRecord = Record<string, unknown>

export type StrictValidation = { ok: true } | { ok: false; error: string }

export function validateStrict(
  contract: FieldContract | ResolvedFieldContract,
  json: string
): StrictValidation {
  const name: FieldContract =
    typeof contract === "string" ? contract : contract.contract
  let root: unknown
  try {
    root = JSON.parse(json)
  } catch {
    return { ok: false, error: "Rich-text JSON is malformed" }
  }
  if (!isRecord(root) || root.type !== "doc") {
    return { ok: false, error: "Rich-text value must be a doc" }
  }
  const spec = contractSpec(name)
  if (name !== "title") {
    const nameCheck = validateDoc(json, name)
    if (!nameCheck.ok) return nameCheck
  }
  const content = root.content
  if (!Array.isArray(content))
    return { ok: false, error: "doc.content must be an array" }
  if (content.length === 0)
    return { ok: false, error: "doc must contain a block" }

  if (name === "title") {
    if (
      content.length !== 1 ||
      !isRecord(content[0]) ||
      content[0].type !== "heading"
    ) {
      return { ok: false, error: "title must contain exactly one heading" }
    }
  } else if (name === "inline") {
    if (content.some((node) => !isRecord(node) || node.type !== "paragraph")) {
      return {
        ok: false,
        error: "inline documents contain paragraph blocks only",
      }
    }
  }

  const pending: Array<{ node: unknown; parent?: string }> = []
  for (const node of content) pending.push({ node, parent: "doc" })
  while (pending.length) {
    const { node, parent } = pending.pop()!
    if (!isRecord(node) || typeof node.type !== "string") {
      return { ok: false, error: "node must have a string type" }
    }
    const type = node.type
    if (name === "title" && type === "hardBreak")
      return { ok: false, error: "a title is one line and has no line break" }
    if (!spec.nodes.has(type))
      return { ok: false, error: `node "${type}" is not allowed` }
    const children = node.content
    if (children !== undefined && !Array.isArray(children)) {
      return { ok: false, error: `${type}.content must be an array` }
    }
    const list = Array.isArray(children) ? children : []
    if (type === "text") {
      if (typeof node.text !== "string" || node.text.length === 0) {
        return { ok: false, error: "text nodes must have nonempty text" }
      }
      if (name === "title" && /[\r\n]/.test(node.text))
        return { ok: false, error: "a title is one line and has no line break" }
      if (list.length)
        return { ok: false, error: "text nodes cannot have content" }
    }
    if (
      ["hardBreak", "image", "horizontalRule"].includes(type) &&
      list.length
    ) {
      return { ok: false, error: `${type} cannot have content` }
    }
    if (type === "heading" && !isAllowedHeadingLevel(name, node)) {
      return { ok: false, error: "heading level is outside the contract range" }
    }
    if (
      type === "orderedList" &&
      !optionalPositiveInteger(node.attrs, "start")
    ) {
      return {
        ok: false,
        error: "ordered list start must be a positive integer when present",
      }
    }
    if (
      (type === "tableCell" || type === "tableHeader") &&
      !validSpans(node.attrs)
    ) {
      return {
        ok: false,
        error: "table cell spans must be positive integers when present",
      }
    }
    if (type === "image") {
      const attrs = isRecord(node.attrs) ? node.attrs : undefined
      if (typeof attrs?.src !== "string")
        return { ok: false, error: "image src must be a string" }
    }
    if (
      type === "codeBlock" &&
      list.some(
        (child) =>
          isRecord(child) && Array.isArray(child.marks) && child.marks.length
      )
    ) {
      return { ok: false, error: "code block text cannot carry marks" }
    }
    if (node.marks !== undefined && !Array.isArray(node.marks)) {
      return { ok: false, error: "node marks must be an array" }
    }
    if (Array.isArray(node.marks)) {
      if (type !== "text" && type !== "hardBreak") {
        return {
          ok: false,
          error: "marks may only be attached to inline nodes",
        }
      }
      for (const mark of node.marks) {
        if (
          !isRecord(mark) ||
          typeof mark.type !== "string" ||
          !spec.marks.has(mark.type)
        ) {
          return { ok: false, error: "mark is not allowed by the contract" }
        }
        if (mark.type === "link") {
          const attrs = isRecord(mark.attrs) ? mark.attrs : {}
          if (
            typeof attrs.href !== "string" &&
            typeof attrs.pageId !== "string"
          ) {
            return { ok: false, error: "link requires a string href or pageId" }
          }
        }
      }
    }
    if (!validParent(type, parent))
      return { ok: false, error: `${type} is invalid inside ${parent}` }
    for (const child of list) pending.push({ node: child, parent: type })
    const childError = validateChildren(type, list)
    if (childError) return { ok: false, error: childError }
  }
  return { ok: true }
}

/** Legacy reads convert a copy first, then use the established lenient name check. */
export function validateLegacy(
  contract: FieldContract | ResolvedFieldContract,
  value: string
): StrictValidation {
  const resolved = typeof contract === "string" ? undefined : contract
  const name: FieldContract =
    typeof contract === "string" ? contract : contract.contract
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: true }
  }
  if (!isRecord(parsed) || parsed.type !== "doc") return { ok: true }
  if (
    name === "title" &&
    Array.isArray(parsed.content) &&
    parsed.content.some((node) => isRecord(node) && node.type === "heading") &&
    !(
      parsed.content.length === 1 &&
      isRecord(parsed.content[0]) &&
      parsed.content[0].type === "heading"
    )
  ) {
    return { ok: false, error: "title input must have one heading wrapper" }
  }
  const config = resolved ?? resolveFieldContract(name)
  const shaped = toFieldShape(config, value).value
  let shapedDoc: unknown
  try {
    shapedDoc = JSON.parse(shaped)
  } catch {
    return { ok: true }
  }
  if (!isRecord(shapedDoc) || shapedDoc.type !== "doc") return { ok: true }
  if (name === "title") return validateLegacyTitleNames(shapedDoc)
  return validateDoc(shaped, name)
}

/** Title legacy reads enforce the title wrapper and allowlists without applying
 * the stricter canonical-write grammar, cardinality, or attribute checks. */
function validateLegacyTitleNames(root: unknown): StrictValidation {
  const spec = contractSpec("title")
  if (!isRecord(root) || root.type !== "doc" || !Array.isArray(root.content)) {
    return { ok: false, error: "title must be wrapped in a doc" }
  }
  if (
    root.content.length !== 1 ||
    !isRecord(root.content[0]) ||
    root.content[0].type !== "heading"
  ) {
    return { ok: false, error: "title must contain one heading wrapper" }
  }
  const pending: Array<{ node: unknown; parent: string }> = []
  for (const node of root.content) pending.push({ node, parent: "doc" })
  while (pending.length) {
    const { node, parent } = pending.pop()!
    if (
      !isRecord(node) ||
      typeof node.type !== "string" ||
      !spec.nodes.has(node.type)
    ) {
      return { ok: false, error: "title contains a disallowed node" }
    }
    if (parent === "doc" && node.type !== "heading") {
      return { ok: false, error: "title doc must use heading wrappers" }
    }
    if (node.marks !== undefined) {
      if (!Array.isArray(node.marks))
        return { ok: false, error: "title marks must be an array" }
      for (const mark of node.marks) {
        if (
          !isRecord(mark) ||
          typeof mark.type !== "string" ||
          !spec.marks.has(mark.type)
        ) {
          return { ok: false, error: "title contains a disallowed mark" }
        }
      }
    }
    if (node.content !== undefined && !Array.isArray(node.content)) {
      return { ok: false, error: "title content must be an array when present" }
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content)
        pending.push({ node: child, parent: node.type })
    }
  }
  return { ok: true }
}

function validateChildren(type: string, children: unknown[]): string | null {
  const kinds = children.map((child) =>
    isRecord(child) ? child.type : undefined
  )
  const all = (allowed: string[]) =>
    kinds.every((kind) => typeof kind === "string" && allowed.includes(kind))
  if (
    (type === "paragraph" || type === "heading") &&
    !all(["text", "hardBreak"])
  )
    return `${type} accepts inline content only`
  if (
    (type === "bulletList" || type === "orderedList") &&
    (children.length === 0 || !all(["listItem"]))
  )
    return `${type} requires listItem children`
  if (
    type === "listItem" &&
    (children.length === 0 ||
      kinds[0] !== "paragraph" ||
      kinds
        .slice(1)
        .some((kind) => typeof kind !== "string" || !blockTypes.includes(kind)))
  )
    return "listItem starts with a paragraph and then accepts blocks"
  if (type === "blockquote" && (children.length === 0 || !all(blockTypes)))
    return "blockquote requires block children"
  if (type === "codeBlock" && !all(["text"]))
    return "codeBlock accepts text only"
  if (type === "table" && (children.length === 0 || !all(["tableRow"])))
    return "table requires tableRow children"
  if (
    type === "tableRow" &&
    (children.length === 0 || !all(["tableCell", "tableHeader"]))
  )
    return "tableRow requires cells"
  if (
    (type === "tableCell" || type === "tableHeader") &&
    (children.length === 0 || !all(blockTypes))
  )
    return `${type} requires block children`
  return null
}

const blockTypes = [
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "image",
  "table",
]

function validParent(type: string, parent?: string): boolean {
  if (parent === "doc") return blockTypes.includes(type)
  if (parent === "paragraph" || parent === "heading")
    return type === "text" || type === "hardBreak"
  if (parent === "bulletList" || parent === "orderedList")
    return type === "listItem"
  if (parent === "listItem") return blockTypes.includes(type)
  if (
    parent === "blockquote" ||
    parent === "tableCell" ||
    parent === "tableHeader"
  )
    return blockTypes.includes(type)
  if (parent === "table") return type === "tableRow"
  if (parent === "tableRow")
    return type === "tableCell" || type === "tableHeader"
  if (parent === "codeBlock") return type === "text"
  return false
}

function isAllowedHeadingLevel(
  contract: FieldContract,
  node: JsonRecord
): boolean {
  const attrs = isRecord(node.attrs) ? node.attrs : undefined
  const level = attrs?.level
  if (!Number.isInteger(level)) return false
  if (contract === "title")
    return contractSpec("title").headingLevels.has(level as number)
  return contractSpec(contract).headingLevels.has(level as number)
}

function optionalPositiveInteger(attrs: unknown, key: string): boolean {
  if (!isRecord(attrs) || attrs[key] === undefined || attrs[key] === null)
    return true
  return Number.isInteger(attrs[key]) && (attrs[key] as number) > 0
}

function validSpans(attrs: unknown): boolean {
  return (
    optionalPositiveInteger(attrs, "colspan") &&
    optionalPositiveInteger(attrs, "rowspan")
  )
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
