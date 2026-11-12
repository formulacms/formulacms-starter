import { describe, expect, test } from "vitest"
import { listItemKeys, stableItemKeys } from "./keys"

type Item = { q?: string; itemId?: string }
const keysOf = (items: Item[]) => stableItemKeys(items, (i) => i.q)

describe("stableItemKeys", () => {
  test("a key follows its item across a reorder", () => {
    // The property that matters: reordering must move keys with their items,
    // not leave them pinned to a position. This is what kept the wrong FAQ
    // panel expanded when an editor reordered questions.
    const before = [{ q: "First?" }, { q: "Second?" }, { q: "Third?" }]
    const after = [{ q: "Third?" }, { q: "First?" }, { q: "Second?" }]

    const keyFor = (items: Item[], q: string) =>
      keysOf(items)[items.findIndex((i) => i.q === q)]

    for (const q of ["First?", "Second?", "Third?"]) {
      expect(keyFor(after, q)).toBe(keyFor(before, q))
    }
  })

  test("items sharing identical content still get unique keys", () => {
    const keys = keysOf([{ q: "Same?" }, { q: "Same?" }, { q: "Same?" }])

    expect(new Set(keys).size).toBe(3)
    expect(keys[0]).toBe("Same?")
  })

  test("identity is trimmed so whitespace edits do not remount", () => {
    expect(keysOf([{ q: "  Padded?  " }])).toEqual(keysOf([{ q: "Padded?" }]))
  })

  test("items with no identity fall back to position, still unique", () => {
    const keys = keysOf([{}, { q: "" }, { q: "   " }])

    expect(new Set(keys).size).toBe(3)
  })

  test("a real value colliding with the positional fallback stays unique", () => {
    const keys = keysOf([{}, { q: "@0" }])

    expect(new Set(keys).size).toBe(2)
  })

  test("empty list produces no keys", () => {
    expect(keysOf([])).toEqual([])
  })

  test("durable IDs keep a row key through text edits", () => {
    expect(keysOf([{ itemId: "row-1", q: "Before" }])).toEqual(["itemId:row-1"])
    expect(keysOf([{ itemId: "row-1", q: "After" }])).toEqual(["itemId:row-1"])
  })
})

describe("listItemKeys", () => {
  test("prefers persisted IDs and deterministically falls back for duplicates", () => {
    expect(
      listItemKeys([{ itemId: "a" }, { itemId: "a" }, {}], ["e1", "e2", "e3"])
    ).toEqual(["itemId:a", "e2", "e3"])
  })

  test("falls back safely for undefined, null, scalar, and array rows", () => {
    const arrayRow = Object.assign(["array"], { itemId: "array-id" })
    const rows = [
      undefined,
      null,
      "scalar",
      arrayRow,
      { itemId: "identified" },
      { itemId: "duplicate" },
      { itemId: "duplicate" },
      {},
    ]

    expect(
      listItemKeys(rows, [
        "fallback-0",
        "fallback-1",
        "fallback-2",
        "fallback-3",
        "unused-identified",
        "unused-duplicate",
        "fallback-6",
        "fallback-7",
      ])
    ).toEqual([
      "fallback-0",
      "fallback-1",
      "fallback-2",
      "fallback-3",
      "itemId:identified",
      "itemId:duplicate",
      "fallback-6",
      "fallback-7",
    ])
    expect(listItemKeys(rows.slice(0, 4), [])).toEqual(["@0", "@1", "@2", "@3"])
  })

  test("does not mutate rows or allocate persisted identity", () => {
    const rows = [{ itemId: "row-1", question: "Q" }, { question: "R" }]
    const before = structuredClone(rows)
    expect(listItemKeys(rows, ["unused-for-id", "ephemeral"])).toEqual([
      "itemId:row-1",
      "ephemeral",
    ])
    expect(rows).toEqual(before)
    expect(rows[1]).not.toHaveProperty("itemId")
  })
})
