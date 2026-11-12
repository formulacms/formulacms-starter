import { describe, expect, it } from "vitest"

import { normalizeRenderDocument } from "./tolerant-reader"

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

describe("normalizeRenderDocument", () => {
  it("preserves valid documents and is idempotent for each field contract", () => {
    const documents: ReadonlyArray<readonly [string, unknown]> = [
      [
        "inline",
        {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "caption" }] },
          ],
        },
      ],
      [
        "basic",
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "title" }],
            },
          ],
        },
      ],
      [
        "full",
        {
          type: "doc",
          content: [
            {
              type: "table",
              content: [
                {
                  type: "tableRow",
                  content: [
                    {
                      type: "tableCell",
                      content: [
                        {
                          type: "paragraph",
                          content: [{ type: "text", text: "body" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      [
        "title",
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 1 },
              content: [{ type: "text", text: "title" }],
            },
          ],
        },
      ],
    ]

    for (const [contract, document] of documents) {
      const once = normalizeRenderDocument(
        document,
        contract as "inline" | "basic" | "full" | "title"
      )
      expect(
        normalizeRenderDocument(
          once,
          contract as "inline" | "basic" | "full" | "title"
        )
      ).toEqual(once)
    }
  })

  it("lifts unknown and out-of-contract wrappers while keeping sibling order", () => {
    const document = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        {
          type: "unknownWrapper",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "unknown child" }],
            },
            {
              type: "customBlock",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "nested child" }],
                },
              ],
            },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
        { type: "unknownLeaf" },
      ],
    }
    expect(normalizeRenderDocument(document, "full")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "unknown child" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "nested child" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    })

    expect(
      normalizeRenderDocument(
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "unwrapped" }],
                },
              ],
            },
          ],
        },
        "inline"
      )
    ).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "unwrapped" }] },
      ],
    })
  })

  it("drops unsupported marks and malformed entries without losing allowed marks", () => {
    const input = {
      type: "doc",
      content: [
        null,
        7,
        [],
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "kept",
              marks: [
                null,
                "bold",
                [],
                {},
                { type: "unknown" },
                { type: "code" },
                { type: "bold", attrs: { source: "kept" } },
                { type: "italic" },
              ],
            },
          ],
        },
      ],
    }
    expect(normalizeRenderDocument(input, "basic")).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "kept",
              marks: [
                { type: "bold", attrs: { source: "kept" } },
                { type: "italic" },
              ],
            },
          ],
        },
      ],
    })
    expect(
      normalizeRenderDocument(
        {
          type: "doc",
          content: [
            {
              type: "heading",
              content: [
                {
                  type: "text",
                  text: "title",
                  marks: [
                    { type: "bold" },
                    { type: "link", attrs: { href: "/x" } },
                  ],
                },
              ],
            },
          ],
        },
        "title"
      )
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "title", marks: [{ type: "bold" }] }],
        },
      ],
    })
  })

  it("drops empty and non-string text and omits malformed nested properties", () => {
    const input = {
      type: "doc",
      content: [
        { type: "text", text: "" },
        { type: "text", text: 42 },
        { type: "paragraph", content: { invalid: true }, marks: "invalid" },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "valid", content: "invalid", marks: {} },
          ],
        },
      ],
    }
    expect(normalizeRenderDocument(input, "basic")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "valid" }] },
      ],
    })
    expect(
      normalizeRenderDocument({ type: "doc", content: "bad" }, "full")
    ).toEqual({
      type: "doc",
      content: [],
    })
    expect(normalizeRenderDocument(null, "full")).toEqual({
      type: "doc",
      content: [],
    })
    expect(normalizeRenderDocument({ type: "paragraph" }, "full")).toEqual({
      type: "doc",
      content: [],
    })
  })

  it("repairs headings from scalar integer values and contract-specific levels", () => {
    const document = (levels: unknown[]) => ({
      type: "doc",
      content: levels.map((level) => ({
        type: "heading",
        attrs: level === "missing" ? {} : { level },
        content: [{ type: "text", text: "h" }],
      })),
    })
    const levels = (contract: "basic" | "full" | "title", values: unknown[]) =>
      normalizeRenderDocument(document(values), contract).content?.map(
        (node) => node.attrs?.level
      )

    expect(
      levels("basic", [4, "4", "2", "missing", "garbage", 0, 2.5])
    ).toEqual([3, 3, 2, 2, 2, 2, 2])
    expect(levels("full", [7, "missing", "garbage"])).toEqual([6, 1, 1])
    expect(levels("title", ["missing", "6"])).toEqual([1, 6])
    expect(
      normalizeRenderDocument(
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: { valueOf: null, toString: null } },
              content: [{ type: "text", text: "repaired" }],
            },
            { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
          ],
        },
        "basic"
      )
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "repaired" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
      ],
    })
    expect(
      normalizeRenderDocument(
        {
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "paragraph" }],
            },
          ],
        },
        "inline"
      )
    ).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
  })

  it("neutralizes only missing link targets and preserves explicit link attrs", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "plain",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "/plain",
                    title: "Plain",
                    pageId: "p1",
                    noFollow: true,
                    sponsored: true,
                    ugc: true,
                  },
                },
              ],
            },
            {
              type: "text",
              text: "self",
              marks: [
                { type: "link", attrs: { href: "/self", target: "_self" } },
              ],
            },
            {
              type: "text",
              text: "blank",
              marks: [
                { type: "link", attrs: { href: "/blank", target: "_blank" } },
              ],
            },
          ],
        },
      ],
    }
    const normalized = normalizeRenderDocument(document, "basic")
    expect(normalized.content?.[0]?.content?.map((node) => node.marks)).toEqual(
      [
        [
          {
            type: "link",
            attrs: {
              href: "/plain",
              title: "Plain",
              pageId: "p1",
              noFollow: true,
              sponsored: true,
              ugc: true,
              target: null,
            },
          },
        ],
        [{ type: "link", attrs: { href: "/self", target: "_self" } }],
        [{ type: "link", attrs: { href: "/blank", target: "_blank" } }],
      ]
    )
  })

  it("does not mutate inputs and stays deterministic across the representative corpus", () => {
    const corpus = deepFreeze([
      {
        type: "doc",
        content: [
          {
            type: "unknown",
            content: [
              {
                type: "paragraph",
                attrs: { class: "x" },
                content: [
                  { type: "text", text: "a", marks: [{ type: "bold" }] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: "4" },
            content: [{ type: "text", text: "b" }],
          },
        ],
      },
      {
        type: "doc",
        content: [
          { type: "text", text: "" },
          { type: "paragraph", marks: "bad" },
        ],
      },
    ])
    const snapshot = JSON.stringify(corpus)
    for (const document of corpus) {
      const first = normalizeRenderDocument(document, "basic")
      const second = normalizeRenderDocument(document, "basic")
      expect(second).toEqual(first)
      expect(normalizeRenderDocument(first, "basic")).toEqual(first)
    }
    expect(JSON.stringify(corpus)).toBe(snapshot)
    expect(Object.isFrozen(corpus)).toBe(true)
  })
  it("keeps structured-looking text and edge paragraphs unchanged", () => {
    const document = deepFreeze({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: '{"type":"doc","content":[]}' }],
        },
        { type: "paragraph", content: [] },
        {
          type: "paragraph",
          content: [{ type: "text", text: "<strong>literal HTML</strong>" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "# literal Markdown\nlast line" }],
        },
      ],
    })
    const before = JSON.stringify(document)
    expect(normalizeRenderDocument(document, "basic")).toEqual(document)
    expect(JSON.stringify(document)).toBe(before)
  })

  it("preserves link, mark, attribute and first/last-block changes", () => {
    const document = (
      href: string,
      mark: string,
      level: number,
      first: string,
      last: string
    ) => ({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: first,
              marks: [
                { type: mark },
                { type: "link", attrs: { href, target: null, title: "kept" } },
              ],
            },
          ],
        },
        { type: "paragraph", content: [] },
        {
          type: "heading",
          attrs: { level },
          content: [{ type: "text", text: "middle" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: last }],
        },
      ],
    })
    const base = normalizeRenderDocument(
      document("/original", "bold", 2, "first", "last"),
      "basic"
    )
    for (const changed of [
      document("/changed", "bold", 2, "first", "last"),
      document("/original", "italic", 2, "first", "last"),
      document("/original", "bold", 3, "first", "last"),
      document("/original", "bold", 2, "changed first", "last"),
      document("/original", "bold", 2, "first", "changed last"),
    ]) {
      const result = normalizeRenderDocument(deepFreeze(changed), "basic")
      expect(result).toEqual(changed)
      expect(result).not.toEqual(base)
    }
  })

  it("isolates locale and published copies across a JSON normalization round trip", () => {
    const stored = deepFreeze({
      en: {
        type: "doc",
        content: [
          {
            type: "unknownWrapper",
            content: [
              {
                type: "heading",
                attrs: { level: "9" },
                content: [{ type: "text", text: "EN draft" }],
              },
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "draft link",
                    marks: [{ type: "link", attrs: { href: "/en/draft" } }],
                  },
                ],
              },
            ],
          },
        ],
      },
      fr: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "FR draft" }],
          },
        ],
      },
      published: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "EN published" }],
          },
        ],
      },
    })
    const before = JSON.stringify(stored)
    const once = normalizeRenderDocument(stored.en, "basic")
    const reloaded = JSON.parse(JSON.stringify(once))
    expect(normalizeRenderDocument(reloaded, "basic")).toEqual(once)
    expect(once.content?.[0]).toMatchObject({
      type: "heading",
      attrs: { level: 3 },
    })
    expect(JSON.stringify(stored)).toBe(before)
    expect(stored.fr.content[0]?.content[0]?.text).toBe("FR draft")
    expect(stored.published.content[0]?.content[0]?.text).toBe("EN published")
  })
})
