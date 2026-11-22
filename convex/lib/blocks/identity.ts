import type { GenericValidator } from "convex/values"
import type { Primitive } from "./primitives"
import type { AIHint, Block } from "."

export const INVALID_BLOCK_IDENTITY_MESSAGE =
  "Each block on a page must have its own non-empty ID. Refresh the editor and save again."

function isNonEmptyBlockId(id: unknown): id is string {
  return typeof id === "string" && id.trim().length > 0
}

function collectReservedBlockIds(
  blocks: readonly { id?: unknown }[]
): Set<string> {
  const reserved = new Set<string>()
  for (const block of blocks) {
    if (isNonEmptyBlockId(block.id)) reserved.add(block.id)
  }
  return reserved
}

/** Whether every sibling has a non-empty ID that occurs exactly once. */
export function hasUniqueBlockIds(
  blocks: readonly { id?: unknown }[]
): boolean {
  const seen = new Set<string>()
  for (const block of blocks) {
    if (!isNonEmptyBlockId(block.id) || seen.has(block.id)) {
      return false
    }
    seen.add(block.id)
  }
  return true
}

/**
 * Repair legacy sibling identity without changing valid IDs or row content.
 * Candidate IDs are checked against the complete stored list as well as IDs
 * generated earlier in this repair, so even a theoretical UUID collision is
 * retried safely.
 */
export function repairBlockIds<T extends { id: string }>(
  blocks: readonly T[],
  createId?: () => string
): T[]
export function repairBlockIds<T extends { id?: unknown }>(
  blocks: readonly T[],
  createId?: () => string
): Array<T & { id: string }>
export function repairBlockIds<T extends { id?: unknown }>(
  blocks: readonly T[],
  createId: () => string = () => crypto.randomUUID()
): Array<T & { id: string }> {
  if (hasUniqueBlockIds(blocks)) {
    return blocks as Array<T & { id: string }>
  }

  const reserved = collectReservedBlockIds(blocks)
  const used = new Set<string>()

  return blocks.map((block) => {
    if (isNonEmptyBlockId(block.id) && !used.has(block.id)) {
      used.add(block.id)
      return block as T & { id: string }
    }

    let id = createId()
    while (!isNonEmptyBlockId(id) || reserved.has(id) || used.has(id)) {
      id = createId()
    }
    used.add(id)
    return { ...block, id }
  })
}

/** Repair each locale's independent sibling list without crossing locale scope. */
export function repairLocalizedBlockIds<
  TBlock extends { id?: unknown },
  TLocale extends { blocks?: TBlock[] },
  TContent extends Record<string, TLocale>,
>(
  content: TContent | undefined,
  createId: () => string = () => crypto.randomUUID()
): TContent | undefined {
  if (!content) return content
  let changed = false
  const entries = Object.entries(content).map(([locale, localized]) => {
    if (!localized.blocks) return [locale, localized] as const
    const blocks = repairBlockIds(localized.blocks, createId)
    if (blocks === localized.blocks) return [locale, localized] as const
    changed = true
    return [locale, { ...localized, blocks }] as const
  })
  return changed ? (Object.fromEntries(entries) as TContent) : content
}

/**
 * Stable publish-time repair for legacy rows. Approval digests and the later
 * promote transaction must normalize the same invalid sibling list to the
 * same IDs; random UUID repair would make an unchanged approved draft drift.
 */
export function repairLocalizedBlockIdsForPublish<
  TBlock extends { id?: unknown },
  TLocale extends { blocks?: TBlock[] },
  TContent extends Record<string, TLocale>,
>(content: TContent | undefined): TContent | undefined {
  let sequence = 0
  return repairLocalizedBlockIds(content, () => {
    sequence += 1
    return `formulacms-repaired-block-${sequence}`
  })
}

/**
 * Give legacy-invalid siblings deterministic transient IDs for React keys,
 * refs, selection, and Block-derived DOM IDs. Valid stored IDs are preserved
 * exactly; no random value is created during server or client render.
 */
export function withUniqueBlockRenderIds<T extends { id: string }>(
  blocks: readonly T[]
): T[]
export function withUniqueBlockRenderIds<T extends { id?: unknown }>(
  blocks: readonly T[]
): Array<T & { id: string }>
export function withUniqueBlockRenderIds<T extends { id?: unknown }>(
  blocks: readonly T[]
): Array<T & { id: string }> {
  if (hasUniqueBlockIds(blocks)) {
    return blocks as Array<T & { id: string }>
  }

  const reserved = collectReservedBlockIds(blocks)
  const used = new Set<string>()

  return blocks.map((block, index) => {
    if (isNonEmptyBlockId(block.id) && !used.has(block.id)) {
      used.add(block.id)
      return block as T & { id: string }
    }

    const base = `__formulacms-legacy-block-${index + 1}`
    let id = base
    let suffix = 2
    while (reserved.has(id) || used.has(id)) {
      id = `${base}-${suffix}`
      suffix += 1
    }
    used.add(id)
    return { ...block, id }
  })
}

/**
 * Deterministic occurrence identity for drifted revision history. Duplicate
 * logical identity cannot be recovered through arbitrary reorder, but pairing
 * the nth occurrence on each side keeps every archived sibling visible.
 */
export function blockOccurrenceKeys(
  blocks: readonly { id?: unknown }[]
): string[] {
  const counts = new Map<string, number>()
  return blocks.map((block) => {
    const identity = isNonEmptyBlockId(block.id)
      ? (["id", block.id] as const)
      : (["missing", typeof block.id, block.id ?? null] as const)
    const groupKey = JSON.stringify(identity)
    const occurrence = counts.get(groupKey) ?? 0
    counts.set(groupKey, occurrence + 1)
    return JSON.stringify([...identity, occurrence])
  })
}

/** Read contracts only. Admission remains the exact generated Block validators. */
export type BlockStructure = {
  id: string
  type: string
  enabled: boolean
  primary: Record<string, unknown>
  items?: unknown[]
  presentationIdV1?: string
}

export type BlockDescriptorStructure = {
  type: string
  primary: Primitive
  items?: Primitive
  validator: GenericValidator
  aiHint: AIHint
  preview?: { primary?: unknown; items?: unknown }
}

/** A read view preserves concrete inputs; an impossible branch still has structure. */
type BlockRead<T> = [Exclude<T, null | undefined>] extends [never]
  ? BlockStructure | Extract<T, null | undefined>
  : T

export function readBlock<T extends BlockStructure | null | undefined>(
  value: T
): BlockRead<T>
export function readBlock(value: BlockStructure | null | undefined) {
  return value
}

/** Discriminator proof preserves the caller's exact admitted value. */
export function hasBlockType<T extends BlockStructure, Type extends string>(
  value: T,
  type: Type
): value is T & { type: Type } {
  return value.type === type
}

/** Exact admitted discriminator for calls whose public contract remains closed. */
export function blockTypeOf(value: Block): Block["type"]
export function blockTypeOf(value: BlockStructure): string {
  return value.type
}
