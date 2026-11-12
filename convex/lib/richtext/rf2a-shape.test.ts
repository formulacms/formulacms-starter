import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { resolveFieldContract } from "./contracts"
import { toComparisonForm, toDescriptorComparisonForm } from "./comparison"
import {
  convertTransitionTitle,
  readFieldText,
  readTransitionField,
  transitionForField,
} from "./transitions"
import { toFieldShape } from "./shape"
import { validateLegacy, validateStrict } from "./strict"
import { group, text } from "../slices/primitives"
import { buildPMDocForContract } from "./build"

const title = resolveFieldContract({
  contract: "title",
  heading: { role: "itemTitle" },
})
const inline = resolveFieldContract({ contract: "inline" })

describe("RF2a field shape and transition readers", () => {
  test("title conversion is idempotent and preserves already-canonical bytes", () => {
    const canonical = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Keep" }],
        },
      ],
    })
    expect(toFieldShape(title, canonical)).toEqual({
      value: canonical,
      removedLinks: [],
    })
    expect(toFieldShape(title, toFieldShape(title, "Plain").value).value).toBe(
      toFieldShape(title, "Plain").value
    )
  })

  test("contract-aware title builder uses the role default and turns newlines into spaces", () => {
    expect(
      buildPMDocForContract("one\ntwo", {
        contract: "title",
        heading: { role: "itemTitle" },
      })
    ).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "one two" }],
        },
      ],
    })
  })

  test("title upcast trims empty edges, joins blocks with spaces and reports links in order", () => {
    const source = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "A",
              marks: [{ type: "link", attrs: { href: "/a" } }],
            },
          ],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "B",
              marks: [{ type: "link", attrs: { pageId: "p2" } }],
            },
          ],
        },
        { type: "paragraph" },
      ],
    })
    const result = toFieldShape(title, source)
    expect(JSON.parse(result.value).content[0].attrs.level).toBe(3)
    expect(
      JSON.parse(result.value).content[0].content.map(
        (node: { type: string }) => node.type
      )
    ).toEqual(["text"])
    expect(
      JSON.parse(result.value).content[0].content.map(
        (node: { text: string }) => node.text
      )
    ).toEqual(["A B"])
    expect(result.removedLinks).toEqual([{ href: "/a" }, { pageId: "p2" }])
    expect(toFieldShape(title, "").value).toBe(
      JSON.stringify({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 3 } }],
      })
    )
    expect(toFieldShape(title, "   ").value).toBe(
      JSON.stringify({
        type: "doc",
        content: [{ type: "heading", attrs: { level: 3 } }],
      })
    )
  })

  test("inline downcast and title conversion preserve malformed values", () => {
    const heading = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "x" }],
        },
      ],
    })
    expect(
      JSON.parse(toFieldShape(inline, heading).value).content[0].type
    ).toBe("paragraph")
    const malformed = '{"type":"doc","content":[null]}'
    expect(toFieldShape(title, malformed)).toEqual({
      value: malformed,
      removedLinks: [],
    })
    expect(toFieldShape(inline, "<p>legacy</p>").value).toBe("<p>legacy</p>")
    expect(toFieldShape(title, "<p>legacy</p>").value).toBe("<p>legacy</p>")
  })

  test("title conversion preserves multi-heading and mixed wrapper docs as unconvertible", () => {
    const twoHeadings = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "One" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Two" }],
        },
      ],
    })
    const mixed = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "One" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "Two" }] },
      ],
    })
    expect(toFieldShape(title, twoHeadings)).toEqual({
      value: twoHeadings,
      removedLinks: [],
    })
    expect(toFieldShape(title, mixed)).toEqual({
      value: mixed,
      removedLinks: [],
    })
  })

  test("canonicalizes non-default heading levels to the role default but keeps default bytes", () => {
    const nonDefault = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "Keep" }],
        },
      ],
    })
    const normalized = toFieldShape(title, nonDefault).value
    expect(JSON.parse(normalized).content[0].attrs.level).toBe(3)
    expect(toFieldShape(title, normalized).value).toBe(normalized)
  })

  test("role-default title round-trip and descriptor comparison preserve content", sliceProfile([]), () => {
    const source = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Why?" }],
        },
      ],
    })
    const inlineValue = toFieldShape(inline, source).value
    expect(toFieldShape(title, inlineValue).value).toBe(source)
    const row = group({ question: text() })
    const before = { question: "Why?", itemId: "stable" }
    const after = { question: source, itemId: "stable" }
    expect(
      toDescriptorComparisonForm(row, before, {
        sliceType: "faq-simple",
        fieldPath: "items[0]",
      })
    ).toEqual(
      toDescriptorComparisonForm(row, after, {
        sliceType: "faq-simple",
        fieldPath: "items[0]",
      })
    )
  })

  test("comparison flattens wrappers but preserves edge paragraphs and text/marks", () => {
    const a = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
        },
      ],
    })
    const b = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 5 },
          content: [
            { type: "hardBreak" },
            { type: "hardBreak" },
            { type: "text", text: "x", marks: [{ type: "bold" }] },
          ],
        },
      ],
    })
    // Inline keeps its breaks; a title compares a break as a space.
    expect(toComparisonForm("inline", a)).toContain('"type":"hardBreak"')
    expect(toComparisonForm("title", b)).toBe(
      '{"content":[{"content":[{"text":"  ","type":"text"},{"marks":[{"type":"bold"}],"text":"x","type":"text"}],"type":"paragraph"}],"type":"doc"}'
    )
  })

  test("registered title comparison retains removed link addresses", sliceProfile([]), () => {
    const address = { sliceType: "faq-simple", fieldPath: "items[0].question" }
    const linked = (href: string) =>
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 3 },
            content: [
              {
                type: "text",
                text: "Question",
                marks: [{ type: "link", attrs: { href } }],
              },
            ],
          },
        ],
      })
    expect(
      toComparisonForm("title", linked("https://one.example"), address)
    ).not.toBe(
      toComparisonForm("title", linked("https://two.example"), address)
    )
  })

  test("registered comparison retains a leading empty paragraph", sliceProfile([]), () => {
    const address = { sliceType: "faq-simple", fieldPath: "items[0].question" }
    const leadingEmptyParagraph = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph" },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Question" }],
        },
      ],
    })
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
    expect(toComparisonForm("title", leadingEmptyParagraph, address)).not.toBe(
      toComparisonForm("title", question, address)
    )
  })

  test("body comparisons canonicalize JSON formatting but preserve semantic changes", () => {
    const compact =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Body","marks":[{"type":"bold"}]}]}]}'
    const spaced =
      '{ "content" : [ { "content" : [ { "text" : "Body", "type" : "text", "marks" : [ { "type" : "bold" } ] } ], "type" : "paragraph" } ], "type" : "doc" }'
    const changedText = spaced.replace("Body", "Changed")
    const changedMark = spaced.replace('"bold"', '"italic"')
    const linked =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Body","marks":[{"type":"link","attrs":{"href":"/one"}}]}]}]}'
    const changedLink = linked.replace("/one", "/two")
    expect(toComparisonForm("basic", compact)).toBe(
      toComparisonForm("basic", spaced)
    )
    expect(toComparisonForm("basic", compact)).not.toBe(
      toComparisonForm("basic", changedText)
    )
    expect(toComparisonForm("basic", compact)).not.toBe(
      toComparisonForm("basic", changedMark)
    )
    expect(toComparisonForm("basic", linked)).not.toBe(
      toComparisonForm("basic", changedLink)
    )
  })

  test("transition is exact-address only and recognizes valid canonical headings", sliceProfile([]), () => {
    const address = { sliceType: "faq-simple", fieldPath: "items[0].question" }
    const canonical = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Why?" }],
        },
      ],
    })
    expect(transitionForField(address)?.to).toBe("title")
    expect(
      transitionForField({ ...address, sliceType: "other" })
    ).toBeUndefined()
    expect(readTransitionField(undefined, canonical)).toEqual({
      kind: "plain",
      value: canonical,
    })
    expect(readTransitionField(address, canonical)).toEqual({
      kind: "title",
      value: canonical,
    })
    expect(readFieldText(address, canonical)).toBe("Why?")
    const twoHeadings = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "First" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Second" }],
        },
      ],
    })
    expect(readTransitionField(address, twoHeadings)).toEqual({
      kind: "plain",
      value: twoHeadings,
    })
    const withBreak = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [
            { type: "text", text: "First" },
            { type: "hardBreak" },
            { type: "text", text: "second" },
          ],
        },
      ],
    })
    expect(readFieldText(address, withBreak)).toBe("First second")
    expect(readFieldText(address, "first\nsecond")).toBe("first\nsecond")
    const plainComparison = JSON.parse(
      toComparisonForm("inline", "first\nsecond", address)
    )
    expect(plainComparison.content[0].content).toEqual([
      { type: "text", text: "first second" },
    ])
    expect(
      readTransitionField(address, '{"type":"doc","content":[null]}')
    ).toEqual({ kind: "plain", value: '{"type":"doc","content":[null]}' })
    expect(readTransitionField(address, "{malformed")).toEqual({
      kind: "plain",
      value: "{malformed",
    })
    expect(validateLegacy(title, canonical)).toEqual({ ok: true })
  })
})

