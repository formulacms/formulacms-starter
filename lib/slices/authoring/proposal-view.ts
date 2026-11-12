import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import type { FieldSpec } from "./scaffold"

export type SliceProposalField = {
  path: string
  kind: string
  optional: boolean
  depth: number
}

export type SliceProposalView = {
  type: string
  label: string
  group: string
  purpose: string
  primaryFields: SliceProposalField[]
  itemFields: SliceProposalField[]
  itemBounds: string | null
}

type ProposalShape = {
  type: string
  label: string
  description: string
  group: string
  primary: Extract<FieldSpec, { kind: "group" }>
  items?: { item: FieldSpec; min?: number; max?: number }
  aiHint?: { purpose?: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readProposalShape(specJson: string): ProposalShape {
  let raw: unknown
  try {
    raw = JSON.parse(specJson)
  } catch {
    throw new Error("The generated proposal is not a reviewable SliceSpec.")
  }

  if (
    !isRecord(raw) ||
    typeof raw.type !== "string" ||
    typeof raw.label !== "string" ||
    typeof raw.description !== "string" ||
    typeof raw.group !== "string" ||
    !isRecord(raw.primary) ||
    raw.primary.kind !== "group" ||
    !isRecord(raw.primary.fields)
  ) {
    throw new Error("The generated proposal is not a reviewable SliceSpec.")
  }

  return raw as ProposalShape
}

function describeKind(field: FieldSpec): string {
  if (field.kind === "richText") {
    return `richText (${resolveFieldContract(field.config).contract})`
  }
  if (field.kind === "ref") return `ref (${field.ref})`
  return field.kind
}

function flattenField(
  field: FieldSpec,
  path: string,
  depth: number,
  rows: SliceProposalField[]
) {
  rows.push({
    path,
    kind: describeKind(field),
    optional: field.optional === true,
    depth,
  })

  if (field.kind === "group") {
    for (const [name, child] of Object.entries(field.fields)) {
      flattenField(child, `${path}.${name}`, depth + 1, rows)
    }
  } else if (field.kind === "list") {
    flattenField(field.item, `${path}[]`, depth + 1, rows)
  }
}

function itemBounds(items: ProposalShape["items"]): string | null {
  if (!items) return null
  if (items.min !== undefined && items.max !== undefined) {
    return `${items.min}–${items.max} items`
  }
  if (items.min !== undefined) return `At least ${items.min} items`
  if (items.max !== undefined) return `Up to ${items.max} items`
  return "Repeatable items"
}

export function parseSliceProposalView(specJson: string): SliceProposalView {
  const spec = readProposalShape(specJson)
  const primaryFields: SliceProposalField[] = []
  const itemFields: SliceProposalField[] = []

  for (const [name, field] of Object.entries(spec.primary.fields)) {
    flattenField(field, name, 0, primaryFields)
  }
  if (spec.items) flattenField(spec.items.item, "item", 0, itemFields)

  return {
    type: spec.type,
    label: spec.label,
    group: spec.group,
    purpose: spec.aiHint?.purpose?.trim() || spec.description,
    primaryFields,
    itemFields,
    itemBounds: itemBounds(spec.items),
  }
}
