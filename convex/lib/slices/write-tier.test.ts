import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { richText } from "./primitives"

import { validateFieldMapRichText, validateSlicesRichText } from "./validate"

const heading = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Title" }],
    },
  ],
})

describe("slice rich-text validation tiers", () => {
  test("registered basic bodies accept relative headings and refuse full-only blocks without rewriting", sliceProfile([]), () => {
    const sample = createSampleSlice("hero-agency")
    const slice = {
      ...sample,
      primary: { ...sample.primary, description: heading },
    }
    const before = JSON.stringify(slice)
    expect(() => validateSlicesRichText([slice])).not.toThrow()
    expect(JSON.stringify(slice)).toBe(before)
    const fullOnly = {
      ...slice,
      primary: {
        ...slice.primary,
        description: JSON.stringify({
          type: "doc",
          content: [{ type: "blockquote", content: [{ type: "paragraph" }] }],
        }),
      },
    }
    expect(() => validateSlicesRichText([fullOnly])).toThrow(/blockquote/)
  })

  test("field-map validation defaults to the same raw write check", () => {
    const fields = { title: richText({ profile: "inline" }) }
    const values = { title: heading }
    expect(() => validateFieldMapRichText(fields, values)).toThrow()
    expect(() =>
      validateFieldMapRichText(fields, values, "legacy")
    ).not.toThrow()
    expect(values.title).toBe(heading)
  })

  test.each(["inline", "basic", "full"] as const)(
    "refuses non-JSON authored %s writes while legacy reads remain explicit",
    (profile) => {
      const fields = { body: richText({ profile }) }
      const values = { body: "<p>Legacy HTML</p>" }
      expect(() => validateFieldMapRichText(fields, values)).toThrow()
      expect(() =>
        validateFieldMapRichText(fields, values, "legacy")
      ).not.toThrow()
      expect(values.body).toBe("<p>Legacy HTML</p>")
    }
  )

  test("D2 activates strict title writes; legacy reads remain explicit", () => {
    const fields = { title: richText({ contract: "title" }) }
    const value = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    })
    expect(() => validateFieldMapRichText(fields, { title: value })).toThrow()
    expect(() =>
      validateFieldMapRichText(fields, { title: value }, "legacy")
    ).not.toThrow()
  })
})
