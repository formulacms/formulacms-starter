import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { type Primitive, type Slice } from "@/convex/lib/slices"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import {
  isLegacyTitleHtml,
  isRecord,
  writeSliceFields,
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
        report.sliceId,
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
  slices: Slice[],
  locale: string,
  previous: TitleWriteReport[] = [],
  forWrite = false
) {
  const reports = previous.filter(
    (report) =>
      report.locale !== locale ||
      slices.some((slice) => readSlice(slice).id === report.sliceId)
  )
  function applyReport(report: TitleWriteReport) {
    const at = reports.findIndex(
      (row) =>
        row.locale === locale &&
        row.sliceId === report.sliceId &&
        row.fieldPath === report.fieldPath
    )
    if (at < 0) reports.push(report)
    else reports[at] = mergeTitleReports([reports[at]], [report])[0]
  }
  const value = slices.map((slice) => {
    // Adopting one slice is a pure function of that slice object, so an
    // unchanged slice (same identity) reuses the previous result instead of
    // being validated again on every keystroke. `forWrite` may allocate item
    // ids, so write-time adoption never reuses.
    const cached = forWrite ? undefined : adoptedSliceCache.get(slice)
    if (cached && cached.locale === locale) {
      for (const report of cached.produced) applyReport(report)
      return cached.out
    }
    const produced: TitleWriteReport[] = []
    const out = adoptSlice(slice, locale, forWrite, produced)
    for (const report of produced) applyReport(report)
    if (!forWrite) adoptedSliceCache.set(slice, { locale, out, produced })
    return out
  })
  return {
    value: value.every((slice, index) => slice === slices[index])
      ? slices
      : value,
    reports,
  }
}

type AdoptedSlice = {
  locale: string
  out: Slice
  produced: TitleWriteReport[]
}
const adoptedSliceCache = new WeakMap<Slice, AdoptedSlice>()

/** Adopt one slice. Reports are returned in the order they were produced so
 * callers can merge them into the draft-wide list exactly as before.
 */
function adoptSlice(
  slice: Slice,
  locale: string,
  forWrite: boolean,
  produced: TitleWriteReport[]
): Slice {
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
        sliceType: readSlice(slice).type,
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
        sliceId: readSlice(slice).id,
        fieldPath: path,
        removedLinks: adopted.removedLinks,
      })
    return adopted.value
  }
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return slice
  const next = Object.assign({}, slice, {
    primary: adoptField(def.primary, readSlice(slice).primary, "primary"),
  }) as Slice
  if (def.items !== undefined && "items" in slice)
    Object.assign(next, {
      items: adoptField(def.items, readSlice(slice).items, "items"),
    })
  const written = writeSliceFields(next, locale, {
    allocateItemIds: forWrite,
  })
  produced.push(...written.reports)
  // A title is one line: any stored break becomes a space on save.
  const out = forWrite ? canonicalSliceTitles(written.value, def) : written.value
  return JSON.stringify(out) === JSON.stringify(slice) ? slice : out
}

/** Apply the shared one-line canonicaliser to every descriptor-declared title in a slice. */
function canonicalSliceTitles(
  slice: Slice,
  def: NonNullable<ReturnType<typeof readSliceDefinition>>
): Slice {
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
  const next = Object.assign({}, slice, {
    primary: trim(def.primary, readSlice(slice).primary),
  }) as Slice
  if (def.items !== undefined && "items" in slice)
    Object.assign(next, { items: trim(def.items, readSlice(slice).items) })
  return next
}

/** Prepare a complete incoming title-bearing draft without publishing any state.
 * Every fallible conversion finishes here; consumers commit this exact result.
 */
export function prepareHeroTitleDraft<
  T extends {
    slices: Slice[]
    removedTitleLinks?: TitleWriteReport[]
  },
>(draft: T, locale: string, previous: TitleWriteReport[] = []) {
  const adopted = adoptHeroTitles(
    draft.slices,
    locale,
    mergeTitleReports(previous, draft.removedTitleLinks ?? [])
  )
  return { ...draft, slices: adopted.value, removedTitleLinks: adopted.reports }
}
