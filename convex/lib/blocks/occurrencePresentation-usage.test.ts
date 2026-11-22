import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { extractBlockOccurrenceIdentities } from "./occurrencePresentation"

const block = (
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
  test("absence and explicit default normalize together; disabled occurrences count", blockProfile([]), () => {
    const a = extractBlockOccurrenceIdentities("page", {
      en: { blocks: [block("a")] },
    })
    const b = extractBlockOccurrenceIdentities("page", {
      en: { blocks: [block("a", "default")] },
    })
    expect(a).toEqual(b)
    expect(a.occurrences).toHaveLength(1)
  })
  test("locale, Type, stored design and Page are all part of identity", blockProfile([]), () => {
    const content = {
      en: { blocks: [block("a", "centered")] },
      fr: { blocks: [block("a", "retained-design")] },
    }
    const a = extractBlockOccurrenceIdentities("one", content)
    const b = extractBlockOccurrenceIdentities("two", content)
    expect(
      new Set([...a.occurrences, ...b.occurrences].map((key) => key.key)).size
    ).toBe(4)
    expect(a.occurrences[1].presentationId).toBe("retained-design")
    expect(
      extractBlockOccurrenceIdentities("one", {
        en: { blocks: [block("a", "centered", "rich-text-body")] },
      }).occurrences[0].key
    ).not.toBe(a.occurrences[0].key)
  })
  test.each([undefined, "", "same"])(
    "missing/duplicate ID %s marks relevant Types unavailable", blockProfile([]),
    (id) => {
      const result = extractBlockOccurrenceIdentities("page", {
        en: { blocks: [block("same"), { ...block("b"), id }] },
      })
      expect(result.invalidTypes).toEqual(["hero-with-image"])
      expect(result.occurrences).toEqual([])
    }
  )
  test("plain structured-looking text and nested row IDs are never parsed or mutated", blockProfile([]), () => {
    const content = { en: { blocks: [block("a")] } }
    const before = JSON.stringify(content)
    expect(
      extractBlockOccurrenceIdentities("page", content).occurrences
    ).toHaveLength(1)
    expect(JSON.stringify(content)).toBe(before)
  })
  test("unknown source shape is unavailable, while legitimately empty content is empty", () => {
    expect(extractBlockOccurrenceIdentities("page", null).unknownInvalid).toBe(
      true
    )
    expect(
      extractBlockOccurrenceIdentities("page", { en: { blocks: [] } })
    ).toEqual({ occurrences: [], invalidTypes: [], unknownInvalid: false })
    expect(
      extractBlockOccurrenceIdentities("page", { en: { blocks: [null] } })
        .unknownInvalid
    ).toBe(true)
  })
})
