import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import type { TitleWriteReport } from "@/convex/lib/richtext/write"
import { toFieldShape, mergeRemovedLinks } from "@/convex/lib/richtext/shape"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { validate } from "convex-helpers/validators"
import { type Primitive, type Slice } from "@/convex/lib/slices"
import { separateSliceOccurrencePresentation } from "@/convex/lib/slices/occurrencePresentation"
import { validateSlicesRichText } from "@/convex/lib/slices/validate"
import type { PreviewInlineEditCommit } from "../../visual-editing-types"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"
import {
  repeatedItemIdentity,
  repeatedTargetMatches,
} from "./repeated-item-identity"
import { isStructuralListOperation } from "@/lib/editor-structure"

// Parent state retains the exact array returned by applyPageField. This receipt
// identifies that output's origin without stamping or persisting content. The
// parent controller forwards it explicitly; iframe module instances never share
// this WeakMap, and an ordinary external edit has no receipt.
const inlineEchoes = new WeakMap<Slice[], PreviewInlineEditCommit>()
export function pageFieldEcho(slices: Slice[]) {
  return inlineEchoes.get(slices)
}

/** Project the latest local value over a proved own echo, retaining all guards. */
export function reconcilePageFieldEcho(
  slices: Slice[],
  locale: string,
  commit: PreviewInlineEditCommit,
  echo: PreviewInlineEditCommit | undefined,
  contentEpoch: number,
  catalogRevision = ""
): Slice[] | null {
  const old = commit.fieldBinding,
    echoed = echo?.fieldBinding
  if (
    !echo?.frameBinding ||
    !commit.inlineSessionId ||
    echo.inlineSessionId !== commit.inlineSessionId ||
    echo.locale !== locale ||
    commit.locale !== locale ||
    echo.sliceId !== commit.sliceId ||
    echo.sliceType !== commit.sliceType ||
    echo.fieldPath !== commit.fieldPath ||
    echo.kind !== commit.kind ||
    !old ||
    !echoed ||
    old.contentEpoch !== contentEpoch ||
    echoed.contentEpoch !== contentEpoch ||
    old.catalogRevision !== catalogRevision ||
    echoed.catalogRevision !== catalogRevision ||
    old.presentation !== echoed.presentation ||
    old.descriptor !== echoed.descriptor
  )
    return null
  const current = capturePageField(
    slices,
    locale,
    commit.sliceId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  if (!current || current.value !== echo.value) return null
  const currentSlice = slices.find(
    (slice) => readSlice(slice).id === commit.sliceId
  )
  if (
    current.repeatedTarget
      ? !currentSlice ||
        old.itemFingerprint !== commit.repeatedTarget?.itemFingerprint ||
        echoed.itemFingerprint !== echo.repeatedTarget?.itemFingerprint ||
        !repeatedTargetMatches(
          currentSlice,
          commit.repeatedTarget,
          contentEpoch,
          { fieldPath: commit.fieldPath, maskField: true }
        ) ||
        !repeatedTargetMatches(
          currentSlice,
          echo.repeatedTarget,
          contentEpoch,
          { fieldPath: commit.fieldPath, maskField: true }
        )
      : commit.repeatedTarget !== undefined ||
        echo.repeatedTarget !== undefined ||
        old.itemFingerprint !== undefined ||
        echoed.itemFingerprint !== undefined
  )
    return null
  // rebase updates only the compatible repeated-item fingerprint; apply still
  // checks the current slice, field descriptor, presentation and exact value.
  const rebased = rebasePageField(
    slices,
    locale,
    { ...commit, fieldBinding: { ...old, lastApplied: echo.value } },
    contentEpoch,
    catalogRevision
  )
  return applyPageField(slices, locale, rebased, contentEpoch, catalogRevision)
}

export function valueAtPageField(value: unknown, path: string[]): unknown {
  for (const key of path) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      !value ||
      typeof value !== "object"
    )
      return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}
