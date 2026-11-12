import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { type Primitive, type Slice } from "@/convex/lib/slices"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"

export type RepeatedItemAncestor = {
  listPath: string
  itemIndex: number
  itemFingerprint: string
}

export type RepeatedItemTarget = {
  itemIndex: number
  itemFingerprint: string
  contentEpoch: number
  listPath?: string
  ancestors?: RepeatedItemAncestor[]
}

export type RepeatedTargetMatchOptions = {
  fieldPath?: string
  maskField?: boolean
  allowDeepestRefresh?: boolean
}

type Row = {
  listPath: string
  itemIndex: number
  value: unknown
  pathIndex: number
}

function validRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function fingerprint(row: Row, path: string[], mask: boolean): string | null {
  const value = mask
    ? setValueAtFieldPath(row.value, path.slice(row.pathIndex + 1), null)
    : row.value
  try {
    const encoded = JSON.stringify(value)
    return typeof encoded === "string" ? encoded : null
  } catch {
    return null
  }
}

/** Resolve a transient repeated-row identity from the installed descriptor and value. */
export function repeatedItemIdentity(
  slice: Slice,
  fieldPath: string,
  contentEpoch: number,
  options: { maskField?: boolean } = {}
): RepeatedItemTarget | undefined | null {
  if (!Number.isSafeInteger(contentEpoch) || contentEpoch < 0) return null
  const path = parseFieldPath(fieldPath)
  if (
    !fieldPath ||
    path.join(".") !== fieldPath ||
    (path[0] !== "primary" && path[0] !== "items") ||
    path.some(
      (part) =>
        !part ||
        part === "__proto__" ||
        part === "constructor" ||
        part === "prototype"
    )
  )
    return null

  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return null
  let descriptor: Primitive | undefined =
    path[0] === "primary"
      ? def.primary
      : def.items !== undefined
        ? def.items
        : undefined
  let value: unknown =
    path[0] === "primary"
      ? readSlice(slice).primary
      : "items" in slice
        ? readSlice(slice).items
        : undefined
  const rows: Row[] = []
  const consumed: string[] = [path[0]]

  for (let index = 1; index < path.length; index++) {
    const segment = path[index]
    if (!descriptor) return null
    if (descriptor.kind === "group") {
      const fields = descriptor.config.fields as Record<string, Primitive>
      if (!Object.hasOwn(fields, segment) || !validRecord(value)) return null
      descriptor = fields[segment]
      if (!Object.hasOwn(value, segment)) return null
      value = value[segment]
      consumed.push(segment)
      continue
    }
    if (descriptor.kind === "list") {
      if (!/^(0|[1-9]\d*)$/.test(segment)) return null
      const itemIndex = Number(segment)
      if (!Number.isSafeInteger(itemIndex) || !Array.isArray(value)) return null
      if (itemIndex >= value.length) return null
      const rowValue = value[itemIndex]
      if (!validRecord(rowValue)) return null
      const listPath = consumed.join(".")
      if (!listPath) return null
      rows.push({ listPath, itemIndex, value: rowValue, pathIndex: index })
      value = rowValue
      descriptor = descriptor.config.item as Primitive
      consumed.push(segment)
      continue
    }
    return null
  }

  if (rows.length === 0) return undefined
  const deepest = rows[rows.length - 1]
  const itemFingerprint = fingerprint(deepest, path, options.maskField === true)
  if (itemFingerprint === null) return null
  const ancestors: RepeatedItemAncestor[] = []
  for (const row of rows.slice(0, -1)) {
    const ancestorFingerprint = fingerprint(
      row,
      path,
      options.maskField === true
    )
    if (ancestorFingerprint === null) return null
    ancestors.push({
      listPath: row.listPath,
      itemIndex: row.itemIndex,
      itemFingerprint: ancestorFingerprint,
    })
  }

  return {
    itemIndex: deepest.itemIndex,
    itemFingerprint,
    contentEpoch,
    ...(deepest.listPath === "items" ? {} : { listPath: deepest.listPath }),
    ...(ancestors.length ? { ancestors } : {}),
  }
}

/** Match a complete full-row binding against the current descriptor and value. */
export function repeatedTargetMatches(
  slice: Slice,
  target: RepeatedItemTarget | undefined,
  contentEpoch: number,
  options: RepeatedTargetMatchOptions = {}
): boolean {
  if (
    !target ||
    !Number.isSafeInteger(target.itemIndex) ||
    target.itemIndex < 0
  )
    return false
  if (
    typeof target.itemFingerprint !== "string" ||
    !Number.isSafeInteger(target.contentEpoch) ||
    target.contentEpoch < 0 ||
    target.contentEpoch !== contentEpoch ||
    !Number.isSafeInteger(contentEpoch) ||
    contentEpoch < 0 ||
    Object.keys(target).some(
      (key) =>
        ![
          "itemIndex",
          "itemFingerprint",
          "contentEpoch",
          "listPath",
          "ancestors",
        ].includes(key)
    )
  )
    return false
  const listPath = target.listPath ?? "items"
  if (
    typeof listPath !== "string" ||
    !listPath ||
    parseFieldPath(listPath).join(".") !== listPath
  )
    return false
  const expected = repeatedItemIdentity(
    slice,
    options.fieldPath ?? `${listPath}.${target.itemIndex}`,
    contentEpoch,
    { maskField: options.maskField === true }
  )
  if (!expected) return false
  if (JSON.stringify(expected) === JSON.stringify(target)) return true
  if (!options.allowDeepestRefresh) return false
  return (
    JSON.stringify({ ...expected, itemFingerprint: target.itemFingerprint }) ===
    JSON.stringify(target)
  )
}
