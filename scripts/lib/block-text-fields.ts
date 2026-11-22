import {
  readBlockDefinition,
  type InstalledBlockType,
} from "@/convex/lib/blocks"
import { isEditorialTextPrimitive } from "@/convex/lib/blocks/primitives"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { walkValue } from "@/convex/lib/blocks/walk"

/**
 * The simulator makes at most this many text fields of a block click-editable
 * (`sampleFields`, and the editor bridge refuses more), so the click check can
 * click no more than that.
 */
export const SIM_TEXT_FIELD_LIMIT = 10

/**
 * Every editorial text field of the block's sample, chosen and ordered as the
 * simulator's `sampleFields` does, so field 11 here is field 11 there. The
 * descriptor says whether the block has text at all, so a block whose text
 * lost its markers still fails the check.
 */
export function sampleTextPaths(type: InstalledBlockType): string[] {
  const def = readBlockDefinition(type)
  const block = createSampleBlock(type) as { primary: unknown; items?: unknown }
  const paths: string[] = []
  const visit: Parameters<typeof walkValue>[2] = ({ def, value, path, key }) => {
    if (typeof value === "string" && key !== "icon" && isEditorialTextPrimitive(def))
      paths.push(path.replace(/\[(\d+)\]/g, ".$1"))
  }
  walkValue(def.primary, block.primary, visit, "primary")
  if (def.items) walkValue(def.items, block.items, visit, "items")
  return paths
}

/**
 * What the check says about a block's text fields: a block with none passes
 * with a note; fields past the simulator's limit are named, never silent.
 */
export function describeTextFields(
  type: string,
  paths: readonly string[]
): { note?: string; warning?: string } {
  if (!paths.length)
    return { note: `${type}: no text field to click; click checks skipped.` }
  if (paths.length > SIM_TEXT_FIELD_LIMIT)
    return {
      warning: `${type}: fields ${SIM_TEXT_FIELD_LIMIT + 1}+ not clicked: ${paths.slice(SIM_TEXT_FIELD_LIMIT).join(", ")}`,
    }
  return {}
}
