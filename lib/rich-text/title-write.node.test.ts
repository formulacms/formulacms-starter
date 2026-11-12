import { describe, expect, test } from "vitest"
import { createSampleSlice } from "@/convex/lib/slices/sample"
import type { Slice } from "@/convex/lib/slices"
import { adoptHeroTitles } from "./adopt-hero-titles"
import { canonicalTitleLine } from "./title-write"
import { renderStaticRichTextDocument } from "./static-render"
import { renderToStaticMarkup } from "react-dom/server"

// Owner 2026-11-04 (ADR-0055 amendment): a title is one line. Every break
// becomes one space on save. One pure function, used by every title writer.

type Node = Record<string, unknown>
const heading = (content?: Node[], level = 2) =>
  JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level }, ...(content ? { content } : {}) },
    ],
  })
const text = (value: string, marks?: Node[]): Node => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
})
const br: Node = { type: "hardBreak" }
const bold = [{ type: "bold" }]

describe("canonicalTitleLine", () => {
  test("an inner break becomes one space; a trailing break is dropped", () => {
    expect(
      canonicalTitleLine(heading([text("a"), br, text("b"), br]))
    ).toBe(heading([text("a b")]))
  })

  test("every break at the very end is dropped, not only the last one", () => {
    expect(canonicalTitleLine(heading([text("a"), br, br]))).toBe(
      heading([text("a")])
    )
  })

  test("consecutive and leading breaks collapse to one space or nothing", () => {
    expect(canonicalTitleLine(heading([br, text("a"), br, br, text("b")]))).toBe(
      heading([text("a b")])
    )
  })

  test("row 1: an already-canonical title comes back byte for byte", () => {
    const value = heading([text("a b")])
    expect(canonicalTitleLine(value)).toBe(value)
    const marked = heading([text("a", bold), text(" b")])
    expect(canonicalTitleLine(marked)).toBe(marked)
  })

  test("row 2: marks survive; a break between equal marks becomes a marked space", () => {
    expect(
      canonicalTitleLine(heading([text("a", bold), br, text("last", bold), br]))
    ).toBe(heading([text("a last", bold)]))
    expect(
      canonicalTitleLine(heading([text("a", bold), br, text("b")]))
    ).toBe(heading([text("a", bold), text(" b")]))
  })

  test("row 3: text that looks like JSON or HTML, or is not a document, is returned as is", () => {
    for (const value of [
      "<b>x</b>",
      "plain\n",
      "",
      '{"type":"doc"',
      '{"type":"paragraph"}',
      '"a string"',
    ])
      expect(canonicalTitleLine(value)).toBe(value)
  })

  test("a title made only of breaks becomes an empty heading", () => {
    expect(canonicalTitleLine(heading([br]))).toBe(heading())
  })

  test("two paragraphs and a newline inside text join with one space", () => {
    const two = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [text("a")] },
        { type: "paragraph", content: [text("b")] },
      ],
    })
    expect(canonicalTitleLine(two)).toBe(heading([text("a b")]))
    expect(canonicalTitleLine(heading([text("a\nb")]))).toBe(
      heading([text("a b")])
    )
  })

  test("row 8: another locale's value is not touched by canonicalising this one", () => {
    const en = heading([text("Hello"), br])
    const fr = heading([text("Bonjour l’équipe « œuvre »")])
    expect(canonicalTitleLine(fr)).toBe(fr)
    expect(canonicalTitleLine(en)).toBe(heading([text("Hello")]))
  })

  test("row 9: canonicalising is stable (load, save, load)", () => {
    const once = canonicalTitleLine(heading([text("a"), br, br, text("b")]))
    expect(canonicalTitleLine(once)).toBe(once)
  })
})

function hero(title: string, description?: string): Slice {
  const sample = createSampleSlice("hero-with-image")
  return {
    ...sample,
    id: "h1",
    primary: {
      ...sample.primary,
      title,
      ...(description === undefined ? {} : { description }),
    },
    items: sample.items.map((row, index) => ({
      ...row,
      itemId: `h1-row-${index}`,
    })),
  } as Slice
}
const titleOf = (slice: Slice) =>
  (slice as unknown as { primary: { title: string } }).primary.title

describe("adoptHeroTitles makes a title one line when it prepares a save", () => {
  const withBreaks = heading([text("Un"), br, text("Deux"), br])
  const oneLine = heading([text("Un Deux")])

  test("a save and a draft read both turn breaks into spaces", () => {
    const saved = adoptHeroTitles([hero(withBreaks)], "en", [], true)
    expect(titleOf(saved.value[0])).toBe(oneLine)
    const draft = adoptHeroTitles([hero(withBreaks)], "en")
    expect(titleOf(draft.value[0])).toBe(oneLine)
  })

  test("the form editor's paragraph shape is converted, then made one line", () => {
    const formShape = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text("Un"), br, text("Deux"), br],
        },
      ],
    })
    const saved = adoptHeroTitles([hero(formShape)], "en", [], true)
    expect(JSON.parse(titleOf(saved.value[0])).content[0].content).toEqual([
      text("Un Deux"),
    ])
  })

  test("row 1: an unchanged title saves byte for byte", () => {
    const slice = hero(oneLine)
    const saved = adoptHeroTitles([slice], "en", [], true)
    expect(titleOf(saved.value[0])).toBe(oneLine)
  })

  test("non-title rich-text fields keep a trailing break", () => {
    const body = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [text("Body"), br] }],
    })
    const saved = adoptHeroTitles([hero(oneLine, body)], "en", [], true)
    const primary = (
      saved.value[0] as unknown as { primary: Record<string, string> }
    ).primary
    expect(primary.description).toBe(body)
  })

  test("row 4: the public heading renders no <br> for a stored break", () => {
    const saved = titleOf(
      adoptHeroTitles([hero(withBreaks)], "en", [], true).value[0]
    )
    const html = renderToStaticMarkup(
      renderStaticRichTextDocument(JSON.parse(saved), "title")
    )
    expect(html).not.toMatch(/<br\s*\/?>/)
    expect(html).toContain("Un Deux")
  })

  test.each([
    ["features-icon-grid", "title"],
    ["faq-simple", "question"],
  ] as const)(
    "list rows: %s items[].%s becomes one line on write and on a draft read",
    (type, field) => {
      const sample = createSampleSlice(type)
      const itemTitle = heading([text("Un"), br, text("Deux"), br], 3)
      const row = (sample as unknown as { items: Record<string, unknown>[] })
        .items[0]
      const slice = {
        ...sample,
        id: "list-1",
        items: [{ ...row, itemId: "list-1-row-0", [field]: itemTitle }],
      } as unknown as Slice
      const saved = adoptHeroTitles([slice], "en", [], true)
      const value = (
        saved.value[0] as unknown as { items: Record<string, string>[] }
      ).items[0][field]
      expect(JSON.parse(value).content[0].content).toEqual([text("Un Deux")])
      const draft = adoptHeroTitles([slice], "en")
      const kept = (
        draft.value[0] as unknown as { items: Record<string, string>[] }
      ).items[0][field]
      expect(JSON.parse(kept).content[0].content).toEqual([text("Un Deux")])
    }
  )
})
