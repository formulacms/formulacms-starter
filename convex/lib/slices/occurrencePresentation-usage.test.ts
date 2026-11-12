import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { extractSliceOccurrenceIdentities } from "./occurrencePresentation"

const slice = (
  id: string,
  presentationIdV1?: string,
  type = "hero-with-image"
) => ({
  id,
  type,
  enabled: false,
  ...(presentationIdV1 === undefined ? {} : { presentationIdV1 }),
  primary: {
    text: '<p>{"looks":"structured"}</p>',
    nested: [{ id: "not-an-occurrence" }],
  },
})

describe("retained occurrence identity policy", () => {
  test("absence and explicit default normalize together; disabled occurrences count", sliceProfile([]), () => {
    const a = extractSliceOccurrenceIdentities("page", {
      en: { slices: [slice("a")] },
    })
    const b = extractSliceOccurrenceIdentities("page", {
      en: { slices: [slice("a", "default")] },
    })
    expect(a).toEqual(b)
    expect(a.occurrences).toHaveLength(1)
  })
  test("locale, Type, stored design and Page are all part of identity", sliceProfile([]), () => {
    const content = {
      en: { slices: [slice("a", "centered")] },
      fr: { slices: [slice("a", "retained-design")] },
    }
    const a = extractSliceOccurrenceIdentities("one", content)
    const b = extractSliceOccurrenceIdentities("two", content)
    expect(
      new Set([...a.occurrences, ...b.occurrences].map((key) => key.key)).size
    ).toBe(4)
    expect(a.occurrences[1].presentationId).toBe("retained-design")
    expect(
      extractSliceOccurrenceIdentities("one", {
        en: { slices: [slice("a", "centered", "rich-text-body")] },
      }).occurrences[0].key
    ).not.toBe(a.occurrences[0].key)
  })
  test.each([undefined, "", "same"])(
    "missing/duplicate ID %s marks relevant Types unavailable", sliceProfile([]),
    (id) => {
      const result = extractSliceOccurrenceIdentities("page", {
        en: { slices: [slice("same"), { ...slice("b"), id }] },
      })
      expect(result.invalidTypes).toEqual(["hero-with-image"])
      expect(result.occurrences).toEqual([])
    }
  )
  test("plain structured-looking text and nested row IDs are never parsed or mutated", sliceProfile([]), () => {
    const content = { en: { slices: [slice("a")] } }
    const before = JSON.stringify(content)
    expect(
      extractSliceOccurrenceIdentities("page", content).occurrences
    ).toHaveLength(1)
    expect(JSON.stringify(content)).toBe(before)
  })
  test("unknown source shape is unavailable, while legitimately empty content is empty", () => {
    expect(extractSliceOccurrenceIdentities("page", null).unknownInvalid).toBe(
      true
    )
    expect(
      extractSliceOccurrenceIdentities("page", { en: { slices: [] } })
    ).toEqual({ occurrences: [], invalidTypes: [], unknownInvalid: false })
    expect(
      extractSliceOccurrenceIdentities("page", { en: { slices: [null] } })
        .unknownInvalid
    ).toBe(true)
  })
})
