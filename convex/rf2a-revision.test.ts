import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { blockDefs, type Block } from "./lib/blocks"
import { diffBlockMutations } from "./lib/blocks/permissions"
import { toDescriptorComparisonForm } from "./lib/richtext/comparison"
import { convertBlockFields } from "./lib/blocks/validate"

function faq(question: string): Block {
  return {
    id: "faq-1",
    type: "faq-simple",
    enabled: true,
    primary: { heading: "FAQ", eyebrow: "", body: "" },
    items: [{ question, answer: "Answer", itemId: "row-1" }],
  } as unknown as Block
}

function comparison(block: Block): Block {
  const def = blockDefs[block.type]
  const converted = convertBlockFields(block).value
  const next = {
    ...converted,
    primary: toDescriptorComparisonForm(def.primary, converted.primary, {
      blockType: block.type,
      fieldPath: "primary",
    }),
  } as Record<string, unknown>
  if ("items" in def && "items" in converted)
    next.items = toDescriptorComparisonForm(def.items, converted.items, {
      blockType: block.type,
      fieldPath: "items",
    })
  return next as unknown as Block
}

function content(block: Block) {
  return { en: { blocks: [block] } }
}

describe("RF2a revision comparison seam", () => {
  test("shape-only FAQ heading restore has an empty mutation diff", blockProfile([]), () => {
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
      diffBlockMutations(
        content(comparison(faq("Question"))),
        content(comparison(faq(title)))
      )
    ).toEqual({ add: new Set(), edit: new Set(), delete: new Set() })
  })

  test("a changed word remains an edit after comparison projection", blockProfile([]), () => {
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
      diffBlockMutations(
        content(comparison(faq("Question"))),
        content(comparison(faq(title)))
      ).edit
    ).toContain("faq-simple")
  })

  test("new itemId initialization is ignored while existing identity changes are not", blockProfile([]), () => {
    const before = faq("Question") as Block & {
      items: Array<Record<string, unknown>>
    }
    delete before.items[0]!.itemId
    const initialized = faq("Question") as unknown as {
      items: Array<Record<string, unknown>>
    }
    initialized.items[0] = { ...initialized.items[0]!, itemId: "created" }
    expect(
      diffBlockMutations(
        content(comparison(before)),
        content(comparison(initialized as unknown as Block))
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
      diffBlockMutations(
        content(existing as unknown as Block),
        content(changed as unknown as Block)
      ).edit
    ).toContain("faq-simple")
  })

  test("restore conversion leaves its frozen source object untouched", blockProfile([]), () => {
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
    convertBlockFields(frozenFixture)
    expect(frozenFixture).toEqual(before)
  })
})