/** Whether a canonical primary path traverses a descriptor list item. */
export function isPrimaryListPath(primary: Primitive, fieldPath: string) {
  const path = parseFieldPath(fieldPath)
  if (path[0] !== "primary" || path.join(".") !== fieldPath) return false
  let descriptor: Primitive | undefined = primary
  for (const key of path.slice(1)) {
    if (descriptor?.kind === "group")
      descriptor = (descriptor.config.fields as Record<string, Primitive>)[key]
    else if (descriptor?.kind === "list" && /^(0|[1-9]\d*)$/.test(key))
      return true
    else return false
  }
  return false
}
function descriptorAt(slice: Slice, path: string[]): Primitive | undefined {
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return undefined
  let descriptor: Primitive | undefined =
    path[0] === "primary"
      ? def.primary
      : path[0] === "items" && def.items !== undefined
        ? def.items
        : undefined
  for (const key of path.slice(1)) {
    if (descriptor?.kind === "group")
      descriptor = (descriptor.config.fields as Record<string, Primitive>)[key]
    else if (descriptor?.kind === "list" && /^(0|[1-9]\d*)$/.test(key))
      descriptor = descriptor.config.item as Primitive
    else return undefined
  }
  return descriptor
}
/** Descriptor identity and an exact field baseline; never displayed text. */
export function capturePageField(
  slices: Slice[],
  locale: string,
  sliceId: string,
  fieldPath: string,
  contentEpoch: number,
  catalogRevision = "",
  diagnosticRefusal?: (reason: string) => void
): PreviewInlineEditCommit | null {
  function refuse(reason: string): null {
    if (process.env.NODE_ENV === "development") diagnosticRefusal?.(reason)
    return null
  }
  const matches = slices.filter((slice) => readSlice(slice).id === sliceId)
  if (matches.length !== 1 || readSlice(matches[0]).enabled === false)
    return refuse(
      matches.length !== 1
        ? "slice identity does not resolve to exactly one slice"
        : "the slice is disabled"
    )
  const slice = matches[0],
    path = parseFieldPath(fieldPath)
  if (
    path.join(".") !== fieldPath ||
    (path[0] !== "primary" && path[0] !== "items")
  )
    return refuse("field path is not a canonical primary or items path")
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return refuse("slice descriptor is unavailable")
  const descriptor = descriptorAt(slice, path),
    value = valueAtPageField(slice, path)
  const contract =
    descriptor?.kind === "richText"
      ? resolveFieldContract(descriptor.config)
      : undefined
  if (
    !descriptor ||
    descriptor.kind !== "richText" ||
    !["inline", "title", "basic"].includes(contract?.contract ?? "") ||
    typeof value !== "string"
  )
    return refuse(
      !descriptor
        ? "field descriptor is missing"
        : descriptor.kind !== "richText"
          ? "field descriptor is not rich text"
          : !["inline", "title", "basic"].includes(contract?.contract ?? "")
            ? "field descriptor does not support preview editing"
            : "field value is not a string"
    )
  const repeated = repeatedItemIdentity(slice, fieldPath, contentEpoch, {
    maskField: true,
  })
  if (repeated === null)
    return refuse("the repeated item has no binding fingerprint")
  return {
    locale,
    sliceId,
    sliceType: readSlice(slice).type,
    expectedSlice: "",
    fieldPath,
    kind: "richText",
    value,
    ...(repeated ? { repeatedTarget: repeated } : {}),
    fieldBinding: {
      contentEpoch,
      presentation: readSlice(slice).presentationIdV1 ?? "",
      catalogRevision,
      descriptor: JSON.stringify(descriptor),
      lastApplied: value,
      itemFingerprint: repeated?.itemFingerprint,
    },
  }
}

