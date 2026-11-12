import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { JSONContent } from "@tiptap/core"

import { renderStaticRichTextDocument } from "./static-render"

describe("static renderer safe handler wrappers", () => {
  it("contains hostile JSON image dimensions to the affected node", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    const hostileNumber = { valueOf: null, toString: null }
    const document: JSONContent = {
      type: "doc",
      content: [
        {
          type: "image",
          attrs: { src: "/hostile.png", width: hostileNumber },
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "sibling survives" }],
        },
      ],
    }

    try {
      const staticMarkup = renderToStaticMarkup(
        createElement(
          "div",
          null,
          renderStaticRichTextDocument(document, "full")
        )
      )
      expect(staticMarkup).toContain("sibling survives")
      expect(staticMarkup).not.toContain("<img")
      expect(warning).toHaveBeenCalledTimes(1)
    } finally {
      warning.mockRestore()
    }
  })

  for (const profile of ["inline", "basic", "full"] as const) {
    it(`renders known handlers with prototype-safe mappings (${profile})`, () => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined)
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      try {
        const html = renderToStaticMarkup(
          createElement(
            "div",
            null,
            renderStaticRichTextDocument(
              {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "known handler" }],
                  },
                ],
              },
              profile
            )
          )
        )
        expect(html).toBe(
          profile === "inline"
            ? "<div>known handler</div>"
            : "<div><p>known handler</p></div>"
        )
        expect(warning).not.toHaveBeenCalled()
        expect(error).not.toHaveBeenCalled()
      } finally {
        warning.mockRestore()
        error.mockRestore()
      }
    })
  }

  for (const profile of ["inline", "basic", "full"] as const) {
    for (const type of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ] as const) {
      it(`safe unknown-node fallback: ${profile}/${type}`, () => {
        const warning = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined)
        const error = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined)
        try {
          const html = renderToStaticMarkup(
            createElement(
              "div",
              null,
              renderStaticRichTextDocument(
                {
                  type: "doc",
                  content: [
                    {
                      type,
                      content: [{ type: "text", text: "must be omitted" }],
                    },
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "sibling survives" }],
                    },
                  ],
                },
                profile
              )
            )
          )
          expect(html).toBe(
            profile === "inline"
              ? "<div>must be omitted<br/><br/>sibling survives</div>"
              : "<div>must be omitted<p>sibling survives</p></div>"
          )
          expect(warning).not.toHaveBeenCalled()
          expect(error).not.toHaveBeenCalled()
        } finally {
          warning.mockRestore()
          error.mockRestore()
        }
      })
    }
  }

  for (const profile of ["inline", "basic", "full"] as const) {
    for (const type of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
    ] as const) {
      it(`safe unknown-mark fallback: ${profile}/${type}`, () => {
        const warning = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined)
        const error = vi
          .spyOn(console, "error")
          .mockImplementation(() => undefined)
        try {
          const html = renderToStaticMarkup(
            createElement(
              "div",
              null,
              renderStaticRichTextDocument(
                {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [
                        {
                          type: "text",
                          text: "marked sibling",
                          marks: [{ type }],
                        },
                      ],
                    },
                  ],
                },
                profile
              )
            )
          )
          expect(html).toBe(
            profile === "inline"
              ? "<div>marked sibling</div>"
              : "<div><p>marked sibling</p></div>"
          )
          expect(warning).not.toHaveBeenCalled()
          expect(error).not.toHaveBeenCalled()
        } finally {
          warning.mockRestore()
          error.mockRestore()
        }
      })
    }
  }
})
