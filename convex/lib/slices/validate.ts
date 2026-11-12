import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice, type SliceStructure } from "@/convex/lib/slices/identity"
import {
  preservesTitleAt,
  preservesLegacyRichTextAt,
  isLegacyTitleHtml,
  type WriteOptions,
} from "../richtext/write"
import { ConvexError } from "convex/values"
import type { Primitive } from "./primitives"
import { type Slice } from "./index"
import { walkFieldMap, walkValue } from "./walk"
import {
  resolveFieldContract,
  type FieldAddress,
  type RichTextContractConfig,
} from "../richtext/contracts"
import { toFieldShape, type RemovedRichTextLink } from "../richtext/shape"
import { validateLegacy, validateStrict } from "../richtext/strict"
import { convertTransitionTitle } from "../richtext/transitions"
import { hasUniqueSliceIds, INVALID_SLICE_IDENTITY_MESSAGE } from "./identity"

/**
 * Write-path rich-text enforcement (ADR-0009).
 *
 * Walks each slice's primitive descriptors to locate every `richText` field and
 * validates its stored value against the field's resolved contract. Reading the
 * contract from the descriptor keeps a single source of truth
 * — adding a `richText()` field to any slice is covered automatically, with no
 * hardcoded `"basic"` to drift. This is *not* the Phase C editor/render
 * registry; it only reads the descriptors Phase A already built.
 */

export type RichTextValidationTier = "write" | "legacy"

/** Writes inspect the stored bytes; legacy reads validate a converted copy. */
function checkLeafRichText(
  leaf: { def: Primitive; value: unknown },
  tier: RichTextValidationTier
): void {
  if (leaf.def.kind !== "richText" || typeof leaf.value !== "string") return
  const config = leaf.def.config as RichTextContractConfig
  const resolved = resolveFieldContract(config)
  const result =
    tier === "legacy"
      ? validateLegacy(resolved, leaf.value)
      : validateStrict(resolved, leaf.value)
  if (!result.ok) {
    throw new ConvexError(`Invalid rich-text content: ${result.error}`)
  }
}

export interface FieldShapeConversionReport extends FieldAddress {
  removedLinks: RemovedRichTextLink[]
}

export interface ConvertedFields<T> {
  value: T
  reports: FieldShapeConversionReport[]
}

/** Convert descriptor-bound rich-text fields on an immutable copy. */
export function convertSliceFields(slice: Slice): ConvertedFields<Slice>
export function convertSliceFields(
  slice: SliceStructure
): ConvertedFields<Record<string, unknown>> {
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return { value: slice, reports: [] }
  const reports: FieldShapeConversionReport[] = []
  const next: Record<string, unknown> = { ...slice }
  next.primary = convertDescriptorValue(
    def.primary,
    slice.primary,
    { sliceType: readSlice(slice).type, fieldPath: "primary" },
    reports
  )
  if (def.items) {
    next.items = convertDescriptorValue(
      def.items,
      slice.items,
      { sliceType: readSlice(slice).type, fieldPath: "items" },
      reports
    )
  }
  return { value: next, reports }
}

/** Convert rich-text fields declared by a content-type field map. */
export function convertContentFields(
  fields: Record<string, Primitive>,
  values: Record<string, unknown>,
  contentType: string
): ConvertedFields<Record<string, unknown>> {
  const reports: FieldShapeConversionReport[] = []
  const next: Record<string, unknown> = { ...values }
  for (const [key, def] of Object.entries(fields)) {
    next[key] = convertDescriptorValue(
      def,
      values[key],
      { sliceType: contentType, fieldPath: key },
      reports
    )
  }
  return { value: next, reports }
}