// ADR-0055 amendment (owner 2026-11-04): a title is one line.
describe("one-line titles", () => {
  const doc = (...blocks: unknown[][]) =>
    JSON.stringify({
      type: "doc",
      content: blocks.map((content) => ({
        type: "heading",
        attrs: { level: 3 },
        ...(content.length ? { content } : {}),
      })),
    })
  const t = (text: string, marks?: unknown[]) => ({
    type: "text",
    text,
    ...(marks ? { marks } : {}),
  })
  const br = { type: "hardBreak" }
  const bold = [{ type: "bold" }]
  const line = (value: string) =>
    JSON.parse(toFieldShape(title, value).value).content[0].content

  test("inner, leading, trailing and repeated breaks become single spaces or vanish", () => {
    expect(line(doc([t("a"), br, t("b")]))).toEqual([t("a b")])
    expect(line(doc([t("a"), br, br, br, t("b")]))).toEqual([t("a b")])
    expect(line(doc([br, t("a"), br]))).toEqual([t("a")])
    expect(line(doc([t("a "), br, t(" b")]))).toEqual([t("a b")])
  })

  test("newlines in text and plain text, and two blocks, join with one space", () => {
    expect(line(doc([t("a\nb")]))).toEqual([t("a b")])
    expect(line("a\r\nb\n")).toEqual([t("a b")])
    const paragraphs = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [t("a")] },
        { type: "paragraph" },
        { type: "paragraph", content: [t("b")] },
      ],
    })
    expect(line(paragraphs)).toEqual([t("a b")])
  })

  test("empty and break-only titles are an empty heading", () => {
    expect(toFieldShape(title, doc([br, br])).value).toBe(doc([]))
    expect(toFieldShape(title, "").value).toBe(doc([]))
  })

  test("marks spanning a removed break stay as one run; different marks keep their words", () => {
    expect(line(doc([t("a", bold), br, t("b", bold)]))).toEqual([t("a b", bold)])
    expect(line(doc([t("a", bold), br, t("b")]))).toEqual([
      t("a", bold),
      t(" b"),
    ])
  })

  test("an already-canonical title stays byte for byte", () => {
    for (const value of [
      doc([t("Plain")]),
      doc([t("A "), t("bold", bold), t(" word")]),
      doc([t("Spaces  inside and trailing ")]),
    ])
      expect(toFieldShape(title, value).value).toBe(value)
  })

  test("the strict validator rejects a break under a title and accepts the same line", () => {
    expect(validateStrict(title, doc([t("a"), br, t("b")])).ok).toBe(false)
    expect(validateStrict(title, doc([t("a b")]))).toEqual({ ok: true })
    // A newline hidden inside title text is a line break too (ADR-0055 amendment 2026-11-04).
    expect(validateStrict(title, doc([t("a\nb")])).ok).toBe(false)
    expect(validateStrict(title, doc([t("a\r\nb")])).ok).toBe(false)
  })

  test("comparison: a stored break and a space are the same title; a changed word is not", () => {
    const withBreak = doc([t("a"), br, t("b")])
    const withSpace = doc([t("a b")])
    expect(toComparisonForm("title", withBreak)).toBe(
      toComparisonForm("title", withSpace)
    )
    expect(toComparisonForm("title", doc([t("a c")]))).not.toBe(
      toComparisonForm("title", withSpace)
    )
  })

  test("the FAQ transition turns newlines into spaces", () => {
    const address = { sliceType: "faq-simple", fieldPath: "items[0].question" }
    expect(
      readFieldText(address, convertTransitionTitle(address, "Line one\nLine two")!.value)
    ).toBe("Line one Line two")
  })
})
