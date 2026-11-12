import { describe, expect, it } from "vitest"
import { describeTypeScaleMappings } from "../../../lib/slices/authoring/type-scale"
import {
  MAX_MARKUP_CHARS,
  buildMarkupBlock,
  buildMarkupBlockForLang,
} from "./markup"

describe("buildMarkupBlock", () => {
  it("returns an empty string when no markup is provided", () => {
    expect(buildMarkupBlock({})).toBe("")
    expect(buildMarkupBlock({ html: "", tsx: "   " })).toBe("")
    expect(buildMarkupBlock({ html: null, tsx: undefined })).toBe("")
  })

  it("emits an HTML structural-source-of-truth block", () => {
    const block = buildMarkupBlock({ html: "<section>hi</section>" })
    expect(block).toContain("Source markup (HTML) — STRUCTURAL SOURCE OF TRUTH")
    expect(block).toContain("TRANSLATE its Tailwind classes")
    expect(block).toContain("```html\n<section>hi</section>\n```")
  })

  it("emits a TSX block that reads correctly on its own", () => {
    const block = buildMarkupBlock({ tsx: "<Section/>" })
    expect(block).toContain("Source markup (JSX/TSX) — STRUCTURAL SOURCE OF TRUTH")
    // Worded to stand alone — must not dangle a reference to a missing HTML block.
    expect(block).toContain("Apply the same rules as for source HTML")
    expect(block).not.toContain("Apply the same rules as the HTML block")
    expect(block).toContain("```tsx\n<Section/>\n```")
  })

  it("teaches the canonical type-scale mapping, not a second hand-typed copy", () => {
    const block = buildMarkupBlock({ html: "<h1/>" })
    // A1 established `type-scale.ts` as the single source of this mapping so a
    // prompt copy cannot drift from it. This block held its own wording, which
    // paired the classes and tokens in an order that read `text-4xl`→
    // `text-display` — the promotion A1 exists to prevent.
    expect(block).toContain(describeTypeScaleMappings())
    expect(block).not.toContain("`text-4xl`/`text-5xl`→`text-display`/`text-title`")
  })

  it("places HTML before TSX when both are present", () => {
    const block = buildMarkupBlock({ html: "<h1/>", tsx: "<H1/>" })
    expect(block.indexOf("(HTML)")).toBeLessThan(block.indexOf("(JSX/TSX)"))
  })

  it("trims surrounding whitespace from the payload", () => {
    const block = buildMarkupBlock({ html: "\n  <p/>  \n" })
    expect(block).toContain("```html\n<p/>\n```")
  })
})

describe("buildMarkupBlockForLang", () => {
  it("routes html and tsx to the matching block", () => {
    expect(buildMarkupBlockForLang("<p/>", "html")).toContain("(HTML)")
    expect(buildMarkupBlockForLang("<P/>", "tsx")).toContain("(JSX/TSX)")
  })

  it("returns an empty string for empty markup regardless of lang", () => {
    expect(buildMarkupBlockForLang("", "html")).toBe("")
    expect(buildMarkupBlockForLang("   ", "tsx")).toBe("")
  })
})

describe("MAX_MARKUP_CHARS", () => {
  it("is a sane positive cap", () => {
    expect(MAX_MARKUP_CHARS).toBeGreaterThan(10_000)
  })
})
