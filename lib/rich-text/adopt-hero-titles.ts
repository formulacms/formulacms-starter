import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import { type Primitive, type Block } from "@/convex/lib/blocks"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import {
  isLegacyTitleHtml,
  isRecord,
  writeBlockFields,
  type TitleWriteReport,
} from "@/convex/lib/richtext/write"
import { mergeRemovedLinks } from "@/convex/lib/richtext/shape"
import { parseLegacyTitle, canonicalTitleLine } from "./title-write"
import { prepareLegacyRichText } from "./legacy-html"
import { transitionForField } from "@/convex/lib/richtext/transitions"

export function mergeTitleReports(
  ...groups: TitleWriteReport[][]
): TitleWriteReport[] {
  const reports = new Map<string, TitleWriteReport>()
  for (const group of groups)
    for (const report of group) {
      const key = JSON.stringify([
        report.locale,
        report.blockId,
        report.fieldPath,
      ])
      const previous = reports.get(key)
      reports.set(key, {
        ...report,
        removedLinks: mergeRemovedLinks(
          previous?.removedLinks ?? [],
          report.removedLinks
        ),
      })
    }
  return [...reports.values()]
}

/** Historical API name; adopts every descriptor-declared title in the parent
 * draft, never just the mounted field's display value.
 * Callers keep the located diagnostics with their draft/recovery state.
 */
export function adoptHeroTitles(
  blocks: Block[],
  locale: string,
  previous: TitleWriteReport[] = [],
  forWrite = false
) {
  const reports = previous.filter(
    (report) =>
      report.locale !== locale ||
      blocks.some((block) => readBlock(block).id === report.blockId)
  )
  function applyReport(report: TitleWriteReport) {
    const at = reports.findIndex(
      (row) =>
        row.locale === locale &&
        row.blockId === report.blockId &&
        row.fieldPath === report.fieldPath
    )
    if (at < 0) reports.push(report)
    else reports[at] = mergeTitleReports([reports[at]], [report])[0]
  }
  const value = blocks.map((block) => {
    // Adopting one block is a pure function of that block object, so an
    // unchanged block (same identity) reuses the previous result instead of
    // being validated again on every keystroke. `forWrite` may allocate item
    // ids, so write-time adoption never reuses.
    const cached = forWrite ? undefined : adoptedBlockCache.get(block)
    if (cached && cached.locale === locale) {
      for (const report of cached.produced) applyReport(report)
      return cached.out
    }
    const produced: TitleWriteReport[] = []
    const out = adoptBlock(block, locale, forWrite, produced)
    for (const report of produced) applyReport(report)
    if (!forWrite) adoptedBlockCache.set(block, { locale, out, produced })
    return out
  })
  return {
    value: value.every((block, index) => block === blocks[index])
      ? blocks
      : value,
    reports,
  }
}

type AdoptedBlock = {
  locale: string
  out: Block
  produced: TitleWriteReport[]
}
const adoptedBlockCache = new WeakMap<Block, AdoptedBlock>()

/** Adopt one block. Reports are returned in the order they were produced so
 * callers can merge them into the draft-wide list exactly as before.
 */
function adoptBlock(
  block: Block,
  locale: string,
  forWrite: boolean,
  produced: TitleWriteReport[]
): Block {
  function adoptField(def: Primitive, value: unknown, path: string): unknown {
    if (def.kind === "group" && isRecord(value)) {
      const next = { ...value }
      for (const [key, child] of Object.entries(
        def.config.fields as Record<string, Primitive>
      ))
        if (key in value)
          next[key] = adoptField(child, value[key], `${path}.${key}`)
      return next
    }
    if (def.kind === "list" && Array.isArray(value))
      return value.map((row, index) =>
        adoptField(def.config.item as Primitive, row, `${path}[${index}]`)
      )
    if (def.kind === "richText" && typeof value === "string") {
      const contract = resolveFieldContract(def.config).contract
      if (contract !== "title") return prepareLegacyRichText(value, contract)
    }
    if (
      def.kind !== "richText" ||
      resolveFieldContract(def.config).contract !== "title" ||
      transitionForField({
        blockType: readBlock(block).type,
        fieldPath: path,
      }) ||
      typeof value !== "string" ||
      !isLegacyTitleHtml(value)
    )
      return value
    const adopted = parseLegacyTitle(value)
    if (adopted.removedLinks.length)
      produced.push({
        locale,
        blockId: readBlock(block).id,
        fieldPath: path,
        removedLinks: adopted.removedLinks,
      })
    return adopted.value
  }
  const def = readBlockDefinition(readBlock(block).type)
  if (!def) return block
  const next = Object.assign({}, block, {
    primary: adoptField(def.primary, readBlock(block).primary, "primary"),
  }) as Block
  if (def.items !== undefined && "items" in block)
    Object.assign(next, {
      items: adoptField(def.items, readBlock(block).items, "items"),
    })
  const written = writeBlockFields(next, locale, {
    allocateItemIds: forWrite,
  })
  produced.push(...written.reports)
  // A title is one line: any stored break becomes a space on save.
  const out = forWrite ? canonicalBlockTitles(written.value, def) : written.value
  return JSON.stringify(out) === JSON.stringify(block) ? block : out
}

/** Apply the shared one-line canonicaliser to every descriptor-declared title in a block. */
function canonicalBlockTitles(
  block: Block,
  def: NonNullable<ReturnType<typeof readBlockDefinition>>
): Block {
  function trim(field: Primitive, value: unknown): unknown {
    if (field.kind === "group" && isRecord(value)) {
      const next = { ...value }
      for (const [key, child] of Object.entries(
        field.config.fields as Record<string, Primitive>
      ))
        if (key in value) next[key] = trim(child, value[key])
      return next
    }
    if (field.kind === "list" && Array.isArray(value))
      return value.map((row) => trim(field.config.item as Primitive, row))
    if (field.kind === "richText" && typeof value === "string") {
      const resolved = resolveFieldContract(field.config)
      if (resolved.contract === "title")
        return canonicalTitleLine(value, resolved)
    }
    return value
  }
  const next = Object.assign({}, block, {
    primary: trim(def.primary, readBlock(block).primary),
  }) as Block
  if (def.items !== undefined && "items" in block)
    Object.assign(next, { items: trim(def.items, readBlock(block).items) })
  return next
}

/** Prepare a complete incoming title-bearing draft without publishing any state.
 * Every fallible conversion finishes here; consumers commit this exact result.
 */
export function prepareHeroTitleDraft<
  T extends {
    blocks: Block[]
    removedTitleLinks?: TitleWriteReport[]
  },
>(draft: T, locale: string, previous: TitleWriteReport[] = []) {
  const adopted = adoptHeroTitles(
    draft.blocks,
    locale,
    mergeTitleReports(previous, draft.removedTitleLinks ?? [])
  )
  return { ...draft, blocks: adopted.value, removedTitleLinks: adopted.reports }
}
