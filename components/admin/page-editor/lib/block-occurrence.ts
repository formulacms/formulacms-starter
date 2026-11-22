import { readBlock } from "@/convex/lib/blocks/identity"
import type { Block } from "@/convex/lib/blocks"
import type {
  PreviewInlineEditCommit,
  BlockOccurrenceBaseline,
} from "../../visual-editing-types"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"
import {
  repeatedItemIdentity,
  repeatedTargetMatches,
} from "./repeated-item-identity"

/** Capture the complete occurrence, including list order, before an interaction. */
export function captureBlockOccurrence(
  blocks: Block[],
  locale: string,
  blockId: string,
  fieldPath?: string,
  contentEpoch = 0
): BlockOccurrenceBaseline | null {
  const matches = blocks.filter((block) => readBlock(block).id === blockId)
  if (!blockId.trim() || matches.length !== 1) return null
  const block = matches[0]
  const repeated = fieldPath
    ? repeatedItemIdentity(block, fieldPath, contentEpoch)
    : undefined
  if (repeated === null) return null
  return {
    ...(repeated ? { repeatedTarget: repeated } : {}),
    locale,
    blockId,
    blockType: readBlock(block).type,
    expectedBlock: JSON.stringify(block),
  }
}

export function currentBlockOccurrence(
  blocks: Block[],
  locale: string,
  baseline: BlockOccurrenceBaseline,
  contentEpoch = 0
): Block | undefined {
  if (baseline.sourceInvalidated || locale !== baseline.locale) return undefined
  const matches = blocks.filter(
    (block) => readBlock(block).id === baseline.blockId
  )
  if (matches.length !== 1) return undefined
  const block = matches[0]
  const repeated = baseline.repeatedTarget
  if (repeated && !repeatedTargetMatches(block, repeated, contentEpoch))
    return undefined
  return readBlock(block).type === baseline.blockType &&
    JSON.stringify(block) === baseline.expectedBlock
    ? block
    : undefined
}

export function applyPreviewInlineEdit(
  blocks: Block[],
  locale: string,
  commit: PreviewInlineEditCommit,
  contentEpoch = 0
): Block[] {
  const target = currentBlockOccurrence(blocks, locale, commit, contentEpoch)
  if (!target) return blocks
  const path = parseFieldPath(commit.fieldPath)
  const expected = repeatedItemIdentity(target, commit.fieldPath, contentEpoch)
  if (
    expected === null ||
    JSON.stringify(expected) !== JSON.stringify(commit.repeatedTarget)
  )
    return blocks
  if (path[0] !== "primary" && path[0] !== "items") return blocks
  return blocks.map((block) =>
    block === target
      ? (setValueAtFieldPath(block, path, commit.value) as Block)
      : block
  )
}
