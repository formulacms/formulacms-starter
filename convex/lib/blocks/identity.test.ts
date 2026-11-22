import { describe, expect, it } from "vitest"
import {
  repairBlockIds,
  blockOccurrenceKeys,
  withUniqueBlockRenderIds,
} from "./identity"

describe("Block sibling identity", () => {
  it("preserves first IDs and repairs only empty or later duplicates", () => {
    const blocks = [
      { id: "kept", value: 1 },
      { id: "", value: 2 },
      { id: "kept", value: 3 },
      { id: "reserved-candidate", value: 4 },
    ]
    const candidates = ["kept", "reserved-candidate", "fresh-a", "fresh-b"]

    const repaired = repairBlockIds(blocks, () => candidates.shift()!)

    expect(repaired).toEqual([
      blocks[0],
      { id: "fresh-a", value: 2 },
      { id: "fresh-b", value: 3 },
      blocks[3],
    ])
    expect(repaired[0]).toBe(blocks[0])
    expect(repaired[3]).toBe(blocks[3])
  })

  it("is idempotent once sibling IDs are valid", () => {
    const blocks = [{ id: "one" }, { id: "two" }]

    expect(repairBlockIds(blocks)).toBe(blocks)
    expect(repairBlockIds(repairBlockIds(blocks))).toBe(blocks)
  })

  it("repairs a legacy sibling whose ID property is missing", () => {
    const blocks = [{ id: "kept", value: 1 }, { value: 2 }]

    const repaired = repairBlockIds(blocks, () => "fresh")

    expect(repaired).toEqual([blocks[0], { id: "fresh", value: 2 }])
  })

  it("derives deterministic collision-safe render IDs without changing stored IDs", () => {
    const blocks = [
      { id: "duplicate" },
      { id: "duplicate" },
      { id: "__formulacms-legacy-block-2" },
    ]

    const first = withUniqueBlockRenderIds(blocks)
    const second = withUniqueBlockRenderIds(blocks)

    expect(first.map((block) => block.id)).toEqual([
      "duplicate",
      "__formulacms-legacy-block-2-2",
      "__formulacms-legacy-block-2",
    ])
    expect(second.map((block) => block.id)).toEqual(
      first.map((block) => block.id)
    )
    expect(blocks.map((block) => block.id)).toEqual([
      "duplicate",
      "duplicate",
      "__formulacms-legacy-block-2",
    ])
  })

  it("assigns deterministic occurrence keys to duplicate history", () => {
    expect(
      blockOccurrenceKeys([
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
