import { describe, expect, test } from "vitest"
import {
  collectTextSegments,
  replaceTextSegments,
  parsePMDoc,
  richTextToPlainText,
} from "./pmText"

const doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world", marks: [{ type: "bold" }] },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "link",
          marks: [{ type: "link", attrs: { href: "/x" } }],
        },
      ],
    },
  ],
}

describe("collectTextSegments", () => {
  test("returns text nodes in document order", () => {
    expect(collectTextSegments(doc)).toEqual(["Hello ", "world", "link"])
  })

  test("empty doc yields no segments", () => {
    expect(collectTextSegments({ type: "doc", content: [] })).toEqual([])
  })
})

describe("replaceTextSegments", () => {
  test("replaces text while preserving marks and structure", () => {
    const out = replaceTextSegments(doc, ["Bonjour ", "monde", "lien"]) as {
      content: Array<{ content: Array<{ text: string; marks?: unknown[] }> }>
    }
    expect(collectTextSegments(out)).toEqual(["Bonjour ", "monde", "lien"])
    // marks survive
    expect(out.content[0].content[1].marks).toEqual([{ type: "bold" }])
    expect(out.content[1].content[0].marks).toEqual([
      { type: "link", attrs: { href: "/x" } },
    ])
    // original is not mutated
    expect(collectTextSegments(doc)).toEqual(["Hello ", "world", "link"])
  })

  test("a short replacement array leaves trailing text untouched", () => {
    const out = replaceTextSegments(doc, ["Bonjour "])
    expect(collectTextSegments(out)).toEqual(["Bonjour ", "world", "link"])
  })
})

describe("parsePMDoc", () => {
  test("parses a real PM doc", () => {
    expect(parsePMDoc(JSON.stringify(doc))?.type).toBe("doc")
  })
  test("rejects non-JSON and non-doc shapes", () => {
    expect(parsePMDoc("<p>legacy html</p>")).toBeNull()
    expect(parsePMDoc('{"type":"paragraph"}')).toBeNull()
    expect(parsePMDoc("")).toBeNull()
  })
})

describe("richTextToPlainText", () => {
  test("extracts PM text and normalizes legacy HTML or plain text", () => {
    expect(richTextToPlainText(JSON.stringify(doc))).toBe("Hello world link")
    expect(richTextToPlainText("<strong>Legacy</strong> title")).toBe(
      "Legacy title"
    )
    expect(richTextToPlainText("  Plain   title  ")).toBe("Plain title")
  })

  test("separates hard breaks and block boundaries before whitespace collapse", () => {
    const separated = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "first" },
            { type: "hardBreak" },
            { type: "text", text: "line" },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "next" }],
        },
      ],
    }
    expect(richTextToPlainText(JSON.stringify(separated))).toBe(
      "first line next"
    )
  })
})
