import { describe, expect, test, vi } from "vitest"
import {
  translatePlainText,
  translatePageContent,
  translatePrimitiveValue,
  translateRichText,
  translateSlice,
} from "./translationWorkflow"
import { group, list, table, text } from "../slices/primitives"
import type { HeroAgencySlice, Slice } from "../slices"
import { createSampleSlice } from "../slices/sample"
import { buildFieldDoc } from "../richtext/build"
import { validateStrict } from "../richtext/strict"
import { writeSliceFields } from "../richtext/write"

describe("translation workflow", () => {
  test.each(["", " \n "])(
    "RF4c removes empty translated nodes through the registered slice consumer: %j",
    async (empty) => {
      const sample = createSampleSlice("hero-with-image")
      const source = {
        ...sample,
        primary: {
          ...sample.primary,
          title: JSON.stringify(buildFieldDoc("Keep", "title")),
          description: JSON.stringify(buildFieldDoc("Drop", "basic")),
        },
      }
      const before = JSON.stringify(source)
      const result = (await translateSlice(source, {
        translateText: async (value) =>
          value === "Drop"
            ? empty
            : value === "Keep"
              ? "Ligne une\nLigne deux"
              : value,
      })) as typeof source
      // Translation output is not stored as is: a translated newline makes the
      // raw title invalid, and the write path joins it into one line (ADR-0055
      // one-line titles amendment, 2026-11-04).
      expect(validateStrict("title", result.primary.title).ok).toBe(false)
      expect(
        validateStrict(
          "title",
          (writeSliceFields(result, "fr").value as typeof source).primary.title
        )
      ).toEqual({ ok: true })
      expect(validateStrict("basic", result.primary.description)).toEqual({
        ok: true,
      })
      expect(JSON.parse(result.primary.title).content).toEqual([
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Ligne une\nLigne deux" }],
        },
      ])
      // A title is one line: the write path turns the translated newline into a space.
      expect(
        JSON.parse(
          (writeSliceFields(result, "fr").value as typeof source).primary.title
        ).content[0].content
      ).toEqual([{ type: "text", text: "Ligne une Ligne deux" }])
      expect(JSON.parse(result.primary.description).content).toEqual([
        { type: "paragraph", content: [] },
      ])
      expect(JSON.stringify(source)).toBe(before)
      expect(
        await translateSlice(source, {
          enabled: false,
          translateText: async () => empty,
        })
      ).toEqual(source)
      expect(
        await translatePlainText("Keep plain text", {
          translateText: async () => empty,
        })
      ).toBe("Keep plain text")
    }
  )

  test("plain text preserves significant edge whitespace", async () => {
    const translateText = vi.fn(async (text: string) => text.toUpperCase())

    await expect(
      translatePlainText("  Welcome to \n", { translateText })
    ).resolves.toBe("  WELCOME TO \n")
    expect(translateText).toHaveBeenCalledWith("Welcome to")
  })

  test("plain text passes through locale no-ops and empty model output", async () => {
    const disabledTranslator = vi.fn(async () => "should not run")
    await expect(
      translatePlainText("  Same locale  ", {
        enabled: false,
        translateText: disabledTranslator,
      })
    ).resolves.toBe("  Same locale  ")
    expect(disabledTranslator).not.toHaveBeenCalled()

    await expect(
      translatePlainText("  Keep me  ", {
        translateText: async () => " \n ",
      })
    ).resolves.toBe("  Keep me  ")
  })

  test("caller validation observes stored input only when translation runs", async () => {
    const validateText = vi.fn()
    const validateRichText = vi.fn(() => {
      throw new Error("rich limit")
    })
    const translateText = vi.fn(async (value: string) => value)

    await translatePlainText("  Validate me  ", {
      translateText,
      validateText,
    })
    expect(validateText).toHaveBeenCalledWith("  Validate me  ")
    expect(translateText).toHaveBeenCalledWith("Validate me")

    validateText.mockClear()
    await translatePlainText("   ", { translateText, validateText })
    await translatePlainText("disabled", {
      enabled: false,
      translateText,
      validateText,
    })
    expect(validateText).not.toHaveBeenCalled()

    await expect(
      translateRichText("not-pm-json", { translateText, validateRichText })
    ).rejects.toThrow("rich limit")
    expect(validateRichText).toHaveBeenCalledWith("not-pm-json")
  })

  test("rich text translates text nodes without changing structure or marks", async () => {
    const source = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "left" },
          content: [
            { type: "text", text: "Hello " },
            { type: "text", marks: [{ type: "bold" }], text: "world" },
            { type: "hardBreak" },
          ],
        },
      ],
    })
    const translated: string[] = []

    const result = await translateRichText(source, {
      translateText: async (text) => {
        translated.push(text)
        return { Hello: "Bonjour", world: "monde" }[text] ?? text
      },
    })

    expect(translated).toEqual(["Hello", "world"])
    expect(JSON.parse(result)).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { textAlign: "left" },
          content: [
            { type: "text", text: "Bonjour " },
            { type: "text", marks: [{ type: "bold" }], text: "monde" },
            { type: "hardBreak" },
          ],
        },
      ],
    })
  })

  test("primitive traversal translates nested lists, groups, and table cells", async () => {
    const definition = group({
      heading: text(),
      matrix: table(),
      cards: list(
        group({
          label: text(),
        })
      ),
    })
    const value = {
      heading: "Overview",
      matrix: {
        headerRow: ["Feature", "Detail"],
        rows: [["Fast", "Ships today"]],
      },
      cards: [{ label: "First" }, { label: "Second" }],
    }

    await expect(
      translatePrimitiveValue(definition, value, {
        translateText: async (text) => `tx:${text}`,
      })
    ).resolves.toEqual({
      heading: "tx:Overview",
      matrix: {
        headerRow: ["tx:Feature", "tx:Detail"],
        rows: [["tx:Fast", "tx:Ships today"]],
      },
      cards: [{ label: "tx:First" }, { label: "tx:Second" }],
    })
  })

  test("slice traversal translates editorial copy without changing button identity", async () => {
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "We build products" }],
        },
      ],
    })
    const description = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Studio introduction" }],
        },
      ],
    })
    const slice: HeroAgencySlice = {
      id: "hero-1",
      type: "hero-agency",
      enabled: true,
      primary: {
        eyebrow: "Montreal",
        title,
        description,
      },
      items: [
        {
          id: "cta-1",
          label: "Start a project",
          link: { type: "external", url: "https://example.com/contact" },
          variant: "primary",
          withIcon: false,
          enabled: true,
        },
      ],
    }

    const translated = await translateSlice(slice, {
      translateText: async (value) => `tx:${value}`,
    })

    expect(translated).toEqual({
      ...slice,
      primary: {
        eyebrow: "tx:Montreal",
        title: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "tx:We build products" }],
            },
          ],
        }),
        description: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "tx:Studio introduction" }],
            },
          ],
        }),
      },
      items: [
        {
          id: "cta-1",
          label: "tx:Start a project",
          link: { type: "external", url: "https://example.com/contact" },
          variant: "primary",
          withIcon: false,
          enabled: true,
        },
      ],
    })
    expect(slice.primary.description).toBe(description)
  })

  test("page traversal translates metadata with the title, slices, and descriptor leaves", async () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Long-form copy" }],
        },
      ],
    })
    const page = {
      title: "About us",
      metaTitle: "About our studio",
      metaDescription: "Meet the team behind our work",
      slices: [
        {
          id: "body-1",
          type: "rich-text-body",
          enabled: true,
          primary: { body: richText },
        } as Slice,
      ],
      translatables: [
        { path: "excerpt", kind: "text" as const, value: "Our story" },
        { path: "body", kind: "richText" as const, value: richText },
      ],
    }

    await expect(
      translatePageContent(page, {
        translateText: async (value) => `tx:${value}`,
      })
    ).resolves.toEqual({
      title: "tx:About us",
      metaTitle: "tx:About our studio",
      metaDescription: "tx:Meet the team behind our work",
      slices: [
        {
          id: "body-1",
          type: "rich-text-body",
          enabled: true,
          primary: {
            body: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "tx:Long-form copy" }],
                },
              ],
            }),
          },
        },
      ],
      translatables: [
        { path: "excerpt", kind: "text", value: "tx:Our story" },
        {
          path: "body",
          kind: "richText",
          value: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "tx:Long-form copy" }],
              },
            ],
          }),
        },
      ],
    })
  })

  test("page traversal preserves absent and explicitly empty metadata", async () => {
    const translateText = vi.fn(async (value: string) => `tx:${value}`)

    const absent = await translatePageContent(
      { title: "About", slices: [] },
      { translateText }
    )
    expect(Object.hasOwn(absent, "metaTitle")).toBe(false)
    expect(Object.hasOwn(absent, "metaDescription")).toBe(false)

    const empty = await translatePageContent(
      { title: "About", metaTitle: "", metaDescription: "", slices: [] },
      { translateText }
    )
    expect(Object.hasOwn(empty, "metaTitle")).toBe(true)
    expect(Object.hasOwn(empty, "metaDescription")).toBe(true)
    expect(empty.metaTitle).toBe("")
    expect(empty.metaDescription).toBe("")
    expect(translateText).toHaveBeenCalledTimes(2)
  })

  test("disabled page traversal preserves a dense source graph without model calls", async () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Keep this structure" }],
        },
      ],
    })
    const page = {
      title: "Pricing",
      metaTitle: "Plans",
      metaDescription: "Compare every plan",
      slices: [
        {
          id: "hero-dense",
          type: "hero-with-image",
          enabled: false,
          primary: {
            eyebrow: "New",
            eyebrowLink: {
              type: "external",
              url: "https://example.com/news",
              openInNewTab: true,
              sponsored: true,
            },
            title: "Build with us",
            description: richText,
            image: {
              url: "https://example.com/hero.jpg",
              width: 1600,
              height: 900,
              alt: "Structural image alt",
              focal: { x: 0.25, y: 0.75 },
            },
          },
          items: [
            {
              id: "cta-1",
              label: "Start",
              link: { type: "anchor", anchor: "plans" },
              variant: "outline",
              withIcon: true,
              icon: { url: "https://example.com/icon.svg", alt: "Arrow" },
              enabled: false,
            },
          ],
        },
        {
          id: "features-dense",
          type: "features-icon-grid",
          enabled: true,
          primary: {
            eyebrow: "Capabilities",
            heading: "What we do",
            body: richText,
          },
          items: [
            {
              icon: "Sparkles",
              title: "Product strategy",
              body: richText,
            },
          ],
        },
      ] as Slice[],
      translatables: [
        {
          path: "profile.cards[0].label",
          kind: "text" as const,
          value: "Lead",
        },
        {
          path: "profile.cards[0].bio",
          kind: "richText" as const,
          value: richText,
        },
      ],
    }
    const sourceSnapshot = structuredClone(page)
    const translateText = vi.fn(async (value: string) => `tx:${value}`)

    await expect(
      translatePageContent(page, { enabled: false, translateText })
    ).resolves.toEqual(sourceSnapshot)
    expect(page).toEqual(sourceSnapshot)
    expect(translateText).not.toHaveBeenCalled()
  })

  test("disabled traversal preserves a bold FAQ question without projecting it", async () => {
    const question = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [
            { type: "text", text: "Important", marks: [{ type: "bold" }] },
          ],
        },
      ],
    })
    const page = {
      title: "Page",
      slices: [
        {
          id: "faq",
          type: "faq-simple",
          enabled: true,
          primary: { heading: "", eyebrow: "", body: "" },
          items: [{ itemId: "stable", question, answer: "" }],
        },
      ] as Slice[],
    }
    const source = structuredClone(page)
    const translateText = vi.fn(async (value: string) => `tx:${value}`)

    await expect(
      translatePageContent(page, { enabled: false, translateText })
    ).resolves.toEqual({ ...source, translatables: [] })
    expect(page).toEqual(source)
    expect(translateText).not.toHaveBeenCalled()
  })

  test("disabled traversal preserves a marked primary FAQ rich-text heading byte-for-byte", async () => {
    const heading = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [
            { type: "text", text: "Keep bold", marks: [{ type: "bold" }] },
          ],
        },
      ],
    })
    const page = {
      title: "Body",
      slices: [
        {
          id: "faq-disabled-primary-heading",
          type: "faq-simple",
          enabled: true,
          primary: { heading, eyebrow: "", body: "" },
          items: [],
        },
      ] as Slice[],
    }
    const source = structuredClone(page)
    const translateText = vi.fn(async (value: string) => `tx:${value}`)

    await expect(
      translatePageContent(page, { enabled: false, translateText })
    ).resolves.toEqual({ ...source, translatables: [] })
    expect(page).toEqual(source)
    expect(translateText).not.toHaveBeenCalled()
  })

  test("a later descriptor-leaf rejection returns no partial page and preserves the source", async () => {
    const richText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Slice copy" }],
        },
      ],
    })
    const page = {
      title: "About",
      metaTitle: "About the team",
      metaDescription: "Who we are",
      slices: [
        {
          id: "body-failure",
          type: "rich-text-body",
          enabled: true,
          primary: { body: richText },
        } as Slice,
      ],
      translatables: [
        { path: "profile.name", kind: "text" as const, value: "First leaf" },
        {
          path: "profile.cards[2].bio",
          kind: "text" as const,
          value: "Reject later leaf",
        },
      ],
    }
    const sourceSnapshot = structuredClone(page)

    await expect(
      translatePageContent(page, {
        translateText: async (value) => {
          if (value === "Reject later leaf") throw new Error("leaf rejected")
          return `tx:${value}`
        },
      })
    ).rejects.toThrow("leaf rejected")
    expect(page).toEqual(sourceSnapshot)
  })

  test("FAQ transition sends the plain projection to translation and preserves row metadata", async () => {
    const question = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Question" }],
        },
      ],
    })
    const seen: string[] = []
    const faq = {
      id: "faq",
      type: "faq-simple",
      enabled: true,
      primary: { heading: "FAQ", eyebrow: "", body: "" },
      items: [{ itemId: "stable-row", question, answer: "" }],
    } as unknown as Slice
    const translated = await translateSlice(faq, {
      translateText: async (value) => {
        seen.push(value)
        return `translated:${value}`
      },
    })
    expect(seen).toContain("Question")
    expect(seen).not.toContain(question)
    expect(
      (translated as unknown as { items: Array<{ itemId: string }> }).items[0]
        ?.itemId
    ).toBe("stable-row")
  })

  test("group reconstruction retains itemId and opaque row metadata", async () => {
    const definition = group({ rows: list(group({ label: text() })) })
    const value = {
      rows: [{ itemId: "row-1", serverMetadata: "keep", label: "Hello" }],
    }
    const translated = await translatePrimitiveValue(definition, value, {
      translateText: async (text) => `tx:${text}`,
    })
    expect(translated).toEqual({
      rows: [{ itemId: "row-1", serverMetadata: "keep", label: "tx:Hello" }],
    })
  })
})

