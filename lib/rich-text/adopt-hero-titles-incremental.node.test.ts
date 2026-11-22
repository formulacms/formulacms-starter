import { beforeEach, describe, expect, test, vi } from "vitest"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
import type { Block } from "@/convex/lib/blocks"

// A seam spy: count how many blocks the page check actually re-validates.
const writeBlockFields = vi.hoisted(() => vi.fn())
const real = vi.hoisted(() => ({
  write: null as null | ((...args: unknown[]) => unknown),
}))
vi.mock("@/convex/lib/richtext/write", async (importActual) => {
  const actual =
    await importActual<typeof import("@/convex/lib/richtext/write")>()
  real.write = actual.writeBlockFields as never
  writeBlockFields.mockImplementation((...args: unknown[]) =>
    real.write!(...args)
  )
  return { ...actual, writeBlockFields }
})

import { adoptHeroTitles, prepareHeroTitleDraft } from "./adopt-hero-titles"

function hero(id: string, title?: string): Block {
  const sample = createSampleBlock("hero-with-image")
  return {
    ...sample,
    id,
    primary: { ...sample.primary, ...(title ? { title } : {}) },
    items: sample.items.map((row, index) => ({
      ...row,
      itemId: `${id}-row-${index}`,
    })),
  } as Block
}

const legacy = '<p><strong>Bonjour</strong> <a href="/fr">équipe</a></p>'

describe("the page title check is incremental", () => {
  beforeEach(() => {
    writeBlockFields.mockClear()
  })

  test("unchanged block objects are not re-checked", () => {
    const blocks = [hero("a"), hero("b"), hero("c")]
    const first = adoptHeroTitles(blocks, "en")
    expect(writeBlockFields).toHaveBeenCalledTimes(3)
    writeBlockFields.mockClear()
    const second = adoptHeroTitles(first.value, "en")
    expect(writeBlockFields).toHaveBeenCalledTimes(0)
    expect(second.value).toBe(first.value)
  })

  test("only the block whose identity changed is checked again", () => {
    const first = adoptHeroTitles([hero("a"), hero("b"), hero("c")], "en").value
    writeBlockFields.mockClear()
    const edited = first.map((block, index) =>
      index === 1
        ? ({ ...block, primary: { ...block.primary } } as Block)
        : block
    )
    const next = adoptHeroTitles(edited, "en")
    expect(writeBlockFields).toHaveBeenCalledTimes(1)
    expect(next.value[0]).toBe(first[0])
    expect(next.value[2]).toBe(first[2])
  })

  test("a different locale or a write-time call never reuses the result", () => {
    const blocks = adoptHeroTitles([hero("a")], "en").value
    writeBlockFields.mockClear()
    adoptHeroTitles(blocks, "fr")
    expect(writeBlockFields).toHaveBeenCalledTimes(1)
    adoptHeroTitles(blocks, "fr", [], true)
    adoptHeroTitles(blocks, "fr", [], true)
    expect(writeBlockFields).toHaveBeenCalledTimes(3)
  })

  test("reports from a reused block are identical to a fresh check", () => {
    const blocks = [hero("a"), hero("legacy", legacy), hero("c")]
    const fresh = adoptHeroTitles(blocks, "en")
    const freshReports = JSON.stringify(fresh.reports)
    expect(fresh.reports).toEqual([
      {
        locale: "en",
        blockId: "legacy",
        fieldPath: "primary.title",
        removedLinks: [{ href: "/fr" }],
      },
    ])
    // The same input objects again: served from the reused results.
    writeBlockFields.mockClear()
    const reused = adoptHeroTitles(blocks, "en")
    expect(writeBlockFields).toHaveBeenCalledTimes(0)
    expect(JSON.stringify(reused.reports)).toBe(freshReports)
    expect(reused.value).toEqual(fresh.value)
    // Previous reports for the same field still merge, not duplicate.
    const withPrevious = adoptHeroTitles(blocks, "en", fresh.reports)
    expect(withPrevious.reports).toHaveLength(1)
  })

  test("prepareHeroTitleDraft keeps its report contract on reused blocks", () => {
    const blocks = [hero("a"), hero("legacy", legacy)]
    const first = prepareHeroTitleDraft({ blocks }, "en", [])
    const again = prepareHeroTitleDraft(
      { blocks },
      "en",
      first.removedTitleLinks
    )
    expect(again.removedTitleLinks).toEqual(first.removedTitleLinks)
    expect(again.blocks).toEqual(first.blocks)
  })
})
