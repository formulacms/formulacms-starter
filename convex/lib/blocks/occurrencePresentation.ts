import { v, type GenericValidator, type VObject } from "convex/values"
import { hasUniqueBlockIds } from "./identity"

/**
 * Version-one, Type-scoped occurrence metadata. Absence means the legacy
 * default; it never changes canonical occurrence `id`, `type` or field values.
 */
export const BLOCK_PRESENTATION_ID_MAX_LENGTH = 64

/** Retained identity, independent of renderer fallback and current catalog state. */
export function occurrencePresentationId(value: unknown): string | null {
  if (value === undefined) return "default"
  return isStableBlockPresentationId(value) ? value : null
}

export type BlockOccurrenceIdentity = {
  key: string
  pageId: string
  locale: string
  type: string
  presentationId: string
  blockId: string
}

export type BlockOccurrenceExtraction = {
  occurrences: BlockOccurrenceIdentity[]
  invalidTypes: string[]
  unknownInvalid: boolean
}

/** One inclusion/key policy for writers, initialization and verification. */
export function extractBlockOccurrenceIdentities(
  pageId: string,
  content: unknown
): BlockOccurrenceExtraction {
  const result: BlockOccurrenceExtraction = {
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
    const blocks = (localized as { blocks?: unknown }).blocks
    if (blocks === undefined) continue
    if (!Array.isArray(blocks)) {
      result.unknownInvalid = true
      continue
    }
    const rows = blocks.filter(
      (block): block is Record<string, unknown> =>
        !!block && typeof block === "object" && !Array.isArray(block)
    )
    if (rows.length !== blocks.length) result.unknownInvalid = true
    const identifiable = rows.every(
      (block) => typeof block.type === "string" && block.type.length > 0
    )
    if (!identifiable) result.unknownInvalid = true
    if (
      !hasUniqueBlockIds(rows) ||
      !identifiable ||
      rows.length !== blocks.length
    ) {
      for (const block of rows)
        if (typeof block.type === "string") invalid.add(block.type)
      continue
    }
    for (const block of rows) {
      const presentationId = occurrencePresentationId(block.presentationIdV1)
      const type = block.type as string
      if (presentationId === null || !locale) {
        invalid.add(type)
        continue
      }
      const blockId = block.id as string
      result.occurrences.push({
        key: JSON.stringify([pageId, locale, type, presentationId, blockId]),
        pageId,
        locale,
        type,
        presentationId,
        blockId,
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
export function withBlockOccurrencePresentation<
  Type,
  Fields extends Record<string, GenericValidator>,
>(descriptor: VObject<Type, Fields>) {
  if (Object.hasOwn(descriptor.fields, "presentationIdV1")) {
    throw new Error(
      "Block descriptors cannot own occurrence presentation metadata."
    )
  }
  return descriptor.extend(occurrencePresentationFields)
}

/** Syntax eligibility for retained IDs, not catalog membership or authority. */
export function isStableBlockPresentationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= BLOCK_PRESENTATION_ID_MAX_LENGTH &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.exec(value)?.[0] === value
  )
}

/** Semantic metadata guard only; the native/Type validators still own content. */
export function hasValidBlockOccurrencePresentation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const id = (value as { presentationIdV1?: unknown }).presentationIdV1
  return id === undefined || isStableBlockPresentationId(id)
}

/**
 * Separate only valid occurrence metadata before applying an unchanged Type
 * validator. All other keys survive so unexpected content is still rejected.
 * Neither the occurrence nor its nested primary/items values are modified.
 */
export function separateBlockOccurrencePresentation<Type extends object>(
  occurrence: Type
): {
  descriptorValue: Omit<Type, "presentationIdV1">
  presentationId?: string
} | null {
  if (!hasValidBlockOccurrencePresentation(occurrence)) return null
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
