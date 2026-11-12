import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { INSTALLED_SLICE_TYPES, type Slice } from "@/convex/lib/slices"

import {
  fieldHeadingLevel,
  type OutlineField,
  isOutlineFieldVisible,
  pageHeadingModeFor,
  resolvePageOutline,
  bodyHeadingLevels,
  SLICE_OUTLINE_DESCRIPTORS,
  validateOutlineDescriptor,
} from "./page-outline"

const doc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
    ],
  })
function hero(id = "hero", title = doc("Title")): Slice {
  const sample = createSampleSlice("hero-with-image")
  return { ...sample, id, primary: { ...sample.primary, title } }
}
function outline(
  slices: Slice[],
  mode: "lead-or-fallback" | "owned" | "section" = "lead-or-fallback",
  locale = "en"
) {
  return resolvePageOutline({ slices, locale, mode })
}

describe("RF4b Hero ownership", () => {
  it("promotes the first eligible Hero after an ordinary section", sliceProfile([]), () => {
    const section = createSampleSlice("faq-simple")
    const slices = [
      section,
      { ...hero("disabled"), enabled: false },
      hero("empty", doc("")),
      hero("hidden", "<script>hidden</script>"),
      hero("lead"),
      hero("later"),
    ]
    const before = JSON.stringify(slices)
    expect(outline(slices)).toMatchObject({
      leadSliceId: "lead",
      hostRendersFallbackH1: false,
      baseBySliceId: {
        [section.id]: 2,
        empty: 2,
        hidden: 2,
        lead: 1,
        later: 2,
      },
    })
    expect(JSON.stringify(slices)).toBe(before)
  })

  it("preserves descriptor capability ownership ahead of a Hero", sliceProfile([]), () => {
    const section = createSampleSlice("faq-simple")
    section.primary.heading = doc("Existing capable opener")
    const result = resolvePageOutline({
      slices: [section, hero("later")],
      locale: "en",
      mode: "lead-or-fallback",
      descriptors: {
        ...SLICE_OUTLINE_DESCRIPTORS,
        [section.type]: {
          ...SLICE_OUTLINE_DESCRIPTORS[section.type],
          canOpenPage: true,
        },
      },
    })
    expect(result).toMatchObject({
      leadSliceId: section.id,
      hostRendersFallbackH1: false,
      baseBySliceId: { [section.id]: 1, later: 2 },
    })
  })
})

