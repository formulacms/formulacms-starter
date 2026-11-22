import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"
import { RichTextBody } from "./rich-text-body"

import type { BlockRenderContext } from "@/lib/blocks/links"

test.each(["en", "fr"])(
  "Rich Text Body preserves full content and public marker absence in %s", blockProfile([]),
  (locale) => {
    const block = {
      ...createSampleBlock("rich-text-body"),
      primary: {
        body: '<h2>Body</h2><p><strong>Strong</strong> <a href="https://example.com">link</a></p>',
      },
    }
    const before = JSON.stringify(block)
    const html = renderToStaticMarkup(
      <RichTextBody
        block={block}
        ctx={{ locale, defaultLocale: "en", pagePaths: {} }}
      />
    )
    expect(html).toContain(
      'class="mx-auto max-w-prose-content px-gutter py-section"'
    )
    expect(html).toContain("<strong>Strong</strong>")
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain("prose max-w-none prose-neutral dark:prose-invert")
    expect(html).not.toMatch(
      /data-(preview|tweak|renderer|revision|profile|provenance)/
    )
    expect(JSON.stringify(block)).toBe(before)
  }
)

test("Rich Text Body marks primary.body once on the kit host", blockProfile([]), () => {
  const paths: string[] = []
  const previewKitBlock = vi.fn((node) => node)
  const ctx: BlockRenderContext = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    previewKitBlock,
    previewRichText: ({ rendered, fieldPath }) => {
      paths.push(fieldPath)
      return isValidElement(rendered)
        ? cloneElement(rendered, { "data-preview-field": fieldPath } as object)
        : rendered
    },
  }
  const html = renderToStaticMarkup(
    <RichTextBody block={createSampleBlock("rich-text-body")} ctx={ctx} />
  )
  expect(paths).toEqual(["primary.body"])
  expect(html.match(/data-preview-field=/g)).toHaveLength(1)
  expect(previewKitBlock).toHaveBeenCalledOnce()
})

test.each(["", "<p></p>", '{"type":"doc","content":[{"type":"paragraph"}]}'])(
  "Rich Text Body keeps empty %s host-free", blockProfile([]),
  (body) => {
    const block = { ...createSampleBlock("rich-text-body"), primary: { body } }
    expect(renderToStaticMarkup(<RichTextBody block={block} />)).toBe("")
  }
)

test("Rich Text Body keeps rule-only content visible through the shared outline predicate", blockProfile([]), () => {
  const block = {
    ...createSampleBlock("rich-text-body"),
    primary: { body: '{"type":"doc","content":[{"type":"horizontalRule"}]}' },
  }
  expect(renderToStaticMarkup(<RichTextBody block={block} />)).toContain("<hr")
})
