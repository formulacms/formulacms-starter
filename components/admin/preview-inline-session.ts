import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { adoptHeroTitles } from "@/lib/rich-text/adopt-hero-titles"
import { toFieldShape, mergeRemovedLinks } from "@/convex/lib/richtext/shape"
import { validate } from "convex-helpers/validators"
import { type Primitive, type Slice } from "@/convex/lib/slices"
import { validateSlicesRichText } from "@/convex/lib/slices/validate"
import { separateSliceOccurrencePresentation } from "@/convex/lib/slices/occurrencePresentation"
import type { PreviewInlineEditCommit } from "./visual-editing-types"
import {
  applyPreviewInlineEdit,
  currentSliceOccurrence,
} from "./page-editor/lib/slice-occurrence"
import { parseFieldPath } from "./page-editor/lib/field-path"
import { repeatedItemIdentity } from "./page-editor/lib/repeated-item-identity"

export type PreviewInlineSession = Omit<PreviewInlineEditCommit, "value"> & {
  draft: string
  cancellationValue: string
  label: string
}

/** Resolve writes through the installed descriptor, never through displayed text. */
function descriptorAtPath(
  slice: Slice,
  fieldPath: string
): Primitive | undefined {
  const [root, ...path] = parseFieldPath(fieldPath)
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return undefined
  let descriptor: Primitive | undefined =
    root === "primary"
      ? def.primary
      : root === "items" && def.items !== undefined
        ? def.items
        : undefined
  for (const segment of path) {
    if (descriptor?.kind === "group") {
      descriptor = (descriptor.config.fields as Record<string, Primitive>)[
        segment
      ]
    } else if (descriptor?.kind === "list" && /^(0|[1-9]\d*)$/.test(segment)) {
      descriptor = descriptor.config.item as Primitive
    } else return undefined
  }
  return descriptor
}

export function validatedPreviewCommit(
  slices: Slice[],
  locale: string,
  session: PreviewInlineSession,
  contentEpoch = 0
): PreviewInlineEditCommit | null {
  if (session.sourceInvalidated) return null
  const slice = currentSliceOccurrence(slices, locale, session, contentEpoch)
  if (!slice || readSlice(slice).enabled === false) return null
  const expectedTarget = repeatedItemIdentity(
    slice,
    session.fieldPath,
    contentEpoch
  )
  if (
    expectedTarget === null ||
    JSON.stringify(expectedTarget) !== JSON.stringify(session.repeatedTarget)
  )
    return null
  const descriptor = descriptorAtPath(slice, session.fieldPath)
  if (!descriptor || descriptor.kind !== session.kind) return null
  const contract =
    descriptor.kind === "richText"
      ? resolveFieldContract(descriptor.config)
      : undefined
  if (
    session.repeatedTarget &&
    descriptor.kind === "richText" &&
    !["inline", "title", "basic"].includes(contract!.contract)
  )
    return null
  const shaped = contract
    ? toFieldShape(contract, session.draft)
    : { value: session.draft, removedLinks: [] }
  if (contract && !validateStrict(contract, shaped.value).ok) return null
  const removedLinks = mergeRemovedLinks(
    session.removedLinks ?? [],
    shaped.removedLinks
  )
  const commit: PreviewInlineEditCommit = {
    repeatedTarget: session.repeatedTarget,
    rendererSource: session.rendererSource,
    locale: session.locale,
    sliceId: session.sliceId,
    sliceType: session.sliceType,
    expectedSlice: session.expectedSlice,
    fieldPath: session.fieldPath,
    kind: session.kind,
    value: shaped.value,
    ...(removedLinks.length ? { removedLinks } : {}),
  }
  const projected = applyPreviewInlineEdit(slices, locale, commit, contentEpoch)
  const patched = projected.find(
    (entry) => readSlice(entry).id === readSlice(slice).id
  )
  const occurrence = readSlice(patched)
  const separated = occurrence
    ? separateSliceOccurrencePresentation(occurrence)
    : null
  const patchedDefinition = readSliceDefinition(occurrence?.type ?? "")
  if (
    !patched ||
    !separated ||
    !patchedDefinition ||
    !validate(patchedDefinition.validator, separated.descriptorValue)
  )
    return null
  try {
    const scratch = adoptHeroTitles([patched], locale).value
    validateSlicesRichText(scratch)
  } catch {
    return null
  }
  return commit
}

export function projectPreviewSession(
  slices: Slice[],
  locale: string,
  session: PreviewInlineSession | null,
  contentEpoch = 0
): Slice[] {
  const commit =
    session && validatedPreviewCommit(slices, locale, session, contentEpoch)
  return commit
    ? applyPreviewInlineEdit(slices, locale, commit, contentEpoch)
    : slices
}

/** Save captures this value; later typing stays in the buffer with the new base. */
export function acceptPreviewCapture(
  session: PreviewInlineSession,
  commit: PreviewInlineEditCommit
): PreviewInlineSession {
  if (
    session.sourceInvalidated ||
    commit.sourceInvalidated ||
    JSON.stringify(session.rendererSource) !==
      JSON.stringify(commit.rendererSource) ||
    session.expectedSlice !== commit.expectedSlice ||
    session.locale !== commit.locale ||
    session.sliceId !== commit.sliceId ||
    session.sliceType !== commit.sliceType ||
    session.fieldPath !== commit.fieldPath ||
    session.kind !== commit.kind ||
    JSON.stringify(session.repeatedTarget) !==
      JSON.stringify(commit.repeatedTarget)
  )
    return session
  let base: Slice
  try {
    base = JSON.parse(commit.expectedSlice) as Slice
  } catch {
    return session
  }
  const captured = { ...session, draft: commit.value }
  if (
    !validatedPreviewCommit(
      [base],
      commit.locale,
      captured,
      session.repeatedTarget?.contentEpoch
    )
  )
    return session
  const [patched] = applyPreviewInlineEdit(
    [base],
    commit.locale,
    commit,
    session.repeatedTarget?.contentEpoch
  )
  const repeatedTarget = repeatedItemIdentity(
    patched,
    commit.fieldPath,
    session.repeatedTarget?.contentEpoch ?? 0
  )
  if (repeatedTarget === null) return session
  return {
    ...session,
    expectedSlice: JSON.stringify(patched),
    ...(repeatedTarget ? { repeatedTarget } : {}),
    cancellationValue: commit.value,
  }
}
