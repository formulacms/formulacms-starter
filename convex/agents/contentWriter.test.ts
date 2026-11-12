// Tests for the *pure* assembly half of the content writer agent — given a
// model response, build a same-type Slice with the editorial text in place
// and the structural fields at their schema defaults. The LLM call itself
// isn't exercised here; that's the smoke pass.
//
// The ADR-013 trust claim depends on two assertions being load-bearing:
//   1. The output surface contains ONLY editorial text — no href, no image
//      URL/id, no pageId.
//   2. The result is a valid `Slice` (closed-union; rich-text fields validate
//      against their profile).
import { describe, expect, test } from "vitest"
import { ConvexError } from "convex/values"
import {
  assembleOutline,
  assembleSlice,
  OUTLINE_MAX_SLICES,
  refineRichTextSegments,
} from "../lib/agents/contentWriterContract"
import { validateSlicesRichText } from "../lib/slices/validate"
import { SLICE_TYPES, type Slice } from "../lib/slices"

const SLICE_RESPONSE = [
  "[eyebrow]",
  "Montréal, QC — Digital Agency",
  "[/eyebrow]",
  "[title]",
  "Power Your Life",
  "[/title]",
  "[titlePrefix]",
  "Power Your",
  "[/titlePrefix]",
  "[titleHighlight]",
  "Life",
  "[/titleHighlight]",
  "[description]",
  "Clean energy that is simple, reliable, and ready to grow with you.",
  "[/description]",
  "[items]",
  "- Get Started",
  "- Learn More",
  "[/items]",
].join("\n")

/** Walk an arbitrary value and assert no `href`, `src`, or `pageId` key carries
 *  a non-empty string. The schema defaults set these to "" so we treat "" and
 *  null/undefined as the agent NOT having populated them; anything else means
 *  the agent reached past its editorial surface (mechanism 2 breach). */
function assertNoLinksOrImages(value: unknown): void {
  function walk(v: unknown, path: string): void {
    if (v === null || v === undefined) return
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (
          (k === "href" || k === "src" || k === "pageId") &&
          typeof child === "string"
        ) {
          expect(child, `${path}.${k} must stay empty`).toBe("")
        }
        walk(child, `${path}.${k}`)
      }
    }
  }
  walk(value, "$")
}

describe("assembleSlice", () => {
  test("every rich-text field validates against its declared profile", () => {
    // validateSlicesRichText throws ConvexError on failure — passing through
    // is the assertion. Cover every registered content shape in one pass.
    const slices: Slice[] = SLICE_TYPES.map((type) =>
      assembleSlice(type, SLICE_RESPONSE)
    )
    expect(() => validateSlicesRichText(slices)).not.toThrow()
  })

  test("never carries `marks` on text nodes (agent can't sneak in a link)", () => {
    const slices: Slice[] = SLICE_TYPES.map((type) =>
      assembleSlice(type, SLICE_RESPONSE)
    )
    for (const s of slices) {
      const json = JSON.stringify(s)
      expect(json.includes('"marks"')).toBe(false)
      expect(json.includes('"type":"link"')).toBe(false)
      expect(json.includes('"type":"image"')).toBe(false)
    }
  })

  test("ignores noise/unknown fenced blocks; uses only declared keys", () => {
    const noisy = `${SLICE_RESPONSE}\n\n[href]\nhttps://evil.example.com\n[/href]\n[image]\nhttps://x.png\n[/image]`
    for (const type of SLICE_TYPES) {
      const slice = assembleSlice(type, noisy)
      // The bogus blocks are not declared keys for assembleSlice — they must not
      // leak into the slice.
      assertNoLinksOrImages(slice)
      expect(JSON.stringify(slice).includes("evil.example.com")).toBe(false)
      expect(JSON.stringify(slice).includes("x.png")).toBe(false)
    }
  })

  test("tolerates a model that returns no labeled blocks at all", () => {
    // Worst case: model ignored the format. assembleSlice should still return
    // a valid Slice — just with empty editorial fields, no exception thrown.
    for (const type of SLICE_TYPES) {
      const slice = assembleSlice(type, "lorem ipsum free-form prose, no tags")
      expect(slice.type).toBe(type)
      expect(() => validateSlicesRichText([slice])).not.toThrow()
      assertNoLinksOrImages(slice)
    }
  })
})

