import type { FieldContract } from "@/convex/lib/richtext/contracts"
import {
  normalizeFieldPath,
  resolveFieldContract,
} from "@/convex/lib/richtext/contracts"
import { primaryListFields } from "@/convex/lib/slices/repeating"
import type { FieldSpec, SliceSpec } from "./scaffold"
import { specToPrimitive } from "./scaffold"

type FieldLocation = { path: string; field: FieldSpec }

function normalizedParent(path: string): string {
  return normalizeFieldPath(path.replace(/\[(?:[^\]]*)\]/g, "")).replace(
    /\[\]/g,
    ""
  )
}

function collectFields(
  field: FieldSpec,
  path: string,
  output: FieldLocation[]
): void {
  output.push({ path, field })
  if (field.kind === "group") {
    for (const [name, child] of Object.entries(field.fields)) {
      collectFields(child, `${path}.${name}`, output)
    }
  } else if (field.kind === "list") {
    collectFields(field.item, `${path}[]`, output)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertNoAs(field: FieldSpec, path: string): void {
  const raw = field as unknown as Record<string, unknown>
  if (Object.hasOwn(raw, "as")) {
    throw new Error(
      `${path}.as is not supported; use a rich-text heading contract.`
    )
  }
  if (isRecord(raw.config) && Object.hasOwn(raw.config, "as")) {
    throw new Error(
      `${path}.config.as is not supported; use a rich-text heading contract.`
    )
  }
  if (field.kind === "group") {
    for (const [name, child] of Object.entries(field.fields)) {
      assertNoAs(child, `${path}.${name}`)
    }
  } else if (field.kind === "list") {
    assertNoAs(field.item, `${path}[]`)
  }
}

function fieldContract(field: FieldSpec): FieldContract | undefined {
  if (field.kind !== "richText") return undefined
  return resolveFieldContract(field.config).contract
}

/** Admission policy for new authored Slice Types. Existing readers and tweaks
 * continue to accept legacy `items` specs through the parser and scaffolder. */
export function assertNewSlicePolicy(spec: SliceSpec): void {
  if (spec.items) {
    throw new Error(
      'New Slice Types cannot use top-level "items". Add a named repeating list under "primary" (for example primary.ctas) instead.'
    )
  }

  const locations: FieldLocation[] = []
  for (const [name, field] of Object.entries(spec.primary.fields)) {
    collectFields(field, `primary.${name}`, locations)
    assertNoAs(field, `primary.${name}`)
  }

  const titlePaths = new Set(
    locations
      .filter(({ field }) => fieldContract(field) === "title")
      .map(({ path }) => normalizedParent(path))
  )

  for (const { path, field } of locations) {
    if (field.kind !== "richText") continue
    const contract = fieldContract(field)
    const config = field.config as Record<string, unknown>
    const heading = isRecord(config.heading) ? config.heading : undefined
    const role = heading?.role
    if (contract === "title") {
      if (role !== "sliceTitle" && role !== "itemTitle") {
        throw new Error(
          `${path} uses the title contract and must declare heading.role as "sliceTitle" or "itemTitle".`
        )
      }
    } else if (heading !== undefined) {
      throw new Error(
        `${path} declares a heading role but is not a title field.`
      )
    }

    if (contract === "basic" || contract === "full") {
      const floor = isRecord(config.headingFloor)
        ? config.headingFloor.parent
        : undefined
      if (typeof floor !== "string" || floor.trim() === "") {
        throw new Error(
          `${path} uses the ${contract} body contract and must declare headingFloor.parent.`
        )
      }
    }

    for (const parent of [
      typeof heading?.parent === "string" ? heading.parent : undefined,
      isRecord(config.headingFloor) &&
      typeof config.headingFloor.parent === "string"
        ? config.headingFloor.parent
        : undefined,
    ]) {
      if (parent === undefined) continue
      if (!titlePaths.has(normalizedParent(parent))) {
        throw new Error(
          `${path} heading parent "${parent}" must resolve to a title field in this Slice Type.`
        )
      }
    }
  }

  const primary = specToPrimitive(spec.primary)
  const lists = primaryListFields(primary)
  const namedLists = lists.filter(({ path }) => !path.includes("[]"))
  if (namedLists.length > 4) {
    throw new Error("New Slice Types support at most 4 named primary lists.")
  }
  for (const { path, definition } of lists) {
    const depth = (path.match(/\[\]/g) ?? []).length + 1
    if (depth > 2) {
      throw new Error(`${path} exceeds the supported 2 primary-list levels.`)
    }
    const max = definition.config.max as number | undefined
    if (max !== undefined && max > 24) {
      throw new Error(
        `${path} exceeds the supported 24-row primary-list limit.`
      )
    }
  }
}
