import { describe, expect, test } from "vitest"
import { richTextToHtml } from "./render"
import type { SliceRenderContext } from "@/lib/slices/links"

/**
 * Renderer guard for the link-mark contract. The upstream Link extension ships
 * a baked-in `rel="noopener noreferrer nofollow"` default; if we ever stop
 * neutralizing it in `extensions.ts`, every link would silently get nofollow.
 * These tests pin that contract: rel only appears when our flags ask for it,
 * data-page-id rides through, and pageId rewrites href when ctx is supplied.
 */

function paragraphWithLink(attrs: Record<string, unknown>): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "link",
            marks: [{ type: "link", attrs }],
          },
        ],
      },
    ],
  })
}

describe("richTextToHtml — link mark rendering", () => {
  test("plain link emits no rel attribute", () => {
    const html = richTextToHtml(
      paragraphWithLink({ href: "https://example.com" }),
      "basic"
    )
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain("rel=")
    expect(html).not.toContain("nofollow")
  })

  test("openInNewTab composes noopener noreferrer", () => {
    const html = richTextToHtml(
      paragraphWithLink({ href: "https://example.com", target: "_blank" }),
      "basic"
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  test("nofollow + sponsored + ugc flags compose into rel", () => {
    const html = richTextToHtml(
      paragraphWithLink({
        href: "https://example.com",
        noFollow: true,
        sponsored: true,
        ugc: true,
      }),
      "basic"
    )
    expect(html).toContain('rel="nofollow sponsored ugc"')
  })

  test("data-page-id rides through when pageId is set", () => {
    const html = richTextToHtml(
      paragraphWithLink({ href: "/cached", pageId: "abc123" }),
      "basic"
    )
    expect(html).toContain('data-page-id="abc123"')
  })

  test("pageId resolves to the current path href when ctx provides one", () => {
    const ctx: SliceRenderContext = {
      locale: "fr",
      defaultLocale: "fr",
      pagePaths: { abc123: "/renamed-page" },
    }
    const html = richTextToHtml(
      paragraphWithLink({ href: "/old-cached-slug", pageId: "abc123" }),
      "basic",
      ctx
    )
    expect(html).toContain('href="/renamed-page"')
    expect(html).not.toContain("/old-cached-slug")
  })

  test("pageId with no path in ctx falls back to cached href", () => {
    const ctx: SliceRenderContext = {
      locale: "fr",
      defaultLocale: "fr",
      pagePaths: {},
    }
    const html = richTextToHtml(
      paragraphWithLink({ href: "/cached", pageId: "abc123" }),
      "basic",
      ctx
    )
    expect(html).toContain('href="/cached"')
  })

  test("resolved href is the full localized path (prefix + ancestry)", () => {
    const ctx: SliceRenderContext = {
      locale: "en",
      defaultLocale: "fr",
      pagePaths: { abc123: "/en/company/about" },
    }
    const html = richTextToHtml(
      paragraphWithLink({ href: "/cached", pageId: "abc123" }),
      "basic",
      ctx
    )
    expect(html).toContain('href="/en/company/about"')
  })

  test("non-JSON value preserves safe legacy HTML", () => {
    expect(richTextToHtml("<p>hi</p>", "basic")).toBe("<p>hi</p>")
  })

  test("legacy HTML strips executable tags, event attributes, and unsafe hrefs", () => {
    const html = richTextToHtml(
      '<p onclick="alert(1)">Hi<script>alert(1)</script><a href="javascript:alert(1)" onmouseover="alert(2)">bad</a><a href="/safe" target="_blank">safe</a></p>',
      "basic"
    )

    expect(html).toContain("<p>Hi<a>bad</a>")
    expect(html).toContain('<a href="/safe" target="_blank">safe</a>')
    expect(html).not.toContain("script")
    expect(html).not.toContain("onclick")
    expect(html).not.toContain("onmouseover")
    expect(html).not.toContain("javascript:")
  })

  test("empty value renders empty string", () => {
    expect(richTextToHtml("", "basic")).toBe("")
  })

  // Regression: a stale AI translation could persist {type:"text", text:""}.
  // generateHTML throws "Empty text nodes are not allowed" on those, 500-ing the
  // whole public page. The renderer must strip them and render the rest.
  test("empty text node is dropped instead of throwing", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "kept" },
          ],
        },
      ],
    })
    let html = ""
    expect(() => {
      html = richTextToHtml(doc, "full")
    }).not.toThrow()
    expect(html).toContain("kept")
  })
})

describe("richTextToHtml — inline profile rendering", () => {
  test("inline profile flattens structural paragraphs", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] },
          ],
        },
      ],
    })
    const html = richTextToHtml(doc, "inline")
    expect(html).toBe("hello <strong>world</strong>")
    expect(html).not.toContain("<p")
  })

  test("inline profile keeps paragraph separation without block tags", () => {
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    })
    expect(richTextToHtml(doc, "inline")).toBe("one<br><br>two")
  })

  test("legacy inline HTML paragraphs are flattened", () => {
    expect(richTextToHtml("<p>legacy</p>", "inline")).toBe("legacy")
  })
})

describe("richTextToHtml — table rendering (full profile)", () => {
  const tableDoc = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Head" }],
                  },
                ],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Cell" }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  })

  test("full profile serializes table nodes to HTML", () => {
    const html = richTextToHtml(tableDoc, "full")
    expect(html).toContain("<table")
    expect(html).toContain("<th")
    expect(html).toContain("Head")
    expect(html).toContain("<td")
    expect(html).toContain("Cell")
  })
})
