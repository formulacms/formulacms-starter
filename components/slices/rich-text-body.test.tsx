import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, test, vi } from "vitest"
import { RichTextBody } from "./rich-text-body"

import type { SliceRenderContext } from "@/lib/slices/links"

test.each(["en", "fr"])(
  "Rich Text Body preserves full content and public marker absence in %s", sliceProfile([]),
  (locale) => {
    const slice = {
      ...createSampleSlice("rich-text-body"),
      primary: {
        body: '<h2>Body</h2><p><strong>Strong</strong> <a href="https://example.com">link</a></p>',
      },
    }
    const before = JSON.stringify(slice)
    const html = renderToStaticMarkup(
      <RichTextBody
        slice={slice}
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
    expect(JSON.stringify(slice)).toBe(before)
  }
)

test("Rich Text Body marks primary.body once on the kit host", sliceProfile([]), () => {
  const paths: string[] = []
  const previewKitSlice = vi.fn((node) => node)
  const ctx: SliceRenderContext = {
    locale: "en",
    defaultLocale: "en",
    pagePaths: {},
    previewKitSlice,
    previewRichText: ({ rendered, fieldPath }) => {
      paths.push(fieldPath)
      return isValidElement(rendered)
        ? cloneElement(rendered, { "data-preview-field": fieldPath } as object)
        : rendered
    },
  }
  const html = renderToStaticMarkup(
    <RichTextBody slice={createSampleSlice("rich-text-body")} ctx={ctx} />
  )
  expect(paths).toEqual(["primary.body"])
  expect(html.match(/data-preview-field=/g)).toHaveLength(1)
  expect(previewKitSlice).toHaveBeenCalledOnce()
})

test.each(["", "<p></p>", '{"type":"doc","content":[{"type":"paragraph"}]}'])(
  "Rich Text Body keeps empty %s host-free", sliceProfile([]),
  (body) => {
    const slice = { ...createSampleSlice("rich-text-body"), primary: { body } }
    expect(renderToStaticMarkup(<RichTextBody slice={slice} />)).toBe("")
  }
)

test("Rich Text Body keeps rule-only content visible through the shared outline predicate", sliceProfile([]), () => {
  const slice = {
    ...createSampleSlice("rich-text-body"),
    primary: { body: '{"type":"doc","content":[{"type":"horizontalRule"}]}' },
  }
  expect(renderToStaticMarkup(<RichTextBody slice={slice} />)).toContain("<hr")
})
