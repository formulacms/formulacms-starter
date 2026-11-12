import { describe, expect, test } from "vitest"
import { sanitizeLegacyHtml, validateDoc } from "./profiles"

const doc = (content: unknown[]) => JSON.stringify({ type: "doc", content })
const para = (text: string, marks?: unknown[]) => ({
  type: "paragraph",
  content: [{ type: "text", text, ...(marks ? { marks } : {}) }],
})
const table = () => ({
  type: "table",
  content: [
    {
      type: "tableRow",
      content: [{ type: "tableHeader", content: [para("H")] }],
    },
    {
      type: "tableRow",
      content: [{ type: "tableCell", content: [para("C")] }],
    },
  ],
})

describe("validateDoc — accepts in-profile content", () => {
  test("basic allows paragraph + bold/italic/link marks", () => {
    const json = doc([
      para("hi", [{ type: "bold" }, { type: "link", attrs: { href: "/x" } }]),
    ])
    expect(validateDoc(json, "basic")).toEqual({ ok: true })
  })

  test("basic allows H2/H3 and lists", () => {
    const json = doc([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "h" }],
      },
      {
        type: "bulletList",
        content: [{ type: "listItem", content: [para("a")] }],
      },
    ])
    expect(validateDoc(json, "basic")).toEqual({ ok: true })
  })

  test("full allows image, blockquote, strike, code", () => {
    const json = doc([
      { type: "image", attrs: { src: "/x.png" } },
      { type: "blockquote", content: [para("q")] },
      para("c", [{ type: "strike" }, { type: "code" }]),
    ])
    expect(validateDoc(json, "full")).toEqual({ ok: true })
  })

  test("full allows tables (ADR-0009 amendment)", () => {
    expect(validateDoc(doc([table()]), "full")).toEqual({ ok: true })
  })
})

describe("validateDoc — rejects out-of-profile content", () => {
  test("image is rejected in basic", () => {
    const result = validateDoc(
      doc([{ type: "image", attrs: { src: "/x" } }]),
      "basic"
    )
    expect(result.ok).toBe(false)
  })

  test("H1 is rejected in basic (levels limited to 2,3)", () => {
    const json = doc([
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "h" }],
      },
    ])
    expect(validateDoc(json, "basic").ok).toBe(false)
  })

  test("block node is rejected in inline", () => {
    const json = doc([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "h" }],
      },
    ])
    expect(validateDoc(json, "inline").ok).toBe(false)
  })

  test("disallowed mark is rejected", () => {
    const json = doc([para("x", [{ type: "code" }])])
    expect(validateDoc(json, "basic").ok).toBe(false)
  })

  test("table is rejected in basic (full-only node)", () => {
    expect(validateDoc(doc([table()]), "basic").ok).toBe(false)
  })
})

describe("validateDoc — lenient on legacy / non-JSON", () => {
  test("legacy HTML string passes (not yet migrated)", () => {
    expect(validateDoc("<p>old</p>", "basic")).toEqual({ ok: true })
  })

  test("empty string passes", () => {
    expect(validateDoc("", "basic")).toEqual({ ok: true })
  })

  test("non-doc JSON passes", () => {
    expect(validateDoc('{"foo":1}', "basic")).toEqual({ ok: true })
  })
})

describe("sanitizeLegacyHtml — legacy HTML render boundary", () => {
  test("preserves safe legacy formatting", () => {
    expect(
      sanitizeLegacyHtml(
        '<p><strong>Bold</strong> <a href="/about" title="About">link</a></p>',
        "basic"
      )
    ).toBe(
      '<p><strong>Bold</strong> <a href="/about" title="About">link</a></p>'
    )
  })

  test("strips script tags and event attributes", () => {
    const html = sanitizeLegacyHtml(
      '<p onclick="alert(1)">Hi<script>alert(2)</script></p>',
      "basic"
    )

    expect(html).toBe("<p>Hi</p>")
  })

  test("strips unsafe link URLs", () => {
    expect(
      sanitizeLegacyHtml('<a href="javascript:alert(1)">bad</a>', "basic")
    ).toBe("<a>bad</a>")
  })
})
