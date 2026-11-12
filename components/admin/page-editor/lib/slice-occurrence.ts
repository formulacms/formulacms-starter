import { readSlice } from "@/convex/lib/slices/identity"
import type { Slice } from "@/convex/lib/slices"
import type {
  PreviewInlineEditCommit,
  SliceOccurrenceBaseline,
} from "../../visual-editing-types"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"
import {
  repeatedItemIdentity,
  repeatedTargetMatches,
} from "./repeated-item-identity"

/** Capture the complete occurrence, including list order, before an interaction. */
export function captureSliceOccurrence(
  slices: Slice[],
  locale: string,
  sliceId: string,
  fieldPath?: string,
  contentEpoch = 0
): SliceOccurrenceBaseline | null {
  const matches = slices.filter((slice) => readSlice(slice).id === sliceId)
  if (!sliceId.trim() || matches.length !== 1) return null
  const slice = matches[0]
  const repeated = fieldPath
    ? repeatedItemIdentity(slice, fieldPath, contentEpoch)
    : undefined
  if (repeated === null) return null
  return {
    ...(repeated ? { repeatedTarget: repeated } : {}),
    locale,
    sliceId,
    sliceType: readSlice(slice).type,
    expectedSlice: JSON.stringify(slice),
  }
}

export function currentSliceOccurrence(
  slices: Slice[],
  locale: string,
  baseline: SliceOccurrenceBaseline,
  contentEpoch = 0
): Slice | undefined {
  if (baseline.sourceInvalidated || locale !== baseline.locale) return undefined
  const matches = slices.filter(
    (slice) => readSlice(slice).id === baseline.sliceId
  )
  if (matches.length !== 1) return undefined
  const slice = matches[0]
  const repeated = baseline.repeatedTarget
  if (repeated && !repeatedTargetMatches(slice, repeated, contentEpoch))
    return undefined
  return readSlice(slice).type === baseline.sliceType &&
    JSON.stringify(slice) === baseline.expectedSlice
    ? slice
    : undefined
}

export function applyPreviewInlineEdit(
  slices: Slice[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch = 0
): Slice[] {
  const target = currentSliceOccurrence(slices, locale, commit, contentEpoch)
  if (!target) return slices
  const path = parseFieldPath(commit.fieldPath)
  const expected = repeatedItemIdentity(target, commit.fieldPath, contentEpoch)
  if (
    expected === null ||
    JSON.stringify(expected) !== JSON.stringify(commit.repeatedTarget)
  )
    return slices
  if (path[0] !== "primary" && path[0] !== "items") return slices
  return slices.map((slice) =>
    slice === target
      ? (setValueAtFieldPath(slice, path, commit.value) as Slice)
      : slice
  )
}