test("registered basic body translation preserves block structure, marks and links", async () => {
  const sample = createSampleSlice("features-icon-grid")
  const document = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "First",
            marks: [
              { type: "bold" },
              { type: "link", attrs: { href: "https://example.com" } },
            ],
          },
        ],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Heading" }],
      },
      {
        type: "orderedList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Item" }] },
            ],
          },
        ],
      },
      { type: "paragraph", content: [{ type: "text", text: "Last" }] },
    ],
  }
  sample.primary.body = JSON.stringify(document)
  sample.items[0].body = JSON.stringify(document)
  const before = JSON.stringify(sample)
  const translated = (await translateSlice(sample, {
    translateText: async (text) => `FR ${text}`,
  })) as typeof sample
  const expected = JSON.parse(
    JSON.stringify(document).replace(/"text":"([^"]*)"/g, '"text":"FR $1"')
  )
  expect(JSON.parse(translated.primary.body!)).toEqual(expected)
  expect(JSON.parse(translated.items[0].body)).toEqual(expected)
  expect(validateStrict("basic", translated.items[0].body)).toEqual({
    ok: true,
  })
  expect(JSON.stringify(sample)).toBe(before)
})

describe("durable translation enumeration and assembly", () => {
  const textNode = (text: string) => ({ type: "text", text })
  const paragraph = (text: string) => ({
    type: "paragraph",
    content: text ? [textNode(text)] : [],
  })
  const shapes = [
    {
      name: "loose paragraphs with first and last edges",
      content: [
        paragraph("First loose word"),
        paragraph(""),
        paragraph("Last loose word"),
      ],
    },
    {
      name: "Word-style marks and links",
      content: [
        {
          type: "paragraph",
          content: [
            {
              ...textNode("Linked bold word"),
              marks: [
                { type: "bold" },
                {
                  type: "link",
                  attrs: { href: "https://example.test/old", target: "_blank" },
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "nested lists",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                paragraph("Outer"),
                {
                  type: "orderedList",
                  content: [
                    { type: "listItem", content: [paragraph("Inner")] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "blockquote and loose text",
      content: [
        paragraph("Before"),
        { type: "blockquote", content: [paragraph("Quoted")] },
        paragraph("After"),
      ],
    },
    {
      name: "table header and body",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                { type: "tableHeader", content: [paragraph("Header")] },
                { type: "tableCell", content: [paragraph("Cell")] },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "Google Docs hard breaks",
      content: [
        {
          type: "paragraph",
          content: [
            textNode("First"),
            { type: "hardBreak" },
            textNode("Second"),
          ],
        },
      ],
    },
    {
      name: "non-text image and link attributes",
      content: [
        paragraph("Before image"),
        {
          type: "image",
          attrs: { src: "https://example.test/image.png", alt: "Image alt" },
        },
        paragraph("After image"),
      ],
    },
    {
      name: "code-looking plain text and nonbreaking spaces",
      content: [
        {
          type: "codeBlock",
          content: [
            textNode('{"key":"value"} <p>plain</p> **text**\u00a0kept'),
          ],
        },
      ],
    },
  ]
  test.each(shapes)(
    "$name: same fake translator equals instant output and identity round trip drops no words",
    async ({ content }) => {
      const { enumerateSegments, assembleTranslation } =
        await import("./translationWorkflow")
      const page = {
        title: "  Page title  ",
        metaTitle: "",
        metaDescription: "Last metadata",
        slices: [],
        translatables: [
          {
            path: "body",
            kind: "richText" as const,
            value: JSON.stringify({ type: "doc", content }),
          },
          {
            path: "plain",
            kind: "text" as const,
            value: '{"plain":"JSON"} <b>HTML</b> **Markdown**',
          },
        ],
      }
      const before = structuredClone(page)
      const segments = await enumerateSegments(page)
      expect(new Set(segments.map((segment) => segment.address)).size).toBe(
        segments.length
      )
      const translated = (text: string) => `FR ${text}`
      const outputs = segments.map((segment) => ({
        address: segment.address,
        text: translated(segment.text),
      }))
      expect(await assembleTranslation(page, outputs)).toEqual(
        await translatePageContent(page, {
          translateText: async (text) => translated(text),
        })
      )
      const identity = await assembleTranslation(
        page,
        segments.map((segment) => ({
          address: segment.address,
          text: segment.text,
        }))
      )
      expect(identity).toEqual(
        await translatePageContent(page, {
          translateText: async (text) => text,
        })
      )
      const words = (value: string) =>
        JSON.stringify(JSON.parse(value)).match(/[^\s]+/g)
      expect(words(identity.translatables[0]!.value)).toEqual(
        words(page.translatables[0]!.value)
      )
      expect(identity.translatables[1]!.value).toBe(
        page.translatables[1]!.value
      )
      expect(page).toEqual(before)
      const disabled = vi.fn(async () => "should not run")
      expect(
        await translatePageContent(page, {
          enabled: false,
          translateText: disabled,
        })
      ).toEqual(page)
      expect(disabled).not.toHaveBeenCalled()
    }
  )
  test("addresses cover metadata and registered slice fields; missing, extra and duplicate outputs refuse", async () => {
    const { enumerateSegments, assembleTranslation } =
      await import("./translationWorkflow")
    const slice = createSampleSlice("hero-with-image")
    const page = {
      title: "Title",
      metaTitle: "Meta",
      metaDescription: "Description",
      slices: [slice],
      translatables: [],
    }
    const segments = await enumerateSegments(page)
    expect(segments.map((segment) => segment.address)).toEqual(
      expect.arrayContaining(["title", "metaTitle", "metaDescription"])
    )
    expect(
      segments.some((segment) =>
        segment.address.startsWith("slices[0].primary.")
      )
    ).toBe(true)
    const outputs = segments.map((segment) => ({
      address: segment.address,
      text: `FR ${segment.text}`,
    }))
    expect(await assembleTranslation(page, outputs)).toEqual(
      await translatePageContent(page, {
        translateText: async (text) => `FR ${text}`,
      })
    )
    await expect(assembleTranslation(page, outputs.slice(1))).rejects.toThrow(
      "Missing"
    )
    await expect(
      assembleTranslation(page, [
        ...outputs,
        { address: "extra", text: "extra" },
      ])
    ).rejects.toThrow("Unexpected")
    await expect(
      assembleTranslation(page, [...outputs, outputs[0]!])
    ).rejects.toThrow("Duplicate")
  })
  test("supported segment/text/rich-text limits refuse before jobs or provider calls", async () => {
    const { enumerateSegments } = await import("./translationWorkflow")
    const page = { title: "Title", slices: [], translatables: [] }
    await expect(
      enumerateSegments({ ...page, title: "a".repeat(5001) })
    ).rejects.toThrow("too long")
    await expect(
      enumerateSegments({
        ...page,
        translatables: [
          { path: "body", kind: "richText", value: " ".repeat(200001) },
        ],
      })
    ).rejects.toThrow("too large")
    await expect(
      enumerateSegments({
        ...page,
        translatables: Array.from({ length: 60 }, (_, index) => ({
          path: `p${index}`,
          kind: "text",
          value: "Text",
        })),
      })
    ).rejects.toThrow("Too many")
  })
})
