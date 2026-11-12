import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { JSONContent } from "@tiptap/core"

import { richTextToDocument } from "./render"
import { renderStaticRichTextDocument } from "./static-render"

function markup(
  document: JSONContent,
  contract: "inline" | "basic" | "full" = "basic"
) {
  return renderToStaticMarkup(
    createElement("div", null, renderStaticRichTextDocument(document, contract))
  )
}

function linked(text: string, marks: JSONContent["marks"]) {
  return { type: "text", text, marks } satisfies JSONContent
}

describe("static renderer adjacent-link grouping", () => {
  it("groups adjacent equal links across different semantic marks (named diff1)", () => {
    expect(
      markup({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              linked("one", [
                { type: "bold" },
                { type: "link", attrs: { href: "/same" } },
              ]),
              linked("two", [
                { type: "italic" },
                { type: "link", attrs: { href: "/same" } },
              ]),
              linked("three", [
                { type: "strike" },
                { type: "link", attrs: { href: "/same" } },
              ]),
            ],
          },
        ],
      })
    ).toBe(
      '<div><p><a href="/same"><strong>one</strong><em>two</em><s>three</s></a></p></div>'
    )
  })

  it("preserves a single link's schema-ranked mark nesting without rewrapping", () => {
    expect(
      markup({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              linked("one", [
                { type: "bold" },
                { type: "link", attrs: { href: "/one" } },
              ]),
            ],
          },
        ],
      })
    ).toBe('<div><p><strong><a href="/one">one</a></strong></p></div>')
  })

  it("splits links when attributes differ and leaves boundaries outside the group", () => {
    const first: NonNullable<JSONContent["marks"]> = [
      { type: "link", attrs: { href: "/same" } },
    ]
    expect(
      markup({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              linked("a", first),
              linked("b", [
                { type: "link", attrs: { href: "/same", title: "other" } },
              ]),
              linked("c", [{ type: "link", attrs: { href: "/same" } }]),
              linked("plain", undefined),
              linked("d", first),
              { type: "hardBreak" },
              linked("e", first),
            ],
          },
          { type: "paragraph", content: [linked("f", first)] },
        ],
      })
    ).toBe(
      '<div><p><a href="/same">a</a><a href="/same" title="other">b</a><a href="/same">c</a>plain<a href="/same">d</a><br/><a href="/same">e</a></p><p><a href="/same">f</a></p></div>'
    )
  })

  it("splits anchors when href, target, title, pageId, or rel flags differ", () => {
    const baseline = { href: "/same" }
    const variants = [
      { ...baseline, href: "/different" },
      { ...baseline, target: "_blank" },
      { ...baseline, title: "different" },
      { ...baseline, pageId: "page-2" },
      { ...baseline, noFollow: true },
      { ...baseline, sponsored: true },
      { ...baseline, ugc: true },
    ]
    for (const attrs of variants) {
      expect(
        markup({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                linked("one", [{ type: "link", attrs: baseline }]),
                linked("two", [{ type: "link", attrs }]),
              ],
            },
          ],
        })
      ).toContain("</a><a")
    }
  })

  it("keeps semantic marks while unsafe links lose anchors and blank targets compose rel once", () => {
    expect(
      markup({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              linked("unsafe", [
                { type: "bold" },
                { type: "link", attrs: { href: "javascript:alert(1)" } },
              ]),
              linked("safe1", [
                {
                  type: "link",
                  attrs: { href: "/safe", target: "_blank", noFollow: true },
                },
              ]),
              linked("safe2", [
                { type: "italic" },
                {
                  type: "link",
                  attrs: { href: "/safe", target: "_blank", noFollow: true },
                },
              ]),
            ],
          },
        ],
      })
    ).toBe(
      '<div><p><strong>unsafe</strong><a href="/safe" target="_blank" rel="noopener noreferrer nofollow">safe1<em>safe2</em></a></p></div>'
    )
  })

  it("omits default list and table spans while preserving non-default and scalar-string values", () => {
    expect(
      markup(
        {
          type: "doc",
          content: [
            {
              type: "orderedList",
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "absent" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "orderedList",
              attrs: { start: "1" },
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "first" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "orderedList",
              attrs: { start: "3" },
              content: [
                {
                  type: "listItem",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "third" }],
                    },
                  ],
                },
              ],
            },
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      attrs: { colspan: "1", rowspan: "2" },
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "cell" }],
                        },
                      ],
                    },
                    {
                      type: "tableCell",
                      attrs: { colspan: "bad", rowspan: "bad" },
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "plain" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        "full"
      )
    ).toBe(
      '<div><ol><li><p>absent</p></li></ol><ol><li><p>first</p></li></ol><ol start="3"><li><p>third</p></li></ol><table><tbody><tr><td rowSpan="2"><p>cell</p></td><td><p>plain</p></td></tr></tbody></table></div>'
    )
  })

  it("keeps supported text through malformed children and unknown marks", () => {
    expect(
      markup({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              linked("one", [
                { type: "bold" },
                { type: "unknown" },
                { type: "link", attrs: { href: "/x" } },
              ]),
              null as unknown as JSONContent,
              linked("two", [
                { type: "italic" },
                { type: "link", attrs: { href: "/x" } },
              ]),
            ],
          },
        ],
      })
    ).toBe(
      '<div><p><a href="/x"><strong>one</strong><em>two</em></a></p></div>'
    )
  })

  it("groups links after current-page path resolution", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            linked("one", [
              { type: "link", attrs: { href: "/old", pageId: "about" } },
            ]),
            linked("two", [
              { type: "link", attrs: { href: "/old", pageId: "about" } },
            ]),
          ],
        },
      ],
    })
    const document = richTextToDocument(value, "basic", {
      locale: "fr",
      defaultLocale: "en",
      pagePaths: { about: "/fr/a-propos" },
    })
    expect(markup(document)).toBe(
      '<div><p><a href="/fr/a-propos" data-page-id="about">onetwo</a></p></div>'
    )
  })

  it("repairs excluded wrapper, heading, mark, and malformed-child classes explicitly", () => {
    expect(
      markup(
        {
          type: "doc",
          content: [
            {
              type: "unknownBlock",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "a" },
                    {
                      type: "text",
                      text: "b",
                      marks: [{ type: "unknown" }, { type: "bold" }],
                    },
                    null as unknown as JSONContent,
                  ],
                },
              ],
            },
            {
              type: "heading",
              attrs: { level: "4" },
              content: [
                {
                  type: "text",
                  text: "heading clamp",
                  marks: [{ type: "code" }],
                },
              ],
            },
          ],
        },
        "basic"
      )
    ).toBe("<div><p>a<strong>b</strong></p><h3>heading clamp</h3></div>")
    expect(
      markup(
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 4 },
              content: [{ type: "text", text: "unwrapped" }],
            },
          ],
        },
        "inline"
      )
    ).toBe("<div>unwrapped</div>")
  })

  it("lifts bare text from an unknown root block without a paragraph wrapper", () => {
    expect(
      markup({
        type: "doc",
        content: [
          { type: "unknownBlock", content: [{ type: "text", text: "lifted" }] },
          { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
        ],
      })
    ).toBe("<div>lifted<p>sibling</p></div>")
  })
})
