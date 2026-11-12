import { describe, expect, it } from "vitest"
import {
  repairSliceIds,
  sliceOccurrenceKeys,
  withUniqueSliceRenderIds,
} from "./identity"

describe("Slice sibling identity", () => {
  it("preserves first IDs and repairs only empty or later duplicates", () => {
    const slices = [
      { id: "kept", value: 1 },
      { id: "", value: 2 },
      { id: "kept", value: 3 },
      { id: "reserved-candidate", value: 4 },
    ]
    const candidates = ["kept", "reserved-candidate", "fresh-a", "fresh-b"]

    const repaired = repairSliceIds(slices, () => candidates.shift()!)

    expect(repaired).toEqual([
      slices[0],
      { id: "fresh-a", value: 2 },
      { id: "fresh-b", value: 3 },
      slices[3],
    ])
    expect(repaired[0]).toBe(slices[0])
    expect(repaired[3]).toBe(slices[3])
  })

  it("is idempotent once sibling IDs are valid", () => {
    const slices = [{ id: "one" }, { id: "two" }]

    expect(repairSliceIds(slices)).toBe(slices)
    expect(repairSliceIds(repairSliceIds(slices))).toBe(slices)
  })

  it("repairs a legacy sibling whose ID property is missing", () => {
    const slices = [{ id: "kept", value: 1 }, { value: 2 }]

    const repaired = repairSliceIds(slices, () => "fresh")

    expect(repaired).toEqual([slices[0], { id: "fresh", value: 2 }])
  })

  it("derives deterministic collision-safe render IDs without changing stored IDs", () => {
    const slices = [
      { id: "duplicate" },
      { id: "duplicate" },
      { id: "__formulacms-legacy-slice-2" },
    ]

    const first = withUniqueSliceRenderIds(slices)
    const second = withUniqueSliceRenderIds(slices)

    expect(first.map((slice) => slice.id)).toEqual([
      "duplicate",
      "__formulacms-legacy-slice-2-2",
      "__formulacms-legacy-slice-2",
    ])
    expect(second.map((slice) => slice.id)).toEqual(
      first.map((slice) => slice.id)
    )
    expect(slices.map((slice) => slice.id)).toEqual([
      "duplicate",
      "duplicate",
      "__formulacms-legacy-slice-2",
    ])
  })

  it("assigns deterministic occurrence keys to duplicate history", () => {
    expect(
      sliceOccurrenceKeys([
        { id: "duplicate" },
        { id: "other" },
        { id: "duplicate" },
        { id: "" },
      ])
    ).toEqual([
      '["id","duplicate",0]',
      '["id","other",0]',
      '["id","duplicate",1]',
      '["missing","string","",0]',
    ])
  })
})