describe("refineRichTextSegments", () => {
  // Deterministic stub instead of the LLM — we're testing the walker, not
  // the model. Uppercase makes substitutions obvious in assertions.
  const upper = (s: string) => Promise.resolve(s.toUpperCase())

  const docWithMarks = {
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
            text: "click here",
            marks: [{ type: "link", attrs: { href: "/x" } }],
          },
        ],
      },
    ],
  }

  test("preserves marks, structure, and link attrs byte-for-byte", async () => {
    const out = await refineRichTextSegments(
      JSON.stringify(docWithMarks),
      upper
    )
    const parsed = JSON.parse(out)
    expect(parsed.type).toBe("doc")
    expect(parsed.content).toHaveLength(2)
    // Marks survive.
    expect(parsed.content[0].content[1].marks[0].type).toBe("bold")
    expect(parsed.content[1].content[0].marks[0].type).toBe("link")
    // Link attrs (href) survive — the agent never touched them.
    expect(parsed.content[1].content[0].marks[0].attrs.href).toBe("/x")
    // The text DID change (refiner was applied).
    expect(parsed.content[0].content[0].text).toBe("HELLO ")
    expect(parsed.content[0].content[1].text).toBe("WORLD")
    expect(parsed.content[1].content[0].text).toBe("CLICK HERE")
  })

  test("non-PM input passes through unchanged (lenient, ADR-0009)", async () => {
    const legacy = "<p>old HTML</p>"
    expect(await refineRichTextSegments(legacy, upper)).toBe(legacy)
    expect(await refineRichTextSegments("not json at all", upper)).toBe(
      "not json at all"
    )
  })

  test("empty doc round-trips", async () => {
    const empty = JSON.stringify({ type: "doc", content: [] })
    expect(await refineRichTextSegments(empty, upper)).toBe(empty)
  })

  test("bounds refiner fan-out concurrency (AI-01)", async () => {
    const manySegments = {
      type: "doc",
      content: Array.from({ length: 12 }, (_, i) => ({
        type: "paragraph",
        content: [{ type: "text", text: `segment ${i}` }],
      })),
    }
    let active = 0
    let peak = 0
    const refiner = async (s: string) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return s.toUpperCase()
    }
    const out = await refineRichTextSegments(
      JSON.stringify(manySegments),
      refiner,
      3
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBe(3)
    // Bounding must not reorder or drop segments.
    const parsed = JSON.parse(out)
    expect(parsed.content).toHaveLength(12)
    expect(parsed.content[0].content[0].text).toBe("SEGMENT 0")
    expect(parsed.content[11].content[0].text).toBe("SEGMENT 11")
  })

  test("does NOT introduce new marks or new node types", async () => {
    const out = await refineRichTextSegments(
      JSON.stringify(docWithMarks),
      upper
    )
    // Same set of node/mark types as the input. No `link` mark added to the
    // first paragraph; no fresh `bold` on the link paragraph.
    const seenNodeTypes = new Set<string>()
    const seenMarkTypes = new Set<string>()
    function walk(n: {
      type?: unknown
      content?: unknown
      marks?: unknown
    }): void {
      if (typeof n.type === "string") seenNodeTypes.add(n.type)
      if (Array.isArray(n.marks)) {
        for (const m of n.marks) {
          if (m && typeof (m as { type?: unknown }).type === "string") {
            seenMarkTypes.add((m as { type: string }).type)
          }
        }
      }
      if (Array.isArray(n.content)) for (const c of n.content) walk(c)
    }
    walk(JSON.parse(out))
    expect([...seenNodeTypes].sort()).toEqual(["doc", "paragraph", "text"])
    expect([...seenMarkTypes].sort()).toEqual(["bold", "link"])
  })
})

