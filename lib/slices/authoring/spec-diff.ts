import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import type { FieldSpec, SliceSpec } from "./scaffold"

export type SpecFieldChange = {
  path: string
  change: "added" | "removed" | "modified"
  before?: string
  after?: string
}

type FlatSpec = Map<string, string>

export function diffSliceSpecs(
  prev: SliceSpec,
  next: SliceSpec
): SpecFieldChange[] {
  const before = flattenSpec(prev)
  const after = flattenSpec(next)
  const changes: SpecFieldChange[] = []
  const paths = Array.from(new Set([...before.keys(), ...after.keys()])).sort()

  for (const path of paths) {
    const prevSummary = before.get(path)
    const nextSummary = after.get(path)
    if (prevSummary === nextSummary) continue
    if (path.endsWith(".[field-order]")) {
      // Add/remove rows already describe changed keys. Report ordering when
      // retained definitions change relative order, including mixed edits.
      if (prevSummary === undefined || nextSummary === undefined) continue
      const prevKeys = JSON.parse(prevSummary) as string[]
      const nextKeys = JSON.parse(nextSummary) as string[]
      if (
        JSON.stringify(prevKeys.filter((key) => nextKeys.includes(key))) ===
        JSON.stringify(nextKeys.filter((key) => prevKeys.includes(key)))
      )
        continue
    }

    if (prevSummary === undefined) {
      changes.push({ path, change: "added", after: nextSummary })
    } else if (nextSummary === undefined) {
      changes.push({ path, change: "removed", before: prevSummary })
    } else {
      changes.push({
        path,
        change: "modified",
        before: prevSummary,
        after: nextSummary,
      })
    }
  }

  return changes
}

function flattenSpec(spec: SliceSpec): FlatSpec {
  const fields: FlatSpec = new Map()
  addMeta(fields, "meta.label", spec.label)
  addMeta(fields, "meta.description", spec.description)
  addMeta(fields, "meta.icon", spec.icon)
  addMeta(fields, "meta.group", spec.group)
  addMeta(fields, "meta.aiHint.purpose", spec.aiHint?.purpose)
  addValue(fields, "meta.aiHint.fields", spec.aiHint?.fields)
  addValue(fields, "preview.primary", spec.preview?.primary)
  addValue(fields, "preview.items", spec.preview?.items)
  if (spec.primary.optional) addValue(fields, "primary.optional", true)

  flattenField(fields, "primary", spec.primary, { skipCurrentGroup: true })
  if (spec.items) {
    fields.set("items", summarizeList(spec.items))
    flattenField(fields, "items.item", spec.items.item)
  }

  return fields
}

function addMeta(fields: FlatSpec, path: string, value: string | undefined) {
  if (value !== undefined) fields.set(path, value)
}

/** Preserve array order and exact values while ignoring object-key ordering. */
function summarizeValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  )
}

function addValue(fields: FlatSpec, path: string, value: unknown) {
  if (value !== undefined) fields.set(path, summarizeValue(value))
}

function flattenField(
  fields: FlatSpec,
  path: string,
  field: FieldSpec,
  options: { skipCurrentGroup?: boolean } = {}
) {
  if (field.kind === "group") {
    if (!options.skipCurrentGroup) fields.set(path, summarizeField(field))
    // Brackets cannot be a validated field identifier, so this review-only
    // path cannot collide with a real field named "fields" or "$fieldOrder".
    fields.set(
      `${path}.[field-order]`,
      JSON.stringify(Object.keys(field.fields))
    )
    for (const [key, child] of Object.entries(field.fields)) {
      flattenField(fields, `${path}.${key}`, child)
    }
    return
  }

  fields.set(path, summarizeField(field))

  if (field.kind === "list") {
    flattenField(fields, `${path}.item`, field.item)
  }
}

function summarizeField(field: FieldSpec): string {
  const parts = [field.kind, summarizeConfig(field)].filter(Boolean)
  if ("optional" in field && field.optional) parts.push("optional")
  return parts.join(", ")
}

function summarizeList(items: NonNullable<SliceSpec["items"]>): string {
  return ["list", summarizeMinMax(items)].filter(Boolean).join(", ")
}

function summarizeConfig(field: FieldSpec): string | undefined {
  let summary: string | undefined
  let represented: string[] = []
  switch (field.kind) {
    case "richText":
      summary = resolveFieldContract(field.config).contract
      represented = ["contract", "profile"]
      break
    case "select":
      summary = `options: ${summarizeValue(field.config.options)}`
      represented = ["options"]
      break
    case "relation":
      summary = `pageTypes: ${field.config.pageTypes.join(", ")}`
      represented = ["pageTypes"]
      break
    case "list":
      summary = summarizeMinMax(field.config)
      represented = ["min", "max"]
      break
    case "ref":
      return field.ref
  }
  const extras =
    "config" in field && field.config
      ? Object.entries(field.config)
          .filter(
            ([key, value]) => value !== undefined && !represented.includes(key)
          )
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}: ${summarizeValue(value)}`)
      : []
  return [summary, ...extras].filter(Boolean).join(", ") || undefined
}

function summarizeMinMax(
  config: { min?: number; max?: number } | undefined
): string | undefined {
  if (!config) return undefined
  const parts = [
    typeof config.min === "number" ? `min ${config.min}` : undefined,
    typeof config.max === "number" ? `max ${config.max}` : undefined,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(", ") : undefined
}
