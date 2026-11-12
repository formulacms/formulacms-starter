import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { sliceDefs, type Slice } from "./lib/slices"
import { diffSliceMutations } from "./lib/slices/permissions"
import { toDescriptorComparisonForm } from "./lib/richtext/comparison"
import { convertSliceFields } from "./lib/slices/validate"

function faq(question: string): Slice {
  return {
    id: "faq-1",
    type: "faq-simple",
    enabled: true,
    primary: { heading: "FAQ", eyebrow: "", body: "" },
    items: [{ question, answer: "Answer", itemId: "row-1" }],
  } as unknown as Slice
}

function comparison(slice: Slice): Slice {
  const def = sliceDefs[slice.type]
  const converted = convertSliceFields(slice).value
  const next = {
    ...converted,
    primary: toDescriptorComparisonForm(def.primary, converted.primary, {
      sliceType: slice.type,
      fieldPath: "primary",
    }),
  } as Record<string, unknown>
  if ("items" in def && "items" in converted)
    next.items = toDescriptorComparisonForm(def.items, converted.items, {
      sliceType: slice.type,
      fieldPath: "items",
    })
  return next as unknown as Slice
}

function content(slice: Slice) {
  return { en: { slices: [slice] } }
}

describe("RF2a revision comparison seam", () => {
  test("shape-only FAQ heading restore has an empty mutation diff", sliceProfile([]), () => {
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Question" }],
        },
      ],
    })
    expect(
      diffSliceMutations(
        content(comparison(faq("Question"))),
        content(comparison(faq(title)))
      )
    ).toEqual({ add: new Set(), edit: new Set(), delete: new Set() })
  })

  test("a changed word remains an edit after comparison projection", sliceProfile([]), () => {
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Changed question" }],
        },
      ],
    })
    expect(
      diffSliceMutations(
        content(comparison(faq("Question"))),
        content(comparison(faq(title)))
      ).edit
    ).toContain("faq-simple")
  })

  test("new itemId initialization is ignored while existing identity changes are not", sliceProfile([]), () => {
    const before = faq("Question") as Slice & {
      items: Array<Record<string, unknown>>
    }
    delete before.items[0]!.itemId
    const initialized = faq("Question") as unknown as {
      items: Array<Record<string, unknown>>
    }
    initialized.items[0] = { ...initialized.items[0]!, itemId: "created" }
    expect(
      diffSliceMutations(
        content(comparison(before)),
        content(comparison(initialized as unknown as Slice))
      ).edit.size
    ).toBe(0)
    const changed = faq("Question") as unknown as {
      items: Array<Record<string, unknown>>
    }
    changed.items[0] = { ...changed.items[0], itemId: "different" }
    const existing = faq("Question") as unknown as {
      items: Array<Record<string, unknown>>
    }
    existing.items[0] = { ...existing.items[0], itemId: "original" }
    expect(
      diffSliceMutations(
        content(existing as unknown as Slice),
        content(changed as unknown as Slice)
      ).edit
    ).toContain("faq-simple")
  })

  test("restore conversion leaves its frozen source object untouched", sliceProfile([]), () => {
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Question" }],
        },
      ],
    })
    const frozenFixture = faq(title)
    const before = structuredClone(frozenFixture)
    convertSliceFields(frozenFixture)
    expect(frozenFixture).toEqual(before)
  })
})
