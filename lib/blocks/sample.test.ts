// @vitest-environment happy-dom

import {
  installedBlockDefinition,
  blockProfileAny,
  blockProfile,
} from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { createSampleBlock, hasCuratedPreview } from "./sample"
import { BLOCK_TYPES, type BlockType } from "./builder"
import { blockValidator, type ButtonField } from "@/convex/lib/blocks"
import { validateBlocksRichText } from "@/convex/lib/blocks/validate"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { hasRenderer } from "@/components/blocks/block-registry"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { walkValue } from "@/convex/lib/blocks/walk"

type RichTextSample = { path: string; value: string; placeholder?: string; full: boolean }

function richTextSamples(type: BlockType): RichTextSample[] {
  const def = installedBlockDefinition(type)
  const block = createSampleBlock(type)
  const found: RichTextSample[] = []
  const visit = (leaf: Parameters<Parameters<typeof walkValue>[2]>[0]) => {
    if (leaf.def.kind !== "richText" || typeof leaf.value !== "string") return
    found.push({
      path: leaf.path,
      value: leaf.value,
      placeholder: (leaf.def.config as { placeholder?: string }).placeholder,
      full: resolveFieldContract(leaf.def.config).profile === "full",
    })
  }
  walkValue(def.primary, block.primary, visit, "primary")
  if (def.items) walkValue(def.items, (block as { items?: unknown }).items, visit, "items")
  return found
}

function markTypes(json: string): string[] {
  const marks = new Set<string>()
  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const { marks: nodeMarks, content } = node as {
      marks?: Array<{ type: string }>
      content?: unknown[]
    }
    for (const mark of nodeMarks ?? []) marks.add(mark.type)
    for (const child of content ?? []) collect(child)
  }
  collect(JSON.parse(json))
  return [...marks]
}

describe("createSampleBlock", () => {
  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)(
    "%s never stores a writing prompt as sample rich text", blockProfileAny(BLOCK_TYPES),
    (type) => {
      // A placeholder is sample copy (lib/blocks/authoring/contracts.ts); the
      // Rich Text Body once carried the editor prompt "Start writing…", which
      // "Add the example" stored and published.
      for (const sample of richTextSamples(type)) {
        const plain = richTextToPlainText(sample.value)
        expect(plain.trim().length, sample.path).toBeGreaterThan(0)
        expect(plain, sample.path).not.toMatch(/^\s*start writing/i)
      }
    }
  )

  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)(
    "%s fills a document body without sample copy with real prose", blockProfileAny(BLOCK_TYPES),
    (type) => {
      for (const sample of richTextSamples(type)) {
        if (!sample.full || sample.placeholder !== undefined) continue
        const doc = JSON.parse(sample.value) as { content?: unknown[] }
        expect(doc.content?.length ?? 0, sample.path).toBeGreaterThan(1)
        expect(markTypes(sample.value), sample.path).toEqual(
          expect.arrayContaining(["bold", "italic"])
        )
      }
    }
  )

  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)("%s sample is schema-valid", blockProfileAny(BLOCK_TYPES), (type) => {
    const block = createSampleBlock(type)
    expect(block.type).toBe(type)
    expect(typeof block.id).toBe("string")
    expect(block.enabled).toBe(true)
    // Throws (failing the test) if the sample violates the block union.
    expect(validate(blockValidator, block, { throw: true })).toBe(true)
  })

  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)("%s sample rich-text passes its profiles", blockProfileAny(BLOCK_TYPES), (type) => {
    // The write-path gate throws on any richText value that violates its field
    // profile — proves synthesized PM-JSON is valid for the field it fills.
    expect(() =>
      validateBlocksRichText([createSampleBlock(type)])
    ).not.toThrow()
  })

  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)(
    "%s has a real renderer — never the fallback", blockProfileAny(BLOCK_TYPES),
    (type) => {
      // The agent verify-loop (ADR-0016) depends on this: a generated block
      // registered without a renderer must not render as FallbackBlock.
      expect(hasRenderer(type)).toBe(true)
    }
  )

  test("fills text and rich-text content for previews", blockProfile([]), () => {
    const hero = createSampleBlock("hero-agency")
    const primary = hero.primary as Record<string, unknown>
    expect((primary.title as string).length).toBeGreaterThan(0)
    expect(primary.description).toContain("Web design")
    expect((hero as { items: unknown[] }).items.length).toBeGreaterThan(0)
  })

  test("uses positional button variants for hero previews", blockProfile([]), () => {
    const hero = createSampleBlock("hero-agency") as { items: ButtonField[] }
    expect(hero.items.map((button) => button.variant)).toEqual([
      "primary",
      "link",
    ])
  })

  for (const profileRow of ["hero-agency", "hero-with-image"] as const) {
    test.each([profileRow])("%s assigns a unique id to every generated button", blockProfile([]),
      (type) => {
        const block = createSampleBlock(type) as {
          items: ButtonField[]
        }
        const ids = block.items.map((button) => button.id)

        expect(ids).toEqual(ids.map(() => expect.any(String)))
        expect(new Set(ids).size).toBe(ids.length)
      }
    )
  }

  test("hero-with-image preview matches its committed design reference content", blockProfile([]), () => {
    const hero = createSampleBlock("hero-with-image")

    expect(hero.primary.eyebrow).toBe("We're hiring!")
    expect(hero.primary.eyebrowLinkLabel).toBe("Join our remote team")
    expect(richTextToPlainText(hero.primary.title)).toBe(
      "People who care about your growth"
    )
    expect(richTextToPlainText(hero.primary.description)).toBe(
      "Powerful, self-serve product and growth analytics to help you convert, engage, and retain more."
    )
    expect(hero.primary.image).toMatchObject({
      url: "/block-samples/hero-with-image.webp",
      width: 1500,
      height: 1201,
    })
    expect(hero.items.map((button) => [button.label, button.variant])).toEqual([
      ["Demo", "outline"],
      ["Sign up", "primary"],
    ])
  })

  test("keeps stored hero-with-image blocks valid without the new CTA label", blockProfile([]), () => {
    const hero = createSampleBlock("hero-with-image")
    delete hero.primary.eyebrowLinkLabel

    expect(validate(blockValidator, hero, { throw: true })).toBe(true)
  })

  test("a placeholder-filled design is not treated as settled content", blockProfile([]), () => {
    // Guards the negative side of the check the verifier's rule 3 depends on.
    expect(hasCuratedPreview("faq-simple")).toBe(false)
  })
})