describe("assembleOutline", () => {
  const OK_RESPONSE = `
[title]
Modern dentistry in Montreal
[/title]
[slug]
modern-dentistry-montreal
[/slug]
[metaTitle]
Modern, friendly dentistry in Montreal
[/metaTitle]
[metaDescription]
A family-friendly clinic offering bilingual, same-day care across the city.
[/metaDescription]
[outline]
- hero-agency | Set the value proposition and the primary action.
[/outline]
`

  test("parses title/slug/meta/outline rows from a well-formed response", () => {
    const o = assembleOutline(OK_RESPONSE)
    expect(o.title).toBe("Modern dentistry in Montreal")
    expect(o.slug).toBe("modern-dentistry-montreal")
    expect(o.metaTitle).toMatch(/^Modern, friendly dentistry/)
    expect(o.metaDescription).toMatch(/^A family-friendly clinic/)
    expect(o.outline).toHaveLength(1)
    expect(o.outline.map((r) => r.type)).toEqual(["hero-agency"])
    expect(o.outline[0]?.purpose).toMatch(/value proposition/)
  })

  test("drops unknown slice types silently", () => {
    const raw = `${OK_RESPONSE.replace(
      "- hero-agency | Set the value proposition and the primary action.",
      "- newsletter | Capture emails\n- hero-agency | Set the value proposition and the primary action."
    )}`
    const o = assembleOutline(raw)
    // newsletter not in SLICE_TYPES -> dropped; hero-agency still present.
    expect(o.outline.map((r) => r.type)).toEqual(["hero-agency"])
  })

  test("throws OUTLINE_EMPTY when every row references an unknown type", () => {
    const raw = `
[title]x[/title]
[slug]x[/slug]
[metaTitle]x[/metaTitle]
[metaDescription]x[/metaDescription]
[outline]
- newsletter | a
- testimonials | b
[/outline]
`
    expect(() => assembleOutline(raw)).toThrow(ConvexError)
    expect(() => assembleOutline(raw)).toThrow(/OUTLINE_EMPTY/)
  })

  test("caps the outline at OUTLINE_MAX_SLICES", () => {
    const lines = Array.from(
      { length: 15 },
      (_, i) => `- hero-agency | row ${i}`
    ).join("\n")
    const raw = `[title]x[/title][slug]x[/slug][metaTitle]x[/metaTitle][metaDescription]x[/metaDescription][outline]\n${lines}\n[/outline]`
    const o = assembleOutline(raw)
    expect(o.outline.length).toBe(OUTLINE_MAX_SLICES)
  })

  test("tolerates em-dash / hyphen as the type|purpose separator", () => {
    const raw = `[title]x[/title][slug]x[/slug][metaTitle]x[/metaTitle][metaDescription]x[/metaDescription][outline]\n- hero-agency — first\n[/outline]`
    const o = assembleOutline(raw)
    expect(o.outline.map((r) => r.type)).toEqual(["hero-agency"])
  })

  test("falls back to slugified title when [slug] is missing", () => {
    const raw = `[title]Bright New Page[/title][metaTitle]x[/metaTitle][metaDescription]x[/metaDescription][outline]\n- hero-agency | a\n[/outline]`
    const o = assembleOutline(raw)
    expect(o.slug).toBe("bright-new-page")
  })

  test("re-slugifies a model-supplied slug so wonky chars can't leak through", () => {
    const raw = `[title]x[/title][slug]Hello World! / "<page>"[/slug][metaTitle]x[/metaTitle][metaDescription]x[/metaDescription][outline]\n- hero-agency | a\n[/outline]`
    const o = assembleOutline(raw)
    expect(o.slug).toMatch(/^[a-z0-9-]+$/)
    expect(o.slug.startsWith("hello")).toBe(true)
  })

  test("rejects outline rows with empty purpose", () => {
    const raw = `[title]x[/title][slug]x[/slug][metaTitle]x[/metaTitle][metaDescription]x[/metaDescription][outline]\n- hero |\n[/outline]`
    expect(() => assembleOutline(raw)).toThrow(/OUTLINE_EMPTY/)
  })
})
