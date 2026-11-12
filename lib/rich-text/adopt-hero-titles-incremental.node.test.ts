import { beforeEach, describe, expect, test, vi } from "vitest"
import { createSampleSlice } from "@/convex/lib/slices/sample"
import type { Slice } from "@/convex/lib/slices"

// A seam spy: count how many slices the page check actually re-validates.
const writeSliceFields = vi.hoisted(() => vi.fn())
const real = vi.hoisted(() => ({
  write: null as null | ((...args: unknown[]) => unknown),
}))
vi.mock("@/convex/lib/richtext/write", async (importActual) => {
  const actual =
    await importActual<typeof import("@/convex/lib/richtext/write")>()
  real.write = actual.writeSliceFields as never
  writeSliceFields.mockImplementation((...args: unknown[]) =>
    real.write!(...args)
  )
  return { ...actual, writeSliceFields }
})

import { adoptHeroTitles, prepareHeroTitleDraft } from "./adopt-hero-titles"

function hero(id: string, title?: string): Slice {
  const sample = createSampleSlice("hero-with-image")
  return {
    ...sample,
    id,
    primary: { ...sample.primary, ...(title ? { title } : {}) },
    items: sample.items.map((row, index) => ({
      ...row,
      itemId: `${id}-row-${index}`,
    })),
  } as Slice
}

const legacy = '<p><strong>Bonjour</strong> <a href="/fr">équipe</a></p>'

describe("the page title check is incremental", () => {
  beforeEach(() => {
    writeSliceFields.mockClear()
  })

  test("unchanged slice objects are not re-checked", () => {
    const slices = [hero("a"), hero("b"), hero("c")]
    const first = adoptHeroTitles(slices, "en")
    expect(writeSliceFields).toHaveBeenCalledTimes(3)
    writeSliceFields.mockClear()
    const second = adoptHeroTitles(first.value, "en")
    expect(writeSliceFields).toHaveBeenCalledTimes(0)
    expect(second.value).toBe(first.value)
  })

  test("only the slice whose identity changed is checked again", () => {
    const first = adoptHeroTitles([hero("a"), hero("b"), hero("c")], "en").value
    writeSliceFields.mockClear()
    const edited = first.map((slice, index) =>
      index === 1
        ? ({ ...slice, primary: { ...slice.primary } } as Slice)
        : slice
    )
    const next = adoptHeroTitles(edited, "en")
    expect(writeSliceFields).toHaveBeenCalledTimes(1)
    expect(next.value[0]).toBe(first[0])
    expect(next.value[2]).toBe(first[2])
  })

  test("a different locale or a write-time call never reuses the result", () => {
    const slices = adoptHeroTitles([hero("a")], "en").value
    writeSliceFields.mockClear()
    adoptHeroTitles(slices, "fr")
    expect(writeSliceFields).toHaveBeenCalledTimes(1)
    adoptHeroTitles(slices, "fr", [], true)
    adoptHeroTitles(slices, "fr", [], true)
    expect(writeSliceFields).toHaveBeenCalledTimes(3)
  })

  test("reports from a reused slice are identical to a fresh check", () => {
    const slices = [hero("a"), hero("legacy", legacy), hero("c")]
    const fresh = adoptHeroTitles(slices, "en")
    const freshReports = JSON.stringify(fresh.reports)
    expect(fresh.reports).toEqual([
      {
        locale: "en",
        sliceId: "legacy",
        fieldPath: "primary.title",
        removedLinks: [{ href: "/fr" }],
      },
    ])
    // The same input objects again: served from the reused results.
    writeSliceFields.mockClear()
    const reused = adoptHeroTitles(slices, "en")
    expect(writeSliceFields).toHaveBeenCalledTimes(0)
    expect(JSON.stringify(reused.reports)).toBe(freshReports)
    expect(reused.value).toEqual(fresh.value)
    // Previous reports for the same field still merge, not duplicate.
    const withPrevious = adoptHeroTitles(slices, "en", fresh.reports)
    expect(withPrevious.reports).toHaveLength(1)
  })

  test("prepareHeroTitleDraft keeps its report contract on reused slices", () => {
    const slices = [hero("a"), hero("legacy", legacy)]
    const first = prepareHeroTitleDraft({ slices }, "en", [])
    const again = prepareHeroTitleDraft(
      { slices },
      "en",
      first.removedTitleLinks
    )
    expect(again.removedTitleLinks).toEqual(first.removedTitleLinks)
    expect(again.slices).toEqual(first.slices)
  })
})
