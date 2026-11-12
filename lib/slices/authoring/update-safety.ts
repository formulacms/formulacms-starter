import { resolveFieldContract } from "../../../convex/lib/richtext/contracts"
import { diffSliceSpecs, type SpecFieldChange } from "./spec-diff"
import type { FieldSpec, SliceSpec } from "./scaffold"
import { isRegisteredTitleMigration } from "./title-migrations"

export type SliceUpdateBlockerCode =
  | "removed-field"
  | "kind-change"
  | "required-addition"
  | "optional-to-required"
  | "removed-select-option"
  | "narrowed-rich-text-profile"

export type SliceUpdateBlocker = {
  code: SliceUpdateBlockerCode
  path: string
  summary: string
  operationMessage: string
}

export type SliceUpdateSafety = {
  changes: SpecFieldChange[]
  compatibleChanges: SpecFieldChange[]
  blockers: SliceUpdateBlocker[]
}

type FlatField = {
  kind: string
  optional: boolean
  profile?: "title" | "inline" | "basic" | "full"
  headingRole?: string
  headingParent?: string
  options?: string[]
}

const PROFILE_ORDER = {
  title: -1,
  inline: 0,
  basic: 1,
  full: 2,
} as const

function flattenFieldSpec(
  field: FieldSpec,
  path: string,
  out: Map<string, FlatField>
): void {
  const row: FlatField = {
    kind: field.kind,
    optional: field.optional === true,
  }
  if (field.kind === "richText") {
    row.profile = resolveFieldContract(field.config).contract
    row.headingRole = field.config.heading?.role
    row.headingParent = field.config.heading?.parent
  }
  if (field.kind === "select") row.options = field.config.options
  out.set(path, row)

  if (field.kind === "group") {
    for (const [key, child] of Object.entries(field.fields)) {
      flattenFieldSpec(child, `${path}.${key}`, out)
    }
  }
  if (field.kind === "list") {
    flattenFieldSpec(field.item, `${path}[]`, out)
  }
}

function flattenSliceSpec(spec: SliceSpec): Map<string, FlatField> {
  const fields = new Map<string, FlatField>()
  for (const [key, field] of Object.entries(spec.primary.fields)) {
    flattenFieldSpec(field, `primary.${key}`, fields)
  }
  if (spec.items) {
    flattenFieldSpec(spec.items.item, "item", fields)
  }
  return fields
}

function toDiffPath(path: string): string {
  const rooted =
    path === "item" || path.startsWith("item.") ? `items.${path}` : path
  return rooted.replaceAll("[]", ".item")
}

export function getSliceUpdateBlockersForPath(
  blockers: SliceUpdateBlocker[],
  changePath: string
): SliceUpdateBlocker[] {
  return blockers.filter((blocker) => {
    const blockerPath = toDiffPath(blocker.path)
    return (
      blockerPath === changePath ||
      blockerPath.startsWith(`${changePath}.`) ||
      changePath.startsWith(`${blockerPath}.`)
    )
  })
}

/**
 * Compare two Slice models against the compatibility rules that apply when at
 * least one saved, staged or retained publication instance exists. This is explanatory on the
 * client; updateSliceType remains the enforcing boundary.
 */
export function analyzeSliceUpdate(
  prev: SliceSpec,
  next: SliceSpec
): SliceUpdateSafety {
  const before = flattenSliceSpec(prev)
  const after = flattenSliceSpec(next)
  const addedPaths = [...after.keys()].filter((path) => !before.has(path))
  const blockers: SliceUpdateBlocker[] = []

  for (const path of before.keys()) {
    if (!after.has(path)) {
      blockers.push({
        code: "removed-field",
        path,
        summary: `Removed field “${path}”.`,
        operationMessage: `cannot remove field "${path}" while the block is in use`,
      })
    }
  }

  for (const [path, prevField] of before) {
    const nextField = after.get(path)
    if (!nextField) continue

    const titleMigration =
      prev.type === next.type &&
      isRegisteredTitleMigration(next.type, path, prevField, nextField)
    if (prevField.kind !== nextField.kind && !titleMigration) {
      blockers.push({
        code: "kind-change",
        path,
        summary: `Changed “${path}” from ${prevField.kind} to ${nextField.kind}.`,
        operationMessage: `cannot change field "${path}" from ${prevField.kind} to ${nextField.kind} while the block is in use`,
      })
      continue
    }

    if (prevField.optional && !nextField.optional) {
      blockers.push({
        code: "optional-to-required",
        path,
        summary: `Made optional field “${path}” required.`,
        operationMessage: `cannot make optional field "${path}" required`,
      })
    }

    if (prevField.kind === "select") {
      const nextOptions = new Set(nextField.options ?? [])
      for (const option of prevField.options ?? []) {
        if (!nextOptions.has(option)) {
          blockers.push({
            code: "removed-select-option",
            path,
            summary: `Removed choice “${option}” from “${path}”.`,
            operationMessage: `cannot remove select option "${option}" from "${path}"`,
          })
        }
      }
    }

    if (
      prevField.kind === "richText" &&
      prevField.profile &&
      nextField.profile &&
      PROFILE_ORDER[nextField.profile] < PROFILE_ORDER[prevField.profile] &&
      !titleMigration
    ) {
      blockers.push({
        code: "narrowed-rich-text-profile",
        path,
        summary: `Narrowed formatted text “${path}” from ${prevField.profile} to ${nextField.profile}.`,
        operationMessage: `cannot narrow richText profile for "${path}" from ${prevField.profile} to ${nextField.profile}`,
      })
    }
  }

  for (const path of addedPaths) {
    if (!after.get(path)?.optional) {
      blockers.push({
        code: "required-addition",
        path,
        summary: `Added required field “${path}”.`,
        operationMessage: `new field "${path}" must be optional while the block is in use`,
      })
    }
  }

  const changes = diffSliceSpecs(prev, next)
  const compatibleChanges = changes.filter(
    (change) =>
      getSliceUpdateBlockersForPath(blockers, change.path).length === 0
  )

  return { changes, compatibleChanges, blockers }
}