export function applyPageField(
  slices: Slice[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch: number,
  catalogRevision = "",
  report: (report: TitleWriteReport) => void = () => {}
): Slice[] | null {
  const binding = commit.fieldBinding
  if (
    !binding ||
    commit.locale !== locale ||
    binding.contentEpoch !== contentEpoch ||
    binding.catalogRevision !== catalogRevision
  )
    return null
  const current = capturePageField(
    slices,
    locale,
    commit.sliceId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  const currentSlice = slices.find(
    (slice) => readSlice(slice).id === commit.sliceId
  )
  if (
    !current ||
    !currentSlice ||
    current.sliceType !== commit.sliceType ||
    commit.kind !== current.kind ||
    !current.fieldBinding ||
    current.fieldBinding.presentation !== binding.presentation ||
    current.fieldBinding.descriptor !== binding.descriptor ||
    current.value !== binding.lastApplied ||
    current.fieldBinding.itemFingerprint !== binding.itemFingerprint ||
    (current.repeatedTarget
      ? !repeatedTargetMatches(
          currentSlice,
          commit.repeatedTarget,
          contentEpoch,
          { fieldPath: commit.fieldPath, maskField: true }
        )
      : commit.repeatedTarget !== undefined)
  )
    return null
  const target = currentSlice
  const descriptor = descriptorAt(target, parseFieldPath(commit.fieldPath))!
  const contract = resolveFieldContract(descriptor.config)
  const shaped = toFieldShape(contract, commit.value)
  const next = slices.map((slice) =>
    readSlice(slice).id === commit.sliceId
      ? (setValueAtFieldPath(
          slice,
          parseFieldPath(commit.fieldPath),
          shaped.value
        ) as Slice)
      : slice
  )
  const patched = next.find((slice) => readSlice(slice).id === commit.sliceId)!
  const separated = separateSliceOccurrencePresentation(readSlice(patched))
  const patchedDefinition = readSliceDefinition(readSlice(patched).type)
  if (
    !separated ||
    !patchedDefinition ||
    !validate(patchedDefinition.validator, separated.descriptorValue)
  )
    return null
  try {
    validateSlicesRichText([patched])
  } catch {
    return null
  }
  const removedLinks = mergeRemovedLinks(
    commit.removedLinks ?? [],
    shaped.removedLinks
  )
  if (removedLinks.length)
    report({
      locale,
      sliceId: commit.sliceId,
      fieldPath: commit.fieldPath,
      removedLinks,
    })
  if (commit.inlineSessionId && commit.frameBinding)
    inlineEchoes.set(next, {
      ...commit,
      fieldBinding: { ...commit.fieldBinding! },
      frameBinding: { ...commit.frameBinding },
    })
  return next
}

/** Rebase only parent-qualified value changes under the unchanged structural epoch. */
export function rebasePageField(
  slices: Slice[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch: number,
  catalogRevision = ""
) {
  const current = capturePageField(
    slices,
    locale,
    commit.sliceId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  const old = commit.fieldBinding,
    fresh = current?.fieldBinding
  const currentSlice = slices.find(
    (slice) => readSlice(slice).id === commit.sliceId
  )
  if (
    !old ||
    !fresh ||
    !currentSlice ||
    old.contentEpoch !== contentEpoch ||
    old.catalogRevision !== catalogRevision ||
    old.presentation !== fresh.presentation ||
    old.descriptor !== fresh.descriptor ||
    old.lastApplied !== fresh.lastApplied ||
    current.sliceType !== commit.sliceType
  )
    return commit
  if (
    current.repeatedTarget
      ? !old.itemFingerprint ||
        old.itemFingerprint !== commit.repeatedTarget?.itemFingerprint ||
        !repeatedTargetMatches(
          currentSlice,
          commit.repeatedTarget,
          contentEpoch,
          {
            fieldPath: commit.fieldPath,
            maskField: true,
            allowDeepestRefresh: true,
          }
        )
      : commit.repeatedTarget !== undefined
  )
    return commit
  return {
    ...commit,
    fieldBinding: fresh,
    repeatedTarget: current.repeatedTarget,
  }
}

/** List operations retain object references; equal-valued swaps still invalidate. */
export function hasStructuralSliceChange(
  previous: Slice[],
  next: Slice[]
): boolean {
  if (
    previous.length !== next.length ||
    previous.some(
      (slice, index) =>
        readSlice(slice).id !== readSlice(next[index])?.id ||
        readSlice(slice).type !== readSlice(next[index])?.type ||
        readSlice(slice).presentationIdV1 !==
          readSlice(next[index])?.presentationIdV1 ||
        readSlice(slice).enabled !== readSlice(next[index])?.enabled
    )
  )
    return true
  function changed(a: unknown, b: unknown): boolean {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return true
      if (a !== b && isStructuralListOperation(b)) return true
      if (
        a.some(
          (item, index) =>
            item !== b[index] && b.includes(item) && b.indexOf(item) !== index
        )
      )
        return true
      const old = a.map((item) => JSON.stringify(item)),
        fresh = b.map((item) => JSON.stringify(item))
      if (
        JSON.stringify(old) !== JSON.stringify(fresh) &&
        JSON.stringify([...old].sort()) === JSON.stringify([...fresh].sort())
      )
        return true
      return a.some((item, index) => changed(item, b[index]))
    }
    if (a && b && typeof a === "object" && typeof b === "object")
      return Object.entries(a).some(([key, value]) =>
        changed(value, (b as Record<string, unknown>)[key])
      )
    return false
  }
  return previous.some((slice, index) => changed(slice, next[index]))
}
