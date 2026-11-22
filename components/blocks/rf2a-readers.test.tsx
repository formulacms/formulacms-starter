import { blockProfile } from "@/test-utils/block-profile"
import type { FaqSimpleBlock } from "@/convex/lib/blocks/faqSimple"
import { render, screen } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { FaqSimple } from "./faq-simple"
import { RichTextContent } from "./rich-text-content"
import type { BlockRenderContext } from "@/lib/blocks/links"

import { toFieldShape } from "@/convex/lib/richtext/shape"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { toComparisonForm } from "@/convex/lib/richtext/comparison"

const ctx = { locale: "en" } as BlockRenderContext
function doc(nodes: unknown[]) {
  return JSON.stringify({ type: "doc", content: nodes })
}

describe("RF2a current-shape readers", () => {
  test("renders a future heading-shaped field through the inline profile", () => {
    const heading = doc([
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Future title" }],
      },
    ])
    const { container } = render(
      <RichTextContent value={heading} profile="inline" ctx={ctx} />
    )
    expect(container.textContent).toContain("Future title")
    expect(container.querySelector("h3")).toBeNull()
  })

  test("FAQ displays legacy text and title docs as equivalent visible questions", blockProfile([]), () => {
    const title = doc([
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          { type: "text", text: "What", marks: [{ type: "bold" }] },
          { type: "hardBreak" },
          { type: "text", text: "now?" },
        ],
      },
    ])
    const block = {
      id: "faq",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "FAQ", eyebrow: "", body: "" },
      items: [{ question: title, answer: "" }],
    } as unknown as FaqSimpleBlock
    render(<FaqSimple block={block} ctx={ctx} />)
    expect(screen.getByRole("button").textContent).toContain("What")
    expect(screen.getByRole("button").textContent).toContain("now?")
    expect(screen.getByRole("button").querySelector("strong")).not.toBeNull()
  })

  test("title questions keep link text but render no link element", blockProfile([]), () => {
    const linkedTitle = doc([
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          {
            type: "text",
            text: "Linked question",
            marks: [{ type: "link", attrs: { href: "https://example.test" } }],
          },
        ],
      },
    ])
    const block = {
      id: "faq-linked",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "FAQ", eyebrow: "", body: "" },
      items: [{ question: linkedTitle, answer: "Answer" }],
    } as unknown as FaqSimpleBlock
    const before = structuredClone(block)
    render(<FaqSimple block={block} ctx={ctx} />)

    expect(screen.getByRole("button").textContent).toContain("Linked question")
    expect(screen.queryByRole("link")).toBeNull()
    expect(block).toEqual(before)
  })

  test("title hard breaks and plain FAQ newlines render the same visible lines", blockProfile([]), () => {
    const title = doc([
      {
        type: "heading",
        attrs: { level: 3 },
        content: [
          { type: "text", text: "First" },
          { type: "hardBreak" },
          { type: "text", text: "Second" },
        ],
      },
    ])
    const block = {
      id: "faq-linebreaks",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "FAQ", eyebrow: "", body: "" },
      items: [
        { question: title, answer: "Answer" },
        { question: "First\nSecond", answer: "Answer" },
      ],
    } as unknown as FaqSimpleBlock
    const before = structuredClone(block)
    render(<FaqSimple block={block} ctx={ctx} />)
    const questions = screen.getAllByRole("button")

    expect(questions.map((question) => question.textContent)).toEqual([
      "First Second",
      "First Second",
    ])
    expect(
      questions.map((question) => question.querySelectorAll("br").length)
    ).toEqual([0, 0])
    expect(block).toEqual(before)
  })

  test("title upcast removes link marks and edge-empty paragraphs", () => {
    const source = doc([
      { type: "paragraph" },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "A",
            marks: [{ type: "link", attrs: { href: "/gone" } }],
          },
        ],
      },
      { type: "paragraph" },
    ])
    const converted = toFieldShape(
      resolveFieldContract({
        contract: "title",
        heading: { role: "itemTitle" },
      }),
      source
    )
    expect(converted.removedLinks).toEqual([{ href: "/gone" }])
    expect(JSON.parse(converted.value).content[0].type).toBe("heading")
  })

  test("comparison keeps two breaks for empty edge paragraphs", () => {
    const source = doc([
      { type: "paragraph" },
      { type: "paragraph", content: [{ type: "text", text: "A" }] },
      { type: "paragraph" },
    ])
    const result = JSON.parse(toComparisonForm("inline", source))
    expect(
      result.content[0].content.filter(
        (node: { type: string }) => node.type === "hardBreak"
      )
    ).toHaveLength(4)
  })
})
