import { getSchema, type JSONContent } from "@tiptap/core"
import { Node as PMNode } from "@tiptap/pm/model"
import {
  readSliceDefinition,
  type Slice,
  type Primitive,
} from "@/convex/lib/slices"
import { walkValue } from "@/convex/lib/slices/walk"
import { isEditorialTextPrimitive } from "@/convex/lib/slices/primitives"
import {
  resolveFieldContract,
  type FieldContract,
  type RichTextContractConfig,
} from "@/convex/lib/richtext/contracts"
import { validateDoc } from "@/convex/lib/richtext/profiles"
import { extensionsForContract } from "@/lib/rich-text/extensions"
import { richTextToDocument } from "@/lib/rich-text/render"
import { normalizePreviewInlineDocument } from "@/components/admin/preview-inline-document"

export type SampleField = {
  path: string
  contract: FieldContract | "plain"
  value: string
}
export type SampleValues = Record<string, string>
export type SampleSelection = { path: string; from: number; to: number } | null
export const canonicalSamplePath = (path: string) =>
  path.replace(/\[(\d+)\]/g, ".$1")
const CURATED = new Set([
  "hero-agency",
  "hero-with-image",
  "features-icon-grid",
  "faq-simple",
  "rich-text-body",
])

/** The descriptor owns the contract. No simulator schema or display sidecar. */
export function sampleFields(slice: Slice): SampleField[] {
  if (!CURATED.has(slice.type)) return []
  const def = readSliceDefinition(slice.type) as {
    primary: Primitive
    items?: Primitive
  }
  const result: SampleField[] = []
  const visit = ({
    def,
    value,
    path,
    key,
  }: Parameters<typeof walkValue>[2] extends (arg: infer A) => void
    ? A
    : never) => {
    if (
      result.length >= 10 ||
      typeof value !== "string" ||
      key === "icon" ||
      !isEditorialTextPrimitive(def)
    )
      return
    if (def.kind === "text")
      result.push({ path: canonicalSamplePath(path), contract: "plain", value })
    if (def.kind === "richText")
      result.push({
        path: canonicalSamplePath(path),
        contract: resolveFieldContract(def.config as RichTextContractConfig)
          .contract,
        value,
      })
  }
  walkValue(def.primary, slice.primary, visit, "primary")
  if (def.items)
    walkValue(def.items, (slice as { items?: unknown }).items, visit, "items")
  return result
}

const NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "text",
  "hardBreak",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
])
function canonicalNode(node: JSONContent): boolean {
  if (!node || typeof node !== "object" || !NODE_TYPES.has(node.type ?? ""))
    return false
  if (
    Object.keys(node).some(
      (key) => !["type", "content", "text", "attrs", "marks"].includes(key)
    )
  )
    return false
  if (
    node.attrs &&
    Object.keys(node.attrs).some(
      (key) =>
        !(node.type === "heading" && key === "level") &&
        !(node.type === "orderedList" && ["start", "type"].includes(key)) &&
        !(node.type === "codeBlock" && key === "language")
    )
  )
    return false
  if (
    node.marks?.some((mark) =>
      Object.keys(mark).some((key) => !["type", "attrs"].includes(key))
    )
  )
    return false
  if (
    node.marks?.some(
      (mark) =>
        mark.attrs &&
        Object.keys(mark.attrs).some(
          (key) =>
            ![
              "href",
              "target",
              "rel",
              "class",
              "pageId",
              "noFollow",
              "sponsored",
              "ugc",
              "color",
            ].includes(key) ||
            (key === "class" && mark.attrs?.[key] !== null)
        )
    )
  )
    return false
  return (
    (!node.content ||
      (Array.isArray(node.content) && node.content.every(canonicalNode))) &&
    (!node.marks || Array.isArray(node.marks))
  )
}
export function validSampleValue(
  field: SampleField,
  value: unknown
): value is string {
  if (typeof value !== "string") return false
  if (field.contract === "plain") return true
  try {
    const doc = JSON.parse(value) as JSONContent
    if (
      doc?.type !== "doc" ||
      !Array.isArray(doc.content) ||
      !canonicalNode(doc)
    )
      return false
    if (field.contract !== "title" && !validateDoc(value, field.contract).ok)
      return false
    PMNode.fromJSON(
      getSchema(extensionsForContract(field.contract)),
      doc
    ).check()
    return true
  } catch {
    return false
  }
}

/** Compare what the native editor displays, including schema attribute defaults. */
export function canonicalSampleValue(
  field: SampleField,
  value: string
): string | null {
  if (field.contract === "plain") return value
  try {
    const parsed = richTextToDocument(
      value,
      field.contract === "title" ? "inline" : field.contract
    )
    const document =
      field.contract === "inline" || field.contract === "title"
        ? normalizePreviewInlineDocument(parsed, field.contract)
        : parsed
    const schema = getSchema(extensionsForContract(field.contract))
    const node = PMNode.fromJSON(schema, document)
    const filled = schema.topNodeType.createAndFill(undefined, node.content)
    if (!filled) return null
    filled.check()
    return JSON.stringify(filled.toJSON())
  } catch {
    return null
  }
}

/** Stamp stable real item IDs before editing value-derived renderer keys. */
export function projectSamples<T extends Slice>(
  seed: T,
  values: SampleValues
): T {
  const next = structuredClone(seed)
  const rows = (next as { items?: Array<Record<string, unknown>> }).items
  rows?.forEach((row, index) => {
    row.itemId ??= `sim:${seed.id}:${index}`
  })
  for (const field of sampleFields(seed)) {
    const value = values[field.path]
    if (value === undefined || !validSampleValue(field, value)) continue
    const parts = field.path.split(".")
    let bag: Record<string, unknown> = next as unknown as Record<
      string,
      unknown
    >
    for (const part of parts.slice(0, -1))
      bag = bag[part] as Record<string, unknown>
    bag[parts.at(-1)!] = value
  }
  return next
}
export const sampleStorageKey = (
  type: string,
  presentation: string,
  locale: string,
  preset: string
) =>
  `formulacms:sim-samples:v1:${[type, presentation, locale, preset].map(encodeURIComponent).join(":")}`
export function readSampleStorage(
  storage: Pick<Storage, "getItem">,
  key: string,
  fields: SampleField[]
): SampleValues {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {}
    const entries = Object.entries(parsed)
    if (
      entries.length > 10 ||
      entries.some(
        ([path, value]) =>
          !fields.some(
            (field) => field.path === path && validSampleValue(field, value)
          )
      )
    )
      return {}
    return Object.fromEntries(entries) as SampleValues
  } catch {
    return {}
  }
}
export function writeSampleStorage(
  storage: Pick<Storage, "setItem">,
  key: string,
  values: SampleValues,
  fields: SampleField[]
): boolean {
  if (
    Object.keys(values).length > 10 ||
    Object.entries(values).some(
      ([path, value]) =>
        !fields.some(
          (field) => field.path === path && validSampleValue(field, value)
        )
    )
  )
    return false
  try {
    storage.setItem(key, JSON.stringify(values))
    return true
  } catch {
    return false
  }
}
