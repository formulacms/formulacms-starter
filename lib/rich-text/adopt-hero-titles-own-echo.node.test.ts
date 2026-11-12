import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import type { Slice } from "@/convex/lib/slices"

import { validateSlicesRichText } from "@/convex/lib/slices/validate"
import {
  applyPageField,
  capturePageField,
  pageFieldEcho,
} from "@/components/admin/page-editor/lib/page-inline-draft"
import { adoptHeroTitles, prepareHeroTitleDraft } from "./adopt-hero-titles"

const epoch = 7
const catalog = "counterexample-catalog"
const title = (value: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: value }],
      },
    ],
  })
const body = () => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Read more",
          marks: [
            { type: "bold" },
            { type: "link", attrs: { href: "/before", target: "_self" } },
          ],
        },
      ],
    },
  ],
})

function hero(id = "hero") {
  const sample = createSampleSlice("hero-with-image")
  return {
    ...sample,
    id,
    primary: { ...sample.primary, description: JSON.stringify(body()) },
    items: sample.items.map((row, index) => ({
      ...row,
      itemId: `row-${index}`,
    })),
  }
}

/** Only the production apply helper creates the receipt used by these cases. */
function applied(slices: Slice[], locale = "en") {
  const capture = capturePageField(
    slices,
    locale,
    "hero",
    "primary.title",
    epoch,
    catalog
  )
  if (!capture) throw new Error("Expected a real Hero title binding")
  const commit = {
    ...capture,
    value: title(locale === "fr" ? "Notre équipe" : "Our team"),
    inlineSessionId: `inline-${locale}`,
    frameBinding: {
      sessionId: "page-session",
      pageId: "page-id",
      generation: "frame-generation",
      buildId: "build-id",
      languageVersion: 1,
    },
  }
  const value = applyPageField(slices, locale, commit, epoch, catalog)
  if (!value || !pageFieldEcho(value))
    throw new Error("Expected an accepted apply with its authentic receipt")
  return value
}

