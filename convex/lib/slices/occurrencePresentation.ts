import { v, type GenericValidator, type VObject } from "convex/values"
import { hasUniqueSliceIds } from "./identity"

/**
 * Version-one, Type-scoped occurrence metadata. Absence means the legacy
 * default; it never changes canonical occurrence `id`, `type` or field values.
 */
export const SLICE_PRESENTATION_ID_MAX_LENGTH = 64

/** Retained identity, independent of renderer fallback and current catalog state. */
export function occurrencePresentationId(value: unknown): string | null {
  if (value === undefined) return "default"
  return isStableSlicePresentationId(value) ? value : null
}

export type SliceOccurrenceIdentity = {
  key: string
  pageId: string
  locale: string
  type: string
  presentationId: string
  sliceId: string
}

export type SliceOccurrenceExtraction = {
  occurrences: SliceOccurrenceIdentity[]
  invalidTypes: string[]
  unknownInvalid: boolean
}

/** One inclusion/key policy for writers, initialization and verification. */
export function extractSliceOccurrenceIdentities(
  pageId: string,
  content: unknown
): SliceOccurrenceExtraction {
  const result: SliceOccurrenceExtraction = {
    occurrences: [],
    invalidTypes: [],
    unknownInvalid: false,
  }
  if (content === undefined) return result
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    result.unknownInvalid = true
    return result
  }
  const invalid = new Set<string>()
  for (const [locale, localized] of Object.entries(content)) {
    if (
      !localized ||
      typeof localized !== "object" ||
      Array.isArray(localized)
    ) {
      result.unknownInvalid = true
      continue
    }
    const slices = (localized as { slices?: unknown }).slices
    if (slices === undefined) continue
    if (!Array.isArray(slices)) {
      result.unknownInvalid = true
      continue
    }
    const rows = slices.filter(
      (slice): slice is Record<string, unknown> =>
        !!slice && typeof slice === "object" && !Array.isArray(slice)
    )
    if (rows.length !== slices.length) result.unknownInvalid = true
    const identifiable = rows.every(
      (slice) => typeof slice.type === "string" && slice.type.length > 0
    )
    if (!identifiable) result.unknownInvalid = true
    if (
      !hasUniqueSliceIds(rows) ||
      !identifiable ||
      rows.length !== slices.length
    ) {
      for (const slice of rows)
        if (typeof slice.type === "string") invalid.add(slice.type)
      continue
    }
    for (const slice of rows) {
      const presentationId = occurrencePresentationId(slice.presentationIdV1)
      const type = slice.type as string
      if (presentationId === null || !locale) {
        invalid.add(type)
        continue
      }
      const sliceId = slice.id as string
      result.occurrences.push({
        key: JSON.stringify([pageId, locale, type, presentationId, sliceId]),
        pageId,
        locale,
        type,
        presentationId,
        sliceId,
      })
    }
  }
  result.invalidTypes = [...invalid].sort()
  result.occurrences = result.occurrences.filter(
    (occurrence) => !invalid.has(occurrence.type)
  )
  return result
}

const occurrencePresentationFields = {
  presentationIdV1: v.optional(v.string()),
}

/**
 * Native Convex storage shape only. v.string has no length/pattern refinement:
 * writers must also apply the semantic guard and current-catalog assignment
 * policy. Keep this module independent of index/catalog/React imports.
 */
export function withSliceOccurrencePresentation<
  Type,
  Fields extends Record<string, GenericValidator>,
>(descriptor: VObject<Type, Fields>) {
  if (Object.hasOwn(descriptor.fields, "presentationIdV1")) {
    throw new Error(
      "Slice descriptors cannot own occurrence presentation metadata."
    )
  }
  return descriptor.extend(occurrencePresentationFields)
}

/** Syntax eligibility for retained IDs, not catalog membership or authority. */
export function isStableSlicePresentationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SLICE_PRESENTATION_ID_MAX_LENGTH &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.exec(value)?.[0] === value
  )
}

/** Semantic metadata guard only; the native/Type validators still own content. */
export function hasValidSliceOccurrencePresentation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const id = (value as { presentationIdV1?: unknown }).presentationIdV1
  return id === undefined || isStableSlicePresentationId(id)
}

/**
 * Separate only valid occurrence metadata before applying an unchanged Type
 * validator. All other keys survive so unexpected content is still rejected.
 * Neither the occurrence nor its nested primary/items values are modified.
 */
export function separateSliceOccurrencePresentation<Type extends object>(
  occurrence: Type
): {
  descriptorValue: Omit<Type, "presentationIdV1">
  presentationId?: string
} | null {
  if (!hasValidSliceOccurrencePresentation(occurrence)) return null
  const { presentationIdV1, ...descriptorValue } = occurrence as Type & {
    presentationIdV1?: string
  }
  return {
    descriptorValue,
    ...(presentationIdV1 === undefined
      ? {}
      : { presentationId: presentationIdV1 }),
  }
}
