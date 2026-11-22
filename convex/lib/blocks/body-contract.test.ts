import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { createSampleBlock } from "./sample"
import { blockDefs } from "."
import { walkValue } from "./walk"
import { resolveFieldContract } from "../richtext/contracts"
import { validateBlocksRichText } from "./validate"
import { extractBlockText } from "../publishing/search"

const body = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "First",
          marks: [
            { type: "bold" },
            { type: "link", attrs: { href: "https://example.com" } },
          ],
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Heading" }],
    },
    {
      type: "heading",
      attrs: { level: 3 },
      content: [{ type: "text", text: "Subheading" }],
    },
    ...["bulletList", "orderedList"].map((type) => ({
      type,
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "List item" }],
            },
          ],
        },
      ],
    })),
    { type: "paragraph", content: [{ type: "text", text: "Last" }] },
  ],
})

describe("registered supporting body contracts", () => {
  for (const profileRow of ["features-icon-grid", "hero-with-image", "hero-agency"] as const) {
    test.each([profileRow])("%s keeps single paragraph defaults and admits basic documents through block validation/search", blockProfile([]),
      (type) => {
        const sample = createSampleBlock(type)
        const fields: string[] = []
        const def = blockDefs[type]
        const visit = (leaf: Parameters<Parameters<typeof walkValue>[2]>[0]) => {
          if (leaf.def.kind !== "richText") return
          const contract = resolveFieldContract(leaf.def.config)
          if (contract.contract !== "basic") return
          fields.push(leaf.path)
          expect(contract.headingFloorParent).toBe(
            leaf.path.startsWith("items")
              ? "items.title"
              : type === "features-icon-grid"
                ? "primary.heading"
                : "primary.title"
          )
          expect(JSON.parse(leaf.value as string).content).toHaveLength(1)
          expect(JSON.parse(leaf.value as string).content[0].type).toBe(
            "paragraph"
          )
        }
        walkValue(def.primary, sample.primary, visit, "primary")
        walkValue(def.items, sample.items, visit, "items")
        expect(fields.length).toBeGreaterThan(0)
        if (sample.type === "features-icon-grid") {
          sample.primary.body = body
          sample.items = sample.items.map((item) => ({ ...item, body }))
        } else sample.primary.description = body
        expect(() => validateBlocksRichText([sample])).not.toThrow()
        expect(extractBlockText([sample])).toContain(
          "First Heading Subheading List item List item Last"
        )
        const invalid = structuredClone(sample)
        const primary = invalid.primary as Record<string, unknown>
        primary[type === "features-icon-grid" ? "body" : "description"] =
          JSON.stringify({
            type: "doc",
            content: [{ type: "text", text: "invalid inline root" }],
          })
        const sourceBytes = JSON.stringify(invalid)
        expect(() => validateBlocksRichText([invalid])).toThrow(
          /Invalid rich-text content/
        )
        expect(JSON.stringify(invalid)).toBe(sourceBytes)
        expect(() => validateBlocksRichText([sample])).not.toThrow()
      }
    )
  }
  test("optional Features intro and empty basic documents remain valid", blockProfile([]), () => {
    const sample = createSampleBlock("features-icon-grid")
    delete sample.primary.body
    sample.items[0].body = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    })
    expect(() => validateBlocksRichText([sample])).not.toThrow()
    sample.items[0].body = JSON.stringify({ type: "doc", content: [] })
    expect(() => validateBlocksRichText([sample])).toThrow(
      /Invalid rich-text content/
    )
  })
})