describe("page outline", () => {
  it.each(["en", "fr"])(
    "uses the first eligible visible occurrence in %s", sliceProfile([]),
    (locale) => {
      const disabled = { ...hero("disabled"), enabled: false }
      const lead = hero("lead")
      expect(
        outline([disabled, lead, hero("later")], "lead-or-fallback", locale)
      ).toMatchObject({
        leadSliceId: "lead",
        hostRendersFallbackH1: false,
        baseBySliceId: { lead: 1, later: 2 },
        locale,
      })
      for (const first of [
        hero("empty", doc("")),
        createSampleSlice("rich-text-body"),
        createSampleSlice("faq-simple"),
      ]) {
        expect(
          outline([first, lead], "lead-or-fallback", locale)
        ).toMatchObject({ leadSliceId: "lead", hostRendersFallbackH1: false })
      }
    }
  )
  it.each(["owned", "section"] as const)(
    "never promotes in %s mode", sliceProfile([]),
    (mode) => {
      expect(outline([hero()], mode)).toMatchObject({
        leadSliceId: undefined,
        hostRendersFallbackH1: false,
        baseBySliceId: { hero: 2 },
      })
    }
  )
  it("handles no visible slices and duplicate IDs using the zone identity policy", sliceProfile([]), () => {
    expect(outline([{ ...hero(), enabled: false }]).hostRendersFallbackH1).toBe(
      true
    )
    const result = outline([hero(), hero()])
    expect(Object.values(result.baseBySliceId)).toEqual([1, 2])
  })
  it.each([
    "",
    doc(""),
    "<p><br></p>",
    "<p>&nbsp;</p>",
    "<script>hidden</script>",
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "image", attrs: { src: "/image.png" } }],
        },
      ],
    }),
  ])("keeps the fallback for visually empty title %s", sliceProfile([]), (title) => {
    expect(outline([hero("empty", title)]).hostRendersFallbackH1).toBe(true)
  })
  it("maps public content types to their shared preview mode", () => {
    expect(
      ["page", "landing-page", "post", "author"].map(pageHeadingModeFor)
    ).toEqual([
      "lead-or-fallback",
      "lead-or-fallback",
      "lead-or-fallback",
      "owned",
    ])
  })
  it("declares opening policy for every registered source type", () => {
    for (const type of INSTALLED_SLICE_TYPES)
      expect(SLICE_OUTLINE_DESCRIPTORS[type]).toBeDefined()
    for (const descriptor of Object.values(SLICE_OUTLINE_DESCRIPTORS))
      expect(validateOutlineDescriptor(descriptor)).toEqual([])
  })
  it("counts rendered primary and same-item parents, including empty ancestors", sliceProfile([]), () => {
    const faq = createSampleSlice("faq-simple")
    faq.primary.heading = doc("Section")
    faq.items[0].question = "Question"
    let field = outline([faq], "section").fieldsBySliceId[faq.id]
    expect(fieldHeadingLevel(field, "items[0].question")).toBe(3)
    expect(fieldHeadingLevel(field, "items[0].answer")).toBe(4)
    faq.primary.heading = doc("")
    field = outline([faq], "section").fieldsBySliceId[faq.id]
    expect(fieldHeadingLevel(field, "items[0].question")).toBe(2)
    faq.items[0].question = ""
    field = outline([faq], "section").fieldsBySliceId[faq.id]
    expect(fieldHeadingLevel(field, "items[0].answer")).toBe(2)
  })
  it("rejects missing/non-heading parents, cycles and cross-item scope", () => {
    for (const fields of [
      { "primary.title": { parent: "missing" } },
      {
        "primary.title": { parent: "primary.body" },
        "primary.body": { kind: "body" as const },
      },
      { "primary.title": { parent: "items.question" }, "items.question": {} },
      { "primary.title": { parent: "primary.title" } },
    ])
      expect(
        validateOutlineDescriptor({
          canOpenPage: false,
          fields: fields as unknown as Record<string, OutlineField>,
        })
      ).not.toEqual([])
  })
  it("shifts only display headings, closes gaps, and preserves input", () => {
    const document = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "One" }],
        },
        {
          type: "heading",
          attrs: { level: 4 },
          content: [{ type: "text", text: "Two" }],
        },
      ],
    }
    const before = JSON.stringify(document)
    expect([...bodyHeadingLevels(document, 3).values()]).toEqual([3, 4])
    expect(JSON.stringify(document)).toBe(before)
    expect(isOutlineFieldVisible(doc("Visible"))).toBe(true)
  })
})

describe("body heading occurrence resolver extraction", () => {
  it("preserves mapped empties, missing keys, absent maps and empty maps", async () => {
    const { createBodyHeadingResolver } = await import("./page-outline")
    const mapped = createBodyHeadingResolver(
      new Map([
        [2, 4],
        [3, 5],
      ])
    )
    expect(mapped(3, " ")).toBeNull()
    expect(mapped(3, "First")).toBe(4)
    expect(mapped(3, "Next")).toBe(5)
    expect(mapped(2, "Lower")).toBe(4)
    expect(mapped(6, "Missing key")).toBe(5)
    expect(createBodyHeadingResolver()(3, "")).toBe(3)
    const empty = createBodyHeadingResolver(new Map())
    expect(empty(3, " ")).toBeNull()
    expect(empty(3, "Text")).toBe(3)
  })
})
