import { describe, expect, test } from "vitest"
import {
  buildContextSection,
  buildSiblings,
  flattenBlockText,
  SIBLING_TEXT_CAP,
} from "./pageContext"
import type { Block } from "../blocks"
import { buildPMDoc } from "../richtext/build"

function rt(text: string): string {
  return JSON.stringify(buildPMDoc(text, "inline"))
}
const heroBlock: Block = {
  id: "block-hero",
  type: "hero",
  enabled: true,
  primary: {
    title: "Smile, you're home",
    subtitle: rt("Modern dental care, downtown."),
  },
  items: [
    { label: "Book a visit", link: { type: "none" }, enabled: true },
    { label: "Learn more", link: { type: "none" }, enabled: true },
  ],
} as unknown as Block

const secondHeroBlock: Block = {
  id: "block-second-hero",
  type: "hero",
  enabled: true,
  primary: {
    title: "Care that fits your day",
    subtitle: rt("Same-day appointments for the whole family."),
  },
  items: [{ label: "Call now", link: { type: "none" }, enabled: true }],
} as unknown as Block

const emptyHero: Block = {
  id: "block-empty",
  type: "hero",
  enabled: true,
  primary: { title: "" },
  items: [],
} as unknown as Block

describe("flattenBlockText", () => {
  test("projects a registered FAQ title without sending its JSON wrapper", () => {
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Question text" }],
        },
      ],
    })
    const faq = {
      id: "faq",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "FAQ", eyebrow: "", body: "" },
      items: [{ question: title, answer: "Answer" }],
    } as unknown as Block
    const result = flattenBlockText(faq)
    expect(result).toContain("Question text")
    expect(result).not.toContain('"type":"doc"')
  })

  test("keeps ordinary numeric FAQ text as text", () => {
    const faq = {
      id: "faq-number",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "", eyebrow: "12345", body: "" },
      items: [],
    } as unknown as Block
    expect(flattenBlockText(faq)).toBe("12345")
  })

  test("keeps literal JSON in an unregistered FAQ text field verbatim", () => {
    const literal = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "literal" }],
        },
      ],
    })
    const faq = {
      id: "faq-json-text",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "", eyebrow: literal, body: "" },
      items: [],
    } as unknown as Block
    expect(flattenBlockText(faq)).toBe(literal)
  })

  test("hero: title + subtitle + button labels, joined", () => {
    const text = flattenBlockText(heroBlock)
    expect(text).toContain("Smile, you're home")
    expect(text).toContain("Modern dental care")
    expect(text).toContain("Book a visit")
  })

  test("empty block → empty string", () => {
    expect(flattenBlockText(emptyHero)).toBe("")
  })

  test("caps at SIBLING_TEXT_CAP on a word boundary, appends ellipsis", () => {
    const longText = "lorem ipsum ".repeat(80)
    const fat: Block = {
      id: "block-long",
      type: "hero",
      enabled: true,
      primary: { title: "Long", subtitle: rt(longText) },
      items: [],
    } as unknown as Block
    const flat = flattenBlockText(fat)
    expect(flat.length).toBeLessThanOrEqual(SIBLING_TEXT_CAP + 1)
    expect(flat.endsWith("…")).toBe(true)
    // Did not block in the middle of a token.
    expect(flat.replace(/…$/, "").trimEnd().endsWith("ipsum")).toBe(true)
  })
})

describe("buildSiblings", () => {
  test("includes every non-empty block and excludes the named one", () => {
    const siblings = buildSiblings([heroBlock, secondHeroBlock], "block-hero")
    expect(siblings).toHaveLength(1)
    expect(siblings?.[0]?.text).toContain("Care that fits your day")
  })

  test("drops empty blocks", () => {
    const siblings = buildSiblings([heroBlock, emptyHero])
    expect(siblings).toHaveLength(1)
    expect(siblings?.[0]?.type).toBe("hero")
  })

  test("all-empty page → undefined (so optional validator omits it)", () => {
    expect(buildSiblings([emptyHero])).toBeUndefined()
    expect(buildSiblings([])).toBeUndefined()
  })
})

describe("buildContextSection", () => {
  test("renders every section when all inputs are present", () => {
    const block = buildContextSection(
      {
        pageTitle: "About us",
        siblings: [
          { type: "hero", text: "Smile, you're home. Modern dental care." },
        ],
      },
      "Warm and direct."
    )
    expect(block).toMatch(/Brand voice: Warm and direct\./)
    expect(block).toMatch(/Page context/)
    expect(block).toMatch(/- hero: Smile, you're home/)
    expect(block).toMatch(/Page title: About us/)
  })

  test("omits sections that are empty", () => {
    expect(buildContextSection(undefined, undefined)).toBe("")
    expect(buildContextSection(undefined, "  ")).toBe("")
    expect(buildContextSection({ siblings: [] }, "voice")).toBe(
      "Brand voice: voice"
    )
    expect(buildContextSection({ pageTitle: "  " }, undefined)).toBe("")
  })

  test("trims brand voice; preserves multi-line internal whitespace", () => {
    const block = buildContextSection(undefined, "  warm.  ")
    expect(block).toBe("Brand voice: warm.")
  })
})
