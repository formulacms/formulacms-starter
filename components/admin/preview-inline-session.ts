import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { adoptHeroTitles } from "@/lib/rich-text/adopt-hero-titles"
import { toFieldShape, mergeRemovedLinks } from "@/convex/lib/richtext/shape"
import { validate } from "convex-helpers/validators"
import { type Primitive, type Block } from "@/convex/lib/blocks"
import { validateBlocksRichText } from "@/convex/lib/blocks/validate"
import { separateBlockOccurrencePresentation } from "@/convex/lib/blocks/occurrencePresentation"
import type { PreviewInlineEditCommit } from "./visual-editing-types"
import {
  applyPreviewInlineEdit,
  currentBlockOccurrence,
} from "./page-editor/lib/block-occurrence"
import { parseFieldPath } from "./page-editor/lib/field-path"
import { repeatedItemIdentity } from "./page-editor/lib/repeated-item-identity"

export type PreviewInlineSession = Omit<PreviewInlineEditCommit, "value"> & {
  draft: string
  cancellationValue: string
  label: string
}

/** Resolve writes through the installed descriptor, never through displayed text. */
function descriptorAtPath(
  block: Block,
  fieldPath: string
): Primitive | undefined {
  const [root, ...path] = parseFieldPath(fieldPath)
  const def = readBlockDefinition(readBlock(block).type)
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
  blocks: Block[],
  locale: string,
  session: PreviewInlineSession,
  contentEpoch = 0
): PreviewInlineEditCommit | null {
  if (session.sourceInvalidated) return null
  const block = currentBlockOccurrence(blocks, locale, session, contentEpoch)
  if (!block || readBlock(block).enabled === false) return null
  const expectedTarget = repeatedItemIdentity(
    block,
    session.fieldPath,
    contentEpoch
  )
  if (
    expectedTarget === null ||
    JSON.stringify(expectedTarget) !== JSON.stringify(session.repeatedTarget)
  )
    return null
  const descriptor = descriptorAtPath(block, session.fieldPath)
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
    blockId: session.blockId,
    blockType: session.blockType,
    expectedBlock: session.expectedBlock,
    fieldPath: session.fieldPath,
    kind: session.kind,
    value: shaped.value,
    ...(removedLinks.length ? { removedLinks } : {}),
  }
  const projected = applyPreviewInlineEdit(blocks, locale, commit, contentEpoch)
  const patched = projected.find(
    (entry) => readBlock(entry).id === readBlock(block).id
  )
  const occurrence = readBlock(patched)
  const separated = occurrence
    ? separateBlockOccurrencePresentation(occurrence)
    : null
  const patchedDefinition = readBlockDefinition(occurrence?.type ?? "")
  if (
    !patched ||
    !separated ||
    !patchedDefinition ||
    !validate(patchedDefinition.validator, separated.descriptorValue)
  )
    return null
  try {
    const scratch = adoptHeroTitles([patched], locale).value
    validateBlocksRichText(scratch)
  } catch {
    return null
  }
  return commit
}

export function projectPreviewSession(
  blocks: Block[],
  locale: string,
  session: PreviewInlineSession | null,
  contentEpoch = 0
): Block[] {
  const commit =
    session && validatedPreviewCommit(blocks, locale, session, contentEpoch)
  return commit
    ? applyPreviewInlineEdit(blocks, locale, commit, contentEpoch)
    : blocks
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
    session.expectedBlock !== commit.expectedBlock ||
    session.locale !== commit.locale ||
    session.blockId !== commit.blockId ||
    session.blockType !== commit.blockType ||
    session.fieldPath !== commit.fieldPath ||
    session.kind !== commit.kind ||
    JSON.stringify(session.repeatedTarget) !==
      JSON.stringify(commit.repeatedTarget)
  )
    return session
  let base: Block
  try {
    base = JSON.parse(commit.expectedBlock) as Block
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
    expectedBlock: JSON.stringify(patched),
    ...(repeatedTarget ? { repeatedTarget } : {}),
    cancellationValue: commit.value,
  }
}
