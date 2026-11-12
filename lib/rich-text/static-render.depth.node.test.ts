import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { RichTextContent } from "@/components/slices/rich-text-content"
import { LegacyRichTextWalkerOracle } from "./static-render.oracle"

const LEAF_TEXT = "rf1-depth-leaf"
const REALISTIC_DEPTH = 50
const SUPPORTED_DEPTH = 500

function serializedBlockquoteDocument(depth: number): string {
  const nestedBlocks = '{"type":"blockquote","content":['.repeat(depth)
  const leaf = `{"type":"paragraph","content":[{"type":"text","text":"${LEAF_TEXT}"}]}`
  return `{"type":"doc","content":[${nestedBlocks}${leaf}${"]}".repeat(depth + 1)}`
}

function serializedListDocument(depth: number): string {
  const nestedLists = Array.from({ length: depth }, (_, index) => {
    const emptyParagraph =
      index < depth - 1 ? '{"type":"paragraph","content":[]},' : ""
    return `{"type":"bulletList","content":[{"type":"listItem","content":[${emptyParagraph}`
  }).join("")
  const leaf = `{"type":"paragraph","content":[{"type":"text","text":"${LEAF_TEXT}"}]}`
  const nestedClosings = "]}]}".repeat(depth)
  return `{"type":"doc","content":[${nestedLists}${leaf}${nestedClosings}]}`
}

function render(
  Component: typeof RichTextContent | typeof LegacyRichTextWalkerOracle,
  value: string
): string {
  return renderToStaticMarkup(
    createElement(Component, { value, profile: "full" })
  )
}

function leafCount(html: string): number {
  return html.split(LEAF_TEXT).length - 1
}

describe("static renderer supported-depth regression", () => {
  it("matches ordinary nesting and preserves adapter output through 500 levels", () => {
    const warnings = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    try {
      for (const [realisticValue, deepValue] of [
        [
          serializedBlockquoteDocument(REALISTIC_DEPTH),
          serializedBlockquoteDocument(SUPPORTED_DEPTH),
        ],
        [
          serializedListDocument(REALISTIC_DEPTH),
          serializedListDocument(SUPPORTED_DEPTH),
        ],
      ]) {
        expect(JSON.parse(realisticValue)).toMatchObject({ type: "doc" })
        expect(JSON.parse(deepValue)).toMatchObject({ type: "doc" })
        const firstOracle = render(LegacyRichTextWalkerOracle, realisticValue)
        const firstAdapter = render(RichTextContent, realisticValue)
        const secondOracle = render(LegacyRichTextWalkerOracle, realisticValue)
        const secondAdapter = render(RichTextContent, realisticValue)

        expect(firstAdapter).toBe(firstOracle)
        expect(secondOracle).toBe(firstOracle)
        expect(secondAdapter).toBe(firstAdapter)
        expect(leafCount(firstAdapter)).toBe(1)
        expect(leafCount(secondAdapter)).toBe(1)

        const deepAdapter = render(RichTextContent, deepValue)
        expect(leafCount(deepAdapter)).toBe(1)
      }

      expect(warnings).not.toHaveBeenCalled()
      expect(errors).not.toHaveBeenCalled()
    } finally {
      warnings.mockRestore()
      errors.mockRestore()
    }
  })
})
