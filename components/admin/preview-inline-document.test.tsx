import { describe, expect, test } from "vitest"
import { generateJSON } from "@tiptap/html"
import { extensionsForProfile } from "@/lib/rich-text/extensions"
import { richTextToDocument } from "@/lib/rich-text/render"
import { sanitizeLegacyHtml, validateDoc } from "@/convex/lib/richtext/profiles"
import { normalizePreviewInlineDocument } from "./preview-inline-document"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"

test.each([
  ["itemTitle", 3],
  ["sliceTitle", 2],
] as const)(
  "preserves the resolved %s descriptor level through preview normalization",
  (role, level) => {
    const resolved = resolveFieldContract({ contract: "title", heading: { role } })
    const document = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Title" }] }],
    }
    const normalized = normalizePreviewInlineDocument(
      document,
      "title",
      undefined,
      resolved
    )
    expect(normalized.content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level },
    })
    expect(
      normalizePreviewInlineDocument(document, "title").content?.[0]
    ).toMatchObject({ type: "heading", attrs: { level: 2 } })
  }
)

describe("preview inline clipboard document boundary", () => {
  test.each(["inline", "basic", "full"] as const)(
    "parses b as the existing bold mark in the %s profile",
    (profile) => {
      const fromAlias = richTextToDocument("<p><b>Native bold</b></p>", profile)
      expect(fromAlias).toEqual(
        richTextToDocument("<p><strong>Native bold</strong></p>", profile)
      )
      expect(fromAlias.content?.[0].content?.[0]).toEqual({
        type: "text",
        text: "Native bold",
        marks: [{ type: "bold" }],
      })
      expect(validateDoc(JSON.stringify(fromAlias), profile)).toEqual({
        ok: true,
      })
    }
  )

  test.each([
    [
      "normal-weight Google Docs wrapper stays plain",
      "Plain text",
      [{ type: "text", text: "Plain text" }],
    ],
    [
      "normal-weight Google Docs wrapper preserves inner bold span",
      'Plain <span style="font-weight:700">bold</span> text',
      [
        { type: "text", text: "Plain " },
        { type: "text", text: "bold", marks: [{ type: "bold" }] },
        { type: "text", text: " text" },
      ],
    ],
  ])("%s", (_name, content, expectedContent) => {
    const html =
      '<p><b style="font-weight:normal;" id="docs-internal-guid-verification">' +
      content +
      "</b></p>"
    const parsed = richTextToDocument(html, "inline")
    expect(parsed).toEqual(generateJSON(html, extensionsForProfile("inline")))
    expect(parsed.content?.[0].content).toEqual(expectedContent)
    expect(sanitizeLegacyHtml(html, "inline")).not.toMatch(/style=|id=/)
    expect(validateDoc(JSON.stringify(parsed), "inline")).toEqual({ ok: true })
  })

  test("keeps native-like semantic marks while removing unsupported inline content and styling", () => {
    const html =
      "<h1>Unsupported heading</h1><ol><li>Unsupported list item</li></ol>" +
      '<p class="MsoNormal" style="font-size:72pt;width:9000px">' +
      "<b>Native bold</b> <i>Native italic</i> <u>Native underline</u> " +
      '<a href="https://example.invalid/order3-native-paste">Native link</a>' +
      "<script>window.__order3NativeScript=true</script>" +
      '<iframe src="about:blank"></iframe><img src="invalid"></p>'
    const document = normalizePreviewInlineDocument(
      richTextToDocument(html, "inline")
    )
    expect(document).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Unsupported headingUnsupported list item" },
            { type: "hardBreak" },
            { type: "hardBreak" },
            { type: "text", text: "Native bold", marks: [{ type: "bold" }] },
            { type: "text", text: " " },
            {
              type: "text",
              text: "Native italic",
              marks: [{ type: "italic" }],
            },
            { type: "text", text: " " },
            {
              type: "text",
              text: "Native underline",
              marks: [{ type: "underline" }],
            },
            { type: "text", text: " " },
            {
              type: "text",
              text: "Native link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.invalid/order3-native-paste",
                    target: "_blank",
                    rel: "noopener noreferrer",
                    class: null,
                    title: null,
                    pageId: null,
                    noFollow: null,
                    sponsored: null,
                    ugc: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    })
    expect(validateDoc(JSON.stringify(document), "inline")).toEqual({
      ok: true,
    })
  })
})

test.each(["basic", "full"] as const)(
  "preserves native %s paragraphs, lists, headings and marks at the normalization seam",
  (contract) => {
    const document = richTextToDocument(
      '<p><strong>First</strong> <a href="https://example.com">link</a></p><h2>Heading</h2><ul><li><p>Item</p></li></ul><p>Last</p>',
      contract
    )
    expect(normalizePreviewInlineDocument(document, contract)).toEqual(document)
    expect(document.content?.map((node) => node.type)).toEqual([
      "paragraph",
      "heading",
      "bulletList",
      "paragraph",
    ])
  }
)
