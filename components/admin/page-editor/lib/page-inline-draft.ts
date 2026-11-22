import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import type { TitleWriteReport } from "@/convex/lib/richtext/write"
import { toFieldShape, mergeRemovedLinks } from "@/convex/lib/richtext/shape"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { validate } from "convex-helpers/validators"
import { type Primitive, type Block } from "@/convex/lib/blocks"
import { isEditorialTextPrimitive } from "@/convex/lib/blocks/primitives"
import { separateBlockOccurrencePresentation } from "@/convex/lib/blocks/occurrencePresentation"
import { validateBlocksRichText } from "@/convex/lib/blocks/validate"
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
const inlineEchoes = new WeakMap<Block[], PreviewInlineEditCommit>()
export function pageFieldEcho(blocks: Block[]) {
  return inlineEchoes.get(blocks)
}

/** Project the latest local value over a proved own echo, retaining all guards. */
export function reconcilePageFieldEcho(
  blocks: Block[],
  locale: string,
  commit: PreviewInlineEditCommit,
  echo: PreviewInlineEditCommit | undefined,
  contentEpoch: number,
  catalogRevision = ""
): Block[] | null {
  const old = commit.fieldBinding,
    echoed = echo?.fieldBinding
  if (
    !echo?.frameBinding ||
    !commit.inlineSessionId ||
    echo.inlineSessionId !== commit.inlineSessionId ||
    echo.locale !== locale ||
    commit.locale !== locale ||
    echo.blockId !== commit.blockId ||
    echo.blockType !== commit.blockType ||
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
    blocks,
    locale,
    commit.blockId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  if (!current || current.value !== echo.value) return null
  const currentBlock = blocks.find(
    (block) => readBlock(block).id === commit.blockId
  )
  if (
    current.repeatedTarget
      ? !currentBlock ||
        old.itemFingerprint !== commit.repeatedTarget?.itemFingerprint ||
        echoed.itemFingerprint !== echo.repeatedTarget?.itemFingerprint ||
        !repeatedTargetMatches(
          currentBlock,
          commit.repeatedTarget,
          contentEpoch,
          { fieldPath: commit.fieldPath, maskField: true }
        ) ||
        !repeatedTargetMatches(
          currentBlock,
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
  // checks the current block, field descriptor, presentation and exact value.
  const rebased = rebasePageField(
    blocks,
    locale,
    { ...commit, fieldBinding: { ...old, lastApplied: echo.value } },
    contentEpoch,
    catalogRevision
  )
  return applyPageField(blocks, locale, rebased, contentEpoch, catalogRevision)
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
/**
 * A one-line plain text field that the page preview edits in place, like a
 * title: editor-authored copy (`text()`), not multiline. A multiline field
 * stays in the form: the public render folds its line breaks into spaces.
 */
export function isInPlacePlainText(descriptor: Primitive | undefined) {
  return (
    descriptor?.kind === "text" &&
    isEditorialTextPrimitive(descriptor) &&
    (descriptor.config as { multiline?: boolean }).multiline !== true
  )
}

/**
 * A plain line a preview edit may write: one line, within its max length. A
 * stored value already over the limit may still shrink, as in the editor.
 */
function acceptsPlainLine(descriptor: Primitive, value: string, stored: string) {
  const { maxLength } = descriptor.config as { maxLength?: number }
  return (
    !/[\r\n]/.test(value) &&
    (!maxLength || value.length <= Math.max(maxLength, stored.length))
  )
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
function descriptorAt(block: Block, path: string[]): Primitive | undefined {
  const def = readBlockDefinition(readBlock(block).type)
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
  blocks: Block[],
  locale: string,
  blockId: string,
  fieldPath: string,
  contentEpoch: number,
  catalogRevision = "",
  diagnosticRefusal?: (reason: string) => void
): PreviewInlineEditCommit | null {
  function refuse(reason: string): null {
    if (process.env.NODE_ENV === "development") diagnosticRefusal?.(reason)
    return null
  }
  const matches = blocks.filter((block) => readBlock(block).id === blockId)
  if (matches.length !== 1 || readBlock(matches[0]).enabled === false)
    return refuse(
      matches.length !== 1
        ? "block identity does not resolve to exactly one block"
        : "the block is disabled"
    )
  const block = matches[0],
    path = parseFieldPath(fieldPath)
  if (
    path.join(".") !== fieldPath ||
    (path[0] !== "primary" && path[0] !== "items")
  )
    return refuse("field path is not a canonical primary or items path")
  const def = readBlockDefinition(readBlock(block).type)
  if (!def) return refuse("block descriptor is unavailable")
  const descriptor = descriptorAt(block, path),
    value = valueAtPageField(block, path)
  const contract =
    descriptor?.kind === "richText"
      ? resolveFieldContract(descriptor.config)
      : undefined
  const plain = isInPlacePlainText(descriptor)
  if (
    !descriptor ||
    (!plain && descriptor.kind !== "richText") ||
    (!plain &&
      !["inline", "title", "basic"].includes(contract?.contract ?? "")) ||
    typeof value !== "string"
  )
    return refuse(
      !descriptor
        ? "field descriptor is missing"
        : !plain && descriptor.kind !== "richText"
          ? "field descriptor is neither rich text nor one-line plain text"
          : !plain &&
              !["inline", "title", "basic"].includes(contract?.contract ?? "")
            ? "field descriptor does not support preview editing"
            : "field value is not a string"
    )
  const repeated = repeatedItemIdentity(block, fieldPath, contentEpoch, {
    maskField: true,
  })
  if (repeated === null)
    return refuse("the repeated item has no binding fingerprint")
  return {
    locale,
    blockId,
    blockType: readBlock(block).type,
    expectedBlock: "",
    fieldPath,
    kind: plain ? "text" : "richText",
    value,
    ...(repeated ? { repeatedTarget: repeated } : {}),
    fieldBinding: {
      contentEpoch,
      presentation: readBlock(block).presentationIdV1 ?? "",
      catalogRevision,
      descriptor: JSON.stringify(descriptor),
      lastApplied: value,
      itemFingerprint: repeated?.itemFingerprint,
    },
  }
}

export function applyPageField(
  blocks: Block[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch: number,
  catalogRevision = "",
  report: (report: TitleWriteReport) => void = () => {}
): Block[] | null {
  const binding = commit.fieldBinding
  if (
    !binding ||
    commit.locale !== locale ||
    binding.contentEpoch !== contentEpoch ||
    binding.catalogRevision !== catalogRevision
  )
    return null
  const current = capturePageField(
    blocks,
    locale,
    commit.blockId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  const currentBlock = blocks.find(
    (block) => readBlock(block).id === commit.blockId
  )
  if (
    !current ||
    !currentBlock ||
    current.blockType !== commit.blockType ||
    commit.kind !== current.kind ||
    !current.fieldBinding ||
    current.fieldBinding.presentation !== binding.presentation ||
    current.fieldBinding.descriptor !== binding.descriptor ||
    current.value !== binding.lastApplied ||
    current.fieldBinding.itemFingerprint !== binding.itemFingerprint ||
    (current.repeatedTarget
      ? !repeatedTargetMatches(
          currentBlock,
          commit.repeatedTarget,
          contentEpoch,
          { fieldPath: commit.fieldPath, maskField: true }
        )
      : commit.repeatedTarget !== undefined)
  )
    return null
  const target = currentBlock
  const descriptor = descriptorAt(target, parseFieldPath(commit.fieldPath))!
  if (descriptor.kind === "text" && !acceptsPlainLine(descriptor, commit.value, current.value))
    return null
  const shaped =
    descriptor.kind === "text"
      ? { value: commit.value, removedLinks: [] }
      : toFieldShape(resolveFieldContract(descriptor.config), commit.value)
  const next = blocks.map((block) =>
    readBlock(block).id === commit.blockId
      ? (setValueAtFieldPath(
          block,
          parseFieldPath(commit.fieldPath),
          shaped.value
        ) as Block)
      : block
  )
  const patched = next.find((block) => readBlock(block).id === commit.blockId)!
  const separated = separateBlockOccurrencePresentation(readBlock(patched))
  const patchedDefinition = readBlockDefinition(readBlock(patched).type)
  if (
    !separated ||
    !patchedDefinition ||
    !validate(patchedDefinition.validator, separated.descriptorValue)
  )
    return null
  try {
    validateBlocksRichText([patched])
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
      blockId: commit.blockId,
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
  blocks: Block[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch: number,
  catalogRevision = ""
) {
  const current = capturePageField(
    blocks,
    locale,
    commit.blockId,
    commit.fieldPath,
    contentEpoch,
    catalogRevision
  )
  const old = commit.fieldBinding,
    fresh = current?.fieldBinding
  const currentBlock = blocks.find(
    (block) => readBlock(block).id === commit.blockId
  )
  if (
    !old ||
    !fresh ||
    !currentBlock ||
    old.contentEpoch !== contentEpoch ||
    old.catalogRevision !== catalogRevision ||
    old.presentation !== fresh.presentation ||
    old.descriptor !== fresh.descriptor ||
    old.lastApplied !== fresh.lastApplied ||
    current.blockType !== commit.blockType
  )
    return commit
  if (
    current.repeatedTarget
      ? !old.itemFingerprint ||
        old.itemFingerprint !== commit.repeatedTarget?.itemFingerprint ||
        !repeatedTargetMatches(
          currentBlock,
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
export function hasStructuralBlockChange(
  previous: Block[],
  next: Block[]
): boolean {
  if (
    previous.length !== next.length ||
    previous.some(
      (block, index) =>
        readBlock(block).id !== readBlock(next[index])?.id ||
        readBlock(block).type !== readBlock(next[index])?.type ||
        readBlock(block).presentationIdV1 !==
          readBlock(next[index])?.presentationIdV1 ||
        readBlock(block).enabled !== readBlock(next[index])?.enabled
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
  return previous.some((block, index) => changed(block, next[index]))
}