function convertDescriptorValue(
  def: Primitive,
  value: unknown,
  address: FieldAddress,
  reports: FieldShapeConversionReport[]
): unknown {
  if (def.kind === "group") {
    if (!isRecord(value)) return value
    const fields =
      (def.config as { fields?: Record<string, Primitive> }).fields ?? {}
    const next: Record<string, unknown> = { ...value }
    for (const [key, child] of Object.entries(fields)) {
      next[key] = convertDescriptorValue(
        child,
        value[key],
        {
          ...address,
          fieldPath: `${address.fieldPath}.${key}`,
        },
        reports
      )
    }
    return next
  }
  if (def.kind === "list") {
    if (!Array.isArray(value)) return value
    const item = (def.config as { item: Primitive }).item
    return value.map((row, index) =>
      convertDescriptorValue(
        item,
        row,
        {
          ...address,
          fieldPath: `${address.fieldPath}[${index}]`,
        },
        reports
      )
    )
  }
  if (def.kind !== "richText" || typeof value !== "string") return value
  const config = def.config as RichTextContractConfig
  const contractName = resolveFieldContract(config).contract
  const converted =
    (contractName === "title"
      ? convertTransitionTitle(address, value)
      : undefined) ?? toFieldShape(resolveFieldContract(config), value)
  if (converted.value !== value || converted.removedLinks.length > 0) {
    reports.push({ ...address, removedLinks: converted.removedLinks })
  }
  return converted.value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate every rich-text field across a set of slices, throwing a
 * {@link ConvexError} on the first value that violates its strict contract.
 * The explicitly selected legacy tier remains lenient. The throw aborts the walk,
 * preserving the original first-failure semantics. Writes are the default;
 * converted read/restore callers must explicitly select the legacy tier.
 */
export function validateSlicesRichText(
  slices: readonly Slice[],
  tier: RichTextValidationTier = "write",
  preservation?: { options: WriteOptions; locale: string }
): void {
  for (const slice of slices) {
    const def = readSliceDefinition(readSlice(slice).type)
    if (!def) continue
    const check =
      (root: string) =>
      (leaf: { def: Primitive; value: unknown; path: string }) => {
        const path = leaf.path
          ? `${root}${leaf.path.startsWith("[") ? "" : "."}${leaf.path}`
          : root
        if (
          preservation &&
          leaf.def.kind === "richText" &&
          resolveFieldContract(leaf.def.config).contract === "title" &&
          typeof leaf.value === "string" &&
          isLegacyTitleHtml(leaf.value) &&
          preservesTitleAt(
            preservation.options,
            preservation.locale,
            slice,
            path,
            leaf.value
          )
        )
          return
        if (
          tier === "write" &&
          preservation &&
          leaf.def.kind === "richText" &&
          typeof leaf.value === "string" &&
          !validateStrict(resolveFieldContract(leaf.def.config), leaf.value)
            .ok &&
          preservesLegacyRichTextAt(
            preservation.options,
            preservation.locale,
            slice,
            path,
            leaf.value,
            resolveFieldContract(leaf.def.config)
          )
        )
          return
        checkLeafRichText(leaf, tier)
      }
    walkValue(
      def.primary,
      (slice as { primary?: unknown }).primary,
      check("primary")
    )
    if (def.items) {
      walkValue(def.items, (slice as { items?: unknown }).items, check("items"))
    }
  }
}

/** Reject new writes that contain empty or duplicate sibling Slice IDs. */
export function validateUniqueSliceIds(slices: readonly Slice[]): void {
  if (!hasUniqueSliceIds(slices)) {
    throw new ConvexError(INVALID_SLICE_IDENTITY_MESSAGE)
  }
}

/**
 * Validate every rich-text field across a descriptor field map + stored value
 * bag (plan 029 C8). Same first-failure semantics as {@link validateSlicesRichText}.
 *
 * Content-type descriptors declare rich-text fields via the same `richText()`
 * primitive that slices use, so the walk + profile enforcement is identical —
 * this helper only differs in that it iterates a `Record<string, Primitive>`
 * instead of a slice tree. `pages.updateDraft` calls this on
 * `descriptor.localizedFields` to cover author bios, faq answers, and future
 * localized rich-text on the same code path that covers slice rich-text.
 */
export function validateFieldMapRichText(
  fields: Record<string, Primitive>,
  values: Record<string, unknown> | undefined,
  tier: RichTextValidationTier = "write"
): void {
  walkFieldMap(fields, values, (leaf) => checkLeafRichText(leaf, tier))
}
