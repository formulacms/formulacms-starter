import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import { type Primitive, type Block } from "@/convex/lib/blocks"
import { isEditorialTextPrimitive } from "@/convex/lib/blocks/primitives"
import { fieldHasContent } from "./fields/field-utils"
import { readFieldText } from "@/convex/lib/richtext/transitions"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"

export type BlockTextMode = "copy" | "translate" | "write"

/**
 * Overlay editor-authored copy from `textSource` while keeping the target
 * Block's identity and structural choices. Existing List rows keep their
 * non-editorial identity; source-only rows are copied whole.
 */
export function mergeBlockText(
  target: Block,
  textSource: Block,
  primaryDef: Primitive,
  mode: BlockTextMode = "translate"
): Block {
  const def = readBlockDefinition(readBlock(target).type)
  if (!def) return target
  const primary = mergeTextValue(
    primaryDef,
    readBlock(target).primary,
    readBlock(textSource).primary,
    mode,
    { blockType: readBlock(target).type, fieldPath: "primary" }
  ) as Block["primary"]
  let next = Object.assign({}, target, { primary }) as Block
  if ("items" in target && "items" in textSource && def.items !== undefined) {
    next = Object.assign({}, next, {
      items: mergeTextValue(
        def.items,
        (target as { items?: unknown[] }).items,
        (textSource as { items?: unknown[] }).items,
        mode,
        { blockType: readBlock(target).type, fieldPath: "items" }
      ),
    }) as Block
  }
  return next
}

function mergeTextValue(
  def: Primitive,
  target: unknown,
  source: unknown,
  mode: BlockTextMode,
  address?: { blockType: string; fieldPath: string }
): unknown {
  switch (def.kind) {
    case "text":
    case "richText":
      return isEditorialTextPrimitive(def) && typeof source === "string"
        ? def.kind === "text"
          ? readFieldText(address, source)
          : // The parent draft owns title adoption and its located diagnostics.
            resolveFieldContract(def.config).contract === "title"
            ? source
            : toFieldShape(
                resolveFieldContract(
                  def.config as {
                    profile?: "inline" | "basic" | "full"
                    contract?: "title" | "inline" | "basic" | "full"
                  }
                ),
                source
              ).value
        : target
    case "relation":
      return mode === "copy" && source !== undefined ? source : target
    case "group": {
      const fields = def.config.fields as Record<string, Primitive>
      const targetObj =
        target && typeof target === "object" && !Array.isArray(target)
          ? { ...(target as Record<string, unknown>) }
          : {}
      const sourceObj =
        source && typeof source === "object" && !Array.isArray(source)
          ? (source as Record<string, unknown>)
          : {}
      for (const [key, child] of Object.entries(fields)) {
        targetObj[key] = mergeTextValue(
          child,
          targetObj[key],
          sourceObj[key],
          mode,
          address
            ? { ...address, fieldPath: `${address.fieldPath}.${key}` }
            : undefined
        )
      }
      return targetObj
    }
    case "list": {
      const itemDef = def.config.item as Primitive
      const targetItems = Array.isArray(target) ? target : []
      const sourceItems = Array.isArray(source) ? source : []
      const max = Math.max(targetItems.length, sourceItems.length)
      const next: unknown[] = []
      for (let i = 0; i < max; i++) {
        const targetItem = targetItems[i]
        const sourceItem = sourceItems[i]
        if (targetItem !== undefined && sourceItem !== undefined) {
          next.push(
            mergeTextValue(
              itemDef,
              targetItem,
              sourceItem,
              mode,
              address
                ? { ...address, fieldPath: `${address.fieldPath}[${i}]` }
                : undefined
            )
          )
        } else if (targetItem !== undefined) {
          next.push(targetItem)
        } else if (sourceItem !== undefined) {
          next.push(sourceItem)
        }
      }
      return next
    }
    default:
      return target
  }
}

/** Does this Block carry real editor-authored copy? */
export function blockHasContent(block: Block, primaryDef: Primitive): boolean {
  const def = readBlockDefinition(readBlock(block).type)
  if (!def) return false
  if (valueHasTextContent(primaryDef, readBlock(block).primary)) return true
  if (def.items !== undefined && "items" in block) {
    return valueHasTextContent(
      def.items,
      (block as { items?: unknown[] }).items
    )
  }
  return false
}

function valueHasTextContent(def: Primitive, value: unknown): boolean {
  switch (def.kind) {
    case "text":
    case "richText":
      return (
        isEditorialTextPrimitive(def) &&
        typeof value === "string" &&
        fieldHasContent(value)
      )
    case "group": {
      const fields = def.config.fields as Record<string, Primitive>
      const objectValue = (value ?? {}) as Record<string, unknown>
      return Object.entries(fields).some(([key, child]) =>
        valueHasTextContent(child, objectValue[key])
      )
    }
    case "list": {
      const itemDef = def.config.item as Primitive
      return (Array.isArray(value) ? value : []).some((item) =>
        valueHasTextContent(itemDef, item)
      )
    }
    default:
      return false
  }
}
