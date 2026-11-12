import type { GenericValidator } from "convex/values"
import type { Primitive } from "./primitives"
import type { AIHint, Slice } from "."

export const INVALID_SLICE_IDENTITY_MESSAGE =
  "Each block on a page must have its own non-empty ID. Refresh the editor and save again."

function isNonEmptySliceId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0
}

function collectReservedSliceIds(
  slices: readonly { id?: unknown }[]
): Set<string> {
  const reserved = new Set<string>()
  for (const slice of slices) {
    if (isNonEmptySliceId(slice.id)) reserved.add(slice.id)
  }
  return reserved
}

/** Whether every sibling has a non-empty ID that occurs exactly once. */
export function hasUniqueSliceIds(
  slices: readonly { id?: unknown }[]
): boolean {
  const seen = new Set<string>()
  for (const slice of slices) {
    if (!isNonEmptySliceId(slice.id) || seen.has(slice.id)) {
      return false
    }
    seen.add(slice.id)
  }
  return true
}

/**
 * Repair legacy sibling identity without changing valid IDs or row content.
 * Candidate IDs are checked against the complete stored list as well as IDs
 * generated earlier in this repair, so even a theoretical UUID collision is
 * retried safely.
 */
export function repairSliceIds<T extends { id: string }>(
  slices: readonly T[],
  createId?: () => string
): T[]
export function repairSliceIds<T extends { id?: unknown }>(
  slices: readonly T[],
  createId?: () => string
): Array<T & { id: string }>
export function repairSliceIds<T extends { id?: unknown }>(
  slices: readonly T[],
  createId: () => string = () => crypto.randomUUID()
): Array<T & { id: string }> {
  if (hasUniqueSliceIds(slices)) {
    return slices as Array<T & { id: string }>
  }

  const reserved = collectReservedSliceIds(slices)
  const used = new Set<string>()

  return slices.map((slice) => {
    if (isNonEmptySliceId(slice.id) && !used.has(slice.id)) {
      used.add(slice.id)
      return slice as T & { id: string }
    }

    let id = createId()
    while (!isNonEmptySliceId(id) || reserved.has(id) || used.has(id)) {
      id = createId()
    }
    used.add(id)
    return { ...slice, id }
  })
}

/** Repair each locale's independent sibling list without crossing locale scope. */
export function repairLocalizedSliceIds<
  TSlice extends { id?: unknown },
  TLocale extends { slices?: TSlice[] },
  TContent extends Record<string, TLocale>,
>(
  content: TContent | undefined,
  createId: () => string = () => crypto.randomUUID()
): TContent | undefined {
  if (!content) return content
  let changed = false
  const entries = Object.entries(content).map(([locale, localized]) => {
    if (!localized.slices) return [locale, localized] as const
    const slices = repairSliceIds(localized.slices, createId)
    if (slices === localized.slices) return [locale, localized] as const
    changed = true
    return [locale, { ...localized, slices }] as const
  })
  return changed ? (Object.fromEntries(entries) as TContent) : content
}

/**
 * Stable publish-time repair for legacy rows. Approval digests and the later
 * promote transaction must normalize the same invalid sibling list to the
 * same IDs; random UUID repair would make an unchanged approved draft drift.
 */
export function repairLocalizedSliceIdsForPublish<
  TSlice extends { id?: unknown },
  TLocale extends { slices?: TSlice[] },
  TContent extends Record<string, TLocale>,
>(content: TContent | undefined): TContent | undefined {
  let sequence = 0
  return repairLocalizedSliceIds(content, () => {
    sequence += 1
    return `formulacms-repaired-slice-${sequence}`
  })
}

/**
 * Give legacy-invalid siblings deterministic transient IDs for React keys,
 * refs, selection, and Slice-derived DOM IDs. Valid stored IDs are preserved
 * exactly; no random value is created during server or client render.
 */
export function withUniqueSliceRenderIds<T extends { id: string }>(
  slices: readonly T[]
): T[]
export function withUniqueSliceRenderIds<T extends { id?: unknown }>(
  slices: readonly T[]
): Array<T & { id: string }>
export function withUniqueSliceRenderIds<T extends { id?: unknown }>(
  slices: readonly T[]
): Array<T & { id: string }> {
  if (hasUniqueSliceIds(slices)) {
    return slices as Array<T & { id: string }>
  }

  const reserved = collectReservedSliceIds(slices)
  const used = new Set<string>()

  return slices.map((slice, index) => {
    if (isNonEmptySliceId(slice.id) && !used.has(slice.id)) {
      used.add(slice.id)
      return slice as T & { id: string }
    }

    const base = `__formulacms-legacy-slice-${index + 1}`
    let id = base
    let suffix = 2
    while (reserved.has(id) || used.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    used.add(id)
    return { ...slice, id }
  })
}

/**
 * Deterministic occurrence identity for drifted revision history. Duplicate
 * logical identity cannot be recovered through arbitrary reorder, but pairing
 * the nth occurrence on each side keeps every archived sibling visible.
 */
export function sliceOccurrenceKeys(
  slices: readonly { id?: unknown }[]
): string[] {
  const counts = new Map<string, number>()
  return slices.map((slice) => {
    const identity = isNonEmptySliceId(slice.id)
      ? (["id", slice.id] as const)
      : (["missing", typeof slice.id, slice.id ?? null] as const)
    const groupKey = JSON.stringify(identity)
    const occurrence = counts.get(groupKey) ?? 0
    counts.set(groupKey, occurrence + 1)
    return JSON.stringify([...identity, occurrence])
  })
}

/** Read contracts only. Admission remains the exact generated Slice validators. */
export type SliceStructure = {
  id: string
  type: string
  enabled: boolean
  primary: Record<string, unknown>
  items?: unknown[]
  presentationIdV1?: string
}

export type SliceDescriptorStructure = {
  type: string
  primary: Primitive
  items?: Primitive
  validator: GenericValidator
  aiHint: AIHint
  preview?: { primary?: unknown; items?: unknown }
}

/** A read view preserves concrete inputs; an impossible branch still has structure. */
type SliceRead<T> = [Exclude<T, null | undefined>] extends [never]
  ? SliceStructure | Extract<T, null | undefined>
  : T

export function readSlice<T extends SliceStructure | null | undefined>(
  value: T
): SliceRead<T>
export function readSlice(value: SliceStructure | null | undefined) {
  return value
}

/** Discriminator proof preserves the caller's exact admitted value. */
export function hasSliceType<T extends SliceStructure, Type extends string>(
  value: T,
  type: Type
): value is T & { type: Type } {
  return value.type === type
}

/** Exact admitted discriminator for calls whose public contract remains closed. */
export function sliceTypeOf(value: Slice): Slice["type"]
export function sliceTypeOf(value: SliceStructure): string {
  return value.type
}