describe("own-echo adoption counterexamples", () => {
  test.each([
    ["en", false],
    ["en", true],
    ["fr", false],
    ["fr", true],
  ] as const)(
    "%s no-op preparation retains exact bytes, array and receipt (forWrite=%s)", sliceProfile([]),
    (locale, forWrite) => {
      const slices = applied([hero()], locale)
      const bytes = JSON.stringify(slices)
      const receipt = pageFieldEcho(slices)
      const reports = [
        {
          locale,
          sliceId: "hero",
          fieldPath: "primary.title",
          removedLinks: [{ href: "/removed" }],
        },
        {
          locale: locale === "fr" ? "en" : "fr",
          sliceId: "other-locale",
          fieldPath: "primary.title",
          removedLinks: [{ href: "/autre" }],
        },
      ]
      const reportBytes = JSON.stringify(reports)
      const adopted = adoptHeroTitles(slices, locale, reports, forWrite)
      const prepared = prepareHeroTitleDraft(
        { slices, removedTitleLinks: reports },
        locale
      )
      expect(adopted.value).toBe(slices)
      expect(prepared.slices).toBe(slices)
      expect(pageFieldEcho(adopted.value)).toBe(receipt)
      expect(pageFieldEcho(prepared.slices)).toBe(receipt)
      expect(JSON.stringify(adopted.value)).toBe(bytes)
      expect(adopted.reports).toEqual(reports)
      expect(prepared.removedTitleLinks).toEqual(reports)
      expect(JSON.stringify(reports)).toBe(reportBytes)
    }
  )

  test.each([false, true])(
    "a real sibling conversion has fresh output and no borrowed receipt (forWrite=%s)", sliceProfile([]),
    (forWrite) => {
      const sibling = hero("legacy")
      sibling.primary.title =
        '<p><strong>Bonjour</strong> <a href="/fr">équipe</a></p>'
      const slices = applied([hero(), sibling])
      const bytes = JSON.stringify(slices)
      const adopted = adoptHeroTitles(slices, "en", [], forWrite)
      expect(adopted.value).not.toBe(slices)
      expect(adopted.value[0]).toBe(slices[0])
      expect(pageFieldEcho(adopted.value)).toBeUndefined()
      expect(pageFieldEcho(slices)).toBeDefined()
      expect(adopted.value[1].primary).not.toEqual(sibling.primary)
      expect(adopted.reports).toEqual([
        {
          locale: "en",
          sliceId: "legacy",
          fieldPath: "primary.title",
          removedLinks: [{ href: "/fr" }],
        },
      ])
      expect(() => validateSlicesRichText(adopted.value)).not.toThrow()
      expect(JSON.stringify(slices)).toBe(bytes)
      const reloaded = JSON.parse(JSON.stringify(adopted.value)) as Slice[]
      expect(adoptHeroTitles(reloaded, "en", adopted.reports, true).value).toBe(
        reloaded
      )
    }
  )

  test("forWrite allocates missing row IDs without copying an authentic receipt", sliceProfile([]), () => {
    const source = hero()
    source.items.forEach((row) => Reflect.deleteProperty(row, "itemId"))
    const slices = applied([source])
    const bytes = JSON.stringify(slices)
    expect(adoptHeroTitles(slices, "en").value).toBe(slices)
    const adopted = adoptHeroTitles(slices, "en", [], true)
    expect(adopted.value).not.toBe(slices)
    expect(pageFieldEcho(adopted.value)).toBeUndefined()
    const saved = adopted.value[0]
    if (saved.type !== "hero-with-image") throw new Error("Expected Hero")
    expect(saved.items.map((row) => row.label)).toEqual(
      source.items.map((row) => row.label)
    )
    expect(saved.items.every((row) => !!row.itemId)).toBe(true)
    expect(new Set(saved.items.map((row) => row.itemId)).size).toBe(
      saved.items.length
    )
    expect(adoptHeroTitles(adopted.value, "en", [], true).value).toBe(
      adopted.value
    )
    expect(JSON.stringify(slices)).toBe(bytes)
  })

  test.each(["href", "mark", "attribute", "first-empty", "last-empty"])(
    "a canonical %s edit is preserved and cannot borrow earlier provenance", sliceProfile([]),
    (change) => {
      const slices = applied([hero()])
      const stale = capturePageField(
        slices,
        "en",
        "hero",
        "primary.description",
        epoch,
        catalog
      )!
      const updated = structuredClone(body())
      const text = updated.content[0].content[0]
      if (change === "href") text.marks[1].attrs!.href = "/after"
      if (change === "mark") text.marks[0].type = "italic"
      if (change === "attribute") text.marks[1].attrs!.target = "_blank"
      if (change === "first-empty")
        updated.content.unshift({ type: "paragraph", content: [] })
      if (change === "last-empty")
        updated.content.push({ type: "paragraph", content: [] })
      const source = slices[0]
      const external = [
        {
          ...source,
          primary: { ...source.primary, description: JSON.stringify(updated) },
        },
      ] as Slice[]
      const adopted = adoptHeroTitles(external, "en")
      expect(adopted.value).toBe(external)
      expect(pageFieldEcho(adopted.value)).toBeUndefined()
      expect(
        capturePageField(
          adopted.value,
          "en",
          "hero",
          "primary.description",
          epoch,
          catalog
        )?.value
      ).toBe(JSON.stringify(updated))
      expect(
        applyPageField(
          adopted.value,
          "en",
          { ...stale, value: JSON.stringify(body()) },
          epoch,
          catalog
        )
      ).toBeNull()
    }
  )

  test.each(['{"type":"doc"}', "<p>literal</p>", "# literal"])(
    "registered plain text stays literal through receipt-preserving preparation: %s", sliceProfile([]),
    (literal) => {
      const source = hero()
      source.primary.eyebrow = literal
      const slices = applied([source])
      const prepared = prepareHeroTitleDraft({ slices }, "en")
      expect(prepared.slices).toBe(slices)
      expect(prepared.slices[0].primary).toMatchObject({ eyebrow: literal })
      expect(pageFieldEcho(prepared.slices)).toBe(pageFieldEcho(slices))
    }
  )

  test("a later invalid sibling refuses preparation without mutating earlier conversions", sliceProfile([]), () => {
    const legacy = hero()
    legacy.primary.title = "<p>Legacy headline</p>"
    const invalid = hero("invalid")
    invalid.primary.description = '{"type":'
    const slices = [legacy, invalid]
    const bytes = JSON.stringify(slices)
    expect(() => adoptHeroTitles(slices, "en", [], true)).toThrow()
    expect(JSON.stringify(slices)).toBe(bytes)
    expect(pageFieldEcho(slices)).toBeUndefined()
  })
})
